import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  APP_REVIEW_RECORDING_EVIDENCE_ID,
  AppReviewId,
  EMPTY_APP_REVIEW_EVIDENCE,
  AssetPreviewTypeValidationError,
  ThreadId,
  type AppReviewEvidence,
} from "@t3tools/contracts";
import { PROJECT_FAVICON_FALLBACK_MARKER } from "@t3tools/shared/projectFavicon";
import { describe, expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import {
  ProjectionThreadAppReviewRepository,
  type ProjectionThreadAppReview,
} from "../persistence/Services/ProjectionThreadAppReviews.ts";
import * as ProjectFaviconResolver from "../project/ProjectFaviconResolver.ts";
import * as T3ProjectFileLoader from "../project/T3ProjectFileLoader.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { ASSET_ROUTE_PREFIX, issueAssetUrl, resolveAsset } from "./AssetAccess.ts";

const configLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-asset-access-test-",
});
const appReviewRows = new Map<string, ProjectionThreadAppReview>();
const appReviewRepositoryLayer = Layer.succeed(
  ProjectionThreadAppReviewRepository,
  ProjectionThreadAppReviewRepository.of({
    upsert: (row) =>
      Effect.sync(() => {
        appReviewRows.set(row.reviewId, row);
      }),
    getById: ({ reviewId }) => Effect.sync(() => Option.fromNullishOr(appReviewRows.get(reviewId))),
    listByThreadId: () => Effect.succeed([]),
    listAll: () => Effect.succeed([]),
    deleteByThreadId: () => Effect.void,
  }),
);
const testLayer = Layer.mergeAll(
  configLayer,
  WorkspacePaths.layer,
  ProjectFaviconResolver.layer.pipe(
    Layer.provide(WorkspacePaths.layer),
    Layer.provide(T3ProjectFileLoader.layer),
  ),
  ServerSecretStore.layer.pipe(Layer.provide(configLayer)),
  appReviewRepositoryLayer,
).pipe(Layer.provideMerge(NodeServices.layer));

const seedAppReview = (reviewId: AppReviewId, evidence: AppReviewEvidence) => {
  appReviewRows.set(reviewId, {
    reviewId,
    sourceThreadId: ThreadId.make("thread-source"),
    reviewThreadId: ThreadId.make("thread-review"),
    sourceProposedPlan: null,
    sourceTurnId: null,
    status: "running",
    document: {
      verdict: "pending",
      summary: "",
      checks: [],
      findings: [],
      questions: [],
      nextSteps: [],
    },
    evidence,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
};

describe("AssetAccess", () => {
  it.effect("issues workspace URLs that resolve the entry file and sibling assets", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-asset-workspace-",
      });
      const htmlPath = path.join(root, "report.html");
      const cssPath = path.join(root, "report.css");
      yield* fileSystem.writeFileString(htmlPath, '<link rel="stylesheet" href="report.css">');
      yield* fileSystem.writeFileString(cssPath, "body { color: red; }");
      yield* fileSystem.writeFileString(path.join(root, ".env"), "SECRET=value");
      const canonicalHtmlPath = yield* fileSystem.realPath(htmlPath);
      const canonicalCssPath = yield* fileSystem.realPath(cssPath);

      const result = yield* issueAssetUrl({
        resource: {
          _tag: "workspace-file",
          threadId: ThreadId.make("thread-1"),
          path: htmlPath,
        },
        workspaceRoot: root,
      });
      const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
      const separatorIndex = suffix.indexOf("/");
      const token = suffix.slice(0, separatorIndex);

      expect(yield* resolveAsset(token, "report.html")).toEqual({
        kind: "file",
        path: canonicalHtmlPath,
      });
      expect(yield* resolveAsset(token, "report.css")).toEqual({
        kind: "file",
        path: canonicalCssPath,
      });
      expect(yield* resolveAsset(token, "../secret.txt")).toBeNull();
      expect(yield* resolveAsset(token, ".env")).toBeNull();
      expect(yield* resolveAsset(`${token}tampered`, "report.html")).toBeNull();
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects workspace files outside the authorized root", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-asset-root-",
      });
      const outside = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-asset-outside-",
      });
      const htmlPath = path.join(outside, "report.html");
      yield* fileSystem.writeFileString(htmlPath, "<p>outside</p>");

      const error = yield* issueAssetUrl({
        resource: {
          _tag: "workspace-file",
          threadId: ThreadId.make("thread-1"),
          path: htmlPath,
        },
        workspaceRoot: root,
      }).pipe(Effect.flip);
      expect(error.message).toBe("Workspace file path must be relative to the project root.");
      expect(error).toMatchObject({
        _tag: "AssetWorkspacePathValidationError",
        resource: {
          _tag: "workspace-file",
          threadId: "thread-1",
          path: htmlPath,
        },
      });
      expect(error.cause).toBeInstanceOf(WorkspacePaths.WorkspacePathOutsideRootError);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("preserves non-missing canonical path failures when issuing asset URLs", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-asset-permission-root-",
      });
      const htmlPath = path.join(root, "report.html");
      yield* fileSystem.writeFileString(htmlPath, "<p>report</p>");
      const cause = PlatformError.systemError({
        _tag: "PermissionDenied",
        module: "FileSystem",
        method: "realPath",
        pathOrDescriptor: htmlPath,
      });
      const failingFileSystem = FileSystem.FileSystem.of({
        ...fileSystem,
        realPath: () => Effect.fail(cause),
      });

      const error = yield* issueAssetUrl({
        resource: {
          _tag: "workspace-file",
          threadId: ThreadId.make("thread-1"),
          path: htmlPath,
        },
        workspaceRoot: root,
      }).pipe(Effect.provideService(FileSystem.FileSystem, failingFileSystem), Effect.flip);

      expect(error.message).toBe("Failed to inspect the workspace asset.");
      expect(error).toMatchObject({
        _tag: "AssetWorkspaceAssetInspectionError",
        resource: {
          _tag: "workspace-file",
          threadId: "thread-1",
          path: htmlPath,
        },
      });
      expect(error.cause).toBe(cause);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("issues exact workspace URLs for image previews", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-asset-image-workspace-",
      });
      const assetsDirectory = path.join(root, "assets");
      const imagePath = path.join(assetsDirectory, "icon.png");
      const siblingPath = path.join(assetsDirectory, "other.png");
      yield* fileSystem.makeDirectory(assetsDirectory, { recursive: true });
      yield* fileSystem.writeFile(imagePath, new Uint8Array([137, 80, 78, 71]));
      yield* fileSystem.writeFile(siblingPath, new Uint8Array([137, 80, 78, 71]));
      const canonicalImagePath = yield* fileSystem.realPath(imagePath);

      const result = yield* issueAssetUrl({
        resource: {
          _tag: "workspace-file",
          threadId: ThreadId.make("thread-1"),
          path: imagePath,
        },
        workspaceRoot: root,
      });
      const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
      const separatorIndex = suffix.indexOf("/");
      const token = suffix.slice(0, separatorIndex);

      expect(yield* resolveAsset(token, "icon.png")).toEqual({
        kind: "file",
        path: canonicalImagePath,
      });
      expect(yield* resolveAsset(token, "other.png")).toBeNull();
      expect(yield* resolveAsset(token, "../icon.png")).toBeNull();
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("issues exact workspace URLs for video previews", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-asset-video-workspace-",
      });
      const assetsDirectory = path.join(root, "artifacts", "hero-captures");
      const recordingPath = path.join(assetsDirectory, "recording.webm");
      const siblingVideoPath = path.join(assetsDirectory, "other.webm");
      const siblingImagePath = path.join(assetsDirectory, "other.png");
      const browserRecordingDirectory = path.join(root, ".logs", "recordings", "run-1");
      const browserRecordingPath = path.join(browserRecordingDirectory, "page@abcd1234.webm");
      yield* fileSystem.makeDirectory(assetsDirectory, { recursive: true });
      yield* fileSystem.makeDirectory(browserRecordingDirectory, { recursive: true });
      yield* fileSystem.writeFile(recordingPath, new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]));
      yield* fileSystem.writeFile(siblingVideoPath, new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]));
      yield* fileSystem.writeFile(siblingImagePath, new Uint8Array([137, 80, 78, 71]));
      yield* fileSystem.writeFile(browserRecordingPath, new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]));
      const canonicalRecordingPath = yield* fileSystem.realPath(recordingPath);
      const canonicalBrowserRecordingPath = yield* fileSystem.realPath(browserRecordingPath);

      const result = yield* issueAssetUrl({
        resource: {
          _tag: "workspace-file",
          threadId: ThreadId.make("thread-1"),
          path: recordingPath,
        },
        workspaceRoot: root,
      });
      const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
      const separatorIndex = suffix.indexOf("/");
      const token = suffix.slice(0, separatorIndex);

      expect(yield* resolveAsset(token, "recording.webm")).toEqual({
        kind: "file",
        path: canonicalRecordingPath,
      });
      expect(yield* resolveAsset(token, "other.webm")).toBeNull();
      expect(yield* resolveAsset(token, "other.png")).toBeNull();
      expect(yield* resolveAsset(token, "../recording.webm")).toBeNull();

      const browserRecordingResult = yield* issueAssetUrl({
        resource: {
          _tag: "workspace-file",
          threadId: ThreadId.make("thread-1"),
          path: browserRecordingPath,
        },
        workspaceRoot: root,
      });
      expect(browserRecordingResult.relativeUrl.endsWith("/page%40abcd1234.webm")).toBe(true);
      const browserRecordingSuffix = browserRecordingResult.relativeUrl.slice(
        `${ASSET_ROUTE_PREFIX}/`.length,
      );
      const browserRecordingSeparatorIndex = browserRecordingSuffix.indexOf("/");
      const browserRecordingToken = browserRecordingSuffix.slice(0, browserRecordingSeparatorIndex);

      expect(yield* resolveAsset(browserRecordingToken, "page@abcd1234.webm")).toEqual({
        kind: "file",
        path: canonicalBrowserRecordingPath,
      });
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("issues exact attachment capabilities by attachment id", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const attachmentId = "thread-1-00000000-0000-4000-8000-000000000001";
      const attachmentPath = path.join(config.attachmentsDir, `${attachmentId}.png`);
      yield* fileSystem.makeDirectory(config.attachmentsDir, { recursive: true });
      yield* fileSystem.writeFile(attachmentPath, new Uint8Array([1, 2, 3]));

      const result = yield* issueAssetUrl({
        resource: { _tag: "attachment", attachmentId },
      });
      const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
      const separatorIndex = suffix.indexOf("/");
      const token = suffix.slice(0, separatorIndex);

      expect(yield* resolveAsset(token, "ignored.png")).toEqual({
        kind: "file",
        path: attachmentPath,
      });
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("issues project favicon capabilities with a signed fallback", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-asset-favicon-",
      });
      const faviconPath = path.join(root, "favicon.svg");
      const initialFavicon = "<svg>a</svg>";
      const updatedFavicon = "<svg>b</svg>";
      expect(updatedFavicon).toHaveLength(initialFavicon.length);
      yield* fileSystem.writeFileString(faviconPath, initialFavicon);
      const canonicalFaviconPath = yield* fileSystem.realPath(faviconPath);

      const faviconResult = yield* issueAssetUrl({
        resource: { _tag: "project-favicon", cwd: root },
      });
      expect(faviconResult.sourcePath).toBe("favicon.svg");
      expect(faviconResult.relativeUrl).toMatch(/\/v[0-9a-f]{64}-favicon\.svg$/);
      expect(
        yield* issueAssetUrl({
          resource: { _tag: "project-favicon", cwd: root },
        }),
      ).toEqual(faviconResult);
      const faviconSuffix = faviconResult.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
      const faviconSeparatorIndex = faviconSuffix.indexOf("/");
      expect(
        yield* resolveAsset(
          faviconSuffix.slice(0, faviconSeparatorIndex),
          faviconSuffix.slice(faviconSeparatorIndex + 1),
        ),
      ).toEqual({ kind: "file", path: canonicalFaviconPath });

      yield* fileSystem.writeFileString(faviconPath, updatedFavicon);
      const updatedFaviconResult = yield* issueAssetUrl({
        resource: { _tag: "project-favicon", cwd: root },
      });
      expect(
        updatedFaviconResult.relativeUrl.slice(updatedFaviconResult.relativeUrl.lastIndexOf("/")),
      ).not.toBe(faviconResult.relativeUrl.slice(faviconResult.relativeUrl.lastIndexOf("/")));

      yield* fileSystem.remove(faviconPath);
      const fallbackResult = yield* issueAssetUrl({
        resource: { _tag: "project-favicon", cwd: root },
      });
      expect(fallbackResult.relativeUrl.endsWith(`/${PROJECT_FAVICON_FALLBACK_MARKER}`)).toBe(true);
      expect(fallbackResult.sourcePath).toBeUndefined();
      const fallbackSuffix = fallbackResult.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
      const fallbackSeparatorIndex = fallbackSuffix.indexOf("/");
      expect(
        yield* resolveAsset(
          fallbackSuffix.slice(0, fallbackSeparatorIndex),
          fallbackSuffix.slice(fallbackSeparatorIndex + 1),
        ),
      ).toBeNull();
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("issues project favicon capabilities for a saved override", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-asset-favicon-override-",
      });
      yield* fileSystem.makeDirectory(path.join(root, "brand"));
      yield* fileSystem.writeFileString(path.join(root, "brand", "custom.svg"), "<svg />");
      yield* fileSystem.writeFileString(path.join(root, "favicon.svg"), "<svg>auto</svg>");

      const result = yield* issueAssetUrl({
        resource: { _tag: "project-favicon", cwd: root },
        projectFaviconPath: "brand/custom.svg",
      });

      expect(result.sourcePath).toBe("brand/custom.svg");
      expect(result.relativeUrl).toMatch(/\/v[0-9a-f]{64}-custom\.svg$/);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("ignores a client favicon path hint", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-asset-favicon-hint-",
      });
      yield* fileSystem.makeDirectory(path.join(root, "brand"));
      yield* fileSystem.writeFileString(path.join(root, "brand", "hint.svg"), "<svg>hint</svg>");
      yield* fileSystem.writeFileString(path.join(root, "brand", "saved.svg"), "<svg>saved</svg>");

      const result = yield* issueAssetUrl({
        resource: { _tag: "project-favicon", cwd: root, path: "brand/hint.svg" },
        projectFaviconPath: "brand/saved.svg",
      });

      expect(result.sourcePath).toBe("brand/saved.svg");
      expect(result.relativeUrl).toMatch(/\/v[0-9a-f]{64}-saved\.svg$/);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("keeps automatic favicon resolution separate from a saved override", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-asset-favicon-automatic-",
      });
      yield* fileSystem.makeDirectory(path.join(root, "brand"));
      yield* fileSystem.writeFileString(path.join(root, "brand", "saved.svg"), "<svg>saved</svg>");
      yield* fileSystem.writeFileString(path.join(root, "favicon.svg"), "<svg>automatic</svg>");

      const result = yield* issueAssetUrl({
        resource: { _tag: "project-favicon", cwd: root },
      });

      expect(result.sourcePath).toBe("favicon.svg");
      expect(result.relativeUrl).toMatch(/\/v[0-9a-f]{64}-favicon\.svg$/);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects a resolved project favicon with a non-image extension", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-asset-favicon-type-",
      });
      yield* fileSystem.writeFileString(path.join(root, "secret.txt"), "not an image");

      const error = yield* issueAssetUrl({
        resource: { _tag: "project-favicon", cwd: root },
        projectFaviconPath: "secret.txt",
      }).pipe(Effect.flip);

      expect(error).toBeInstanceOf(AssetPreviewTypeValidationError);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("buckets project favicon expiry after content hashing", () =>
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-asset-favicon-expiry-",
      });
      yield* fileSystem.writeFileString(path.join(root, "favicon.svg"), "<svg />");

      const bucketMs = 30 * 60 * 1000;
      yield* TestClock.setTime(bucketMs - 1);
      const crossingCrypto = Crypto.make({
        randomBytes: (size) => new Uint8Array(size),
        digest: (algorithm, data) =>
          TestClock.adjust("2 millis").pipe(Effect.andThen(crypto.digest(algorithm, data))),
      });
      const result = yield* issueAssetUrl({
        resource: { _tag: "project-favicon", cwd: root },
      }).pipe(Effect.provideService(Crypto.Crypto, crossingCrypto));

      expect(result.expiresAt).toBe(3 * bucketMs);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("preserves structured project favicon resolution causes", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-asset-favicon-error-",
      });
      const platformCause = PlatformError.systemError({
        _tag: "PermissionDenied",
        module: "FileSystem",
        method: "stat",
      });
      const resolutionCause = new ProjectFaviconResolver.ProjectFaviconResolutionError({
        operation: "stat-candidate",
        workspaceRoot: root,
        relativePath: "favicon.svg",
        cause: platformCause,
      });
      const resolver = ProjectFaviconResolver.ProjectFaviconResolver.of({
        resolvePath: () => Effect.fail(resolutionCause),
      });

      const error = yield* issueAssetUrl({
        resource: { _tag: "project-favicon", cwd: root },
      }).pipe(
        Effect.provideService(ProjectFaviconResolver.ProjectFaviconResolver, resolver),
        Effect.flip,
      );

      expect(error.message).toBe("Failed to resolve project favicon.");
      expect(error._tag).toBe("AssetProjectFaviconResolutionError");
      expect(error.cause).toBe(resolutionCause);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("round-trips a saved app-review recording through signed URLs", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const artifactsDir = path.join(config.stateDir, "preview-artifacts");
      const webmPath = path.join(artifactsDir, "browser-recording-test.webm");
      yield* fileSystem.makeDirectory(artifactsDir, { recursive: true });
      yield* fileSystem.writeFile(webmPath, new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]));
      const canonicalWebmPath = yield* fileSystem.realPath(webmPath);

      const reviewId = AppReviewId.make("app-review-recording");
      seedAppReview(reviewId, {
        recording: {
          status: "saved",
          path: webmPath,
          mimeType: "video/webm",
          sizeBytes: 4,
          startedAt: "2026-01-01T00:00:00.000Z",
          completedAt: "2026-01-01T00:01:00.000Z",
          error: null,
        },
        screenshots: [],
      });

      const result = yield* issueAssetUrl({
        resource: {
          _tag: "app-review-evidence",
          reviewId,
          evidenceId: APP_REVIEW_RECORDING_EVIDENCE_ID,
        },
      });
      expect(result.relativeUrl.endsWith("/browser-recording-test.webm")).toBe(true);
      const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
      const separatorIndex = suffix.indexOf("/");
      const token = suffix.slice(0, separatorIndex);

      expect(yield* resolveAsset(token, "browser-recording-test.webm")).toEqual({
        kind: "file",
        path: canonicalWebmPath,
      });
      expect(yield* resolveAsset(`${token}tampered`, "browser-recording-test.webm")).toBeNull();
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("round-trips app-review screenshots by evidence id", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const reviewId = AppReviewId.make("app-review-screenshot");
      const screenshotDir = path.join(config.stateDir, "preview-artifacts", "app-review", reviewId);
      const screenshotPath = path.join(screenshotDir, "shot-1.png");
      yield* fileSystem.makeDirectory(screenshotDir, { recursive: true });
      yield* fileSystem.writeFile(screenshotPath, new Uint8Array([137, 80, 78, 71]));
      const canonicalScreenshotPath = yield* fileSystem.realPath(screenshotPath);

      seedAppReview(reviewId, {
        recording: EMPTY_APP_REVIEW_EVIDENCE.recording,
        screenshots: [
          {
            id: "shot-1",
            path: screenshotPath,
            mimeType: "image/png",
            caption: "Initial load",
            capturedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      });

      const result = yield* issueAssetUrl({
        resource: { _tag: "app-review-evidence", reviewId, evidenceId: "shot-1" },
      });
      const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
      const token = suffix.slice(0, suffix.indexOf("/"));

      expect(yield* resolveAsset(token, "shot-1.png")).toEqual({
        kind: "file",
        path: canonicalScreenshotPath,
      });

      const missing = yield* issueAssetUrl({
        resource: { _tag: "app-review-evidence", reviewId, evidenceId: "shot-2" },
      }).pipe(Effect.flip);
      expect(missing._tag).toBe("AssetAppReviewEvidenceNotFoundError");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects app-review evidence that is not saved or escapes the artifacts root", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      // Recording not yet saved: no URL may be minted.
      const recordingReviewId = AppReviewId.make("app-review-in-progress");
      seedAppReview(recordingReviewId, {
        recording: { ...EMPTY_APP_REVIEW_EVIDENCE.recording, status: "recording" },
        screenshots: [],
      });
      const notSaved = yield* issueAssetUrl({
        resource: {
          _tag: "app-review-evidence",
          reviewId: recordingReviewId,
          evidenceId: APP_REVIEW_RECORDING_EVIDENCE_ID,
        },
      }).pipe(Effect.flip);
      expect(notSaved._tag).toBe("AssetAppReviewEvidenceNotFoundError");

      // Evidence path outside stateDir/preview-artifacts: rejected even though
      // the file exists.
      const outside = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-asset-evidence-outside-",
      });
      const outsidePath = path.join(outside, "escape.webm");
      yield* fileSystem.writeFile(outsidePath, new Uint8Array([1]));
      const traversalReviewId = AppReviewId.make("app-review-traversal");
      seedAppReview(traversalReviewId, {
        recording: {
          status: "saved",
          path: outsidePath,
          mimeType: "video/webm",
          sizeBytes: 1,
          startedAt: null,
          completedAt: null,
          error: null,
        },
        screenshots: [],
      });
      const traversal = yield* issueAssetUrl({
        resource: {
          _tag: "app-review-evidence",
          reviewId: traversalReviewId,
          evidenceId: APP_REVIEW_RECORDING_EVIDENCE_ID,
        },
      }).pipe(Effect.flip);
      expect(traversal._tag).toBe("AssetAppReviewEvidenceNotFoundError");

      // Unknown review id.
      const unknown = yield* issueAssetUrl({
        resource: {
          _tag: "app-review-evidence",
          reviewId: AppReviewId.make("app-review-missing"),
          evidenceId: APP_REVIEW_RECORDING_EVIDENCE_ID,
        },
      }).pipe(Effect.flip);
      expect(unknown._tag).toBe("AssetAppReviewEvidenceNotFoundError");
    }).pipe(Effect.provide(testLayer)),
  );
});
