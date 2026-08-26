import type {
  AppReviewWorkflowRun,
  DurableValidationJob,
  OrchestrationImplementationAutomationHalt,
  OrchestrationImplementationRun,
  OrchestrationImplementationTicketState,
  OrchestrationReadModel,
  WorkflowCanonicalNextAction,
  WorkflowFailureCategory,
  WorkflowStageExecution,
  WorkflowStageTarget,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

const ACTIVE_STATES = new Set<WorkflowStageExecution["state"]>([
  "starting",
  "running",
  "reconciling",
]);
const TERMINAL_STATES = new Set<WorkflowStageExecution["state"]>([
  "halted",
  "succeeded",
  "skipped",
]);

export const WORKFLOW_PROVIDER_LEASE_MS = 5 * 60 * 1_000;
export const WORKFLOW_CRASH_RECOVERY_MS = 8 * 60 * 60 * 1_000;
export const WORKFLOW_RATE_LIMIT_PARK_MS = 5 * 60 * 60 * 1_000;
export const DURABLE_VALIDATION_JOB_LEASE_MS = 2 * 60 * 1_000;

export function workflowStageTargetKey(target: WorkflowStageTarget): string {
  switch (target.kind) {
    case "run":
      return `run:${target.runId}:${target.stage}`;
    case "ticket":
      return `ticket:${target.runId}:${target.ticketId}:${target.stage}`;
    case "app-review-phase":
      return `app-review:${target.runId}:${String(target.cycleNumber)}:${target.phase}`;
  }
}

function historicalExecutionId(target: WorkflowStageTarget, generation: number): string {
  return `historical:${workflowStageTargetKey(target)}:${String(generation)}`;
}

function categoryForHalt(halt: OrchestrationImplementationAutomationHalt): WorkflowFailureCategory {
  switch (halt.category) {
    case "structural-invariant":
      return "structural-invariant";
    case "review-blocked":
      return "review-findings";
    case "validation-failed":
      return "validation-failed";
    case "retry-exhausted":
    case "stage-failed":
      return "provider-terminal";
  }
}

function nextActionForFailure(category: WorkflowFailureCategory): WorkflowCanonicalNextAction {
  switch (category) {
    case "provider-rate-limit":
      return "wait-for-retry";
    case "dependency-failed":
      return "wait-for-dependencies";
    case "review-findings":
      return "review-findings";
    case "validation-failed":
      return "repair-validation";
    case "planned-restart":
    case "server-crash":
    case "provider-transport":
      return "continue-stage";
    case "provider-terminal":
      return "fix-authentication";
    case "structural-invariant":
    case "missing-directive":
      return "rerun-stage";
  }
}

function historicalExecution(input: {
  readonly target: WorkflowStageTarget;
  readonly generation: number;
  readonly state: WorkflowStageExecution["state"];
  readonly threadClaimed: boolean;
  readonly timestamp: string;
  readonly category?: WorkflowFailureCategory;
  readonly detail?: string;
}): WorkflowStageExecution {
  const category = input.category;
  return {
    target: input.target,
    generation: input.generation,
    executionId: historicalExecutionId(input.target, input.generation),
    state: input.state,
    queuedAt: input.timestamp,
    claimedAt: input.threadClaimed ? input.timestamp : null,
    leaseRenewedAt: input.threadClaimed ? input.timestamp : null,
    leaseExpiresAt: input.threadClaimed
      ? DateTime.formatIso(
          DateTime.add(DateTime.makeUnsafe(Date.parse(input.timestamp)), {
            milliseconds: WORKFLOW_PROVIDER_LEASE_MS,
          }),
        )
      : null,
    lastProgressAt: input.timestamp,
    durableJobId: null,
    failure:
      category === undefined
        ? null
        : {
            category,
            detail: input.detail ?? "Historical workflow failure.",
            failedAt: input.timestamp,
            nextAction: nextActionForFailure(category),
          },
    recovery: null,
    updatedAt: input.timestamp,
  };
}

function ticketCurrentTarget(
  run: OrchestrationImplementationRun,
  ticket: OrchestrationImplementationTicketState,
): { readonly target: WorkflowStageTarget; readonly generation: number } | null {
  const base = { runId: run.id, ticketId: ticket.ticketId } as const;
  switch (ticket.status) {
    case "ready":
    case "running":
      return {
        target: { kind: "ticket", ...base, stage: "implementation" },
        generation: ticket.implementationGeneration,
      };
    case "app-reviewing":
      return {
        target: { kind: "ticket", ...base, stage: "app-review" },
        generation: ticket.appReviewGeneration,
      };
    case "code-reviewing":
      return {
        target: { kind: "ticket", ...base, stage: "code-review" },
        generation: ticket.codeReviewGeneration,
      };
    case "succeeded": {
      const stage = ticket.codeReviewThreadId !== null ? "code-review" : "implementation";
      return {
        target: { kind: "ticket", ...base, stage },
        generation:
          stage === "code-review" ? ticket.codeReviewGeneration : ticket.implementationGeneration,
      };
    }
    case "failed": {
      const halt = run.automationHalt;
      const stage =
        halt?.ticketId === ticket.ticketId && halt.stage !== "final-code-review"
          ? halt.stage
          : "implementation";
      if (stage === "integration") return null;
      return {
        target: { kind: "ticket", ...base, stage },
        generation:
          stage === "app-review"
            ? ticket.appReviewGeneration
            : stage === "code-review"
              ? ticket.codeReviewGeneration
              : ticket.implementationGeneration,
      };
    }
    case "blocked":
      return null;
  }
}

function runCurrentTarget(
  run: OrchestrationImplementationRun,
): Extract<WorkflowStageTarget, { readonly kind: "run" }> | null {
  const base = { kind: "run", runId: run.id } as const;
  switch (run.status) {
    case "integrating":
      return { ...base, stage: "integration" };
    case "validating":
      return { ...base, stage: "validation" };
    case "qa-reviewing":
    case "fixing":
      return { ...base, stage: "app-review" };
    case "code-reviewing":
    case "code-review-fixing":
      return { ...base, stage: "code-review" };
    case "publishing-change-request":
      return { ...base, stage: "publication" };
    case "babysitting-change-request":
      return { ...base, stage: "babysitting" };
    case "needs-human-attention": {
      const halt = run.automationHalt;
      if (halt === null || halt.ticketId !== undefined) return null;
      if (halt.stage === "final-code-review") return { ...base, stage: "code-review" };
      if (halt.stage === "implementation") return null;
      return { ...base, stage: halt.stage };
    }
    case "launch-pending":
    case "running":
    case "completed":
    case "canceled":
      return null;
  }
}

export function normalizeImplementationRunExecutions(
  run: OrchestrationImplementationRun,
): OrchestrationImplementationRun {
  const ticketStates = run.ticketStates.map((ticket) => {
    const current = ticketCurrentTarget(run, ticket);
    if (current === null) {
      if (ticket.status !== "succeeded") return ticket;
      const stageExecutions = ticket.stageExecutions.map((execution) =>
        ACTIVE_STATES.has(execution.state)
          ? {
              ...execution,
              state: "succeeded" as const,
              lastProgressAt: ticket.updatedAt,
              updatedAt: ticket.updatedAt,
            }
          : execution,
      );
      return stageExecutions.some((execution, index) => execution !== ticket.stageExecutions[index])
        ? { ...ticket, stageExecutions }
        : ticket;
    }
    const currentKey = workflowStageTargetKey(current.target);
    const halt = run.automationHalt?.ticketId === ticket.ticketId ? run.automationHalt : null;
    const retry = run.retryableFailure?.ticketId === ticket.ticketId ? run.retryableFailure : null;
    const state: WorkflowStageExecution["state"] =
      ticket.status === "succeeded"
        ? "succeeded"
        : halt !== null || ticket.status === "failed"
          ? "halted"
          : retry !== null
            ? "reconciling"
            : ticket.status === "ready"
              ? "queued"
              : "running";
    const category =
      halt !== null
        ? categoryForHalt(halt)
        : retry !== null
          ? retry.humanBlocked
            ? "structural-invariant"
            : "provider-transport"
          : ticket.status === "failed"
            ? "provider-terminal"
            : undefined;
    const detail = halt?.detail ?? retry?.detail ?? ticket.warningMarkdown ?? undefined;
    let foundCurrent = false;
    const stageExecutions = ticket.stageExecutions.map((execution) => {
      const matchesCurrent = workflowStageTargetKey(execution.target) === currentKey;
      if (matchesCurrent && execution.generation === current.generation) {
        foundCurrent = true;
        if (execution.state === "queued" || execution.state === "starting") return execution;
        if (state === "succeeded" && execution.state !== "succeeded") {
          return {
            ...execution,
            state,
            lastProgressAt: ticket.updatedAt,
            failure: null,
            recovery: null,
            updatedAt: ticket.updatedAt,
          };
        }
        if (state === "halted" && execution.state !== "halted") {
          return {
            ...execution,
            state,
            lastProgressAt: ticket.updatedAt,
            failure:
              category === undefined
                ? execution.failure
                : {
                    category,
                    detail: detail ?? "Workflow stage halted.",
                    failedAt: ticket.updatedAt,
                    nextAction: nextActionForFailure(category),
                  },
            updatedAt: ticket.updatedAt,
          };
        }
        return execution;
      }
      return ACTIVE_STATES.has(execution.state)
        ? {
            ...execution,
            state: "succeeded" as const,
            lastProgressAt: ticket.updatedAt,
            failure: null,
            recovery: null,
            updatedAt: ticket.updatedAt,
          }
        : execution;
    });
    if (foundCurrent) {
      return stageExecutions.some((execution, index) => execution !== ticket.stageExecutions[index])
        ? { ...ticket, stageExecutions }
        : ticket;
    }
    return {
      ...ticket,
      stageExecutions: [
        ...stageExecutions,
        historicalExecution({
          ...current,
          state,
          threadClaimed: state !== "queued",
          timestamp: ticket.updatedAt,
          ...(category === undefined ? {} : { category }),
          ...(detail === undefined ? {} : { detail }),
        }),
      ],
    };
  });

  const target = runCurrentTarget(run);
  if (target === null) {
    if (run.status !== "completed") return { ...run, ticketStates };
    const stageExecutions = run.stageExecutions.map((execution) =>
      ACTIVE_STATES.has(execution.state)
        ? {
            ...execution,
            state: "succeeded" as const,
            lastProgressAt: run.updatedAt,
            failure: null,
            recovery: null,
            updatedAt: run.updatedAt,
          }
        : execution,
    );
    return { ...run, ticketStates, stageExecutions };
  }
  const halt = run.automationHalt?.ticketId === undefined ? run.automationHalt : null;
  const retry = run.retryableFailure?.ticketId === undefined ? run.retryableFailure : null;
  const category =
    halt !== null
      ? categoryForHalt(halt)
      : retry !== null
        ? retry.humanBlocked
          ? "structural-invariant"
          : "provider-transport"
        : undefined;
  const detail = halt?.detail ?? retry?.detail ?? undefined;
  const targetKey = workflowStageTargetKey(target);
  const state: WorkflowStageExecution["state"] =
    halt !== null ? "halted" : retry !== null ? "reconciling" : "running";
  let foundTarget = false;
  const stageExecutions = run.stageExecutions.map((execution) => {
    if (workflowStageTargetKey(execution.target) === targetKey) {
      foundTarget = true;
      if (execution.state === "queued" || execution.state === "starting") return execution;
      if (halt === null && retry === null) return execution;
      if (execution.state === state) return execution;
      return {
        ...execution,
        state,
        lastProgressAt: run.updatedAt,
        failure:
          category === undefined
            ? state === "running"
              ? null
              : execution.failure
            : {
                category,
                detail: detail ?? "Workflow stage halted.",
                failedAt: run.updatedAt,
                nextAction: nextActionForFailure(category),
              },
        recovery: state === "running" ? null : execution.recovery,
        updatedAt: run.updatedAt,
      };
    }
    return ACTIVE_STATES.has(execution.state)
      ? {
          ...execution,
          state: "succeeded" as const,
          lastProgressAt: run.updatedAt,
          failure: null,
          recovery: null,
          updatedAt: run.updatedAt,
        }
      : execution;
  });
  if (foundTarget) return { ...run, ticketStates, stageExecutions };
  return {
    ...run,
    ticketStates,
    stageExecutions: [
      ...stageExecutions,
      historicalExecution({
        target,
        generation: target.stage === "code-review" ? run.finalCodeReviewGeneration : 0,
        state,
        threadClaimed: true,
        timestamp: run.updatedAt,
        ...(category === undefined ? {} : { category }),
        ...(detail === undefined ? {} : { detail }),
      }),
    ],
  };
}

function categoryForAppReviewFailure(
  failure: AppReviewWorkflowRun["failure"],
): WorkflowFailureCategory {
  if (
    failure?.reason === "plan-missing" ||
    failure?.reason === "plan-malformed" ||
    failure?.reason === "fix-result-missing"
  ) {
    return "missing-directive";
  }
  return failure?.reason === "review-blocked" ? "review-findings" : "provider-terminal";
}

export function normalizeAppReviewPhaseExecution(run: AppReviewWorkflowRun): AppReviewWorkflowRun {
  if (run.activePhase === null) {
    if (run.phaseExecution === null || run.status === "running") return run;
    const state: WorkflowStageExecution["state"] = run.status === "failed" ? "halted" : "succeeded";
    return run.phaseExecution.state === state
      ? run
      : {
          ...run,
          phaseExecution: {
            ...run.phaseExecution,
            state,
            lastProgressAt: run.updatedAt,
            failure:
              state === "halted"
                ? (run.phaseExecution.failure ?? {
                    category: categoryForAppReviewFailure(run.failure),
                    detail: run.failure?.detailMarkdown ?? "App Review phase halted.",
                    failedAt: run.updatedAt,
                    nextAction: "rerun-stage",
                  })
                : null,
            recovery: state === "succeeded" ? null : run.phaseExecution.recovery,
            updatedAt: run.updatedAt,
          },
        };
  }
  const cycle = run.cycles.at(-1);
  if (cycle === undefined) return run;
  const target: WorkflowStageTarget = {
    kind: "app-review-phase",
    runId: run.id,
    cycleNumber: cycle.cycleNumber,
    phase: run.activePhase,
  };
  const failure = run.failure ?? cycle.failure ?? null;
  if (
    run.phaseExecution !== null &&
    workflowStageTargetKey(run.phaseExecution.target) === workflowStageTargetKey(target)
  ) {
    if (!TERMINAL_STATES.has(run.phaseExecution.state)) return run;
    return {
      ...run,
      phaseExecution: {
        ...run.phaseExecution,
        state: "reconciling",
        claimedAt: run.updatedAt,
        leaseRenewedAt: run.updatedAt,
        leaseExpiresAt: DateTime.formatIso(
          DateTime.add(DateTime.makeUnsafe(Date.parse(run.updatedAt)), {
            milliseconds: WORKFLOW_PROVIDER_LEASE_MS,
          }),
        ),
        lastProgressAt: run.updatedAt,
        failure: null,
        recovery: null,
        updatedAt: run.updatedAt,
      },
    };
  }
  return {
    ...run,
    phaseExecution: historicalExecution({
      target,
      generation: 0,
      state: failure === null ? "running" : "halted",
      threadClaimed: run.activeThreadId !== null,
      timestamp: run.updatedAt,
      ...(failure === null
        ? {}
        : {
            category: categoryForAppReviewFailure(failure),
            detail: failure.detailMarkdown,
          }),
    }),
  };
}

export type WorkflowReconciliationAction =
  | {
      readonly type: "claim-queued-stage";
      readonly commandId: string;
      readonly execution: WorkflowStageExecution;
    }
  | {
      readonly type: "renew-lease";
      readonly commandId: string;
      readonly execution: WorkflowStageExecution;
    }
  | {
      readonly type: "expire-lease";
      readonly commandId: string;
      readonly execution: WorkflowStageExecution;
    }
  | {
      readonly type: "resume-interrupted-execution";
      readonly commandId: string;
      readonly execution: WorkflowStageExecution;
    }
  | {
      readonly type: "leave-retry-wait";
      readonly commandId: string;
      readonly execution: WorkflowStageExecution;
    }
  | {
      readonly type: "revoke-stale-execution";
      readonly commandId: string;
      readonly execution: WorkflowStageExecution;
    }
  | {
      readonly type: "derive-dependency-block";
      readonly commandId: string;
      readonly runId: string;
      readonly ticketId: string;
      readonly dependencyTicketIds: readonly string[];
    }
  | {
      readonly type: "derive-dependency-eligibility";
      readonly commandId: string;
      readonly runId: string;
      readonly ticketId: string;
    }
  | {
      readonly type: "settle-nested-review";
      readonly commandId: string;
      readonly appReviewRunId: string;
      readonly implementationRunId: string;
      readonly ticketId: string | null;
    }
  | {
      readonly type: "start-durable-validation-job";
      readonly commandId: string;
      readonly runId: string;
      readonly job: DurableValidationJob;
    }
  | {
      readonly type: "reattach-durable-validation-job";
      readonly commandId: string;
      readonly runId: string;
      readonly job: DurableValidationJob;
    }
  | {
      readonly type: "rerun-expired-validation-job";
      readonly commandId: string;
      readonly runId: string;
      readonly job: DurableValidationJob;
    }
  | {
      readonly type: "apply-durable-job-result";
      readonly commandId: string;
      readonly runId: string;
      readonly job: DurableValidationJob;
    }
  | {
      readonly type: "cancel-stale-validation-job";
      readonly commandId: string;
      readonly runId: string;
      readonly job: DurableValidationJob;
    }
  | {
      readonly type: "report-watchdog";
      readonly commandId: string;
      readonly runId: string;
      readonly nextAction: WorkflowCanonicalNextAction;
      readonly fingerprint: string;
    };

function reconciliationCommandId(
  action: WorkflowReconciliationAction["type"],
  identity: string,
  generation = 0,
): string {
  return `workflow-reconcile:${action}:${identity}:${String(generation)}`;
}

function latestExecutions(executions: readonly WorkflowStageExecution[]) {
  const latest = new Map<string, WorkflowStageExecution>();
  for (const execution of executions) {
    const key = workflowStageTargetKey(execution.target);
    const current = latest.get(key);
    if (current === undefined || execution.generation > current.generation)
      latest.set(key, execution);
  }
  return latest;
}

function allRunExecutions(run: OrchestrationImplementationRun): WorkflowStageExecution[] {
  return [...run.stageExecutions, ...run.ticketStates.flatMap((ticket) => ticket.stageExecutions)];
}

export function ticketDependencyState(
  run: OrchestrationImplementationRun,
  ticket: OrchestrationImplementationTicketState,
): "eligible" | "blocked" | "waiting" {
  let waiting = false;
  for (const dependencyId of ticket.dependencyTicketIds) {
    const dependency = run.ticketStates.find((candidate) => candidate.ticketId === dependencyId);
    if (dependency === undefined) return "blocked";
    if (dependency.status === "succeeded") continue;
    const executions = [...latestExecutions(dependency.stageExecutions).values()].sort(
      (left, right) => right.updatedAt.localeCompare(left.updatedAt),
    );
    const current = executions[0];
    if (current?.state === "succeeded" || current?.state === "skipped") continue;
    if (current?.state === "halted") return "blocked";
    if (current !== undefined) {
      waiting = true;
      continue;
    }
    if (dependency.status === "failed") return "blocked";
    waiting = true;
  }
  return waiting ? "waiting" : "eligible";
}

export function reconcileWorkflowState(
  readModel: OrchestrationReadModel,
  now: string,
): ReadonlyArray<WorkflowReconciliationAction> {
  const nowMs = Date.parse(now);
  const actions: WorkflowReconciliationAction[] = [];
  const validationJobs: Array<{
    readonly run: OrchestrationImplementationRun;
    readonly job: DurableValidationJob;
  }> = [];

  for (const rawRun of readModel.implementationRuns) {
    const run = normalizeImplementationRunExecutions(rawRun);
    const executions = allRunExecutions(run);
    validationJobs.push(...run.validationJobs.map((job) => ({ run, job })));
    const latest = latestExecutions(executions);
    for (const execution of executions) {
      const key = workflowStageTargetKey(execution.target);
      if (
        latest.get(key)?.executionId !== execution.executionId &&
        !TERMINAL_STATES.has(execution.state)
      ) {
        actions.push({
          type: "revoke-stale-execution",
          commandId: reconciliationCommandId(
            "revoke-stale-execution",
            execution.executionId,
            execution.generation,
          ),
          execution,
        });
        continue;
      }
      if (execution.state === "queued") {
        actions.push({
          type: "claim-queued-stage",
          commandId: reconciliationCommandId("claim-queued-stage", key, execution.generation),
          execution,
        });
      } else if (
        ACTIVE_STATES.has(execution.state) &&
        execution.leaseExpiresAt !== null &&
        Date.parse(execution.leaseExpiresAt) <= nowMs
      ) {
        actions.push({
          type: "expire-lease",
          commandId: reconciliationCommandId(
            "expire-lease",
            execution.executionId,
            execution.generation,
          ),
          execution,
        });
      } else if (execution.state === "retry-wait") {
        const retryAt = execution.recovery?.retryAt ?? null;
        if (retryAt === null || Date.parse(retryAt) > nowMs) continue;
        actions.push({
          type: "leave-retry-wait",
          commandId: reconciliationCommandId(
            "leave-retry-wait",
            execution.executionId,
            execution.generation,
          ),
          execution,
        });
      } else if (execution.state === "reconciling") {
        actions.push({
          type: "resume-interrupted-execution",
          commandId: reconciliationCommandId(
            "resume-interrupted-execution",
            execution.executionId,
            execution.generation,
          ),
          execution,
        });
      }
    }

    for (const ticket of run.ticketStates) {
      const dependencyState = ticketDependencyState(run, ticket);
      if (dependencyState === "blocked" && ticket.status !== "blocked") {
        actions.push({
          type: "derive-dependency-block",
          commandId: reconciliationCommandId(
            "derive-dependency-block",
            `${run.id}:${ticket.ticketId}`,
          ),
          runId: run.id,
          ticketId: ticket.ticketId,
          dependencyTicketIds: ticket.dependencyTicketIds,
        });
      } else if (dependencyState === "eligible" && ticket.status === "blocked") {
        actions.push({
          type: "derive-dependency-eligibility",
          commandId: reconciliationCommandId(
            "derive-dependency-eligibility",
            `${run.id}:${ticket.ticketId}`,
          ),
          runId: run.id,
          ticketId: ticket.ticketId,
        });
      }
    }

    const hasActive = [...latest.values()].some((execution) => ACTIVE_STATES.has(execution.state));
    const hasQueued = [...latest.values()].some((execution) => execution.state === "queued");
    const hasTimedRetry = [...latest.values()].some(
      (execution) => execution.state === "retry-wait" && execution.recovery?.retryAt !== null,
    );
    const halted = [...latest.values()].filter((execution) => execution.state === "halted");
    if (!hasActive && !hasQueued && !hasTimedRetry && halted.length > 0) {
      const nextAction = halted[0]?.failure?.nextAction ?? "inspect-workflow";
      const fingerprint = halted
        .map(
          (execution) =>
            `${workflowStageTargetKey(execution.target)}:${execution.generation}:${execution.failure?.category ?? "unknown"}`,
        )
        .sort()
        .join("|");
      actions.push({
        type: "report-watchdog",
        commandId: reconciliationCommandId("report-watchdog", `${run.id}:${fingerprint}`),
        runId: run.id,
        nextAction,
        fingerprint,
      });
    }
  }

  const liveValidationJob = validationJobs.find(({ job }) => job.status === "running");
  let queuedValidationJobClaimed = liveValidationJob !== undefined;
  for (const { run, job } of validationJobs.sort((left, right) =>
    left.job.queuedAt.localeCompare(right.job.queuedAt),
  )) {
    const latest = latestExecutions(allRunExecutions(run)).get(workflowStageTargetKey(job.target));
    const stale = latest === undefined || latest.generation !== job.generation;
    if (stale && job.status !== "canceled") {
      actions.push({
        type: "cancel-stale-validation-job",
        commandId: reconciliationCommandId("cancel-stale-validation-job", job.id, job.generation),
        runId: run.id,
        job,
      });
      continue;
    }
    if (job.status === "succeeded" || job.status === "failed") {
      actions.push({
        type: "apply-durable-job-result",
        commandId: reconciliationCommandId(
          "apply-durable-job-result",
          `${job.id}:${job.completedAt ?? job.queuedAt}`,
          job.generation,
        ),
        runId: run.id,
        job,
      });
      continue;
    }
    if (job.status === "running") {
      const heartbeatMs = Date.parse(job.heartbeatAt ?? job.startedAt ?? job.queuedAt);
      const expired = heartbeatMs + DURABLE_VALIDATION_JOB_LEASE_MS <= nowMs;
      actions.push({
        type: expired ? "rerun-expired-validation-job" : "reattach-durable-validation-job",
        commandId: reconciliationCommandId(
          expired ? "rerun-expired-validation-job" : "reattach-durable-validation-job",
          job.id,
          job.generation,
        ),
        runId: run.id,
        job,
      });
      continue;
    }
    if (job.status === "queued" && !queuedValidationJobClaimed) {
      queuedValidationJobClaimed = true;
      actions.push({
        type: "start-durable-validation-job",
        commandId: reconciliationCommandId("start-durable-validation-job", job.id, job.generation),
        runId: run.id,
        job,
      });
    }
  }

  for (const rawNestedRun of readModel.appReviewWorkflowRuns ?? []) {
    const nestedRun = normalizeAppReviewPhaseExecution(rawNestedRun);
    const execution = nestedRun.phaseExecution;
    if (execution !== null) {
      const retryAt = execution.recovery?.retryAt ?? null;
      if (execution.state === "queued") {
        actions.push({
          type: "claim-queued-stage",
          commandId: reconciliationCommandId(
            "claim-queued-stage",
            workflowStageTargetKey(execution.target),
            execution.generation,
          ),
          execution,
        });
      } else if (
        ACTIVE_STATES.has(execution.state) &&
        execution.leaseExpiresAt !== null &&
        Date.parse(execution.leaseExpiresAt) <= nowMs
      ) {
        actions.push({
          type: "expire-lease",
          commandId: reconciliationCommandId(
            "expire-lease",
            execution.executionId,
            execution.generation,
          ),
          execution,
        });
      } else if (
        execution.state === "retry-wait" &&
        retryAt !== null &&
        Date.parse(retryAt) <= nowMs
      ) {
        actions.push({
          type: "leave-retry-wait",
          commandId: reconciliationCommandId(
            "leave-retry-wait",
            execution.executionId,
            execution.generation,
          ),
          execution,
        });
      } else if (execution.state === "reconciling") {
        actions.push({
          type: "resume-interrupted-execution",
          commandId: reconciliationCommandId(
            "resume-interrupted-execution",
            execution.executionId,
            execution.generation,
          ),
          execution,
        });
      }
    }
    if (nestedRun.status === "running") continue;
    if (nestedRun.caller.type !== "implementation") continue;
    actions.push({
      type: "settle-nested-review",
      commandId: reconciliationCommandId(
        "settle-nested-review",
        `${nestedRun.caller.implementationRunId}:${nestedRun.id}:${nestedRun.updatedAt}`,
      ),
      appReviewRunId: nestedRun.id,
      implementationRunId: nestedRun.caller.implementationRunId,
      ticketId: nestedRun.caller.ticketId ?? null,
    });
  }

  return actions.sort((left, right) => left.commandId.localeCompare(right.commandId));
}

export function workflowExecutionIsActive(execution: WorkflowStageExecution): boolean {
  return ACTIVE_STATES.has(execution.state);
}

function recoverExecutionAtStartup(
  execution: WorkflowStageExecution,
  cause: "planned-restart" | "server-crash",
  now: string,
): WorkflowStageExecution {
  const interrupted =
    ACTIVE_STATES.has(execution.state) ||
    (cause === "planned-restart" && execution.state === "retry-wait");
  if (!interrupted) return execution;
  if (cause === "planned-restart") {
    return {
      ...execution,
      state: "reconciling",
      claimedAt: null,
      leaseRenewedAt: null,
      leaseExpiresAt: null,
      lastProgressAt: now,
      failure: {
        category: cause,
        detail: "The server planned this restart and will resume the same execution.",
        failedAt: now,
        nextAction: "continue-stage",
      },
      recovery: {
        cause,
        startedAt: now,
        deadlineAt: null,
        attempts: 0,
        selectedModel: execution.recovery?.selectedModel ?? null,
        fallbackHistory: [],
        retryAt: null,
      },
      updatedAt: now,
    };
  }

  const existingCrash = execution.recovery?.cause === "server-crash" ? execution.recovery : null;
  const deadlineAt =
    existingCrash?.deadlineAt ??
    DateTime.formatIso(
      DateTime.add(DateTime.makeUnsafe(Date.parse(now)), {
        milliseconds: WORKFLOW_CRASH_RECOVERY_MS,
      }),
    );
  const expired = Date.parse(deadlineAt) <= Date.parse(now);
  return {
    ...execution,
    state: expired ? "halted" : "reconciling",
    claimedAt: null,
    leaseRenewedAt: null,
    leaseExpiresAt: null,
    lastProgressAt: now,
    failure: {
      category: cause,
      detail: expired
        ? "Crash recovery remained unresolved for eight hours."
        : "The previous server runtime ended before this execution settled.",
      failedAt: now,
      nextAction: expired ? "rerun-stage" : "continue-stage",
    },
    recovery: {
      cause,
      startedAt: existingCrash?.startedAt ?? now,
      deadlineAt,
      attempts: (existingCrash?.attempts ?? 0) + 1,
      selectedModel: execution.recovery?.selectedModel ?? null,
      fallbackHistory: execution.recovery?.fallbackHistory ?? [],
      retryAt: null,
    },
    updatedAt: now,
  };
}

export function recoverWorkflowRunsAfterStartup(input: {
  readonly readModel: OrchestrationReadModel;
  readonly cause: "planned-restart" | "server-crash";
  readonly now: string;
}): {
  readonly implementationRuns: readonly OrchestrationImplementationRun[];
  readonly appReviewRuns: readonly AppReviewWorkflowRun[];
} {
  return {
    implementationRuns: input.readModel.implementationRuns.map((rawRun) => {
      const run = normalizeImplementationRunExecutions(rawRun);
      const stageExecutions = run.stageExecutions.map((execution) =>
        recoverExecutionAtStartup(execution, input.cause, input.now),
      );
      const ticketStates = run.ticketStates.map((ticket) => ({
        ...ticket,
        stageExecutions: ticket.stageExecutions.map((execution) =>
          recoverExecutionAtStartup(execution, input.cause, input.now),
        ),
      }));
      const changed =
        stageExecutions.some((execution, index) => execution !== run.stageExecutions[index]) ||
        ticketStates.some((ticket, index) => ticket !== run.ticketStates[index]);
      return changed
        ? {
            ...run,
            status: run.status === "needs-human-attention" ? "running" : run.status,
            stageExecutions,
            ticketStates,
            appReviewUnblockAttemptCount: 0,
            retryableFailure: null,
            automationHalt: null,
            updatedAt: input.now,
          }
        : run;
    }),
    appReviewRuns: (input.readModel.appReviewWorkflowRuns ?? []).map((rawRun) => {
      const run = normalizeAppReviewPhaseExecution(rawRun);
      if (run.phaseExecution === null) return run;
      const phaseExecution = recoverExecutionAtStartup(run.phaseExecution, input.cause, input.now);
      return phaseExecution === run.phaseExecution
        ? run
        : {
            ...run,
            status: "running",
            outcome: null,
            failure: null,
            phaseExecution,
            updatedAt: input.now,
          };
    }),
  };
}
