import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { HttpClient, HttpRouter } from "effect/unstable/http";

import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as ServerConfig from "./config.ts";
import {
  ProjectionThreadAppReviewRepository,
  type ProjectionThreadAppReview,
} from "./persistence/Services/ProjectionThreadAppReviews.ts";
import * as ProjectFaviconResolver from "./project/ProjectFaviconResolver.ts";
import * as T3ProjectFileLoader from "./project/T3ProjectFileLoader.ts";
import * as WorkspacePaths from "./workspace/WorkspacePaths.ts";
import {
  assetResponseHeaders,
  assetRouteLayer,
  downloadContentDisposition,
  isLoopbackHostname,
  parseByteRangeHeader,
  resolveDevRedirectUrl,
} from "./http.ts";
import { issueAssetUrl } from "./assets/AssetAccess.ts";

const configLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-http-asset-test-",
});
const appReviewRepositoryLayer = Layer.succeed(
  ProjectionThreadAppReviewRepository,
  ProjectionThreadAppReviewRepository.of({
    upsert: () => Effect.void,
    getById: () => Effect.succeed(Option.none<ProjectionThreadAppReview>()),
    listByThreadId: () => Effect.succeed([]),
    listAll: () => Effect.succeed([]),
    deleteByThreadId: () => Effect.void,
  }),
);
const assetRouteSupportLayer = Layer.mergeAll(
  configLayer,
  WorkspacePaths.layer,
  ProjectFaviconResolver.layer.pipe(
    Layer.provide(WorkspacePaths.layer),
    Layer.provide(T3ProjectFileLoader.layer),
  ),
  ServerSecretStore.layer.pipe(Layer.provide(configLayer)),
  appReviewRepositoryLayer,
).pipe(Layer.provideMerge(NodeServices.layer));

function withAssetRoute<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return Effect.scoped(
    Effect.gen(function* () {
      yield* HttpRouter.serve(assetRouteLayer, {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(Layer.build);
      return yield* effect;
    }),
  ).pipe(Effect.provide(Layer.mergeAll(assetRouteSupportLayer, NodeHttpServer.layerTest)));
}

const issueWorkspaceWebmAssetUrl = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-http-asset-root-" });
  const recordingPath = path.join(root, "recording.webm");
  const bytes = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x01]);
  yield* fileSystem.writeFile(recordingPath, bytes);

  const result = yield* issueAssetUrl({
    resource: {
      _tag: "workspace-file",
      threadId: ThreadId.make("thread-http-asset"),
      path: recordingPath,
    },
    workspaceRoot: root,
  });
  return { relativeUrl: result.relativeUrl, sizeBytes: bytes.byteLength };
});

describe("http dev routing", () => {
  it("treats localhost and loopback addresses as local", () => {
    expect(isLoopbackHostname("127.0.0.1")).toBe(true);
    expect(isLoopbackHostname("localhost")).toBe(true);
    expect(isLoopbackHostname("::1")).toBe(true);
    expect(isLoopbackHostname("[::1]")).toBe(true);
  });

  it("does not treat LAN addresses as local", () => {
    expect(isLoopbackHostname("192.168.86.35")).toBe(false);
    expect(isLoopbackHostname("10.0.0.24")).toBe(false);
    expect(isLoopbackHostname("example.local")).toBe(false);
  });

  it("preserves path and query when redirecting to the dev server", () => {
    const devUrl = new URL("http://127.0.0.1:5173/");
    const requestUrl = new URL("http://127.0.0.1:3774/pair?token=test-token");

    expect(resolveDevRedirectUrl(devUrl, requestUrl)).toBe(
      "http://127.0.0.1:5173/pair?token=test-token",
    );
  });
});

describe("byte range parsing", () => {
  it("returns null for absent, malformed, and multi-range headers", () => {
    expect(parseByteRangeHeader(undefined, 10)).toBeNull();
    expect(parseByteRangeHeader("items=0-1", 10)).toBeNull();
    expect(parseByteRangeHeader("bytes=0-1,3-4", 10)).toBeNull();
    expect(parseByteRangeHeader("bytes=-", 10)).toBeNull();
  });

  it("parses bounded, open-ended, and suffix byte ranges", () => {
    expect(parseByteRangeHeader("bytes=2-5", 10)).toEqual({ offset: 2, bytesToRead: 4 });
    expect(parseByteRangeHeader("bytes=7-", 10)).toEqual({ offset: 7, bytesToRead: 3 });
    expect(parseByteRangeHeader("bytes=-4", 10)).toEqual({ offset: 6, bytesToRead: 4 });
    expect(parseByteRangeHeader("bytes=-99", 10)).toEqual({ offset: 0, bytesToRead: 10 });
  });

  it("marks well-formed impossible ranges as unsatisfiable", () => {
    expect(parseByteRangeHeader("bytes=10-", 10)).toBe("unsatisfiable");
    expect(parseByteRangeHeader("bytes=5-4", 10)).toBe("unsatisfiable");
    expect(parseByteRangeHeader("bytes=-0", 10)).toBe("unsatisfiable");
    expect(parseByteRangeHeader("bytes=0-0", 0)).toBe("unsatisfiable");
  });
});

describe("asset route", () => {
  it.effect("serves WebM assets with an explicit media content type", () =>
    withAssetRoute(
      Effect.gen(function* () {
        const { relativeUrl } = yield* issueWorkspaceWebmAssetUrl;
        const client = yield* HttpClient.HttpClient;

        const response = yield* client.get(relativeUrl);

        expect(response.status).toBe(200);
        expect(response.headers["content-type"]).toBe("video/webm");
        expect(response.headers["accept-ranges"]).toBe("bytes");
        expect(response.headers["x-content-type-options"]).toBe("nosniff");
      }),
    ),
  );

  it.effect("preserves media content type on partial WebM range responses", () =>
    withAssetRoute(
      Effect.gen(function* () {
        const { relativeUrl, sizeBytes } = yield* issueWorkspaceWebmAssetUrl;
        const client = yield* HttpClient.HttpClient;

        const response = yield* client.get(relativeUrl, {
          headers: { range: "bytes=1-3" },
        });

        expect(response.status).toBe(206);
        expect(response.headers["content-range"]).toBe(`bytes 1-3/${sizeBytes}`);
        expect(response.headers["content-type"]).toBe("video/webm");
        expect(response.headers["accept-ranges"]).toBe("bytes");
      }),
    ),
  );

  it.effect("keeps unsatisfiable WebM ranges as 416 responses", () =>
    withAssetRoute(
      Effect.gen(function* () {
        const { relativeUrl, sizeBytes } = yield* issueWorkspaceWebmAssetUrl;
        const client = yield* HttpClient.HttpClient;

        const response = yield* client.get(relativeUrl, {
          headers: { range: `bytes=${sizeBytes}-` },
        });

        expect(response.status).toBe(416);
        expect(response.headers["content-range"]).toBe(`bytes */${sizeBytes}`);
        expect(response.headers["content-type"]).toBe("video/webm");
      }),
    ),
  );
});
describe("assetResponseHeaders", () => {
  it("sandboxes SVG assets", () => {
    expect(assetResponseHeaders("/attachments/user-image.svg")).toMatchObject({
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      "X-Content-Type-Options": "nosniff",
    });
    expect(assetResponseHeaders("/attachments/user-image.SVG")).toHaveProperty(
      "Content-Security-Policy",
    );
  });

  it("does not apply document policy to raster images", () => {
    expect(assetResponseHeaders("/attachments/user-image.png")).toEqual({
      "Cache-Control": "private, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    });
  });

  it("serves inline videos with their declared mime type", () => {
    expect(
      assetResponseHeaders("/attachments/demo.bin", {
        mimeType: 'video/mp4; codecs="avc1.42E01E"',
      }),
    ).toEqual({
      "Cache-Control": "private, max-age=3600",
      "Content-Type": "video/mp4",
      "X-Content-Type-Options": "nosniff",
    });
  });
  it("declares utf-8 for HTML assets so non-ASCII content renders correctly", () => {
    expect(assetResponseHeaders("/workspace/page.html")).toHaveProperty(
      "Content-Type",
      "text/html; charset=utf-8",
    );
    expect(assetResponseHeaders("/workspace/PAGE.HTM")).toHaveProperty(
      "Content-Type",
      "text/html; charset=utf-8",
    );
  });

  it("downloads uploaded documents without executing their content", () => {
    expect(assetResponseHeaders("/attachments/upload.html", { download: true })).toMatchObject({
      "Content-Disposition": "attachment",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Content-Type": "application/octet-stream",
    });
  });

  it("serves the real filename and mime type when the claims carry them", () => {
    expect(
      assetResponseHeaders("/attachments/thread-1-abc-pdf.pdf", {
        download: true,
        fileName: "Q3 report.pdf",
        mimeType: "application/pdf",
      }),
    ).toMatchObject({
      "Content-Disposition": 'attachment; filename="Q3 report.pdf"',
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Content-Type": "application/pdf",
    });
  });

  it("keeps renderable mime types as octet-stream downloads", () => {
    for (const mimeType of [
      "text/html",
      "text/xml",
      "image/svg+xml",
      "application/xhtml+xml",
      "application/rss+xml",
      "APPLICATION/XML",
      "IMAGE/SVG+XML",
      "application/xml-dtd",
      "application/xml-external-parsed-entity",
      "not a mime",
    ]) {
      expect(
        assetResponseHeaders("/attachments/upload.bin", { download: true, mimeType }),
      ).toHaveProperty("Content-Type", "application/octet-stream");
    }
  });

  it("preserves official Office Open XML mime types", () => {
    for (const mimeType of [
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ]) {
      expect(
        assetResponseHeaders("/attachments/upload.bin", { download: true, mimeType }),
      ).toHaveProperty("Content-Type", mimeType);
    }
  });
});

describe("downloadContentDisposition", () => {
  it("quotes plain names and strips quotes and control characters", () => {
    expect(downloadContentDisposition("report.pdf")).toBe('attachment; filename="report.pdf"');
    expect(downloadContentDisposition('we"ird\n.pdf')).toBe('attachment; filename="we_ird_.pdf"');
  });

  it("adds an RFC 5987 encoded name for non-ASCII filenames", () => {
    expect(downloadContentDisposition("répört.pdf")).toBe(
      `attachment; filename="r_p_rt.pdf"; filename*=UTF-8''r%C3%A9p%C3%B6rt.pdf`,
    );
    expect(downloadContentDisposition("résumé'(*).pdf")).toBe(
      `attachment; filename="r_sum_'(*).pdf"; filename*=UTF-8''r%C3%A9sum%C3%A9%27%28%2A%29.pdf`,
    );
  });

  it("does not throw on unpaired surrogates in the filename", () => {
    expect(downloadContentDisposition("bad\ud800name.pdf")).toBe(
      `attachment; filename="bad_name.pdf"; filename*=UTF-8''bad%EF%BF%BDname.pdf`,
    );
  });
});
