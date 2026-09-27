import {
  CommandId,
  DEFAULT_WORKSPACE_USER_ID,
  ProjectId,
  OrchestrationImplementationTicketState,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { decideOrchestrationCommand } from "./decider.ts";
import { queueImplementationRerun } from "./implementationRerun.ts";

const decodeTicket = Schema.decodeUnknownEffect(OrchestrationImplementationTicketState);

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

for (const stage of ["implementation", "app-review", "code-review"] as const) {
  it.layer(NodeServices.layer)(`Concurrent ${stage} rerun`, (it) => {
    it.effect("rejects an older snapshot after accepting a ticket rerun", () =>
      Effect.gen(function* () {
        const ticket = yield* decodeTicket({
          ticketId: "ticket-a",
          status: "failed",
          updatedAt: now,
        });
        const oldRun = {
          ...readModel.implementationRuns[0]!,
          ticketStates: [ticket],
          updatedAt: now,
        };
        const queued = queueImplementationRerun({
          run: oldRun,
          target: { kind: "ticket", ticketId: ticket.ticketId, stage },
          executionId: "manual-ticket-rerun",
          createdAt: "2026-01-01T00:00:02.000Z",
        });
        const error = yield* decideOrchestrationCommand({
          command: {
            type: "thread.implementation-run.update",
            commandId: CommandId.make("stale-update"),
            threadId: sourceThreadId,
            run: oldRun,
            createdAt: "2026-01-01T00:00:01.000Z",
          },
          readModel: { ...readModel, implementationRuns: [queued.run] },
        }).pipe(Effect.flip);
        expect(error._tag).toBe("OrchestrationCommandInvariantError");
        expect(String(error)).toContain("overwrite newer ticket state");

        const result = yield* decideOrchestrationCommand({
          command: {
            type: "thread.implementation-run.update",
            commandId: CommandId.make("fresh-update"),
            threadId: sourceThreadId,
            run: { ...queued.run, updatedAt: "2026-01-01T00:00:03.000Z" },
            createdAt: "2026-01-01T00:00:03.000Z",
          },
          readModel: { ...readModel, implementationRuns: [queued.run] },
        });
        const event = Array.isArray(result) ? result[0] : result;
        expect(event).toMatchObject({
          type: "thread.implementation-run-updated",
          payload: { run: { ticketStates: [{ stageExecutions: [queued.execution] }] } },
        });
      }),
    );
  });
}
