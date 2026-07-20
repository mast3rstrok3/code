import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  DevReviewId,
  EMPTY_DEV_REVIEW_EVIDENCE,
  EnvironmentId,
  PreviewAutomationExecutionError,
  ProviderInstanceId,
  ThreadId,
  type DevReviewEvidence,
  type DevReviewRecord,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import * as ServerConfig from "../../../config.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { handlers } from "./handlers.ts";

const reviewId = DevReviewId.make("dev-review-1");
const threadId = ThreadId.make("thread-review");
const environmentId = EnvironmentId.make("environment-1");
const providerInstanceId = ProviderInstanceId.make("codex");

// 1x1 transparent PNG.
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const emptyDocument = {
  verdict: "pending",
  summary: "",
  checks: [],
  findings: [],
  questions: [],
  nextSteps: [],
} as const;

const makeReview = (evidence: DevReviewEvidence): DevReviewRecord => ({
  id: reviewId,
  sourceThreadId: ThreadId.make("thread-source"),
  reviewThreadId: threadId,
  sourceTurnId: null,
  status: "running",
  document: emptyDocument,
  evidence,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const makeHarness = (input: {
  readonly review: DevReviewRecord;
  readonly brokerResults?: Partial<Record<string, unknown>>;
  readonly brokerFailure?: PreviewAutomationExecutionError;
}) => {
  const dispatched: OrchestrationCommand[] = [];
  const brokerInvocations: Array<{
    operation: string;
    tabId: string | undefined;
    timeoutMs: number | undefined;
  }> = [];

  const layer = Layer.mergeAll(
    Layer.succeed(McpInvocationContext.McpInvocationContext, {
      environmentId,
      threadId,
      providerSessionId: "provider-session-1",
      providerInstanceId,
      capabilities: new Set(["preview", "dev-review"] as const),
      issuedAt: 1,
      expiresAt: Number.MAX_SAFE_INTEGER,
    }),
    Layer.mock(ProjectionSnapshotQuery)({
      getThreadDetailById: () =>
        Effect.succeed(
          Option.some({
            id: threadId,
            devReviews: [input.review],
          } as never),
        ),
    }),
    Layer.mock(PreviewAutomationBroker.PreviewAutomationBroker)({
      invoke: (request) => {
        brokerInvocations.push({
          operation: request.operation,
          tabId: request.tabId,
          timeoutMs: request.timeoutMs,
        });
        if (input.brokerFailure) return Effect.fail(input.brokerFailure);
        return Effect.succeed(input.brokerResults?.[request.operation] as never);
      },
    }),
    Layer.succeed(
      OrchestrationEngineService,
      OrchestrationEngineService.of({
        latestSequence: Effect.succeed(0),
        readEvents: () => Stream.empty,
        dispatch: (command) => {
          dispatched.push(command);
          return Effect.succeed({ sequence: dispatched.length });
        },
        streamDomainEvents: Stream.empty,
      }),
    ),
    ServerConfig.ServerConfig.layerTest(process.cwd(), {
      prefix: "t3-dev-review-handlers-test-",
    }),
  ).pipe(Layer.provideMerge(NodeServices.layer));

  return { dispatched, brokerInvocations, layer };
};

const brokerFailure = new PreviewAutomationExecutionError({
  operation: "recordingStop",
  environmentId,
  threadId,
  providerSessionId: "provider-session-1",
  providerInstanceId,
  clientId: "server-preview:environment-1",
  connectionId: "connection-1",
  requestId: "request-1",
  timeoutMs: 15_000,
  remoteTag: "PreviewAutomationRecordingNotActiveError",
  remoteMessageLength: 10,
  cause: new Error("no active recording"),
});

describe("dev-review toolkit handlers", () => {
  it.effect("recording start invokes the broker and persists recording evidence", () => {
    const harness = makeHarness({
      review: makeReview(EMPTY_DEV_REVIEW_EVIDENCE),
      brokerResults: {
        recordingStart: {
          tabId: "tab-1",
          recording: true,
          startedAt: "2026-01-01T00:00:10.000Z",
        },
      },
    });

    return Effect.gen(function* () {
      const recording = yield* handlers.dev_review_recording_start({ reviewId });
      assert.strictEqual(recording.status, "recording");
      assert.strictEqual(recording.startedAt, "2026-01-01T00:00:10.000Z");
      assert.deepStrictEqual(harness.brokerInvocations, [
        { operation: "recordingStart", tabId: undefined, timeoutMs: undefined },
      ]);
      assert.strictEqual(harness.dispatched.length, 1);
      const command = harness.dispatched[0];
      assert.strictEqual(command?.type, "thread.dev-review.evidence.update");
      if (command?.type === "thread.dev-review.evidence.update") {
        assert.strictEqual(command.evidence.recording.status, "recording");
      }
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("recording stop persists the saved artifact without echoing the path", () => {
    const harness = makeHarness({
      review: makeReview({
        ...EMPTY_DEV_REVIEW_EVIDENCE,
        recording: {
          ...EMPTY_DEV_REVIEW_EVIDENCE.recording,
          status: "recording",
          startedAt: "2026-01-01T00:00:10.000Z",
        },
      }),
      brokerResults: {
        recordingStop: {
          id: "browser-recording-abc",
          tabId: "tab-1",
          path: "/state/preview-artifacts/browser-recording-abc.webm",
          mimeType: "video/webm",
          sizeBytes: 2048,
          createdAt: "2026-01-01T00:01:00.000Z",
        },
      },
    });

    return Effect.gen(function* () {
      const recording = yield* handlers.dev_review_recording_stop({ reviewId });
      assert.strictEqual(recording.status, "saved");
      assert.strictEqual(recording.mimeType, "video/webm");
      assert.strictEqual(recording.sizeBytes, 2048);
      assert.strictEqual(recording.startedAt, "2026-01-01T00:00:10.000Z");
      assert.deepStrictEqual(harness.brokerInvocations, [
        { operation: "recordingStop", tabId: undefined, timeoutMs: 60_000 },
      ]);
      const command = harness.dispatched[0];
      assert.strictEqual(command?.type, "thread.dev-review.evidence.update");
      if (command?.type === "thread.dev-review.evidence.update") {
        assert.strictEqual(
          command.evidence.recording.path,
          "/state/preview-artifacts/browser-recording-abc.webm",
        );
      }
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("recording stop records a failure instead of erroring", () => {
    const harness = makeHarness({
      review: makeReview(EMPTY_DEV_REVIEW_EVIDENCE),
      brokerFailure,
    });

    return Effect.gen(function* () {
      const recording = yield* handlers.dev_review_recording_stop({ reviewId });
      assert.strictEqual(recording.status, "failed");
      assert.isNotNull(recording.error);
      const command = harness.dispatched[0];
      assert.strictEqual(command?.type, "thread.dev-review.evidence.update");
      if (command?.type === "thread.dev-review.evidence.update") {
        assert.strictEqual(command.evidence.recording.status, "failed");
      }
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("capture screenshot writes the PNG and persists gallery evidence", () => {
    const harness = makeHarness({
      review: makeReview(EMPTY_DEV_REVIEW_EVIDENCE),
      brokerResults: {
        snapshot: {
          url: "http://127.0.0.1:5173/",
          title: "App",
          loading: false,
          visibleText: "",
          interactiveElements: [],
          accessibilityTree: null,
          consoleEntries: [],
          networkEntries: [],
          actionTimeline: [],
          screenshot: {
            mimeType: "image/png",
            data: PNG_BASE64,
            width: 1,
            height: 1,
          },
        },
      },
    });

    return Effect.gen(function* () {
      const result = yield* handlers.dev_review_capture_screenshot({
        reviewId,
        caption: "Initial load",
      });
      assert.strictEqual(result.id, "shot-1");
      assert.strictEqual(result.caption, "Initial load");
      assert.deepStrictEqual(harness.brokerInvocations, [
        { operation: "snapshot", tabId: undefined, timeoutMs: undefined },
      ]);

      const command = harness.dispatched[0];
      assert.strictEqual(command?.type, "thread.dev-review.evidence.update");
      if (command?.type !== "thread.dev-review.evidence.update") return;
      const screenshot = command.evidence.screenshots[0];
      assert.ok(screenshot);
      assert.strictEqual(screenshot.id, "shot-1");
      assert.strictEqual(screenshot.mimeType, "image/png");

      const fileSystem = yield* FileSystem.FileSystem;
      const written = yield* fileSystem.readFile(screenshot.path);
      assert.deepStrictEqual(written, new Uint8Array(Buffer.from(PNG_BASE64, "base64")));
      // Tool result stays metadata-only: no image bytes and no path.
      assert.notProperty(result, "path");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("rejects a passed verdict without saved recording and screenshots", () => {
    const harness = makeHarness({
      review: makeReview({
        recording: { ...EMPTY_DEV_REVIEW_EVIDENCE.recording, status: "failed" },
        screenshots: [],
      }),
    });

    return Effect.gen(function* () {
      const error = yield* handlers
        .dev_review_update({ reviewId, status: "passed" })
        .pipe(Effect.flip);
      assert.strictEqual(error._tag, "DevReviewError");
      assert.match(error.message, /saved screen recording/);
      assert.match(error.message, /dev_review_recording_start/);
      assert.match(error.message, /blocked/);
      assert.strictEqual(harness.dispatched.length, 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("accepts a terminal verdict once evidence is complete", () => {
    const harness = makeHarness({
      review: makeReview({
        recording: {
          status: "saved",
          path: "/state/preview-artifacts/browser-recording-abc.webm",
          mimeType: "video/webm",
          sizeBytes: 2048,
          startedAt: "2026-01-01T00:00:10.000Z",
          completedAt: "2026-01-01T00:01:00.000Z",
          error: null,
        },
        screenshots: [
          {
            id: "shot-1",
            path: "/state/preview-artifacts/dev-review/dev-review-1/shot-1.png",
            mimeType: "image/png",
            caption: "Initial load",
            capturedAt: "2026-01-01T00:00:30.000Z",
          },
        ],
      }),
    });

    return Effect.gen(function* () {
      const updated = yield* handlers.dev_review_update({ reviewId, status: "passed" });
      assert.strictEqual(updated.status, "passed");
      assert.strictEqual(harness.dispatched.length, 1);
      assert.strictEqual(harness.dispatched[0]?.type, "thread.dev-review.update");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("still allows blocked without evidence", () => {
    const harness = makeHarness({ review: makeReview(EMPTY_DEV_REVIEW_EVIDENCE) });

    return Effect.gen(function* () {
      const updated = yield* handlers.dev_review_update({ reviewId, status: "blocked" });
      assert.strictEqual(updated.status, "blocked");
      assert.strictEqual(harness.dispatched.length, 1);
    }).pipe(Effect.provide(harness.layer));
  });
});
