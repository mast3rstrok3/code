import {
  DEV_REVIEW_WORKFLOW_MAX_CYCLES,
  type DevReviewRecord,
  type DevReviewWorkflowRun,
  type ThreadId,
} from "@t3tools/contracts";

export function selectActiveDevReviewRecord(
  records: readonly DevReviewRecord[],
  openedThreadId: ThreadId,
): DevReviewRecord | null {
  const sorted = [...records].sort(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
  );
  return sorted.find((record) => record.reviewThreadId === openedThreadId) ?? sorted.at(-1) ?? null;
}

export function isValidDevReviewWorkflowLaunch(input: {
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
    input.cycleBudget <= DEV_REVIEW_WORKFLOW_MAX_CYCLES &&
    input.sourceSettled &&
    !input.worktreeOwned
  );
}

export function devReviewRunContainsThread(run: DevReviewWorkflowRun, threadId: ThreadId): boolean {
  return (
    run.targetThreadId === threadId ||
    run.controllerThreadId === threadId ||
    run.cycles.some(
      (cycle) => cycle.reviewerThreadId === threadId || cycle.fixerThreadId === threadId,
    )
  );
}

export function devReviewRunStatusLabel(run: DevReviewWorkflowRun): string {
  if (run.status !== "running") return run.outcome ?? run.status;
  const cycle = run.cycles.at(-1)?.cycleNumber ?? Math.min(run.attemptsUsed + 1, run.cycleBudget);
  const phase = run.activePhase ?? "refreshing preview";
  return `${phase} · Cycle ${Math.max(1, cycle)} of ${run.cycleBudget}`;
}

export function selectLatestDevReviewControllerRun(
  runs: readonly DevReviewWorkflowRun[],
  threadId: ThreadId,
): DevReviewWorkflowRun | null {
  let latest: DevReviewWorkflowRun | null = null;
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

export function devReviewRunFailureSummary(run: DevReviewWorkflowRun): string | null {
  if (run.failure === null) return null;
  return run.failure.detailMarkdown
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 2)
    .join("\n");
}
