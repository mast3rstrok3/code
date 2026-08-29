import {
  CommandId,
  DEFAULT_WORKSPACE_USER_ID,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const now = "2026-01-01T00:00:00.000Z";
const sourceThreadId = ThreadId.make("thread-source");

const readModel = {
  snapshotSequence: 0,
  projects: [],
  appReviewWorkflowRuns: [],
  threads: [
    {
      id: sourceThreadId,
      projectId: ProjectId.make("project-1"),
      ownerUserId: DEFAULT_WORKSPACE_USER_ID,
      parentThreadId: null,
      workflowRole: null,
      title: "Source",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "dev",
      worktreePath: "/tmp/project",
      latestTurn: null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    },
  ],
  implementationRuns: [
    {
      id: "implementation-run-1",
      orchestratorThreadId: "thread-orchestrator",
      status: "needs-human-attention",
      retryableFailure: {
        stage: "merge-gate",
        detail: "Validation needs another run.",
        failedAt: now,
        attemptCount: 1,
        maxAttempts: 2,
        humanBlocked: false,
      },
      stageExecutions: [
        {
          target: {
            kind: "run",
            runId: "implementation-run-1",
            stage: "merge-gate",
          },
          generation: 1,
          executionId: "workflow-execution-manual-rerun",
          state: "queued",
          queuedAt: now,
          claimedAt: null,
          leaseRenewedAt: null,
          leaseExpiresAt: null,
          lastProgressAt: now,
          durableJobId: null,
          failure: null,
          recovery: null,
          updatedAt: now,
        },
      ],
      ticketStates: [],
    },
  ],
} as unknown as OrchestrationReadModel;

it.layer(NodeServices.layer)("Implementation retry decider", (it) => {
  it.effect("rejects an automatic retry after a manual rerun queued the stage", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: {
          type: "thread.implementation-run.retry",
          commandId: CommandId.make("implementation-auto-retry"),
          threadId: sourceThreadId,
          runId: "implementation-run-1",
          createdAt: "2026-01-01T00:00:01.000Z",
        },
        readModel,
      }).pipe(Effect.flip);

      expect(error._tag).toBe("OrchestrationCommandInvariantError");
      expect(String(error)).toContain("already has a stage queued or starting");
    }),
  );
});
