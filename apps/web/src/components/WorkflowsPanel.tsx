import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type {
  AppReviewWorkflowRun,
  ModelSelection,
  ThreadId,
  OrchestrationImplementationRun,
  OrchestrationPlanningSpec,
  OrchestrationPlanningTicket,
  OrchestrationPlanningWorkflowStage,
  WorkflowPreset,
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
  resolveWorkflowGroupTimeRange,
  resolveWorkflowStepTimeRange,
  resolveWorkflowThreadTimeRange,
  resolveWorkflowThreadStatus,
  workflowStatusIsActive,
  workflowStepMatchesImplementationFailure,
  workflowThreadKey,
  type WorkflowGroup,
  type WorkflowRoot,
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
import { WorkflowModelsMenu } from "./WorkflowModelsMenu";
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
  return {
    run: undefined,
    disabledReason: "This workflow cannot re-enter this step on its own.",
  };
}

/** Threads of a step that are still live, excluding the workflow root. */
function collectRunningStepThreadIds(
  step: WorkflowTimelineStep<EnvironmentThreadShell>,
  rootThreadId: string,
): readonly ThreadId[] {
  const ids = new Set<ThreadId>();
  const consider = (thread: EnvironmentThreadShell) => {
    if (thread.id === rootThreadId) return;
    if (!workflowStatusIsActive(resolveWorkflowThreadStatus(thread))) return;
    ids.add(thread.id);
  };
  for (const entry of step.entries) {
    if (entry.kind === "thread") consider(entry.row.thread);
    else for (const row of entry.group.rows) consider(row.thread);
  }
  return [...ids];
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

function TicketAppReviewCycles(props: {
  readonly run: AppReviewWorkflowRun;
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

  return (
    <div className="space-y-2 pt-1">
      {props.run.cycles
        .toSorted((left, right) => left.cycleNumber - right.cycleNumber)
        .map((cycle) => {
          const steps = [
            {
              label: "App review",
              detail:
                cycle.reviewVerdict ?? (cycle.status === "reviewing" ? "in progress" : "pending"),
              thread: threadRow(cycle.reviewerThreadId),
            },
            {
              label: "Gap analysis & repair tickets",
              detail: cycle.repairTickets?.length
                ? `${cycle.repairTickets.length} ticket${cycle.repairTickets.length === 1 ? "" : "s"}`
                : cycle.status === "planning"
                  ? "in progress"
                  : "pending",
              thread: threadRow(cycle.reviewerThreadId),
            },
            {
              label: "Fix the problem",
              detail:
                cycle.fixResult?.status ?? (cycle.status === "fixing" ? "in progress" : "pending"),
              thread: threadRow(cycle.fixerThreadId),
            },
          ];
          return (
            <article
              key={cycle.cycleNumber}
              className="rounded-md border border-border/70 bg-background/60 p-2"
            >
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-[11px] font-medium">
                  Cycle {cycle.cycleNumber} of {props.run.cycleBudget}
                </span>
                <span className="text-[10px] capitalize text-muted-foreground">
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
                {steps.map((step, index) => (
                  <li key={step.label} className="relative">
                    <span className="absolute -left-[1.05rem] top-0.5 flex size-3.5 items-center justify-center rounded-full border border-border bg-background text-[8px] text-muted-foreground">
                      {index + 1}
                    </span>
                    <div className="text-[10px]">
                      <span className="font-medium text-foreground">{step.label}</span>
                      <span className="capitalize text-muted-foreground"> · {step.detail}</span>
                    </div>
                    {step.thread}
                  </li>
                ))}
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

function TicketPhases(props: {
  readonly tickets: readonly OrchestrationPlanningTicket[];
  readonly run: OrchestrationImplementationRun;
  readonly threads: readonly EnvironmentThreadShell[];
  readonly appReviewWorkflowRuns: readonly AppReviewWorkflowRun[];
  readonly onOpenThread: (thread: EnvironmentThreadShell) => void;
  readonly onOpenAppReview: () => void;
  readonly activeThreadKey: string | null;
  readonly timestampFormat: TimestampFormat;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const states = new Map(props.run.ticketStates.map((state) => [state.ticketId, state] as const));
  return (
    <div className="space-y-2">
      {buildTicketWaves(
        props.tickets.filter((ticket) => props.run.planningTicketIds.includes(ticket.id)),
      ).map((wave, waveIndex) => (
        <section
          key={wave.map((ticket) => ticket.id).join(":")}
          className="rounded-md border border-border/70 bg-background/40 p-2"
        >
          <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            Wave {waveIndex + 1} · {wave.length} ticket{wave.length === 1 ? "" : "s"}
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
            return (
              <div key={ticket.id} className="border-t border-border/60 first:border-t-0">
                <button
                  type="button"
                  aria-expanded={open}
                  onClick={() => setExpanded((current) => ({ ...current, [ticket.id]: !open }))}
                  className="cursor-pointer flex w-full items-center gap-2 py-2 text-left"
                >
                  {open ? (
                    <ChevronDown className="size-3.5" />
                  ) : (
                    <ChevronRight className="size-3.5" />
                  )}
                  <span className="min-w-0 flex-1 truncate text-xs font-medium">
                    {ticket.key ?? `Ticket ${ticket.ordinal + 1}`} · {ticket.title}
                  </span>
                  <span className="text-[10px] capitalize text-muted-foreground">
                    {state?.status ?? ticket.status}
                  </span>
                </button>
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
                      {stages.map((stage, stageIndex) => (
                        <section key={stage.label} className="relative">
                          <span className="absolute -left-[1.05rem] top-1 flex size-4 items-center justify-center rounded-full border border-border bg-background text-[9px] font-medium text-muted-foreground">
                            {stageIndex + 1}
                          </span>
                          <div className="mb-1 flex items-center gap-1.5 text-[11px]">
                            <span className="font-medium text-foreground">{stage.label}</span>
                            <span className="capitalize text-muted-foreground">
                              · {stage.detail}
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
                          </div>
                          {stage.label === "App Review" && appReviewRun ? (
                            <TicketAppReviewCycles
                              run={appReviewRun}
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
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })}
        </section>
      ))}
    </div>
  );
}

function implementationRunForGroup(
  group: WorkflowGroup<EnvironmentThreadShell>,
  runs: readonly OrchestrationImplementationRun[],
): OrchestrationImplementationRun | null {
  const directlyLinked =
    runs.find(
      (run) =>
        run.id === group.sourceId ||
        run.appReviewWorkflowRunIds.some((runId) => runId === group.sourceId) ||
        group.rows.some((row) => row.thread.id === run.orchestratorThreadId),
    ) ?? null;
  if (directlyLinked !== null) return directlyLinked;
  if (group.preset !== "planning") return null;
  return runs.toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] ?? null;
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
  readonly onRestartPlanningStage?: ((stage: RestartablePlanningStage) => void) | undefined;
  readonly onResumeWorkflow?: (() => void) | undefined;
  readonly onSetStepModel?: SetWorkflowStepModel | undefined;
  readonly onStopThreads?: ((threadIds: readonly ThreadId[]) => void) | undefined;
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
  const linkedImplementationRun = implementationRunForGroup(group, props.implementationRuns);
  const status =
    linkedImplementationRun?.status === "needs-human-attention"
      ? "failed"
      : linkedAppReviewRun === null
        ? groupStatus(group)
        : runPresentation.status;
  const visual = STATUS_VISUALS[status];
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
  // Pausing settles the whole workflow, so a resume is workflow-wide. Only the
  // step the run actually stopped at offers it, so "Start step again" never
  // claims to restart a step the runtime would skip.
  const workflowPaused = props.workflowRoot.settledOverride === "settled";
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
                <span className="min-w-0 flex-1 truncate text-sm font-medium">
                  {props.cycleLabel ?? groupTitle(group)}
                </span>
                <span className={cn("text-[11px]", visual.textClass)}>
                  {runPresentation.label ?? visual.label}
                </span>
              </span>
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
              const runningStep = availableSteps.find((step) =>
                step.entries.some((entry) =>
                  entry.kind === "thread"
                    ? resolveWorkflowThreadStatus(entry.row.thread) === "working"
                    : entry.group.isActive,
                ),
              );
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
                    <span className="min-w-0 flex-1 text-xs font-semibold">{phase}</span>
                    <span className="max-w-[55%] truncate text-[10px] text-muted-foreground">
                      {runningStep
                        ? workflowStepLabel(runningStep)
                        : `${availableSteps.length} steps`}
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
                          const planningProgress =
                            phase === "Planning" && props.workflowRoot.planningWorkflowSummary
                              ? planningStepProgress(
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
                            onResumeWorkflow: props.onResumeWorkflow,
                            implementationRunId: linkedImplementationRun?.id ?? null,
                          });
                          // The workflow root is excluded: stopping it pauses the
                          // whole run, which is what the header's Pause is for.
                          const stepRunningThreadIds = collectRunningStepThreadIds(
                            step,
                            props.workflowRoot.id,
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
                          return (
                            <section key={step.id} className="px-1 py-1">
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
                                    <div className="min-w-0 flex-1">
                                      <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                                        Step {index + 1}
                                      </div>
                                      <h4 className="truncate text-sm font-semibold text-foreground">
                                        {workflowStepLabel(step)}
                                      </h4>
                                      {planningProgress ? (
                                        <div className="mt-0.5 text-[10px] text-muted-foreground">
                                          {planningProgress}
                                        </div>
                                      ) : null}
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
                                    onSetStepModel={props.onSetStepModel}
                                    onRestart={stepRestart.run}
                                    onStop={props.onStopThreads}
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
                              props.tickets.length > 0 ? (
                                <div className="mt-1 border-t border-border/70 p-1">
                                  <TicketPhases
                                    tickets={props.tickets}
                                    run={linkedImplementationRun}
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
  readonly onRestartPlanningStage?: ((stage: RestartablePlanningStage) => void) | undefined;
  readonly onResumeWorkflow?: (() => void) | undefined;
  readonly onPauseWorkflow?: (() => void) | undefined;
  readonly onSetStepModel?: SetWorkflowStepModel | undefined;
  readonly onStopThreads?: ((threadIds: readonly ThreadId[]) => void) | undefined;
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
                  const status = groupStatus(group);
                  const visual = STATUS_VISUALS[status];
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
                      <span className={cn("mt-1 size-2 shrink-0 rounded-full", visual.dotClass)} />
                      <span className="min-w-0">
                        <span className="block truncate text-xs font-medium">
                          {groupTitle(group)}
                        </span>
                        <span className="block truncate text-[10px] text-muted-foreground">
                          {activeStep
                            ? `${workflowStepPhase(activeStep)} · ${workflowStepLabel(activeStep)}`
                            : visual.label}
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
          <WorkflowModelsMenu
            environmentId={workflow.root.environmentId}
            preset={workflow.root.workflowPreset ?? null}
            pinFor={(key) =>
              (workflow.root.workflowStepModels ?? []).find(
                (entry) => workflowModelPinKey(entry) === workflowModelPinKey(key),
              )?.modelSelection ?? null
            }
            rootModelSelection={workflow.root.modelSelection}
            onSetStepModel={props.onSetStepModel}
          />
          {workflow.root.settledOverride !== "settled" && props.onPauseWorkflow ? (
            <button
              type="button"
              onClick={props.onPauseWorkflow}
              title="Pause the workflow and stop all active agent sessions"
              className="cursor-pointer mt-1 inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-border/80 px-2 text-xs font-medium hover:bg-accent"
            >
              <Pause className="size-3" aria-hidden /> Pause
            </button>
          ) : workflow.root.settledOverride === "settled" && props.onResumeWorkflow ? (
            <button
              type="button"
              onClick={props.onResumeWorkflow}
              title="Resume the workflow from the step it stopped at, keeping its worktrees"
              className="cursor-pointer mt-1 inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-border/80 px-2 text-xs font-medium hover:bg-accent"
            >
              <Play className="size-3" aria-hidden /> Resume
            </button>
          ) : workflow.root.settledOverride === "settled" ? (
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
                spec={props.spec}
                tickets={props.tickets}
                skillTitlesById={props.skillTitlesById}
                onOpenSkill={props.onOpenSkill}
                workflowRoot={workflow.root}
                onOpenThread={props.onOpenThread}
                onOpenAppReview={props.onOpenAppReview}
                onCopyWorkflowLink={props.onCopyWorkflowLink}
                onRetryImplementationRun={props.onRetryImplementationRun}
                onRestartPlanningStage={props.onRestartPlanningStage}
                onResumeWorkflow={props.onResumeWorkflow}
                onSetStepModel={props.onSetStepModel}
                onStopThreads={props.onStopThreads}
              />
            ))}
        </div>
      </div>
    </ScrollArea>
  );
}
