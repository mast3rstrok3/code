import type {
  AppReviewWorkflowRun,
  OrchestrationImplementationAutomationHalt,
  OrchestrationImplementationRun,
  OrchestrationImplementationRetryableFailure,
  OrchestrationImplementationRunStatus,
  OrchestrationPlanningTicket,
  OrchestrationPlanningWorkflowStage,
  OrchestrationSessionStatus,
  OrchestrationThreadWorkflowRole,
  WorkflowPreset,
} from "@t3tools/contracts";
import {
  WORKFLOW_PRESET_DEFINITION_BY_ID,
  type WorkflowPresetHelpStep,
  workflowPresetStepUsesRootThread,
} from "@t3tools/shared/workflowPresets";

export interface WorkflowModelThread {
  readonly environmentId: string;
  readonly id: string;
  readonly title?: string | undefined;
  readonly parentThreadId: string | null;
  readonly workflowRole: OrchestrationThreadWorkflowRole | null;
  readonly workflowContext?: {
    readonly workflowId: string;
    readonly parentWorkflowId?: string | null | undefined;
    readonly rootThreadId: string;
    readonly ticketScope?: readonly string[] | undefined;
  } | null;
  readonly workflowSubagentBatchProvenance?: {
    readonly batchId: string;
  } | null;
  readonly workflowPreset?: WorkflowPreset | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
  readonly settledAt: string | null;
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
  readonly backgroundLiveness?: "working" | "monitoring" | null | undefined;
  readonly latestTurn: {
    readonly state: "running" | "interrupted" | "completed" | "error";
    readonly requestedAt: string;
    readonly startedAt: string | null;
    readonly completedAt: string | null;
  } | null;
  readonly session: {
    readonly status: OrchestrationSessionStatus;
    readonly updatedAt: string;
  } | null;
}

export type WorkflowThreadStatus =
  | "working"
  | "monitoring"
  | "approval"
  | "input"
  | "completed"
  | "failed"
  | "stopped"
  | "archived";

export interface WorkflowTreeRow<TThread extends WorkflowModelThread> {
  readonly thread: TThread;
  readonly depth: number;
  readonly parentThreadKey: string | null;
}

export interface WorkflowGroup<TThread extends WorkflowModelThread> {
  readonly id: string;
  readonly kind: "workflow" | "batch" | "legacy";
  readonly sourceId: string;
  readonly parentGroupId: string | null;
  readonly depth: number;
  readonly createdAt: string;
  readonly preset: WorkflowPreset | null;
  readonly rows: readonly WorkflowTreeRow<TThread>[];
  readonly activeCount: number;
  readonly settledCount: number;
  readonly isActive: boolean;
}

export interface WorkflowRoot<TThread extends WorkflowModelThread> {
  readonly root: TThread;
  readonly members: readonly TThread[];
  readonly groups: readonly WorkflowGroup<TThread>[];
}

export type WorkflowTimelineEntry<TThread extends WorkflowModelThread> =
  | {
      readonly kind: "thread";
      readonly id: string;
      readonly createdAt: string;
      readonly row: WorkflowTreeRow<TThread>;
    }
  | {
      readonly kind: "workflow";
      readonly id: string;
      readonly createdAt: string;
      readonly group: WorkflowGroup<TThread>;
    };

export interface WorkflowTimelineStep<TThread extends WorkflowModelThread> {
  readonly id: string;
  readonly createdAt: string;
  readonly label: string | null;
  readonly skillId: string | null;
  readonly repeatsAsCycles: boolean;
  /**
   * True when the step's work happens in the workflow's main thread rather
   * than a thread of its own, which bounds what a per-step model pin can
   * change.
   */
  readonly usesRootThread: boolean;
  readonly entries: readonly WorkflowTimelineEntry<TThread>[];
}

export interface WorkflowTimeRange {
  readonly startedAt: string;
  readonly endedAt: string | null;
}

export function buildTicketWaves(
  tickets: readonly OrchestrationPlanningTicket[],
): readonly (readonly OrchestrationPlanningTicket[])[] {
  const remaining = new Map(tickets.map((ticket) => [ticket.id, ticket] as const));
  const waves: OrchestrationPlanningTicket[][] = [];
  while (remaining.size > 0) {
    const ready = [...remaining.values()]
      .filter((ticket) =>
        ticket.dependencies.every((dependency) => !remaining.has(dependency.ticketId)),
      )
      .toSorted((left, right) => left.ordinal - right.ordinal);
    const wave =
      ready.length > 0
        ? ready
        : [[...remaining.values()].toSorted((a, b) => a.ordinal - b.ordinal)[0]!];
    waves.push(wave);
    for (const ticket of wave) remaining.delete(ticket.id);
  }
  return waves;
}

/**
 * Whether a step owns the work an implementation run reports at `stage`.
 *
 * Matching is by label because a step is a presentation row, not a runtime
 * record. Guided presets prefix their labels with the phase ("Implementation
 * phase · Execute ticket waves") and name the same work differently from the
 * legacy presets ("TDD implementation workers"), so every arm has to accept
 * both vocabularies — a stage that matches no step silently loses its restart.
 */
export function workflowStepMatchesImplementationFailure<TThread extends WorkflowModelThread>(
  step: WorkflowTimelineStep<TThread>,
  stage: OrchestrationImplementationRetryableFailure["stage"],
): boolean {
  const label = step.label?.toLowerCase() ?? "";
  switch (stage) {
    case "source-dirty":
    case "worktree-setup":
      return (
        label.includes("create shared worktree") ||
        label.includes("prepare shared worktree") ||
        label.includes("load the selected spec") ||
        label.includes("load planning tickets") ||
        // Fast feature has no setup step: its Planning step creates the shared
        // worktree and starts the stack, so it owns both stages' restart.
        label === "planning"
      );
    case "worker-setup":
    case "worker-execution":
      return label.includes("tdd") || label.includes("build") || label.includes("ticket wave");
    case "integration":
    case "merge-gate":
      return label.includes("integrat") || label.includes("merge");
    case "app-dev-stack":
      return label.includes("appdevstack") || label === "planning";
    case "app-review":
      return label.includes("app review");
    case "code-review":
      return label.includes("code review");
    case "fixer":
      return label.includes("repair") || label.includes("tdd") || label.includes("ticket wave");
    case "build":
      return label.includes("build") || label.includes("tdd") || label.includes("ticket wave");
    case "change-request":
      return (
        label.includes("change request") ||
        label.includes("publish") ||
        label.includes("create pull request")
      );
    case "change-request-babysit":
      return label.includes("babysit pull request") || label.includes("green checks");
  }
}

/**
 * Whether the step can use the run's narrow retry command.
 *
 * The server ignores that command once a failure has moved past its retry
 * budget. Returning false then lets the panel use the stage re-run command
 * instead of showing an enabled button that does nothing.
 */
export function workflowStepCanRetryImplementationFailure<TThread extends WorkflowModelThread>(
  step: WorkflowTimelineStep<TThread>,
  run: {
    readonly status: OrchestrationImplementationRunStatus;
    readonly retryableFailure?: OrchestrationImplementationRetryableFailure | null | undefined;
  },
): boolean {
  const failure = run.retryableFailure;
  return (
    run.status === "needs-human-attention" &&
    failure != null &&
    failure.attemptCount < failure.maxAttempts &&
    workflowStepMatchesImplementationFailure(step, failure.stage)
  );
}

/**
 * What each stage of one ticket should report in the Workflows panel.
 *
 * A stage records an outcome only once it has one, so reading the outcome
 * alone describes a stage that is running right now as one that never began.
 * The ticket's own status is what distinguishes the two.
 */
export function implementationTicketStageDetails(
  state:
    | {
        readonly status: string;
        readonly workerResult?: { readonly status: string } | null | undefined;
        readonly appReviewOutcome?: string | null | undefined;
        readonly codeReviewOutcome?: string | null | undefined;
      }
    | undefined,
  ticket: { readonly appReviewEligible?: boolean | undefined },
): {
  readonly implementation: string;
  readonly appReview: string;
  readonly codeReview: string;
} {
  return {
    implementation:
      state?.workerResult?.status ??
      (state?.status === "running" ? "running" : (state?.status ?? "not started")),
    appReview:
      state?.appReviewOutcome === "skipped"
        ? "skipped — not planned for browser review"
        : (state?.appReviewOutcome ??
          (state?.status === "app-reviewing"
            ? "in review"
            : ticket.appReviewEligible === true
              ? "eligible"
              : "not planned")),
    codeReview:
      state?.codeReviewOutcome ??
      (state?.status === "code-reviewing" ? "in review" : "not started"),
  };
}

/**
 * The stage an implementation run is sitting at right now.
 *
 * A paused or stalled run reports no `retryableFailure`, so this is what tells
 * the panel which step a resume would actually re-enter — the difference
 * between one honest "Start step again" and the same button on every row.
 * Ticket-level App Review and Code Review report as worker execution because
 * the ticket-wave step owns them.
 */
export function implementationRunCurrentStage(run: {
  readonly status: OrchestrationImplementationRunStatus;
  readonly retryableFailure?: OrchestrationImplementationRetryableFailure | null | undefined;
  readonly automationHalt?: OrchestrationImplementationAutomationHalt | null | undefined;
}): OrchestrationImplementationRetryableFailure["stage"] | null {
  switch (run.status) {
    case "needs-human-attention":
      if (run.retryableFailure?.stage !== undefined) return run.retryableFailure.stage;
      switch (run.automationHalt?.stage) {
        case "app-review":
          return "app-review";
        case "code-review":
        case "final-code-review":
          return "code-review";
        case "integration":
          return "integration";
        case "implementation":
          return "worker-execution";
        default:
          return null;
      }
    case "launch-pending":
      return "worktree-setup";
    case "running":
      return "worker-execution";
    case "integrating":
      return "integration";
    case "validating":
      return "merge-gate";
    case "qa-reviewing":
      return "app-review";
    case "fixing":
      return "fixer";
    case "code-reviewing":
    case "code-review-fixing":
      return "code-review";
    case "publishing-change-request":
      return "change-request";
    case "babysitting-change-request":
      return "change-request-babysit";
    case "completed":
    case "canceled":
      return null;
  }
}

/** Progress for publication steps that cannot rely on an owned agent thread. */
export function implementationRunPublicationStageProgress(
  run: {
    readonly status: OrchestrationImplementationRunStatus;
    readonly changeRequest: unknown | null;
    readonly retryableFailure?: OrchestrationImplementationRetryableFailure | null | undefined;
  },
  stage: "change-request" | "change-request-babysit",
): "completed" | "current" | "upcoming" {
  if (stage === "change-request" && run.changeRequest !== null) return "completed";
  if (
    stage === "change-request-babysit" &&
    run.status === "completed" &&
    run.changeRequest !== null
  ) {
    return "completed";
  }
  return implementationRunCurrentStage(run) === stage ? "current" : "upcoming";
}

export interface WorkflowViewModel<TThread extends WorkflowModelThread> {
  readonly ownerThreadKeyByThreadKey: ReadonlyMap<string, string>;
  readonly rootsByThreadKey: ReadonlyMap<string, WorkflowRoot<TThread>>;
  readonly topLevelThreads: readonly TThread[];
}

export function workflowThreadKey(thread: Pick<WorkflowModelThread, "environmentId" | "id">) {
  return `${thread.environmentId}:${thread.id}`;
}

function timestampMs(value: string): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function buildWorkflowTimeline<TThread extends WorkflowModelThread>(
  group: WorkflowGroup<TThread>,
  groups: readonly WorkflowGroup<TThread>[],
  options?: { readonly flattenNestedWorkflows?: boolean },
): readonly WorkflowTimelineEntry<TThread>[] {
  const childGroups = groups.filter((candidate) => candidate.parentGroupId === group.id);
  const nestedEntries = options?.flattenNestedWorkflows
    ? childGroups.flatMap((child) => buildWorkflowTimeline(child, groups, options))
    : childGroups.map(
        (child): WorkflowTimelineEntry<TThread> => ({
          kind: "workflow",
          id: child.id,
          createdAt: child.createdAt,
          group: child,
        }),
      );
  return [
    ...group.rows.map(
      (row): WorkflowTimelineEntry<TThread> => ({
        kind: "thread",
        id: workflowThreadKey(row.thread),
        createdAt: row.thread.createdAt,
        row,
      }),
    ),
    ...nestedEntries,
  ].toSorted(
    (left, right) =>
      timestampMs(left.createdAt) - timestampMs(right.createdAt) || left.id.localeCompare(right.id),
  );
}

function workflowStepIdentity<TThread extends WorkflowModelThread>(
  entry: WorkflowTimelineEntry<TThread>,
): string {
  if (entry.kind === "workflow") {
    return `workflow:${entry.group.preset ?? entry.group.id}`;
  }
  return `role:${entry.row.thread.workflowRole ?? "workflow-child"}`;
}

/** The skill a preset names when it gives the run's coordinator a step of its own. */
const IMPLEMENTATION_COORDINATOR_SKILL_ID = "implementation.orchestrator-planning.codex";

function entrySkillIds<TThread extends WorkflowModelThread>(
  entry: WorkflowTimelineEntry<TThread>,
): ReadonlySet<string> {
  if (entry.kind === "workflow") {
    return entry.group.preset === "app-review"
      ? new Set(["implementation.browser-app-review.codex"])
      : new Set();
  }
  switch (entry.row.thread.workflowRole) {
    case "planning-orchestrator":
      return new Set([
        "planning.engineering-grill-automatic.codex",
        "planning.grill-stage.codex",
        "planning.spec.codex",
        "planning.tickets.codex",
        "planning.wayfinder.codex",
        "planning.research.codex",
        "planning.prototype.codex",
      ]);
    case "planning-reviewer":
      return new Set(["planning.ticket-reviewer.codex"]);
    case "implementation-orchestrator":
      return new Set([IMPLEMENTATION_COORDINATOR_SKILL_ID]);
    case "implementation-worker":
    case "implementation-fixer":
    case "product-fix-implementer":
    case "fast-feature-implementer":
      return new Set(["implementation.tdd.codex"]);
    case "app-review-fixer":
      return new Set(["matt-pocock.implement"]);
    case "app-review-planner":
      return new Set(["matt-pocock.to-tickets"]);
    case "implementation-validator":
      return new Set(["implementation.merge-gate.codex"]);
    case "implementation-qa-reviewer":
    case "app-review-reviewer":
    case "app-review-orchestrator":
      return new Set(["implementation.browser-app-review.codex"]);
    case "implementation-code-reviewer":
      return new Set(["implementation.code-review.codex"]);
    case "implementation-change-request-babysitter":
      return new Set(["implementation.change-request-babysitter.codex"]);
    case null:
      return new Set();
  }
}

function entryMatchesDefinedStep<TThread extends WorkflowModelThread>(
  entry: WorkflowTimelineEntry<TThread>,
  step: WorkflowPresetHelpStep,
  options: { readonly coordinatorHasStep: boolean },
): boolean {
  if (entry.kind === "workflow") return false;
  const role = entry.row.thread.workflowRole;
  const label = step.label.toLowerCase();
  if (label.includes("execute ticket waves")) {
    // The run's coordinator opens the implementation phase and stays alive for
    // the rest of it, so it describes no single step. Presets that give it a
    // step of its own keep it there; the ones without land it on the step that
    // starts the phase, which is the work its own turn does.
    if (role === "implementation-orchestrator") return !options.coordinatorHasStep;
    return (
      entry.row.thread.workflowContext?.ticketScope?.length === 1 &&
      (role === "implementation-worker" ||
        role === "implementation-code-reviewer" ||
        role === "app-review-orchestrator" ||
        role === "app-review-reviewer" ||
        role === "app-review-planner" ||
        role === "app-review-fixer")
    );
  }
  if (label.includes("merge ticket branches")) {
    return (
      role === "implementation-validator" &&
      !entry.row.thread.title?.toLowerCase().includes("final validation")
    );
  }
  if (label.includes("app review") && !label.includes("ticket")) {
    return (
      (role === "app-review-orchestrator" ||
        role === "app-review-reviewer" ||
        role === "app-review-planner" ||
        role === "app-review-fixer" ||
        role === "implementation-qa-reviewer" ||
        role === "implementation-fixer") &&
      entry.row.thread.workflowContext?.ticketScope?.length !== 1
    );
  }
  if (label.includes("final code review")) {
    // Deliberately not the run's coordinator: it exists from the first ticket
    // wave onward and reads as settled whenever it is idle, which called the
    // final review done before it had started.
    return (
      (role === "implementation-code-reviewer" &&
        entry.row.thread.workflowContext?.ticketScope?.length !== 1) ||
      (role === "implementation-validator" &&
        entry.row.thread.title?.toLowerCase().includes("final validation") === true)
    );
  }
  if (step.skillId !== undefined && entrySkillIds(entry).has(step.skillId)) return true;
  if (label.includes("start and probe appdevstack")) {
    return role === "implementation-orchestrator" || role === "fast-feature-implementer";
  }
  if (label.includes("change request") || label.includes("publish")) {
    return role === "implementation-orchestrator" || role === "fast-feature-implementer";
  }
  if (label.includes("cli plan")) return role === "fast-feature-implementer";
  return false;
}

function definedStepRepeatsAsCycles(step: WorkflowPresetHelpStep): boolean {
  const label = step.label.toLowerCase();
  return (
    step.skillId === "implementation.browser-app-review.codex" ||
    step.skillId === "implementation.code-review.codex" ||
    step.skillId === "planning.ticket-reviewer.codex" ||
    label.includes("cycle")
  );
}

function fallbackStepRepeatsAsCycles<TThread extends WorkflowModelThread>(
  entries: readonly WorkflowTimelineEntry<TThread>[],
): boolean {
  if (entries.length < 2) return false;
  if (entries.every((entry) => entry.kind === "workflow")) return true;
  return entries.every(
    (entry) =>
      entry.kind === "thread" &&
      (entry.row.thread.workflowRole === "planning-reviewer" ||
        entry.row.thread.workflowRole === "implementation-qa-reviewer" ||
        entry.row.thread.workflowRole === "implementation-fixer" ||
        entry.row.thread.workflowRole === "app-review-reviewer" ||
        entry.row.thread.workflowRole === "app-review-fixer"),
  );
}

/** The parts of an implementation run needed to link it to a workflow group. */
export interface WorkflowModelImplementationRun {
  readonly id: string;
  readonly specId: string | null;
  readonly sourceProposedPlan?: { readonly threadId: string } | null | undefined;
  readonly orchestratorThreadId: string;
  readonly appReviewWorkflowRunIds: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

function newestImplementationRun<TRun extends WorkflowModelImplementationRun>(
  runs: readonly TRun[],
): TRun | null {
  return (
    runs.toSorted(
      (left, right) =>
        right.createdAt.localeCompare(left.createdAt) ||
        right.updatedAt.localeCompare(left.updatedAt) ||
        right.id.localeCompare(left.id),
    )[0] ?? null
  );
}

/**
 * The implementation run whose progress a group's card reports.
 *
 * A top-level card flattens its nested workflow groups into its own steps, so
 * the run that owns a descendant group owns that card's implementation steps
 * too. Matching only the card's own rows misses it, because implementation
 * threads carry the run id as their workflow id and land in a nested group.
 *
 * When nothing links — a run whose threads do not exist yet — a planning card
 * falls back to the newest run built from the same spec or proposed plan. It
 * never borrows a run from another workflow, whose tickets and retries belong
 * to a different card.
 */
export function resolveGroupImplementationRun<
  TThread extends WorkflowModelThread,
  TRun extends WorkflowModelImplementationRun,
>(
  group: WorkflowGroup<TThread>,
  groups: readonly WorkflowGroup<TThread>[],
  runs: readonly TRun[],
  scope: { readonly specId: string | null; readonly rootThreadId: string },
): TRun | null {
  const linkedGroups =
    group.parentGroupId === null ? [group, ...descendantGroups(group, groups)] : [group];
  const directlyLinked = runs.filter((run) =>
    linkedGroups.some(
      (candidate) =>
        run.id === candidate.sourceId ||
        run.appReviewWorkflowRunIds.some((runId) => runId === candidate.sourceId) ||
        candidate.rows.some((row) => row.thread.id === run.orchestratorThreadId),
    ),
  );
  if (group.preset !== "planning" && group.preset !== "fast-engineering") {
    return newestImplementationRun(directlyLinked);
  }
  const scopedRuns = runs.filter(
    (run) =>
      (scope.specId !== null && run.specId === scope.specId) ||
      run.sourceProposedPlan?.threadId === scope.rootThreadId,
  );
  if (group.parentGroupId !== null) return newestImplementationRun(directlyLinked);
  return newestImplementationRun([...new Set([...directlyLinked, ...scopedRuns])]);
}

export interface WorkflowCurrentPath {
  readonly groupId: string;
  readonly status: "blocked" | "awaiting" | "running" | "paused" | "upcoming" | "done";
  readonly phase: string;
  readonly stepId: string | null;
  readonly stepLabel: string;
  readonly waveIndex: number | null;
  readonly ticketId: string | null;
  readonly ticketLabel: string | null;
  readonly ticketStage: "implementation" | "app-review" | "code-review" | null;
  readonly appReviewRunId: string | null;
  readonly cycleNumber: number | null;
  readonly cycleBudget: number | null;
  readonly appReviewPhase: "review" | "planning" | "fixing" | null;
  readonly threadId: string | null;
  readonly activeTicketCount: number;
  readonly subtitle: string;
}

/** The deepest durable row the Interaction Modes chip can reveal. */
export function workflowCurrentPathScrollTarget(path: WorkflowCurrentPath): string | null {
  if (path.threadId !== null) return path.threadId;
  if (
    path.appReviewRunId !== null &&
    path.cycleNumber !== null &&
    path.ticketStage === "app-review"
  ) {
    return `app-review-cycle:${path.appReviewRunId}:${path.cycleNumber}`;
  }
  if (path.ticketId !== null && path.cycleNumber !== null && path.ticketStage === "code-review") {
    return `ticket-code-review:${path.ticketId}:${path.cycleNumber}`;
  }
  return path.ticketId;
}

const currentPathStep = <TThread extends WorkflowModelThread>(
  steps: readonly WorkflowTimelineStep<TThread>[],
  predicate: (label: string) => boolean,
) => steps.find((step) => predicate((step.label ?? "").toLowerCase())) ?? null;

/**
 * Resolve the durable workflow location that a chip and card should reveal.
 *
 * Ticket state wins over a missing or stale worker session. Among concurrent
 * tickets, a human block wins, then input, running work, a pause, and upcoming
 * work. Wave and ticket order break ties.
 */
export function resolveWorkflowCurrentPath<TThread extends WorkflowModelThread>(input: {
  readonly groupId: string;
  readonly workflowLabel: string;
  readonly steps: readonly WorkflowTimelineStep<TThread>[];
  readonly run: OrchestrationImplementationRun | null;
  readonly appReviewWorkflowRuns: readonly AppReviewWorkflowRun[];
  readonly tickets: readonly OrchestrationPlanningTicket[];
  readonly threads: readonly TThread[];
  readonly planningStage?: OrchestrationPlanningWorkflowStage | null | undefined;
  readonly workflowPaused: boolean;
  readonly ticketCodeReviewBudget: number;
  readonly finalCodeReviewBudget: number;
}): WorkflowCurrentPath {
  const run = input.run;
  if (run !== null) {
    const ticketById = new Map(input.tickets.map((ticket) => [ticket.id, ticket] as const));
    const waves = buildTicketWaves(
      input.tickets.filter((ticket) => run.planningTicketIds.includes(ticket.id)),
    );
    const order = new Map<string, { readonly waveIndex: number; readonly ordinal: number }>();
    waves.forEach((wave, waveIndex) =>
      wave.forEach((ticket) => order.set(ticket.id, { waveIndex, ordinal: ticket.ordinal })),
    );
    const threadPriority = (ticketId: string) => {
      const threads = input.threads.filter((thread) =>
        thread.workflowContext?.ticketScope?.includes(ticketId),
      );
      if (threads.some((thread) => thread.hasPendingApprovals || thread.hasPendingUserInput)) {
        return 1;
      }
      return 9;
    };
    const ticketPriority = (state: OrchestrationImplementationRun["ticketStates"][number]) => {
      if (run.automationHalt?.ticketId === state.ticketId || state.status === "failed") return 0;
      const pendingPriority = threadPriority(state.ticketId);
      if (pendingPriority < 9) return pendingPriority;
      if (
        state.status === "running" ||
        state.status === "app-reviewing" ||
        state.status === "code-reviewing"
      )
        return 2;
      if (input.workflowPaused && state.status !== "succeeded") return 3;
      if (state.status === "ready" || state.status === "blocked") return 4;
      return 9;
    };
    const focusedState = run.ticketStates
      .filter((state) => ticketPriority(state) < 9)
      .toSorted((left, right) => {
        const priority = ticketPriority(left) - ticketPriority(right);
        if (priority !== 0) return priority;
        const leftOrder = order.get(left.ticketId) ?? { waveIndex: Number.MAX_VALUE, ordinal: 0 };
        const rightOrder = order.get(right.ticketId) ?? { waveIndex: Number.MAX_VALUE, ordinal: 0 };
        return (
          leftOrder.waveIndex - rightOrder.waveIndex ||
          leftOrder.ordinal - rightOrder.ordinal ||
          left.ticketId.localeCompare(right.ticketId)
        );
      })[0];
    const activeTicketCount = run.ticketStates.filter(
      (state) =>
        state.status === "running" ||
        state.status === "app-reviewing" ||
        state.status === "code-reviewing",
    ).length;
    if (focusedState !== undefined) {
      const ticket = ticketById.get(focusedState.ticketId);
      const ticketLabel = ticket?.key ?? `Ticket ${(ticket?.ordinal ?? 0) + 1}`;
      const waveIndex = order.get(focusedState.ticketId)?.waveIndex ?? 0;
      const priority = ticketPriority(focusedState);
      const status =
        priority === 0
          ? "blocked"
          : priority === 1
            ? "awaiting"
            : priority === 2
              ? "running"
              : priority === 3
                ? "paused"
                : "upcoming";
      const haltedStage =
        run.automationHalt?.ticketId === focusedState.ticketId ? run.automationHalt.stage : null;
      const ticketStage =
        focusedState.status === "app-reviewing" || haltedStage === "app-review"
          ? ("app-review" as const)
          : focusedState.status === "code-reviewing" ||
              haltedStage === "code-review" ||
              haltedStage === "final-code-review"
            ? ("code-review" as const)
            : ("implementation" as const);
      const appReviewRun =
        ticketStage === "app-review"
          ? (input.appReviewWorkflowRuns.find(
              (candidate) => candidate.id === focusedState.appReviewWorkflowRunId,
            ) ?? null)
          : null;
      const appReviewCycle = appReviewRun?.cycles.at(-1) ?? null;
      const cycleNumber =
        ticketStage === "app-review"
          ? (appReviewCycle?.cycleNumber ??
            (Math.min(appReviewRun?.cyclesUsed ?? 0, appReviewRun?.cycleBudget ?? 1) || 1))
          : ticketStage === "code-review"
            ? Math.min(focusedState.codeReviewPassCount + 1, input.ticketCodeReviewBudget)
            : null;
      const cycleBudget =
        ticketStage === "app-review"
          ? (appReviewRun?.cycleBudget ?? null)
          : ticketStage === "code-review"
            ? input.ticketCodeReviewBudget
            : null;
      const appReviewPhase = appReviewRun?.activePhase ?? null;
      const phaseLabel =
        appReviewPhase === "review"
          ? "E2E and browser review"
          : appReviewPhase === "planning"
            ? "Gap analysis"
            : appReviewPhase === "fixing"
              ? "TDD repair"
              : null;
      const segments = [
        input.workflowLabel,
        "Execute ticket waves",
        activeTicketCount > 1 ? `${activeTicketCount} active` : null,
        ticketLabel,
        ticketStage === "implementation"
          ? "Implementation"
          : ticketStage === "app-review"
            ? "App Review"
            : "Code Review",
        cycleNumber === null ? null : `Cycle ${cycleNumber}`,
        phaseLabel,
      ].filter((segment): segment is string => segment !== null);
      const ticketStep = currentPathStep(input.steps, (label) => label.includes("ticket wave"));
      return {
        groupId: input.groupId,
        status,
        phase: "Implementation",
        stepId: ticketStep?.id ?? null,
        stepLabel: ticketStep?.label ?? "Execute ticket waves",
        waveIndex,
        ticketId: focusedState.ticketId,
        ticketLabel,
        ticketStage,
        appReviewRunId: appReviewRun?.id ?? null,
        cycleNumber,
        cycleBudget,
        appReviewPhase,
        threadId:
          ticketStage === "implementation"
            ? focusedState.workerThreadId
            : ticketStage === "app-review"
              ? (appReviewRun?.activeThreadId ?? null)
              : (focusedState.codeReviewThreadId ?? null),
        activeTicketCount,
        subtitle: segments.join(" · "),
      };
    }

    const stage = implementationRunCurrentStage(run);
    const finalValidation = run.status === "validating" && run.activeValidationKind === "final";
    const step = finalValidation
      ? (currentPathStep(input.steps, (label) => label.includes("final code review")) ??
        currentPathStep(input.steps, (label) => label.includes("code review")))
      : stage === "app-review"
        ? currentPathStep(input.steps, (label) => label.includes("app review"))
        : stage === "code-review"
          ? (currentPathStep(input.steps, (label) => label.includes("final code review")) ??
            currentPathStep(input.steps, (label) => label.includes("code review")))
          : stage === "change-request" || stage === "change-request-babysit"
            ? currentPathStep(input.steps, (label) =>
                stage === "change-request-babysit"
                  ? label.includes("babysit")
                  : label.includes("pull request") || label.includes("publication"),
              )
            : currentPathStep(input.steps, (label) =>
                stage === "merge-gate" || stage === "integration"
                  ? label.includes("merge") || label.includes("integrat")
                  : label.includes("implementation"),
              );
    const finalCodeReview = stage === "code-review" && !finalValidation;
    const combinedAppReview =
      stage === "app-review"
        ? (input.appReviewWorkflowRuns
            .filter(
              (candidate) =>
                candidate.caller.type === "implementation" &&
                candidate.caller.implementationRunId === run.id &&
                candidate.caller.ticketId === undefined,
            )
            .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] ?? null)
        : null;
    const combinedAppReviewCycle = combinedAppReview?.cycles.at(-1) ?? null;
    const cycleNumber = finalCodeReview
      ? Math.min(run.finalCodeReviewPassCount + 1, input.finalCodeReviewBudget)
      : (combinedAppReviewCycle?.cycleNumber ?? null);
    const appReviewPhase = combinedAppReview?.activePhase ?? null;
    const appReviewPhaseLabel =
      appReviewPhase === "review"
        ? "E2E and browser review"
        : appReviewPhase === "planning"
          ? "Gap analysis"
          : appReviewPhase === "fixing"
            ? "TDD repair"
            : null;
    const status =
      run.status === "needs-human-attention"
        ? "blocked"
        : input.workflowPaused
          ? "paused"
          : run.status === "completed"
            ? "done"
            : "running";
    const segments = [
      input.workflowLabel,
      finalValidation
        ? "Final validation"
        : (step?.label ?? stage?.replaceAll("-", " ") ?? "Complete"),
      cycleNumber === null ? null : `Cycle ${cycleNumber}`,
      appReviewPhaseLabel,
    ].filter((segment): segment is string => segment !== null);
    return {
      groupId: input.groupId,
      status,
      phase: finalCodeReview || finalValidation ? "Code Review" : "Implementation",
      stepId: step?.id ?? null,
      stepLabel: step?.label ?? "Workflow",
      waveIndex: null,
      ticketId: null,
      ticketLabel: null,
      ticketStage: null,
      appReviewRunId: combinedAppReview?.id ?? null,
      cycleNumber,
      cycleBudget: finalCodeReview
        ? input.finalCodeReviewBudget
        : (combinedAppReview?.cycleBudget ?? null),
      appReviewPhase,
      threadId:
        run.activeCodeReviewThreadId ??
        combinedAppReview?.activeThreadId ??
        run.activeAppReviewThreadId ??
        run.activeValidatorThreadId ??
        run.activeChangeRequestBabysitterThreadId,
      activeTicketCount,
      subtitle: segments.join(" · "),
    };
  }

  const planningNeedle =
    input.planningStage === "grill"
      ? "grill"
      : input.planningStage === "spec-authoring"
        ? "spec authoring"
        : input.planningStage === "tickets-authoring"
          ? "ticket authoring"
          : input.planningStage === "ticket-review" || input.planningStage === "ticket-revision"
            ? "ticket review"
            : null;
  const planningStep =
    (planningNeedle === null
      ? null
      : currentPathStep(input.steps, (label) => label.includes(planningNeedle))) ??
    input.steps.find((step) => step.entries.length > 0) ??
    input.steps[0] ??
    null;
  const hasPendingUserAction = input.threads.some(
    (thread) => thread.hasPendingApprovals || thread.hasPendingUserInput,
  );
  const status =
    input.planningStage === "needs-human-attention"
      ? "blocked"
      : hasPendingUserAction
        ? "awaiting"
        : input.workflowPaused
          ? "paused"
          : input.planningStage === "completed"
            ? "done"
            : planningStep === null
              ? "upcoming"
              : "running";
  return {
    groupId: input.groupId,
    status,
    phase: "Planning",
    stepId: planningStep?.id ?? null,
    stepLabel: planningStep?.label ?? "Planning",
    waveIndex: null,
    ticketId: null,
    ticketLabel: null,
    ticketStage: null,
    appReviewRunId: null,
    cycleNumber: null,
    cycleBudget: null,
    appReviewPhase: null,
    threadId: input.threads[0]?.id ?? null,
    activeTicketCount: 0,
    subtitle: [input.workflowLabel, planningStep?.label ?? "Planning"].join(" · "),
  };
}

function descendantGroups<TThread extends WorkflowModelThread>(
  group: WorkflowGroup<TThread>,
  groups: readonly WorkflowGroup<TThread>[],
): readonly WorkflowGroup<TThread>[] {
  const children = groups.filter((candidate) => candidate.parentGroupId === group.id);
  return [...children, ...children.flatMap((child) => descendantGroups(child, groups))];
}

/**
 * Render the canonical steps users see in Settings → Workflows. Runtime threads
 * attach to those definitions; a fresh thread for a repeated review or repair
 * remains another cycle of the same step. Historical workflows without defined
 * steps retain role-based grouping as a fallback.
 */
export function buildWorkflowSteps<TThread extends WorkflowModelThread>(
  group: WorkflowGroup<TThread>,
  groups: readonly WorkflowGroup<TThread>[],
  rootThread?: TThread,
  options?: { readonly flattenNestedWorkflows?: boolean },
): readonly WorkflowTimelineStep<TThread>[] {
  const timeline = buildWorkflowTimeline(group, groups, options);
  const definedSteps =
    group.preset === null ? [] : WORKFLOW_PRESET_DEFINITION_BY_ID[group.preset].helpSteps;
  if (definedSteps.length > 0) {
    const coordinatorHasStep = definedSteps.some(
      (definition) => definition.skillId === IMPLEMENTATION_COORDINATOR_SKILL_ID,
    );
    const matchedEntryIds = new Set<string>();
    const steps = definedSteps.map((definition, index): WorkflowTimelineStep<TThread> => {
      const matchedEntries = timeline.filter((entry) =>
        entryMatchesDefinedStep(entry, definition, { coordinatorHasStep }),
      );
      for (const entry of matchedEntries) matchedEntryIds.add(entry.id);
      const usesRootThread =
        group.preset !== null && workflowPresetStepUsesRootThread(group.preset, definition);
      const entries =
        rootThread !== undefined && usesRootThread
          ? [
              {
                kind: "thread" as const,
                id: workflowThreadKey(rootThread),
                createdAt: rootThread.createdAt,
                row: { thread: rootThread, depth: 0, parentThreadKey: null },
              },
              ...matchedEntries,
            ]
          : matchedEntries;
      return {
        id: `defined:${group.id}:${String(index)}`,
        createdAt: entries[0]?.createdAt ?? group.createdAt,
        label: definition.label,
        skillId: definition.skillId ?? null,
        repeatsAsCycles: definedStepRepeatsAsCycles(definition),
        usesRootThread,
        entries,
      };
    });
    const unmatched = timeline.filter((entry) => !matchedEntryIds.has(entry.id));
    if (unmatched.length === 0) return steps;
    return [...steps, ...buildFallbackWorkflowSteps(unmatched)];
  }
  return buildFallbackWorkflowSteps(timeline);
}

function buildFallbackWorkflowSteps<TThread extends WorkflowModelThread>(
  timeline: readonly WorkflowTimelineEntry<TThread>[],
): readonly WorkflowTimelineStep<TThread>[] {
  const steps: WorkflowTimelineStep<TThread>[] = [];
  const stepIndexByIdentity = new Map<string, number>();
  for (const entry of timeline) {
    const identity = workflowStepIdentity(entry);
    const existingIndex = stepIndexByIdentity.get(identity);
    if (existingIndex !== undefined) {
      const existing = steps[existingIndex]!;
      const entries = [...existing.entries, entry];
      steps[existingIndex] = {
        ...existing,
        entries,
        repeatsAsCycles: fallbackStepRepeatsAsCycles(entries),
      };
      continue;
    }
    stepIndexByIdentity.set(identity, steps.length);
    steps.push({
      id: `${identity}:${entry.id}`,
      createdAt: entry.createdAt,
      label: null,
      skillId: null,
      repeatsAsCycles: false,
      usesRootThread: false,
      entries: [entry],
    });
  }
  return steps;
}

export function resolveWorkflowThreadTimeRange(thread: WorkflowModelThread): WorkflowTimeRange {
  if (workflowStatusIsActive(resolveWorkflowThreadStatus(thread))) {
    return { startedAt: thread.createdAt, endedAt: null };
  }
  return {
    startedAt: thread.createdAt,
    endedAt:
      thread.settledAt ??
      thread.latestTurn?.completedAt ??
      thread.archivedAt ??
      thread.session?.updatedAt ??
      thread.updatedAt,
  };
}

export function resolveWorkflowGroupTimeRange<TThread extends WorkflowModelThread>(
  group: WorkflowGroup<TThread>,
  groups: readonly WorkflowGroup<TThread>[],
): WorkflowTimeRange {
  const childrenByParentId = new Map<string, WorkflowGroup<TThread>[]>();
  for (const candidate of groups) {
    if (candidate.parentGroupId === null) continue;
    const children = childrenByParentId.get(candidate.parentGroupId);
    if (children) children.push(candidate);
    else childrenByParentId.set(candidate.parentGroupId, [candidate]);
  }
  const ranges: WorkflowTimeRange[] = [];
  const visited = new Set<string>();
  const collect = (candidate: WorkflowGroup<TThread>) => {
    if (visited.has(candidate.id)) return;
    visited.add(candidate.id);
    ranges.push(...candidate.rows.map((row) => resolveWorkflowThreadTimeRange(row.thread)));
    for (const child of childrenByParentId.get(candidate.id) ?? []) collect(child);
  };
  collect(group);

  const startedAt = ranges.reduce(
    (earliest, range) =>
      timestampMs(range.startedAt) < timestampMs(earliest) ? range.startedAt : earliest,
    group.createdAt,
  );
  if (ranges.some((range) => range.endedAt === null)) return { startedAt, endedAt: null };
  const endedAt = ranges.reduce<string>((latest, range) => {
    const candidate = range.endedAt ?? range.startedAt;
    return timestampMs(candidate) > timestampMs(latest) ? candidate : latest;
  }, startedAt);
  return { startedAt, endedAt };
}

export function resolveWorkflowStepTimeRange<TThread extends WorkflowModelThread>(
  step: WorkflowTimelineStep<TThread>,
  groups: readonly WorkflowGroup<TThread>[],
): WorkflowTimeRange {
  const ranges = step.entries.map((entry) =>
    entry.kind === "thread"
      ? resolveWorkflowThreadTimeRange(entry.row.thread)
      : resolveWorkflowGroupTimeRange(entry.group, groups),
  );
  const startedAt = ranges.reduce(
    (earliest, range) =>
      timestampMs(range.startedAt) < timestampMs(earliest) ? range.startedAt : earliest,
    step.createdAt,
  );
  if (ranges.some((range) => range.endedAt === null)) return { startedAt, endedAt: null };
  return {
    startedAt,
    endedAt: ranges.reduce<string>((latest, range) => {
      const candidate = range.endedAt ?? range.startedAt;
      return timestampMs(candidate) > timestampMs(latest) ? candidate : latest;
    }, startedAt),
  };
}

export function resolveWorkflowThreadStatus(thread: WorkflowModelThread): WorkflowThreadStatus {
  if (thread.archivedAt !== null) return "archived";
  if (thread.hasPendingApprovals) return "approval";
  if (thread.hasPendingUserInput) return "input";
  if (thread.session?.status === "running" || thread.session?.status === "starting") {
    return "working";
  }
  if (thread.session?.status === "error" || thread.latestTurn?.state === "error") return "failed";
  if (thread.backgroundLiveness === "working") return "working";
  if (thread.backgroundLiveness === "monitoring") return "monitoring";
  if (
    thread.session?.status === "interrupted" ||
    thread.session?.status === "stopped" ||
    thread.latestTurn?.state === "interrupted"
  ) {
    return "stopped";
  }
  return "completed";
}

export function workflowStatusIsActive(status: WorkflowThreadStatus): boolean {
  return (
    status === "working" || status === "monitoring" || status === "approval" || status === "input"
  );
}

const WORKFLOW_STATUS_PRIORITY: Record<WorkflowThreadStatus, number> = {
  approval: 8,
  input: 7,
  working: 6,
  monitoring: 5,
  failed: 4,
  stopped: 3,
  completed: 2,
  archived: 1,
};

export function resolveWorkflowRollupStatus(
  threads: readonly WorkflowModelThread[],
): WorkflowThreadStatus | null {
  let highest: WorkflowThreadStatus | null = null;
  for (const thread of threads) {
    const status = resolveWorkflowThreadStatus(thread);
    if (highest === null || WORKFLOW_STATUS_PRIORITY[status] > WORKFLOW_STATUS_PRIORITY[highest]) {
      highest = status;
    }
  }
  return highest;
}

/**
 * What one row of the Workflows panel is doing, as the panel colors it.
 *
 * Wider than a thread's own status because a row is not always a thread. A
 * step can be skipped, paused, waiting on the step before it, or sitting at a
 * stage that has not started an agent yet, and those read very differently to
 * someone scanning the panel for the thing to act on.
 */
export type WorkflowStepStatus =
  | "pending"
  | "queued"
  | "running"
  | "awaiting"
  | "blocked"
  | "paused"
  | "skipped"
  | "failed"
  | "stopped"
  | "done";

/** Most demanding first: what a row rolls up to when it holds several states. */
const WORKFLOW_STEP_STATUS_PRIORITY: readonly WorkflowStepStatus[] = [
  "blocked",
  "awaiting",
  "failed",
  "running",
  "paused",
  "stopped",
  "queued",
  "pending",
  "skipped",
  "done",
];

/** The states that are worth a color because someone is waiting on them. */
const WORKFLOW_STEP_STATUS_DEMANDING: ReadonlySet<WorkflowStepStatus> = new Set([
  "blocked",
  "awaiting",
  "failed",
  "running",
  "paused",
  "stopped",
]);

export interface WorkflowStepStatusInput {
  /** Statuses of the threads the step owns, excluding the workflow root. */
  readonly threadStatuses: readonly WorkflowThreadStatus[];
  readonly skipped?: boolean;
  readonly paused?: boolean;
  /** The run stopped here and cannot go on until a human intervenes. */
  readonly blocked?: boolean;
  /**
   * Where the workflow's own progress puts this step. Steps that run in the
   * main thread own no agent to read a status from, so this is the only thing
   * that says whether they are ahead of the run or behind it.
   */
  readonly progress?: "completed" | "current" | "upcoming" | null;
}

export function resolveWorkflowStepStatus(input: WorkflowStepStatusInput): WorkflowStepStatus {
  if (input.skipped === true) return "skipped";
  if (input.blocked === true) return "blocked";
  if (input.paused === true) return "paused";
  const has = (status: WorkflowThreadStatus) => input.threadStatuses.includes(status);
  if (has("approval") || has("input")) return "awaiting";
  if (has("working") || has("monitoring")) return "running";
  // A settled agent under a stage the run is still sitting at means the run is
  // between attempts here, not finished with the step. Reading the settled
  // thread instead would call the live step done and color the next one wrong.
  if (input.progress === "current") return "running";
  if (has("failed")) return "failed";
  if (has("stopped")) return "stopped";
  if (input.threadStatuses.length > 0) return "done";
  if (input.progress === "completed") return "done";
  return "pending";
}

/**
 * The single status a row of several shows, ranked by what it asks of the user.
 *
 * Used where the row is one piece of work split across parts, such as a ticket
 * wave: the wave is only done once its last ticket is, and one blocked ticket
 * is the thing the user needs to see.
 */
export function resolveWorkflowStepRollup(
  statuses: readonly WorkflowStepStatus[],
): WorkflowStepStatus {
  if (statuses.length === 0) return "pending";
  return (
    WORKFLOW_STEP_STATUS_PRIORITY.find((candidate) => statuses.includes(candidate)) ?? "pending"
  );
}

/**
 * The status a phase shows for the steps under it.
 *
 * A phase reports the most demanding thing under it, so one blocked step is
 * never hidden by the four beside it that are fine. With nothing demanding
 * left it claims done only once every step is done or skipped; a phase that is
 * part way through with nothing running reports as not started and leaves its
 * step count to say how far it got.
 */
export function resolveWorkflowPhaseStatus(
  statuses: readonly WorkflowStepStatus[],
): WorkflowStepStatus {
  if (statuses.length === 0) return "pending";
  const demanding = statuses.filter((status) => WORKFLOW_STEP_STATUS_DEMANDING.has(status));
  if (demanding.length > 0) return resolveWorkflowStepRollup(demanding);
  return statuses.every((status) => status === "done" || status === "skipped") ? "done" : "pending";
}

/**
 * The status one ticket row of an implementation run shows.
 *
 * The run's own ticket state says whether a ticket is waiting on its
 * dependencies, done, or failed; the ticket's threads say whether it is
 * waiting on the user right now. Neither alone describes the row.
 */
export function resolveWorkflowTicketStatus(input: {
  readonly ticketState: string | null;
  readonly threadStatuses: readonly WorkflowThreadStatus[];
  readonly skipped: boolean;
  readonly paused: boolean;
}): WorkflowStepStatus {
  if (input.skipped) return "skipped";
  if (input.paused) return "paused";
  if (input.threadStatuses.includes("approval") || input.threadStatuses.includes("input")) {
    return "awaiting";
  }
  switch (input.ticketState) {
    // A run marks a ticket blocked while its dependencies are still building,
    // which is a queue rather than something the user has to unblock.
    case "blocked":
      return "queued";
    case "ready":
      return "pending";
    case "running":
    case "app-reviewing":
    case "code-reviewing":
      return "running";
    case "succeeded":
      return "done";
    case "failed":
      return "failed";
    default:
      return resolveWorkflowStepStatus({ threadStatuses: input.threadStatuses });
  }
}

/**
 * The status behind one ticket stage's reported detail.
 *
 * `implementationTicketStageDetails` writes the words the row already shows,
 * so this only decides the color beside them rather than restating them.
 */
export function resolveWorkflowStageDetailStatus(detail: string): WorkflowStepStatus {
  const value = detail.toLowerCase();
  if (value.startsWith("skipped")) return "skipped";
  if (
    value === "running" ||
    value === "in review" ||
    value === "in progress" ||
    value === "reviewing" ||
    value === "planning" ||
    value === "fixing"
  ) {
    return "running";
  }
  if (
    value === "succeeded" ||
    value === "passed" ||
    value === "clean" ||
    value === "completed" ||
    // Gap analysis reports the repair tickets it wrote, which is its outcome.
    /^\d+ tickets?$/.test(value)
  ) {
    return "done";
  }
  if (value === "failed" || value === "review-failed" || value === "exhausted") return "failed";
  if (value === "blocked") return "blocked";
  // A review that landed findings is waiting on the fix its run will make.
  if (value === "findings") return "awaiting";
  return "pending";
}

export function resolveWorkflowLifecycle<TThread extends WorkflowModelThread>(
  members: readonly TThread[],
  classify: (thread: TThread) => "active" | "snoozed" | "settled",
): "active" | "snoozed" | "settled" {
  let hasSnoozed = false;
  for (const member of members) {
    const lifecycle = classify(member);
    if (lifecycle === "active") return "active";
    if (lifecycle === "snoozed") hasSnoozed = true;
  }
  return hasSnoozed ? "snoozed" : "settled";
}

function resolveOwner<TThread extends WorkflowModelThread>(
  thread: TThread,
  byKey: ReadonlyMap<string, TThread>,
): TThread {
  const contextRootId = thread.workflowContext?.rootThreadId;
  const contextRoot = contextRootId
    ? byKey.get(`${thread.environmentId}:${contextRootId}`)
    : undefined;
  // A nested workflow's rootThreadId identifies its local controller (for
  // example, App Review can root at a Fast Feature Build child). Continue up
  // the physical thread ancestry so every nested workflow remains visible from
  // the thread that initiated the complete workflow tree.
  let current = contextRoot ?? thread;
  const path: TThread[] = [];
  const indexByKey = new Map<string, number>();
  while (current.parentThreadId !== null) {
    const currentKey = workflowThreadKey(current);
    const cycleIndex = indexByKey.get(currentKey);
    if (cycleIndex !== undefined) {
      return path.slice(cycleIndex).toSorted((left, right) => left.id.localeCompare(right.id))[0]!;
    }
    indexByKey.set(currentKey, path.length);
    path.push(current);
    const parent = byKey.get(`${current.environmentId}:${current.parentThreadId}`);
    if (!parent || parent === current) break;
    current = parent;
  }
  return current;
}

function resolveLegacyBranchKey<TThread extends WorkflowModelThread>(
  thread: TThread,
  owner: TThread,
  byKey: ReadonlyMap<string, TThread>,
): string {
  let current = thread;
  const visited = new Set<string>();
  while (current.parentThreadId !== null && current.parentThreadId !== owner.id) {
    const currentKey = workflowThreadKey(current);
    if (visited.has(currentKey)) break;
    visited.add(currentKey);
    const parent = byKey.get(`${current.environmentId}:${current.parentThreadId}`);
    if (!parent || parent === current) break;
    current = parent;
  }
  return current.id;
}

function sortOldestFirst<TThread extends WorkflowModelThread>(left: TThread, right: TThread) {
  return (
    timestampMs(left.createdAt) - timestampMs(right.createdAt) || left.id.localeCompare(right.id)
  );
}

function buildGroupRows<TThread extends WorkflowModelThread>(threads: readonly TThread[]) {
  const byKey = new Map(threads.map((thread) => [workflowThreadKey(thread), thread] as const));
  const parentByKey = new Map<string, string | null>();
  for (const thread of threads) {
    const key = workflowThreadKey(thread);
    if (thread.parentThreadId === null || thread.parentThreadId === thread.id) {
      parentByKey.set(key, null);
      continue;
    }
    const parentKey = `${thread.environmentId}:${thread.parentThreadId}`;
    parentByKey.set(key, byKey.has(parentKey) ? parentKey : null);
  }

  // Break every edge participating in a cycle. Orphans and corrupt branches
  // become roots, so the renderer always emits each surviving shell once.
  for (const startKey of byKey.keys()) {
    const path: string[] = [];
    const indexByKey = new Map<string, number>();
    let currentKey: string | null = startKey;
    while (currentKey !== null) {
      const cycleIndex = indexByKey.get(currentKey);
      if (cycleIndex !== undefined) {
        for (const cycleKey of path.slice(cycleIndex)) parentByKey.set(cycleKey, null);
        break;
      }
      indexByKey.set(currentKey, path.length);
      path.push(currentKey);
      currentKey = parentByKey.get(currentKey) ?? null;
    }
  }

  const childrenByParent = new Map<string, TThread[]>();
  for (const thread of threads) {
    const parentKey = parentByKey.get(workflowThreadKey(thread));
    if (parentKey === null || parentKey === undefined) continue;
    const children = childrenByParent.get(parentKey);
    if (children) children.push(thread);
    else childrenByParent.set(parentKey, [thread]);
  }
  for (const children of childrenByParent.values()) children.sort(sortOldestFirst);

  const rows: WorkflowTreeRow<TThread>[] = [];
  const emitted = new Set<string>();
  const emit = (thread: TThread, depth: number) => {
    const key = workflowThreadKey(thread);
    if (emitted.has(key)) return;
    emitted.add(key);
    rows.push({ thread, depth, parentThreadKey: parentByKey.get(key) ?? null });
    for (const child of childrenByParent.get(key) ?? []) emit(child, depth + 1);
  };
  const roots = threads
    .filter((thread) => parentByKey.get(workflowThreadKey(thread)) === null)
    .toSorted(sortOldestFirst);
  for (const root of roots) emit(root, 0);
  for (const thread of [...threads].sort(sortOldestFirst)) emit(thread, 0);
  return rows;
}

export function buildWorkflowViewModel<TThread extends WorkflowModelThread>(
  threads: readonly TThread[],
): WorkflowViewModel<TThread> {
  const byKey = new Map(threads.map((thread) => [workflowThreadKey(thread), thread] as const));
  const ownerThreadKeyByThreadKey = new Map<string, string>();
  const membersByOwnerKey = new Map<string, TThread[]>();

  for (const thread of threads) {
    const owner = resolveOwner(thread, byKey);
    const threadKey = workflowThreadKey(thread);
    const ownerKey = workflowThreadKey(owner);
    ownerThreadKeyByThreadKey.set(threadKey, ownerKey);
    const members = membersByOwnerKey.get(ownerKey);
    if (members) members.push(thread);
    else membersByOwnerKey.set(ownerKey, [thread]);
  }

  const rootsByThreadKey = new Map<string, WorkflowRoot<TThread>>();
  for (const [ownerKey, members] of membersByOwnerKey) {
    const owner = byKey.get(ownerKey);
    if (!owner) continue;
    const descendants = members.filter((thread) => workflowThreadKey(thread) !== ownerKey);
    const grouped = new Map<
      string,
      { kind: WorkflowGroup<TThread>["kind"]; sourceId: string; threads: TThread[] }
    >();
    if (owner.workflowContext != null && owner.workflowPreset !== null) {
      grouped.set(`workflow:${owner.workflowContext.workflowId}`, {
        kind: "workflow",
        sourceId: owner.workflowContext.workflowId,
        threads: [],
      });
    }
    for (const thread of descendants) {
      const contextId = thread.workflowContext?.workflowId;
      const batchId = thread.workflowSubagentBatchProvenance?.batchId;
      const kind = contextId ? "workflow" : batchId ? "batch" : "legacy";
      const sourceId = contextId ?? batchId ?? resolveLegacyBranchKey(thread, owner, byKey);
      const groupId = `${kind}:${sourceId}`;
      const group = grouped.get(groupId);
      if (group) group.threads.push(thread);
      else grouped.set(groupId, { kind, sourceId, threads: [thread] });
    }

    const groupIdByThreadKey = new Map<string, string>();
    const groupIdByWorkflowId = new Map<string, string>();
    for (const [groupId, group] of grouped) {
      if (group.kind === "workflow") groupIdByWorkflowId.set(group.sourceId, groupId);
      for (const thread of group.threads) {
        groupIdByThreadKey.set(workflowThreadKey(thread), groupId);
      }
    }

    const parentGroupIdById = new Map<string, string | null>();
    for (const [groupId, group] of grouped) {
      const declaredParentWorkflowId = group.threads.find(
        (thread) => thread.workflowContext?.parentWorkflowId != null,
      )?.workflowContext?.parentWorkflowId;
      const declaredParentGroupId =
        declaredParentWorkflowId === undefined || declaredParentWorkflowId === null
          ? undefined
          : groupIdByWorkflowId.get(declaredParentWorkflowId);
      if (declaredParentGroupId !== undefined && declaredParentGroupId !== groupId) {
        parentGroupIdById.set(groupId, declaredParentGroupId);
        continue;
      }
      let parentGroupId: string | null = null;
      for (const thread of [...group.threads].sort(sortOldestFirst)) {
        let parentThreadId = thread.parentThreadId;
        const visited = new Set<string>();
        while (parentThreadId !== null) {
          const parentKey = `${thread.environmentId}:${parentThreadId}`;
          if (visited.has(parentKey)) break;
          visited.add(parentKey);
          const candidateGroupId = groupIdByThreadKey.get(parentKey);
          if (candidateGroupId !== undefined && candidateGroupId !== groupId) {
            parentGroupId = candidateGroupId;
            break;
          }
          const parent = byKey.get(parentKey);
          if (!parent) break;
          parentThreadId = parent.parentThreadId;
        }
        if (parentGroupId !== null) break;
      }
      parentGroupIdById.set(groupId, parentGroupId);
    }

    // Corrupt cross-workflow ancestry must not make the group renderer recurse
    // forever. Break every group edge participating in a cycle, matching the
    // thread-row cycle handling above.
    for (const startId of grouped.keys()) {
      const path: string[] = [];
      const indexById = new Map<string, number>();
      let currentId: string | null = startId;
      while (currentId !== null) {
        const cycleIndex = indexById.get(currentId);
        if (cycleIndex !== undefined) {
          for (const cycleId of path.slice(cycleIndex)) parentGroupIdById.set(cycleId, null);
          break;
        }
        indexById.set(currentId, path.length);
        path.push(currentId);
        currentId = parentGroupIdById.get(currentId) ?? null;
      }
    }

    const depthByGroupId = new Map<string, number>();
    const resolveGroupDepth = (groupId: string): number => {
      const cached = depthByGroupId.get(groupId);
      if (cached !== undefined) return cached;
      const parentGroupId = parentGroupIdById.get(groupId) ?? null;
      const depth = parentGroupId === null ? 0 : resolveGroupDepth(parentGroupId) + 1;
      depthByGroupId.set(groupId, depth);
      return depth;
    };

    const unorderedGroups = [...grouped.entries()].map(([id, group]): WorkflowGroup<TThread> => {
      const rows = buildGroupRows(group.threads);
      const statuses =
        rows.length > 0
          ? rows.map((row) => resolveWorkflowThreadStatus(row.thread))
          : [resolveWorkflowThreadStatus(owner)];
      const activeCount = statuses.filter(workflowStatusIsActive).length;
      return {
        id,
        kind: group.kind,
        sourceId: group.sourceId,
        parentGroupId: parentGroupIdById.get(id) ?? null,
        depth: resolveGroupDepth(id),
        createdAt: group.threads.reduce(
          (earliest, thread) =>
            timestampMs(thread.createdAt) < timestampMs(earliest) ? thread.createdAt : earliest,
          group.threads[0]?.createdAt ?? owner.createdAt,
        ),
        preset:
          group.threads.find((thread) => thread.workflowPreset != null)?.workflowPreset ??
          (group.kind === "workflow" ? owner.workflowPreset : null) ??
          null,
        rows,
        activeCount,
        settledCount: statuses.length - activeCount,
        isActive: activeCount > 0,
      };
    });

    const compareGroups = (left: WorkflowGroup<TThread>, right: WorkflowGroup<TThread>) =>
      timestampMs(left.createdAt) - timestampMs(right.createdAt) || left.id.localeCompare(right.id);
    const childrenByParentId = new Map<string, WorkflowGroup<TThread>[]>();
    for (const group of unorderedGroups) {
      if (group.parentGroupId === null) continue;
      const children = childrenByParentId.get(group.parentGroupId);
      if (children) children.push(group);
      else childrenByParentId.set(group.parentGroupId, [group]);
    }
    for (const children of childrenByParentId.values()) children.sort(compareGroups);

    // Workflow cards follow the generated step tree: a parent run comes first,
    // followed immediately by its sub-workflows in creation order.
    const groups: WorkflowGroup<TThread>[] = [];
    const emittedGroups = new Set<string>();
    const emitGroup = (group: WorkflowGroup<TThread>) => {
      if (emittedGroups.has(group.id)) return;
      emittedGroups.add(group.id);
      groups.push(group);
      for (const child of childrenByParentId.get(group.id) ?? []) emitGroup(child);
    };
    for (const group of unorderedGroups
      .filter((candidate) => candidate.parentGroupId === null)
      .sort(compareGroups)) {
      emitGroup(group);
    }
    for (const group of unorderedGroups.sort(compareGroups)) emitGroup(group);

    rootsByThreadKey.set(ownerKey, { root: owner, members, groups });
  }

  return {
    ownerThreadKeyByThreadKey,
    rootsByThreadKey,
    topLevelThreads: threads.filter((thread) => thread.parentThreadId === null),
  };
}

export function selectWorkflowRootForThread<TThread extends WorkflowModelThread>(
  model: WorkflowViewModel<TThread>,
  thread: Pick<WorkflowModelThread, "environmentId" | "id"> | null | undefined,
): WorkflowRoot<TThread> | null {
  if (!thread) return null;
  const threadKey = workflowThreadKey(thread);
  const ownerKey = model.ownerThreadKeyByThreadKey.get(threadKey) ?? threadKey;
  return model.rootsByThreadKey.get(ownerKey) ?? null;
}

export function workflowNavigationIsAvailable<TThread extends WorkflowModelThread>(
  workflow: WorkflowRoot<TThread> | null,
): boolean {
  if (workflow === null) return false;
  return (
    workflow.groups.length > 0 ||
    workflow.root.workflowPreset !== null ||
    workflow.root.workflowContext !== null
  );
}
