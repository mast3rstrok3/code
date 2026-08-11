import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  DEFAULT_WORKSPACE_USER_ID,
  DevReviewWorkflowCycleBudget,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { projectEvent } from "./projector.ts";

const now = "2026-01-01T00:00:00.000Z";
const projectId = ProjectId.make("project-dev-review");
const sourceThreadId = ThreadId.make("thread-source");

function thread(
  id: ThreadId,
  worktreePath: string | null,
  overrides: Partial<OrchestrationThread> = {},
): OrchestrationThread {
  return {
    id,
    projectId,
    ownerUserId: DEFAULT_WORKSPACE_USER_ID,
    parentThreadId: null,
    workflowRole: null,
    title: "Source",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "dev",
    worktreePath,
    latestTurn: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    planningWorkflow: null,
    devReviews: [],
    activities: [],
    checkpoints: [],
    session: null,
    ...overrides,
  };
}

function readModel(): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [
      {
        id: projectId,
        title: "Dev Review",
        workspaceRoot: "/tmp/dev-review",
        repositoryIdentity: null,
        defaultModelSelection: null,
        defaultThreadEnvMode: null,
        scripts: [],
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      },
    ],
    threads: [thread(sourceThreadId, "/tmp/dev-review-worktree")],
    implementationRuns: [],
    devReviewWorkflowRuns: [],
    updatedAt: now,
  };
}

function launchCommand(controllerThreadId: ThreadId, targetThreadId = sourceThreadId) {
  return {
    type: "thread.dev-review-workflow.launch" as const,
    commandId: CommandId.make(`cmd-${controllerThreadId}`),
    targetThreadId,
    controllerThreadId,
    caller: { type: "standalone" as const, sourceThreadId: targetThreadId },
    briefMarkdown: "Review checkout.",
    supportingContextMarkdown: null,
    previewTargets: ["http://localhost:3000"],
    cycleBudget: DevReviewWorkflowCycleBudget.make(10),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6" },
    createdAt: now,
  };
}

it.layer(NodeServices.layer)("Dev Review workflow decider", (it) => {
  it.effect("creates one persistent controller and a distinct workflow run", () =>
    Effect.gen(function* () {
      const controllerThreadId = ThreadId.make("thread-controller");
      const decided = yield* decideOrchestrationCommand({
        command: launchCommand(controllerThreadId),
        readModel: readModel(),
      });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events.map((event) => event.type)).toEqual([
        "thread.created",
        "thread.dev-review-workflow-launched",
      ]);
      const launched = events[1];
      if (launched?.type !== "thread.dev-review-workflow-launched") return;
      expect(launched.payload.run.controllerThreadId).toBe(controllerThreadId);
      expect(launched.payload.run.activePhase).toBeNull();
      expect(launched.payload.run.attemptsUsed).toBe(0);
      expect(launched.payload.run.id).toBe(`dev-review-workflow-${controllerThreadId}`);
    }),
  );

  it.effect("rejects a second active run targeting the same canonical worktree", () =>
    Effect.gen(function* () {
      const initial = readModel();
      const first = yield* decideOrchestrationCommand({
        command: launchCommand(ThreadId.make("thread-controller-1")),
        readModel: initial,
      });
      const events = Array.isArray(first) ? first : [first];
      let projected = initial;
      for (const [index, event] of events.entries()) {
        projected = yield* projectEvent(projected, { ...event, sequence: index + 1 });
      }
      const equivalentTarget = ThreadId.make("thread-equivalent-target");
      projected = {
        ...projected,
        threads: [...projected.threads, thread(equivalentTarget, "/tmp/dev-review-worktree/")],
      };
      const duplicate = yield* Effect.exit(
        decideOrchestrationCommand({
          command: launchCommand(ThreadId.make("thread-controller-2"), equivalentTarget),
          readModel: projected,
        }),
      );
      expect(duplicate._tag).toBe("Failure");
    }),
  );

  it.effect("rejects standalone launch while source work is waiting for user input", () =>
    Effect.gen(function* () {
      const model: OrchestrationReadModel = {
        ...readModel(),
        threads: [
          thread(sourceThreadId, "/tmp/dev-review-worktree", {
            activities: [
              {
                id: EventId.make("activity-user-input"),
                tone: "info",
                kind: "user-input.requested",
                summary: "Choose a target",
                payload: { requestId: "request-1" },
                turnId: null,
                createdAt: now,
              },
            ],
          }),
        ],
      };
      const result = yield* Effect.exit(
        decideOrchestrationCommand({
          command: launchCommand(ThreadId.make("thread-controller")),
          readModel: model,
        }),
      );
      expect(result._tag).toBe("Failure");
    }),
  );
});
