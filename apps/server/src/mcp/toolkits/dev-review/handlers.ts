import {
  CommandId,
  DevReviewError,
  OrchestrationDispatchCommandError,
  OrchestrationGetSnapshotError,
  type DevReviewEvidence,
  type DevReviewId,
  type DevReviewRecord,
  type DevReviewScreenshotEvidence,
  type PreviewAutomationRecordingArtifact,
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

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import * as ServerConfig from "../../../config.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { DevReviewToolkit } from "./tools.ts";

const RECORDING_STOP_TIMEOUT_MS = 60_000;

const reviewError = (reviewId: DevReviewId | undefined, message: string, cause?: unknown) =>
  new DevReviewError({
    ...(reviewId === undefined ? {} : { reviewId }),
    message,
    ...(cause === undefined ? {} : { cause }),
  });

const dispatchError = (message: string, cause: unknown) =>
  new OrchestrationDispatchCommandError({
    message,
    cause,
  });

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

let commandIdSequence = 0;
const newCommandId = (prefix: string, reviewId: DevReviewId) =>
  Effect.sync(() => {
    commandIdSequence += 1;
    return CommandId.make(`${prefix}:${reviewId}:${commandIdSequence.toString(36)}`);
  });

const sanitizePathSegment = (value: string): string => {
  const normalized = value.replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized.length > 0 ? normalized.slice(0, 72) : "review";
};

const resolveDevReview = Effect.fn("DevReviewToolkit.resolveDevReview")(function* (
  reviewId?: DevReviewId,
) {
  const scope = yield* McpInvocationContext.requireMcpCapability("dev-review").pipe(
    Effect.mapError((cause) => reviewError(reviewId, cause.message, cause)),
  );
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const thread = yield* snapshotQuery.getThreadDetailById(scope.threadId).pipe(
    Effect.mapError(
      (cause) =>
        new OrchestrationGetSnapshotError({
          message: `Failed to load thread ${scope.threadId}.`,
          cause,
        }),
    ),
  );
  if (Option.isNone(thread)) {
    return yield* reviewError(reviewId, `Thread ${scope.threadId} was not found.`);
  }

  const review =
    reviewId === undefined
      ? (thread.value.devReviews.find((entry) => entry.reviewThreadId === scope.threadId) ??
        thread.value.devReviews[0])
      : thread.value.devReviews.find((entry) => entry.id === reviewId);
  if (review === undefined) {
    return yield* reviewError(reviewId, "Dev Review record not found for this thread.");
  }

  return { scope, review };
});

const dispatchEvidenceUpdate = Effect.fn("DevReviewToolkit.dispatchEvidenceUpdate")(
  function* (input: {
    readonly scope: McpInvocationContext.McpInvocationScope;
    readonly review: DevReviewRecord;
    readonly evidence: DevReviewEvidence;
  }) {
    const engine = yield* OrchestrationEngineService;
    const updatedAt = yield* nowIso;
    yield* engine
      .dispatch({
        type: "thread.dev-review.evidence.update",
        commandId: yield* newCommandId("dev-review-evidence", input.review.id),
        threadId: input.scope.threadId,
        reviewId: input.review.id,
        evidence: input.evidence,
        createdAt: updatedAt,
        updatedAt,
      })
      .pipe(
        Effect.mapError((cause) => dispatchError("Failed to persist Dev Review evidence.", cause)),
      );
  },
);

const invokeBrowser = Effect.fn("DevReviewToolkit.invokeBrowser")(function* <A>(
  scope: McpInvocationContext.McpInvocationScope,
  operation: "recordingStart" | "recordingStop" | "snapshot",
  tabId: PreviewTabId | undefined,
) {
  const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
  return (yield* broker.invoke({
    scope,
    operation,
    input: {},
    ...(tabId === undefined ? {} : { tabId }),
    ...(operation === "recordingStop" ? { timeoutMs: RECORDING_STOP_TIMEOUT_MS } : {}),
  })) as A;
});

export const handlers = {
  dev_review_get: (input) =>
    resolveDevReview(input.reviewId).pipe(Effect.map(({ review }) => review)),

  dev_review_update: (input) =>
    Effect.gen(function* () {
      const { scope, review } = yield* resolveDevReview(input.reviewId);
      if (input.status === undefined && input.document === undefined) {
        return yield* reviewError(review.id, "Provide status, document, or both.");
      }
      if (input.status === "passed" || input.status === "failed") {
        const { recording, screenshots } = review.evidence;
        if (recording.status !== "saved" || screenshots.length === 0) {
          return yield* reviewError(
            review.id,
            `Cannot set status '${input.status}' without browser evidence: a saved screen recording (current recording status is '${recording.status}') and at least one screenshot (currently ${screenshots.length}) are required. ` +
              "Run dev_review_recording_start, exercise the app with the preview_* tools, capture screenshots with dev_review_capture_screenshot, then dev_review_recording_stop. " +
              "If the browser tools are unavailable, set status 'blocked' instead.",
          );
        }
      }
      const engine = yield* OrchestrationEngineService;
      const updatedAt = yield* nowIso;
      yield* engine
        .dispatch({
          type: "thread.dev-review.update",
          commandId: yield* newCommandId("dev-review-update", review.id),
          threadId: scope.threadId,
          reviewId: review.id,
          ...(input.status === undefined ? {} : { status: input.status }),
          ...(input.document === undefined ? {} : { document: input.document }),
          createdAt: updatedAt,
          updatedAt,
        })
        .pipe(
          Effect.mapError((cause) => dispatchError("Failed to persist Dev Review update.", cause)),
        );
      return {
        ...review,
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.document === undefined ? {} : { document: input.document }),
        updatedAt,
      };
    }),

  dev_review_recording_start: (input) =>
    Effect.gen(function* () {
      const { scope, review } = yield* resolveDevReview(input.reviewId);
      const status = yield* invokeBrowser<PreviewAutomationRecordingStatus>(
        scope,
        "recordingStart",
        input.tabId,
      );
      const startedAt = status.startedAt ?? (yield* nowIso);
      const evidence: DevReviewEvidence = {
        ...review.evidence,
        recording: {
          status: "recording",
          path: null,
          mimeType: null,
          sizeBytes: null,
          startedAt,
          completedAt: null,
          error: null,
        },
      };
      yield* dispatchEvidenceUpdate({ scope, review, evidence });
      return evidence.recording;
    }),

  dev_review_recording_stop: (input) =>
    Effect.gen(function* () {
      const { scope, review } = yield* resolveDevReview(input.reviewId);
      const completedAt = yield* nowIso;
      const stopped = yield* Effect.exit(
        invokeBrowser<PreviewAutomationRecordingArtifact>(scope, "recordingStop", input.tabId),
      );
      // The artifact path never round-trips through the model: it is persisted
      // server-side and served later through signed asset URLs.
      const evidence: DevReviewEvidence =
        stopped._tag === "Success"
          ? {
              ...review.evidence,
              recording: {
                status: "saved",
                path: stopped.value.path,
                mimeType: stopped.value.mimeType,
                sizeBytes: stopped.value.sizeBytes,
                startedAt: review.evidence.recording.startedAt,
                completedAt,
                error: null,
              },
            }
          : {
              ...review.evidence,
              recording: {
                status: "failed",
                path: null,
                mimeType: null,
                sizeBytes: null,
                startedAt: review.evidence.recording.startedAt,
                completedAt,
                error: Cause.findErrorOption(stopped.cause).pipe(
                  Option.map((failure) => failure.message),
                  Option.getOrElse(() => Cause.pretty(stopped.cause)),
                ),
              },
            };
      yield* dispatchEvidenceUpdate({ scope, review, evidence });
      return evidence.recording;
    }),

  dev_review_capture_screenshot: (input) =>
    Effect.gen(function* () {
      const { scope, review } = yield* resolveDevReview(input.reviewId);
      const snapshot = yield* invokeBrowser<PreviewAutomationSnapshot>(
        scope,
        "snapshot",
        input.tabId,
      );
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const screenshotDir = path.join(
        config.stateDir,
        "preview-artifacts",
        "dev-review",
        sanitizePathSegment(review.id),
      );
      yield* fileSystem
        .makeDirectory(screenshotDir, { recursive: true })
        .pipe(
          Effect.mapError((cause) =>
            reviewError(review.id, "Failed to create the Dev Review evidence directory.", cause),
          ),
        );

      let index = review.evidence.screenshots.length + 1;
      let artifactPath = path.join(screenshotDir, `shot-${index}.png`);
      while (yield* fileSystem.exists(artifactPath).pipe(Effect.orElseSucceed(() => false))) {
        index += 1;
        artifactPath = path.join(screenshotDir, `shot-${index}.png`);
      }

      const bytes = Buffer.from(snapshot.screenshot.data, "base64");
      yield* fileSystem
        .writeFile(artifactPath, bytes)
        .pipe(
          Effect.mapError((cause) =>
            reviewError(review.id, "Failed to write the Dev Review screenshot.", cause),
          ),
        );

      const capturedAt = yield* nowIso;
      const screenshot: DevReviewScreenshotEvidence = {
        id: `shot-${index}`,
        path: artifactPath,
        mimeType: "image/png",
        caption: input.caption,
        capturedAt,
      };
      const evidence: DevReviewEvidence = {
        ...review.evidence,
        screenshots: [...review.evidence.screenshots, screenshot],
      };
      yield* dispatchEvidenceUpdate({ scope, review, evidence });
      // Image bytes stay on disk; returning only metadata keeps the tool
      // result small for the model.
      return { id: screenshot.id, caption: screenshot.caption, capturedAt };
    }),
} satisfies Parameters<typeof DevReviewToolkit.toLayer>[0];

export const DevReviewToolkitHandlersLive = DevReviewToolkit.toLayer(handlers);
