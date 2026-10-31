import {
  findWorkflowPauseScope,
  isLegacyFinalRegressionFailure,
  isRunStageSkipped,
  isTicketSkipped,
  type AppReviewWorkflowRun,
  type OrchestrationImplementationRerunRunStage,
  type OrchestrationImplementationRerunTarget,
  type OrchestrationImplementationRun,
  type OrchestrationImplementationSkipRunStage,
  type OrchestrationImplementationTicketState,
  type OrchestrationPlanningSpec,
  type OrchestrationPlanningTicket,
  type OrchestrationPlanningWorkflowStage,
  type OrchestrationThreadWorkflowRole,
  type ThreadId,
  type WorkflowPreset,
} from "@t3tools/contracts";
import {
  WORKFLOW_PRESET_DEFINITION_BY_ID,
  type WorkflowPresetSubStep,
} from "@t3tools/shared/workflowPresets";

import type { EnvironmentWorkflowThreadShell } from "./state/models.ts";
import {
  buildWorkflowSteps,
  implementationRunCurrentStage,
  implementationRunPublicationStageProgress,
  resolveGroupImplementationRun,
  resolveWorkflowGroupTimeRange,
  resolveWorkflowHeaderStatus,
  resolveWorkflowStepRollup,
  resolveWorkflowStepStatus,
  resolveWorkflowStepTimeRange,
  resolveWorkflowThreadStatus,
  resolveWorkflowTicketStatus,
  workflowStatusIsActive,
  workflowStepMatchesImplementationFailure,
  type WorkflowCurrentPath,
  type WorkflowGroup,
  type WorkflowStepStatus,
  type WorkflowThreadStatus,
  type WorkflowTimelineStep,
} from "./workflowModel.ts";

/**
 * Presentation-free logic behind the workflow panel, shared by the web and
 * mobile clients so both read a run the same way.
 */

export const WORKFLOW_THREAD_STATUS_LABELS: Record<WorkflowThreadStatus, string> = {
  working: "Working",
  monitoring: "Monitoring",
  approval: "Approval",
  input: "Input",
  completed: "Completed",
  failed: "Failed",
  stopped: "Stopped",
  archived: "Archived",
};

export const WORKFLOW_STEP_STATUS_LABELS: Record<WorkflowStepStatus, string> = {
  running: "Running",
  awaiting: "Needs you",
  blocked: "Blocked",
  failed: "Failed",
  paused: "Paused",
  stopped: "Stopped",
  queued: "Queued",
  skipped: "Skipped",
  pending: "Not started",
  done: "Done",
};

export function workflowRoleShortLabel(
  role: OrchestrationThreadWorkflowRole | null | undefined,
): string | null {
  switch (role) {
    case "planning-orchestrator":
      return "Planning";
    case "planning-reviewer":
      return "Ticket review";
    case "planning-grill-judge":
      return "Grill judge";
    case "implementation-orchestrator":
      return "Build";
    case "implementation-worker":
      return "Worker";
    case "implementation-validator":
      return "Merge gate";
    case "implementation-qa-reviewer":
      return "App review";
    case "app-review-orchestrator":
      return "App Review";
    case "app-review-reviewer":
      return "Browser review";
    case "app-review-planner":
      return "Gap analysis";
    case "app-review-fixer":
      return "Implement";
    case "implementation-fixer":
    case "product-fix-implementer":
      return "Fix";
    case "implementation-code-reviewer":
      return "Code review";
    case "fast-feature-implementer":
      return "Build";
    default:
      return null;
  }
}

/** The step-level color for a row whose status is a thread's own. */
export function threadStatusAsStepStatus(status: WorkflowThreadStatus): WorkflowStepStatus {
  switch (status) {
    case "approval":
    case "input":
      return "awaiting";
    case "working":
    case "monitoring":
      return "running";
    case "failed":
      return "failed";
    case "stopped":
      return "stopped";
    case "archived":
      return "skipped";
    case "completed":
      return "done";
  }
}

/** `now` stands in for an end that has not happened yet. */
export function elapsedBetween(startedAt: string, endedAt: string | null, now: number): string {
  const start = Date.parse(startedAt);
  const end = endedAt === null ? now : Date.parse(endedAt);
  if (Number.isNaN(start) || Number.isNaN(end)) return "";
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

export function groupTitle(group: WorkflowGroup<EnvironmentWorkflowThreadShell>): string {
  if (group.preset) return WORKFLOW_PRESET_DEFINITION_BY_ID[group.preset].label;
  if (group.kind === "batch") return "Agent batch";
  if (group.kind === "legacy") return "Legacy workflow";
  return "Workflow run";
}

export function groupStatus(
  group: WorkflowGroup<EnvironmentWorkflowThreadShell>,
): WorkflowThreadStatus {
  const statuses = group.rows.map((row) => resolveWorkflowThreadStatus(row.thread));
  return (
    statuses.find((status) => status === "approval") ??
    statuses.find((status) => status === "input") ??
    statuses.find((status) => status === "working") ??
    statuses.find((status) => status === "monitoring") ??
    statuses.find((status) => status === "failed") ??
    statuses.find((status) => status === "stopped") ??
    statuses.find((status) => status === "archived") ??
    "completed"
  );
}

export function workflowStepTitle(
  step: WorkflowTimelineStep<EnvironmentWorkflowThreadShell>,
): string {
  if (step.label !== null) return step.label;
  const first = step.entries[0];
  if (!first) return "Work";
  if (first.kind === "workflow") return groupTitle(first.group);
  return workflowRoleShortLabel(first.row.thread.workflowRole) ?? "Work";
}

export function workflowStepPhase(
  step: WorkflowTimelineStep<EnvironmentWorkflowThreadShell>,
): string {
  const label = workflowStepTitle(step);
  const separator = label.indexOf(" phase · ");
  if (separator !== -1) return label.slice(0, separator);
  const roles = step.entries.flatMap((entry) =>
    entry.kind === "thread" && entry.row.thread.workflowRole !== null
      ? [entry.row.thread.workflowRole]
      : [],
  );
  return roles.length > 0 && roles.every((role) => role.startsWith("planning-"))
    ? "Planning"
    : "Implementation";
}

export function workflowStepLabel(
  step: WorkflowTimelineStep<EnvironmentWorkflowThreadShell>,
): string {
  const label = workflowStepTitle(step);
  const separator = label.indexOf(" phase · ");
  return separator === -1 ? label : label.slice(separator + " phase · ".length);
}

export function groupWorkflowStepsByPhase(
  steps: readonly WorkflowTimelineStep<EnvironmentWorkflowThreadShell>[],
): readonly (readonly [string, readonly WorkflowTimelineStep<EnvironmentWorkflowThreadShell>[]])[] {
  const byPhase = new Map<string, WorkflowTimelineStep<EnvironmentWorkflowThreadShell>[]>();
  for (const step of steps) {
    const phase = workflowStepPhase(step);
    const phaseSteps = byPhase.get(phase);
    if (phaseSteps) phaseSteps.push(step);
    else byPhase.set(phase, [step]);
  }
  return [...byPhase.entries()];
}

export function planningStepTimeRange(
  step: WorkflowTimelineStep<EnvironmentWorkflowThreadShell>,
  groups: readonly WorkflowGroup<EnvironmentWorkflowThreadShell>[],
  spec: OrchestrationPlanningSpec | null,
  tickets: readonly OrchestrationPlanningTicket[],
) {
  const label = workflowStepLabel(step).toLowerCase();
  if (label.includes("spec authoring") && spec !== null) {
    return { startedAt: spec.createdAt, endedAt: spec.updatedAt };
  }
  if (label.includes("ticket authoring") && tickets.length > 0) {
    const ordered = [...tickets].sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt),
    );
    return {
      startedAt: spec?.updatedAt ?? ordered[0]!.createdAt,
      endedAt: ordered.reduce(
        (latest, ticket) => (ticket.createdAt > latest ? ticket.createdAt : latest),
        ordered[0]!.createdAt,
      ),
    };
  }
  const threadRange = resolveWorkflowStepTimeRange(step, groups);
  if (label.includes("grill") && spec !== null) {
    return { startedAt: threadRange.startedAt, endedAt: spec.createdAt };
  }
  return threadRange;
}

export type RestartablePlanningStage = "grill" | "spec" | "tickets";

export function restartablePlanningStage(
  step: WorkflowTimelineStep<EnvironmentWorkflowThreadShell>,
  currentStage: OrchestrationPlanningWorkflowStage,
): RestartablePlanningStage | null {
  const label = workflowStepLabel(step).toLowerCase();
  if (label.includes("grill")) return "grill";
  if (label.includes("spec authoring")) return currentStage === "grill" ? null : "spec";
  if (label.includes("ticket authoring")) {
    return currentStage === "grill" || currentStage === "spec-authoring" ? null : "tickets";
  }
  return null;
}

/**
 * The restart the workflow can honor for a step, if any.
 *
 * Only stages the runtime can re-enter are offered: planning stages restart in
 * place, a paused run resumes at the step it stopped at, and a blocked
 * implementation run retries from its failed stage. Every other step reports
 * why it cannot be restarted on its own rather than offering an action that
 * would do nothing.
 */
export function resolveStepRestart(input: {
  readonly planningRestartStage: RestartablePlanningStage | null;
  readonly rootSessionBusy: boolean;
  readonly canRetryStep: boolean;
  readonly workflowPaused: boolean;
  /** True only for the one step a resume would actually re-enter. */
  readonly isResumeStep: boolean;
  readonly resumeStepLabel: string | null;
  readonly onRestartPlanningStage: ((stage: RestartablePlanningStage) => void) | undefined;
  readonly onRetryImplementationRun: ((runId: string) => void) | undefined;
  /** The run-wide stage this step starts again, when it owns one. */
  readonly rerunRunStage: RerunRunStage | null;
  readonly onRerunImplementationStage:
    | ((input: {
        readonly runId: string;
        readonly target: OrchestrationImplementationRerunTarget;
      }) => void)
    | undefined;
  readonly onResumeWorkflow: (() => void) | undefined;
  readonly implementationRunId: string | null;
}): { readonly run: (() => void) | undefined; readonly disabledReason: string | null } {
  if (input.planningRestartStage !== null && input.onRestartPlanningStage !== undefined) {
    if (input.rootSessionBusy) {
      return {
        run: undefined,
        disabledReason: "The main thread is busy. Wait for it to settle before restarting.",
      };
    }
    const stage = input.planningRestartStage;
    const restart = input.onRestartPlanningStage;
    return { run: () => restart(stage), disabledReason: null };
  }
  // A paused run keeps its worktrees, branches, App Stack, and active
  // stage threads. Resuming continues the stage in its recorded thread.
  if (input.workflowPaused) {
    if (input.isResumeStep && input.onResumeWorkflow !== undefined) {
      const resume = input.onResumeWorkflow;
      return { run: () => resume(), disabledReason: null };
    }
    return {
      run: undefined,
      disabledReason:
        input.resumeStepLabel === null
          ? "The workflow is paused. Resume it from the workflow header."
          : `The workflow is paused at ${input.resumeStepLabel}. Start that step again to continue.`,
    };
  }
  if (
    input.canRetryStep &&
    input.onRetryImplementationRun !== undefined &&
    input.implementationRunId !== null
  ) {
    const runId = input.implementationRunId;
    const retry = input.onRetryImplementationRun;
    return { run: () => retry(runId), disabledReason: null };
  }
  if (
    input.rerunRunStage !== null &&
    input.onRerunImplementationStage !== undefined &&
    input.implementationRunId !== null
  ) {
    const runId = input.implementationRunId;
    const stage = input.rerunRunStage;
    const rerun = input.onRerunImplementationStage;
    return {
      run: () => rerun({ runId, target: { kind: "run", stage } }),
      disabledReason: null,
    };
  }
  return {
    run: undefined,
    disabledReason: "This workflow cannot re-enter this step on its own.",
  };
}

/**
 * The run-wide stage a step starts again, for the steps that own one.
 *
 * Ticket waves are deliberately absent: re-running the whole wave would restart
 * the tickets that already succeeded, so those start again one ticket and one
 * stage at a time from the ticket's own row.
 */
export function rerunRunStageForStep(
  step: WorkflowTimelineStep<EnvironmentWorkflowThreadShell>,
  run?: OrchestrationImplementationRun | null,
): RerunRunStage | null {
  const label = workflowStepLabel(step).toLowerCase();
  // Integration re-merges the terminal branches and then re-enters the merge
  // gate, which is the whole of what this step does.
  if (label.includes("final regression tests"))
    return run?.codeReviewedHeadSha != null ? "merge-gate" : null;
  if (label.includes("merge ticket branches")) return "integration";
  if (label.includes("app review")) return "app-review";
  if (label.includes("code review")) return "code-review";
  return null;
}

/** The skip controlled by a workflow row, including publication stages that cannot restart. */
export function skipRunStageForStep(
  step: WorkflowTimelineStep<EnvironmentWorkflowThreadShell>,
): SkipRunStage | null {
  const label = workflowStepLabel(step).toLowerCase();
  if (label.includes("create pull request")) return "change-request";
  if (label.includes("babysit pull request")) return "change-request-babysit";
  return rerunRunStageForStep(step);
}

/** Threads of a step that are still live, excluding the workflow root. */
export function collectRunningStepThreadIds(
  allThreads: readonly EnvironmentWorkflowThreadShell[],
  step: WorkflowTimelineStep<EnvironmentWorkflowThreadShell>,
  rootThreadId: string,
): readonly ThreadId[] {
  const ids = new Set<ThreadId>();
  const consider = (thread: EnvironmentWorkflowThreadShell) => {
    if (thread.id === rootThreadId) return;
    // A paused scope is stopped even while a stale session row says otherwise.
    if (findWorkflowPauseScope(allThreads, thread.id) !== null) return;
    if (!workflowStatusIsActive(resolveWorkflowThreadStatus(thread))) return;
    ids.add(thread.id);
  };
  for (const entry of step.entries) {
    if (entry.kind === "thread") consider(entry.row.thread);
    else for (const row of entry.group.rows) consider(row.thread);
  }
  return [...ids];
}

/** Every thread a step owns, whatever it is doing right now. */
export function collectStepThreads(
  step: WorkflowTimelineStep<EnvironmentWorkflowThreadShell>,
  rootThreadId: string,
): readonly EnvironmentWorkflowThreadShell[] {
  const byId = new Map<ThreadId, EnvironmentWorkflowThreadShell>();
  const consider = (thread: EnvironmentWorkflowThreadShell) => {
    if (thread.id === rootThreadId) return;
    byId.set(thread.id, thread);
  };
  for (const entry of step.entries) {
    if (entry.kind === "thread") consider(entry.row.thread);
    else for (const row of entry.group.rows) consider(row.thread);
  }
  return [...byId.values()];
}

export function planningStepProgress(
  step: WorkflowTimelineStep<EnvironmentWorkflowThreadShell>,
  currentStage: OrchestrationPlanningWorkflowStage,
): "Completed" | "Current" | "Upcoming" | null {
  const label = workflowStepLabel(step).toLowerCase();
  const stepIndex = label.includes("prepare shared worktree")
    ? 0
    : label.includes("grill")
      ? 1
      : label.includes("spec authoring")
        ? 2
        : label.includes("ticket authoring")
          ? 3
          : label.includes("ticket review")
            ? 4
            : null;
  if (stepIndex === null) return null;
  const currentIndex =
    currentStage === "grill"
      ? 1
      : currentStage === "spec-authoring"
        ? 2
        : currentStage === "tickets-authoring"
          ? 3
          : currentStage === "ticket-review" || currentStage === "ticket-revision"
            ? 4
            : 5;
  return stepIndex < currentIndex
    ? "Completed"
    : stepIndex === currentIndex
      ? "Current"
      : "Upcoming";
}

/**
 * The agents a rendered step starts, read back from its preset definition.
 *
 * Matched on the definition's own label so a step rendered from a legacy run
 * still finds its sub-steps.
 */
export function workflowStepSubSteps(
  preset: WorkflowPreset | null,
  step: WorkflowTimelineStep<EnvironmentWorkflowThreadShell>,
): ReadonlyArray<WorkflowPresetSubStep> {
  if (preset === null || step.label === null) return [];
  const definition = WORKFLOW_PRESET_DEFINITION_BY_ID[preset];
  return definition?.helpSteps.find((candidate) => candidate.label === step.label)?.subSteps ?? [];
}

export function workflowSkillLabel(skillId: string, titles: ReadonlyMap<string, string>): string {
  if (skillId === "implementation.browser-app-review.codex") return "App Review";
  const title = titles.get(skillId);
  if (title) return title;
  switch (skillId) {
    case "implementation.browser-app-review.codex":
      return "App Review";
    case "implementation.code-review.codex":
      return "Code Review";
    case "implementation.merge-gate.codex":
      return "Merge Gate";
    case "implementation.tdd.codex":
      return "Ticket implementation";
    default:
      return skillId;
  }
}

export type RerunRunStage = OrchestrationImplementationRerunRunStage;
export type SkipRunStage = OrchestrationImplementationSkipRunStage;

/** Whether the App Review's current phase still has a live provider session. */
export function appReviewRunActiveThreadIsBusy(
  run: AppReviewWorkflowRun | null | undefined,
  threads: readonly EnvironmentWorkflowThreadShell[],
): boolean {
  if (run?.status !== "running" || run.activeThreadId === null) return false;
  const activeThread = threads.find((thread) => thread.id === run.activeThreadId);
  return (
    activeThread?.session?.status === "starting" || activeThread?.session?.status === "running"
  );
}

/**
 * The pause covering one row of the panel.
 *
 * A row is only shown as paused when every thread in it is: stopping one
 * ticket of a wave leaves the wave running, and saying otherwise would hide
 * the work that is still going. `scopeThreadIds` names the scopes a Resume has
 * to clear, which may be the row's own threads or an ancestor the user stopped
 * from a wider menu.
 */
export function workflowPauseOf(
  allThreads: readonly EnvironmentWorkflowThreadShell[],
  rowThreads: readonly EnvironmentWorkflowThreadShell[],
): { readonly scopeThreadIds: readonly ThreadId[]; readonly paused: boolean } {
  const scopeThreadIds = new Set<ThreadId>();
  let pausedCount = 0;
  for (const thread of rowThreads) {
    const scope = findWorkflowPauseScope(allThreads, thread.id);
    if (scope === null) continue;
    pausedCount += 1;
    scopeThreadIds.add(scope.id);
  }
  return {
    scopeThreadIds: [...scopeThreadIds],
    paused: rowThreads.length > 0 && pausedCount === rowThreads.length,
  };
}

/**
 * The threads a Stop would actually end, so the button can disable itself.
 *
 * A paused thread never counts, whatever its session row says. That row can
 * outlive the agent: the provider's last write is lost when the server restarts
 * before it lands, and a stale "running" would leave a stopped wave reading as
 * busy, with Clear and Start refusing to touch it.
 */
export function runningThreadIdsOf(
  allThreads: readonly EnvironmentWorkflowThreadShell[],
  threads: readonly EnvironmentWorkflowThreadShell[],
): readonly ThreadId[] {
  return threads
    .filter(
      (thread) =>
        findWorkflowPauseScope(allThreads, thread.id) === null &&
        (thread.session?.status === "running" || thread.session?.status === "starting"),
    )
    .map((thread) => thread.id);
}

export function implementationRunWorkflowIds(
  run: Pick<OrchestrationImplementationRun, "id" | "appReviewWorkflowRunIds" | "ticketStates">,
  appReviewWorkflowRuns: readonly AppReviewWorkflowRun[],
): ReadonlySet<string> {
  const workflowIds = new Set([run.id, ...run.appReviewWorkflowRunIds]);
  for (const state of run.ticketStates) {
    const appReviewWorkflowRunId = state.appReviewWorkflowRunId;
    if (appReviewWorkflowRunId !== null && appReviewWorkflowRunId !== undefined) {
      workflowIds.add(appReviewWorkflowRunId);
    }
  }
  for (const appReviewRun of appReviewWorkflowRuns) {
    if (
      appReviewRun.caller.type === "implementation" &&
      appReviewRun.caller.implementationRunId === run.id
    ) {
      workflowIds.add(appReviewRun.id);
    }
  }
  return workflowIds;
}

/**
 * The review outcome that colors a ticket: App Review's while the ticket is in
 * one or held back by one, Code Review's otherwise.
 */
export function ticketReviewOutcome(state: OrchestrationImplementationTicketState | undefined) {
  return state?.status === "app-reviewing" || state?.status === "blocked"
    ? state.appReviewOutcome
    : state?.codeReviewOutcome;
}

/**
 * The status of every ticket the workflow's implementation runs hold, for the
 * progress bar at the top of the panel.
 *
 * Each ticket reads the status its own row shows. A ticket held by more than
 * one run counts once, under the newest run, which is the one still able to
 * finish it.
 */
export function workflowTicketStatuses(input: {
  readonly runs: readonly OrchestrationImplementationRun[];
  readonly tickets: readonly OrchestrationPlanningTicket[];
  readonly threads: readonly EnvironmentWorkflowThreadShell[];
  readonly appReviewWorkflowRuns: readonly AppReviewWorkflowRun[];
}): readonly WorkflowStepStatus[] {
  const counted = new Set<string>();
  const statuses: WorkflowStepStatus[] = [];
  const newestFirst = [...input.runs].sort((left, right) =>
    right.createdAt.localeCompare(left.createdAt),
  );
  for (const run of newestFirst) {
    const runTickets = input.tickets.filter(
      (ticket) => run.planningTicketIds.includes(ticket.id) && !counted.has(ticket.id),
    );
    if (runTickets.length === 0) continue;
    const runWorkflowIds = implementationRunWorkflowIds(run, input.appReviewWorkflowRuns);
    const runThreads = input.threads.filter((thread) =>
      runWorkflowIds.has(thread.workflowContext?.workflowId ?? ""),
    );
    for (const ticket of runTickets) {
      counted.add(ticket.id);
      const state = run.ticketStates.find((candidate) => candidate.ticketId === ticket.id);
      const ticketThreads = runThreads.filter(
        (thread) => thread.workflowContext?.ticketScope.includes(ticket.id) === true,
      );
      statuses.push(
        resolveWorkflowTicketStatus({
          ticketState: state?.status ?? null,
          reviewOutcome: ticketReviewOutcome(state),
          threadStatuses: ticketThreads.map(resolveWorkflowThreadStatus),
          skipped: isTicketSkipped(run.skips, ticket.id),
          paused: workflowPauseOf(runThreads, ticketThreads).paused,
        }),
      );
    }
  }
  return statuses;
}

export type TicketProgressSegment =
  | "succeeded"
  | "skipped"
  | "running"
  | "awaiting"
  | "failed"
  | "paused"
  | "ready"
  | "waiting";

/** Stopping a ticket pauses it, so a stopped ticket counts as paused. */
export const TICKET_PROGRESS_SEGMENT_BY_STATUS: Record<WorkflowStepStatus, TicketProgressSegment> =
  {
    done: "succeeded",
    skipped: "skipped",
    running: "running",
    awaiting: "awaiting",
    blocked: "failed",
    failed: "failed",
    paused: "paused",
    stopped: "paused",
    pending: "ready",
    queued: "waiting",
  };

export function appReviewRunPresentation(run: AppReviewWorkflowRun | null): {
  readonly status: WorkflowThreadStatus;
  readonly label: string | null;
} {
  if (run === null) return { status: "completed", label: null };
  switch (run.status) {
    case "running":
      return { status: "working", label: "Running" };
    case "passed":
      return { status: "completed", label: "Passed" };
    case "failed":
      return { status: "failed", label: "Failed" };
    case "exhausted":
      return { status: "failed", label: "Exhausted" };
  }
} /**
 * Everything a workflow group's card derives from the run: its linked runs,
 * steps and their statuses, the live step, and the header's status and label.
 */
export function resolveWorkflowGroupState(props: {
  readonly group: WorkflowGroup<EnvironmentWorkflowThreadShell>;
  readonly groups: readonly WorkflowGroup<EnvironmentWorkflowThreadShell>[];
  readonly workflowRoot: EnvironmentWorkflowThreadShell;
  readonly currentPath: WorkflowCurrentPath | null;
  readonly appReviewWorkflowRuns: readonly AppReviewWorkflowRun[];
  readonly implementationRuns: readonly OrchestrationImplementationRun[];
  readonly spec: OrchestrationPlanningSpec | null;
  readonly tickets: readonly OrchestrationPlanningTicket[];
}) {
  const { group } = props;
  const linkedAppReviewRun =
    group.preset === "app-review"
      ? (props.appReviewWorkflowRuns.find((run) => run.id === group.sourceId) ?? null)
      : null;
  const runPresentation = appReviewRunPresentation(linkedAppReviewRun);
  const linkedImplementationRun = resolveGroupImplementationRun(
    group,
    props.groups,
    props.implementationRuns,
    { specId: props.spec?.id ?? null, rootThreadId: props.workflowRoot.id },
  );
  // Tickets belong to the run that is executing them. An unlinked run leaves
  // this empty, and the step falls back to listing its threads rather than
  // rendering an empty box under an expanded step.
  const ticketWaveTickets =
    linkedImplementationRun === null
      ? []
      : props.tickets.filter((ticket) =>
          linkedImplementationRun.planningTicketIds.includes(ticket.id),
        );
  const steps = buildWorkflowSteps(group, props.groups, props.workflowRoot, {
    flattenNestedWorkflows: group.parentGroupId === null,
  });
  // A pause on the workflow root stops the whole run, and the header's Resume
  // clears it. Scopes inside the run carry their own marks and their own
  // Resume; this one is only about the run as a whole.
  const workflowPaused = props.workflowRoot.workflowPausedAt != null;
  const linkedValidationKind =
    linkedImplementationRun && isLegacyFinalRegressionFailure(linkedImplementationRun)
      ? "final"
      : linkedImplementationRun?.activeValidationKind;
  const resumeStage =
    workflowPaused && linkedImplementationRun !== null
      ? implementationRunCurrentStage(linkedImplementationRun)
      : null;
  const resumeStep =
    resumeStage === null
      ? null
      : (steps.find((step) =>
          workflowStepMatchesImplementationFailure(step, resumeStage, linkedValidationKind),
        ) ?? null);
  const timeRange = resolveWorkflowGroupTimeRange(group, props.groups);
  // Feature's browser App Reviews are reviewer threads of the root, not App Review runs.
  const showsAppReviews =
    group.preset === "app-review" ||
    (group.parentGroupId === null &&
      (props.appReviewWorkflowRuns.length > 0 ||
        group.rows.some((row) => row.thread.workflowRole === "implementation-qa-reviewer")));
  const workflowThreads = [
    props.workflowRoot,
    ...props.groups.flatMap((candidate) => candidate.rows.map((row) => row.thread)),
  ];

  const automationHalt = linkedImplementationRun?.automationHalt ?? null;
  const canonicalExecutions =
    linkedImplementationRun === null
      ? linkedAppReviewRun?.phaseExecution === null ||
        linkedAppReviewRun?.phaseExecution === undefined
        ? []
        : [linkedAppReviewRun.phaseExecution]
      : [
          ...linkedImplementationRun.stageExecutions,
          ...linkedImplementationRun.ticketStates.flatMap((ticket) => ticket.stageExecutions),
          ...props.appReviewWorkflowRuns.flatMap((run) =>
            run.caller.type === "implementation" &&
            run.caller.implementationRunId === linkedImplementationRun.id &&
            run.phaseExecution !== null
              ? [run.phaseExecution]
              : [],
          ),
        ];
  const planningStage = props.workflowRoot.planningWorkflowSummary?.stage ?? null;
  // The stage the run is sitting at right now, which is what tells a step that
  // owns no agent of its own whether the run has reached it, passed it, or has
  // not got there yet.
  const currentImplementationStage =
    linkedImplementationRun === null
      ? null
      : implementationRunCurrentStage(linkedImplementationRun);
  const stepStatusById = new Map(
    steps.map((step) => {
      const planningProgress =
        workflowStepPhase(step) === "Planning" && planningStage !== null
          ? planningStepProgress(step, planningStage)
          : null;
      const runStage = skipRunStageForStep(step);
      const publicationProgress =
        linkedImplementationRun !== null &&
        (runStage === "change-request" || runStage === "change-request-babysit")
          ? implementationRunPublicationStageProgress(linkedImplementationRun, runStage)
          : null;
      const progress =
        planningProgress !== null
          ? (planningProgress.toLowerCase() as "completed" | "current" | "upcoming")
          : workflowStepLabel(step).toLowerCase().includes("final regression tests") &&
              linkedImplementationRun?.finalValidation?.status === "passed" &&
              linkedImplementationRun.validatedHeadSha !== null &&
              linkedImplementationRun.validatedHeadSha ===
                linkedImplementationRun.codeReviewedHeadSha
            ? ("completed" as const)
            : publicationProgress !== null
              ? publicationProgress
              : currentImplementationStage !== null &&
                  workflowStepMatchesImplementationFailure(
                    step,
                    currentImplementationStage,
                    linkedValidationKind,
                  )
                ? ("current" as const)
                : null;
      const stepThreads = collectStepThreads(step, props.workflowRoot.id);
      return [
        step.id,
        resolveWorkflowStepStatus({
          threadStatuses: stepThreads.map(resolveWorkflowThreadStatus),
          skipped:
            runStage !== null &&
            linkedImplementationRun !== null &&
            (isRunStageSkipped(linkedImplementationRun.skips, runStage) ||
              (runStage === "change-request-babysit" &&
                isRunStageSkipped(linkedImplementationRun.skips, "change-request"))),
          blocked:
            linkedImplementationRun?.status === "needs-human-attention" &&
            currentImplementationStage !== null &&
            workflowStepMatchesImplementationFailure(
              step,
              currentImplementationStage,
              linkedValidationKind,
            ),
          // A run-wide pause reads as paused only on the step it stopped at.
          // Marking every step paused would bury the one a resume re-enters.
          paused:
            workflowPauseOf(workflowThreads, stepThreads).paused ||
            (workflowPaused && progress === "current"),
          progress,
        }),
      ] as const;
    }),
  );
  const stepStatusOf = (
    step: WorkflowTimelineStep<EnvironmentWorkflowThreadShell>,
  ): WorkflowStepStatus => stepStatusById.get(step.id) ?? "pending";
  const groupStepStatus = resolveWorkflowStepRollup(steps.map(stepStatusOf));
  /** The step a collapsed row points at: whatever is holding the run up. */
  const liveStepOf = (
    candidates: readonly WorkflowTimelineStep<EnvironmentWorkflowThreadShell>[],
  ): WorkflowTimelineStep<EnvironmentWorkflowThreadShell> | null =>
    candidates.find((step) => stepStatusOf(step) === "blocked") ??
    candidates.find((step) => stepStatusOf(step) === "awaiting") ??
    candidates.find((step) => stepStatusOf(step) === "running") ??
    candidates.find((step) => stepStatusOf(step) === "paused") ??
    null;
  const currentStep = liveStepOf(steps);
  // The card's own color: a run that stopped for a human outranks everything,
  // then a pause on the whole workflow, then the most demanding step under it.
  const headerStatus: WorkflowStepStatus =
    linkedImplementationRun?.status === "needs-human-attention"
      ? "blocked"
      : workflowPaused
        ? "paused"
        : linkedAppReviewRun !== null
          ? threadStatusAsStepStatus(runPresentation.status)
          : resolveWorkflowHeaderStatus({
              currentPath: linkedImplementationRun === null ? null : props.currentPath,
              fallback:
                steps.length > 0 ? groupStepStatus : threadStatusAsStepStatus(groupStatus(group)),
            });
  const recoveredExistingThread =
    linkedImplementationRun !== null &&
    (linkedImplementationRun.finalCodeReviewLaunchCount > 1 ||
      (linkedImplementationRun.retryableFailure?.attemptCount ?? 0) > 1 ||
      linkedImplementationRun.ticketStates.some(
        (state) =>
          state.attemptCount > 1 ||
          state.appReviewLaunchCount > 1 ||
          state.codeReviewLaunchCount > 1,
      ));
  const completedWithWarnings =
    linkedImplementationRun?.status === "completed" &&
    (linkedImplementationRun.codeReviewExhaustedAt !== null ||
      linkedImplementationRun.appReviewExhaustedAt !== null ||
      linkedImplementationRun.ticketStates.some((state) => state.warningMarkdown !== null));
  const headerLabel =
    headerStatus === "blocked"
      ? "Needs attention"
      : completedWithWarnings
        ? "Completed with warnings"
        : linkedImplementationRun?.status === "completed"
          ? "Clean"
          : recoveredExistingThread && headerStatus === "running"
            ? "Resumed"
            : linkedAppReviewRun !== null && runPresentation.label !== null && !workflowPaused
              ? runPresentation.label
              : WORKFLOW_STEP_STATUS_LABELS[headerStatus];
  return {
    linkedAppReviewRun,
    runPresentation,
    linkedImplementationRun,
    ticketWaveTickets,
    steps,
    workflowPaused,
    linkedValidationKind,
    resumeStage,
    resumeStep,
    timeRange,
    showsAppReviews,
    workflowThreads,
    automationHalt,
    canonicalExecutions,
    planningStage,
    currentImplementationStage,
    stepStatusById,
    stepStatusOf,
    groupStepStatus,
    liveStepOf,
    currentStep,
    headerStatus,
    recoveredExistingThread,
    completedWithWarnings,
    headerLabel,
  };
}
