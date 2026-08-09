import { memo, useState, useCallback, useEffect, useMemo } from "react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  OrchestrationImplementationRun,
  OrchestrationPlanningFileChange,
  OrchestrationPlanningFileChangeAction,
  OrchestrationPlanningSpecId,
  OrchestrationPlanningWorkflow,
  OrchestrationThreadShell,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { IMPLEMENTATION_RUN_MAX_QA_REPAIRS } from "@t3tools/contracts";
import { type TimestampFormat } from "@t3tools/contracts/settings";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "./ui/collapsible";
import { ScrollArea } from "./ui/scroll-area";
import ChatMarkdown from "./ChatMarkdown";
import {
  CheckIcon,
  ArrowDownIcon,
  ChevronRightIcon,
  ExternalLinkIcon,
  FileTextIcon,
  GitBranchIcon,
  GitMergeIcon,
  EllipsisIcon,
  LoaderIcon,
  MapIcon,
  PlayIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  SquareIcon,
} from "lucide-react";
import { cn } from "~/lib/utils";
import type { ActivePlanState } from "../session-logic";
import type { LatestProposedPlanState } from "../session-logic";
import { formatTimestamp } from "../timestampFormat";
import {
  proposedPlanTitle,
  buildProposedPlanMarkdownFilename,
  normalizePlanMarkdownForExport,
  downloadPlanAsTextFile,
  stripDisplayedPlanMarkdown,
} from "../proposedPlan";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "./ui/menu";
import { projectEnvironment } from "~/state/projects";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  addExpandedId,
  buildImplementationDependencyLanes,
  buildPlanningTicketPresentation,
  planningTicketLabel,
  toggleExpandedId,
  type PlanningTicketPresentation,
  type PlanSidebarSectionId,
} from "./PlanSidebar.logic";

function stepStatusIcon(status: string): React.ReactNode {
  if (status === "completed") {
    return (
      <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-success/10 text-success-foreground">
        <CheckIcon className="size-3" />
      </span>
    );
  }
  if (status === "inProgress") {
    return (
      <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
        <LoaderIcon className="size-3 animate-spin" />
      </span>
    );
  }
  return (
    <span className="flex size-5 shrink-0 items-center justify-center rounded-full border border-border/60 bg-muted/30">
      <span className="size-1.5 rounded-full bg-muted-foreground/30" />
    </span>
  );
}

function statusVariant(status: string): "success" | "warning" | "error" | "info" | "outline" {
  const normalized = status.toLowerCase();
  if (normalized.includes("warning")) {
    return "warning";
  }
  if (
    normalized.includes("passed") ||
    normalized.includes("completed") ||
    normalized.includes("succeeded") ||
    normalized.includes("ready")
  ) {
    return "success";
  }
  if (
    normalized.includes("failed") ||
    normalized.includes("blocked") ||
    normalized.includes("attention")
  ) {
    return "error";
  }
  if (
    normalized.includes("running") ||
    normalized.includes("review") ||
    normalized.includes("validating") ||
    normalized.includes("fixing")
  ) {
    return "warning";
  }
  if (normalized.includes("pending") || normalized.includes("launch")) {
    return "info";
  }
  return "outline";
}

function DisclosureSection({
  title,
  count,
  open,
  onOpenChange,
  actions,
  children,
}: {
  title: string;
  count?: number | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  actions?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <Collapsible open={open} onOpenChange={onOpenChange}>
      <div className="flex items-center justify-between gap-2 border-t border-border/50 pt-3">
        <CollapsibleTrigger
          className="group flex min-w-0 flex-1 items-center gap-1.5 text-left"
          aria-label={`${open ? "Collapse" : "Expand"} ${title}`}
        >
          <ChevronRightIcon
            className={cn(
              "size-3 shrink-0 text-muted-foreground/40 transition-transform",
              open && "rotate-90",
            )}
            aria-hidden
          />
          <span className="min-w-0 truncate text-[10px] font-semibold tracking-widest text-muted-foreground/40 uppercase group-hover:text-muted-foreground/60">
            {title}
          </span>
          {count !== undefined ? (
            <Badge variant="outline" size="sm" className="h-4 px-1 text-[10px]">
              {count}
            </Badge>
          ) : null}
        </CollapsibleTrigger>
        {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
      </div>
      <CollapsiblePanel>
        {children ? <div className="pt-2">{children}</div> : null}
      </CollapsiblePanel>
    </Collapsible>
  );
}

function ItemDisclosure({
  label,
  open,
  onOpenChange,
  summary,
  actions,
  children,
}: {
  label: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  summary: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Collapsible open={open} onOpenChange={onOpenChange}>
      <div className="flex min-w-0 items-start gap-1">
        <CollapsibleTrigger
          className="group flex min-w-0 flex-1 items-start gap-2 text-left"
          aria-label={`${open ? "Collapse" : "Expand"} ${label}`}
        >
          <ChevronRightIcon
            className={cn(
              "mt-0.5 size-3.5 shrink-0 text-muted-foreground/45 transition-transform",
              open && "rotate-90",
            )}
            aria-hidden
          />
          {summary}
        </CollapsibleTrigger>
        {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
      </div>
      <CollapsiblePanel>
        <div className="pt-2">{children}</div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

function MetadataLine({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[72px_minmax(0,1fr)] gap-2 text-[11px] leading-5">
      <span className="text-muted-foreground/45">{label}</span>
      <span className="min-w-0 truncate text-muted-foreground/80">{value}</span>
    </div>
  );
}

function formatCompactTimestamp(value: string, timestampFormat: TimestampFormat): string {
  return value ? formatTimestamp(value, timestampFormat) : "Not recorded";
}

interface PlanSidebarProps {
  activePlan: ActivePlanState | null;
  activeProposedPlan: LatestProposedPlanState | null;
  planningWorkflow?: OrchestrationPlanningWorkflow | null;
  workflowThreadShells?: ReadonlyArray<OrchestrationThreadShell> | undefined;
  implementationRuns?: ReadonlyArray<OrchestrationImplementationRun> | undefined;
  label?: string;
  environmentId: EnvironmentId;
  threadRef?: ScopedThreadRef | undefined;
  markdownCwd: string | undefined;
  workspaceRoot: string | undefined;
  timestampFormat: TimestampFormat;
  mode?: "sheet" | "sidebar" | "embedded";
  automationOwned?: boolean | undefined;
  onOpenThread?: (threadId: ThreadId) => void;
  onCreateSpec?: (() => void) | undefined;
  onLoadSpecBundle?: (specId: OrchestrationPlanningSpecId) => void;
  onRequestTicketReview?: (specId: OrchestrationPlanningSpecId) => void;
  onLaunchImplementationRun?: (specId: OrchestrationPlanningSpecId) => void;
  onRetryImplementationChangeRequest?: (runId: OrchestrationImplementationRun["id"]) => void;
  onRetryImplementationRun?: (runId: OrchestrationImplementationRun["id"]) => void;
  onCancelImplementationRun?: (runId: OrchestrationImplementationRun["id"]) => void;
  focusedTicketId?: string | null;
}

const EMPTY_WORKFLOW_THREAD_SHELLS: ReadonlyArray<OrchestrationThreadShell> = [];
const EMPTY_IMPLEMENTATION_RUNS: ReadonlyArray<OrchestrationImplementationRun> = [];
const PLANNED_FILE_ACTIONS: ReadonlyArray<{
  readonly action: OrchestrationPlanningFileChangeAction;
  readonly label: string;
}> = [
  { action: "create", label: "Create" },
  { action: "update", label: "Update" },
  { action: "delete", label: "Delete" },
];

export function PlannedFileChanges({
  changes,
}: {
  readonly changes: ReadonlyArray<OrchestrationPlanningFileChange>;
}) {
  return (
    <div className="rounded-md border border-border/50 bg-background/45 p-2">
      <div className="mb-1.5 text-[11px] font-medium text-foreground/75">Planned files</div>
      {changes.length > 0 ? (
        <div className="space-y-1.5">
          {PLANNED_FILE_ACTIONS.map(({ action, label }) => {
            const actionChanges = changes.filter((change) => change.action === action);
            return actionChanges.length > 0 ? (
              <div key={action} className="space-y-1">
                {actionChanges.map((change) => (
                  <div key={change.path} className="flex min-w-0 items-center gap-1.5">
                    <Badge variant="outline" size="sm" className="shrink-0">
                      {label}
                    </Badge>
                    <code className="min-w-0 break-all text-[11px] text-foreground/80">
                      {change.path}
                    </code>
                  </div>
                ))}
              </div>
            ) : null;
          })}
        </div>
      ) : (
        <p className="text-[11px] text-muted-foreground/55">No planned file changes recorded.</p>
      )}
    </div>
  );
}

function formatPlanningTicketLabels(
  ticketIds: ReadonlyArray<string>,
  presentationById: ReadonlyMap<string, PlanningTicketPresentation>,
): string {
  return ticketIds.map((ticketId) => planningTicketLabel(ticketId, presentationById)).join(", ");
}

export function ImplementationTicketFlow({
  run,
  presentationById,
  onOpenThread,
}: {
  readonly run: OrchestrationImplementationRun;
  readonly presentationById: ReadonlyMap<string, PlanningTicketPresentation>;
  readonly onOpenThread?: ((threadId: ThreadId) => void) | undefined;
}) {
  const runPresentationById = useMemo(() => {
    const next = new Map(presentationById);
    run.ticketStates.forEach((ticketState, index) => {
      if (!next.has(ticketState.ticketId)) {
        const number = index + 1;
        next.set(ticketState.ticketId, {
          number,
          title: "Ticket details unavailable",
          label: planningTicketLabel(ticketState.ticketId, presentationById, number),
        });
      }
    });
    return next;
  }, [presentationById, run.ticketStates]);
  const layout = useMemo(
    () => buildImplementationDependencyLanes(run.ticketStates),
    [run.ticketStates],
  );
  const ticketStatesById = useMemo(
    () => new Map(run.ticketStates.map((ticketState) => [ticketState.ticketId, ticketState])),
    [run.ticketStates],
  );
  const runningTicketIds = run.ticketStates
    .filter((ticketState) => ticketState.status === "running")
    .map((ticketState) => ticketState.ticketId);
  const readyTicketIds = run.ticketStates
    .filter((ticketState) => ticketState.status === "ready")
    .map((ticketState) => ticketState.ticketId);

  if (run.ticketStates.length === 0) {
    return (
      <p className="text-[11px] text-muted-foreground/55">
        No ticket dependency flow is recorded for this run.
      </p>
    );
  }

  const renderTicketCard = (ticketId: string) => {
    const ticketState = ticketStatesById.get(ticketId);
    if (ticketState === undefined) return null;
    const presentation = runPresentationById.get(ticketId);
    const workerThreadId = ticketState.workerThreadId;
    return (
      <div
        key={ticketId}
        className="min-w-0 rounded-md border border-border/55 bg-background/55 p-2"
      >
        <div className="flex min-w-0 items-start gap-1.5">
          <span className="min-w-0 flex-1 text-[11px] leading-4 font-medium text-foreground/85">
            {presentation?.label ?? "Ticket details unavailable"}
          </span>
          <Badge
            variant={statusVariant(ticketState.status)}
            size="sm"
            className="h-4 shrink-0 px-1 text-[9px]"
          >
            {ticketState.status}
          </Badge>
        </div>
        {ticketState.dependencyTicketIds.length > 0 ? (
          <p className="mt-1 text-[10px] leading-4 text-muted-foreground/55">
            After {formatPlanningTicketLabels(ticketState.dependencyTicketIds, runPresentationById)}
          </p>
        ) : (
          <p className="mt-1 text-[10px] leading-4 text-muted-foreground/45">No blockers</p>
        )}
        {workerThreadId !== null ? (
          <Button
            size="xs"
            variant="ghost"
            className="mt-1 h-5 px-1 text-[10px]"
            onClick={() => onOpenThread?.(workerThreadId)}
            disabled={!onOpenThread}
          >
            <ExternalLinkIcon className="size-3" />
            Open worker
          </Button>
        ) : null}
      </div>
    );
  };

  return (
    <div className="space-y-2 rounded-md border border-border/50 bg-muted/10 p-2">
      <div>
        <div className="text-[11px] font-medium text-foreground/75">Ticket dependency flow</div>
        {runningTicketIds.length > 0 ? (
          <p className="mt-0.5 text-[10px] leading-4 text-muted-foreground/60">
            {runningTicketIds.length > 1 ? "Running in parallel: " : "Running: "}
            {formatPlanningTicketLabels(runningTicketIds, runPresentationById)}
          </p>
        ) : readyTicketIds.length > 0 ? (
          <p className="mt-0.5 text-[10px] leading-4 text-muted-foreground/60">
            Ready: {formatPlanningTicketLabels(readyTicketIds, runPresentationById)}
          </p>
        ) : null}
      </div>
      {layout.levels.map((ticketIds, levelIndex) => (
        <div key={`level-${ticketIds.join(":")}`}>
          {levelIndex > 0 ? (
            <div className="flex h-5 items-center justify-center text-muted-foreground/35">
              <ArrowDownIcon className="size-3" aria-hidden />
            </div>
          ) : null}
          <div className="mb-1 flex items-center justify-between gap-2 text-[9px] tracking-wide text-muted-foreground/45 uppercase">
            <span>Dependency level {levelIndex + 1}</span>
            {ticketIds.length > 1 ? <span>Parallel-capable</span> : null}
          </div>
          <div className={cn("grid gap-1.5", ticketIds.length > 1 && "grid-cols-2")}>
            {ticketIds.map(renderTicketCard)}
          </div>
        </div>
      ))}
      {layout.unresolvedTicketIds.length > 0 ? (
        <div>
          {layout.levels.length > 0 ? (
            <div className="flex h-5 items-center justify-center text-muted-foreground/35">
              <ArrowDownIcon className="size-3" aria-hidden />
            </div>
          ) : null}
          <div className="mb-1 text-[9px] tracking-wide text-destructive/70 uppercase">
            Unresolved dependencies
          </div>
          <div
            className={cn("grid gap-1.5", layout.unresolvedTicketIds.length > 1 && "grid-cols-2")}
          >
            {layout.unresolvedTicketIds.map(renderTicketCard)}
          </div>
        </div>
      ) : null}
    </div>
  );
}

const PlanSidebar = memo(function PlanSidebar({
  activePlan,
  activeProposedPlan,
  planningWorkflow = null,
  workflowThreadShells = EMPTY_WORKFLOW_THREAD_SHELLS,
  implementationRuns = EMPTY_IMPLEMENTATION_RUNS,
  label = "Plan",
  environmentId,
  threadRef,
  markdownCwd,
  workspaceRoot,
  timestampFormat,
  mode = "sidebar",
  automationOwned = false,
  onOpenThread,
  onCreateSpec,
  onLoadSpecBundle,
  onRequestTicketReview,
  onLaunchImplementationRun,
  onRetryImplementationChangeRequest,
  onRetryImplementationRun,
  onCancelImplementationRun,
  focusedTicketId = null,
}: PlanSidebarProps) {
  const [expandedSectionIds, setExpandedSectionIds] = useState<ReadonlySet<PlanSidebarSectionId>>(
    () => new Set(),
  );
  const [expandedTicketIds, setExpandedTicketIds] = useState<ReadonlySet<string>>(() => new Set());
  const [expandedReviewCycleIds, setExpandedReviewCycleIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [expandedImplementationRunIds, setExpandedImplementationRunIds] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const [isSavingToWorkspace, setIsSavingToWorkspace] = useState(false);
  const writeProjectFile = useAtomCommand(projectEnvironment.writeFile, {
    reportFailure: false,
  });
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: "plan" });

  const planMarkdown = activeProposedPlan?.planMarkdown ?? null;
  const displayedPlanMarkdown = planMarkdown ? stripDisplayedPlanMarkdown(planMarkdown) : null;
  const planTitle = planMarkdown ? proposedPlanTitle(planMarkdown) : null;
  const spec = planningWorkflow?.spec ?? null;
  const wayfinderMap = planningWorkflow?.wayfinderMap ?? null;
  const tickets = useMemo(
    () =>
      (planningWorkflow?.tickets ?? [])
        .filter((ticket) => spec !== null && ticket.specId === spec.id)
        .toSorted((left, right) => left.ordinal - right.ordinal),
    [planningWorkflow?.tickets, spec],
  );
  const wayfinderTickets = useMemo(
    () =>
      (planningWorkflow?.tickets ?? [])
        .filter((ticket) => wayfinderMap !== null && ticket.specId === wayfinderMap.id)
        .toSorted((left, right) => left.ordinal - right.ordinal),
    [planningWorkflow?.tickets, wayfinderMap],
  );
  const ticketPresentationById = useMemo(() => buildPlanningTicketPresentation(tickets), [tickets]);
  const reviewCycles = useMemo(
    () =>
      [...(planningWorkflow?.reviewCycles ?? [])].sort(
        (left, right) => left.cycleNumber - right.cycleNumber,
      ),
    [planningWorkflow?.reviewCycles],
  );
  const activeSpecImplementationRuns = useMemo(
    () =>
      implementationRuns.filter(
        (run) =>
          (spec !== null && run.specId === spec.id) ||
          run.sourceProposedPlan?.threadId === threadRef?.threadId,
      ),
    [implementationRuns, spec, threadRef?.threadId],
  );
  const workflowThreadsById = useMemo(
    () => new Map(workflowThreadShells.map((thread) => [thread.id, thread] as const)),
    [workflowThreadShells],
  );

  useEffect(() => {
    setExpandedTicketIds(new Set());
    setExpandedReviewCycleIds(new Set());
    setExpandedImplementationRunIds(new Set());
  }, [spec?.id]);

  useEffect(() => {
    if (focusedTicketId === null) return;
    setExpandedSectionIds((current) => addExpandedId(current, "tickets"));
    setExpandedTicketIds((current) => addExpandedId(current, focusedTicketId));
    requestAnimationFrame(() => {
      document
        .querySelector(`[data-planning-ticket-id="${CSS.escape(focusedTicketId)}"]`)
        ?.scrollIntoView({ block: "center", behavior: "smooth" });
    });
  }, [focusedTicketId]);

  const sectionExpanded = useCallback(
    (sectionId: PlanSidebarSectionId) => expandedSectionIds.has(sectionId),
    [expandedSectionIds],
  );

  const setSectionExpanded = useCallback((sectionId: PlanSidebarSectionId, open: boolean) => {
    setExpandedSectionIds((current) => {
      const isOpen = current.has(sectionId);
      return isOpen === open ? current : toggleExpandedId(current, sectionId);
    });
  }, []);

  const handleCopyPlan = useCallback(() => {
    if (!planMarkdown) return;
    copyToClipboard(planMarkdown);
  }, [planMarkdown, copyToClipboard]);

  const handleDownload = useCallback(() => {
    if (!planMarkdown) return;
    const filename = buildProposedPlanMarkdownFilename(planMarkdown);
    downloadPlanAsTextFile(filename, normalizePlanMarkdownForExport(planMarkdown));
  }, [planMarkdown]);

  const handleSaveToWorkspace = useCallback(() => {
    if (!workspaceRoot || !planMarkdown) return;
    const filename = buildProposedPlanMarkdownFilename(planMarkdown);
    setIsSavingToWorkspace(true);
    void (async () => {
      const result = await writeProjectFile({
        environmentId,
        input: {
          cwd: workspaceRoot,
          relativePath: filename,
          contents: normalizePlanMarkdownForExport(planMarkdown),
        },
      });
      setIsSavingToWorkspace(false);
      if (result._tag === "Success") {
        toastManager.add({
          type: "success",
          title: "Plan saved",
          description: result.value.relativePath,
        });
        return;
      }
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not save plan",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
    })();
  }, [environmentId, planMarkdown, workspaceRoot, writeProjectFile]);

  const toggleTicket = useCallback((ticketId: string) => {
    setExpandedTicketIds((current) => toggleExpandedId(current, ticketId));
  }, []);

  const expandAllTickets = useCallback(() => {
    setExpandedTicketIds(new Set(tickets.map((ticket) => ticket.id)));
  }, [tickets]);

  const collapseAllTickets = useCallback(() => {
    setExpandedTicketIds(new Set());
  }, []);

  const toggleReviewCycle = useCallback((cycleId: string) => {
    setExpandedReviewCycleIds((current) => toggleExpandedId(current, cycleId));
  }, []);

  const toggleImplementationRun = useCallback((runId: string) => {
    setExpandedImplementationRunIds((current) => toggleExpandedId(current, runId));
  }, []);

  const handleOpenThread = useCallback(
    (threadId: ThreadId) => {
      onOpenThread?.(threadId);
    },
    [onOpenThread],
  );

  return (
    <div
      className={cn(
        "flex min-h-0 flex-col bg-card/50",
        mode === "sidebar"
          ? "h-full w-[340px] shrink-0 border-l border-border/70"
          : "h-full w-full",
      )}
    >
      {/* Header */}
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-border/60 px-3">
        <div className="flex items-center gap-2">
          <Badge
            variant="info"
            size="sm"
            className="rounded-md px-1.5 py-0 font-semibold tracking-wide uppercase"
          >
            {label}
          </Badge>
          {activePlan ? (
            <span className="text-[11px] text-muted-foreground/60 tabular-nums">
              {formatTimestamp(activePlan.createdAt, timestampFormat)}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-1">
          {planMarkdown ? (
            <Menu>
              <MenuTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    className="text-muted-foreground/50 hover:text-foreground/70"
                    aria-label="Plan actions"
                  />
                }
              >
                <EllipsisIcon className="size-3.5" />
              </MenuTrigger>
              <MenuPopup align="end">
                <MenuItem onClick={handleCopyPlan}>
                  {isCopied ? "Copied!" : "Copy to clipboard"}
                </MenuItem>
                <MenuItem onClick={handleDownload}>Download as markdown</MenuItem>
                <MenuItem
                  onClick={handleSaveToWorkspace}
                  disabled={!workspaceRoot || isSavingToWorkspace}
                >
                  Save to workspace
                </MenuItem>
              </MenuPopup>
            </Menu>
          ) : null}
        </div>
      </div>

      {/* Content */}
      <ScrollArea className="min-h-0 flex-1">
        <div className="p-3 space-y-4">
          {/* Explanation and Plan Steps */}
          {activePlan && (activePlan.explanation || activePlan.steps.length > 0) ? (
            <DisclosureSection
              title="Steps"
              count={activePlan.steps.length}
              open={sectionExpanded("steps")}
              onOpenChange={(open) => setSectionExpanded("steps", open)}
            >
              <div className="space-y-2">
                {activePlan.explanation ? (
                  <p className="text-[13px] leading-relaxed text-muted-foreground/80">
                    {activePlan.explanation}
                  </p>
                ) : null}
                {activePlan.steps.length > 0 ? (
                  <div className="space-y-1">
                    {activePlan.steps.map((step) => (
                      <div
                        key={`${step.status}:${step.step}`}
                        className={cn(
                          "flex items-center gap-2.5 rounded-lg px-2.5 py-2 transition-colors duration-200",
                          step.status === "inProgress" && "bg-blue-500/5",
                          step.status === "completed" && "bg-emerald-500/5",
                        )}
                      >
                        {stepStatusIcon(step.status)}
                        <p
                          className={cn(
                            "text-[13px] leading-snug",
                            step.status === "completed"
                              ? "text-muted-foreground/50 line-through decoration-muted-foreground/20"
                              : step.status === "inProgress"
                                ? "text-foreground/90"
                                : "text-muted-foreground/70",
                          )}
                        >
                          {step.step}
                        </p>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            </DisclosureSection>
          ) : null}

          {/* Proposed Plan Markdown */}
          {planMarkdown ? (
            <DisclosureSection
              title={planTitle ?? "Full Plan"}
              open={sectionExpanded("proposed-plan")}
              onOpenChange={(open) => setSectionExpanded("proposed-plan", open)}
            >
              <div className="rounded-lg border border-border/50 bg-background/50 p-3">
                <ChatMarkdown
                  text={displayedPlanMarkdown ?? ""}
                  cwd={markdownCwd}
                  threadRef={threadRef}
                  isStreaming={false}
                />
              </div>
            </DisclosureSection>
          ) : null}

          {wayfinderMap ? (
            <DisclosureSection
              title="Wayfinder Map"
              count={wayfinderTickets.length}
              open={sectionExpanded("wayfinder-map")}
              onOpenChange={(open) => setSectionExpanded("wayfinder-map", open)}
            >
              <div className="space-y-3">
                <div className="space-y-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <MapIcon className="size-3.5 shrink-0 text-muted-foreground/45" />
                    <h3 className="min-w-0 truncate text-sm font-medium">{wayfinderMap.title}</h3>
                    <Badge variant="secondary" size="sm">
                      Wayfinding
                    </Badge>
                  </div>
                  <MetadataLine label="Map ID" value={wayfinderMap.id} />
                  <MetadataLine
                    label="Updated"
                    value={formatCompactTimestamp(wayfinderMap.updatedAt, timestampFormat)}
                  />
                </div>
                <div className="rounded-md border border-border/50 bg-background/45 p-2">
                  <ChatMarkdown
                    text={wayfinderMap.summaryMarkdown}
                    cwd={markdownCwd}
                    threadRef={threadRef}
                    isStreaming={false}
                  />
                </div>
                <div className="space-y-1 border-t border-border/45 pt-2">
                  <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/55">
                    Decision tickets
                  </div>
                  {wayfinderTickets.length > 0 ? (
                    wayfinderTickets.map((ticket) => (
                      <ItemDisclosure
                        key={ticket.id}
                        label={`wayfinder ticket ${ticket.title}`}
                        open={expandedTicketIds.has(ticket.id)}
                        onOpenChange={() => toggleTicket(ticket.id)}
                        summary={
                          <>
                            <span className="min-w-0 flex-1 text-[13px]">{ticket.title}</span>
                            <Badge variant={statusVariant(ticket.status)} size="sm">
                              {ticket.status}
                            </Badge>
                          </>
                        }
                      >
                        <div className="space-y-2 pl-5">
                          {ticket.dependencies.length > 0 ? (
                            <div className="flex flex-wrap gap-1">
                              {ticket.dependencies.map((dependency) => (
                                <Badge
                                  key={`${ticket.id}:${dependency.ticketId}`}
                                  variant="outline"
                                  size="sm"
                                >
                                  Depends on {dependency.ticketId}
                                </Badge>
                              ))}
                            </div>
                          ) : null}
                          <ChatMarkdown
                            text={ticket.bodyMarkdown}
                            cwd={markdownCwd}
                            threadRef={threadRef}
                            isStreaming={false}
                          />
                        </div>
                      </ItemDisclosure>
                    ))
                  ) : (
                    <p className="text-[12px] text-muted-foreground/45">
                      No decision tickets have been mapped yet.
                    </p>
                  )}
                </div>
              </div>
            </DisclosureSection>
          ) : null}

          <DisclosureSection
            title="Spec"
            open={sectionExpanded("spec")}
            onOpenChange={(open) => setSectionExpanded("spec", open)}
            actions={
              spec && onLoadSpecBundle ? (
                <Button
                  size="xs"
                  variant="ghost"
                  className="h-6 px-1.5 text-[11px]"
                  onClick={() => onLoadSpecBundle(spec.id)}
                >
                  <RefreshCwIcon className="size-3" />
                  Refresh
                </Button>
              ) : !spec && !automationOwned && onCreateSpec ? (
                <Button
                  size="xs"
                  variant="outline"
                  className="h-6 text-[11px]"
                  onClick={() => onCreateSpec()}
                >
                  <FileTextIcon className="size-3" />
                  Create Spec
                </Button>
              ) : null
            }
          >
            {spec ? (
              <div className="space-y-2">
                <div className="space-y-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <FileTextIcon className="size-3.5 shrink-0 text-muted-foreground/45" />
                    <h3 className="min-w-0 truncate text-sm font-medium">{spec.title}</h3>
                    <Badge variant={statusVariant(planningWorkflow?.stage ?? "unknown")} size="sm">
                      {planningWorkflow?.stage ?? "unknown"}
                    </Badge>
                  </div>
                  <MetadataLine label="Workflow" value={spec.workflowId} />
                  <MetadataLine label="Source" value={spec.sourceThreadId} />
                  <MetadataLine
                    label="Created"
                    value={formatCompactTimestamp(spec.createdAt, timestampFormat)}
                  />
                  <MetadataLine
                    label="Updated"
                    value={formatCompactTimestamp(spec.updatedAt, timestampFormat)}
                  />
                </div>
                <div className="rounded-md border border-border/50 bg-background/45 p-2">
                  <ChatMarkdown
                    text={spec.summaryMarkdown}
                    cwd={markdownCwd}
                    threadRef={threadRef}
                    isStreaming={false}
                  />
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {onOpenThread ? (
                    <Button
                      size="xs"
                      variant="outline"
                      className="h-6 text-[11px]"
                      onClick={() => handleOpenThread(spec.sourceThreadId)}
                    >
                      <ExternalLinkIcon className="size-3" />
                      Source
                    </Button>
                  ) : null}
                  {!automationOwned && onRequestTicketReview ? (
                    <Button
                      size="xs"
                      variant="outline"
                      className="h-6 text-[11px]"
                      onClick={() => onRequestTicketReview(spec.id)}
                      disabled={tickets.length === 0}
                    >
                      <RefreshCwIcon className="size-3" />
                      Review
                    </Button>
                  ) : null}
                  {!automationOwned && onLaunchImplementationRun ? (
                    <Button
                      size="xs"
                      variant="outline"
                      className="h-6 text-[11px]"
                      onClick={() => onLaunchImplementationRun(spec.id)}
                      disabled={tickets.length === 0}
                    >
                      <PlayIcon className="size-3" />
                      Implement
                    </Button>
                  ) : null}
                </div>
              </div>
            ) : (
              <p className="text-[12px] text-muted-foreground/45">
                No projected Spec is available for this thread.
              </p>
            )}
          </DisclosureSection>

          <DisclosureSection
            title="Tickets"
            count={tickets.length}
            open={sectionExpanded("tickets")}
            onOpenChange={(open) => setSectionExpanded("tickets", open)}
          >
            {tickets.length > 0 ? (
              <div className="space-y-2">
                <div className="flex justify-end gap-1">
                  <Button
                    size="xs"
                    variant="ghost"
                    className="h-6 px-1.5 text-[11px]"
                    onClick={expandAllTickets}
                  >
                    Expand all
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    className="h-6 px-1.5 text-[11px]"
                    onClick={collapseAllTickets}
                  >
                    Collapse all
                  </Button>
                </div>
                <div className="divide-y divide-border/45">
                  {tickets.map((ticket) => {
                    const expanded = expandedTicketIds.has(ticket.id);
                    const presentation = ticketPresentationById.get(ticket.id);
                    return (
                      <div
                        key={ticket.id}
                        data-planning-ticket-id={ticket.id}
                        className="py-2 first:pt-0 last:pb-0"
                      >
                        <ItemDisclosure
                          label={`ticket ${presentation?.label ?? ticket.title}`}
                          open={expanded}
                          onOpenChange={() => toggleTicket(ticket.id)}
                          summary={
                            <>
                              <span className="mt-px min-w-6 shrink-0 text-[11px] tabular-nums text-muted-foreground/45">
                                #{presentation?.number ?? 1}
                              </span>
                              <span className="min-w-0 flex-1 text-[13px] leading-5 text-foreground/90">
                                {ticket.title}
                              </span>
                              <Badge variant={statusVariant(ticket.status)} size="sm">
                                {ticket.status}
                              </Badge>
                            </>
                          }
                        >
                          <div className="space-y-2 pl-5">
                            {ticket.dependencies.length > 0 ? (
                              <div className="flex flex-wrap gap-1">
                                {ticket.dependencies.map((dependency) => (
                                  <Badge
                                    key={`${ticket.id}:${dependency.ticketId}`}
                                    variant="outline"
                                    size="sm"
                                    className="h-4 px-1 text-[10px]"
                                  >
                                    Depends on{" "}
                                    {planningTicketLabel(
                                      dependency.ticketId,
                                      ticketPresentationById,
                                    )}
                                  </Badge>
                                ))}
                              </div>
                            ) : null}
                            <PlannedFileChanges changes={ticket.plannedFileChanges} />
                            <div className="rounded-md border border-border/50 bg-background/45 p-2">
                              <ChatMarkdown
                                text={ticket.bodyMarkdown}
                                cwd={markdownCwd}
                                threadRef={threadRef}
                                isStreaming={false}
                              />
                            </div>
                          </div>
                        </ItemDisclosure>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : (
              <p className="text-[12px] text-muted-foreground/45">
                No projected tickets are available for this Spec.
              </p>
            )}
          </DisclosureSection>

          <DisclosureSection
            title="Ticket Review Cycles"
            count={reviewCycles.length}
            open={sectionExpanded("review-cycles")}
            onOpenChange={(open) => setSectionExpanded("review-cycles", open)}
          >
            {reviewCycles.length > 0 ? (
              <div className="space-y-2">
                {reviewCycles.map((cycle) => {
                  const cycleId = `${cycle.reviewerThreadId}:${cycle.cycleNumber}`;
                  const expanded = expandedReviewCycleIds.has(cycleId);
                  return (
                    <div
                      key={cycleId}
                      className="border-t border-border/45 pt-2 first:border-t-0 first:pt-0"
                    >
                      <ItemDisclosure
                        label={`review cycle ${cycle.cycleNumber}`}
                        open={expanded}
                        onOpenChange={() => toggleReviewCycle(cycleId)}
                        summary={
                          <>
                            <Badge variant={statusVariant(cycle.status)} size="sm">
                              {cycle.mode} · {cycle.cycleNumber}/10
                            </Badge>
                            <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground/60">
                              {formatCompactTimestamp(cycle.createdAt, timestampFormat)}
                            </span>
                            <span className="shrink-0 text-[10px] text-muted-foreground/50">
                              {cycle.status}
                            </span>
                          </>
                        }
                        actions={
                          onOpenThread ? (
                            <Button
                              size="icon-xs"
                              variant="ghost"
                              aria-label="Open reviewer thread"
                              onClick={() => handleOpenThread(cycle.reviewerThreadId)}
                            >
                              <ExternalLinkIcon className="size-3.5" />
                            </Button>
                          ) : null
                        }
                      >
                        <div className="space-y-1 pl-5">
                          <MetadataLine label="Reviewer" value={cycle.reviewerThreadId} />
                          <MetadataLine
                            label="Targets"
                            value={
                              formatPlanningTicketLabels(
                                cycle.targetPlanningTicketIds,
                                ticketPresentationById,
                              ) || "All tickets"
                            }
                          />
                          {cycle.failingPlanningTicketIds.length > 0 ? (
                            <MetadataLine
                              label="Failing"
                              value={formatPlanningTicketLabels(
                                cycle.failingPlanningTicketIds,
                                ticketPresentationById,
                              )}
                            />
                          ) : null}
                          {cycle.editedPlanningTicketIds.length > 0 ? (
                            <MetadataLine
                              label="Edited"
                              value={formatPlanningTicketLabels(
                                cycle.editedPlanningTicketIds,
                                ticketPresentationById,
                              )}
                            />
                          ) : null}
                          {cycle.verdictMarkdown.trim().length > 0 ? (
                            <div className="rounded-md border border-border/50 bg-background/45 p-2">
                              <ChatMarkdown
                                text={cycle.verdictMarkdown}
                                cwd={markdownCwd}
                                threadRef={threadRef}
                                isStreaming={false}
                              />
                            </div>
                          ) : null}
                        </div>
                      </ItemDisclosure>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="text-[12px] text-muted-foreground/45">
                No review cycles have been projected yet.
              </p>
            )}
          </DisclosureSection>

          <DisclosureSection
            title="Implementation Runs"
            count={activeSpecImplementationRuns.length}
            open={sectionExpanded("implementation-runs")}
            onOpenChange={(open) => setSectionExpanded("implementation-runs", open)}
          >
            {activeSpecImplementationRuns.length > 0 ? (
              <div className="space-y-3">
                {activeSpecImplementationRuns.map((run) => {
                  const orchestratorThread = workflowThreadsById.get(run.orchestratorThreadId);
                  const expanded = expandedImplementationRunIds.has(run.id);
                  return (
                    <div
                      key={run.id}
                      className="border-t border-border/45 pt-2 first:border-t-0 first:pt-0"
                    >
                      <ItemDisclosure
                        label={`implementation run ${run.id}`}
                        open={expanded}
                        onOpenChange={() => toggleImplementationRun(run.id)}
                        summary={
                          <>
                            <Badge variant={statusVariant(run.status)} size="sm">
                              {run.status}
                            </Badge>
                            <span className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground/70">
                              {run.id}
                            </span>
                          </>
                        }
                        actions={
                          onOpenThread ? (
                            <Button
                              size="icon-xs"
                              variant="ghost"
                              aria-label="Open implementation thread"
                              onClick={() => handleOpenThread(run.orchestratorThreadId)}
                            >
                              <ExternalLinkIcon className="size-3.5" />
                            </Button>
                          ) : null
                        }
                      >
                        <div className="space-y-2 pl-5">
                          <div className="space-y-1">
                            <MetadataLine
                              label="Branch"
                              value={
                                <span className="inline-flex min-w-0 items-center gap-1">
                                  <GitBranchIcon className="size-3 shrink-0" />
                                  <span className="truncate">{run.orchestratorBranch}</span>
                                </span>
                              }
                            />
                            <MetadataLine label="Base" value={run.baseBranch} />
                            <MetadataLine label="Pinned" value={run.pinnedCommit} />
                            <MetadataLine label="Worktree" value={run.orchestratorWorktreePath} />
                            {orchestratorThread ? (
                              <MetadataLine label="Thread" value={orchestratorThread.title} />
                            ) : null}
                          </div>
                          <ImplementationTicketFlow
                            run={run}
                            presentationById={ticketPresentationById}
                            onOpenThread={onOpenThread}
                          />
                          <div className="grid gap-1 text-[11px] text-muted-foreground/70">
                            <div className="flex items-center gap-1.5">
                              <GitMergeIcon className="size-3 text-muted-foreground/45" />
                              <span>Merge gate: {run.baseBranchMergePolicy}</span>
                            </div>
                            <div>
                              Validation:{" "}
                              {run.finalValidation
                                ? `${run.finalValidation.command} (${run.finalValidation.status})`
                                : run.launchSummary.validationCommands.join(", ")}
                            </div>
                            <div>
                              App dev: {run.appDevStack.status}
                              {run.appDevStack.frontendUrl
                                ? ` · ${run.appDevStack.frontendUrl}`
                                : ""}
                            </div>
                            <div>
                              QA repairs: {run.qaCycleCount}/{IMPLEMENTATION_RUN_MAX_QA_REPAIRS};
                              Browser reviews: {run.qaAttemptCount}
                            </div>
                            {run.lastQaFailure ? (
                              <div className="text-destructive">
                                Last QA failure ({run.lastQaFailure.kind}):{" "}
                                {run.lastQaFailure.status}
                              </div>
                            ) : null}
                            {run.qaExhaustedAt ? (
                              <div className="text-destructive">
                                QA exhausted; Code Review and publication continue best-effort.
                              </div>
                            ) : null}
                            <div>
                              Change request:{" "}
                              {run.changeRequest
                                ? `#${run.changeRequest.number} ${run.changeRequest.state}`
                                : run.changeRequestFailure
                                  ? `failed: ${run.changeRequestFailure.reason}`
                                  : "not published"}
                            </div>
                            {run.retryableFailure ? (
                              // The failure record survives a retry so attempts
                              // accumulate, so it describes the last attempt
                              // rather than the current state once work resumes.
                              <div
                                className={
                                  run.status === "needs-human-attention"
                                    ? "text-destructive"
                                    : "text-muted-foreground/60"
                                }
                              >
                                {run.status === "needs-human-attention" ? "" : "Last failure — "}
                                {run.retryableFailure.stage}: {run.retryableFailure.detail}
                              </div>
                            ) : null}
                          </div>
                          <div className="flex flex-wrap gap-1.5">
                            {run.changeRequest?.url ? (
                              <Button
                                size="xs"
                                variant="outline"
                                className="h-6 text-[11px]"
                                onClick={() =>
                                  window.open(run.changeRequest?.url, "_blank", "noopener")
                                }
                              >
                                <ExternalLinkIcon className="size-3" />
                                PR
                              </Button>
                            ) : null}
                            {run.changeRequestFailure &&
                            run.retryableFailure === null &&
                            onRetryImplementationChangeRequest ? (
                              <Button
                                size="xs"
                                variant="outline"
                                className="h-6 text-[11px]"
                                onClick={() => onRetryImplementationChangeRequest(run.id)}
                              >
                                <RotateCcwIcon className="size-3" />
                                Retry PR
                              </Button>
                            ) : null}
                            {run.retryableFailure &&
                            run.status === "needs-human-attention" &&
                            onRetryImplementationRun ? (
                              <Button
                                size="xs"
                                variant="outline"
                                className="h-6 text-[11px]"
                                onClick={() => onRetryImplementationRun(run.id)}
                              >
                                <RotateCcwIcon className="size-3" />
                                Retry {run.retryableFailure.stage}
                              </Button>
                            ) : null}
                            {run.status !== "completed" &&
                            run.status !== "canceled" &&
                            onCancelImplementationRun ? (
                              <Button
                                size="xs"
                                variant="outline"
                                className="h-6 text-[11px]"
                                onClick={() => onCancelImplementationRun(run.id)}
                              >
                                <SquareIcon className="size-3" />
                                Cancel run
                              </Button>
                            ) : null}
                          </div>
                        </div>
                      </ItemDisclosure>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="text-[12px] text-muted-foreground/45">
                No implementation runs have been projected for this Spec.
              </p>
            )}
          </DisclosureSection>

          {/* Empty state */}
          {!activePlan &&
          !planMarkdown &&
          !wayfinderMap &&
          !spec &&
          activeSpecImplementationRuns.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <p className="text-[13px] text-muted-foreground/40">No active plan yet.</p>
              <p className="mt-1 text-[11px] text-muted-foreground/30">
                Plans will appear here when generated.
              </p>
            </div>
          ) : null}
        </div>
      </ScrollArea>
    </div>
  );
});

export default PlanSidebar;
export type { PlanSidebarProps };
