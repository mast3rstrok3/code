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
});
