import {
  findWorkflowPauseScope,
  isRunStageSkipped,
  isTicketSkipped,
  isTicketStageSkipped,
} from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type {
  AppReviewWorkflowCycle,
  AppReviewWorkflowPhase,
  AppReviewWorkflowRun,
  EnvironmentId,
  ModelSelection,
  OrchestrationImplementationRerunRunStage,
  OrchestrationImplementationRerunTarget,
  OrchestrationImplementationRerunTicketStage,
  OrchestrationImplementationSkipTarget,
  ThreadId,
  OrchestrationImplementationRun,
  OrchestrationPlanningSpec,
  OrchestrationPlanningTicket,
  OrchestrationPlanningWorkflowStage,
  WorkflowPreset,
  WorkflowStepCycleOverride,
  WorkflowStepReviewPartsOverride,
} from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import {
  WORKFLOW_PRESET_DEFINITION_BY_ID,
  type WorkflowPresetSubStep,
} from "@t3tools/shared/workflowPresets";
import {
  Archive,
  ArrowUpRight,
  ChevronDown,
  ChevronRight,
  Copy,
  Eye,
  GitFork,
  Pause,
  Play,
} from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";

import { cn } from "~/lib/utils";
import { formatChatTimestampTooltip, formatShortTimestamp } from "~/timestampFormat";
import {
  buildWorkflowSteps,
  buildTicketWaves,
  implementationRunCurrentStage,
  implementationTicketStageDetails,
  resolveGroupImplementationRun,
  resolveWorkflowGroupTimeRange,
  resolveWorkflowPhaseStatus,
  resolveWorkflowStageDetailStatus,
  resolveWorkflowStepStatus,
  resolveWorkflowStepRollup,
  resolveWorkflowStepTimeRange,
  resolveWorkflowThreadTimeRange,
  resolveWorkflowThreadStatus,
  resolveWorkflowTicketStatus,
  workflowStatusIsActive,
  workflowStepMatchesImplementationFailure,
  workflowThreadKey,
  type WorkflowGroup,
  type WorkflowRoot,
  type WorkflowStepStatus,
  type WorkflowTimelineStep,
  type WorkflowThreadStatus,
} from "~/workflowModel";
import { ScrollArea } from "~/components/ui/scroll-area";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";

import ChatMarkdown from "./ChatMarkdown";
import { WorkflowStepSettingsMenu } from "./WorkflowStepSettingsMenu";
import { type SetWorkflowStepReviewParts } from "./WorkflowStepReviewParts";
import type { SetWorkflowStepCycles } from "./WorkflowStepCycles";
import { WorkflowSettingsMenu } from "./WorkflowSettingsMenu";
import {
  workflowModelPinKey,
  type SetWorkflowStepModel,
  type WorkflowModelPinKey,
} from "./WorkflowModelPins";
import { workflowRoleShortLabel } from "./Sidebar.logic";

const STATUS_VISUALS: Record<
  WorkflowThreadStatus,
  { readonly label: string; readonly dotClass: string; readonly textClass: string }
> = {
  working: {
    label: "Working",
    dotClass: "bg-sky-500",
    textClass: "text-sky-600 dark:text-sky-400",
  },
  monitoring: {
    label: "Monitoring",
    dotClass: "bg-sky-500",
    textClass: "text-sky-600 dark:text-sky-400",
  },
  approval: {
    label: "Approval",
    dotClass: "bg-amber-500",
    textClass: "text-amber-700 dark:text-amber-300",
  },
  input: {
    label: "Input",
    dotClass: "bg-indigo-500",
    textClass: "text-indigo-600 dark:text-indigo-300",
  },
  completed: {
    label: "Completed",
    dotClass: "bg-emerald-500",
    textClass: "text-emerald-700 dark:text-emerald-300",
  },
  failed: { label: "Failed", dotClass: "bg-red-500", textClass: "text-red-700 dark:text-red-300" },
  stopped: {
    label: "Stopped",
    dotClass: "bg-muted-foreground/60",
    textClass: "text-muted-foreground",
  },
  archived: {
    label: "Archived",
    dotClass: "bg-muted-foreground/50",
    textClass: "text-muted-foreground",
  },
};

/**
 * One color per thing the user can do about a row.
 *
 * Six hues carry ten states: sky is moving, amber wants the user, red stopped
 * badly, violet was stopped on purpose, emerald finished, and muted has not
 * started or never will. The label is what the row says when it has room for
 * words; the rail and tint are what make the live step findable in a long
 * collapsed list without reading any of them.
 */
const STEP_VISUALS: Record<
  WorkflowStepStatus,
  {
    readonly label: string;
    readonly dotClass: string;
    readonly textClass: string;
    readonly railClass: string;
    readonly tintClass: string;
  }
> = {
  running: {
    label: "Running",
    dotClass: "bg-sky-500",
    textClass: "text-sky-600 dark:text-sky-400",
    railClass: "bg-sky-500",
    tintClass: "bg-sky-500/5",
  },
  awaiting: {
    label: "Needs you",
    dotClass: "bg-amber-500",
    textClass: "text-amber-700 dark:text-amber-300",
    railClass: "bg-amber-500",
    tintClass: "bg-amber-500/5",
  },
  blocked: {
    label: "Blocked",
    dotClass: "bg-red-500",
    textClass: "text-red-700 dark:text-red-300",
    railClass: "bg-red-500",
    tintClass: "bg-red-500/5",
  },
  failed: {
    label: "Failed",
    dotClass: "bg-red-500",
    textClass: "text-red-700 dark:text-red-300",
    railClass: "bg-red-500/60",
    tintClass: "",
  },
  paused: {
    label: "Paused",
    dotClass: "bg-violet-500",
    textClass: "text-violet-600 dark:text-violet-300",
    railClass: "bg-violet-500",
    tintClass: "bg-violet-500/5",
  },
  stopped: {
    label: "Stopped",
    dotClass: "bg-muted-foreground/60",
    textClass: "text-muted-foreground",
    railClass: "bg-muted-foreground/40",
    tintClass: "",
  },
  queued: {
    label: "Queued",
    dotClass: "border border-muted-foreground/60 bg-muted-foreground/20",
    textClass: "text-muted-foreground",
    railClass: "bg-border",
    tintClass: "",
  },
  skipped: {
    label: "Skipped",
    dotClass: "border border-dashed border-muted-foreground/60",
    textClass: "text-muted-foreground/70",
    railClass: "bg-transparent",
    tintClass: "",
  },
  pending: {
    label: "Not started",
    dotClass: "border border-muted-foreground/50",
    textClass: "text-muted-foreground/70",
    railClass: "bg-transparent",
    tintClass: "",
  },
  done: {
    label: "Done",
    dotClass: "bg-emerald-500",
    textClass: "text-emerald-700 dark:text-emerald-300",
    railClass: "bg-emerald-500/50",
    tintClass: "",
  },
};

function StatusDot(props: { readonly status: WorkflowStepStatus; readonly className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "size-2 shrink-0 rounded-full",
        STEP_VISUALS[props.status].dotClass,
        props.className,
      )}
    />
  );
}

/** The step-level color for a row whose status is a thread's own. */
function threadStatusAsStepStatus(status: WorkflowThreadStatus): WorkflowStepStatus {
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

function elapsedBetween(startedAt: string, endedAt: string | null): string {
  const start = Date.parse(startedAt);
  const end = endedAt === null ? Date.now() : Date.parse(endedAt);
  if (Number.isNaN(start) || Number.isNaN(end)) return "";
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

function Elapsed(props: { readonly startedAt: string; readonly endedAt: string | null }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (props.endedAt !== null) return;
    const update = () => {
      if (ref.current) ref.current.textContent = elapsedBetween(props.startedAt, null);
    };
    update();
    const interval = window.setInterval(update, 1_000);
    return () => window.clearInterval(interval);
  }, [props.endedAt, props.startedAt]);
  return (
    <span ref={ref} className="tabular-nums">
      {elapsedBetween(props.startedAt, props.endedAt)}
    </span>
  );
}

function TimelineTimeRange(props: {
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly timestampFormat: TimestampFormat;
  readonly className?: string;
}) {
  const start = formatShortTimestamp(props.startedAt, props.timestampFormat) || "—";
  const end =
    props.endedAt === null
      ? "In progress"
      : formatShortTimestamp(props.endedAt, props.timestampFormat) || "—";
  return (
    <span
      className={cn(
        "flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] leading-4 text-muted-foreground",
        props.className,
      )}
    >
      <span className="whitespace-nowrap">
        <span className="mr-1 uppercase tracking-wide text-muted-foreground/70">Start</span>
        <time
          dateTime={props.startedAt}
          title={formatChatTimestampTooltip(props.startedAt, props.timestampFormat)}
          className="tabular-nums text-foreground/80"
        >
          {start}
        </time>
      </span>
      <span className="whitespace-nowrap">
        <span className="mr-1 uppercase tracking-wide text-muted-foreground/70">End</span>
        {props.endedAt === null ? (
          <span className="text-foreground/80">{end}</span>
        ) : (
          <time
            dateTime={props.endedAt}
            title={formatChatTimestampTooltip(props.endedAt, props.timestampFormat)}
            className="tabular-nums text-foreground/80"
          >
            {end}
          </time>
        )}
      </span>
      <span className="whitespace-nowrap">
        <span className="mr-1 uppercase tracking-wide text-muted-foreground/70">Took</span>
        <span className="text-foreground/80">
          <Elapsed startedAt={props.startedAt} endedAt={props.endedAt} />
        </span>
      </span>
    </span>
  );
}

function groupTitle(group: WorkflowGroup<EnvironmentThreadShell>): string {
  if (group.preset) return WORKFLOW_PRESET_DEFINITION_BY_ID[group.preset].label;
  if (group.kind === "batch") return "Agent batch";
  if (group.kind === "legacy") return "Legacy workflow";
  return "Workflow run";
}

function groupStatus(group: WorkflowGroup<EnvironmentThreadShell>): WorkflowThreadStatus {
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

function ThreadRow(props: {
  readonly row: WorkflowGroup<EnvironmentThreadShell>["rows"][number];
  readonly timestampFormat: TimestampFormat;
  readonly activeThreadKey: string | null;
  readonly onOpenThread: (thread: EnvironmentThreadShell) => void;
}) {
  const { row } = props;
  const status = resolveWorkflowThreadStatus(row.thread);
  const visual = STATUS_VISUALS[status];
  const role = workflowRoleShortLabel(row.thread.workflowRole) ?? "Workflow child";
  const provider = row.thread.session?.providerInstanceId ?? row.thread.modelSelection.instanceId;
  const model = row.thread.modelSelection.model;
  const active = workflowThreadKey(row.thread) === props.activeThreadKey;
  const timeRange = resolveWorkflowThreadTimeRange(row.thread);
  const visualDepth = Math.min(
    row.thread.workflowRole === "implementation-code-reviewer" ||
      row.thread.workflowRole === "implementation-validator" ||
      row.thread.workflowRole === "implementation-qa-reviewer" ||
      row.thread.workflowRole === "implementation-fixer"
      ? 0
      : row.depth,
    4,
  );

  return (
    <button
      type="button"
      onClick={() => props.onOpenThread(row.thread)}
      aria-current={active ? "page" : undefined}
      className={cn(
        "cursor-pointer relative flex w-full min-w-0 items-start gap-2 rounded-md py-2 pr-2 text-left transition-colors",
        active ? "bg-accent text-foreground" : "hover:bg-accent/60",
      )}
      style={{ paddingLeft: `${0.5 + visualDepth * 0.875}rem` }}
    >
      {visualDepth > 0 ? (
        <span
          aria-hidden
          className="absolute top-0 bottom-0 border-l border-border/70"
          style={{ left: `${0.65 + (visualDepth - 1) * 0.875}rem` }}
        />
      ) : null}
      <span className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", visual.dotClass)} />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{row.thread.title}</span>
          <span className={cn("shrink-0 text-[11px]", visual.textClass)}>{visual.label}</span>
        </span>
        <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
          <span className="shrink-0">{role}</span>
          <span aria-hidden>·</span>
          <span className="min-w-0 truncate">
            {provider} · {model}
          </span>
          {status === "archived" ? <Archive className="size-3 shrink-0" aria-hidden /> : null}
        </span>
        <TimelineTimeRange
          {...timeRange}
          timestampFormat={props.timestampFormat}
          className="mt-1"
        />
      </span>
    </button>
  );
}

function workflowStepTitle(step: WorkflowTimelineStep<EnvironmentThreadShell>): string {
  if (step.label !== null) return step.label;
  const first = step.entries[0];
  if (!first) return "Work";
  if (first.kind === "workflow") return groupTitle(first.group);
  return workflowRoleShortLabel(first.row.thread.workflowRole) ?? "Work";
}

function workflowStepPhase(step: WorkflowTimelineStep<EnvironmentThreadShell>): string {
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

function workflowStepLabel(step: WorkflowTimelineStep<EnvironmentThreadShell>): string {
  const label = workflowStepTitle(step);
  const separator = label.indexOf(" phase · ");
  return separator === -1 ? label : label.slice(separator + " phase · ".length);
}

function groupWorkflowStepsByPhase(
  steps: readonly WorkflowTimelineStep<EnvironmentThreadShell>[],
): readonly (readonly [string, readonly WorkflowTimelineStep<EnvironmentThreadShell>[]])[] {
  const byPhase = new Map<string, WorkflowTimelineStep<EnvironmentThreadShell>[]>();
  for (const step of steps) {
    const phase = workflowStepPhase(step);
    const phaseSteps = byPhase.get(phase);
    if (phaseSteps) phaseSteps.push(step);
    else byPhase.set(phase, [step]);
  }
  return [...byPhase.entries()];
}

function planningStepTimeRange(
  step: WorkflowTimelineStep<EnvironmentThreadShell>,
  groups: readonly WorkflowGroup<EnvironmentThreadShell>[],
  spec: OrchestrationPlanningSpec | null,
  tickets: readonly OrchestrationPlanningTicket[],
) {
  const label = workflowStepLabel(step).toLowerCase();
  if (label.includes("spec authoring") && spec !== null) {
    return { startedAt: spec.createdAt, endedAt: spec.updatedAt };
  }
  if (label.includes("ticket authoring") && tickets.length > 0) {
    const ordered = tickets.toSorted((left, right) =>
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

type RestartablePlanningStage = "grill" | "spec" | "tickets";

function restartablePlanningStage(
  step: WorkflowTimelineStep<EnvironmentThreadShell>,
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
function resolveStepRestart(input: {
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
  // A paused run keeps its worktrees, branches, and App Dev Stack. Resuming
  // starts fresh agents on that same work, which is also how a step's model pin
  // reaches a stage that was already in flight when the pause landed.
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
function rerunRunStageForStep(
  step: WorkflowTimelineStep<EnvironmentThreadShell>,
): RerunRunStage | null {
  const label = workflowStepLabel(step).toLowerCase();
  // Integration re-merges the terminal branches and then re-enters the merge
  // gate, which is the whole of what this step does.
  if (label.includes("merge ticket branches")) return "integration";
  if (label.includes("app review")) return "app-review";
  if (label.includes("code review")) return "code-review";
  return null;
}

/** Threads of a step that are still live, excluding the workflow root. */
function collectRunningStepThreadIds(
  allThreads: readonly EnvironmentThreadShell[],
  step: WorkflowTimelineStep<EnvironmentThreadShell>,
  rootThreadId: string,
): readonly ThreadId[] {
  const ids = new Set<ThreadId>();
  const consider = (thread: EnvironmentThreadShell) => {
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
function collectStepThreads(
  step: WorkflowTimelineStep<EnvironmentThreadShell>,
  rootThreadId: string,
): readonly EnvironmentThreadShell[] {
  const byId = new Map<ThreadId, EnvironmentThreadShell>();
  const consider = (thread: EnvironmentThreadShell) => {
    if (thread.id === rootThreadId) return;
    byId.set(thread.id, thread);
  };
  for (const entry of step.entries) {
    if (entry.kind === "thread") consider(entry.row.thread);
    else for (const row of entry.group.rows) consider(row.thread);
  }
  return [...byId.values()];
}

function planningStepProgress(
  step: WorkflowTimelineStep<EnvironmentThreadShell>,
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

function PlanningArtifacts(props: {
  readonly spec: OrchestrationPlanningSpec | null;
  readonly tickets: readonly OrchestrationPlanningTicket[];
  readonly onOpenSpec: () => void;
  readonly onOpenTicket: (ticket: OrchestrationPlanningTicket) => void;
}) {
  if (props.spec === null && props.tickets.length === 0) return null;
  return (
    <section className="border-t border-border/70 p-2">
      <div className="mb-2 px-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        Planning documents
      </div>
      <div className="flex flex-wrap gap-1.5">
        {props.spec ? (
          <button
            type="button"
            onClick={props.onOpenSpec}
            className="cursor-pointer inline-flex items-center gap-1 rounded-md border border-border/70 px-2 py-1.5 text-xs font-medium hover:bg-accent"
          >
            Spec · {props.spec.title}
            <ArrowUpRight className="size-3" aria-hidden />
          </button>
        ) : null}
        {props.tickets
          .toSorted((left, right) => left.ordinal - right.ordinal)
          .map((ticket) => (
            <button
              key={ticket.id}
              type="button"
              onClick={() => props.onOpenTicket(ticket)}
              className="cursor-pointer inline-flex min-w-0 items-center gap-1 rounded-md border border-border/70 px-2 py-1.5 text-xs hover:bg-accent"
            >
              <span className="max-w-56 truncate">
                {ticket.key ?? `Ticket ${ticket.ordinal + 1}`} · {ticket.title}
              </span>
              <ArrowUpRight className="size-3 shrink-0" aria-hidden />
            </button>
          ))}
      </div>
    </section>
  );
}

/** The Models-list pin each App Review phase reads. */
const APP_REVIEW_PHASE_PIN = {
  review: { workflowPromptId: "implementation.browser-app-review.codex" },
  planning: {
    workflowPromptId: "matt-pocock.to-tickets",
    stepWorkflowPromptId: "implementation.browser-app-review.codex",
  },
  fixing: {
    workflowPromptId: "matt-pocock.implement",
    stepWorkflowPromptId: "implementation.browser-app-review.codex",
  },
} as const satisfies Record<AppReviewWorkflowPhase, WorkflowModelPinKey>;

/**
 * Why an App Review phase cannot start again yet, if it cannot.
 *
 * Mirrors the server's rules so the panel never offers an action the decider
 * refuses: only the current cycle can be redone, the phases need what the
 * phases before them produced, and nothing starts under a live agent.
 */
function appReviewPhaseRerunDisabledReason(input: {
  readonly phaseLabel: string;
  readonly phase: AppReviewWorkflowPhase;
  readonly cycle: AppReviewWorkflowCycle;
  readonly isCurrentCycle: boolean;
  readonly callerBusyReason: string | null;
  readonly cyclesUsed: number;
  readonly cycleBudget: number;
  readonly activeThread: EnvironmentThreadShell | undefined;
}): string | null {
  if (!input.isCurrentCycle) return "Only the newest cycle can start again.";
  if (input.callerBusyReason !== null) return input.callerBusyReason;
  const session = input.activeThread?.session?.status;
  if (session === "starting" || session === "running") {
    return "This App Review is still running. Stop it before starting a phase again.";
  }
  // A browser review redo runs a new cycle rather than overwriting this one, so
  // it needs a cycle left to run in.
  if (input.phase === "review" && input.cyclesUsed >= input.cycleBudget) {
    return `Every one of the ${String(input.cycleBudget)} review cycles has been used.`;
  }
  if (input.phase === "planning" && input.cycle.actionableFindingsMarkdown === null) {
    return "Gap analysis needs findings from this cycle's browser review.";
  }
  if (input.phase === "fixing" && (input.cycle.repairTickets?.length ?? 0) === 0) {
    return "The repair needs the tickets gap analysis writes.";
  }
  return null;
}

function TicketAppReviewCycles(props: {
  readonly run: AppReviewWorkflowRun;
  /**
   * Set when the ticket or run that owns this review has an agent of its own in
   * the shared worktree. A repair would land beside it, so the server refuses.
   */
  readonly callerBusyReason: string | null;
  readonly environmentId: EnvironmentId;
  readonly rootModelSelection: ModelSelection;
  readonly pinFor: (key: WorkflowModelPinKey) => ModelSelection | null;
  readonly onSetStepModel: SetWorkflowStepModel | undefined;
  readonly onRerunPhase: ((phase: AppReviewWorkflowPhase) => void) | undefined;
  readonly onStopThreads: ((threadIds: readonly ThreadId[]) => void) | undefined;
  readonly onResumeThreads: ((threadIds: readonly ThreadId[]) => void) | undefined;
  readonly threads: readonly EnvironmentThreadShell[];
  readonly onOpenThread: (thread: EnvironmentThreadShell) => void;
  readonly activeThreadKey: string | null;
  readonly timestampFormat: TimestampFormat;
}) {
  const threadById = new Map(props.threads.map((thread) => [thread.id, thread] as const));
  const threadRow = (threadId: EnvironmentThreadShell["id"] | null) => {
    if (threadId === null) return null;
    const thread = threadById.get(threadId);
    if (!thread) return null;
    return (
      <ThreadRow
        row={{ thread, depth: 0, parentThreadKey: null }}
        timestampFormat={props.timestampFormat}
        activeThreadKey={props.activeThreadKey}
        onOpenThread={props.onOpenThread}
      />
    );
  };

  const latestCycleNumber = props.run.cycles.at(-1)?.cycleNumber ?? null;
  return (
    <div className="space-y-2 pt-1">
      {props.run.cycles
        .toSorted((left, right) => left.cycleNumber - right.cycleNumber)
        .map((cycle) => {
          const steps = [
            {
              label: "App review",
              phase: "review" as const,
              detail:
                cycle.reviewVerdict ?? (cycle.status === "reviewing" ? "in progress" : "pending"),
              threadId: cycle.reviewerThreadId,
              thread: threadRow(cycle.reviewerThreadId),
            },
            {
              label: "Gap analysis & repair tickets",
              phase: "planning" as const,
              detail: cycle.repairTickets?.length
                ? `${cycle.repairTickets.length} ticket${cycle.repairTickets.length === 1 ? "" : "s"}`
                : cycle.status === "planning"
                  ? "in progress"
                  : "pending",
              // Gap analysis has run in a thread of its own since it moved out
              // of the reviewer; older cycles still carry only the reviewer.
              threadId: cycle.plannerThreadId ?? cycle.reviewerThreadId,
              thread: threadRow(cycle.plannerThreadId ?? cycle.reviewerThreadId),
            },
            {
              label: "Fix the problem",
              phase: "fixing" as const,
              detail:
                cycle.fixResult?.status ?? (cycle.status === "fixing" ? "in progress" : "pending"),
              threadId: cycle.fixerThreadId,
              thread: threadRow(cycle.fixerThreadId),
            },
          ];
          // Only the newest cycle can start again: every phase entry point on
          // the server works on the run's current cycle.
          const isCurrentCycle = cycle.cycleNumber === latestCycleNumber;
          const cycleStatus = resolveWorkflowStageDetailStatus(cycle.status);
          return (
            <article
              key={cycle.cycleNumber}
              className="rounded-md border border-border/70 bg-background/60 p-2"
            >
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <StatusDot status={cycleStatus} className="size-1.5" />
                <span className="text-[11px] font-medium">
                  Cycle {cycle.cycleNumber} of {props.run.cycleBudget}
                </span>
                <span className={cn("text-[10px] capitalize", STEP_VISUALS[cycleStatus].textClass)}>
                  · {cycle.status}
                </span>
              </div>
              <TimelineTimeRange
                startedAt={cycle.startedAt}
                endedAt={cycle.completedAt}
                timestampFormat={props.timestampFormat}
                className="mt-1"
              />
              <ol className="mt-2 space-y-1.5 border-l border-border/70 pl-3">
                {steps.map((step, index) => {
                  const phaseStatus = resolveWorkflowStageDetailStatus(step.detail);
                  return (
                    <li key={step.label} className="relative">
                      <span
                        className={cn(
                          "absolute -left-[1.05rem] top-0.5 flex size-3.5 items-center justify-center rounded-full border border-border bg-background text-[8px]",
                          STEP_VISUALS[phaseStatus].textClass,
                        )}
                      >
                        {index + 1}
                      </span>
                      <div className="flex items-center gap-1.5 text-[10px]">
                        <StatusDot status={phaseStatus} className="size-1.5" />
                        <span className="font-medium text-foreground">{step.label}</span>
                        <span className={cn("capitalize", STEP_VISUALS[phaseStatus].textClass)}>
                          {" "}
                          · {step.detail}
                        </span>
                        {props.onRerunPhase === undefined ? null : (
                          <WorkflowStepSettingsMenu
                            environmentId={props.environmentId}
                            scopeNoun="phase"
                            stepLabel={`Cycle ${String(cycle.cycleNumber)} · ${step.label}`}
                            workflowPromptId={APP_REVIEW_PHASE_PIN[step.phase].workflowPromptId}
                            subSteps={[]}
                            pinFor={props.pinFor}
                            usesRootThread={false}
                            rootModelSelection={props.rootModelSelection}
                            restartLabel={`Start ${step.label} again in cycle ${String(cycle.cycleNumber)}`}
                            restartDisabledReason={appReviewPhaseRerunDisabledReason({
                              phaseLabel: step.label,
                              phase: step.phase,
                              cycle,
                              isCurrentCycle,
                              callerBusyReason: props.callerBusyReason,
                              cyclesUsed: props.run.cyclesUsed,
                              cycleBudget: props.run.cycleBudget,
                              activeThread:
                                props.run.activeThreadId === null
                                  ? undefined
                                  : threadById.get(props.run.activeThreadId),
                            })}
                            runningThreadIds={runningThreadIdsOf(
                              props.threads,
                              props.run.activeThreadId === null
                                ? []
                                : [threadById.get(props.run.activeThreadId)].flatMap((thread) =>
                                    thread === undefined ? [] : [thread],
                                  ),
                            )}
                            pausedScopeThreadIds={
                              workflowPauseOf(
                                props.threads,
                                props.run.activeThreadId === null
                                  ? []
                                  : [threadById.get(props.run.activeThreadId)].flatMap((thread) =>
                                      thread === undefined ? [] : [thread],
                                    ),
                              ).scopeThreadIds
                            }
                            onSetStepModel={props.onSetStepModel}
                            onStop={props.onStopThreads}
                            onResume={props.onResumeThreads}
                            onRestart={() => props.onRerunPhase?.(step.phase)}
                          />
                        )}
                      </div>
                      {step.thread}
                    </li>
                  );
                })}
              </ol>
              {cycle.repairTickets && cycle.repairTickets.length > 0 ? (
                <div className="mt-2 space-y-1 rounded border border-border/60 p-1.5">
                  {cycle.repairTickets.map((ticket) => (
                    <div key={ticket.key} className="rounded bg-muted/35 px-2 py-1.5">
                      <div className="text-[10px] font-medium text-foreground">
                        {ticket.key} · {ticket.title}
                      </div>
                      <div className="mt-0.5 line-clamp-2 whitespace-pre-wrap text-[9px] leading-4 text-muted-foreground">
                        {ticket.bodyMarkdown}
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}
              {cycle.actionableFindingsMarkdown ? (
                <div className="mt-2 rounded border border-border/60 px-2 py-1.5">
                  <div className="text-[9px] font-medium uppercase tracking-wider text-muted-foreground">
                    Gaps to fix
                  </div>
                  <p className="mt-1 whitespace-pre-wrap text-[10px] leading-4 text-muted-foreground">
                    {cycle.actionableFindingsMarkdown}
                  </p>
                </div>
              ) : null}
            </article>
          );
        })}
      {props.run.cycles.length === 0 ? (
        <div className="py-1 text-[10px] text-muted-foreground/65">Review cycle is starting</div>
      ) : null}
    </div>
  );
}

function AppReviewRunsTimeline(props: {
  readonly runs: readonly AppReviewWorkflowRun[];
  readonly callerBusyReason: string | null;
  readonly onStopThreads: ((threadIds: readonly ThreadId[]) => void) | undefined;
  readonly onResumeThreads: ((threadIds: readonly ThreadId[]) => void) | undefined;
  readonly environmentId: EnvironmentId;
  readonly rootModelSelection: ModelSelection;
  readonly pinFor: (key: WorkflowModelPinKey) => ModelSelection | null;
  readonly onSetStepModel: SetWorkflowStepModel | undefined;
  readonly onRerunAppReviewPhase:
    | ((input: { readonly appReviewRunId: string; readonly phase: AppReviewWorkflowPhase }) => void)
    | undefined;
  readonly threads: readonly EnvironmentThreadShell[];
  readonly onOpenThread: (thread: EnvironmentThreadShell) => void;
  readonly activeThreadKey: string | null;
  readonly timestampFormat: TimestampFormat;
}) {
  return (
    <div className="space-y-2 px-2 pb-2">
      {props.runs
        .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt))
        .map((run, index) => (
          <section key={run.id}>
            {props.runs.length > 1 ? (
              <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                Recorded App Review {index + 1} · {run.status}
              </div>
            ) : null}
            <TicketAppReviewCycles
              run={run}
              callerBusyReason={props.callerBusyReason}
              onStopThreads={props.onStopThreads}
              onResumeThreads={props.onResumeThreads}
              environmentId={props.environmentId}
              rootModelSelection={props.rootModelSelection}
              pinFor={props.pinFor}
              onSetStepModel={props.onSetStepModel}
              onRerunPhase={
                props.onRerunAppReviewPhase === undefined
                  ? undefined
                  : (phase) => props.onRerunAppReviewPhase?.({ appReviewRunId: run.id, phase })
              }
              threads={props.threads}
              onOpenThread={props.onOpenThread}
              activeThreadKey={props.activeThreadKey}
              timestampFormat={props.timestampFormat}
            />
          </section>
        ))}
    </div>
  );
}

/**
 * The agents a rendered step starts, read back from its preset definition.
 *
 * Matched on the definition's own label so a step rendered from a legacy run
 * still finds its sub-steps.
 */
function workflowStepSubSteps(
  preset: WorkflowPreset | null,
  step: WorkflowTimelineStep<EnvironmentThreadShell>,
): ReadonlyArray<WorkflowPresetSubStep> {
  if (preset === null || step.label === null) return [];
  const definition = WORKFLOW_PRESET_DEFINITION_BY_ID[preset];
  return definition?.helpSteps.find((candidate) => candidate.label === step.label)?.subSteps ?? [];
}

function workflowSkillLabel(skillId: string, titles: ReadonlyMap<string, string>): string {
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

/**
 * How many of a stage's threads render before the rest are folded away.
 *
 * A stage that retried hard can own hundreds of threads. Rendering them all
 * buries the one the user is looking for and costs a long list on every open,
 * so the newest — the live attempt among them — stay visible and the history
 * waits behind one click.
 */
const VISIBLE_STAGE_THREADS = 8;

/** The tail of a step's entries, keeping each entry's original cycle number. */
function visibleStepEntries(
  step: WorkflowTimelineStep<EnvironmentThreadShell>,
  showAll: boolean,
): ReadonlyArray<{
  readonly entry: WorkflowTimelineStep<EnvironmentThreadShell>["entries"][number];
  readonly entryIndex: number;
}> {
  const indexed = step.entries.map((entry, entryIndex) => ({ entry, entryIndex }));
  return showAll || indexed.length <= VISIBLE_STAGE_THREADS
    ? indexed
    : indexed.slice(-VISIBLE_STAGE_THREADS);
}

function ThreadRowList(props: {
  readonly threads: readonly EnvironmentThreadShell[];
  readonly timestampFormat: TimestampFormat;
  readonly activeThreadKey: string | null;
  readonly onOpenThread: (thread: EnvironmentThreadShell) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const hiddenCount = props.threads.length - VISIBLE_STAGE_THREADS;
  const visible =
    showAll || hiddenCount <= 0 ? props.threads : props.threads.slice(-VISIBLE_STAGE_THREADS);
  return (
    <div className="space-y-0.5">
      {hiddenCount > 0 && !showAll ? (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="cursor-pointer w-full rounded px-2 py-1 text-left text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          Show {hiddenCount} earlier attempt{hiddenCount === 1 ? "" : "s"}
        </button>
      ) : null}
      {visible.map((thread) => (
        <ThreadRow
          key={thread.id}
          row={{ thread, depth: 0, parentThreadKey: null }}
          timestampFormat={props.timestampFormat}
          activeThreadKey={props.activeThreadKey}
          onOpenThread={props.onOpenThread}
        />
      ))}
    </div>
  );
}

/**
 * The wave step every per-ticket agent runs under. Ticket reviews are sub-steps
 * of it, so their pins carry it as the step id. Matches the id the ticket
 * execution step already carries in the shared preset definitions.
 */
const TICKET_WAVE_PROMPT_ID = "implementation.tdd.codex";

type RerunTicketStage = OrchestrationImplementationRerunTicketStage;
type RerunRunStage = OrchestrationImplementationRerunRunStage;

/**
 * Why a ticket stage cannot start again yet, if it cannot.
 *
 * Mirrors the server's rule so the panel never offers an action the decider
 * will refuse: a second agent on the same branch is exactly what the guard
 * exists to prevent.
 */
function ticketStageRerunDisabledReason(input: {
  readonly stageLabel: string;
  readonly threads: readonly EnvironmentThreadShell[];
  readonly appReviewRun: AppReviewWorkflowRun | null | undefined;
}): string | null {
  if (input.stageLabel === "App Review" && input.appReviewRun?.status === "running") {
    return "This App Review is still running. Stop it before starting it again.";
  }
  const busy = input.threads.find(
    (thread) => thread.session?.status === "starting" || thread.session?.status === "running",
  );
  return busy === undefined
    ? null
    : `${input.stageLabel} is still running. Stop it before starting it again.`;
}

/** The re-run pin and command target for one row of a ticket's stage list. */
const TICKET_STAGE_RERUN = {
  Implementation: {
    stage: "implementation",
    pinKey: { workflowPromptId: TICKET_WAVE_PROMPT_ID },
  },
  "App Review": {
    stage: "app-review",
    pinKey: {
      workflowPromptId: "implementation.browser-app-review.codex",
      stepWorkflowPromptId: TICKET_WAVE_PROMPT_ID,
    },
  },
  "Code Review": {
    stage: "code-review",
    pinKey: {
      workflowPromptId: "implementation.code-review.codex",
      stepWorkflowPromptId: TICKET_WAVE_PROMPT_ID,
    },
  },
} as const satisfies Record<
  string,
  { readonly stage: RerunTicketStage; readonly pinKey: WorkflowModelPinKey }
>;

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
  allThreads: readonly EnvironmentThreadShell[],
  rowThreads: readonly EnvironmentThreadShell[],
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
  allThreads: readonly EnvironmentThreadShell[],
  threads: readonly EnvironmentThreadShell[],
): readonly ThreadId[] {
  return threads
    .filter(
      (thread) =>
        findWorkflowPauseScope(allThreads, thread.id) === null &&
        (thread.session?.status === "running" || thread.session?.status === "starting"),
    )
    .map((thread) => thread.id);
}

function TicketPhases(props: {
  readonly tickets: readonly OrchestrationPlanningTicket[];
  readonly run: OrchestrationImplementationRun;
  readonly environmentId: EnvironmentId;
  readonly rootModelSelection: ModelSelection;
  readonly pinFor: (key: WorkflowModelPinKey) => ModelSelection | null;
  readonly onSetStepModel: SetWorkflowStepModel | undefined;
  readonly onRerunTicketStage:
    | ((input: { readonly ticketId: string; readonly stage: RerunTicketStage }) => void)
    | undefined;
  readonly onResetTicketStage:
    | ((input: { readonly ticketId: string; readonly stage: RerunTicketStage }) => void)
    | undefined;
  readonly skips: readonly OrchestrationImplementationSkipTarget[];
  readonly onSetTicketSkip:
    | ((input: {
        readonly ticketId: string;
        readonly stage?: RerunTicketStage;
        readonly skipped: boolean;
      }) => void)
    | undefined;
  readonly onStopThreads: ((threadIds: readonly ThreadId[]) => void) | undefined;
  readonly onResumeThreads: ((threadIds: readonly ThreadId[]) => void) | undefined;
  readonly onRerunAppReviewPhase:
    | ((input: { readonly appReviewRunId: string; readonly phase: AppReviewWorkflowPhase }) => void)
    | undefined;
  readonly threads: readonly EnvironmentThreadShell[];
  readonly appReviewWorkflowRuns: readonly AppReviewWorkflowRun[];
  readonly onOpenThread: (thread: EnvironmentThreadShell) => void;
  readonly onOpenAppReview: () => void;
  readonly activeThreadKey: string | null;
  readonly timestampFormat: TimestampFormat;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const states = new Map(props.run.ticketStates.map((state) => [state.ticketId, state] as const));
  const threadsByTicketId = new Map<string, EnvironmentThreadShell[]>();
  for (const thread of props.threads) {
    for (const ticketId of thread.workflowContext?.ticketScope ?? []) {
      const scoped = threadsByTicketId.get(ticketId);
      if (scoped) scoped.push(thread);
      else threadsByTicketId.set(ticketId, [thread]);
    }
  }
  return (
    <div className="space-y-2">
      {buildTicketWaves(props.tickets).map((wave, waveIndex) => {
        const waveTicketIds = new Set(wave.map((ticket) => ticket.id));
        // A wave is derived from the dependency graph rather than stored, so
        // every action names the ticket ids this row is rendering right now.
        const waveThreads = props.threads.filter((thread) =>
          thread.workflowContext?.ticketScope.some((ticketId) => waveTicketIds.has(ticketId)),
        );
        const waveBusy = runningThreadIdsOf(props.threads, waveThreads).length > 0;
        const wavePause = workflowPauseOf(props.threads, waveThreads);
        // A wave is only done once its last ticket is, so it shows the most
        // demanding of them rather than an average nobody can act on.
        const waveStatus = resolveWorkflowStepRollup(
          wave.map((ticket) =>
            resolveWorkflowTicketStatus({
              ticketState: states.get(ticket.id)?.status ?? null,
              threadStatuses: (threadsByTicketId.get(ticket.id) ?? []).map(
                resolveWorkflowThreadStatus,
              ),
              skipped: isTicketSkipped(props.skips, ticket.id),
              paused: wavePause.paused,
            }),
          ),
        );
        const forEachWaveTicket = (
          act:
            | ((input: { readonly ticketId: string; readonly stage: RerunTicketStage }) => void)
            | undefined,
        ) =>
          act === undefined
            ? undefined
            : () => {
                for (const ticket of wave) act({ ticketId: ticket.id, stage: "implementation" });
              };
        return (
          <section
            key={wave.map((ticket) => ticket.id).join(":")}
            className="rounded-md border border-border/70 bg-background/40 p-2"
          >
            <div className="mb-1 flex items-center gap-1.5">
              <StatusDot status={waveStatus} className="size-1.5" />
              <div className="min-w-0 flex-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                Wave {waveIndex + 1} · {wave.length} ticket{wave.length === 1 ? "" : "s"}
              </div>
              <span
                className={cn(
                  "shrink-0 text-[10px] font-medium",
                  STEP_VISUALS[waveStatus].textClass,
                )}
              >
                {STEP_VISUALS[waveStatus].label}
              </span>
              <WorkflowStepSettingsMenu
                environmentId={props.environmentId}
                scopeNoun="wave"
                stepLabel={`Wave ${String(waveIndex + 1)}`}
                workflowPromptId={null}
                subSteps={[]}
                pinFor={props.pinFor}
                usesRootThread={false}
                rootModelSelection={props.rootModelSelection}
                restartLabel={`Start wave ${String(waveIndex + 1)} again`}
                restartDisabledReason={
                  waveBusy ? "This wave is still running. Stop it before starting it again." : null
                }
                runningThreadIds={runningThreadIdsOf(props.threads, waveThreads)}
                pausedScopeThreadIds={wavePause.scopeThreadIds}
                onSetStepModel={undefined}
                onStop={props.onStopThreads}
                onResume={props.onResumeThreads}
                onRestart={forEachWaveTicket(props.onRerunTicketStage)}
                clearDisabledReason={
                  waveBusy ? "This wave is still running. Stop it before clearing it." : null
                }
                confirmClearMessage={`Clears all ${String(wave.length)} ticket${wave.length === 1 ? "" : "s"} in this wave, including the ones that succeeded. Branches and commits stay; the wave rebuilds in dependency order.`}
                onClear={forEachWaveTicket(props.onResetTicketStage)}
              />
            </div>
            {wave.map((ticket) => {
              const open = expanded[ticket.id] ?? false;
              const state = states.get(ticket.id);
              const appReviewRun = props.appReviewWorkflowRuns.find(
                (run) => run.id === state?.appReviewWorkflowRunId,
              );
              const linkedThreadIds = new Set(
                [
                  state?.workerThreadId,
                  state?.codeReviewThreadId,
                  appReviewRun?.controllerThreadId,
                  ...props.threads
                    .filter(
                      (thread) =>
                        thread.workflowContext?.ticketScope.includes(ticket.id) === true &&
                        (thread.workflowRole === "implementation-worker" ||
                          thread.workflowRole === "implementation-code-reviewer" ||
                          thread.workflowRole === "app-review-orchestrator" ||
                          thread.workflowRole === "app-review-reviewer" ||
                          thread.workflowRole === "app-review-fixer"),
                    )
                    .map((thread) => thread.id),
                ].flatMap((threadId) => (threadId == null ? [] : [threadId])),
              );
              const linkedThreads = [...linkedThreadIds]
                .map((threadId) => props.threads.find((thread) => thread.id === threadId))
                .filter((thread): thread is EnvironmentThreadShell => thread !== undefined)
                .toSorted(
                  (left, right) =>
                    Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
                    left.id.localeCompare(right.id),
                );
              const implementationThreads = linkedThreads.filter(
                (thread) => thread.workflowRole === "implementation-worker",
              );
              const appReviewThreads = linkedThreads.filter(
                (thread) => thread.workflowRole?.startsWith("app-review-") === true,
              );
              const codeReviewThreads = linkedThreads.filter(
                (thread) => thread.workflowRole === "implementation-code-reviewer",
              );
              const ticketTimeRanges = linkedThreads.map(resolveWorkflowThreadTimeRange);
              const ticketTimeRange =
                ticketTimeRanges.length === 0
                  ? null
                  : {
                      startedAt: ticketTimeRanges.reduce(
                        (earliest, range) =>
                          range.startedAt < earliest ? range.startedAt : earliest,
                        ticketTimeRanges[0]!.startedAt,
                      ),
                      endedAt: ticketTimeRanges.some((range) => range.endedAt === null)
                        ? null
                        : ticketTimeRanges.reduce<string | null>(
                            (latest, range) =>
                              range.endedAt !== null && (latest === null || range.endedAt > latest)
                                ? range.endedAt
                                : latest,
                            ticketTimeRanges[0]!.endedAt,
                          ),
                    };
              const stageDetails = implementationTicketStageDetails(state, ticket);
              const stages = [
                {
                  label: "Implementation",
                  detail: stageDetails.implementation,
                  threads: implementationThreads,
                },
                {
                  label: "App Review",
                  detail: stageDetails.appReview,
                  threads: appReviewThreads,
                },
                {
                  label: "Code Review",
                  detail: stageDetails.codeReview,
                  threads: codeReviewThreads,
                },
              ] as const;
              const ticketLabel = ticket.key ?? `Ticket ${ticket.ordinal + 1}`;
              const ticketPause = workflowPauseOf(props.threads, linkedThreads);
              const ticketStatus = resolveWorkflowTicketStatus({
                ticketState: state?.status ?? null,
                threadStatuses: linkedThreads.map(resolveWorkflowThreadStatus),
                skipped: isTicketSkipped(props.skips, ticket.id),
                paused: ticketPause.paused,
              });
              const ticketDetail =
                ticketStatus === "skipped"
                  ? "skipped"
                  : ticketStatus === "paused"
                    ? "paused"
                    : (state?.status ?? ticket.status);
              return (
                <div key={ticket.id} className="border-t border-border/60 first:border-t-0">
                  <div className="flex w-full items-center gap-1">
                    <button
                      type="button"
                      aria-expanded={open}
                      onClick={() => setExpanded((current) => ({ ...current, [ticket.id]: !open }))}
                      className="cursor-pointer flex min-w-0 flex-1 items-center gap-2 py-2 text-left"
                    >
                      {open ? (
                        <ChevronDown className="size-3.5" />
                      ) : (
                        <ChevronRight className="size-3.5" />
                      )}
                      <StatusDot status={ticketStatus} className="size-1.5" />
                      <span
                        className={cn(
                          "min-w-0 flex-1 truncate text-xs font-medium",
                          ticketStatus === "skipped" && "text-muted-foreground line-through",
                        )}
                      >
                        {ticketLabel} · {ticket.title}
                      </span>
                      <span
                        className={cn(
                          "text-[10px] capitalize",
                          STEP_VISUALS[ticketStatus].textClass,
                        )}
                      >
                        {ticketDetail}
                      </span>
                    </button>
                    <WorkflowStepSettingsMenu
                      environmentId={props.environmentId}
                      scopeNoun="ticket"
                      stepLabel={ticketLabel}
                      workflowPromptId={null}
                      subSteps={[]}
                      pinFor={props.pinFor}
                      usesRootThread={false}
                      rootModelSelection={props.rootModelSelection}
                      restartLabel={`Start ${ticketLabel} again`}
                      restartDisabledReason={ticketStageRerunDisabledReason({
                        stageLabel: "Implementation",
                        threads: implementationThreads,
                        appReviewRun,
                      })}
                      runningThreadIds={runningThreadIdsOf(props.threads, linkedThreads)}
                      pausedScopeThreadIds={ticketPause.scopeThreadIds}
                      onSetStepModel={undefined}
                      onStop={props.onStopThreads}
                      onResume={props.onResumeThreads}
                      onRestart={
                        props.onRerunTicketStage === undefined
                          ? undefined
                          : () =>
                              props.onRerunTicketStage?.({
                                ticketId: ticket.id,
                                stage: "implementation",
                              })
                      }
                      clearDisabledReason={ticketStageRerunDisabledReason({
                        stageLabel: "Implementation",
                        threads: implementationThreads,
                        appReviewRun,
                      })}
                      confirmClearMessage={`Clears every stage of ${ticketLabel}. Its branch and commits stay; it starts again once its dependencies have succeeded.`}
                      onClear={
                        props.onResetTicketStage === undefined
                          ? undefined
                          : () =>
                              props.onResetTicketStage?.({
                                ticketId: ticket.id,
                                stage: "implementation",
                              })
                      }
                      skipped={isTicketSkipped(props.skips, ticket.id)}
                      onSetSkipped={
                        props.onSetTicketSkip === undefined
                          ? undefined
                          : (skipped) => props.onSetTicketSkip?.({ ticketId: ticket.id, skipped })
                      }
                    />
                  </div>
                  {open ? (
                    <div className="mb-2 ml-5 border-l border-border/70 pl-3">
                      {ticketTimeRange ? (
                        <TimelineTimeRange
                          {...ticketTimeRange}
                          timestampFormat={props.timestampFormat}
                          className="mb-2"
                        />
                      ) : null}
                      <div className="space-y-2">
                        {stages.map((stage, stageIndex) => {
                          const stageSkipped = isTicketStageSkipped(
                            props.skips,
                            ticket.id,
                            TICKET_STAGE_RERUN[stage.label].stage,
                          );
                          const stagePaused = workflowPauseOf(props.threads, stage.threads).paused;
                          const stageStatus = stageSkipped
                            ? "skipped"
                            : stagePaused
                              ? "paused"
                              : resolveWorkflowStageDetailStatus(stage.detail);
                          const stageDetail = stageSkipped
                            ? "skipped"
                            : stagePaused
                              ? "paused"
                              : stage.detail;
                          return (
                            <section key={stage.label} className="relative">
                              <span
                                className={cn(
                                  "absolute -left-[1.05rem] top-1 flex size-4 items-center justify-center rounded-full border border-border bg-background text-[9px] font-medium",
                                  STEP_VISUALS[stageStatus].textClass,
                                )}
                              >
                                {stageIndex + 1}
                              </span>
                              <div className="mb-1 flex items-center gap-1.5 text-[11px]">
                                <StatusDot status={stageStatus} className="size-1.5" />
                                <span
                                  className={cn(
                                    "font-medium",
                                    stageStatus === "skipped"
                                      ? "text-muted-foreground line-through"
                                      : "text-foreground",
                                  )}
                                >
                                  {stage.label}
                                </span>
                                <span
                                  className={cn("capitalize", STEP_VISUALS[stageStatus].textClass)}
                                >
                                  · {stageDetail}
                                </span>
                                {stage.label === "App Review" && appReviewRun ? (
                                  <button
                                    type="button"
                                    onClick={props.onOpenAppReview}
                                    className="cursor-pointer ml-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] hover:bg-accent hover:text-foreground"
                                  >
                                    Results <Eye className="size-3" aria-hidden />
                                  </button>
                                ) : null}
                                <WorkflowStepSettingsMenu
                                  environmentId={props.environmentId}
                                  scopeNoun="stage"
                                  stepLabel={`${ticket.key ?? `Ticket ${ticket.ordinal + 1}`} · ${stage.label}`}
                                  workflowPromptId={
                                    TICKET_STAGE_RERUN[stage.label].pinKey.workflowPromptId
                                  }
                                  subSteps={[]}
                                  pinFor={props.pinFor}
                                  usesRootThread={false}
                                  rootModelSelection={props.rootModelSelection}
                                  restartLabel={`Start ${stage.label} again`}
                                  restartDisabledReason={ticketStageRerunDisabledReason({
                                    stageLabel: stage.label,
                                    threads: stage.threads,
                                    appReviewRun,
                                  })}
                                  runningThreadIds={runningThreadIdsOf(
                                    props.threads,
                                    stage.threads,
                                  )}
                                  pausedScopeThreadIds={
                                    workflowPauseOf(props.threads, stage.threads).scopeThreadIds
                                  }
                                  onSetStepModel={props.onSetStepModel}
                                  onStop={props.onStopThreads}
                                  onResume={props.onResumeThreads}
                                  onRestart={
                                    props.onRerunTicketStage === undefined
                                      ? undefined
                                      : () =>
                                          props.onRerunTicketStage?.({
                                            ticketId: ticket.id,
                                            stage: TICKET_STAGE_RERUN[stage.label].stage,
                                          })
                                  }
                                  clearDisabledReason={ticketStageRerunDisabledReason({
                                    stageLabel: stage.label,
                                    threads: stage.threads,
                                    appReviewRun,
                                  })}
                                  onClear={
                                    props.onResetTicketStage === undefined
                                      ? undefined
                                      : () =>
                                          props.onResetTicketStage?.({
                                            ticketId: ticket.id,
                                            stage: TICKET_STAGE_RERUN[stage.label].stage,
                                          })
                                  }
                                  skipped={isTicketStageSkipped(
                                    props.skips,
                                    ticket.id,
                                    TICKET_STAGE_RERUN[stage.label].stage,
                                  )}
                                  onSetSkipped={
                                    props.onSetTicketSkip === undefined
                                      ? undefined
                                      : (skipped) =>
                                          props.onSetTicketSkip?.({
                                            ticketId: ticket.id,
                                            stage: TICKET_STAGE_RERUN[stage.label].stage,
                                            skipped,
                                          })
                                  }
                                />
                              </div>
                              {stage.label === "App Review" && appReviewRun ? (
                                <TicketAppReviewCycles
                                  run={appReviewRun}
                                  onStopThreads={props.onStopThreads}
                                  onResumeThreads={props.onResumeThreads}
                                  callerBusyReason={
                                    [...implementationThreads, ...codeReviewThreads].some(
                                      (thread) =>
                                        thread.session?.status === "starting" ||
                                        thread.session?.status === "running",
                                    )
                                      ? "This ticket has an agent working in the same worktree. Stop it before starting a phase again."
                                      : null
                                  }
                                  environmentId={props.environmentId}
                                  rootModelSelection={props.rootModelSelection}
                                  pinFor={props.pinFor}
                                  onSetStepModel={props.onSetStepModel}
                                  onRerunPhase={
                                    props.onRerunAppReviewPhase === undefined
                                      ? undefined
                                      : (phase) =>
                                          props.onRerunAppReviewPhase?.({
                                            appReviewRunId: appReviewRun.id,
                                            phase,
                                          })
                                  }
                                  threads={props.threads}
                                  onOpenThread={props.onOpenThread}
                                  activeThreadKey={props.activeThreadKey}
                                  timestampFormat={props.timestampFormat}
                                />
                              ) : stage.threads.length > 0 ? (
                                <ThreadRowList
                                  threads={stage.threads}
                                  timestampFormat={props.timestampFormat}
                                  activeThreadKey={props.activeThreadKey}
                                  onOpenThread={props.onOpenThread}
                                />
                              ) : (
                                <div className="py-1 text-[10px] text-muted-foreground/65">
                                  No thread created
                                </div>
                              )}
                            </section>
                          );
                        })}
                      </div>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </section>
        );
      })}
    </div>
  );
}

function appReviewRunPresentation(run: AppReviewWorkflowRun | null): {
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
}

function WorkflowGroupCard(props: {
  readonly group: WorkflowGroup<EnvironmentThreadShell>;
  readonly groups: readonly WorkflowGroup<EnvironmentThreadShell>[];
  readonly expandedById: Readonly<Record<string, boolean>>;
  readonly setExpandedById: Dispatch<SetStateAction<Record<string, boolean>>>;
  readonly focusedWorkflowId: string | null;
  readonly focusedGroupRef: RefObject<HTMLElement | null>;
  readonly activeThreadKey: string | null;
  readonly timestampFormat: TimestampFormat;
  readonly appReviewWorkflowRuns: readonly AppReviewWorkflowRun[];
  readonly implementationRuns: readonly OrchestrationImplementationRun[];
  readonly workflowRoot: EnvironmentThreadShell;
  readonly onOpenThread: (thread: EnvironmentThreadShell) => void;
  readonly onOpenAppReview: () => void;
  readonly onCopyWorkflowLink: (workflowId: string) => void;
  readonly onRetryImplementationRun?: ((runId: string) => void) | undefined;
  readonly onRerunImplementationStage?:
    | ((input: {
        readonly runId: string;
        readonly target: OrchestrationImplementationRerunTarget;
      }) => void)
    | undefined;
  readonly onResetImplementationStage?:
    | ((input: {
        readonly runId: string;
        readonly target: OrchestrationImplementationRerunTarget;
      }) => void)
    | undefined;
  readonly onSetImplementationSkip?:
    | ((input: {
        readonly runId: string;
        readonly target: OrchestrationImplementationSkipTarget;
        readonly skipped: boolean;
      }) => void)
    | undefined;
  readonly onRerunAppReviewPhase?:
    | ((input: { readonly appReviewRunId: string; readonly phase: AppReviewWorkflowPhase }) => void)
    | undefined;
  readonly onRestartPlanningStage?: ((stage: RestartablePlanningStage) => void) | undefined;
  readonly onResumeWorkflow?: (() => void) | undefined;
  readonly onSetStepModel?: SetWorkflowStepModel | undefined;
  readonly defaultStepCycles?: ReadonlyArray<WorkflowStepCycleOverride> | undefined;
  readonly onSetStepCycles?: SetWorkflowStepCycles | undefined;
  readonly defaultStepReviewParts?: ReadonlyArray<WorkflowStepReviewPartsOverride> | undefined;
  readonly onSetStepReviewParts?: SetWorkflowStepReviewParts | undefined;
  readonly onStopThreads?: ((threadIds: readonly ThreadId[]) => void) | undefined;
  readonly onResumeThreads?: ((threadIds: readonly ThreadId[]) => void) | undefined;
  readonly tickets: readonly OrchestrationPlanningTicket[];
  readonly spec: OrchestrationPlanningSpec | null;
  readonly skillTitlesById: ReadonlyMap<string, string>;
  readonly onOpenSkill: (skillId: string) => void;
  readonly nested?: boolean;
  readonly cycleLabel?: string | undefined;
}) {
  const { group } = props;
  const expanded = props.expandedById[group.id] ?? false;
  const focused = group.kind === "workflow" && group.sourceId === props.focusedWorkflowId;
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
  // Pins are keyed by step *and* sub-step: the same agent prompt appears under
  // more than one step, so a bare prompt id would collide.
  const stepModelByPinKey = new Map(
    (props.workflowRoot.workflowStepModels ?? []).map(
      (entry) => [workflowModelPinKey(entry), entry.modelSelection] as const,
    ),
  );
  const pinFor = (key: WorkflowModelPinKey): ModelSelection | null =>
    stepModelByPinKey.get(workflowModelPinKey(key)) ?? null;
  const steps = buildWorkflowSteps(group, props.groups, props.workflowRoot, {
    flattenNestedWorkflows: group.parentGroupId === null,
  });
  const [expandedPhases, setExpandedPhases] = useState<Record<string, boolean>>({});
  const [expandedSteps, setExpandedSteps] = useState<Record<string, boolean>>({});
  const [expandedStepEntries, setExpandedStepEntries] = useState<Record<string, boolean>>({});
  const [openPlanningArtifact, setOpenPlanningArtifact] = useState<{
    readonly title: string;
    readonly markdown: string;
  } | null>(null);
  const phases = groupWorkflowStepsByPhase(steps);
  // A pause on the workflow root stops the whole run, and the header's Resume
  // clears it. Scopes inside the run carry their own marks and their own
  // Resume; this one is only about the run as a whole.
  const workflowPaused = props.workflowRoot.workflowPausedAt != null;
  const resumeStage =
    workflowPaused && linkedImplementationRun !== null
      ? implementationRunCurrentStage(linkedImplementationRun)
      : null;
  const resumeStep =
    resumeStage === null
      ? null
      : (steps.find((step) => workflowStepMatchesImplementationFailure(step, resumeStage)) ?? null);
  const timeRange = resolveWorkflowGroupTimeRange(group, props.groups);
  const showsAppReviews =
    group.preset === "app-review" ||
    (group.parentGroupId === null && props.appReviewWorkflowRuns.length > 0);
  const workflowThreads = [
    props.workflowRoot,
    ...props.groups.flatMap((candidate) => candidate.rows.map((row) => row.thread)),
  ];

  const retryableFailure = linkedImplementationRun?.retryableFailure ?? null;
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
      const progress =
        planningProgress !== null
          ? (planningProgress.toLowerCase() as "completed" | "current" | "upcoming")
          : currentImplementationStage !== null &&
              workflowStepMatchesImplementationFailure(step, currentImplementationStage)
            ? ("current" as const)
            : null;
      const runStage = rerunRunStageForStep(step);
      const stepThreads = collectStepThreads(step, props.workflowRoot.id);
      return [
        step.id,
        resolveWorkflowStepStatus({
          threadStatuses: stepThreads.map(resolveWorkflowThreadStatus),
          skipped:
            runStage !== null &&
            linkedImplementationRun !== null &&
            isRunStageSkipped(linkedImplementationRun.skips, runStage),
          blocked:
            linkedImplementationRun?.status === "needs-human-attention" &&
            retryableFailure !== null &&
            workflowStepMatchesImplementationFailure(step, retryableFailure.stage),
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
  const stepStatusOf = (step: WorkflowTimelineStep<EnvironmentThreadShell>): WorkflowStepStatus =>
    stepStatusById.get(step.id) ?? "pending";
  const groupStepStatus = resolveWorkflowStepRollup(steps.map(stepStatusOf));
  /** The step a collapsed row points at: whatever is holding the run up. */
  const liveStepOf = (
    candidates: readonly WorkflowTimelineStep<EnvironmentThreadShell>[],
  ): WorkflowTimelineStep<EnvironmentThreadShell> | null =>
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
          : steps.length > 0
            ? groupStepStatus
            : threadStatusAsStepStatus(groupStatus(group));
  const headerLabel =
    headerStatus === "blocked"
      ? "Needs attention"
      : linkedAppReviewRun !== null && runPresentation.label !== null && !workflowPaused
        ? runPresentation.label
        : STEP_VISUALS[headerStatus].label;

  return (
    <div className={cn("relative", props.nested && "ml-3 my-1.5")}>
      {props.nested ? (
        <span
          aria-hidden
          className="absolute -left-2.5 top-0 h-6 w-2.5 rounded-bl-md border-b border-l border-border/70"
        />
      ) : null}
      <section
        ref={focused ? props.focusedGroupRef : undefined}
        data-workflow-group={group.id}
        data-workflow-id={group.kind === "workflow" ? group.sourceId : undefined}
        data-workflow-depth={group.depth}
        className={cn(
          "overflow-hidden rounded-lg border border-border/80 bg-card",
          focused && "border-primary/60 ring-2 ring-primary/20",
        )}
      >
        <div className="flex items-start hover:bg-accent/40">
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() =>
              props.setExpandedById((current) => ({ ...current, [group.id]: !expanded }))
            }
            className="cursor-pointer flex min-w-0 flex-1 items-start gap-2 p-3 text-left"
          >
            {expanded ? (
              <ChevronDown className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
            ) : (
              <ChevronRight className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
            )}
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2">
                <StatusDot status={headerStatus} className="mt-0.5" />
                <span className="min-w-0 flex-1 truncate text-sm font-medium">
                  {props.cycleLabel ?? groupTitle(group)}
                </span>
                <span className={cn("text-[11px]", STEP_VISUALS[headerStatus].textClass)}>
                  {headerLabel}
                </span>
              </span>
              {currentStep ? (
                <span
                  className={cn(
                    "mt-1 flex min-w-0 items-center gap-1.5 text-[11px]",
                    STEP_VISUALS[headerStatus].textClass,
                  )}
                >
                  <span className="shrink-0">{workflowStepPhase(currentStep)}</span>
                  <span aria-hidden>·</span>
                  <span className="min-w-0 truncate">{workflowStepLabel(currentStep)}</span>
                </span>
              ) : null}
              <span className="mt-1 flex flex-wrap items-center gap-x-1.5 text-[11px] text-muted-foreground">
                {group.depth > 0 ? (
                  <>
                    <span>Sub-workflow</span>
                    <span aria-hidden>·</span>
                  </>
                ) : null}
                {group.kind === "workflow" ? (
                  <>
                    <span className="font-mono" title={group.sourceId}>
                      ID {group.sourceId.slice(0, 8)}
                    </span>
                    <span aria-hidden>·</span>
                  </>
                ) : null}
                <span>{group.activeCount} active</span>
                <span aria-hidden>·</span>
                <span>{group.settledCount} settled</span>
              </span>
              <TimelineTimeRange
                {...timeRange}
                timestampFormat={props.timestampFormat}
                className="mt-1"
              />
            </span>
          </button>
          {showsAppReviews ? (
            <button
              type="button"
              aria-label="View App Review results"
              title="View App Review results"
              onClick={props.onOpenAppReview}
              className="cursor-pointer mt-2 flex items-center gap-1 rounded-md px-2 py-1.5 text-[11px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <Eye className="size-3.5" aria-hidden />
              App Reviews
            </button>
          ) : null}
          {group.kind === "workflow" ? (
            <button
              type="button"
              aria-label={`Copy link to ${groupTitle(group)} workflow`}
              title="Copy workflow link"
              onClick={() => props.onCopyWorkflowLink(group.sourceId)}
              className="cursor-pointer m-2 rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <Copy className="size-3.5" aria-hidden />
            </button>
          ) : null}
        </div>
        {expanded ? (
          <div className="divide-y divide-border/70 border-t border-border/70">
            {phases.map(([phase, availableSteps]) => {
              const phaseId = `${group.id}:${phase}`;
              const phaseOpen = expandedPhases[phaseId] ?? false;
              const phaseStatuses = availableSteps.map(stepStatusOf);
              const phaseStatus = resolveWorkflowPhaseStatus(phaseStatuses);
              const phaseSettled = phaseStatuses.filter(
                (status) => status === "done" || status === "skipped",
              ).length;
              const runningStep = liveStepOf(availableSteps);
              return (
                <section key={phaseId} className="border-b border-border/70 last:border-b-0">
                  <button
                    type="button"
                    aria-expanded={phaseOpen}
                    onClick={() =>
                      setExpandedPhases((current) => ({ ...current, [phaseId]: !phaseOpen }))
                    }
                    className="cursor-pointer flex w-full items-center gap-2 px-3 py-2.5 text-left hover:bg-accent/40"
                  >
                    {phaseOpen ? (
                      <ChevronDown className="size-3.5" />
                    ) : (
                      <ChevronRight className="size-3.5" />
                    )}
                    <StatusDot status={phaseStatus} />
                    <span className="min-w-0 flex-1 text-xs font-semibold">{phase}</span>
                    {runningStep ? (
                      <span
                        className={cn(
                          "max-w-[45%] truncate text-[10px]",
                          STEP_VISUALS[phaseStatus].textClass,
                        )}
                      >
                        {workflowStepLabel(runningStep)}
                      </span>
                    ) : null}
                    <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                      {phaseSettled}/{phaseStatuses.length} done
                    </span>
                  </button>
                  {phaseOpen ? (
                    <div className="border-t border-border/70">
                      <div className="divide-y divide-border/70">
                        {availableSteps.map((step) => {
                          const index = steps.indexOf(step);
                          const stepTimeRange =
                            phase === "Planning"
                              ? planningStepTimeRange(step, props.groups, props.spec, props.tickets)
                              : resolveWorkflowStepTimeRange(step, props.groups);
                          const threadCount = step.entries.filter(
                            (entry) => entry.kind === "thread",
                          ).length;
                          const retryableFailure =
                            linkedImplementationRun?.retryableFailure ?? null;
                          const canRetryStep =
                            linkedImplementationRun?.status === "needs-human-attention" &&
                            retryableFailure !== null &&
                            workflowStepMatchesImplementationFailure(
                              step,
                              retryableFailure.stage,
                            ) &&
                            props.onRetryImplementationRun !== undefined;
                          const planningRestartStage =
                            phase === "Planning" && props.workflowRoot.planningWorkflowSummary
                              ? restartablePlanningStage(
                                  step,
                                  props.workflowRoot.planningWorkflowSummary.stage,
                                )
                              : null;
                          const rootSessionBusy =
                            props.workflowRoot.session?.status === "running" ||
                            props.workflowRoot.session?.status === "starting" ||
                            props.workflowRoot.hasPendingApprovals ||
                            props.workflowRoot.hasPendingUserInput;
                          const stepRestart = resolveStepRestart({
                            planningRestartStage,
                            rootSessionBusy,
                            canRetryStep,
                            workflowPaused,
                            isResumeStep: resumeStep?.id === step.id,
                            resumeStepLabel:
                              resumeStep === null ? null : workflowStepTitle(resumeStep),
                            onRestartPlanningStage: props.onRestartPlanningStage,
                            onRetryImplementationRun: props.onRetryImplementationRun,
                            rerunRunStage: rerunRunStageForStep(step),
                            onRerunImplementationStage: props.onRerunImplementationStage,
                            onResumeWorkflow: props.onResumeWorkflow,
                            implementationRunId: linkedImplementationRun?.id ?? null,
                          });
                          // Only a step that owns a run-wide stage has something
                          // to clear; the rest are phases of a thread's own work.
                          const stepClearStage = rerunRunStageForStep(step);
                          const stepClearRunId = linkedImplementationRun?.id ?? null;
                          const onClearStep =
                            stepClearStage === null ||
                            stepClearRunId === null ||
                            props.onResetImplementationStage === undefined
                              ? undefined
                              : () =>
                                  props.onResetImplementationStage?.({
                                    runId: stepClearRunId,
                                    target: { kind: "run", stage: stepClearStage },
                                  });
                          // The workflow root is excluded: stopping it pauses the
                          // whole run, which is what the header's Pause is for.
                          const stepRunningThreadIds = collectRunningStepThreadIds(
                            workflowThreads,
                            step,
                            props.workflowRoot.id,
                          );
                          const stepPause = workflowPauseOf(
                            workflowThreads,
                            collectStepThreads(step, props.workflowRoot.id),
                          );
                          const stepOpen = expandedSteps[step.id] ?? false;
                          const isTicketExecutionStep =
                            group.preset === "planning" &&
                            workflowStepLabel(step).toLowerCase().includes("execute ticket waves");
                          const isCombinedAppReviewStep =
                            workflowStepLabel(step).toLowerCase().includes("app review") &&
                            !isTicketExecutionStep;
                          const combinedAppReviewRuns =
                            linkedImplementationRun === null
                              ? []
                              : props.appReviewWorkflowRuns.filter(
                                  (run) =>
                                    run.caller.type === "implementation" &&
                                    run.caller.implementationRunId === linkedImplementationRun.id &&
                                    run.caller.ticketId === undefined,
                                );
                          const stepStatus = stepStatusOf(step);
                          const stepVisual = STEP_VISUALS[stepStatus];
                          return (
                            <section
                              key={step.id}
                              data-step-status={stepStatus}
                              className={cn("relative px-1 py-1", stepVisual.tintClass)}
                            >
                              <span
                                aria-hidden
                                className={cn(
                                  "absolute inset-y-1 left-0 w-[3px] rounded-full",
                                  stepVisual.railClass,
                                )}
                              />
                              <header className="px-1">
                                <div className="flex items-start gap-1">
                                  <button
                                    type="button"
                                    aria-expanded={stepOpen}
                                    onClick={() =>
                                      setExpandedSteps((current) => ({
                                        ...current,
                                        [step.id]: !stepOpen,
                                      }))
                                    }
                                    className="cursor-pointer flex min-w-0 flex-1 items-start gap-2 rounded-md px-1 py-1.5 text-left hover:bg-accent/40"
                                  >
                                    {stepOpen ? (
                                      <ChevronDown className="mt-0.5 size-3.5 shrink-0" />
                                    ) : (
                                      <ChevronRight className="mt-0.5 size-3.5 shrink-0" />
                                    )}
                                    <StatusDot status={stepStatus} className="mt-1" />
                                    <div className="min-w-0 flex-1">
                                      <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider">
                                        <span className="text-muted-foreground">
                                          Step {index + 1}
                                        </span>
                                        <span aria-hidden className="text-muted-foreground/50">
                                          ·
                                        </span>
                                        <span className={stepVisual.textClass}>
                                          {stepVisual.label}
                                        </span>
                                      </div>
                                      <h4
                                        className={cn(
                                          "truncate text-sm font-semibold",
                                          stepStatus === "skipped"
                                            ? "text-muted-foreground line-through"
                                            : "text-foreground",
                                        )}
                                      >
                                        {workflowStepLabel(step)}
                                      </h4>
                                    </div>
                                  </button>
                                  {step.skillId ? (
                                    <button
                                      type="button"
                                      onClick={() => props.onOpenSkill(step.skillId!)}
                                      className="cursor-pointer mt-1 rounded-full border border-border px-2 py-0.5 font-mono text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground"
                                    >
                                      {workflowSkillLabel(step.skillId, props.skillTitlesById)}
                                    </button>
                                  ) : null}
                                  {isCombinedAppReviewStep ? (
                                    <span className="mt-1 shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
                                      Up to 10 cycles
                                    </span>
                                  ) : step.repeatsAsCycles && step.entries.length > 1 ? (
                                    <span className="mt-1 shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
                                      {step.entries.length} cycles
                                    </span>
                                  ) : threadCount > 1 ? (
                                    <span className="mt-1 shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
                                      {threadCount} threads
                                    </span>
                                  ) : null}
                                  <WorkflowStepSettingsMenu
                                    environmentId={props.workflowRoot.environmentId}
                                    stepLabel={workflowStepTitle(step)}
                                    workflowPromptId={step.skillId}
                                    subSteps={workflowStepSubSteps(group.preset, step)}
                                    pinFor={pinFor}
                                    usesRootThread={step.usesRootThread}
                                    rootModelSelection={props.workflowRoot.modelSelection}
                                    restartLabel={`Start ${workflowStepTitle(step)} again`}
                                    restartDisabledReason={stepRestart.disabledReason}
                                    runningThreadIds={stepRunningThreadIds}
                                    pausedScopeThreadIds={stepPause.scopeThreadIds}
                                    onSetStepModel={props.onSetStepModel}
                                    stepCycles={props.workflowRoot.workflowStepCycles}
                                    defaultStepCycles={props.defaultStepCycles}
                                    onSetStepCycles={props.onSetStepCycles}
                                    stepReviewParts={props.workflowRoot.workflowStepReviewParts}
                                    defaultStepReviewParts={props.defaultStepReviewParts}
                                    onSetStepReviewParts={props.onSetStepReviewParts}
                                    onRestart={stepRestart.run}
                                    onStop={props.onStopThreads}
                                    onResume={props.onResumeThreads}
                                    onClear={onClearStep}
                                    confirmClearMessage={`Clears this step's recorded work for the whole run. Branches and commits stay.`}
                                    skipped={
                                      stepClearStage !== null &&
                                      linkedImplementationRun !== undefined &&
                                      linkedImplementationRun !== null &&
                                      isRunStageSkipped(
                                        linkedImplementationRun.skips,
                                        stepClearStage,
                                      )
                                    }
                                    onSetSkipped={
                                      stepClearStage === null ||
                                      stepClearRunId === null ||
                                      props.onSetImplementationSkip === undefined
                                        ? undefined
                                        : (skipped) =>
                                            props.onSetImplementationSkip?.({
                                              runId: stepClearRunId,
                                              target: { kind: "run", stage: stepClearStage },
                                              skipped,
                                            })
                                    }
                                  />
                                </div>
                                <TimelineTimeRange
                                  {...stepTimeRange}
                                  timestampFormat={props.timestampFormat}
                                  className="mt-1"
                                />
                              </header>
                              {stepOpen &&
                              isTicketExecutionStep &&
                              linkedImplementationRun &&
                              ticketWaveTickets.length > 0 ? (
                                <div className="mt-1 border-t border-border/70 p-1">
                                  <TicketPhases
                                    tickets={ticketWaveTickets}
                                    run={linkedImplementationRun}
                                    environmentId={props.workflowRoot.environmentId}
                                    rootModelSelection={props.workflowRoot.modelSelection}
                                    pinFor={pinFor}
                                    onSetStepModel={props.onSetStepModel}
                                    onRerunAppReviewPhase={props.onRerunAppReviewPhase}
                                    onRerunTicketStage={
                                      props.onRerunImplementationStage === undefined
                                        ? undefined
                                        : ({ ticketId, stage }) =>
                                            props.onRerunImplementationStage?.({
                                              runId: linkedImplementationRun.id,
                                              target: { kind: "ticket", ticketId, stage },
                                            })
                                    }
                                    onResetTicketStage={
                                      props.onResetImplementationStage === undefined
                                        ? undefined
                                        : ({ ticketId, stage }) =>
                                            props.onResetImplementationStage?.({
                                              runId: linkedImplementationRun.id,
                                              target: { kind: "ticket", ticketId, stage },
                                            })
                                    }
                                    onStopThreads={props.onStopThreads}
                                    onResumeThreads={props.onResumeThreads}
                                    skips={linkedImplementationRun.skips}
                                    onSetTicketSkip={
                                      props.onSetImplementationSkip === undefined
                                        ? undefined
                                        : ({ ticketId, stage, skipped }) =>
                                            props.onSetImplementationSkip?.({
                                              runId: linkedImplementationRun.id,
                                              target:
                                                stage === undefined
                                                  ? { kind: "ticket", ticketId }
                                                  : { kind: "ticket", ticketId, stage },
                                              skipped,
                                            })
                                    }
                                    threads={workflowThreads}
                                    appReviewWorkflowRuns={props.appReviewWorkflowRuns}
                                    onOpenThread={props.onOpenThread}
                                    onOpenAppReview={props.onOpenAppReview}
                                    activeThreadKey={props.activeThreadKey}
                                    timestampFormat={props.timestampFormat}
                                  />
                                </div>
                              ) : stepOpen &&
                                isCombinedAppReviewStep &&
                                combinedAppReviewRuns.length > 0 ? (
                                <AppReviewRunsTimeline
                                  runs={combinedAppReviewRuns}
                                  onStopThreads={props.onStopThreads}
                                  onResumeThreads={props.onResumeThreads}
                                  callerBusyReason={
                                    stepRunningThreadIds.length > 0
                                      ? "This step has an agent working in the same worktree. Stop it before starting a phase again."
                                      : null
                                  }
                                  environmentId={props.workflowRoot.environmentId}
                                  rootModelSelection={props.workflowRoot.modelSelection}
                                  pinFor={pinFor}
                                  onSetStepModel={props.onSetStepModel}
                                  onRerunAppReviewPhase={props.onRerunAppReviewPhase}
                                  threads={workflowThreads}
                                  onOpenThread={props.onOpenThread}
                                  activeThreadKey={props.activeThreadKey}
                                  timestampFormat={props.timestampFormat}
                                />
                              ) : stepOpen && step.entries.length === 0 ? (
                                <div className="px-2 py-1 text-[11px] text-muted-foreground/55">
                                  Not started
                                </div>
                              ) : stepOpen ? (
                                <div className="space-y-0.5">
                                  {step.entries.length > VISIBLE_STAGE_THREADS &&
                                  !(expandedStepEntries[step.id] ?? false) ? (
                                    <button
                                      type="button"
                                      onClick={() =>
                                        setExpandedStepEntries((current) => ({
                                          ...current,
                                          [step.id]: true,
                                        }))
                                      }
                                      className="cursor-pointer w-full rounded px-2 py-1 text-left text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground"
                                    >
                                      Show {step.entries.length - VISIBLE_STAGE_THREADS} earlier
                                      entr
                                      {step.entries.length - VISIBLE_STAGE_THREADS === 1
                                        ? "y"
                                        : "ies"}
                                    </button>
                                  ) : null}
                                  {visibleStepEntries(
                                    step,
                                    expandedStepEntries[step.id] ?? false,
                                  ).map(({ entry, entryIndex }) => {
                                    const cycleLabel = step.repeatsAsCycles
                                      ? `Cycle ${entryIndex + 1}`
                                      : undefined;
                                    return entry.kind === "thread" ? (
                                      <div key={entry.id}>
                                        {cycleLabel ? (
                                          <div className="px-2 pt-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
                                            {cycleLabel}
                                          </div>
                                        ) : null}
                                        <ThreadRow
                                          row={entry.row}
                                          timestampFormat={props.timestampFormat}
                                          activeThreadKey={props.activeThreadKey}
                                          onOpenThread={props.onOpenThread}
                                        />
                                      </div>
                                    ) : (
                                      <button
                                        key={entry.id}
                                        type="button"
                                        onClick={() => {
                                          const thread = entry.group.rows[0]?.thread;
                                          if (thread) props.onOpenThread(thread);
                                        }}
                                        className="cursor-pointer flex w-full items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-accent/60"
                                      >
                                        <span className="min-w-0 flex-1 truncate text-sm font-medium">
                                          {cycleLabel ?? groupTitle(entry.group)}
                                        </span>
                                        <ArrowUpRight className="size-3.5 text-muted-foreground" />
                                      </button>
                                    );
                                  })}
                                </div>
                              ) : null}
                            </section>
                          );
                        })}
                      </div>
                      {phase === "Planning" ? (
                        <PlanningArtifacts
                          spec={props.spec}
                          tickets={props.tickets}
                          onOpenSpec={() => {
                            if (props.spec) {
                              setOpenPlanningArtifact({
                                title: props.spec.title,
                                markdown: props.spec.summaryMarkdown,
                              });
                            }
                          }}
                          onOpenTicket={(ticket) =>
                            setOpenPlanningArtifact({
                              title: `${ticket.key ?? `Ticket ${ticket.ordinal + 1}`} · ${ticket.title}`,
                              markdown: ticket.bodyMarkdown,
                            })
                          }
                        />
                      ) : null}
                    </div>
                  ) : null}
                </section>
              );
            })}
          </div>
        ) : null}
      </section>
      <Dialog
        open={openPlanningArtifact !== null}
        onOpenChange={(open) => {
          if (!open) setOpenPlanningArtifact(null);
        }}
      >
        <DialogPopup className="w-[min(52rem,calc(100vw-2rem))] max-w-none">
          <DialogHeader>
            <DialogTitle>{openPlanningArtifact?.title ?? "Planning document"}</DialogTitle>
            <DialogDescription>Durable workflow artifact</DialogDescription>
          </DialogHeader>
          <DialogPanel className="max-h-[70vh]">
            <ChatMarkdown text={openPlanningArtifact?.markdown ?? ""} cwd={undefined} />
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </div>
  );
}

export function WorkflowsPanel(props: {
  readonly workflow: WorkflowRoot<EnvironmentThreadShell> | null;
  readonly activeThreadKey: string | null;
  readonly focusedWorkflowId: string | null;
  readonly timestampFormat: TimestampFormat;
  readonly appReviewWorkflowRuns: readonly AppReviewWorkflowRun[];
  readonly implementationRuns: readonly OrchestrationImplementationRun[];
  readonly tickets: readonly OrchestrationPlanningTicket[];
  readonly spec: OrchestrationPlanningSpec | null;
  readonly skillTitlesById: ReadonlyMap<string, string>;
  readonly onOpenSkill: (skillId: string) => void;
  readonly onOpenThread: (thread: EnvironmentThreadShell) => void;
  readonly onOpenAppReview: () => void;
  readonly onCopyWorkflowLink: (workflowId: string) => void;
  readonly onRetryImplementationRun?: ((runId: string) => void) | undefined;
  readonly onRerunImplementationStage?:
    | ((input: {
        readonly runId: string;
        readonly target: OrchestrationImplementationRerunTarget;
      }) => void)
    | undefined;
  readonly onResetImplementationStage?:
    | ((input: {
        readonly runId: string;
        readonly target: OrchestrationImplementationRerunTarget;
      }) => void)
    | undefined;
  readonly onSetImplementationSkip?:
    | ((input: {
        readonly runId: string;
        readonly target: OrchestrationImplementationSkipTarget;
        readonly skipped: boolean;
      }) => void)
    | undefined;
  readonly onRerunAppReviewPhase?:
    | ((input: { readonly appReviewRunId: string; readonly phase: AppReviewWorkflowPhase }) => void)
    | undefined;
  readonly onRestartPlanningStage?: ((stage: RestartablePlanningStage) => void) | undefined;
  readonly onResumeWorkflow?: (() => void) | undefined;
  readonly onPauseWorkflow?: (() => void) | undefined;
  readonly onSetStepModel?: SetWorkflowStepModel | undefined;
  readonly defaultStepCycles?: ReadonlyArray<WorkflowStepCycleOverride> | undefined;
  readonly onSetStepCycles?: SetWorkflowStepCycles | undefined;
  readonly defaultStepReviewParts?: ReadonlyArray<WorkflowStepReviewPartsOverride> | undefined;
  readonly onSetStepReviewParts?: SetWorkflowStepReviewParts | undefined;
  readonly onStopThreads?: ((threadIds: readonly ThreadId[]) => void) | undefined;
  readonly onResumeThreads?: ((threadIds: readonly ThreadId[]) => void) | undefined;
}) {
  const groups = props.workflow?.groups ?? [];
  const focusedGroupRef = useRef<HTMLElement>(null);
  const [expandedById, setExpandedById] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (props.focusedWorkflowId === null) return;
    const focusedGroup = groups.find(
      (group) => group.kind === "workflow" && group.sourceId === props.focusedWorkflowId,
    );
    if (!focusedGroup) return;
    const groupById = new Map(groups.map((group) => [group.id, group] as const));
    const expandedAncestors: Record<string, boolean> = {};
    let currentGroup: WorkflowGroup<EnvironmentThreadShell> | undefined = focusedGroup;
    while (currentGroup) {
      expandedAncestors[currentGroup.id] = true;
      currentGroup =
        currentGroup.parentGroupId === null ? undefined : groupById.get(currentGroup.parentGroupId);
    }
    setExpandedById((current) => ({ ...current, ...expandedAncestors }));
    const frame = window.requestAnimationFrame(() => {
      focusedGroupRef.current?.scrollIntoView({ block: "nearest" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [groups, props.focusedWorkflowId]);

  if (!props.workflow) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-8 text-center">
        <div className="max-w-xs">
          <GitFork className="mx-auto size-5 text-muted-foreground" />
          <h3 className="mt-3 text-sm font-medium">No workflow runs</h3>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            This workflow may have been removed.
          </p>
        </div>
      </div>
    );
  }

  const workflow = props.workflow;
  const rootTimeRange = resolveWorkflowThreadTimeRange(workflow.root);

  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="p-3">
        {groups.length > 0 ? (
          <div className="mb-3 rounded-lg border border-border/80 bg-card p-2">
            <div className="mb-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              Interaction modes
            </div>
            <div className="flex gap-2 overflow-x-auto pb-1">
              {groups
                .filter((group) => group.parentGroupId === null)
                .map((group) => {
                  const chipStatus =
                    workflow.root.workflowPausedAt != null
                      ? "paused"
                      : threadStatusAsStepStatus(groupStatus(group));
                  const activeStep = buildWorkflowSteps(group, groups, workflow.root).find((step) =>
                    step.entries.some((entry) =>
                      entry.kind === "thread"
                        ? resolveWorkflowThreadStatus(entry.row.thread) === "working"
                        : entry.group.isActive,
                    ),
                  );
                  return (
                    <button
                      key={group.id}
                      type="button"
                      onClick={() => {
                        setExpandedById((current) => ({ ...current, [group.id]: true }));
                        document
                          .querySelector(`[data-workflow-group="${CSS.escape(group.id)}"]`)
                          ?.scrollIntoView({ block: "nearest" });
                      }}
                      className="cursor-pointer flex min-w-36 shrink-0 items-start gap-2 rounded-md border border-border/70 px-2.5 py-2 text-left hover:bg-accent"
                    >
                      <StatusDot status={chipStatus} className="mt-1" />
                      <span className="min-w-0">
                        <span className="block truncate text-xs font-medium">
                          {groupTitle(group)}
                        </span>
                        <span
                          className={cn(
                            "block truncate text-[10px]",
                            activeStep === undefined
                              ? STEP_VISUALS[chipStatus].textClass
                              : "text-muted-foreground",
                          )}
                        >
                          {activeStep
                            ? `${workflowStepPhase(activeStep)} · ${workflowStepLabel(activeStep)}`
                            : STEP_VISUALS[chipStatus].label}
                        </span>
                      </span>
                    </button>
                  );
                })}
            </div>
          </div>
        ) : null}
        <div className="mb-3 flex items-start gap-2">
          <button
            type="button"
            onClick={() => props.onOpenThread(workflow.root)}
            className="cursor-pointer flex min-w-0 flex-1 items-start gap-2 rounded-md px-2 py-2 text-left hover:bg-accent/60"
          >
            <GitFork className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1">
              <span className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-sm font-medium">
                  {workflow.root.title}
                </span>
                <span className="shrink-0 text-[11px] text-muted-foreground">Main thread</span>
              </span>
              <TimelineTimeRange
                {...rootTimeRange}
                timestampFormat={props.timestampFormat}
                className="mt-1"
              />
            </span>
          </button>
          <WorkflowSettingsMenu
            environmentId={workflow.root.environmentId}
            preset={workflow.root.workflowPreset ?? null}
            pinFor={(key) =>
              (workflow.root.workflowStepModels ?? []).find(
                (entry) => workflowModelPinKey(entry) === workflowModelPinKey(key),
              )?.modelSelection ?? null
            }
            rootModelSelection={workflow.root.modelSelection}
            onSetStepModel={props.onSetStepModel}
            stepCycles={workflow.root.workflowStepCycles}
            defaultStepCycles={props.defaultStepCycles}
            onSetStepCycles={props.onSetStepCycles}
            stepReviewParts={workflow.root.workflowStepReviewParts}
            defaultStepReviewParts={props.defaultStepReviewParts}
            onSetStepReviewParts={props.onSetStepReviewParts}
          />
          {workflow.root.workflowPausedAt == null && props.onPauseWorkflow ? (
            <button
              type="button"
              onClick={props.onPauseWorkflow}
              title="Pause the workflow and stop all active agent sessions"
              className="cursor-pointer mt-1 inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-border/80 px-2 text-xs font-medium hover:bg-accent"
            >
              <Pause className="size-3" aria-hidden /> Pause
            </button>
          ) : workflow.root.workflowPausedAt != null && props.onResumeWorkflow ? (
            <button
              type="button"
              onClick={props.onResumeWorkflow}
              title="Resume the workflow from the step it stopped at, keeping its worktrees"
              className="cursor-pointer mt-1 inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-border/80 px-2 text-xs font-medium hover:bg-accent"
            >
              <Play className="size-3" aria-hidden /> Resume
            </button>
          ) : workflow.root.workflowPausedAt != null ? (
            <span className="mt-1 rounded-md bg-muted px-2 py-1 text-xs font-medium text-muted-foreground">
              Paused
            </span>
          ) : null}
        </div>

        {groups.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border/80 px-3 py-4 text-center">
            <p className="text-xs font-medium">Workflow started</p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              This workflow is running in the main thread. Its stages will appear here as they are
              created.
            </p>
          </div>
        ) : null}

        <div className="space-y-2">
          {groups
            .filter((group) => group.parentGroupId === null)
            .map((group) => (
              <WorkflowGroupCard
                key={group.id}
                group={group}
                groups={groups}
                expandedById={expandedById}
                setExpandedById={setExpandedById}
                focusedWorkflowId={props.focusedWorkflowId}
                focusedGroupRef={focusedGroupRef}
                activeThreadKey={props.activeThreadKey}
                timestampFormat={props.timestampFormat}
                appReviewWorkflowRuns={props.appReviewWorkflowRuns}
                implementationRuns={props.implementationRuns}
                defaultStepCycles={props.defaultStepCycles}
                onSetStepCycles={props.onSetStepCycles}
                defaultStepReviewParts={props.defaultStepReviewParts}
                onSetStepReviewParts={props.onSetStepReviewParts}
                spec={props.spec}
                tickets={props.tickets}
                skillTitlesById={props.skillTitlesById}
                onOpenSkill={props.onOpenSkill}
                workflowRoot={workflow.root}
                onOpenThread={props.onOpenThread}
                onOpenAppReview={props.onOpenAppReview}
                onCopyWorkflowLink={props.onCopyWorkflowLink}
                onRetryImplementationRun={props.onRetryImplementationRun}
                onRerunImplementationStage={props.onRerunImplementationStage}
                onResetImplementationStage={props.onResetImplementationStage}
                onSetImplementationSkip={props.onSetImplementationSkip}
                onRerunAppReviewPhase={props.onRerunAppReviewPhase}
                onRestartPlanningStage={props.onRestartPlanningStage}
                onResumeWorkflow={props.onResumeWorkflow}
                onResumeThreads={props.onResumeThreads}
                onSetStepModel={props.onSetStepModel}
                onStopThreads={props.onStopThreads}
              />
            ))}
        </div>
      </div>
    </ScrollArea>
  );
}
