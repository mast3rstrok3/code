import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  type ModelSelection,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { layerTest as serverSettingsLayerTest } from "../serverSettings.ts";
import { OrchestratorV2 } from "./Orchestrator.ts";
import { ThreadManagementService } from "./ThreadManagementService.ts";
import {
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
      Layer.mock(OrchestratorV2)({
        getThreadShell: (id) =>
          Effect.succeed(id === rootId ? root : id === reviewId ? shell({}) : null),
      }),
      Layer.mock(ThreadManagementService)({
        dispatch: (command) =>
          Effect.sync(() => {
            commands.push(command);
            return { sequence: commands.length, storedEvents: [] } as never;
          }),
      }),
      serverSettingsLayerTest(),
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
