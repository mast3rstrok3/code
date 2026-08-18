import {
  CommandId,
  DEFAULT_WORKSPACE_USER_ID,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WorkflowId,
  type ModelSelection,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const ROOT_MODEL: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
};
const PINNED_MODEL: ModelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-opus-5",
};

function makeThread(input: {
  readonly id: string;
  readonly rootThreadId?: string;
}): OrchestrationThread {
  return {
    id: ThreadId.make(input.id),
    projectId: ProjectId.make("project-1"),
    ownerUserId: DEFAULT_WORKSPACE_USER_ID,
    parentThreadId: null,
    workflowRole: null,
    ...(input.rootThreadId === undefined
      ? {}
      : {
          workflowContext: {
            workflowId: WorkflowId.make("workflow-1"),
            rootThreadId: ThreadId.make(input.rootThreadId),
            ticketScope: [],
          },
        }),
    title: input.id,
    modelSelection: ROOT_MODEL,
    runtimeMode: "full-access",
    interactionMode: "planning-workflow",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    pinOrderKey: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    planningWorkflow: null,
    appReviews: [],
    activities: [],
    checkpoints: [],
    session: null,
  };
}

function makeReadModel(threads: ReadonlyArray<OrchestrationThread>): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    implementationRuns: [],
    threads: [...threads],
    updatedAt: NOW,
  };
}

it.layer(NodeServices.layer)("workflow step model decider", (it) => {
  it.effect("records a pin on the addressed workflow root", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "thread.workflow.step-model.set",
          commandId: CommandId.make("cmd-pin-step"),
          threadId: ThreadId.make("root-1"),
          workflowPromptId: "implementation.code-review.codex",
          modelSelection: PINNED_MODEL,
          createdAt: NOW,
        },
        readModel: makeReadModel([makeThread({ id: "root-1" })]),
      });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe("thread.workflow-step-model-set");
      expect(events[0]?.payload).toMatchObject({
        threadId: "root-1",
        workflowPromptId: "implementation.code-review.codex",
        modelSelection: PINNED_MODEL,
      });
    }),
  );

  it.effect("redirects a pin sent from a child thread to the workflow root", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "thread.workflow.step-model.set",
          commandId: CommandId.make("cmd-pin-child"),
          threadId: ThreadId.make("child-1"),
          workflowPromptId: "implementation.tdd.codex",
          modelSelection: PINNED_MODEL,
          createdAt: NOW,
        },
        readModel: makeReadModel([
          makeThread({ id: "root-1" }),
          makeThread({ id: "child-1", rootThreadId: "root-1" }),
        ]),
      });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events).toHaveLength(1);
      expect(events[0]?.aggregateId).toBe("root-1");
      expect(events[0]?.payload).toMatchObject({ threadId: "root-1" });
    }),
  );

  it.effect("clears a pin when no model is given", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "thread.workflow.step-model.set",
          commandId: CommandId.make("cmd-clear-step"),
          threadId: ThreadId.make("root-1"),
          workflowPromptId: "implementation.code-review.codex",
          modelSelection: null,
          createdAt: NOW,
        },
        readModel: makeReadModel([makeThread({ id: "root-1" })]),
      });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events[0]?.payload).toMatchObject({ modelSelection: null });
    }),
  );
});
