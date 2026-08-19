import {
  APP_REVIEW_WORKFLOW_MAX_CYCLES,
  type AppReviewRecord,
  type AppReviewWorkflowCycle,
  type AppReviewWorkflowRun,
  type OrchestrationPlanningTicket,
  type ThreadId,
} from "@t3tools/contracts";

export function selectActiveAppReviewRecord(
  records: readonly AppReviewRecord[],
  openedThreadId: ThreadId,
): AppReviewRecord | null {
  const sorted = [...records].sort(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
  );
  return sorted.find((record) => record.reviewThreadId === openedThreadId) ?? sorted.at(-1) ?? null;
}

export function isValidAppReviewWorkflowLaunch(input: {
  readonly brief: string;
  readonly cycleBudget: number;
  readonly sourceSettled: boolean;
  readonly previewTargets?: ReadonlyArray<string>;
  readonly worktreeOwned: boolean;
}): boolean {
  return (
    input.brief.trim().length > 0 &&
    Number.isInteger(input.cycleBudget) &&
    input.cycleBudget >= 1 &&
    input.cycleBudget <= APP_REVIEW_WORKFLOW_MAX_CYCLES &&
    input.sourceSettled &&
    !input.worktreeOwned
  );
}

export function appReviewRunContainsThread(run: AppReviewWorkflowRun, threadId: ThreadId): boolean {
  return (
    run.targetThreadId === threadId ||
    run.controllerThreadId === threadId ||
    run.cycles.some(
      (cycle) => cycle.reviewerThreadId === threadId || cycle.fixerThreadId === threadId,
    )
  );
}

/** The ticket an App Review was launched for, when it was launched for one. */
export function appReviewRunTicketId(run: AppReviewWorkflowRun): string | null {
  return run.caller.type === "implementation" ? (run.caller.ticketId ?? null) : null;
}

/**
 * How a run is named in the panel. A ticket's own reviews carry the ticket, so
 * a workflow's reviews read as a list of tickets rather than a pile of runs.
 */
export function appReviewRunTicketLabel(
  run: AppReviewWorkflowRun,
  tickets: readonly OrchestrationPlanningTicket[],
): string | null {
  const ticketId = appReviewRunTicketId(run);
  if (ticketId === null) return null;
  const ticket = tickets.find((candidate) => candidate.id === ticketId);
  if (ticket === undefined) return ticketId;
  return `${ticket.key ?? `Ticket ${String(ticket.ordinal + 1)}`} · ${ticket.title}`;
}

/**
 * Runs in reading order: ticket by ticket in plan order, and within a ticket
 * oldest first, so a re-review follows the review it repeats. Reviews of the
 * run as a whole sort last, since they only happen once the tickets are done.
 * A ticket the plan no longer lists sorts just ahead of those.
 */
export function selectAppReviewRunsForPanel(input: {
  readonly runs: readonly AppReviewWorkflowRun[];
  readonly openedThreadId: ThreadId;
  readonly workflowScoped: boolean;
  readonly tickets?: readonly OrchestrationPlanningTicket[];
}): readonly AppReviewWorkflowRun[] {
  const ordinalByTicketId = new Map(
    (input.tickets ?? []).map((ticket) => [ticket.id, ticket.ordinal] as const),
  );
  const rank = (run: AppReviewWorkflowRun): number => {
    const ticketId = appReviewRunTicketId(run);
    if (ticketId === null) return Number.MAX_SAFE_INTEGER;
    return ordinalByTicketId.get(ticketId) ?? Number.MAX_SAFE_INTEGER - 1;
  };
  return input.runs
    .filter((run) => input.workflowScoped || appReviewRunContainsThread(run, input.openedThreadId))
    .toSorted(
      (left, right) =>
        rank(left) - rank(right) ||
        left.createdAt.localeCompare(right.createdAt) ||
        left.id.localeCompare(right.id),
    );
}

/**
 * The run the panel header speaks for. Whatever is running wins, so the header
 * tracks live work rather than whichever ticket happens to sort last.
 */
export function selectHeadlineAppReviewRun(
  runs: readonly AppReviewWorkflowRun[],
): AppReviewWorkflowRun | null {
  return runs.find((run) => run.status === "running") ?? runs.at(-1) ?? null;
}

export function appReviewRunStatusLabel(run: AppReviewWorkflowRun): string {
  if (run.status !== "running") return run.outcome ?? run.status;
  const cycle = run.cycles.at(-1)?.cycleNumber ?? Math.min(run.cyclesUsed + 1, run.cycleBudget);
  const phase =
    run.activePhase === "review"
      ? "UI review"
      : run.activePhase === "planning"
        ? "Gap analysis & plan"
        : run.activePhase === "fixing"
          ? "Implementing plan"
          : "Refreshing preview";
  return `${phase} · Cycle ${Math.max(1, cycle)} of ${run.cycleBudget}`;
}

export type AppReviewCycleStepStatus = "complete" | "current" | "pending" | "not-needed" | "failed";

export function appReviewCycleStepStatuses(
  cycle: AppReviewWorkflowCycle,
): readonly [AppReviewCycleStepStatus, AppReviewCycleStepStatus, AppReviewCycleStepStatus] {
  // A spent cycle names the step that broke, so the two after it read as never
  // reached rather than as work still to come. Cycles recorded before the
  // failure moved onto the cycle blame the review, where the run used to end.
  const brokeAt = cycle.status === "failed" ? (cycle.failure?.phase ?? "review") : null;
  const reviewPassed = cycle.reviewVerdict === "passed";
  const reviewComplete = cycle.reviewVerdict !== null && cycle.reviewVerdict !== "pending";
  const planComplete = cycle.planId !== null;
  const fixComplete = cycle.fixResult?.status === "succeeded";
  return [
    brokeAt === "review"
      ? "failed"
      : reviewComplete
        ? "complete"
        : cycle.status === "reviewing"
          ? "current"
          : "pending",
    brokeAt === "planning"
      ? "failed"
      : reviewPassed
        ? "not-needed"
        : planComplete
          ? "complete"
          : cycle.status === "planning"
            ? "current"
            : "pending",
    brokeAt === "fixing"
      ? "failed"
      : reviewPassed
        ? "not-needed"
        : fixComplete
          ? "complete"
          : cycle.status === "fixing"
            ? "current"
            : "pending",
  ];
}

export function selectLatestAppReviewControllerRun(
  runs: readonly AppReviewWorkflowRun[],
  threadId: ThreadId,
): AppReviewWorkflowRun | null {
  let latest: AppReviewWorkflowRun | null = null;
  for (const run of runs) {
    if (run.controllerThreadId !== threadId) continue;
    if (
      latest === null ||
      run.updatedAt > latest.updatedAt ||
      (run.updatedAt === latest.updatedAt && run.id > latest.id)
    ) {
      latest = run;
    }
  }
  return latest;
}

export function appReviewRunFailureSummary(run: AppReviewWorkflowRun): string | null {
  if (run.failure === null) return null;
  return run.failure.detailMarkdown
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 2)
    .join("\n");
}
