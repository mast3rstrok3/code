import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { AppReviewWorkflowRun, OrchestrationImplementationRun } from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import { WORKFLOW_PRESET_DEFINITION_BY_ID } from "@t3tools/shared/workflowPresets";
import { Archive, ChevronDown, ChevronRight, Copy, Eye, GitFork, RotateCcw } from "lucide-react";
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
  resolveWorkflowGroupTimeRange,
  resolveWorkflowStepTimeRange,
  resolveWorkflowThreadTimeRange,
  resolveWorkflowThreadStatus,
  workflowStepMatchesImplementationFailure,
  workflowThreadKey,
  type WorkflowGroup,
  type WorkflowRoot,
  type WorkflowTimelineStep,
  type WorkflowThreadStatus,
} from "~/workflowModel";
import { ScrollArea } from "~/components/ui/scroll-area";

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

function implementationRunForGroup(
  group: WorkflowGroup<EnvironmentThreadShell>,
  runs: readonly OrchestrationImplementationRun[],
): OrchestrationImplementationRun | null {
  return (
    runs.find(
      (run) =>
        run.id === group.sourceId ||
        run.appReviewWorkflowRunIds.some((runId) => runId === group.sourceId) ||
        group.rows.some((row) => row.thread.id === run.orchestratorThreadId),
    ) ?? null
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
  readonly nested?: boolean;
  readonly cycleLabel?: string | undefined;
}) {
  const { group } = props;
  const expanded = props.expandedById[group.id] ?? group.isActive;
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
  const steps = buildWorkflowSteps(group, props.groups, props.workflowRoot);
  const timeRange = resolveWorkflowGroupTimeRange(group, props.groups);

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
          {group.preset === "app-review" ? (
            <button
              type="button"
              aria-label="View App Review results"
              title="View App Review results"
              onClick={props.onOpenAppReview}
              className="cursor-pointer mt-2 flex items-center gap-1 rounded-md px-2 py-1.5 text-[11px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <Eye className="size-3.5" aria-hidden />
              Results
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
            {steps.map((step, index) => {
              const stepTimeRange = resolveWorkflowStepTimeRange(step, props.groups);
              const threadCount = step.entries.filter((entry) => entry.kind === "thread").length;
              const retryableFailure = linkedImplementationRun?.retryableFailure ?? null;
              const canRetryStep =
                linkedImplementationRun?.status === "needs-human-attention" &&
                retryableFailure !== null &&
                workflowStepMatchesImplementationFailure(step, retryableFailure.stage) &&
                props.onRetryImplementationRun !== undefined;
              return (
                <section key={step.id} className="px-1 py-2">
                  <header className="px-2 pb-1.5">
                    <div className="flex min-w-0 items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                          Step {index + 1}
                        </div>
                        <h4 className="truncate text-sm font-semibold text-foreground">
                          {workflowStepTitle(step)}
                        </h4>
                      </div>
                      {canRetryStep ? (
                        <button
                          type="button"
                          title={`Restart blocked ${workflowStepTitle(step)} step`}
                          onClick={() =>
                            props.onRetryImplementationRun?.(linkedImplementationRun.id)
                          }
                          className="cursor-pointer flex shrink-0 items-center gap-1 rounded-md border border-destructive/30 px-2 py-1 text-[10px] font-medium text-destructive hover:bg-destructive/10"
                        >
                          <RotateCcw className="size-3" aria-hidden />
                          Restart step
                        </button>
                      ) : step.repeatsAsCycles && step.entries.length > 1 ? (
                        <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
                          {step.entries.length} cycles
                        </span>
                      ) : threadCount > 1 ? (
                        <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
                          {threadCount} threads
                        </span>
                      ) : null}
                    </div>
                    <TimelineTimeRange
                      {...stepTimeRange}
                      timestampFormat={props.timestampFormat}
                      className="mt-1"
                    />
                  </header>
                  {step.entries.length === 0 ? (
                    <div className="px-2 py-1 text-[11px] text-muted-foreground/55">
                      Not started
                    </div>
                  ) : (
                    <div className="space-y-0.5">
                      {step.entries.map((entry, entryIndex) => {
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
                          <WorkflowGroupCard
                            key={entry.id}
                            {...props}
                            group={entry.group}
                            nested
                            cycleLabel={cycleLabel}
                          />
                        );
                      })}
                    </div>
                  )}
                </section>
              );
            })}
          </div>
        ) : null}
      </section>
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
  readonly onOpenThread: (thread: EnvironmentThreadShell) => void;
  readonly onOpenAppReview: () => void;
  readonly onCopyWorkflowLink: (workflowId: string) => void;
  readonly onRetryImplementationRun?: ((runId: string) => void) | undefined;
}) {
  const groups = props.workflow?.groups ?? [];
  const focusedGroupRef = useRef<HTMLElement>(null);
  const [expandedById, setExpandedById] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(groups.map((group) => [group.id, group.isActive])),
  );

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

  if (!props.workflow || groups.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-8 text-center">
        <div className="max-w-xs">
          <GitFork className="mx-auto size-5 text-muted-foreground" />
          <h3 className="mt-3 text-sm font-medium">No workflow runs</h3>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            This workflow may have been removed, or it has no created child threads.
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
        <button
          type="button"
          onClick={() => props.onOpenThread(workflow.root)}
          className="cursor-pointer mb-3 flex w-full min-w-0 items-start gap-2 rounded-md px-2 py-2 text-left hover:bg-accent/60"
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
                workflowRoot={workflow.root}
                onOpenThread={props.onOpenThread}
                onOpenAppReview={props.onOpenAppReview}
                onCopyWorkflowLink={props.onCopyWorkflowLink}
                onRetryImplementationRun={props.onRetryImplementationRun}
              />
            ))}
        </div>
      </div>
    </ScrollArea>
  );
}
