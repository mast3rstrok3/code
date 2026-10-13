import {
  CommandId,
  DEFAULT_WORKSPACE_USER_ID,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
  type WorkflowPreset,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const threadId = ThreadId.make("thread-1");

const readModel: OrchestrationReadModel = {
  snapshotSequence: 0,
  projects: [],
  threads: [
    {
      id: threadId,
      projectId: ProjectId.make("project-1"),
      ownerUserId: DEFAULT_WORKSPACE_USER_ID,
      parentThreadId: null,
      workflowRole: null,
      workflowContext: null,
      planningWorkflow: null,
      appReviews: [],
      title: "Thread",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "t3/feature",
      worktreePath: "/repo.worktrees/feature",
      pullRequests: [],
      latestTurn: null,
      createdAt: NOW,
      updatedAt: NOW,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      deletedAt: null,
      messages: [],
      proposedPlans: [],
      activities: [],
      checkpoints: [],
      session: null,
    },
  ],
  implementationRuns: [],
  updatedAt: NOW,
};

const setPreset = (workflowPreset: WorkflowPreset | null) =>
  decideOrchestrationCommand({
    command: {
      type: "thread.composer-mode.set",
      commandId: CommandId.make(`cmd-${workflowPreset}`),
      threadId,
      interactionMode: "plan",
      workflowPreset,
      createdAt: NOW,
    },
    readModel,
  }).pipe(Effect.map((events) => (Array.isArray(events) ? events[0] : events)));

it.layer(NodeServices.layer)("thread.composer-mode.set decider", (it) => {
  it.effect("gives a new Feature root the workflow id its App Stacks are tagged with", () =>
    Effect.gen(function* () {
      const event = yield* setPreset("fast-plan");
      expect(event?.type).toBe("thread.composer-mode-set");
      if (event?.type !== "thread.composer-mode-set") return;
      expect(event.payload.workflowContext).toEqual({
        workflowId: "workflow-thread-1",
        parentWorkflowId: null,
        rootThreadId: threadId,
        ticketScope: [],
      });
    }),
  );

  it.effect("leaves other workflows to stamp their own identity", () =>
    Effect.gen(function* () {
      for (const preset of ["planning", null] as const) {
        const event = yield* setPreset(preset);
        expect(event?.type === "thread.composer-mode-set" && event.payload.workflowContext).toBe(
          undefined,
        );
      }
    }),
  );
});
