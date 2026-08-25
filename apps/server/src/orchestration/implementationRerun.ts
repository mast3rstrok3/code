import {
  type OrchestrationImplementationRerunTarget,
  type OrchestrationImplementationRun,
  type WorkflowStageExecution,
  type WorkflowStageTarget,
} from "@t3tools/contracts";

type AutomationHalt = NonNullable<OrchestrationImplementationRun["automationHalt"]>;

export function implementationRerunTargetMatchesHalt(
  halt: AutomationHalt,
  target: OrchestrationImplementationRerunTarget,
): boolean {
  if (target.kind === "ticket") {
    if (halt.ticketId !== target.ticketId) return false;
    return (
      halt.stage === target.stage ||
      (target.stage === "code-review" && halt.stage === "final-code-review")
    );
  }

  switch (target.stage) {
    case "integration":
    case "merge-gate":
      return halt.ticketId === undefined && halt.stage === "integration";
    case "app-review":
      return halt.ticketId === undefined && halt.stage === "app-review";
    case "code-review":
      return (
        halt.ticketId === undefined &&
        (halt.stage === "code-review" || halt.stage === "final-code-review")
      );
  }
}

/**
 * A workflow-level restart button cannot name the ticket that halted inside
 * that step. Route it to the ticket stage so the action clears the real halt.
 */
export function normalizeImplementationRerunTargetForHalt(
  run: Pick<OrchestrationImplementationRun, "automationHalt">,
  target: OrchestrationImplementationRerunTarget,
): OrchestrationImplementationRerunTarget {
  const halt = run.automationHalt;
  if (halt?.ticketId === undefined || target.kind !== "run") return target;
  if (target.stage === "app-review" && halt.stage === "app-review") {
    return { kind: "ticket", ticketId: halt.ticketId, stage: "app-review" };
  }
  if (
    target.stage === "code-review" &&
    (halt.stage === "code-review" || halt.stage === "final-code-review")
  ) {
    return { kind: "ticket", ticketId: halt.ticketId, stage: "code-review" };
  }
  return target;
}

export function implementationRerunWorkflowTarget(
  runId: string,
  target: OrchestrationImplementationRerunTarget,
): WorkflowStageTarget {
  return target.kind === "ticket"
    ? { kind: "ticket", runId, ticketId: target.ticketId, stage: target.stage }
    : { kind: "run", runId, stage: target.stage };
}

function latestTargetGeneration(
  executions: readonly WorkflowStageExecution[],
  target: WorkflowStageTarget,
): number {
  return executions.reduce(
    (generation, execution) =>
      JSON.stringify(execution.target) === JSON.stringify(target)
        ? Math.max(generation, execution.generation)
        : generation,
    -1,
  );
}

function queuedExecution(input: {
  readonly target: WorkflowStageTarget;
  readonly generation: number;
  readonly executionId: string;
  readonly createdAt: string;
  readonly failure?: WorkflowStageExecution["failure"];
}): WorkflowStageExecution {
  return {
    target: input.target,
    generation: input.generation,
    executionId: input.executionId,
    state: input.failure === undefined ? "queued" : "halted",
    queuedAt: input.createdAt,
    claimedAt: null,
    leaseRenewedAt: null,
    leaseExpiresAt: null,
    lastProgressAt: input.createdAt,
    durableJobId: null,
    failure: input.failure ?? null,
    recovery: null,
    updatedAt: input.createdAt,
  };
}

function dependentTicketIds(run: OrchestrationImplementationRun, ticketId: string): Set<string> {
  const dependents = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const ticket of run.ticketStates) {
      if (ticket.ticketId === ticketId || dependents.has(ticket.ticketId)) continue;
      if (
        ticket.dependencyTicketIds.some(
          (dependencyId) => dependencyId === ticketId || dependents.has(dependencyId),
        )
      ) {
        dependents.add(ticket.ticketId);
        changed = true;
      }
    }
  }
  return dependents;
}

export function queueImplementationRerun(input: {
  readonly run: OrchestrationImplementationRun;
  readonly target: OrchestrationImplementationRerunTarget;
  readonly executionId: string;
  readonly createdAt: string;
}): { readonly run: OrchestrationImplementationRun; readonly execution: WorkflowStageExecution } {
  const workflowTarget = implementationRerunWorkflowTarget(input.run.id, input.target);
  if (input.target.kind === "run") {
    const legacyGeneration =
      input.target.stage === "code-review" ? input.run.finalCodeReviewGeneration : 0;
    const generation =
      Math.max(
        legacyGeneration,
        latestTargetGeneration(input.run.stageExecutions ?? [], workflowTarget),
      ) + 1;
    const execution = queuedExecution({
      target: workflowTarget,
      generation,
      executionId: input.executionId,
      createdAt: input.createdAt,
    });
    return {
      execution,
      run: {
        ...input.run,
        ...(input.target.stage === "code-review" ? { finalCodeReviewGeneration: generation } : {}),
        stageExecutions: [...(input.run.stageExecutions ?? []), execution],
        updatedAt: input.createdAt,
      },
    };
  }

  const target = input.target;
  const dependents = dependentTicketIds(input.run, target.ticketId);
  let targetExecution: WorkflowStageExecution | null = null;
  const ticketStates = input.run.ticketStates.map((ticket) => {
    if (ticket.ticketId === target.ticketId) {
      const legacyGeneration =
        target.stage === "implementation"
          ? ticket.implementationGeneration
          : target.stage === "app-review"
            ? ticket.appReviewGeneration
            : ticket.codeReviewGeneration;
      const generation =
        Math.max(
          legacyGeneration,
          latestTargetGeneration(ticket.stageExecutions ?? [], workflowTarget),
        ) + 1;
      targetExecution = queuedExecution({
        target: workflowTarget,
        generation,
        executionId: input.executionId,
        createdAt: input.createdAt,
      });
      return {
        ...ticket,
        ...(target.stage === "implementation"
          ? { implementationGeneration: generation }
          : target.stage === "app-review"
            ? { appReviewGeneration: generation }
            : { codeReviewGeneration: generation }),
        stageExecutions: [...(ticket.stageExecutions ?? []), targetExecution],
        updatedAt: input.createdAt,
      };
    }
    if (!dependents.has(ticket.ticketId)) return ticket;
    const generation = ticket.implementationGeneration + 1;
    const dependencyTarget: WorkflowStageTarget = {
      kind: "ticket",
      runId: input.run.id,
      ticketId: ticket.ticketId,
      stage: "implementation",
    };
    const dependencyExecution = queuedExecution({
      target: dependencyTarget,
      generation,
      executionId: `${input.executionId}:dependency:${ticket.ticketId}`,
      createdAt: input.createdAt,
      failure: {
        category: "dependency-failed",
        detail: `Waiting for re-run ticket '${target.ticketId}'.`,
        failedAt: input.createdAt,
        nextAction: "wait-for-dependencies",
      },
    });
    return {
      ...ticket,
      status: "blocked" as const,
      implementationGeneration: generation,
      stageExecutions: [...(ticket.stageExecutions ?? []), dependencyExecution],
      updatedAt: input.createdAt,
    };
  });
  if (targetExecution === null) throw new Error(`Missing re-run ticket '${target.ticketId}'.`);
  return {
    execution: targetExecution,
    run: { ...input.run, ticketStates, updatedAt: input.createdAt },
  };
}
