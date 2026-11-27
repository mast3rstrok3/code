import * as McpToolAccess from "../../McpToolAccess.ts";
import {
  AppReviewError,
  hasCompleteAppReviewEvidence,
  PREVIEW_RECORDING_STOP_TIMEOUT_MS,
  type AppReviewEvidence,
  type AppReviewRecord,
  type AppReviewScope,
  type AppReviewScreenshotEvidence,
  type PreviewAutomationRecordingStatus,
  type PreviewAutomationSnapshot,
  type PreviewTabId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as AppReviewStore from "../../../appReview/AppReviewStore.ts";
import * as AppReviewTests from "../../../appReview/AppReviewTests.ts";
import * as ServerConfig from "../../../config.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import * as PreviewRecordingPolicy from "../../../preview/PreviewRecordingPolicy.ts";
import { claimPreviewRecording } from "../preview/handlers.ts";
import { AppReviewToolkit } from "./tools.ts";

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const requireScope = McpInvocationContext.requireThreadMcpCapability("app-review").pipe(
  Effect.mapError((cause) => new AppReviewError({ message: cause.message, cause })),
);

/** Where a review's browser evidence lives, below `stateDir/preview-artifacts`. */
const evidenceDir = Effect.fn("AppReviewToolkit.evidenceDir")(function* (review: AppReviewRecord) {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = path.join(
    config.stateDir,
    "preview-artifacts",
    "app-review",
    review.id.replace(/[^a-zA-Z0-9_.-]+/g, "-").slice(0, 96),
  );
  yield* fileSystem.makeDirectory(dir, { recursive: true }).pipe(
    Effect.mapError(
      (cause) =>
        new AppReviewError({
          reviewId: review.id,
          message: "Failed to create the App Review evidence directory.",
          cause,
        }),
    ),
  );
  return dir;
});

const invokeBrowser = Effect.fn("AppReviewToolkit.invokeBrowser")(function* <A>(
  scope: McpInvocationContext.McpThreadInvocationScope,
  operation: "recordingStart" | "recordingStop" | "snapshot",
  tabId: PreviewTabId | undefined,
  input: object = operation === "recordingStop" ? { transferToEnvironment: true } : {},
) {
  if (!scope.capabilities.has("preview")) {
    return yield* new AppReviewError({
      message:
        "The preview browser is not available to this agent. Turn on browser tools for it, or review with E2E tests only.",
    });
  }
  const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
  return (yield* broker.invoke({
    scope,
    operation,
    input,
    ...(tabId === undefined ? {} : { tabId }),
    ...(operation === "recordingStop" ? { timeoutMs: PREVIEW_RECORDING_STOP_TIMEOUT_MS } : {}),
  })) as A;
});

const browserEvidence = "browser" satisfies AppReviewScope;

/** Why `passed` is refused for this review, or null when its evidence supports it. */
const appReviewPassBlocker = (review: AppReviewRecord): string | null => {
  const scope = review.appReviewScope ?? "browser";
  if (scope !== "browser") {
    const tests = review.evidence.tests ?? [];
    if (tests.length === 0) {
      return "Cannot set status 'passed' without E2E results. Run the project's test commands with app_review_run_test first.";
    }
    const latest = new Map(tests.map((result) => [result.command, result] as const));
    const failed = [...latest.values()].filter((result) => result.status === "failed");
    if (failed.length > 0) {
      return `Cannot set status 'passed' while the latest run of ${failed.map((result) => `'${result.command}'`).join(", ")} failed. Fix and rerun it, or set status 'failed'.`;
    }
  }
  if (scope !== "e2e" && !hasCompleteAppReviewEvidence(review.evidence)) {
    const { recording, screenshots } = review.evidence;
    return (
      `Cannot set status 'passed' without browser evidence: a saved recording (status is '${recording.status}') and at least one screenshot (${screenshots.length} so far). ` +
      "Run app_review_recording_start, exercise the app with the preview_* tools, capture screenshots with app_review_capture_screenshot, then app_review_recording_stop. " +
      "If the browser cannot reach the app, set status 'failed' and say why."
    );
  }
  return null;
};

export const handlers = {
  app_review_start: Effect.fn("AppReviewToolkit.start")(function* (input) {
    const scope = yield* requireScope;
    const store = yield* AppReviewStore.AppReviewStore;
    return yield* store.start({
      threadId: scope.thread.threadId,
      scope: input.scope ?? "both",
      brief: input.brief,
    });
  }),

  app_review_get: Effect.fn("AppReviewToolkit.get")(function* (input) {
    const scope = yield* requireScope;
    const store = yield* AppReviewStore.AppReviewStore;
    const threadId = scope.thread.threadId;
    const review =
      input.reviewId === undefined
        ? yield* store.active(threadId)
        : (yield* store.get(input.reviewId)).pipe(
            Option.filter(
              (record) => record.reviewThreadId === threadId || record.sourceThreadId === threadId,
            ),
          );
    if (Option.isNone(review)) {
      return yield* new AppReviewError({
        ...(input.reviewId === undefined ? {} : { reviewId: input.reviewId }),
        message:
          input.reviewId === undefined
            ? "This thread has no App Review yet. Call app_review_start, or run a test or start a recording to begin one."
            : "That App Review is not on this thread.",
      });
    }
    return review.value;
  }),

  app_review_update: Effect.fn("AppReviewToolkit.update")(function* (input) {
    const scope = yield* requireScope;
    if (input.status === undefined && input.document === undefined) {
      return yield* new AppReviewError({ message: "Provide status, document, or both." });
    }
    const store = yield* AppReviewStore.AppReviewStore;
    return yield* store.update({ threadId: scope.thread.threadId }, (review) => {
      const blocker = input.status === "passed" ? appReviewPassBlocker(review) : null;
      if (blocker !== null)
        return Effect.fail(new AppReviewError({ reviewId: review.id, message: blocker }));
      // The brief is set once at start; a document sent without one keeps it.
      const brief = input.document?.brief ?? review.document.brief;
      return Effect.succeed({
        ...review,
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.document === undefined
          ? {}
          : { document: brief === undefined ? input.document : { ...input.document, brief } }),
      });
    });
  }),

  app_review_run_test: Effect.fn("AppReviewToolkit.runTest")(function* (input) {
    const scope = yield* requireScope;
    const tests = yield* AppReviewTests.AppReviewTests;
    return yield* tests.run({ threadId: scope.thread.threadId, ...input });
  }),

  app_review_recording_start: Effect.fn("AppReviewToolkit.recordingStart")(function* (input) {
    const scope = yield* requireScope;
    const policy = yield* PreviewRecordingPolicy.PreviewRecordingPolicy;
    const mode = yield* policy.modeForThread(scope.thread.threadId);
    const start = (format: "dom" | "video") =>
      invokeBrowser<PreviewAutomationRecordingStatus>(scope, "recordingStart", input.tabId, {
        format,
      });
    // A DOM replay by default; `auto` falls back to video where rrweb cannot attach.
    const status =
      mode === "video"
        ? yield* start("video")
        : yield* start("dom").pipe(
            Effect.catch((error) => (mode === "auto" ? start("video") : Effect.fail(error))),
          );
    const startedAt = status.startedAt ?? (yield* nowIso);
    const store = yield* AppReviewStore.AppReviewStore;
    const review = yield* store.update(
      { threadId: scope.thread.threadId, evidence: browserEvidence },
      (record) =>
        Effect.succeed({
          ...record,
          evidence: {
            ...record.evidence,
            recording: {
              status: "recording",
              path: null,
              mimeType: null,
              sizeBytes: null,
              startedAt,
              completedAt: null,
              error: null,
            },
          },
        }),
    );
    return review.evidence.recording;
  }),

  app_review_recording_stop: Effect.fn("AppReviewToolkit.recordingStop")(function* (input) {
    const scope = yield* requireScope;
    const threadId = scope.thread.threadId;
    const stopped = yield* Effect.exit(
      invokeBrowser<unknown>(scope, "recordingStop", input.tabId).pipe(
        Effect.flatMap((response) => claimPreviewRecording(threadId, response)),
      ),
    );
    const completedAt = yield* nowIso;
    const store = yield* AppReviewStore.AppReviewStore;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const review = yield* store.update(
      { threadId, evidence: browserEvidence },
      Effect.fn("AppReviewToolkit.saveRecording")(function* (record) {
        const startedAt = record.evidence.recording.startedAt;
        if (stopped._tag === "Failure") {
          return {
            ...record,
            evidence: {
              ...record.evidence,
              recording: {
                status: "failed",
                path: null,
                mimeType: null,
                sizeBytes: null,
                startedAt,
                completedAt,
                error: Cause.findErrorOption(stopped.cause).pipe(
                  Option.map((failure) => failure.message),
                  Option.getOrElse(() => Cause.pretty(stopped.cause)),
                ),
              },
            },
          } satisfies AppReviewRecord;
        }
        // Thread attachments are not review evidence; the recording moves under the review.
        const artifact = stopped.value;
        const target = path.join(
          yield* evidenceDir(record),
          `recording${path.extname(artifact.path)}`,
        );
        yield* fileSystem.rename(artifact.path, target).pipe(
          Effect.mapError(
            (cause) =>
              new AppReviewError({
                reviewId: record.id,
                message: "Failed to save the App Review recording.",
                cause,
              }),
          ),
        );
        return {
          ...record,
          evidence: {
            ...record.evidence,
            recording: {
              status: "saved",
              path: target,
              mimeType: artifact.mimeType,
              sizeBytes: artifact.sizeBytes,
              startedAt,
              completedAt,
              error: null,
            },
          },
        } satisfies AppReviewRecord;
      }),
    );
    // The artifact path never reaches the model; clients read it through signed asset URLs.
    return review.evidence.recording;
  }),

  app_review_capture_screenshot: Effect.fn("AppReviewToolkit.captureScreenshot")(function* (input) {
    const scope = yield* requireScope;
    const snapshot = yield* invokeBrowser<PreviewAutomationSnapshot>(
      scope,
      "snapshot",
      input.tabId,
    );
    const capturedAt = yield* nowIso;
    const store = yield* AppReviewStore.AppReviewStore;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const review = yield* store.update(
      { threadId: scope.thread.threadId, evidence: browserEvidence },
      Effect.fn("AppReviewToolkit.saveScreenshot")(function* (record) {
        const dir = yield* evidenceDir(record);
        let index = record.evidence.screenshots.length + 1;
        while (
          yield* fileSystem
            .exists(path.join(dir, `shot-${index}.png`))
            .pipe(Effect.orElseSucceed(() => false))
        ) {
          index += 1;
        }
        const artifactPath = path.join(dir, `shot-${index}.png`);
        yield* fileSystem
          .writeFile(artifactPath, Buffer.from(snapshot.screenshot.data, "base64"))
          .pipe(
            Effect.mapError(
              (cause) =>
                new AppReviewError({
                  reviewId: record.id,
                  message: "Failed to write the App Review screenshot.",
                  cause,
                }),
            ),
          );
        const screenshot: AppReviewScreenshotEvidence = {
          id: `shot-${index}`,
          path: artifactPath,
          mimeType: "image/png",
          caption: input.caption,
          capturedAt,
        };
        const evidence: AppReviewEvidence = {
          ...record.evidence,
          screenshots: [...record.evidence.screenshots, screenshot],
        };
        return { ...record, evidence } satisfies AppReviewRecord;
      }),
    );
    const screenshot = review.evidence.screenshots.at(-1)!;
    // Image bytes stay on disk, which keeps the tool result small.
    return { id: screenshot.id, caption: screenshot.caption, capturedAt };
  }),
} satisfies Parameters<typeof AppReviewToolkit.toLayer>[0];

export const layer = McpToolAccess.toLayer(AppReviewToolkit, {
  app_review_start: McpToolAccess.actsAsCaller(handlers.app_review_start),
  app_review_get: McpToolAccess.readsAsCaller(handlers.app_review_get),
  app_review_update: McpToolAccess.actsAsCaller(handlers.app_review_update),
  app_review_run_test: McpToolAccess.actsAsCaller(handlers.app_review_run_test),
  app_review_recording_start: McpToolAccess.actsAsCaller(handlers.app_review_recording_start),
  app_review_recording_stop: McpToolAccess.actsAsCaller(handlers.app_review_recording_stop),
  app_review_capture_screenshot: McpToolAccess.actsAsCaller(handlers.app_review_capture_screenshot),
});
