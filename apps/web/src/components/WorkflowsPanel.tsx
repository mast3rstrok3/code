import { TicketTestPlatformPicker } from "./ReviewTestPlatformPicker";
import { TicketAppStackPicker } from "./TicketAppStackPicker";
import {
  FINAL_REGRESSION_MAX_CYCLES,
  isRunStageSkipped,
  isTicketSkipped,
  isTicketStageSkipped,
} from "@t3tools/contracts";
import { NativeVerificationPanel } from "./NativeVerificationPanel";
import type { EnvironmentWorkflowThreadShell } from "@t3tools/client-runtime/state/models";
import type {
  AppReviewWorkflowCycle,
  AppReviewWorkflowPhase,
  AppReviewWorkflowRun,
  EnvironmentId,
  GrillAnswerer,
  ModelSelection,
  OrchestrationImplementationRerunTarget,
  OrchestrationImplementationRerunTicketStage,
  OrchestrationImplementationSkipTarget,
  ThreadId,
  OrchestrationImplementationRun,
  OrchestrationPlanningSpec,
  OrchestrationPlanningTicket,
  WorkflowStepCycleOverride,
  WorkflowStepModelOverride,
  WorkflowStepReviewPartsOverride,
  WorkflowStageExecution,
} from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import { resolveWorkflowStepCycleBudget } from "@t3tools/shared/workflowStepCycles";
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
  useCallback,
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
  buildTicketWaves,
  implementationTicketStageDetails,
  resolveGroupImplementationRun,
  resolveWorkflowPhaseStatus,
  resolveWorkflowStageDetailStatus,
  resolveWorkflowStepRollup,
  resolveWorkflowStepTimeRange,
  resolveWorkflowThreadTimeRange,
  resolveWorkflowThreadStatus,
  resolveWorkflowTicketStatus,
  workflowCurrentPathScrollTarget,
  workflowStepCanRetryImplementationFailure,
  workflowThreadKey,
  type WorkflowGroup,
  type WorkflowCurrentPath,
  type WorkflowRoot,
  type WorkflowStepStatus,
  type WorkflowTimelineStep,
  type WorkflowThreadStatus,
} from "@t3tools/client-runtime/workflow-model";
import {
  appReviewRunActiveThreadIsBusy,
  collectRunningStepThreadIds,
  collectStepThreads,
  elapsedBetween,
  groupTitle,
  groupWorkflowStepsByPhase,
  implementationRunWorkflowIds,
  planningStepTimeRange,
  rerunRunStageForStep,
  resolveStepRestart,
  resolveWorkflowGroupCurrentPath,
  resolveWorkflowGroupState,
  type RestartablePlanningStage,
  restartablePlanningStage,
  runningThreadIdsOf,
  skipRunStageForStep,
  TICKET_PROGRESS_SEGMENT_BY_STATUS,
  type TicketProgressSegment,
  ticketReviewOutcome,
  workflowPauseOf,
  workflowRoleShortLabel,
  workflowSkillLabel,
  workflowStepLabel,
  workflowStepPhase,
  workflowStepSubSteps,
  workflowStepTitle,
  workflowTicketStatuses,
  WORKFLOW_STEP_STATUS_LABELS,
  WORKFLOW_THREAD_STATUS_LABELS,
} from "@t3tools/client-runtime/workflow-panel";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
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
} from "@t3tools/client-runtime/workflow-step-models";
import { basenameOfPath } from "~/pierre-icons";

const STATUS_VISUALS: Record<
  WorkflowThreadStatus,
  { readonly dotClass: string; readonly textClass: string }
> = {
  working: {
    dotClass: "bg-sky-500",
    textClass: "text-sky-600 dark:text-sky-400",
  },
  monitoring: {
    dotClass: "bg-sky-500",
    textClass: "text-sky-600 dark:text-sky-400",
  },
  approval: {
    dotClass: "bg-amber-500",
    textClass: "text-amber-700 dark:text-amber-300",
  },
  input: {
    dotClass: "bg-indigo-500",
    textClass: "text-indigo-600 dark:text-indigo-300",
  },
  completed: {
    dotClass: "bg-emerald-500",
    textClass: "text-emerald-700 dark:text-emerald-300",
  },
  failed: { dotClass: "bg-red-500", textClass: "text-red-700 dark:text-red-300" },
  stopped: {
    dotClass: "bg-muted-foreground/60",
    textClass: "text-muted-foreground",
  },
  archived: {
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
    readonly dotClass: string;
    readonly textClass: string;
    readonly railClass: string;
    readonly tintClass: string;
  }
> = {
  running: {
    dotClass: "bg-sky-500",
    textClass: "text-sky-600 dark:text-sky-400",
    railClass: "bg-sky-500",
    tintClass: "bg-sky-500/5",
  },
  awaiting: {
    dotClass: "bg-amber-500",
    textClass: "text-amber-700 dark:text-amber-300",
    railClass: "bg-amber-500",
    tintClass: "bg-amber-500/5",
  },
  blocked: {
    dotClass: "bg-red-500",
    textClass: "text-red-700 dark:text-red-300",
    railClass: "bg-red-500",
    tintClass: "bg-red-500/5",
  },
  failed: {
    dotClass: "bg-red-500",
    textClass: "text-red-700 dark:text-red-300",
    railClass: "bg-red-500/60",
    tintClass: "",
  },
  paused: {
    dotClass: "bg-violet-500",
    textClass: "text-violet-600 dark:text-violet-300",
    railClass: "bg-violet-500",
    tintClass: "bg-violet-500/5",
  },
  stopped: {
    dotClass: "bg-muted-foreground/60",
    textClass: "text-muted-foreground",
    railClass: "bg-muted-foreground/40",
    tintClass: "",
  },
  queued: {
    dotClass: "border border-muted-foreground/60 bg-muted-foreground/20",
    textClass: "text-muted-foreground",
    railClass: "bg-border",
    tintClass: "",
  },
  skipped: {
    dotClass: "border border-dashed border-muted-foreground/60",
    textClass: "text-muted-foreground/70",
    railClass: "bg-transparent",
    tintClass: "",
  },
  pending: {
    dotClass: "border border-muted-foreground/50",
    textClass: "text-muted-foreground/70",
    railClass: "bg-transparent",
    tintClass: "",
  },
  done: {
    dotClass: "bg-emerald-500",
    textClass: "text-emerald-700 dark:text-emerald-300",
    railClass: "bg-emerald-500/50",
    tintClass: "",
  },
};

type WorkflowDisclosureState = Readonly<Record<string, boolean>>;

interface WorkflowDisclosureControls {
  readonly expanded: WorkflowDisclosureState;
  readonly toggle: (id: string) => void;
}

interface WorkflowNavigationRequest {
  readonly id: number;
  readonly path: WorkflowCurrentPath;
}

const workflowGroupDisclosureId = (groupId: string) => `group:${groupId}`;
const workflowPhaseDisclosureId = (groupId: string, phase: string) => `phase:${groupId}:${phase}`;
const workflowStepDisclosureId = (groupId: string, stepId: string) => `step:${groupId}:${stepId}`;
const workflowTicketDisclosureId = (groupId: string, ticketId: string) =>
  `ticket:${groupId}:${ticketId}`;
const workflowTicketStageDisclosureId = (
  groupId: string,
  ticketId: string,
  stage: NonNullable<WorkflowCurrentPath["ticketStage"]>,
) => `ticket-stage:${groupId}:${ticketId}:${stage}`;
const workflowAppReviewCycleDisclosureId = (groupId: string, runId: string, cycleNumber: number) =>
  `app-review-cycle:${groupId}:${runId}:${String(cycleNumber)}`;
const workflowAppReviewPhaseDisclosureId = (
  groupId: string,
  runId: string,
  cycleNumber: number,
  phase: NonNullable<WorkflowCurrentPath["appReviewPhase"]>,
) => `app-review-phase:${groupId}:${runId}:${String(cycleNumber)}:${phase}`;
const workflowCodeReviewCycleDisclosureId = (
  groupId: string,
  ticketId: string,
  cycleNumber: number,
) => `code-review-cycle:${groupId}:${ticketId}:${String(cycleNumber)}`;
const workflowRepairTicketDisclosureId = (
  groupId: string,
  runId: string,
  cycleNumber: number,
  ticketKey: string,
) => `repair-ticket:${groupId}:${runId}:${String(cycleNumber)}:${ticketKey}`;
const workflowGapsDisclosureId = (groupId: string, runId: string, cycleNumber: number) =>
  `gaps:${groupId}:${runId}:${String(cycleNumber)}`;

/** Every disclosure an explicit current-work navigation should reveal. */
export function workflowDisclosureIdsForCurrentPath(path: WorkflowCurrentPath): readonly string[] {
  const ids = [
    workflowGroupDisclosureId(path.groupId),
    workflowPhaseDisclosureId(path.groupId, path.phase),
  ];
  if (path.stepId !== null) ids.push(workflowStepDisclosureId(path.groupId, path.stepId));
  if (path.ticketId !== null) {
    ids.push(workflowTicketDisclosureId(path.groupId, path.ticketId));
    if (path.ticketStage !== null) {
      ids.push(workflowTicketStageDisclosureId(path.groupId, path.ticketId, path.ticketStage));
    }
    if (path.ticketStage === "code-review" && path.cycleNumber !== null) {
      ids.push(workflowCodeReviewCycleDisclosureId(path.groupId, path.ticketId, path.cycleNumber));
    }
  }
  if (path.appReviewRunId !== null && path.cycleNumber !== null) {
    ids.push(
      workflowAppReviewCycleDisclosureId(path.groupId, path.appReviewRunId, path.cycleNumber),
    );
    if (path.appReviewPhase !== null) {
      ids.push(
        workflowAppReviewPhaseDisclosureId(
          path.groupId,
          path.appReviewRunId,
          path.cycleNumber,
          path.appReviewPhase,
        ),
      );
    }
  }
  return ids;
}

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

function elapsedUntilNow(startedAt: string, endedAt: string | null): string {
  return elapsedBetween(startedAt, endedAt, Date.now());
}

function Elapsed(props: { readonly startedAt: string; readonly endedAt: string | null }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (props.endedAt !== null) return;
    const update = () => {
      if (ref.current) ref.current.textContent = elapsedUntilNow(props.startedAt, null);
    };
    update();
    const interval = window.setInterval(update, 1_000);
    return () => window.clearInterval(interval);
  }, [props.endedAt, props.startedAt]);
  return (
    <span ref={ref} className="tabular-nums">
      {elapsedUntilNow(props.startedAt, props.endedAt)}
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
        "flex flex-wrap items-center gap-x-2 gap-y-0.5 text-3xs leading-4 text-muted-foreground",
        props.className,
      )}
    >
      <span className="whitespace-nowrap">
        <span className="mr-1 uppercase tracking-wide text-muted-foreground/70">Start</span>
        <Tooltip>
          <TooltipTrigger
            render={<time dateTime={props.startedAt} className="tabular-nums text-foreground/80" />}
          >
            {start}
          </TooltipTrigger>
          <TooltipPopup>
            {formatChatTimestampTooltip(props.startedAt, props.timestampFormat)}
          </TooltipPopup>
        </Tooltip>
      </span>
      <span className="whitespace-nowrap">
        <span className="mr-1 uppercase tracking-wide text-muted-foreground/70">End</span>
        {props.endedAt === null ? (
          <span className="text-foreground/80">{end}</span>
        ) : (
          <Tooltip>
            <TooltipTrigger
              render={<time dateTime={props.endedAt} className="tabular-nums text-foreground/80" />}
            >
              {end}
            </TooltipTrigger>
            <TooltipPopup>
              {formatChatTimestampTooltip(props.endedAt, props.timestampFormat)}
            </TooltipPopup>
          </Tooltip>
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

function ThreadRow(props: {
  readonly row: WorkflowGroup<EnvironmentWorkflowThreadShell>["rows"][number];
  readonly timestampFormat: TimestampFormat;
  readonly activeThreadKey: string | null;
  readonly onOpenThread: (thread: EnvironmentWorkflowThreadShell) => void;
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
      data-workflow-current-target={row.thread.id}
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
          <span className={cn("shrink-0 text-2xs", visual.textClass)}>
            {WORKFLOW_THREAD_STATUS_LABELS[status]}
          </span>
        </span>
        <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-2xs text-muted-foreground">
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

function PlanningArtifacts(props: {
  readonly spec: OrchestrationPlanningSpec | null;
  readonly tickets: readonly OrchestrationPlanningTicket[];
  readonly onOpenSpec: () => void;
  readonly onOpenTicket: (ticket: OrchestrationPlanningTicket) => void;
}) {
  if (props.spec === null && props.tickets.length === 0) return null;
  return (
    <section className="border-t border-border/70 p-2">
      <div className="mb-2 px-1 text-3xs font-medium uppercase tracking-wider text-muted-foreground">
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
  e2e: { workflowPromptId: "implementation.e2e-app-review.codex" },
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
  readonly activeThread: EnvironmentWorkflowThreadShell | undefined;
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

export function TicketAppReviewCycles(props: {
  readonly groupId: string;
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
  readonly threads: readonly EnvironmentWorkflowThreadShell[];
  readonly onOpenThread: (thread: EnvironmentWorkflowThreadShell) => void;
  readonly activeThreadKey: string | null;
  readonly timestampFormat: TimestampFormat;
  readonly disclosures: WorkflowDisclosureControls;
}) {
  const threadById = new Map(props.threads.map((thread) => [thread.id, thread] as const));
  const threadRow = (threadId: EnvironmentWorkflowThreadShell["id"] | null) => {
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
              label: "End-to-end test",
              phase: "e2e" as const,
              detail: cycle.e2eExecution
                ? cycle.e2eVerdict === "pending"
                  ? "in progress"
                  : (cycle.e2eVerdict ?? "pending")
                : cycle.e2eThreadId == null
                  ? "not needed"
                  : (cycle.e2eVerdict ??
                    (cycle.status === "e2e-testing" ? "in progress" : "pending")),
              threadId: cycle.e2eThreadId,
              thread: threadRow(cycle.e2eThreadId ?? null),
            },
            {
              label: "Browser review",
              phase: "review" as const,
              detail:
                cycle.appReviewScope === "e2e"
                  ? "not needed"
                  : (cycle.reviewVerdict ??
                    (cycle.status === "reviewing" ? "in progress" : "pending")),
              threadId: cycle.appReviewScope === "e2e" ? null : cycle.reviewerThreadId,
              thread: cycle.appReviewScope === "e2e" ? null : threadRow(cycle.reviewerThreadId),
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
              threadId:
                cycle.plannerThreadId ??
                (cycle.appReviewScope === "e2e"
                  ? (cycle.e2eThreadId ?? cycle.reviewerThreadId)
                  : cycle.reviewerThreadId),
              thread: threadRow(
                cycle.plannerThreadId ??
                  (cycle.appReviewScope === "e2e"
                    ? (cycle.e2eThreadId ?? cycle.reviewerThreadId)
                    : cycle.reviewerThreadId),
              ),
            },
            {
              label: "TDD repair",
              phase: "fixing" as const,
              detail:
                cycle.fixResult?.status ?? (cycle.status === "fixing" ? "in progress" : "pending"),
              threadId: cycle.fixerThreadId,
              thread: threadRow(cycle.fixerThreadId),
            },
          ].filter((step) => step.phase !== "review" || cycle.appReviewScope !== "e2e");
          // Only the newest cycle can start again: every phase entry point on
          // the server works on the run's current cycle.
          const isCurrentCycle = cycle.cycleNumber === latestCycleNumber;
          const cycleStatus = resolveWorkflowStageDetailStatus(cycle.status);
          const cycleDisclosureId = workflowAppReviewCycleDisclosureId(
            props.groupId,
            props.run.id,
            cycle.cycleNumber,
          );
          const cycleOpen = props.disclosures.expanded[cycleDisclosureId] ?? false;
          const gapsDisclosureId = workflowGapsDisclosureId(
            props.groupId,
            props.run.id,
            cycle.cycleNumber,
          );
          const gapsOpen = props.disclosures.expanded[gapsDisclosureId] ?? false;
          const planningDisclosureId = workflowAppReviewPhaseDisclosureId(
            props.groupId,
            props.run.id,
            cycle.cycleNumber,
            "planning",
          );
          const planningOpen = props.disclosures.expanded[planningDisclosureId] ?? false;
          return (
            <article
              key={cycle.cycleNumber}
              data-workflow-current-target={`app-review-cycle:${props.run.id}:${cycle.cycleNumber}`}
              data-app-review-cycle={cycle.cycleNumber}
              className="overflow-hidden rounded-md border border-border/70 bg-background/60"
            >
              <button
                type="button"
                aria-expanded={cycleOpen}
                onClick={() => props.disclosures.toggle(cycleDisclosureId)}
                className="cursor-pointer flex w-full items-center gap-2 px-2 py-1.5 text-left hover:bg-accent/40"
              >
                {cycleOpen ? (
                  <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
                ) : (
                  <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
                )}
                <StatusDot status={cycleStatus} className="size-1.5" />
                <span className="min-w-0 flex-1 truncate text-2xs font-medium">
                  Cycle {cycle.cycleNumber} of {props.run.cycleBudget}
                </span>
                <span
                  className={cn(
                    "shrink-0 text-3xs capitalize",
                    STEP_VISUALS[cycleStatus].textClass,
                  )}
                >
                  {cycle.status}
                </span>
              </button>
              {cycleOpen ? (
                <div className="border-t border-border/60 px-2 pb-2">
                  <TimelineTimeRange
                    startedAt={cycle.startedAt}
                    endedAt={cycle.completedAt}
                    timestampFormat={props.timestampFormat}
                    className="py-1.5"
                  />
                  {cycle.e2eExecution ? (
                    <div className="space-y-1 py-2 text-xs" aria-label="Automated E2E results">
                      <p>
                        Automated tests: {cycle.e2eExecution.results.length}/
                        {cycle.e2eExecution.commands.length} finished. No agent runs during testing.
                      </p>
                      {cycle.e2eExecution.commands.map((selection) => {
                        const result = cycle.e2eExecution!.results.find(
                          (entry) => entry.command === selection.command,
                        );
                        return (
                          <details key={selection.command}>
                            <summary className="cursor-pointer break-all">
                              {result?.status ?? "pending"} · {selection.retryCommand}
                            </summary>
                            {result ? (
                              <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all">
                                {result.outputMarkdown}
                              </pre>
                            ) : null}
                          </details>
                        );
                      })}
                    </div>
                  ) : null}
                  <ol className="mt-2 space-y-1.5 border-l border-border/70 pl-3">
                    {steps.map((step, index) => {
                      const phaseStatus = resolveWorkflowStageDetailStatus(step.detail);
                      const phaseDisclosureId = workflowAppReviewPhaseDisclosureId(
                        props.groupId,
                        props.run.id,
                        cycle.cycleNumber,
                        step.phase,
                      );
                      const phaseOpen = props.disclosures.expanded[phaseDisclosureId] ?? false;
                      return (
                        <li
                          key={step.label}
                          data-workflow-current-target={step.threadId ?? undefined}
                          className="relative"
                        >
                          <span
                            className={cn(
                              "absolute -left-[1.05rem] top-0.5 flex size-3.5 items-center justify-center rounded-full border border-border bg-background text-4xs",
                              STEP_VISUALS[phaseStatus].textClass,
                            )}
                          >
                            {index + 1}
                          </span>
                          <div className="flex min-w-0 items-center gap-1">
                            <button
                              type="button"
                              aria-expanded={phaseOpen}
                              onClick={() => props.disclosures.toggle(phaseDisclosureId)}
                              className="cursor-pointer flex min-w-0 flex-1 items-center gap-1.5 rounded px-1 py-1 text-left text-3xs hover:bg-accent/40"
                            >
                              {phaseOpen ? (
                                <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
                              ) : (
                                <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
                              )}
                              <StatusDot status={phaseStatus} className="size-1.5" />
                              <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                                {step.label}
                              </span>
                              <span
                                className={cn(
                                  "shrink-0 capitalize",
                                  STEP_VISUALS[phaseStatus].textClass,
                                )}
                              >
                                {step.detail}
                              </span>
                            </button>
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
                                    : [threadById.get(props.run.activeThreadId)].flatMap(
                                        (thread) => (thread === undefined ? [] : [thread]),
                                      ),
                                )}
                                pausedScopeThreadIds={
                                  workflowPauseOf(
                                    props.threads,
                                    props.run.activeThreadId === null
                                      ? []
                                      : [threadById.get(props.run.activeThreadId)].flatMap(
                                          (thread) => (thread === undefined ? [] : [thread]),
                                        ),
                                  ).scopeThreadIds
                                }
                                onSetStepModel={
                                  cycle.e2eExecution && step.phase === "e2e"
                                    ? undefined
                                    : props.onSetStepModel
                                }
                                onStop={props.onStopThreads}
                                onResume={props.onResumeThreads}
                                onRestart={() => props.onRerunPhase?.(step.phase)}
                              />
                            )}
                          </div>
                          {phaseOpen ? step.thread : null}
                        </li>
                      );
                    })}
                  </ol>
                  {planningOpen && cycle.repairTickets && cycle.repairTickets.length > 0 ? (
                    <div className="mt-2 space-y-1">
                      {cycle.repairTickets.map((ticket) => {
                        const ticketDisclosureId = workflowRepairTicketDisclosureId(
                          props.groupId,
                          props.run.id,
                          cycle.cycleNumber,
                          ticket.key,
                        );
                        const ticketOpen = props.disclosures.expanded[ticketDisclosureId] ?? false;
                        return (
                          <section
                            key={ticket.key}
                            className="overflow-hidden rounded border border-border/60 bg-muted/20"
                          >
                            <button
                              type="button"
                              aria-expanded={ticketOpen}
                              onClick={() => props.disclosures.toggle(ticketDisclosureId)}
                              className="cursor-pointer flex w-full items-center gap-1.5 px-2 py-1.5 text-left hover:bg-accent/40"
                            >
                              {ticketOpen ? (
                                <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
                              ) : (
                                <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
                              )}
                              <span className="min-w-0 flex-1 truncate text-3xs font-medium text-foreground">
                                {ticket.key} · {ticket.title}
                              </span>
                            </button>
                            {ticketOpen ? (
                              <div className="whitespace-pre-wrap border-t border-border/60 px-2 py-1.5 text-3xs leading-4 text-muted-foreground">
                                {ticket.bodyMarkdown}
                              </div>
                            ) : null}
                          </section>
                        );
                      })}
                    </div>
                  ) : null}
                  {planningOpen && cycle.actionableFindingsMarkdown ? (
                    <section className="mt-2 overflow-hidden rounded border border-border/60">
                      <button
                        type="button"
                        aria-expanded={gapsOpen}
                        onClick={() => props.disclosures.toggle(gapsDisclosureId)}
                        className="cursor-pointer flex w-full items-center gap-1.5 px-2 py-1.5 text-left hover:bg-accent/40"
                      >
                        {gapsOpen ? (
                          <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
                        ) : (
                          <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
                        )}
                        <span className="min-w-0 flex-1 truncate text-3xs font-medium text-foreground">
                          Gaps to fix
                        </span>
                      </button>
                      {gapsOpen ? (
                        <p className="whitespace-pre-wrap border-t border-border/60 px-2 py-1.5 text-3xs leading-4 text-muted-foreground">
                          {cycle.actionableFindingsMarkdown}
                        </p>
                      ) : null}
                    </section>
                  ) : null}
                </div>
              ) : null}
            </article>
          );
        })}
      {props.run.cycles.length === 0 ? (
        <div className="py-1 text-3xs text-muted-foreground/65">Review cycle is starting</div>
      ) : null}
    </div>
  );
}

function AppReviewRunsTimeline(props: {
  readonly groupId: string;
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
  readonly threads: readonly EnvironmentWorkflowThreadShell[];
  readonly onOpenThread: (thread: EnvironmentWorkflowThreadShell) => void;
  readonly activeThreadKey: string | null;
  readonly timestampFormat: TimestampFormat;
  readonly disclosures: WorkflowDisclosureControls;
}) {
  return (
    <div className="space-y-2 px-2 pb-2">
      {props.runs
        .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt))
        .map((run, index) => (
          <section key={run.id}>
            {props.runs.length > 1 ? (
              <div className="mb-1 text-3xs font-medium uppercase tracking-wider text-muted-foreground">
                Recorded App Review {index + 1} · {run.status}
              </div>
            ) : null}
            <TicketAppReviewCycles
              groupId={props.groupId}
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
              disclosures={props.disclosures}
            />
          </section>
        ))}
    </div>
  );
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
  step: WorkflowTimelineStep<EnvironmentWorkflowThreadShell>,
  showAll: boolean,
): ReadonlyArray<{
  readonly entry: WorkflowTimelineStep<EnvironmentWorkflowThreadShell>["entries"][number];
  readonly entryIndex: number;
}> {
  const indexed = step.entries.map((entry, entryIndex) => ({ entry, entryIndex }));
  return showAll || indexed.length <= VISIBLE_STAGE_THREADS
    ? indexed
    : indexed.slice(-VISIBLE_STAGE_THREADS);
}

function ThreadRowList(props: {
  readonly threads: readonly EnvironmentWorkflowThreadShell[];
  readonly timestampFormat: TimestampFormat;
  readonly activeThreadKey: string | null;
  readonly onOpenThread: (thread: EnvironmentWorkflowThreadShell) => void;
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
          className="cursor-pointer w-full rounded px-2 py-1 text-left text-3xs text-muted-foreground hover:bg-accent hover:text-foreground"
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

function EarlierThreads(props: {
  readonly threads: readonly EnvironmentWorkflowThreadShell[];
  readonly timestampFormat: TimestampFormat;
  readonly activeThreadKey: string | null;
  readonly onOpenThread: (thread: EnvironmentWorkflowThreadShell) => void;
}) {
  if (props.threads.length === 0) return null;
  return (
    <details className="mt-1 rounded border border-border/60 px-1.5 py-1">
      <summary className="cursor-pointer text-3xs text-muted-foreground">
        Earlier threads · {props.threads.length}
      </summary>
      <ThreadRowList {...props} />
    </details>
  );
}

/**
 * The wave step every per-ticket agent runs under. Ticket reviews are sub-steps
 * of it, so their pins carry it as the step id. Matches the id the ticket
 * execution step already carries in the shared preset definitions.
 */
const TICKET_WAVE_PROMPT_ID = "implementation.tdd.codex";

type RerunTicketStage = OrchestrationImplementationRerunTicketStage;

function executionTargetLabel(execution: WorkflowStageExecution): string {
  const target = execution.target;
  if (target.kind === "ticket") {
    return `${target.ticketId} · ${target.stage.replaceAll("-", " ")}`;
  }
  if (target.kind === "app-review-phase") {
    return `App Review cycle ${String(target.cycleNumber)} · ${target.phase}`;
  }
  return target.stage.replaceAll("-", " ");
}

function latestWorkflowStageExecutions(
  executions: readonly WorkflowStageExecution[],
): readonly WorkflowStageExecution[] {
  const byTarget = new Map<string, WorkflowStageExecution>();
  for (const execution of executions) {
    const key = JSON.stringify(execution.target);
    const current = byTarget.get(key);
    if (current === undefined || execution.generation > current.generation) {
      byTarget.set(key, execution);
    }
  }
  return [...byTarget.values()].sort((left, right) =>
    JSON.stringify(left.target).localeCompare(JSON.stringify(right.target)),
  );
}

function WorkflowExecutionStatusList(props: {
  readonly executions: readonly WorkflowStageExecution[];
}) {
  const executions = latestWorkflowStageExecutions(props.executions);
  if (executions.length === 0) return null;
  const unfinished = executions.filter((execution) =>
    ["queued", "starting", "running", "reconciling", "retry-wait"].includes(execution.state),
  ).length;
  const dependencyBlocked = executions.filter(
    (execution) => execution.failure?.category === "dependency-failed",
  ).length;
  const halted = executions.filter(
    (execution) =>
      execution.state === "halted" && execution.failure?.category !== "dependency-failed",
  ).length;
  return (
    <div className="border-b border-border/70 px-3 py-2 text-2xs">
      <div className="font-medium text-foreground">
        Recorded stages: {halted} halted, {unfinished} unfinished, {dependencyBlocked}{" "}
        dependency-blocked
      </div>
      <p className="text-muted-foreground">
        These records include earlier attempts. See the current workflow step for live progress.
      </p>
      <div className="mt-2 space-y-2">
        {executions.map((execution) => {
          const fallback = execution.recovery?.fallbackHistory.at(-1)?.model ?? null;
          return (
            <div key={execution.executionId} className="rounded-md bg-muted/40 px-2 py-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="min-w-0 truncate text-foreground">
                  {executionTargetLabel(execution)}
                </span>
                <span className="shrink-0 font-mono text-muted-foreground">
                  {execution.state} · g{String(execution.generation)}
                </span>
              </div>
              <div className="mt-1 text-muted-foreground">
                Last progress {execution.lastProgressAt}
                {execution.failure === null
                  ? ""
                  : ` · ${execution.failure.category} · ${execution.failure.nextAction}`}
              </div>
              {execution.recovery === null ? null : (
                <div className="mt-1 text-muted-foreground">
                  Recovery {execution.recovery.cause} · primary{" "}
                  {execution.recovery.selectedModel?.model ?? "unselected"} · fallback{" "}
                  {fallback?.model ?? "none"}
                  {execution.recovery.retryAt === null
                    ? ""
                    : ` · retry ${execution.recovery.retryAt}`}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Why a ticket stage cannot start again yet, if it cannot.
 *
 * Mirrors the server's rule so the panel never offers an action the decider
 * will refuse: a second agent on the same branch is exactly what the guard
 * exists to prevent.
 */
function ticketStageRerunDisabledReason(input: {
  readonly stageLabel: string;
  readonly threads: readonly EnvironmentWorkflowThreadShell[];
  readonly appReviewRun: AppReviewWorkflowRun | null | undefined;
}): string | null {
  if (input.stageLabel === "App Review") {
    return appReviewRunActiveThreadIsBusy(input.appReviewRun, input.threads)
      ? "This App Review is still running. Stop it before starting it again."
      : null;
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

/** The bar fills in this order: finished work, live work, then work not begun. */
const TICKET_PROGRESS_SEGMENTS: readonly {
  readonly key: TicketProgressSegment;
  readonly label: string;
  readonly fillClass: string;
}[] = [
  { key: "succeeded", label: "Succeeded", fillClass: "bg-emerald-500" },
  { key: "skipped", label: "Skipped", fillClass: "bg-emerald-500/30" },
  { key: "running", label: "Running", fillClass: "bg-sky-500" },
  { key: "awaiting", label: "Needs you", fillClass: "bg-amber-500" },
  { key: "failed", label: "Failed", fillClass: "bg-red-500" },
  { key: "paused", label: "Paused", fillClass: "bg-violet-500" },
  { key: "ready", label: "Ready", fillClass: "bg-muted-foreground/40" },
  { key: "waiting", label: "Waiting on dependencies", fillClass: "bg-muted-foreground/15" },
];

function TicketProgress(props: { readonly statuses: readonly WorkflowStepStatus[] }) {
  const counts = new Map<TicketProgressSegment, number>();
  for (const status of props.statuses) {
    const segment = TICKET_PROGRESS_SEGMENT_BY_STATUS[status];
    counts.set(segment, (counts.get(segment) ?? 0) + 1);
  }
  const segments = TICKET_PROGRESS_SEGMENTS.flatMap((segment) => {
    const count = counts.get(segment.key) ?? 0;
    return count === 0 ? [] : [{ ...segment, count }];
  });
  return (
    <div className="mb-3 rounded-lg border border-border/80 bg-card p-2">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <span className="text-3xs font-medium uppercase tracking-wider text-muted-foreground">
          Tickets
        </span>
        <span className="text-2xs tabular-nums text-muted-foreground">
          <span className="font-medium text-foreground">{counts.get("succeeded") ?? 0}</span> of{" "}
          {props.statuses.length} succeeded
        </span>
      </div>
      <div aria-hidden className="flex h-2 gap-0.5 overflow-hidden rounded-full">
        {segments.map((segment) => (
          <Tooltip key={segment.key}>
            <TooltipTrigger
              render={
                <span
                  className={cn("h-full min-w-1 basis-0", segment.fillClass)}
                  style={{ flexGrow: segment.count }}
                />
              }
            />
            <TooltipPopup>
              {segment.count} {segment.label}
            </TooltipPopup>
          </Tooltip>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
        {segments.map((segment) => (
          <span
            key={segment.key}
            className="inline-flex items-center gap-1.5 text-2xs text-muted-foreground"
          >
            <span aria-hidden className={cn("size-1.5 rounded-full", segment.fillClass)} />
            <span className="font-medium tabular-nums text-foreground">{segment.count}</span>
            {segment.label}
          </span>
        ))}
      </div>
    </div>
  );
}

function TicketPhases(props: {
  readonly stepReviewParts: ReadonlyArray<WorkflowStepReviewPartsOverride> | undefined;
  readonly defaultStepReviewParts: ReadonlyArray<WorkflowStepReviewPartsOverride> | undefined;
  readonly onSetStepReviewParts: SetWorkflowStepReviewParts | undefined;
  readonly groupId: string;
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
  readonly threads: readonly EnvironmentWorkflowThreadShell[];
  readonly appReviewWorkflowRuns: readonly AppReviewWorkflowRun[];
  readonly onOpenThread: (thread: EnvironmentWorkflowThreadShell) => void;
  readonly onOpenAppReview: () => void;
  readonly activeThreadKey: string | null;
  readonly timestampFormat: TimestampFormat;
  readonly disclosures: WorkflowDisclosureControls;
  readonly ticketCodeReviewBudget: number;
}) {
  const states = new Map(props.run.ticketStates.map((state) => [state.ticketId, state] as const));
  const runWorkflowIds = implementationRunWorkflowIds(props.run, props.appReviewWorkflowRuns);
  const runThreads = props.threads.filter((thread) =>
    runWorkflowIds.has(thread.workflowContext?.workflowId ?? ""),
  );
  const threadsByTicketId = new Map<string, EnvironmentWorkflowThreadShell[]>();
  for (const thread of runThreads) {
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
        const waveThreads = runThreads.filter((thread) =>
          thread.workflowContext?.ticketScope.some((ticketId) => waveTicketIds.has(ticketId)),
        );
        const waveBusy = runningThreadIdsOf(runThreads, waveThreads).length > 0;
        const wavePause = workflowPauseOf(runThreads, waveThreads);
        // A wave is only done once its last ticket is, so it shows the most
        // demanding of them rather than an average nobody can act on.
        const waveStatus = resolveWorkflowStepRollup(
          wave.map((ticket) =>
            resolveWorkflowTicketStatus({
              ticketState: states.get(ticket.id)?.status ?? null,
              reviewOutcome: ticketReviewOutcome(states.get(ticket.id)),
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
              <div className="min-w-0 flex-1 text-3xs font-medium uppercase tracking-wider text-muted-foreground">
                Wave {waveIndex + 1} · {wave.length} ticket{wave.length === 1 ? "" : "s"}
              </div>
              <span
                className={cn("shrink-0 text-3xs font-medium", STEP_VISUALS[waveStatus].textClass)}
              >
                {WORKFLOW_STEP_STATUS_LABELS[waveStatus]}
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
                runningThreadIds={runningThreadIdsOf(runThreads, waveThreads)}
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
              const ticketDisclosureId = workflowTicketDisclosureId(props.groupId, ticket.id);
              const open = props.disclosures.expanded[ticketDisclosureId] ?? false;
              const state = states.get(ticket.id);
              const appReviewRun = props.appReviewWorkflowRuns.find(
                (run) => run.id === state?.appReviewWorkflowRunId,
              );
              const linkedThreadIds = new Set(
                [
                  state?.workerThreadId,
                  state?.codeReviewThreadId,
                  appReviewRun?.controllerThreadId,
                  ...runThreads
                    .filter(
                      (thread) =>
                        thread.workflowContext?.ticketScope.includes(ticket.id) === true &&
                        (thread.workflowRole === "implementation-worker" ||
                          thread.workflowRole === "implementation-code-reviewer" ||
                          thread.workflowRole === "app-review-orchestrator" ||
                          thread.workflowRole === "app-review-reviewer" ||
                          thread.workflowRole === "app-review-planner" ||
                          thread.workflowRole === "app-review-fixer"),
                    )
                    .map((thread) => thread.id),
                ].flatMap((threadId) => (threadId == null ? [] : [threadId])),
              );
              const linkedThreads = [...linkedThreadIds]
                .map((threadId) => runThreads.find((thread) => thread.id === threadId))
                .filter((thread): thread is EnvironmentWorkflowThreadShell => thread !== undefined)
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
              const primaryImplementationThreads = implementationThreads.filter(
                (thread) => thread.id === state?.workerThreadId,
              );
              const earlierImplementationThreads = implementationThreads.filter(
                (thread) => thread.id !== state?.workerThreadId,
              );
              const currentAppReviewThreadIds = new Set(
                (appReviewRun?.cycles ?? []).flatMap((cycle) =>
                  [
                    cycle.e2eThreadId,
                    cycle.reviewerThreadId,
                    cycle.plannerThreadId,
                    cycle.fixerThreadId,
                  ].flatMap((threadId) => (threadId == null ? [] : [threadId])),
                ),
              );
              const earlierAppReviewThreads = appReviewThreads.filter(
                (thread) => !currentAppReviewThreadIds.has(thread.id),
              );
              const currentCodeReviewCycleCount = Math.min(
                props.ticketCodeReviewBudget,
                (state?.codeReviewPassCount ?? 0) +
                  (state?.status === "code-reviewing" && state.codeReviewThreadId !== null ? 1 : 0),
              );
              const currentCodeReviewThreads =
                currentCodeReviewCycleCount === 0
                  ? []
                  : codeReviewThreads.slice(-currentCodeReviewCycleCount);
              const earlierCodeReviewThreads = codeReviewThreads.slice(
                0,
                Math.max(0, codeReviewThreads.length - currentCodeReviewThreads.length),
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
                  threads: primaryImplementationThreads,
                },
                {
                  label: "App Review",
                  detail: stageDetails.appReview,
                  threads: appReviewThreads,
                },
                {
                  label: "Code Review",
                  detail: stageDetails.codeReview,
                  threads: currentCodeReviewThreads,
                },
              ] as const;
              const ticketLabel = ticket.key ?? `Ticket ${ticket.ordinal + 1}`;
              // A ticket in another repository names it; the workflow's own goes unnamed.
              // Older servers send runs without repositories.
              const ticketRepository = (props.run.repositories ?? []).find(
                (repository) => repository.projectId === ticket.projectId,
              );
              const ticketPause = workflowPauseOf(runThreads, linkedThreads);
              const ticketStatus = resolveWorkflowTicketStatus({
                ticketState: state?.status ?? null,
                reviewOutcome: ticketReviewOutcome(state),
                threadStatuses: linkedThreads.map(resolveWorkflowThreadStatus),
                skipped: isTicketSkipped(props.skips, ticket.id),
                paused: ticketPause.paused,
              });
              const ticketDetail =
                ticketStatus === "skipped"
                  ? "skipped"
                  : ticketStatus === "paused"
                    ? "paused"
                    : (state?.status === "app-reviewing" || state?.status === "blocked") &&
                        state.appReviewOutcome != null
                      ? `App Review ${state.appReviewOutcome}`
                      : state?.status === "code-reviewing" && state.codeReviewOutcome != null
                        ? `Code Review ${state.codeReviewOutcome}`
                        : (state?.status ?? ticket.status);
              return (
                <div
                  key={ticket.id}
                  data-workflow-current-target={ticket.id}
                  className="border-t border-border/60 first:border-t-0"
                >
                  <div className="flex w-full items-center gap-1">
                    <button
                      type="button"
                      aria-expanded={open}
                      onClick={() => props.disclosures.toggle(ticketDisclosureId)}
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
                      {ticketRepository === undefined ? null : (
                        <span className="shrink-0 text-3xs text-muted-foreground">
                          {basenameOfPath(ticketRepository.repositoryPath)}
                        </span>
                      )}
                      <span
                        className={cn("text-3xs capitalize", STEP_VISUALS[ticketStatus].textClass)}
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
                      runningThreadIds={runningThreadIdsOf(runThreads, linkedThreads)}
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
                      <div className="mb-3 space-y-3 rounded-md border border-border p-2">
                        <TicketTestPlatformPicker
                          ticketId={ticket.id}
                          overrides={props.stepReviewParts}
                          defaults={props.defaultStepReviewParts}
                          onSetStepReviewParts={props.onSetStepReviewParts}
                        />
                        {ticket.appReviewEligible === true ? (
                          <TicketAppStackPicker
                            environmentId={props.environmentId}
                            ticket={ticket}
                            worktreePath={
                              ticketRepository?.worktreePath ?? props.run.orchestratorWorktreePath
                            }
                            branch={props.run.orchestratorBranch}
                            overrides={props.stepReviewParts}
                            defaults={props.defaultStepReviewParts}
                            onSetStepReviewParts={props.onSetStepReviewParts}
                          />
                        ) : null}
                      </div>
                      {state?.workerResult &&
                      (state.status !== "succeeded" || state.nativeVerification) ? (
                        <NativeVerificationPanel
                          environmentId={props.environmentId}
                          runId={props.run.id}
                          ticket={state}
                        />
                      ) : null}
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
                          const stagePaused = workflowPauseOf(runThreads, stage.threads).paused;
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
                          const stageKind = TICKET_STAGE_RERUN[stage.label].stage;
                          const stageDisclosureId = workflowTicketStageDisclosureId(
                            props.groupId,
                            ticket.id,
                            stageKind,
                          );
                          const stageOpen = props.disclosures.expanded[stageDisclosureId] ?? false;
                          return (
                            <section key={stage.label} className="relative">
                              <span
                                className={cn(
                                  "absolute -left-[1.05rem] top-1 flex size-4 items-center justify-center rounded-full border border-border bg-background text-3xs font-medium",
                                  STEP_VISUALS[stageStatus].textClass,
                                )}
                              >
                                {stageIndex + 1}
                              </span>
                              <div className="flex min-w-0 items-center gap-1 text-2xs">
                                <button
                                  type="button"
                                  aria-expanded={stageOpen}
                                  onClick={() => props.disclosures.toggle(stageDisclosureId)}
                                  className="cursor-pointer flex min-w-0 flex-1 items-center gap-1.5 rounded px-1 py-1 text-left hover:bg-accent/40"
                                >
                                  {stageOpen ? (
                                    <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
                                  ) : (
                                    <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
                                  )}
                                  <StatusDot status={stageStatus} className="size-1.5" />
                                  <span
                                    className={cn(
                                      "min-w-0 flex-1 truncate font-medium",
                                      stageStatus === "skipped"
                                        ? "text-muted-foreground line-through"
                                        : "text-foreground",
                                    )}
                                  >
                                    {stage.label}
                                  </span>
                                  <span
                                    className={cn(
                                      "shrink-0 capitalize",
                                      STEP_VISUALS[stageStatus].textClass,
                                    )}
                                  >
                                    {stageDetail}
                                  </span>
                                </button>
                                {stage.label === "App Review" && appReviewRun ? (
                                  <button
                                    type="button"
                                    onClick={props.onOpenAppReview}
                                    className="cursor-pointer inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-3xs hover:bg-accent hover:text-foreground"
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
                                  runningThreadIds={runningThreadIdsOf(runThreads, stage.threads)}
                                  pausedScopeThreadIds={
                                    workflowPauseOf(runThreads, stage.threads).scopeThreadIds
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
                              {stageOpen && stage.label === "App Review" && appReviewRun ? (
                                <>
                                  <TicketAppReviewCycles
                                    groupId={props.groupId}
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
                                    threads={runThreads}
                                    onOpenThread={props.onOpenThread}
                                    activeThreadKey={props.activeThreadKey}
                                    timestampFormat={props.timestampFormat}
                                    disclosures={props.disclosures}
                                  />
                                  <EarlierThreads
                                    threads={earlierAppReviewThreads}
                                    timestampFormat={props.timestampFormat}
                                    activeThreadKey={props.activeThreadKey}
                                    onOpenThread={props.onOpenThread}
                                  />
                                </>
                              ) : stageOpen && stage.label === "Implementation" ? (
                                <>
                                  {stage.threads.length > 0 ? (
                                    <ThreadRowList
                                      threads={stage.threads}
                                      timestampFormat={props.timestampFormat}
                                      activeThreadKey={props.activeThreadKey}
                                      onOpenThread={props.onOpenThread}
                                    />
                                  ) : (
                                    <div className="py-1 text-3xs text-muted-foreground/65">
                                      No thread created
                                    </div>
                                  )}
                                  <EarlierThreads
                                    threads={earlierImplementationThreads}
                                    timestampFormat={props.timestampFormat}
                                    activeThreadKey={props.activeThreadKey}
                                    onOpenThread={props.onOpenThread}
                                  />
                                </>
                              ) : stageOpen && stage.label === "Code Review" ? (
                                <>
                                  <div className="space-y-1.5">
                                    {currentCodeReviewThreads.map((thread, index) => {
                                      const cycleNumber = index + 1;
                                      const cycleDisclosureId = workflowCodeReviewCycleDisclosureId(
                                        props.groupId,
                                        ticket.id,
                                        cycleNumber,
                                      );
                                      const cycleOpen =
                                        props.disclosures.expanded[cycleDisclosureId] ?? false;
                                      return (
                                        <article
                                          key={thread.id}
                                          data-workflow-current-target={`ticket-code-review:${ticket.id}:${cycleNumber}`}
                                          className="overflow-hidden rounded-md border border-border/70 bg-background/60"
                                        >
                                          <button
                                            type="button"
                                            aria-expanded={cycleOpen}
                                            onClick={() =>
                                              props.disclosures.toggle(cycleDisclosureId)
                                            }
                                            className="cursor-pointer flex w-full items-center gap-1.5 px-2 py-1.5 text-left hover:bg-accent/40"
                                          >
                                            {cycleOpen ? (
                                              <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
                                            ) : (
                                              <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
                                            )}
                                            <span className="min-w-0 flex-1 truncate text-3xs font-medium text-muted-foreground">
                                              Cycle {cycleNumber} of {props.ticketCodeReviewBudget}
                                            </span>
                                          </button>
                                          {cycleOpen ? (
                                            <div className="border-t border-border/60 p-1">
                                              <ThreadRowList
                                                threads={[thread]}
                                                timestampFormat={props.timestampFormat}
                                                activeThreadKey={props.activeThreadKey}
                                                onOpenThread={props.onOpenThread}
                                              />
                                            </div>
                                          ) : null}
                                        </article>
                                      );
                                    })}
                                  </div>
                                  {currentCodeReviewThreads.length === 0 ? (
                                    <div className="py-1 text-3xs text-muted-foreground/65">
                                      No cycle started
                                    </div>
                                  ) : null}
                                  <EarlierThreads
                                    threads={earlierCodeReviewThreads}
                                    timestampFormat={props.timestampFormat}
                                    activeThreadKey={props.activeThreadKey}
                                    onOpenThread={props.onOpenThread}
                                  />
                                </>
                              ) : stageOpen && stage.threads.length > 0 ? (
                                <ThreadRowList
                                  threads={stage.threads}
                                  timestampFormat={props.timestampFormat}
                                  activeThreadKey={props.activeThreadKey}
                                  onOpenThread={props.onOpenThread}
                                />
                              ) : stageOpen ? (
                                <div className="py-1 text-3xs text-muted-foreground/65">
                                  No thread created
                                </div>
                              ) : null}
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

function WorkflowGroupCard(props: {
  readonly group: WorkflowGroup<EnvironmentWorkflowThreadShell>;
  readonly currentPath: WorkflowCurrentPath | null;
  readonly groups: readonly WorkflowGroup<EnvironmentWorkflowThreadShell>[];
  readonly expandedById: Readonly<Record<string, boolean>>;
  readonly setExpandedById: Dispatch<SetStateAction<Record<string, boolean>>>;
  readonly focusedWorkflowId: string | null;
  readonly focusedGroupRef: RefObject<HTMLElement | null>;
  readonly activeThreadKey: string | null;
  readonly timestampFormat: TimestampFormat;
  readonly appReviewWorkflowRuns: readonly AppReviewWorkflowRun[];
  readonly implementationRuns: readonly OrchestrationImplementationRun[];
  readonly workflowRoot: EnvironmentWorkflowThreadShell;
  readonly onOpenThread: (thread: EnvironmentWorkflowThreadShell) => void;
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
  readonly navigationRequest: WorkflowNavigationRequest | null;
  readonly onNavigationApplied: (requestId: number) => void;
}) {
  const { group } = props;
  const expanded = props.expandedById[group.id] ?? false;
  const focused = group.kind === "workflow" && group.sourceId === props.focusedWorkflowId;
  const {
    linkedImplementationRun,
    ticketWaveTickets,
    steps,
    workflowPaused,
    resumeStep,
    timeRange,
    showsAppReviews,
    workflowThreads,
    automationHalt,
    canonicalExecutions,
    stepStatusOf,
    liveStepOf,
    currentStep,
    headerStatus,
    headerLabel,
  } = resolveWorkflowGroupState(props);
  // Pins are keyed by step *and* sub-step: the same agent prompt appears under
  // more than one step, so a bare prompt id would collide.
  const stepModelByPinKey = new Map(
    (props.workflowRoot.workflowStepModels ?? []).map(
      (entry) => [workflowModelPinKey(entry), entry.modelSelection] as const,
    ),
  );
  const pinFor = (key: WorkflowModelPinKey): ModelSelection | null =>
    stepModelByPinKey.get(workflowModelPinKey(key)) ?? null;
  const ticketCodeReviewBudget = resolveWorkflowStepCycleBudget({
    key: {
      workflowPromptId: "implementation.code-review.codex",
      stepWorkflowPromptId: "implementation.tdd.codex",
    },
    threadOverrides: props.workflowRoot.workflowStepCycles,
    settingsOverrides: props.defaultStepCycles,
  });
  const [expandedDisclosures, setExpandedDisclosures] = useState<Record<string, boolean>>({});
  const [expandedStepEntries, setExpandedStepEntries] = useState<Record<string, boolean>>({});
  const [pendingScrollTarget, setPendingScrollTarget] = useState<string | null>(null);
  const [openPlanningArtifact, setOpenPlanningArtifact] = useState<{
    readonly ticketId?: string;
    readonly title: string;
    readonly markdown: string;
  } | null>(null);
  const openPlanningTicket =
    openPlanningArtifact?.ticketId === undefined
      ? undefined
      : props.tickets.find((ticket) => ticket.id === openPlanningArtifact.ticketId);
  const phases = groupWorkflowStepsByPhase(steps);
  const toggleDisclosure = useCallback((id: string) => {
    setExpandedDisclosures((current) => ({ ...current, [id]: !(current[id] ?? false) }));
  }, []);
  const disclosures: WorkflowDisclosureControls = {
    expanded: expandedDisclosures,
    toggle: toggleDisclosure,
  };
  useEffect(() => {
    const request = props.navigationRequest;
    if (request === null || request.path.groupId !== group.id) return;
    const disclosureIds = workflowDisclosureIdsForCurrentPath(request.path).filter(
      (id) => id !== workflowGroupDisclosureId(group.id),
    );
    setExpandedDisclosures((current) =>
      Object.fromEntries([
        ...Object.entries(current),
        ...disclosureIds.map((id) => [id, true] as const),
      ]),
    );
    setPendingScrollTarget(workflowCurrentPathScrollTarget(request.path));
    props.onNavigationApplied(request.id);
  }, [group.id, props.navigationRequest, props.onNavigationApplied]);
  useEffect(() => {
    if (pendingScrollTarget === null) return;
    const frame = window.requestAnimationFrame(() => {
      const target = document.querySelector(
        `[data-workflow-current-target="${CSS.escape(pendingScrollTarget)}"]`,
      );
      (
        target ?? document.querySelector(`[data-workflow-group="${CSS.escape(group.id)}"]`)
      )?.scrollIntoView({ block: "nearest" });
      setPendingScrollTarget(null);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [group.id, pendingScrollTarget]);

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
        <div className="flex items-center hover:bg-accent/40">
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() =>
              props.setExpandedById((current) => ({ ...current, [group.id]: !expanded }))
            }
            className="cursor-pointer flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left"
          >
            {expanded ? (
              <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
            ) : (
              <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
            )}
            <StatusDot status={headerStatus} />
            <span className="min-w-0 flex-1 truncate text-sm font-medium">
              {props.cycleLabel ?? groupTitle(group)}
            </span>
            <span
              className={cn(
                "max-w-[38%] shrink-0 truncate text-2xs",
                STEP_VISUALS[headerStatus].textClass,
              )}
            >
              {headerLabel}
            </span>
          </button>
          {showsAppReviews ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label="View App Review results"
                    onClick={props.onOpenAppReview}
                    className="cursor-pointer flex items-center gap-1 rounded-md px-2 py-1.5 text-2xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
                  />
                }
              >
                <Eye className="size-3.5" aria-hidden />
                App Reviews
              </TooltipTrigger>
              <TooltipPopup>View App Review results</TooltipPopup>
            </Tooltip>
          ) : null}
          {group.kind === "workflow" ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label={`Copy link to ${groupTitle(group)} workflow`}
                    onClick={() => props.onCopyWorkflowLink(group.sourceId)}
                    className="cursor-pointer mr-1 rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                  />
                }
              >
                <Copy className="size-3.5" aria-hidden />
              </TooltipTrigger>
              <TooltipPopup>Copy workflow link</TooltipPopup>
            </Tooltip>
          ) : null}
        </div>
        {expanded ? (
          <div className="border-t border-border/70">
            <div className="space-y-1 border-b border-border/70 px-3 py-2 text-2xs text-muted-foreground">
              {currentStep ? (
                <div
                  className={cn(
                    "flex min-w-0 items-center gap-1.5",
                    STEP_VISUALS[headerStatus].textClass,
                  )}
                >
                  <span className="shrink-0">{workflowStepPhase(currentStep)}</span>
                  <span aria-hidden>·</span>
                  <span className="min-w-0 truncate">{workflowStepLabel(currentStep)}</span>
                </div>
              ) : null}
              <div className="flex flex-wrap items-center gap-x-1.5">
                {group.depth > 0 ? (
                  <>
                    <span>Sub-workflow</span>
                    <span aria-hidden>·</span>
                  </>
                ) : null}
                {group.kind === "workflow" ? (
                  <>
                    <Tooltip>
                      <TooltipTrigger render={<span className="font-mono" />}>
                        ID {group.sourceId.slice(0, 8)}
                      </TooltipTrigger>
                      <TooltipPopup>{group.sourceId}</TooltipPopup>
                    </Tooltip>
                    <span aria-hidden>·</span>
                  </>
                ) : null}
                <span>{group.activeCount} active</span>
                <span aria-hidden>·</span>
                <span>{group.settledCount} settled</span>
              </div>
              <TimelineTimeRange {...timeRange} timestampFormat={props.timestampFormat} />
            </div>
            <WorkflowExecutionStatusList executions={canonicalExecutions} />
            {automationHalt !== null ? (
              <div
                role="alert"
                className="mx-3 mb-3 rounded-3xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-xs"
              >
                <div className="font-medium text-foreground">Needs human attention</div>
                <div className="mt-1 text-muted-foreground">
                  {automationHalt.ticketId === undefined
                    ? automationHalt.stage.replaceAll("-", " ")
                    : `${automationHalt.stage.replaceAll("-", " ")} · ${automationHalt.ticketId}`}
                </div>
                <div className="mt-2 whitespace-pre-wrap text-foreground">
                  {automationHalt.detail}
                </div>
                <div className="mt-2 text-muted-foreground">
                  Automatic retries stopped. Start the affected step again to create a new
                  execution.
                </div>
              </div>
            ) : null}
            {phases.map(([phase, availableSteps]) => {
              const phaseId = workflowPhaseDisclosureId(group.id, phase);
              const phaseOpen = disclosures.expanded[phaseId] ?? false;
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
                    onClick={() => disclosures.toggle(phaseId)}
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
                          "max-w-[45%] truncate text-3xs",
                          STEP_VISUALS[phaseStatus].textClass,
                        )}
                      >
                        {workflowStepLabel(runningStep)}
                      </span>
                    ) : null}
                    <span className="shrink-0 text-3xs tabular-nums text-muted-foreground">
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
                          const canRetryStep =
                            linkedImplementationRun !== null &&
                            linkedImplementationRun !== undefined &&
                            workflowStepCanRetryImplementationFailure(
                              step,
                              linkedImplementationRun,
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
                            rerunRunStage: rerunRunStageForStep(step, linkedImplementationRun),
                            onRerunImplementationStage: props.onRerunImplementationStage,
                            onResumeWorkflow: props.onResumeWorkflow,
                            implementationRunId: linkedImplementationRun?.id ?? null,
                          });
                          // Only a step that owns a run-wide stage has something
                          // to clear; the rest are phases of a thread's own work.
                          const stepClearStage = rerunRunStageForStep(
                            step,
                            linkedImplementationRun,
                          );
                          const stepSkipStage = skipRunStageForStep(step);
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
                          const stepDisclosureId = workflowStepDisclosureId(group.id, step.id);
                          const stepOpen = disclosures.expanded[stepDisclosureId] ?? false;
                          const isTicketExecutionStep =
                            (group.preset === "planning" || group.preset === "implementation") &&
                            workflowStepLabel(step).toLowerCase().includes("execute ticket waves");
                          const isCombinedAppReviewStep =
                            workflowStepLabel(step).toLowerCase().includes("app review") &&
                            !isTicketExecutionStep;
                          const effectiveStepCycleBudget =
                            step.skillId === null
                              ? null
                              : resolveWorkflowStepCycleBudget({
                                  key: { workflowPromptId: step.skillId },
                                  threadOverrides: props.workflowRoot.workflowStepCycles,
                                  settingsOverrides: props.defaultStepCycles,
                                });
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
                                <div className="flex items-center gap-1">
                                  <button
                                    type="button"
                                    aria-expanded={stepOpen}
                                    onClick={() => disclosures.toggle(stepDisclosureId)}
                                    className="cursor-pointer flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 py-1.5 text-left hover:bg-accent/40"
                                  >
                                    {stepOpen ? (
                                      <ChevronDown className="size-3.5 shrink-0" />
                                    ) : (
                                      <ChevronRight className="size-3.5 shrink-0" />
                                    )}
                                    <span className="shrink-0 text-3xs font-medium text-muted-foreground">
                                      {index + 1}
                                    </span>
                                    <StatusDot status={stepStatus} />
                                    <h4
                                      className={cn(
                                        "min-w-0 flex-1 truncate text-xs font-semibold",
                                        stepStatus === "skipped"
                                          ? "text-muted-foreground line-through"
                                          : "text-foreground",
                                      )}
                                    >
                                      {workflowStepLabel(step)}
                                    </h4>
                                    <span className={cn("shrink-0 text-3xs", stepVisual.textClass)}>
                                      {WORKFLOW_STEP_STATUS_LABELS[stepStatus]}
                                    </span>
                                  </button>
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
                                      stepSkipStage !== null &&
                                      linkedImplementationRun !== undefined &&
                                      linkedImplementationRun !== null &&
                                      isRunStageSkipped(
                                        linkedImplementationRun.skips,
                                        stepSkipStage,
                                      )
                                    }
                                    onSetSkipped={
                                      stepSkipStage === null ||
                                      stepClearRunId === null ||
                                      props.onSetImplementationSkip === undefined
                                        ? undefined
                                        : (skipped) =>
                                            props.onSetImplementationSkip?.({
                                              runId: stepClearRunId,
                                              target: { kind: "run", stage: stepSkipStage },
                                              skipped,
                                            })
                                    }
                                  />
                                </div>
                                {stepOpen ? (
                                  <div className="flex flex-wrap items-center gap-1.5 px-1 pb-1 text-3xs text-muted-foreground">
                                    {step.skillId ? (
                                      <button
                                        type="button"
                                        onClick={() => props.onOpenSkill(step.skillId!)}
                                        className="cursor-pointer rounded-full border border-border px-2 py-0.5 font-mono hover:bg-accent hover:text-foreground"
                                      >
                                        {workflowSkillLabel(step.skillId, props.skillTitlesById)}
                                      </button>
                                    ) : null}
                                    {isCombinedAppReviewStep ? (
                                      <span className="shrink-0 rounded-full bg-muted px-2 py-0.5">
                                        Up to {Math.min(effectiveStepCycleBudget ?? 5, 5)} cycles
                                      </span>
                                    ) : step.skillId === "implementation.code-review.codex" &&
                                      effectiveStepCycleBudget !== null ? (
                                      <span className="shrink-0 rounded-full bg-muted px-2 py-0.5">
                                        Up to {effectiveStepCycleBudget} cycles
                                      </span>
                                    ) : step.repeatsAsCycles && step.entries.length > 1 ? (
                                      <span className="shrink-0 rounded-full bg-muted px-2 py-0.5">
                                        {step.entries.length} cycles
                                      </span>
                                    ) : threadCount > 1 ? (
                                      <span className="shrink-0 rounded-full bg-muted px-2 py-0.5">
                                        {threadCount} threads
                                      </span>
                                    ) : null}
                                    <TimelineTimeRange
                                      {...stepTimeRange}
                                      timestampFormat={props.timestampFormat}
                                    />
                                  </div>
                                ) : null}
                              </header>
                              {stepOpen &&
                              workflowStepLabel(step)
                                .toLowerCase()
                                .includes("final regression tests") &&
                              linkedImplementationRun != null &&
                              linkedImplementationRun.finalValidationResults.length > 0 ? (
                                <div className="space-y-1 px-2 pb-2 text-xs">
                                  {linkedImplementationRun.finalRegression ? (
                                    <p className="text-muted-foreground">
                                      {linkedImplementationRun.finalRegression.cycles.length} of{" "}
                                      {FINAL_REGRESSION_MAX_CYCLES} test cycles completed
                                      {linkedImplementationRun.activeValidationKind === "final" &&
                                      linkedImplementationRun.status === "fixing"
                                        ? " · Repairing failures"
                                        : ""}
                                      {linkedImplementationRun.activeValidationKind === "final" &&
                                      linkedImplementationRun.status === "code-reviewing"
                                        ? " · Reviewing repairs"
                                        : ""}
                                    </p>
                                  ) : null}
                                  {linkedImplementationRun.finalValidationResults.map((result) => (
                                    <details
                                      key={`${result.command}:${result.completedAt}:${result.status}`}
                                      className="rounded-md border border-border p-2"
                                    >
                                      <summary className="cursor-pointer break-words">
                                        <span className="font-medium">{result.status}</span>
                                        {" · "}
                                        <code>{result.command}</code>
                                      </summary>
                                      <div className="mt-2 whitespace-pre-wrap break-words text-muted-foreground">
                                        {result.outputMarkdown}
                                      </div>
                                    </details>
                                  ))}
                                </div>
                              ) : null}
                              {stepOpen &&
                              isTicketExecutionStep &&
                              linkedImplementationRun &&
                              ticketWaveTickets.length > 0 ? (
                                <div className="mt-1 border-t border-border/70 p-1">
                                  <TicketPhases
                                    stepReviewParts={props.workflowRoot.workflowStepReviewParts}
                                    defaultStepReviewParts={props.defaultStepReviewParts}
                                    onSetStepReviewParts={props.onSetStepReviewParts}
                                    groupId={group.id}
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
                                    disclosures={disclosures}
                                    ticketCodeReviewBudget={ticketCodeReviewBudget}
                                  />
                                </div>
                              ) : stepOpen &&
                                isCombinedAppReviewStep &&
                                combinedAppReviewRuns.length > 0 ? (
                                <AppReviewRunsTimeline
                                  groupId={group.id}
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
                                  disclosures={disclosures}
                                />
                              ) : stepOpen && step.entries.length === 0 ? (
                                <div className="px-2 py-1 text-2xs text-muted-foreground/55">
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
                                      className="cursor-pointer w-full rounded px-2 py-1 text-left text-3xs text-muted-foreground hover:bg-accent hover:text-foreground"
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
                                          <div className="px-2 pt-1 text-3xs font-medium uppercase tracking-wide text-muted-foreground/70">
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
                              ticketId: ticket.id,
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
            {openPlanningArtifact?.ticketId !== undefined ? (
              <div className="mb-4 space-y-3 rounded-md border border-border p-3">
                <TicketTestPlatformPicker
                  ticketId={openPlanningArtifact.ticketId}
                  overrides={props.workflowRoot.workflowStepReviewParts}
                  defaults={props.defaultStepReviewParts}
                  onSetStepReviewParts={props.onSetStepReviewParts}
                />
                {openPlanningTicket?.appReviewEligible === true ? (
                  <TicketAppStackPicker
                    environmentId={props.workflowRoot.environmentId}
                    ticket={openPlanningTicket}
                    worktreePath={props.workflowRoot.worktreePath ?? null}
                    branch={props.workflowRoot.branch ?? null}
                    overrides={props.workflowRoot.workflowStepReviewParts}
                    defaults={props.defaultStepReviewParts}
                    onSetStepReviewParts={props.onSetStepReviewParts}
                  />
                ) : null}
              </div>
            ) : null}
            <ChatMarkdown text={openPlanningArtifact?.markdown ?? ""} cwd={undefined} />
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </div>
  );
}

export function WorkflowsPanel(props: {
  readonly defaultMaxParallelTickets?: number | undefined;
  readonly defaultMaxParallelAppReviews?: number | undefined;
  readonly onSetMaxParallelAppReviews?: ((value: number) => void) | undefined;
  readonly onSetMaxParallelTickets?: ((value: number) => void) | undefined;
  readonly defaultGrillAnswerer?: GrillAnswerer | undefined;
  readonly onSetGrillAnswerer?: ((answerer: GrillAnswerer) => void) | undefined;
  readonly workflow: WorkflowRoot<EnvironmentWorkflowThreadShell> | null;
  readonly activeThreadKey: string | null;
  readonly focusedWorkflowId: string | null;
  readonly timestampFormat: TimestampFormat;
  readonly appReviewWorkflowRuns: readonly AppReviewWorkflowRun[];
  readonly implementationRuns: readonly OrchestrationImplementationRun[];
  readonly tickets: readonly OrchestrationPlanningTicket[];
  readonly spec: OrchestrationPlanningSpec | null;
  readonly skillTitlesById: ReadonlyMap<string, string>;
  readonly onOpenSkill: (skillId: string) => void;
  readonly onOpenThread: (thread: EnvironmentWorkflowThreadShell) => void;
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
  readonly defaultStepModels?: ReadonlyArray<WorkflowStepModelOverride> | undefined;
  readonly defaultStepCycles?: ReadonlyArray<WorkflowStepCycleOverride> | undefined;
  readonly onSetStepCycles?: SetWorkflowStepCycles | undefined;
  readonly defaultStepReviewParts?: ReadonlyArray<WorkflowStepReviewPartsOverride> | undefined;
  readonly onSetStepReviewParts?: SetWorkflowStepReviewParts | undefined;
  readonly onStopThreads?: ((threadIds: readonly ThreadId[]) => void) | undefined;
  readonly onResumeThreads?: ((threadIds: readonly ThreadId[]) => void) | undefined;
}) {
  const groups = props.workflow?.groups ?? [];
  const focusedGroupRef = useRef<HTMLElement>(null);
  const handledFocusedWorkflowId = useRef<string | null>(null);
  const [expandedById, setExpandedById] = useState<Record<string, boolean>>({});
  const nextNavigationRequestId = useRef(0);
  const [navigationRequest, setNavigationRequest] = useState<
    | (WorkflowNavigationRequest & {
        readonly groupId: string;
      })
    | null
  >(null);
  const handleNavigationApplied = useCallback((requestId: number) => {
    setNavigationRequest((current) => (current?.id === requestId ? null : current));
  }, []);

  useEffect(() => {
    if (props.focusedWorkflowId === null) {
      handledFocusedWorkflowId.current = null;
      return;
    }
    if (handledFocusedWorkflowId.current === props.focusedWorkflowId) return;
    const focusedGroup = groups.find(
      (group) => group.kind === "workflow" && group.sourceId === props.focusedWorkflowId,
    );
    if (!focusedGroup) return;
    handledFocusedWorkflowId.current = props.focusedWorkflowId;
    const groupById = new Map(groups.map((group) => [group.id, group] as const));
    const expandedAncestors: Record<string, boolean> = {};
    let currentGroup: WorkflowGroup<EnvironmentWorkflowThreadShell> | undefined = focusedGroup;
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
  const topLevelGroups = groups.filter((group) => group.parentGroupId === null);
  const implementationRunByGroupId = new Map(
    topLevelGroups.map(
      (group) =>
        [
          group.id,
          resolveGroupImplementationRun(group, groups, props.implementationRuns, {
            specId: props.spec?.id ?? null,
            rootThreadId: workflow.root.id,
          }),
        ] as const,
    ),
  );
  const ticketStatuses = workflowTicketStatuses({
    runs: [...new Set(implementationRunByGroupId.values())].flatMap((run) =>
      run === null ? [] : [run],
    ),
    tickets: props.tickets,
    threads: [workflow.root, ...workflow.members],
    appReviewWorkflowRuns: props.appReviewWorkflowRuns,
  });
  const currentPathByGroupId = new Map(
    topLevelGroups.map(
      (group) =>
        [
          group.id,
          resolveWorkflowGroupCurrentPath({
            group,
            groups,
            workflow,
            run: implementationRunByGroupId.get(group.id) ?? null,
            appReviewWorkflowRuns: props.appReviewWorkflowRuns,
            tickets: props.tickets,
            defaultStepCycles: props.defaultStepCycles,
          }),
        ] as const,
    ),
  );

  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="p-3">
        {ticketStatuses.length > 0 ? <TicketProgress statuses={ticketStatuses} /> : null}
        {groups.length > 0 ? (
          <div className="mb-3 rounded-lg border border-border/80 bg-card p-2">
            <div className="mb-2 text-3xs font-medium uppercase tracking-wider text-muted-foreground">
              Interaction modes
            </div>
            <div className="flex gap-2 overflow-x-auto pb-1">
              {topLevelGroups.map((group) => {
                const currentPath = currentPathByGroupId.get(group.id)!;
                const chipStatus: WorkflowStepStatus =
                  currentPath.status === "blocked"
                    ? "blocked"
                    : currentPath.status === "awaiting"
                      ? "awaiting"
                      : currentPath.status === "running"
                        ? "running"
                        : currentPath.status === "paused"
                          ? "paused"
                          : currentPath.status === "done"
                            ? "done"
                            : "pending";
                return (
                  <button
                    key={group.id}
                    type="button"
                    aria-expanded={expandedById[group.id] ?? false}
                    onClick={() => {
                      nextNavigationRequestId.current += 1;
                      setNavigationRequest({
                        groupId: group.id,
                        id: nextNavigationRequestId.current,
                        path: currentPath,
                      });
                      setExpandedById((current) => ({ ...current, [group.id]: true }));
                    }}
                    className="cursor-pointer flex min-w-56 shrink-0 items-start gap-2 rounded-md border border-border/70 px-2.5 py-2 text-left hover:bg-accent"
                  >
                    <StatusDot status={chipStatus} className="mt-1" />
                    <span className="min-w-0">
                      <span className="block truncate text-xs font-medium">
                        {groupTitle(group)}
                      </span>
                      <span className={cn("block truncate text-3xs", "text-muted-foreground")}>
                        {currentPath.subtitle}
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
                <span className="shrink-0 text-2xs text-muted-foreground">Main thread</span>
              </span>
              <TimelineTimeRange
                {...rootTimeRange}
                timestampFormat={props.timestampFormat}
                className="mt-1"
              />
            </span>
          </button>
          <WorkflowSettingsMenu
            maxParallelTickets={
              workflow.root.workflowImplementationSettings?.maxParallelTickets ??
              props.defaultMaxParallelTickets
            }
            onSetMaxParallelTickets={props.onSetMaxParallelTickets}
            maxParallelAppReviews={
              workflow.root.workflowImplementationSettings?.maxParallelAppReviews ??
              props.defaultMaxParallelAppReviews
            }
            onSetMaxParallelAppReviews={props.onSetMaxParallelAppReviews}
            grillAnswerer={
              workflow.root.workflowImplementationSettings?.grillAnswerer ??
              props.defaultGrillAnswerer
            }
            onSetGrillAnswerer={props.onSetGrillAnswerer}
            environmentId={workflow.root.environmentId}
            preset={workflow.root.workflowPreset ?? null}
            pinFor={(key) =>
              (workflow.root.workflowStepModels ?? []).find(
                (entry) => workflowModelPinKey(entry) === workflowModelPinKey(key),
              )?.modelSelection ?? null
            }
            rootModelSelection={workflow.root.modelSelection}
            onSetStepModel={props.onSetStepModel}
            defaultStepModels={props.defaultStepModels}
            stepCycles={workflow.root.workflowStepCycles}
            defaultStepCycles={props.defaultStepCycles}
            onSetStepCycles={props.onSetStepCycles}
            stepReviewParts={workflow.root.workflowStepReviewParts}
            defaultStepReviewParts={props.defaultStepReviewParts}
            onSetStepReviewParts={props.onSetStepReviewParts}
          />
          {workflow.root.workflowPausedAt == null && props.onPauseWorkflow ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    onClick={props.onPauseWorkflow}
                    className="cursor-pointer mt-1 inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-border/80 px-2 text-xs font-medium hover:bg-accent"
                  />
                }
              >
                <Pause className="size-3" aria-hidden /> Pause
              </TooltipTrigger>
              <TooltipPopup>Pause the workflow and stop all active agent sessions</TooltipPopup>
            </Tooltip>
          ) : workflow.root.workflowPausedAt != null && props.onResumeWorkflow ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    onClick={props.onResumeWorkflow}
                    className="cursor-pointer mt-1 inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-border/80 px-2 text-xs font-medium hover:bg-accent"
                  />
                }
              >
                <Play className="size-3" aria-hidden /> Resume
              </TooltipTrigger>
              <TooltipPopup>
                Resume the workflow from the step it stopped at, keeping its worktrees
              </TooltipPopup>
            </Tooltip>
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
          {topLevelGroups.map((group) => (
            <WorkflowGroupCard
              key={group.id}
              group={group}
              currentPath={currentPathByGroupId.get(group.id) ?? null}
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
              navigationRequest={navigationRequest?.groupId === group.id ? navigationRequest : null}
              onNavigationApplied={handleNavigationApplied}
            />
          ))}
        </div>
      </div>
    </ScrollArea>
  );
}
