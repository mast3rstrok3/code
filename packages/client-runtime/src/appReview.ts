import {
  APP_REVIEW_WORKFLOW_MAX_CYCLES,
  type AppReviewRecord,
  type AppReviewWorkflowCycle,
  type AppReviewWorkflowPhase,
  type AppReviewWorkflowRun,
  type ClientOrchestrationCommand,
  type CommandId,
  type ModelSelection,
  type OrchestrationPlanningTicket,
  type ThreadId,
} from "@t3tools/contracts";
import { normalizePreviewUrl } from "@t3tools/shared/preview";

export interface AppReviewWorkflowLaunchRequest {
  readonly brief: string;
  readonly cycleBudget: number;
  readonly reviewUrl: string;
  readonly reviewOnly: boolean;
}

const DOM_REPLAY_MIME_TYPE = "application/x-rrweb+jsonl";

/** An rrweb DOM recording, which only a DOM replayer can play. */
export function isDomReplayRecording(mimeType: string | null | undefined): boolean {
  return mimeType === DOM_REPLAY_MIME_TYPE;
}

/**
 * The exchange a launch hands the reviewer as context: the newest user message
 * and everything after it.
 */
export function appReviewSupportingContext(
  messages: ReadonlyArray<{ readonly role: string; readonly text: string }>,
): string | null {
  let start = messages.length - 1;
  while (start >= 0 && messages[start]?.role !== "user") start -= 1;
  const context = messages
    .slice(Math.max(0, start))
    .map((message) => `${message.role}: ${message.text}`)
    .join("\n\n");
  return context.length > 0 ? context : null;
}

/** The URL a launch pins, or null when it should resolve the worktree's App Stack. */
export function normalizeAppReviewPreviewTarget(value: string): string | null {
  if (value.trim().length === 0) return null;
  try {
    return normalizePreviewUrl(value);
  } catch {
    return null;
  }
}

/**
 * How a launch names its target: the host the run will drive, or the App
 * Stack it resolves from the worktree when the user named nothing.
 */
export function appReviewTargetLabel(reviewUrl: string): string {
  const normalized = normalizeAppReviewPreviewTarget(reviewUrl);
  if (normalized === null) return "App Stack";
  try {
    return new URL(normalized).host;
  } catch {
    return normalized;
  }
}

/** What the next launch will do, in one line. */
export function appReviewLaunchSummary(input: {
  readonly cycleBudget: number;
  readonly reviewUrl: string;
  readonly reviewOnly: boolean;
}): string {
  const target = appReviewTargetLabel(input.reviewUrl);
  if (input.reviewOnly) return `Review only · ${target}`;
  return `${input.cycleBudget} ${input.cycleBudget === 1 ? "cycle" : "cycles"} · ${target}`;
}

/**
 * The standalone launch command for a thread. A review URL pins the target;
 * without one the server resolves the worktree's App Stack. Review only spends
 * exactly one cycle.
 */
export function appReviewWorkflowLaunchCommand(input: {
  readonly request: AppReviewWorkflowLaunchRequest;
  readonly commandId: CommandId;
  readonly targetThreadId: ThreadId;
  readonly controllerThreadId: ThreadId;
  readonly supportingContextMarkdown: string | null;
  readonly modelSelection: ModelSelection;
  readonly createdAt: string;
}): Extract<ClientOrchestrationCommand, { type: "thread.app-review-workflow.launch" }> {
  const { request } = input;
  return {
    type: "thread.app-review-workflow.launch",
    commandId: input.commandId,
    targetThreadId: input.targetThreadId,
    controllerThreadId: input.controllerThreadId,
    caller: { type: "standalone", sourceThreadId: input.targetThreadId },
    briefMarkdown: request.brief,
    supportingContextMarkdown: input.supportingContextMarkdown,
    previewTargets: request.reviewUrl ? [request.reviewUrl] : [],
    previewTargetsPinned: Boolean(request.reviewUrl),
    reviewOnly: request.reviewOnly,
    cycleBudget: request.reviewOnly ? 1 : request.cycleBudget,
    modelSelection: input.modelSelection,
    createdAt: input.createdAt,
  };
}

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
      (cycle) =>
        cycle.e2eThreadId === threadId ||
        cycle.reviewerThreadId === threadId ||
        cycle.plannerThreadId === threadId ||
        cycle.fixerThreadId === threadId,
    )
  );
}

/** The ticket an App Review was launched for, when it was launched for one. */
function appReviewRunTicketId(run: AppReviewWorkflowRun): string | null {
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
  // `filter` already copies, and Hermes has no Array#toSorted.
  return input.runs
    .filter((run) => input.workflowScoped || appReviewRunContainsThread(run, input.openedThreadId))
    .sort(
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

/** How many recorded E2E tests a cycle can replay. */
export function appReviewCycleReplayCount(
  cycle: Pick<AppReviewWorkflowCycle, "e2eExecution">,
): number {
  return (cycle.e2eExecution?.results ?? []).reduce(
    (count, result) => count + (result.recordings?.length ?? 0),
    0,
  );
}

/** How many recorded E2E tests a run can replay across its cycles. */
export function appReviewRunReplayCount(run: Pick<AppReviewWorkflowRun, "cycles">): number {
  return run.cycles.reduce((count, cycle) => count + appReviewCycleReplayCount(cycle), 0);
}

export function appReviewRunStatusLabel(run: AppReviewWorkflowRun): string {
  if (run.status !== "running") return run.outcome ?? run.status;
  if (run.prerequisiteCheck != null) return "Waiting for test prerequisites";
  const cycle = run.cycles.at(-1)?.cycleNumber ?? Math.min(run.cyclesUsed + 1, run.cycleBudget);
  const phase =
    run.activePhase === "e2e"
      ? "End-to-end test"
      : run.activePhase === "review"
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
): readonly [
  AppReviewCycleStepStatus,
  AppReviewCycleStepStatus,
  AppReviewCycleStepStatus,
  AppReviewCycleStepStatus,
] {
  // A spent cycle names the step that broke, so the steps after it read as never
  // reached rather than as work still to come. Cycles recorded before the
  // failure moved onto the cycle blame the review, where the run used to end.
  const brokeAt = cycle.status === "failed" ? (cycle.failure?.phase ?? "review") : null;
  const hasE2e = cycle.e2eThreadId != null || cycle.e2eReviewId != null;
  const hasBrowser = cycle.appReviewScope !== "e2e";
  const e2eComplete = cycle.e2eVerdict === "passed" || cycle.e2eVerdict === "failed";
  const reviewPassed = cycle.reviewVerdict === "passed";
  const reviewComplete = cycle.reviewVerdict !== null && cycle.reviewVerdict !== "pending";
  const planComplete = cycle.planId !== null;
  const fixComplete = cycle.fixResult?.status === "succeeded";
  return [
    !hasE2e
      ? "not-needed"
      : brokeAt === "e2e"
        ? "failed"
        : e2eComplete
          ? "complete"
          : cycle.status === "e2e-testing"
            ? "current"
            : "pending",
    !hasBrowser
      ? "not-needed"
      : brokeAt === "review"
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

export const APP_REVIEW_CYCLE_STEP_STATUS_LABELS: Record<AppReviewCycleStepStatus, string> = {
  "not-needed": "Not needed",
  complete: "Complete",
  current: "In progress",
  failed: "Failed",
  pending: "Pending",
};

/** One step of a cycle as the panel lists it, with the thread its action opens. */
export interface AppReviewCycleStep {
  readonly phase: AppReviewWorkflowPhase;
  readonly number: number;
  readonly title: string;
  readonly description: string;
  readonly status: AppReviewCycleStepStatus;
  readonly actionLabel: string;
  readonly threadId: ThreadId | null;
}

/**
 * The steps a cycle shows. An E2E-only cycle has no browser review, so its
 * later steps renumber and its planning falls back to the E2E thread.
 */
export function appReviewCycleSteps(cycle: AppReviewWorkflowCycle): readonly AppReviewCycleStep[] {
  const [e2eStatus, reviewStatus, planningStatus, implementationStatus] =
    appReviewCycleStepStatuses(cycle);
  const e2eOnly = cycle.appReviewScope === "e2e";
  const repairTicketCount = cycle.repairTickets?.length ?? 0;
  const steps: AppReviewCycleStep[] = [
    {
      phase: "e2e",
      number: 1,
      title: "End-to-end test",
      description: "Run the configured E2E suite and publish its checks and replay links.",
      status: e2eStatus,
      actionLabel: "E2E thread",
      threadId: cycle.e2eThreadId ?? null,
    },
  ];
  if (!e2eOnly) {
    steps.push({
      phase: "review",
      number: 2,
      title: "Human-style UI review",
      description: "Use the app UI, test the acceptance brief, and save evidence.",
      status: reviewStatus,
      actionLabel: "Review thread",
      threadId: cycle.reviewerThreadId,
    });
  }
  steps.push(
    {
      phase: "planning",
      number: e2eOnly ? 2 : 3,
      title: "Gap analysis & repair tickets",
      description: "Turn actionable findings into repair tickets in a separate planning thread.",
      status: planningStatus,
      actionLabel:
        repairTicketCount > 0
          ? `${repairTicketCount} repair ticket${repairTicketCount === 1 ? "" : "s"}`
          : "Review thread",
      threadId:
        cycle.plannerThreadId ??
        (e2eOnly ? (cycle.e2eThreadId ?? cycle.reviewerThreadId) : cycle.reviewerThreadId),
    },
    {
      phase: "fixing",
      number: e2eOnly ? 3 : 4,
      title: "Implement the repair tickets",
      description: "Use the Implement skill in a fresh thread and validate every child ticket.",
      status: implementationStatus,
      actionLabel: "Implementation thread",
      threadId: cycle.fixerThreadId ?? null,
    },
  );
  return steps;
}

/**
 * Why an App Review phase cannot start again yet, if it cannot.
 *
 * Mirrors the server's rules so the panel never offers an action the decider
 * refuses: only the current cycle can be redone, the phases need what the
 * phases before them produced, and nothing starts under a live agent.
 */
export function appReviewPhaseRerunDisabledReason(input: {
  readonly phaseLabel: string;
  readonly phase: AppReviewWorkflowPhase;
  readonly cycle: AppReviewWorkflowCycle;
  readonly isCurrentCycle: boolean;
  readonly callerBusyReason: string | null;
  readonly cyclesUsed: number;
  readonly cycleBudget: number;
  readonly activeThread:
    | { readonly session?: { readonly status: string } | null | undefined }
    | undefined;
}): string | null {
  if (!input.isCurrentCycle) return "Only the newest cycle can start again.";
  if (input.callerBusyReason !== null) return input.callerBusyReason;
  const session = input.activeThread?.session?.status;
  if (session === "starting" || session === "running") {
    return "This App Review is still running. Stop it before starting a phase again.";
  }
  // A browser review redo runs a new cycle rather than overwriting this one, so
  // it needs a cycle left to run in.
  if (
    (input.phase === "e2e" || input.phase === "review") &&
    input.cyclesUsed >= input.cycleBudget
  ) {
    return `Every one of the ${String(input.cycleBudget)} review cycles has been used.`;
  }
  if (input.phase === "planning" && input.cycle.actionableFindingsMarkdown === null) {
    return "Gap analysis needs findings from this cycle's review sections.";
  }
  if (input.phase === "fixing" && (input.cycle.repairTickets?.length ?? 0) === 0) {
    return "The repair needs the tickets gap analysis writes.";
  }
  return null;
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
