import type { EnvironmentWorkflowThreadShell } from "@t3tools/client-runtime/state/models";
import {
  buildTicketWaves,
  resolveGroupImplementationRun,
  resolveWorkflowPhaseStatus,
  resolveWorkflowStepRollup,
  resolveWorkflowStepTimeRange,
  resolveWorkflowThreadStatus,
  resolveWorkflowThreadTimeRange,
  resolveWorkflowTicketStatus,
  workflowStepCanRetryImplementationFailure,
  type WorkflowRoot,
  type WorkflowStepStatus,
  type WorkflowThreadStatus,
  type WorkflowTimelineStep,
} from "@t3tools/client-runtime/workflow-model";
import {
  collectRunningStepThreadIds,
  collectStepThreads,
  groupTitle,
  groupWorkflowStepsByPhase,
  implementationRunWorkflowIds,
  planningStepTimeRange,
  rerunRunStageForStep,
  resolveStepRestart,
  resolveWorkflowGroupCurrentPath,
  resolveWorkflowGroupState,
  restartablePlanningStage,
  runningThreadIdsOf,
  skipRunStageForStep,
  TICKET_PROGRESS_SEGMENT_BY_STATUS,
  ticketReviewOutcome,
  workflowPauseOf,
  workflowRoleShortLabel,
  workflowStepLabel,
  workflowStepSubSteps,
  workflowStepTitle,
  workflowTicketStatuses,
  type RestartablePlanningStage,
  type TicketProgressSegment,
} from "@t3tools/client-runtime/workflow-panel";
import {
  isRunStageSkipped,
  isTicketSkipped,
  type AppReviewWorkflowRun,
  type OrchestrationImplementationRerunTarget,
  type OrchestrationImplementationRun,
  type OrchestrationImplementationSkipTarget,
  type OrchestrationPlanningSpec,
  type OrchestrationPlanningTicket,
  type ThreadId,
  type WorkflowStepCycleOverride,
} from "@t3tools/contracts";
import { resolveWorkflowStepCycleBudget } from "@t3tools/shared/workflowStepCycles";

type Thread = EnvironmentWorkflowThreadShell;

/** What "Start again" does for a scope, as data the sheet turns into commands. */
export type WorkflowRestartAction =
  | { readonly kind: "planning-stage"; readonly stage: RestartablePlanningStage }
  | { readonly kind: "resume" }
  | { readonly kind: "retry"; readonly runId: string }
  | {
      readonly kind: "rerun";
      readonly runId: string;
      readonly targets: readonly OrchestrationImplementationRerunTarget[];
    };

/** The controls the web step menu offers, for one step, wave, or ticket. */
export interface WorkflowScopeControls {
  readonly noun: "step" | "wave" | "ticket";
  readonly label: string;
  readonly runningThreadIds: readonly ThreadId[];
  /** The paused scopes covering this one; a Resume clears them. Empty when running. */
  readonly pausedScopeThreadIds: readonly ThreadId[];
  readonly restart: WorkflowRestartAction | null;
  readonly restartDisabledReason: string | null;
  readonly clear: {
    readonly runId: string;
    readonly targets: readonly OrchestrationImplementationRerunTarget[];
  } | null;
  readonly clearDisabledReason: string | null;
  readonly confirmClearMessage: string;
  readonly skip: {
    readonly runId: string;
    readonly target: OrchestrationImplementationSkipTarget;
    readonly skipped: boolean;
  } | null;
}

/** What the per-step settings screen tunes. */
export interface WorkflowStepTuning {
  readonly stepLabel: string;
  readonly workflowPromptId: string | null;
  readonly subStepPromptIds: readonly string[];
  readonly subStepLabels: readonly string[];
  readonly usesRootThread: boolean;
}

export type WorkflowSheetRow =
  | {
      readonly kind: "group";
      readonly id: string;
      readonly title: string;
      readonly status: WorkflowStepStatus;
      readonly label: string;
      readonly subtitle: string | null;
      readonly startedAt: string;
      readonly endedAt: string | null;
      readonly expanded: boolean;
      readonly halt: { readonly scope: string; readonly detail: string } | null;
    }
  | {
      readonly kind: "phase";
      readonly id: string;
      readonly phase: string;
      readonly status: WorkflowStepStatus;
      readonly done: number;
      readonly total: number;
      readonly liveStepLabel: string | null;
      readonly expanded: boolean;
    }
  | {
      readonly kind: "step";
      readonly id: string;
      readonly number: number;
      readonly label: string;
      readonly status: WorkflowStepStatus;
      readonly startedAt: string;
      readonly endedAt: string | null;
      readonly badge: string | null;
      readonly expanded: boolean;
      readonly controls: WorkflowScopeControls;
      readonly tuning: WorkflowStepTuning;
    }
  | {
      readonly kind: "thread";
      readonly id: string;
      readonly thread: Thread;
      readonly status: WorkflowThreadStatus;
      readonly role: string;
      readonly caption: string | null;
      readonly startedAt: string;
      readonly endedAt: string | null;
      readonly indent: number;
    }
  | { readonly kind: "more"; readonly id: string; readonly stepId: string; readonly hidden: number }
  | {
      readonly kind: "wave";
      readonly id: string;
      readonly title: string;
      readonly status: WorkflowStepStatus;
      readonly controls: WorkflowScopeControls;
    }
  | {
      readonly kind: "ticket";
      readonly id: string;
      readonly ticket: OrchestrationPlanningTicket;
      readonly title: string;
      readonly status: WorkflowStepStatus;
      readonly expanded: boolean;
      readonly controls: WorkflowScopeControls;
    }
  | {
      readonly kind: "document";
      readonly id: string;
      readonly title: string;
      readonly markdown: string;
    }
  | { readonly kind: "note"; readonly id: string; readonly text: string }
  | { readonly kind: "heading"; readonly id: string; readonly text: string };

export interface WorkflowSheetInput {
  readonly workflow: WorkflowRoot<Thread>;
  readonly implementationRuns: readonly OrchestrationImplementationRun[];
  readonly appReviewWorkflowRuns: readonly AppReviewWorkflowRun[];
  readonly tickets: readonly OrchestrationPlanningTicket[];
  readonly spec: OrchestrationPlanningSpec | null;
  readonly defaultStepCycles: ReadonlyArray<WorkflowStepCycleOverride> | undefined;
  /** Disclosure overrides by row id; rows fall back to their own default. */
  readonly expanded: Readonly<Record<string, boolean>>;
  /** Step ids whose earlier entries the user asked to see. */
  readonly showAllEntries: ReadonlySet<string>;
}

/**
 * How many of a step's entries list before the rest fold away, matching the
 * web panel: a stage that retried hard can own hundreds of threads.
 */
export const VISIBLE_STEP_ENTRIES = 8;

const TICKET_THREAD_ROLES = new Set([
  "implementation-worker",
  "implementation-code-reviewer",
  "app-review-orchestrator",
  "app-review-reviewer",
  "app-review-planner",
  "app-review-fixer",
]);

export function workflowTicketTitle(ticket: OrchestrationPlanningTicket): string {
  return `${ticket.key ?? `Ticket ${ticket.ordinal + 1}`} · ${ticket.title}`;
}

/** Records the action a restart closure would take without running anything. */
function describeStepRestart(
  input: Omit<
    Parameters<typeof resolveStepRestart>[0],
    | "onRestartPlanningStage"
    | "onRetryImplementationRun"
    | "onRerunImplementationStage"
    | "onResumeWorkflow"
  >,
): { readonly action: WorkflowRestartAction | null; readonly disabledReason: string | null } {
  let action: WorkflowRestartAction | null = null;
  // resolveStepRestart owns the restart rules and hands back a closure; these
  // callbacks only capture which command that closure stands for.
  const resolved = resolveStepRestart({
    ...input,
    onRestartPlanningStage: (stage) => {
      action = { kind: "planning-stage", stage };
    },
    onRetryImplementationRun: (runId) => {
      action = { kind: "retry", runId };
    },
    onRerunImplementationStage: ({ runId, target }) => {
      action = { kind: "rerun", runId, targets: [target] };
    },
    onResumeWorkflow: () => {
      action = { kind: "resume" };
    },
  });
  resolved.run?.();
  return { action, disabledReason: resolved.disabledReason };
}

function threadRow(
  thread: Thread,
  id: string,
  caption: string | null,
  indent: number,
): WorkflowSheetRow {
  return {
    kind: "thread",
    id,
    thread,
    status: resolveWorkflowThreadStatus(thread),
    role: workflowRoleShortLabel(thread.workflowRole) ?? "Workflow child",
    caption,
    ...resolveWorkflowThreadTimeRange(thread),
    indent,
  };
}

/** The ticket progress bar's counts, in the web panel's segment order. */
export function summarizeWorkflowTickets(
  statuses: readonly WorkflowStepStatus[],
): ReadonlyMap<TicketProgressSegment, number> {
  const counts = new Map<TicketProgressSegment, number>();
  for (const status of statuses) {
    const segment = TICKET_PROGRESS_SEGMENT_BY_STATUS[status];
    counts.set(segment, (counts.get(segment) ?? 0) + 1);
  }
  return counts;
}

function linkedRun(
  input: Pick<WorkflowSheetInput, "workflow" | "implementationRuns" | "spec">,
  group: WorkflowRoot<Thread>["groups"][number],
): OrchestrationImplementationRun | null {
  return resolveGroupImplementationRun(group, input.workflow.groups, input.implementationRuns, {
    specId: input.spec?.id ?? null,
    rootThreadId: input.workflow.root.id,
  });
}

export function buildWorkflowTicketStatuses(
  input: Pick<
    WorkflowSheetInput,
    "workflow" | "implementationRuns" | "appReviewWorkflowRuns" | "tickets" | "spec"
  >,
) {
  const { workflow } = input;
  const groups = workflow.groups;
  const runs = new Set<OrchestrationImplementationRun>();
  for (const group of groups) {
    if (group.parentGroupId !== null) continue;
    const run = linkedRun(input, group);
    if (run !== null) runs.add(run);
  }
  return workflowTicketStatuses({
    runs: [...runs],
    tickets: input.tickets,
    threads: [workflow.root, ...workflow.members],
    appReviewWorkflowRuns: input.appReviewWorkflowRuns,
  });
}

/**
 * The sheet's flat row list: each top-level workflow group, its phases, steps,
 * and, under an open step, its threads or ticket waves. Mirrors what the web
 * panel derives so both clients read a run the same way.
 */
export function buildWorkflowSheetRows(input: WorkflowSheetInput): readonly WorkflowSheetRow[] {
  const { workflow } = input;
  const groups = workflow.groups;
  const topLevelGroups = groups.filter((group) => group.parentGroupId === null);
  const rows: WorkflowSheetRow[] = [];
  const isOpen = (id: string, fallback: boolean) => input.expanded[id] ?? fallback;

  for (const group of topLevelGroups) {
    const currentPath = resolveWorkflowGroupCurrentPath({
      group,
      groups,
      workflow,
      run: linkedRun(input, group),
      appReviewWorkflowRuns: input.appReviewWorkflowRuns,
      tickets: input.tickets,
      defaultStepCycles: input.defaultStepCycles,
    });
    const state = resolveWorkflowGroupState({
      group,
      groups,
      workflowRoot: workflow.root,
      currentPath,
      appReviewWorkflowRuns: input.appReviewWorkflowRuns,
      implementationRuns: input.implementationRuns,
      spec: input.spec,
      tickets: input.tickets,
    });
    const groupId = `group:${group.id}`;
    const groupOpen = isOpen(groupId, topLevelGroups.length === 1 || state.currentStep !== null);
    rows.push({
      kind: "group",
      id: groupId,
      title: groupTitle(group),
      status: state.headerStatus,
      label: state.headerLabel,
      subtitle: state.linkedImplementationRun === null ? null : currentPath.subtitle,
      ...state.timeRange,
      expanded: groupOpen,
      halt:
        state.automationHalt === null
          ? null
          : {
              scope:
                state.automationHalt.ticketId === undefined
                  ? state.automationHalt.stage.replaceAll("-", " ")
                  : `${state.automationHalt.stage.replaceAll("-", " ")} · ${state.automationHalt.ticketId}`,
              detail: state.automationHalt.detail,
            },
    });
    if (!groupOpen) continue;
    if (state.steps.length === 0) {
      rows.push({
        kind: "note",
        id: `${groupId}:empty`,
        text: "This workflow is running in the main thread. Its stages appear here as they start.",
      });
      continue;
    }

    const run = state.linkedImplementationRun;
    const rootSessionBusy =
      workflow.root.session?.status === "running" ||
      workflow.root.session?.status === "starting" ||
      workflow.root.hasPendingApprovals ||
      workflow.root.hasPendingUserInput;
    for (const [phase, phaseSteps] of groupWorkflowStepsByPhase(state.steps)) {
      const phaseId = `phase:${group.id}:${phase}`;
      const statuses = phaseSteps.map(state.stepStatusOf);
      const liveStep = state.liveStepOf(phaseSteps);
      const phaseOpen = isOpen(
        phaseId,
        liveStep !== null || (state.currentStep === null && phase === "Implementation"),
      );
      rows.push({
        kind: "phase",
        id: phaseId,
        phase,
        status: resolveWorkflowPhaseStatus(statuses),
        done: statuses.filter((status) => status === "done" || status === "skipped").length,
        total: statuses.length,
        liveStepLabel: liveStep === null ? null : workflowStepLabel(liveStep),
        expanded: phaseOpen,
      });
      if (!phaseOpen) continue;

      for (const step of phaseSteps) {
        const stepId = `step:${group.id}:${step.id}`;
        const stepOpen = isOpen(stepId, false);
        const stepThreads = collectStepThreads(step, workflow.root.id);
        const runningThreadIds = collectRunningStepThreadIds(
          state.workflowThreads,
          step,
          workflow.root.id,
        );
        const pause = workflowPauseOf(state.workflowThreads, stepThreads);
        const restart = describeStepRestart({
          planningRestartStage:
            phase === "Planning" && workflow.root.planningWorkflowSummary
              ? restartablePlanningStage(step, workflow.root.planningWorkflowSummary.stage)
              : null,
          rootSessionBusy,
          canRetryStep: run !== null && workflowStepCanRetryImplementationFailure(step, run),
          workflowPaused: state.workflowPaused,
          isResumeStep: state.resumeStep?.id === step.id,
          resumeStepLabel: state.resumeStep === null ? null : workflowStepTitle(state.resumeStep),
          rerunRunStage: rerunRunStageForStep(step, run),
          implementationRunId: run?.id ?? null,
        });
        const clearStage = rerunRunStageForStep(step, run);
        const skipStage = skipRunStageForStep(step);
        const paused = pause.scopeThreadIds.length > 0;
        const subSteps = workflowStepSubSteps(group.preset, step);
        rows.push({
          kind: "step",
          id: stepId,
          number: state.steps.indexOf(step) + 1,
          label: workflowStepLabel(step),
          status: state.stepStatusOf(step),
          ...(phase === "Planning"
            ? planningStepTimeRange(step, groups, input.spec, input.tickets)
            : resolveWorkflowStepTimeRange(step, groups)),
          badge: stepBadge(step, workflow.root, input.defaultStepCycles),
          expanded: stepOpen,
          controls: {
            noun: "step",
            label: workflowStepTitle(step),
            runningThreadIds,
            pausedScopeThreadIds: pause.scopeThreadIds,
            // A paused scope resumes rather than restarting, as on the web.
            restart: paused ? null : restart.action,
            restartDisabledReason: paused
              ? "This step is paused. Resume it to pick the run back up."
              : restart.disabledReason,
            clear:
              clearStage === null || run === null
                ? null
                : { runId: run.id, targets: [{ kind: "run", stage: clearStage }] },
            clearDisabledReason: null,
            confirmClearMessage:
              "Clears this step's recorded work for the whole run. Branches and commits stay.",
            skip:
              skipStage === null || run === null
                ? null
                : {
                    runId: run.id,
                    target: { kind: "run", stage: skipStage },
                    skipped: isRunStageSkipped(run.skips, skipStage),
                  },
          },
          tuning: {
            stepLabel: workflowStepTitle(step),
            workflowPromptId: step.skillId,
            subStepPromptIds: subSteps.map((subStep) => subStep.workflowPromptId),
            subStepLabels: subSteps.map((subStep) => subStep.label),
            usesRootThread: step.usesRootThread,
          },
        });
        if (!stepOpen) continue;

        const isTicketStep =
          (group.preset === "planning" || group.preset === "implementation") &&
          workflowStepLabel(step).toLowerCase().includes("execute ticket waves");
        if (isTicketStep && run !== null && state.ticketWaveTickets.length > 0) {
          rows.push(
            ...buildTicketRows({
              groupId: group.id,
              run,
              tickets: state.ticketWaveTickets,
              threads: state.workflowThreads,
              appReviewWorkflowRuns: input.appReviewWorkflowRuns,
              isOpen,
            }),
          );
          continue;
        }
        if (step.entries.length === 0) {
          rows.push({ kind: "note", id: `${stepId}:empty`, text: "Not started" });
          continue;
        }
        const showAll = input.showAllEntries.has(stepId);
        const hidden = showAll ? 0 : Math.max(0, step.entries.length - VISIBLE_STEP_ENTRIES);
        if (hidden > 0) rows.push({ kind: "more", id: `${stepId}:more`, stepId, hidden });
        step.entries.forEach((entry, entryIndex) => {
          if (entryIndex < hidden) return;
          const caption = step.repeatsAsCycles ? `Cycle ${entryIndex + 1}` : null;
          if (entry.kind === "thread") {
            rows.push(threadRow(entry.row.thread, `${stepId}:${entry.id}`, caption, 1));
            return;
          }
          const first = entry.group.rows[0]?.thread;
          if (first !== undefined) {
            rows.push(
              threadRow(first, `${stepId}:${entry.id}`, caption ?? groupTitle(entry.group), 1),
            );
          }
        });
      }
    }
    if (input.spec !== null || input.tickets.length > 0) {
      rows.push({ kind: "heading", id: `${groupId}:documents`, text: "Planning documents" });
    }
    if (input.spec !== null) {
      rows.push({
        kind: "document",
        id: `${groupId}:spec`,
        title: `Spec · ${input.spec.title}`,
        markdown: input.spec.summaryMarkdown,
      });
    }
    for (const ticket of [...input.tickets].sort((left, right) => left.ordinal - right.ordinal)) {
      rows.push({
        kind: "document",
        id: `${groupId}:ticket:${ticket.id}`,
        title: workflowTicketTitle(ticket),
        markdown: ticket.bodyMarkdown,
      });
    }
  }
  return rows;
}

function stepBadge(
  step: WorkflowTimelineStep<Thread>,
  root: Thread,
  defaultStepCycles: ReadonlyArray<WorkflowStepCycleOverride> | undefined,
): string | null {
  const label = workflowStepLabel(step).toLowerCase();
  const budget =
    step.skillId === null
      ? null
      : resolveWorkflowStepCycleBudget({
          key: { workflowPromptId: step.skillId },
          threadOverrides: root.workflowStepCycles,
          settingsOverrides: defaultStepCycles,
        });
  if (label.includes("app review") && !label.includes("execute ticket waves")) {
    return `Up to ${Math.min(budget ?? 5, 5)} cycles`;
  }
  if (step.skillId === "implementation.code-review.codex" && budget !== null) {
    return `Up to ${budget} cycles`;
  }
  if (step.repeatsAsCycles && step.entries.length > 1) return `${step.entries.length} cycles`;
  const threadCount = step.entries.filter((entry) => entry.kind === "thread").length;
  return threadCount > 1 ? `${threadCount} threads` : null;
}

function buildTicketRows(input: {
  readonly groupId: string;
  readonly run: OrchestrationImplementationRun;
  readonly tickets: readonly OrchestrationPlanningTicket[];
  readonly threads: readonly Thread[];
  readonly appReviewWorkflowRuns: readonly AppReviewWorkflowRun[];
  readonly isOpen: (id: string, fallback: boolean) => boolean;
}): WorkflowSheetRow[] {
  const { run } = input;
  const states = new Map(run.ticketStates.map((state) => [state.ticketId, state] as const));
  const runWorkflowIds = implementationRunWorkflowIds(run, input.appReviewWorkflowRuns);
  const runThreads = input.threads.filter((thread) =>
    runWorkflowIds.has(thread.workflowContext?.workflowId ?? ""),
  );
  const threadsOf = (ticketId: string) =>
    runThreads.filter((thread) => thread.workflowContext?.ticketScope.includes(ticketId) === true);
  const rows: WorkflowSheetRow[] = [];
  buildTicketWaves(input.tickets).forEach((wave, waveIndex) => {
    const waveIds = new Set(wave.map((ticket) => ticket.id));
    const waveThreads = runThreads.filter((thread) =>
      thread.workflowContext?.ticketScope.some((ticketId) => waveIds.has(ticketId)),
    );
    const waveRunning = runningThreadIdsOf(runThreads, waveThreads);
    const wavePause = workflowPauseOf(runThreads, waveThreads);
    const ticketStatus = (ticket: OrchestrationPlanningTicket, paused: boolean) =>
      resolveWorkflowTicketStatus({
        ticketState: states.get(ticket.id)?.status ?? null,
        reviewOutcome: ticketReviewOutcome(states.get(ticket.id)),
        threadStatuses: threadsOf(ticket.id).map(resolveWorkflowThreadStatus),
        skipped: isTicketSkipped(run.skips, ticket.id),
        paused,
      });
    const implementationTargets = wave.map((ticket): OrchestrationImplementationRerunTarget => ({
      kind: "ticket",
      ticketId: ticket.id,
      stage: "implementation",
    }));
    const waveBusy = waveRunning.length > 0;
    rows.push({
      kind: "wave",
      id: `wave:${input.groupId}:${wave.map((ticket) => ticket.id).join(":")}`,
      title: `Wave ${waveIndex + 1} · ${wave.length} ticket${wave.length === 1 ? "" : "s"}`,
      status: resolveWorkflowStepRollup(
        wave.map((ticket) => ticketStatus(ticket, wavePause.paused)),
      ),
      controls: {
        noun: "wave",
        label: `Wave ${waveIndex + 1}`,
        runningThreadIds: waveRunning,
        pausedScopeThreadIds: wavePause.scopeThreadIds,
        restart:
          wavePause.scopeThreadIds.length > 0
            ? null
            : { kind: "rerun", runId: run.id, targets: implementationTargets },
        restartDisabledReason:
          wavePause.scopeThreadIds.length > 0
            ? "This wave is paused. Resume it to pick the run back up."
            : waveBusy
              ? "This wave is still running. Stop it before starting it again."
              : null,
        clear: { runId: run.id, targets: implementationTargets },
        clearDisabledReason: waveBusy
          ? "This wave is still running. Stop it before clearing it."
          : null,
        confirmClearMessage: `Clears all ${wave.length} ticket${wave.length === 1 ? "" : "s"} in this wave, including the ones that succeeded. Branches and commits stay; the wave rebuilds in dependency order.`,
        skip: null,
      },
    });
    for (const ticket of wave) {
      const ticketThreads = threadsOf(ticket.id);
      const pause = workflowPauseOf(runThreads, ticketThreads);
      const running = runningThreadIdsOf(runThreads, ticketThreads);
      const ticketId = `ticket:${input.groupId}:${ticket.id}`;
      const open = input.isOpen(ticketId, false);
      const target: OrchestrationImplementationRerunTarget = {
        kind: "ticket",
        ticketId: ticket.id,
        stage: "implementation",
      };
      rows.push({
        kind: "ticket",
        id: ticketId,
        ticket,
        title: workflowTicketTitle(ticket),
        status: ticketStatus(ticket, pause.paused),
        expanded: open,
        controls: {
          noun: "ticket",
          label: ticket.key ?? `Ticket ${ticket.ordinal + 1}`,
          runningThreadIds: running,
          pausedScopeThreadIds: pause.scopeThreadIds,
          restart:
            pause.scopeThreadIds.length > 0
              ? null
              : { kind: "rerun", runId: run.id, targets: [target] },
          restartDisabledReason:
            pause.scopeThreadIds.length > 0
              ? "This ticket is paused. Resume it to pick the run back up."
              : running.length > 0
                ? "Implementation is still running. Stop it before starting it again."
                : null,
          clear: { runId: run.id, targets: [target] },
          clearDisabledReason:
            running.length > 0 ? "This ticket is still running. Stop it before clearing it." : null,
          confirmClearMessage:
            "Clears this ticket's recorded work so the run builds it again. Branches and commits stay.",
          skip: {
            runId: run.id,
            target: { kind: "ticket", ticketId: ticket.id },
            skipped: isTicketSkipped(run.skips, ticket.id),
          },
        },
      });
      if (!open) continue;
      const state = states.get(ticket.id);
      const linked = ticketThreads
        .filter(
          (thread) =>
            thread.id === state?.workerThreadId ||
            thread.id === state?.codeReviewThreadId ||
            (thread.workflowRole !== null && TICKET_THREAD_ROLES.has(thread.workflowRole)),
        )
        .sort(
          (left, right) =>
            Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
            left.id.localeCompare(right.id),
        );
      if (linked.length === 0) {
        rows.push({ kind: "note", id: `${ticketId}:empty`, text: "No threads yet" });
      }
      for (const thread of linked)
        rows.push(threadRow(thread, `${ticketId}:${thread.id}`, null, 2));
    }
  });
  return rows;
}
