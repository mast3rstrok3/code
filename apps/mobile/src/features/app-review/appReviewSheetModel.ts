import {
  appReviewCycleReplayCount,
  appReviewCycleSteps,
  appReviewPhaseRerunDisabledReason,
  appReviewRunReplayCount,
  appReviewRunStatusLabel,
  appReviewRunTicketLabel,
  type AppReviewCycleStep,
} from "@t3tools/client-runtime/app-review";
import type {
  AppReviewRecord,
  AppReviewWorkflowCycle,
  AppReviewWorkflowRun,
  OrchestrationPlanningTicket,
  OrchestrationThreadWorkflowRole,
  ThreadId,
} from "@t3tools/contracts";

export type AppReviewSheetRow =
  | {
      readonly kind: "run";
      readonly id: string;
      readonly run: AppReviewWorkflowRun;
      readonly label: string;
      readonly statusLabel: string;
      readonly replayCount: number;
      readonly expanded: boolean;
    }
  | { readonly kind: "run-detail"; readonly id: string; readonly run: AppReviewWorkflowRun }
  | {
      readonly kind: "cycle";
      readonly id: string;
      readonly run: AppReviewWorkflowRun;
      readonly cycle: AppReviewWorkflowCycle;
      readonly replayCount: number;
      readonly expanded: boolean;
    }
  | {
      readonly kind: "step";
      readonly id: string;
      readonly run: AppReviewWorkflowRun;
      readonly cycle: AppReviewWorkflowCycle;
      readonly step: AppReviewCycleStep;
      /** Null when this step cannot start again from here: only the newest cycle can. */
      readonly rerun: { readonly disabledReason: string | null } | null;
    }
  | { readonly kind: "heading"; readonly id: string; readonly text: string }
  | { readonly kind: "record"; readonly id: string; readonly record: AppReviewRecord };

/**
 * The App Review sheet as list rows. Only the headline run starts open, and
 * inside a run only the newest cycle shows its steps, so a workflow with a
 * review per ticket reads as a scannable list with the live work one tap away.
 */
export function buildAppReviewSheetRows(input: {
  readonly runs: readonly AppReviewWorkflowRun[];
  readonly headlineRunId: string | null;
  readonly records: readonly AppReviewRecord[];
  readonly allRuns: readonly AppReviewWorkflowRun[];
  readonly tickets: readonly OrchestrationPlanningTicket[];
  readonly expanded: Readonly<Record<string, boolean>>;
  /** The run's active agent, for the rerun guard; undefined when it is not known. */
  readonly sessionStatusFor: (threadId: ThreadId) => string | undefined;
}): readonly AppReviewSheetRow[] {
  const rows: AppReviewSheetRow[] = [];
  input.runs.forEach((run, index) => {
    const runId = `run:${run.id}`;
    const runExpanded = input.expanded[runId] ?? run.id === input.headlineRunId;
    rows.push({
      kind: "run",
      id: runId,
      run,
      label:
        appReviewRunTicketLabel(run, input.tickets) ??
        (input.runs.length > 1 ? `App Review ${String(index + 1)}` : "App Review"),
      statusLabel: appReviewRunStatusLabel(run),
      replayCount: appReviewRunReplayCount(run),
      expanded: runExpanded,
    });
    if (!runExpanded) return;
    rows.push({ kind: "run-detail", id: `${runId}:detail`, run });
    const newestCycleNumber = run.cycles.at(-1)?.cycleNumber;
    const activeSession =
      run.activeThreadId === null ? undefined : input.sessionStatusFor(run.activeThreadId);
    for (const cycle of run.cycles) {
      const cycleId = `${runId}:cycle:${String(cycle.cycleNumber)}`;
      const isCurrentCycle = cycle.cycleNumber === newestCycleNumber;
      const cycleExpanded = input.expanded[cycleId] ?? isCurrentCycle;
      rows.push({
        kind: "cycle",
        id: cycleId,
        run,
        cycle,
        replayCount: appReviewCycleReplayCount(cycle),
        expanded: cycleExpanded,
      });
      if (!cycleExpanded) continue;
      for (const step of appReviewCycleSteps(cycle)) {
        rows.push({
          kind: "step",
          id: `${cycleId}:${step.phase}`,
          run,
          cycle,
          step,
          rerun: isCurrentCycle
            ? {
                disabledReason: appReviewPhaseRerunDisabledReason({
                  phaseLabel: step.title,
                  phase: step.phase,
                  cycle,
                  isCurrentCycle,
                  callerBusyReason: null,
                  cyclesUsed: run.cyclesUsed,
                  cycleBudget: run.cycleBudget,
                  activeThread:
                    activeSession === undefined
                      ? undefined
                      : { session: { status: activeSession } },
                }),
              }
            : null,
        });
      }
    }
  });

  // Browser reviews recorded before App Review ran as a workflow have no run.
  const runReviewIds = new Set(
    input.allRuns.flatMap((run) =>
      run.cycles.flatMap((cycle) =>
        cycle.e2eReviewId == null ? [cycle.reviewId] : [cycle.reviewId, cycle.e2eReviewId],
      ),
    ),
  );
  const legacyRecords = input.records.filter((record) => !runReviewIds.has(record.id));
  if (legacyRecords.length > 0) {
    rows.push({ kind: "heading", id: "legacy", text: "Browser App Reviews" });
    for (const record of legacyRecords) {
      rows.push({ kind: "record", id: `record:${record.id}`, record });
    }
  }
  return rows;
}

const APP_REVIEW_THREAD_ROLES: ReadonlySet<OrchestrationThreadWorkflowRole> = new Set([
  "app-review-orchestrator",
  "app-review-reviewer",
  "app-review-planner",
  "app-review-fixer",
]);

/** A thread an App Review started, which opens straight into its App Review. */
export function isAppReviewThreadRole(
  role: OrchestrationThreadWorkflowRole | null | undefined,
): boolean {
  return role != null && APP_REVIEW_THREAD_ROLES.has(role);
}

/** How the floating control names a controller run, short enough for the pill. */
export function appReviewSegmentLabel(status: AppReviewWorkflowRun["status"] | null): string {
  switch (status) {
    case "running":
      return "Reviewing";
    case "passed":
      return "Review passed";
    case "exhausted":
      return "Review exhausted";
    case "failed":
      return "Review failed";
    case null:
      return "App Review";
  }
}
