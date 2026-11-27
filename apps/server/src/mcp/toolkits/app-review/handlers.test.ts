import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  PreviewAutomationExecutionError,
  ProviderInstanceId,
  ThreadId,
  type AppReviewEvidence,
  type AppReviewScope,
  type PreviewRecordingMode,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as AppReviewStore from "../../../appReview/AppReviewStore.ts";
import * as AppReviewTests from "../../../appReview/AppReviewTests.ts";
import { createPendingAttachmentId } from "../../../attachmentStore.ts";
import * as ServerConfig from "../../../config.ts";
import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import * as PreviewRecordingPolicy from "../../../preview/PreviewRecordingPolicy.ts";
import { handlers } from "./handlers.ts";

const threadId = ThreadId.make("thread-review");
const environmentId = EnvironmentId.make("environment-1");
const providerInstanceId = ProviderInstanceId.make("codex");

// 1x1 transparent PNG.
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const failedDocument = {
  verdict: "failed",
  summary: "Checkout remains broken.",
  checks: [{ id: "checkout", label: "Submit checkout", status: "failed", notes: "Disabled." }],
  findings: [
    {
      id: "finding-1",
      severity: "major",
      title: "Submit remains disabled",
      details: "Checkout cannot continue.",
      reproduction: "Enter valid details and submit.",
      evidenceIds: ["shot-1"],
    },
  ],
  questions: [],
  nextSteps: ["Repair checkout submission."],
} as const;

const savedRecording: AppReviewEvidence["recording"] = {
  status: "saved",
  path: "/state/preview-artifacts/app-review/r/recording.webm",
  mimeType: "video/webm",
  sizeBytes: 2048,
  startedAt: "2026-01-01T00:00:10.000Z",
  completedAt: "2026-01-01T00:01:00.000Z",
  error: null,
};

const screenshot = {
  id: "shot-1",
  path: "/state/preview-artifacts/app-review/r/shot-1.png",
  mimeType: "image/png" as const,
  caption: "Initial load",
  capturedAt: "2026-01-01T00:00:30.000Z",
};

const testResult = (command: string, status: "passed" | "failed") => ({
  command,
  executedCommand: command,
  status,
  outputMarkdown: "",
  completedAt: "2026-01-01T00:02:00.000Z",
});

const makeHarness = (input: {
  readonly brokerResults?: Partial<Record<string, unknown>>;
  readonly brokerFailure?: PreviewAutomationExecutionError;
  readonly capabilities?: ReadonlyArray<McpInvocationContext.McpCapability>;
  readonly recordingMode?: PreviewRecordingMode;
  readonly failDomRecording?: boolean;
}) => {
  const brokerInvocations: Array<{ operation: string; input: unknown }> = [];
  const layer = Layer.mergeAll(
    Layer.succeed(McpInvocationContext.McpInvocationContext, {
      environmentId,
      capabilities: new Set(input.capabilities ?? (["preview", "app-review"] as const)),
      issuedAt: 1,
      thread: { threadId, providerSessionId: "provider-session-1", providerInstanceId },
      client: undefined,
      requestNamespace: "app-review-test",
    }),
    Layer.mock(PreviewAutomationBroker.PreviewAutomationBroker)({
      invoke: (request) => {
        brokerInvocations.push({ operation: request.operation, input: request.input });
        if (input.brokerFailure) return Effect.fail(input.brokerFailure);
        if (input.failDomRecording && (request.input as { format?: string }).format === "dom") {
          return Effect.fail(brokerFailure);
        }
        return Effect.succeed(input.brokerResults?.[request.operation] as never);
      },
    }),
    Layer.mock(AppReviewTests.AppReviewTests)({}),
    Layer.succeed(PreviewRecordingPolicy.PreviewRecordingPolicy, {
      modeForThread: () => Effect.succeed(input.recordingMode ?? "auto"),
    }),
    AppReviewStore.layer.pipe(Layer.provide(Layer.fresh(SqlitePersistenceMemory))),
    ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "t3-app-review-handlers-" }),
  ).pipe(Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));
  return { brokerInvocations, layer };
};

/** Give the thread an active review holding `evidence`. */
const seed = (scope: AppReviewScope, evidence: Partial<AppReviewEvidence>) =>
  Effect.gen(function* () {
    const store = yield* AppReviewStore.AppReviewStore;
    yield* store.start({ threadId, scope });
    return yield* store.update({ threadId }, (record) =>
      Effect.succeed({ ...record, evidence: { ...record.evidence, ...evidence } }),
    );
  });

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

describe("app-review toolkit handlers", () => {
  it.effect("refuses browser evidence when the agent has no preview browser", () => {
    const harness = makeHarness({ capabilities: ["app-review"] });
    return Effect.gen(function* () {
      const error = yield* handlers.app_review_recording_start({}).pipe(Effect.flip);
      assert.match(error.message, /preview browser is not available/);
      assert.deepStrictEqual(harness.brokerInvocations, []);
      const store = yield* AppReviewStore.AppReviewStore;
      assert.deepStrictEqual(yield* store.listForThread(threadId), []);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("requires the app-review capability", () => {
    const harness = makeHarness({ capabilities: ["preview"] });
    return Effect.gen(function* () {
      const error = yield* handlers.app_review_start({}).pipe(Effect.flip);
      assert.strictEqual(error._tag, "AppReviewError");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect(
    "starts a browser review on the first recording and saves the stopped recording under it",
    () => {
      const uploadedAttachmentId = createPendingAttachmentId(".webm");
      const harness = makeHarness({
        brokerResults: {
          recordingStart: {
            tabId: "tab-1",
            recording: true,
            startedAt: "2026-01-01T00:00:10.000Z",
          },
          recordingStop: {
            id: "recording",
            tabId: "tab-1",
            path: "/desktop/recording.webm",
            mimeType: "video/webm",
            sizeBytes: 6,
            createdAt: "2026-01-01T00:01:00.000Z",
            uploadedAttachmentId,
          },
        },
      });
      return Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const missing = yield* handlers.app_review_get({}).pipe(Effect.flip);
        assert.match(missing.message, /no App Review yet/);

        const started = yield* handlers.app_review_recording_start({});
        assert.strictEqual(started.status, "recording");
        assert.deepStrictEqual(harness.brokerInvocations[0], {
          operation: "recordingStart",
          input: { format: "dom" },
        });
        const review = yield* handlers.app_review_get({});
        assert.strictEqual(review.appReviewScope, "browser");
        assert.strictEqual(review.reviewThreadId, threadId);

        yield* fileSystem.makeDirectory(config.attachmentsDir, { recursive: true });
        yield* fileSystem.writeFileString(
          path.join(config.attachmentsDir, `${uploadedAttachmentId}.webm`),
          "video!",
        );
        const stopped = yield* handlers.app_review_recording_stop({});
        assert.strictEqual(stopped.status, "saved");
        assert.strictEqual(stopped.startedAt, "2026-01-01T00:00:10.000Z");
        assert.deepStrictEqual(harness.brokerInvocations.at(-1), {
          operation: "recordingStop",
          input: { transferToEnvironment: true },
        });
        const expected = path.join(
          config.stateDir,
          "preview-artifacts",
          "app-review",
          review.id,
          "recording.webm",
        );
        assert.strictEqual(stopped.path, expected);
        assert.strictEqual(yield* fileSystem.readFileString(expected), "video!");
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("falls back to video only when the project leaves the recorder on auto", () =>
    Effect.gen(function* () {
      const recordingStart = { tabId: "tab-1", recording: true, startedAt: null };
      const auto = makeHarness({ failDomRecording: true, brokerResults: { recordingStart } });
      yield* handlers.app_review_recording_start({}).pipe(Effect.provide(auto.layer));
      assert.deepStrictEqual(
        auto.brokerInvocations.map((call) => call.input),
        [{ format: "dom" }, { format: "video" }],
      );

      const dom = makeHarness({
        recordingMode: "dom",
        failDomRecording: true,
        brokerResults: { recordingStart },
      });
      yield* handlers.app_review_recording_start({}).pipe(Effect.flip, Effect.provide(dom.layer));
      assert.strictEqual(dom.brokerInvocations.length, 1);

      const video = makeHarness({ recordingMode: "video", brokerResults: { recordingStart } });
      yield* handlers.app_review_recording_start({}).pipe(Effect.provide(video.layer));
      assert.deepStrictEqual(video.brokerInvocations[0]?.input, { format: "video" });
    }),
  );

  it.effect("records a failed stop instead of erroring", () => {
    const harness = makeHarness({ brokerFailure });
    return Effect.gen(function* () {
      const recording = yield* handlers.app_review_recording_stop({});
      assert.strictEqual(recording.status, "failed");
      assert.isNotNull(recording.error);
      assert.strictEqual((yield* handlers.app_review_get({})).evidence.recording.status, "failed");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("writes screenshots to the review and returns only their metadata", () => {
    const harness = makeHarness({
      brokerResults: {
        snapshot: { screenshot: { mimeType: "image/png", data: PNG_BASE64, width: 1, height: 1 } },
      },
    });
    return Effect.gen(function* () {
      const first = yield* handlers.app_review_capture_screenshot({ caption: "Initial load" });
      const second = yield* handlers.app_review_capture_screenshot({ caption: "After submit" });
      assert.deepStrictEqual([first.id, second.id], ["shot-1", "shot-2"]);
      assert.notProperty(first, "path");
      const review = yield* handlers.app_review_get({});
      const fileSystem = yield* FileSystem.FileSystem;
      assert.deepStrictEqual(
        yield* fileSystem.readFile(review.evidence.screenshots[0]!.path),
        new Uint8Array(Buffer.from(PNG_BASE64, "base64")),
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("refuses 'passed' until the scope's evidence supports it", () => {
    const harness = makeHarness({});
    return Effect.gen(function* () {
      const pass = handlers.app_review_update({ status: "passed" });

      yield* seed("browser", { recording: { ...savedRecording, status: "failed" } });
      assert.match((yield* Effect.flip(pass)).message, /saved recording/);

      yield* seed("e2e", {});
      assert.match((yield* Effect.flip(pass)).message, /without E2E results/);

      yield* seed("e2e", {
        tests: [testResult("pnpm e2e", "passed"), testResult("pnpm e2e:mobile", "failed")],
      });
      assert.match((yield* Effect.flip(pass)).message, /'pnpm e2e:mobile' failed/);

      yield* seed("both", {
        recording: savedRecording,
        screenshots: [screenshot],
        tests: [testResult("pnpm e2e", "failed"), testResult("pnpm e2e", "passed")],
      });
      assert.strictEqual((yield* pass).status, "passed");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("accepts a failed verdict without evidence and keeps the brief from the start", () => {
    const harness = makeHarness({});
    return Effect.gen(function* () {
      yield* handlers.app_review_start({ scope: "browser", brief: "Checkout flow" });
      const updated = yield* handlers.app_review_update({
        status: "failed",
        document: failedDocument,
      });
      assert.strictEqual(updated.status, "failed");
      assert.strictEqual(updated.document.brief, "Checkout flow");
      assert.strictEqual(updated.document.summary, "Checkout remains broken.");
    }).pipe(Effect.provide(harness.layer));
  });
});
