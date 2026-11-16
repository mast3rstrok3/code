import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  type ModelSelection,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as UsageLimitRecoveryWorker from "./UsageLimitRecoveryWorker.ts";
import {
  limitRecoveryCommand,
  makeWorkflowModelFallback,
  workflowStartingModelFallback,
} from "./UsageLimitRecoveryWorker.ts";

const rootId = ThreadId.make("thread-workflow-root");
const reviewId = ThreadId.make("thread-code-review");
const runId = RunId.make("run-review-1");
const starting: ModelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6" };
const pinned: ModelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-opus-5-5",
};

const shell = (overrides: Partial<OrchestrationV2ThreadShell>) =>
  ({
    id: reviewId,
    status: "failed",
    lastErrorClass: "usage_limit",
    latestRunId: runId,
    modelSelection: pinned,
    workflowRole: "implementation-code-reviewer",
    workflowContext: null,
    workflowPreset: null,
    lineage: { parentThreadId: rootId, relationshipToParent: null, rootThreadId: rootId },
    archivedAt: null,
    deletedAt: null,
    settledOverride: null,
    pendingRuntimeRequest: null,
    ...overrides,
  }) as OrchestrationV2ThreadShell;

const root = shell({
  id: rootId,
  status: "idle",
  lastErrorClass: null,
  modelSelection: starting,
  workflowRole: null,
  workflowPreset: "fast-plan",
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: rootId },
});

describe("workflowStartingModelFallback", () => {
  it("continues a limited step on the model its workflow started on", () => {
    const command = workflowStartingModelFallback({
      thread: shell({}),
      root,
      settings: DEFAULT_SERVER_SETTINGS,
    });
    assert.strictEqual(command?.type, "message.dispatch");
    if (command?.type !== "message.dispatch") return;
    assert.deepStrictEqual(command.modelSelection, starting);
    assert.strictEqual(command.manualContinuationOfRunId, runId);
    assert.strictEqual(command.commandId, `limit-fallback:${reviewId}:${runId}`);
    assert.include(command.text, "claude-opus-5-5 (claudeAgent) hit its usage limit");
    assert.include(command.text, "gpt-6 (codex)");
  });

  it("parks a step already on the starting model until the reset", () => {
    assert.isNull(
      workflowStartingModelFallback({
        thread: shell({ modelSelection: starting }),
        root,
        settings: DEFAULT_SERVER_SETTINGS,
      }),
    );
  });

  it("leaves other failures, plain threads and stopped threads alone", () => {
    const decide = (thread: OrchestrationV2ThreadShell, workflowRoot = root) =>
      workflowStartingModelFallback({
        thread,
        root: workflowRoot,
        settings: DEFAULT_SERVER_SETTINGS,
      });
    assert.isNull(decide(shell({ lastErrorClass: "provider_error" })));
    assert.isNull(decide(shell({ status: "idle" })));
    assert.isNull(decide(shell({ workflowRole: null })));
    assert.isNull(decide(shell({ archivedAt: DateTime.makeUnsafe("2026-10-27T00:00:00Z") })));
    assert.isNull(decide(shell({}), { ...root, workflowPreset: null }));
  });

  it("parks when the starting model's provider is turned off", () => {
    assert.isNull(
      workflowStartingModelFallback({
        thread: shell({}),
        root,
        settings: {
          ...DEFAULT_SERVER_SETTINGS,
          providerInstances: {
            [starting.instanceId]: { driver: "codex", enabled: false },
          },
        } as never,
      }),
    );
  });
});

describe("makeWorkflowModelFallback", () => {
  it.effect("moves a failed workflow step onto the starting model once its run fails", () => {
    const commands: OrchestrationV2ServerCommand[] = [];
    const layer = Layer.mergeAll(
      Layer.mock(Orchestrator.OrchestratorV2)({
        getThreadShell: (id) =>
          Effect.succeed(id === rootId ? root : id === reviewId ? shell({}) : null),
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        dispatch: (command) =>
          Effect.sync(() => {
            commands.push(command);
            return { sequence: commands.length, storedEvents: [] } as never;
          }),
      }),
      ServerSettings.layerTest(),
    );
    return Effect.gen(function* () {
      const fallback = yield* makeWorkflowModelFallback;
      yield* fallback.onEvent({
        type: "run.updated",
        threadId: reviewId,
        payload: { id: runId, status: "failed" },
      } as never);
      // A finished run is not a limit.
      yield* fallback.onEvent({
        type: "run.updated",
        threadId: reviewId,
        payload: { id: runId, status: "completed" },
      } as never);
      yield* fallback.drain;
      assert.strictEqual(commands.length, 1);
      const [command] = commands;
      assert.strictEqual(command?.type, "message.dispatch");
      if (command?.type !== "message.dispatch") return;
      assert.strictEqual(command.threadId, reviewId);
      assert.deepStrictEqual(command.modelSelection, starting);
    }).pipe(Effect.scoped, Effect.provide(layer));
  });
});

it.effect("idle sweeps skip SQL until the next wake time or a relevant event", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-07-01T09:00:00.000Z"));
    const startMs = Date.parse("2026-07-01T09:00:00.000Z");
    const queries = yield* Queue.unbounded<number>();
    // The sweep and the workflow model fallback each subscribe, so every subscriber sees each event.
    const events = yield* PubSub.unbounded<OrchestrationV2DomainEvent>({ replay: 8 });
    const layer = UsageLimitRecoveryWorker.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Scheduler.layer,
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getLimitRecoveryCandidates: () =>
              Clock.currentTimeMillis.pipe(
                Effect.flatMap((nowMs) => Queue.offer(queries, nowMs - startMs)),
                Effect.as([]),
              ),
            // One armed thread resets at 60s.
            getLimitRecoveryWakeAt: (now) =>
              Effect.succeed(
                DateTime.toEpochMillis(now) < startMs + 60_000 ? startMs + 60_000 : null,
              ),
          }),
          Layer.mock(ThreadManagement.ThreadManagementService)({}),
          Layer.mock(Orchestrator.OrchestratorV2)({
            streamDomainEvents: Stream.fromPubSub(events),
          }),
          Layer.mock(ServerSettings.ServerSettingsService)({
            getSettings: Effect.succeed({
              autoResumeLimitedThreads: true,
              snoozeLimitedThreads: false,
            } as never),
            streamChanges: Stream.never,
          }),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      assert.equal(yield* Queue.take(queries), 0);
      // Eleven idle ticks before the recorded wake time, then the wake tick itself.
      yield* TestClock.adjust("60 seconds");
      assert.equal(yield* Queue.take(queries), 60_000);
      yield* PubSub.publish(events, {
        type: "turn-item.updated",
        payload: { type: "assistant_message" },
      } as never);
      yield* TestClock.adjust("30 seconds");
      yield* PubSub.publish(events, {
        type: "run.updated",
        payload: { status: "failed" },
      } as never);
      yield* TestClock.adjust("5 seconds");
      // A streaming item at 90s does not wake it; the failed run does on the 95s tick.
      assert.equal(yield* Queue.take(queries), 95_000);
    }).pipe(Effect.provide(layer));
  }),
);

const HOUR_MS = 60 * 60 * 1000;
const nowMs = Date.parse("2026-10-19T12:00:00.000Z");

const failedThread = (failedAgoMs: number, resetAgoMs: number) => {
  const failedAt = DateTime.makeUnsafe(nowMs - failedAgoMs);
  const candidate: ProjectionStore.ProjectionLimitRecoveryCandidate = {
    id: ThreadId.make("thread:limited"),
    status: "failed",
    lastErrorClass: "usage_limit",
    usageLimitResetAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs - resetAgoMs)),
    latestRunId: RunId.make("run:limited"),
    latestRunCompletedAt: failedAt,
    updatedAt: failedAt,
    archivedAt: null,
    settledOverride: null,
    pendingRuntimeRequest: null,
    limitRecovery: null,
    snoozedUntil: null,
  };
  return candidate;
};

describe("limitRecoveryCommand arming", () => {
  it("does not freshly arm a failure whose reset passed days ago", () => {
    const thread = failedThread(5 * 24 * HOUR_MS, 4 * 24 * HOUR_MS);
    assert.isNull(limitRecoveryCommand(thread, true, nowMs));
    assert.isNull(limitRecoveryCommand(thread, true, nowMs, true));
  });

  it("still arms a failure whose reset only just passed", () => {
    const thread = failedThread(6 * HOUR_MS, HOUR_MS);
    const arm = limitRecoveryCommand(thread, true, nowMs);
    assert.equal(arm?.type, "thread.metadata.update");
  });

  it("arms a reset that is exactly 24 hours overdue", () => {
    const thread = failedThread(30 * HOUR_MS, 24 * HOUR_MS);
    const arm = limitRecoveryCommand(thread, true, nowMs);
    assert.equal(arm?.type, "thread.metadata.update");
  });

  it("does not arm a reset that is 24 hours and 1ms overdue", () => {
    const thread = failedThread(30 * HOUR_MS, 24 * HOUR_MS + 1);
    assert.isNull(limitRecoveryCommand(thread, true, nowMs));
  });
});
