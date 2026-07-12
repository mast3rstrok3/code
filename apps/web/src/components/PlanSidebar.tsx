import { memo, useState, useCallback, useEffect, useMemo } from "react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  OrchestrationImplementationRun,
  OrchestrationPlanningSpecId,
  OrchestrationPlanningWorkflow,
  OrchestrationThreadShell,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { type TimestampFormat } from "@t3tools/contracts/settings";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { ScrollArea } from "./ui/scroll-area";
import ChatMarkdown from "./ChatMarkdown";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ExternalLinkIcon,
  FileTextIcon,
  GitBranchIcon,
  GitMergeIcon,
  EllipsisIcon,
  LoaderIcon,
  PlayIcon,
  RefreshCwIcon,
  RotateCcwIcon,
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

function SectionHeader({
  title,
  count,
  children,
}: {
  title: string;
  count?: number | undefined;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-2 border-t border-border/50 pt-3">
      <div className="flex min-w-0 items-center gap-2">
        <p className="text-[10px] font-semibold tracking-widest text-muted-foreground/40 uppercase">
          {title}
        </p>
        {count !== undefined ? (
          <Badge variant="outline" size="sm" className="h-4 px-1 text-[10px]">
            {count}
          </Badge>
        ) : null}
      </div>
      {children ? <div className="flex shrink-0 items-center gap-1">{children}</div> : null}
    </div>
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
  onLoadSpecBundle?: (specId: OrchestrationPlanningSpecId) => void;
  onRequestTicketReview?: (specId: OrchestrationPlanningSpecId) => void;
  onLaunchImplementationRun?: (specId: OrchestrationPlanningSpecId) => void;
  onRetryImplementationChangeRequest?: (runId: OrchestrationImplementationRun["id"]) => void;
}

const EMPTY_WORKFLOW_THREAD_SHELLS: ReadonlyArray<OrchestrationThreadShell> = [];
const EMPTY_IMPLEMENTATION_RUNS: ReadonlyArray<OrchestrationImplementationRun> = [];

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
  onLoadSpecBundle,
  onRequestTicketReview,
  onLaunchImplementationRun,
  onRetryImplementationChangeRequest,
}: PlanSidebarProps) {
  const [proposedPlanExpanded, setProposedPlanExpanded] = useState(false);
  const [ticketsSectionExpanded, setTicketsSectionExpanded] = useState(true);
  const [expandedTicketIds, setExpandedTicketIds] = useState<ReadonlySet<string>>(() => new Set());
  const [isSavingToWorkspace, setIsSavingToWorkspace] = useState(false);
  const writeProjectFile = useAtomCommand(projectEnvironment.writeFile, {
    reportFailure: false,
  });
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: "plan" });

  const planMarkdown = activeProposedPlan?.planMarkdown ?? null;
  const displayedPlanMarkdown = planMarkdown ? stripDisplayedPlanMarkdown(planMarkdown) : null;
  const planTitle = planMarkdown ? proposedPlanTitle(planMarkdown) : null;
  const spec = planningWorkflow?.spec ?? null;
  const tickets = useMemo(
    () =>
      [...(planningWorkflow?.tickets ?? [])].sort((left, right) => left.ordinal - right.ordinal),
    [planningWorkflow?.tickets],
  );
  const reviewCycles = useMemo(
    () =>
      [...(planningWorkflow?.reviewCycles ?? [])].sort(
        (left, right) => left.cycleNumber - right.cycleNumber,
      ),
    [planningWorkflow?.reviewCycles],
  );
  const activeSpecImplementationRuns = useMemo(
    () => (spec ? implementationRuns.filter((run) => run.specId === spec.id) : []),
    [implementationRuns, spec],
  );
  const workflowThreadsById = useMemo(
    () => new Map(workflowThreadShells.map((thread) => [thread.id, thread] as const)),
    [workflowThreadShells],
  );

  useEffect(() => {
    setExpandedTicketIds(new Set());
    setTicketsSectionExpanded(true);
  }, [spec?.id]);

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
    setExpandedTicketIds((current) => {
      const next = new Set(current);
      if (next.has(ticketId)) {
        next.delete(ticketId);
      } else {
        next.add(ticketId);
      }
      return next;
    });
  }, []);

  const expandAllTickets = useCallback(() => {
    setTicketsSectionExpanded(true);
    setExpandedTicketIds(new Set(tickets.map((ticket) => ticket.id)));
  }, [tickets]);

  const collapseAllTickets = useCallback(() => {
    setExpandedTicketIds(new Set());
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
          {/* Explanation */}
          {activePlan?.explanation ? (
            <p className="text-[13px] leading-relaxed text-muted-foreground/80">
              {activePlan.explanation}
            </p>
          ) : null}

          {/* Plan Steps */}
          {activePlan && activePlan.steps.length > 0 ? (
            <div className="space-y-1">
              <p className="mb-2 text-[10px] font-semibold tracking-widest text-muted-foreground/40 uppercase">
                Steps
              </p>
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

          {/* Proposed Plan Markdown */}
          {planMarkdown ? (
            <div className="space-y-2">
              <button
                type="button"
                className="group flex w-full items-center gap-1.5 text-left"
                onClick={() => setProposedPlanExpanded((v) => !v)}
              >
                {proposedPlanExpanded ? (
                  <ChevronDownIcon className="size-3 shrink-0 text-muted-foreground/40 transition-transform" />
                ) : (
                  <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground/40 transition-transform" />
                )}
                <span className="text-[10px] font-semibold tracking-widest text-muted-foreground/40 uppercase group-hover:text-muted-foreground/60">
                  {planTitle ?? "Full Plan"}
                </span>
              </button>
              {proposedPlanExpanded ? (
                <div className="rounded-lg border border-border/50 bg-background/50 p-3">
                  <ChatMarkdown
                    text={displayedPlanMarkdown ?? ""}
                    cwd={markdownCwd}
                    threadRef={threadRef}
                    isStreaming={false}
                  />
                </div>
              ) : null}
            </div>
          ) : null}

          <div className="space-y-2">
            <SectionHeader title="Spec">
              {spec && onLoadSpecBundle ? (
                <Button
                  size="xs"
                  variant="ghost"
                  className="h-6 px-1.5 text-[11px]"
                  onClick={() => onLoadSpecBundle(spec.id)}
                >
                  <RefreshCwIcon className="size-3" />
                  Refresh
                </Button>
              ) : null}
            </SectionHeader>
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
          </div>

          <div className="space-y-2">
            <SectionHeader title="Tickets" count={tickets.length}>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={
                  ticketsSectionExpanded ? "Collapse tickets section" : "Expand tickets section"
                }
                onClick={() => setTicketsSectionExpanded((value) => !value)}
              >
                {ticketsSectionExpanded ? (
                  <ChevronDownIcon className="size-3.5" />
                ) : (
                  <ChevronRightIcon className="size-3.5" />
                )}
              </Button>
              <Button
                size="xs"
                variant="ghost"
                className="h-6 px-1.5 text-[11px]"
                onClick={expandAllTickets}
                disabled={tickets.length === 0}
              >
                Expand
              </Button>
              <Button
                size="xs"
                variant="ghost"
                className="h-6 px-1.5 text-[11px]"
                onClick={collapseAllTickets}
                disabled={tickets.length === 0}
              >
                Collapse
              </Button>
            </SectionHeader>
            {ticketsSectionExpanded ? (
              tickets.length > 0 ? (
                <div className="divide-y divide-border/45">
                  {tickets.map((ticket) => {
                    const expanded = expandedTicketIds.has(ticket.id);
                    return (
                      <div key={ticket.id} className="py-2 first:pt-0 last:pb-0">
                        <button
                          type="button"
                          className="flex w-full min-w-0 items-start gap-2 text-left"
                          onClick={() => toggleTicket(ticket.id)}
                        >
                          {expanded ? (
                            <ChevronDownIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/45" />
                          ) : (
                            <ChevronRightIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/45" />
                          )}
                          <span className="mt-px min-w-6 shrink-0 text-[11px] tabular-nums text-muted-foreground/45">
                            #{ticket.ordinal + 1}
                          </span>
                          <span className="min-w-0 flex-1 text-[13px] leading-5 text-foreground/90">
                            {ticket.title}
                          </span>
                          <Badge variant={statusVariant(ticket.status)} size="sm">
                            {ticket.status}
                          </Badge>
                        </button>
                        {ticket.dependencies.length > 0 ? (
                          <div className="mt-1 flex flex-wrap gap-1 pl-12">
                            {ticket.dependencies.map((dependency) => (
                              <Badge
                                key={`${ticket.id}:${dependency.ticketId}`}
                                variant="outline"
                                size="sm"
                                className="h-4 px-1 text-[10px]"
                              >
                                dep {dependency.ticketId}
                              </Badge>
                            ))}
                          </div>
                        ) : null}
                        {expanded ? (
                          <div className="mt-2 rounded-md border border-border/50 bg-background/45 p-2">
                            <ChatMarkdown
                              text={ticket.bodyMarkdown}
                              cwd={markdownCwd}
                              threadRef={threadRef}
                              isStreaming={false}
                            />
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="text-[12px] text-muted-foreground/45">
                  No projected tickets are available for this Spec.
                </p>
              )
            ) : null}
          </div>

          <div className="space-y-2">
            <SectionHeader title="Ticket Review Cycles" count={reviewCycles.length} />
            {reviewCycles.length > 0 ? (
              <div className="space-y-2">
                {reviewCycles.map((cycle) => (
                  <div
                    key={`${cycle.reviewerThreadId}:${cycle.cycleNumber}`}
                    className="space-y-1 border-t border-border/45 pt-2 first:border-t-0 first:pt-0"
                  >
                    <div className="flex items-center gap-2">
                      <Badge variant={statusVariant(cycle.status)} size="sm">
                        Cycle {cycle.cycleNumber}
                      </Badge>
                      <span className="text-[11px] text-muted-foreground/60">
                        {formatCompactTimestamp(cycle.createdAt, timestampFormat)}
                      </span>
                      {onOpenThread ? (
                        <Button
                          size="icon-xs"
                          variant="ghost"
                          aria-label="Open reviewer thread"
                          onClick={() => handleOpenThread(cycle.reviewerThreadId)}
                        >
                          <ExternalLinkIcon className="size-3.5" />
                        </Button>
                      ) : null}
                    </div>
                    <MetadataLine label="Reviewer" value={cycle.reviewerThreadId} />
                    {cycle.failingPlanningTicketIds.length > 0 ? (
                      <MetadataLine
                        label="Failing"
                        value={cycle.failingPlanningTicketIds.join(", ")}
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
                ))}
              </div>
            ) : (
              <p className="text-[12px] text-muted-foreground/45">
                No review cycles have been projected yet.
              </p>
            )}
          </div>

          <div className="space-y-2">
            <SectionHeader
              title="Implementation Runs"
              count={activeSpecImplementationRuns.length}
            />
            {activeSpecImplementationRuns.length > 0 ? (
              <div className="space-y-3">
                {activeSpecImplementationRuns.map((run) => {
                  const orchestratorThread = workflowThreadsById.get(run.orchestratorThreadId);
                  return (
                    <div
                      key={run.id}
                      className="space-y-2 border-t border-border/45 pt-2 first:border-t-0 first:pt-0"
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        <Badge variant={statusVariant(run.status)} size="sm">
                          {run.status}
                        </Badge>
                        <span className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground/70">
                          {run.id}
                        </span>
                        {onOpenThread ? (
                          <Button
                            size="icon-xs"
                            variant="ghost"
                            aria-label="Open implementation thread"
                            onClick={() => handleOpenThread(run.orchestratorThreadId)}
                          >
                            <ExternalLinkIcon className="size-3.5" />
                          </Button>
                        ) : null}
                      </div>
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
                      <div className="flex flex-wrap gap-1">
                        {run.ticketStates.map((ticketState) => (
                          <Badge
                            key={`${run.id}:${ticketState.ticketId}`}
                            variant={statusVariant(ticketState.status)}
                            size="sm"
                            className="h-4 px-1 text-[10px]"
                          >
                            {ticketState.ticketId}: {ticketState.status}
                          </Badge>
                        ))}
                      </div>
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
                          {run.appDevStack.frontendUrl ? ` · ${run.appDevStack.frontendUrl}` : ""}
                        </div>
                        <div>
                          Browser review: {run.qaTooling.status}; QA attempts {run.qaAttemptCount}
                        </div>
                        <div>
                          Change request:{" "}
                          {run.changeRequest
                            ? `#${run.changeRequest.number} ${run.changeRequest.state}`
                            : run.changeRequestFailure
                              ? `failed: ${run.changeRequestFailure.reason}`
                              : "not published"}
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {run.ticketStates
                          .filter((ticketState) => ticketState.workerThreadId !== null)
                          .map((ticketState) => (
                            <Button
                              key={`${run.id}:worker:${ticketState.ticketId}`}
                              size="xs"
                              variant="outline"
                              className="h-6 text-[11px]"
                              onClick={() =>
                                ticketState.workerThreadId
                                  ? handleOpenThread(ticketState.workerThreadId)
                                  : undefined
                              }
                              disabled={!onOpenThread}
                            >
                              Worker {ticketState.ticketId}
                            </Button>
                          ))}
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
                        {run.changeRequestFailure && onRetryImplementationChangeRequest ? (
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
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="text-[12px] text-muted-foreground/45">
                No implementation runs have been projected for this Spec.
              </p>
            )}
          </div>

          {/* Empty state */}
          {!activePlan && !planMarkdown && !spec && activeSpecImplementationRuns.length === 0 ? (
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
