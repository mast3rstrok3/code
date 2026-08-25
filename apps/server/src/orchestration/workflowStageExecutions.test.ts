import type {
  DurableValidationJob,
  OrchestrationImplementationRun,
  OrchestrationImplementationTicketState,
  WorkflowStageExecution,
  WorkflowStageTarget,
} from "@t3tools/contracts";
import fc from "fast-check";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { createEmptyReadModel } from "./projector.ts";
import { queueImplementationRerun } from "./implementationRerun.ts";
import {
  reconcileWorkflowState,
  normalizeImplementationRunExecutions,
  recoverWorkflowRunsAfterStartup,
  WORKFLOW_CRASH_RECOVERY_MS,
} from "./workflowStageExecutions.ts";

const now = "2026-01-01T00:00:00.000Z";
const addMilliseconds = (value: string, milliseconds: number) =>
  DateTime.formatIso(
    DateTime.add(DateTime.makeUnsafe(Date.parse(value)), {
      milliseconds,
    }),
  );

function target(ticketId: string, stage: "implementation" | "app-review" = "implementation") {
  return { kind: "ticket", runId: "run-1", ticketId, stage } as const;
}

function execution(input: {
  readonly ticketId: string;
  readonly generation?: number;
  readonly state?: WorkflowStageExecution["state"];
  readonly updatedAt?: string;
  readonly failure?: WorkflowStageExecution["failure"];
  readonly recovery?: WorkflowStageExecution["recovery"];
}): WorkflowStageExecution {
  const updatedAt = input.updatedAt ?? now;
  return {
    target: target(input.ticketId),
    generation: input.generation ?? 0,
    executionId: `${input.ticketId}:${String(input.generation ?? 0)}`,
    state: input.state ?? "running",
    queuedAt: updatedAt,
    claimedAt: updatedAt,
    leaseRenewedAt: updatedAt,
    leaseExpiresAt: "2026-01-01T00:05:00.000Z",
    lastProgressAt: updatedAt,
    durableJobId: null,
    failure: input.failure ?? null,
    recovery: input.recovery ?? null,
    updatedAt,
  };
}

function ticket(input: {
  readonly ticketId: string;
  readonly status?: OrchestrationImplementationTicketState["status"];
  readonly dependencies?: readonly string[];
  readonly executions?: readonly WorkflowStageExecution[];
}): OrchestrationImplementationTicketState {
  return {
    ticketId: input.ticketId,
    status: input.status ?? "running",
    dependencyTicketIds: [...(input.dependencies ?? [])],
    implementationGeneration: 0,
    appReviewGeneration: 0,
    codeReviewGeneration: 0,
    stageExecutions: [...(input.executions ?? [])],
    updatedAt: now,
  } as unknown as OrchestrationImplementationTicketState;
}

function run(input: {
  readonly tickets: readonly OrchestrationImplementationTicketState[];
  readonly executions?: readonly WorkflowStageExecution[];
  readonly jobs?: readonly DurableValidationJob[];
  readonly status?: OrchestrationImplementationRun["status"];
}): OrchestrationImplementationRun {
  return {
    id: "run-1",
    status: input.status ?? "running",
    orchestratorThreadId: "orchestrator-1",
    finalCodeReviewGeneration: 0,
    ticketStates: input.tickets,
    stageExecutions: input.executions ?? [],
    validationJobs: input.jobs ?? [],
    retryableFailure: null,
    automationHalt: null,
    updatedAt: now,
  } as unknown as OrchestrationImplementationRun;
}

function model(implementationRun: OrchestrationImplementationRun) {
  return { ...createEmptyReadModel(now), implementationRuns: [implementationRun] };
}

describe("workflow stage reconciliation", () => {
  it("normalizes historical halt and retry summaries into canonical executions", () => {
    const historicalHalt = {
      ...run({ tickets: [ticket({ ticketId: "ticket-a", status: "failed" })] }),
      automationHalt: {
        ticketId: "ticket-a",
        stage: "implementation",
        category: "structural-invariant",
        detail: "The ticket worktree moved.",
        haltedAt: now,
      },
    } as OrchestrationImplementationRun;
    const halted = normalizeImplementationRunExecutions(historicalHalt);
    expect(halted.ticketStates[0]?.stageExecutions[0]?.state).toBe("halted");
    expect(halted.ticketStates[0]?.stageExecutions[0]?.failure?.category).toBe(
      "structural-invariant",
    );

    const historicalRetry = {
      ...run({ tickets: [], status: "validating" }),
      retryableFailure: {
        stage: "integration",
        detail: "Provider transport stopped.",
        failedAt: now,
        attemptCount: 1,
        maxAttempts: 2,
        humanBlocked: false,
      },
    } as unknown as OrchestrationImplementationRun;
    const retrying = normalizeImplementationRunExecutions(historicalRetry);
    expect(retrying.stageExecutions[0]?.state).toBe("reconciling");
    expect(retrying.stageExecutions[0]?.failure?.category).toBe("provider-transport");
  });

  it("keeps concurrent ticket failures independent", () => {
    const failed = (ticketId: string) =>
      execution({
        ticketId,
        state: "halted",
        failure: {
          category: "provider-terminal",
          detail: `${ticketId} failed`,
          failedAt: now,
          nextAction: "fix-authentication",
        },
      });
    const actions = reconcileWorkflowState(
      model(
        run({
          tickets: [
            ticket({ ticketId: "ticket-a", status: "failed", executions: [failed("ticket-a")] }),
            ticket({ ticketId: "ticket-b", status: "failed", executions: [failed("ticket-b")] }),
          ],
        }),
      ),
      now,
    );

    const watchdog = actions.find((action) => action.type === "report-watchdog");
    expect(watchdog?.fingerprint).toContain("ticket-a");
    expect(watchdog?.fingerprint).toContain("ticket-b");
    expect(actions.filter((action) => action.type === "report-watchdog")).toHaveLength(1);
  });

  it("revokes every late generation after back-to-back reruns", () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 20 }), (rerunCount) => {
        let current = run({ tickets: [ticket({ ticketId: "ticket-a", status: "failed" })] });
        for (let index = 0; index < rerunCount; index += 1) {
          current = queueImplementationRerun({
            run: current,
            target: { kind: "ticket", ticketId: "ticket-a", stage: "implementation" },
            executionId: `rerun-${String(index)}`,
            createdAt: addMilliseconds(now, index),
          }).run;
        }

        const actions = reconcileWorkflowState(model(current), now);
        expect(actions.filter((action) => action.type === "revoke-stale-execution")).toHaveLength(
          rerunCount - 1,
        );
        expect(actions.filter((action) => action.type === "claim-queued-stage")).toHaveLength(1);
      }),
    );
  });

  it("derives a dependency block and removes it after upstream success", () => {
    const upstreamFailure = execution({
      ticketId: "upstream",
      state: "halted",
      failure: {
        category: "provider-terminal",
        detail: "Provider configuration failed.",
        failedAt: now,
        nextAction: "fix-configuration",
      },
    });
    const downstream = ticket({
      ticketId: "downstream",
      status: "ready",
      dependencies: ["upstream"],
    });
    const blockedActions = reconcileWorkflowState(
      model(
        run({
          tickets: [
            ticket({ ticketId: "upstream", status: "failed", executions: [upstreamFailure] }),
            downstream,
          ],
        }),
      ),
      now,
    );
    expect(blockedActions.some((action) => action.type === "derive-dependency-block")).toBe(true);

    const success = { ...upstreamFailure, state: "succeeded", failure: null } as const;
    const eligibleActions = reconcileWorkflowState(
      model(
        run({
          tickets: [
            ticket({ ticketId: "upstream", status: "succeeded", executions: [success] }),
            { ...downstream, status: "blocked" },
          ],
        }),
      ),
      now,
    );
    expect(eligibleActions.some((action) => action.type === "derive-dependency-eligibility")).toBe(
      true,
    );
  });

  it("resets planned restart recovery without spending product counters", () => {
    const active = execution({
      ticketId: "ticket-a",
      state: "retry-wait",
      recovery: {
        cause: "provider-rate-limit",
        startedAt: now,
        deadlineAt: null,
        attempts: 7,
        selectedModel: null,
        fallbackHistory: [],
        retryAt: "2026-01-01T05:00:00.000Z",
      },
    });
    const original = {
      ...run({ tickets: [ticket({ ticketId: "ticket-a", executions: [active] })] }),
      mergeGateAttemptCount: 3,
      codeReviewAttemptCount: 4,
    };
    const recovered = recoverWorkflowRunsAfterStartup({
      readModel: model(original),
      cause: "planned-restart",
      now: "2026-01-01T01:00:00.000Z",
    }).implementationRuns[0]!;

    expect(recovered.ticketStates[0]?.stageExecutions[0]?.recovery?.attempts).toBe(0);
    expect(recovered.ticketStates[0]?.stageExecutions[0]?.recovery?.retryAt).toBeNull();
    expect(recovered.mergeGateAttemptCount).toBe(3);
    expect(recovered.codeReviewAttemptCount).toBe(4);
  });

  it("allows repeated crash resumes for eight hours and then halts only that execution", () => {
    const initial = run({
      tickets: [
        ticket({ ticketId: "affected", executions: [execution({ ticketId: "affected" })] }),
        ticket({ ticketId: "sibling", executions: [execution({ ticketId: "sibling" })] }),
      ],
    });
    const first = recoverWorkflowRunsAfterStartup({
      readModel: model(initial),
      cause: "server-crash",
      now,
    }).implementationRuns[0]!;
    const beforeDeadline = recoverWorkflowRunsAfterStartup({
      readModel: model(first),
      cause: "server-crash",
      now: addMilliseconds(now, WORKFLOW_CRASH_RECOVERY_MS - 1),
    }).implementationRuns[0]!;
    expect(
      beforeDeadline.ticketStates.every(
        (state) => state.stageExecutions[0]?.state === "reconciling",
      ),
    ).toBe(true);
    expect(beforeDeadline.ticketStates[0]?.stageExecutions[0]?.recovery?.attempts).toBe(2);

    const affectedOnly = {
      ...beforeDeadline,
      ticketStates: [
        beforeDeadline.ticketStates[0]!,
        {
          ...beforeDeadline.ticketStates[1]!,
          stageExecutions: [
            {
              ...beforeDeadline.ticketStates[1]!.stageExecutions[0]!,
              state: "succeeded" as const,
            },
          ],
        },
      ],
    };
    const expired = recoverWorkflowRunsAfterStartup({
      readModel: model(affectedOnly),
      cause: "server-crash",
      now: addMilliseconds(now, WORKFLOW_CRASH_RECOVERY_MS),
    }).implementationRuns[0]!;
    expect(expired.ticketStates[0]?.stageExecutions[0]?.state).toBe("halted");
    expect(expired.ticketStates[1]?.stageExecutions[0]?.state).toBe("succeeded");
  });

  it("serializes durable validation jobs and ignores a late stale result", () => {
    const currentExecution = execution({ ticketId: "ticket-a", generation: 2 });
    const job = (
      id: string,
      generation: number,
      status: DurableValidationJob["status"],
      queuedAt: string,
    ): DurableValidationJob => ({
      id,
      target: target("ticket-a", "implementation") as WorkflowStageTarget,
      generation,
      command: "vp test run e2e.test.ts",
      workingDirectory: "/tmp/worktree",
      status,
      heartbeatAt: status === "running" ? queuedAt : null,
      queuedAt,
      startedAt: status === "queued" ? null : queuedAt,
      completedAt: status === "succeeded" ? queuedAt : null,
      outputSummary: "",
      resultReceipt: status === "succeeded" ? "passed" : null,
    });
    const actions = reconcileWorkflowState(
      model(
        run({
          tickets: [ticket({ ticketId: "ticket-a", executions: [currentExecution] })],
          jobs: [
            job("stale", 1, "succeeded", "2025-12-31T23:00:00.000Z"),
            job("first", 2, "queued", now),
            job("second", 2, "queued", "2026-01-01T00:00:01.000Z"),
          ],
        }),
      ),
      now,
    );
    expect(actions.filter((action) => action.type === "cancel-stale-validation-job")).toHaveLength(
      1,
    );
    expect(actions.filter((action) => action.type === "apply-durable-job-result")).toHaveLength(0);
    expect(actions.filter((action) => action.type === "start-durable-validation-job")).toHaveLength(
      1,
    );
    expect(actions.find((action) => action.type === "start-durable-validation-job")?.job.id).toBe(
      "first",
    );
  });
});
