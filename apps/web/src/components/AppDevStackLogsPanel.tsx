import type { AppDevStackPodLogEntry, EnvironmentId, TimestampFormat } from "@t3tools/contracts";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  CheckIcon,
  CopyIcon,
  LoaderIcon,
  RefreshCwIcon,
  SearchIcon,
  ScrollTextIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";

import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { cn } from "~/lib/utils";
import { appDevStackEnvironment } from "~/state/appDevStacks";
import { useEnvironmentQuery } from "~/state/query";
import { formatShortTimestamp } from "~/timestampFormat";

import {
  buildAssociatedStackPodLogsResult,
  buildStackPodLogViews,
  formatAllStackPodLogsForClipboard,
  normalizeStackWorktreePath,
  resolveCurrentStackPath,
  stackLogReadLimitLabel,
  stackLogTailSelectionLabel,
  stackLogTailSelectionToReadLimit,
  type StackLogTailSelection,
  stackPodLogOwnerLabel,
} from "./AppDevStackLogsPanel.logic";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Input } from "./ui/input";
import { ScrollArea } from "./ui/scroll-area";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";
import { Switch } from "./ui/switch";

const TAIL_LINE_OPTIONS = [100, 300, 1000, 5000, "all"] as const;

interface AppDevStackLogsPanelProps {
  readonly environmentId: EnvironmentId;
  readonly timestampFormat: TimestampFormat;
  readonly activeThreadWorktreePath?: string | null | undefined;
  readonly workspaceRoot?: string | null | undefined;
  readonly gitCwd?: string | null | undefined;
}

function PanelState(props: {
  readonly icon?: "loading" | "warning" | "logs";
  readonly title: string;
  readonly description: string;
  readonly action?: ReactNode;
}) {
  const iconClassName = "mx-auto mb-3 size-7 text-muted-foreground";
  return (
    <div className="flex h-full min-h-0 items-center justify-center bg-background p-6 text-center">
      <div className="max-w-sm">
        {props.icon === "loading" ? (
          <LoaderIcon className={cn(iconClassName, "animate-spin")} />
        ) : props.icon === "warning" ? (
          <TriangleAlertIcon className={iconClassName} />
        ) : (
          <ScrollTextIcon className={iconClassName} />
        )}
        <div className="text-sm font-medium">{props.title}</div>
        <div className="mt-1 text-xs leading-relaxed text-muted-foreground">
          {props.description}
        </div>
        {props.action ? <div className="mt-4">{props.action}</div> : null}
      </div>
    </div>
  );
}

function formatFetchedAt(value: string, timestampFormat: TimestampFormat): string {
  return formatShortTimestamp(value, timestampFormat);
}

function readyLabel(entry: AppDevStackPodLogEntry): string {
  return entry.ready ? "ready" : "not ready";
}

function restartLabel(count: number): string {
  return count === 1 ? "1 restart" : `${String(count)} restarts`;
}

function podCountLabel(count: number): string {
  return count === 1 ? "1 pod" : `${String(count)} pods`;
}

function containerCountLabel(count: number): string {
  return count === 1 ? "1 container" : `${String(count)} containers`;
}

function ContainerLogBlock({ entry }: { readonly entry: AppDevStackPodLogEntry }) {
  const owner = stackPodLogOwnerLabel(entry);
  const logText = entry.logs.length > 0 ? entry.logs : "No log lines returned.";

  return (
    <article className="rounded-md border border-border/70 bg-background">
      <div className="border-b border-border/70 px-3 py-2">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="min-w-0 truncate text-xs font-semibold text-foreground">
            {entry.podName}
          </span>
          <span className="text-xs text-muted-foreground">/</span>
          <span className="min-w-0 truncate text-xs font-semibold text-foreground">
            {entry.containerName}
          </span>
          <span
            className={cn(
              "inline-flex h-5 items-center rounded-full border px-2 text-[11px] font-medium",
              entry.phase === "Running" &&
                "border-emerald-500/30 bg-emerald-500/10 text-emerald-600",
              entry.phase === "Failed" &&
                "border-destructive/30 bg-destructive/10 text-destructive",
              entry.phase === "Pending" && "border-amber-500/30 bg-amber-500/10 text-amber-600",
              entry.phase !== "Running" &&
                entry.phase !== "Failed" &&
                entry.phase !== "Pending" &&
                "border-border bg-muted text-muted-foreground",
            )}
          >
            {entry.phase}
          </span>
          <span className="text-[11px] text-muted-foreground">{readyLabel(entry)}</span>
          <span className="text-[11px] text-muted-foreground">
            {restartLabel(entry.restartCount)}
          </span>
          {entry.state ? (
            <span className="text-[11px] text-muted-foreground">{entry.state}</span>
          ) : null}
          {owner ? (
            <span className="truncate text-[11px] text-muted-foreground">{owner}</span>
          ) : null}
        </div>
        {entry.error ? (
          <div className="mt-2 flex items-start gap-2 rounded-md border border-destructive/25 bg-destructive/5 px-2 py-1.5 text-xs text-destructive">
            <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
            <span className="min-w-0 break-words">{entry.error}</span>
          </div>
        ) : null}
      </div>
      <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-[11px] leading-relaxed text-foreground/85">
        {logText}
      </pre>
    </article>
  );
}

export function AppDevStackLogsPanel(props: AppDevStackLogsPanelProps) {
  const [tailSelection, setTailSelection] = useState<StackLogTailSelection>(300);
  const [search, setSearch] = useState("");
  const [hideEmpty, setHideEmpty] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [collapsedServiceKeys, setCollapsedServiceKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: "app stack pod logs" });

  const readLimit = useMemo(() => stackLogTailSelectionToReadLimit(tailSelection), [tailSelection]);
  const associatedWorktreePath = useMemo(
    () =>
      resolveCurrentStackPath({
        activeThreadWorktreePath: props.activeThreadWorktreePath,
        workspaceRoot: props.workspaceRoot,
        gitCwd: props.gitCwd,
      }),
    [props.activeThreadWorktreePath, props.gitCwd, props.workspaceRoot],
  );

  const statusQuery = useEnvironmentQuery(
    appDevStackEnvironment.status({
      environmentId: props.environmentId,
      input: {},
    }),
  );
  const backendEnabled = statusQuery.data?.enabled === true;
  const associatedStackQuery = useEnvironmentQuery(
    backendEnabled && associatedWorktreePath !== null
      ? appDevStackEnvironment.byWorktree({
          environmentId: props.environmentId,
          input: { worktreePath: associatedWorktreePath },
        })
      : null,
  );
  const associatedStack = associatedStackQuery.data?.stack ?? null;
  const stackLogsQuery = useEnvironmentQuery(
    backendEnabled && associatedStack !== null && readLimit.mode === "tail"
      ? appDevStackEnvironment.getStackPodLogs({
          environmentId: props.environmentId,
          input: {
            stackId: associatedStack.id,
            tailLines: readLimit.tailLines,
          },
        })
      : null,
  );
  const allLogsQuery = useEnvironmentQuery(
    backendEnabled && associatedStack !== null && readLimit.mode === "all"
      ? appDevStackEnvironment.getAllStackPodLogs({
          environmentId: props.environmentId,
          input: { limit: readLimit },
        })
      : null,
  );
  const activeLogsQuery = readLimit.mode === "all" ? allLogsQuery : stackLogsQuery;

  const refresh = useCallback(() => {
    statusQuery.refresh();
    associatedStackQuery.refresh();
    stackLogsQuery.refresh();
    allLogsQuery.refresh();
  }, [allLogsQuery, associatedStackQuery, stackLogsQuery, statusQuery]);

  useEffect(() => {
    if (!autoRefresh || tailSelection === "all") return;
    const intervalId = window.setInterval(() => {
      associatedStackQuery.refresh();
      stackLogsQuery.refresh();
    }, 5_000);
    return () => window.clearInterval(intervalId);
  }, [associatedStackQuery, autoRefresh, stackLogsQuery, tailSelection]);

  useEffect(() => {
    if (tailSelection === "all" && autoRefresh) {
      setAutoRefresh(false);
    }
  }, [autoRefresh, tailSelection]);

  useEffect(() => {
    if (search.trim().length === 0 || collapsedServiceKeys.size === 0) return;
    setCollapsedServiceKeys(new Set());
  }, [collapsedServiceKeys.size, search]);

  const toggleServiceGroup = useCallback((serviceKey: string) => {
    setCollapsedServiceKeys((current) => {
      const next = new Set(current);
      if (next.has(serviceKey)) {
        next.delete(serviceKey);
      } else {
        next.add(serviceKey);
      }
      return next;
    });
  }, []);

  const result = useMemo(() => {
    if (associatedStack === null) return null;

    if (readLimit.mode === "tail") {
      if (stackLogsQuery.data === null) return null;
      return buildAssociatedStackPodLogsResult({
        stack: associatedStack,
        result: stackLogsQuery.data,
        limit: readLimit,
      });
    }

    if (allLogsQuery.data === null) return null;
    const normalizedWorktreePath = normalizeStackWorktreePath(associatedStack.worktreePath);
    return {
      ...allLogsQuery.data,
      stacks: allLogsQuery.data.stacks.filter((stack) => {
        if (stack.stackId === associatedStack.id) return true;
        if (stack.namespace === associatedStack.namespace) return true;
        return (
          typeof stack.worktreePath === "string" &&
          normalizeStackWorktreePath(stack.worktreePath) === normalizedWorktreePath
        );
      }),
    };
  }, [allLogsQuery.data, associatedStack, readLimit, stackLogsQuery.data]);
  const stackViews = useMemo(
    () => buildStackPodLogViews(result?.stacks ?? [], { search, hideEmpty }),
    [hideEmpty, result?.stacks, search],
  );
  const stackFailureCount = (result?.stacks ?? []).filter((stack) => stack.error !== null).length;
  const partialFailureCount = (result?.stacks ?? []).reduce(
    (total, stack) => total + stack.entries.filter((entry) => entry.error !== null).length,
    0,
  );
  const clipboardText = useMemo(
    () => (result === null ? "" : formatAllStackPodLogsForClipboard({ result })),
    [result],
  );

  if (statusQuery.isPending && statusQuery.data === null) {
    return (
      <PanelState
        icon="loading"
        title="Loading App Stack"
        description="Checking App Stack availability."
      />
    );
  }
  if (statusQuery.error) {
    return (
      <PanelState icon="warning" title="App Stack unavailable" description={statusQuery.error} />
    );
  }
  if (statusQuery.data?.enabled === false) {
    return (
      <PanelState
        icon="warning"
        title="App Stack disabled"
        description="The backend App Stack controller is not configured for this environment."
      />
    );
  }
  if (associatedWorktreePath === null) {
    return (
      <PanelState
        title="No thread worktree"
        description="This thread is not associated with a worktree that can be resolved to an App Dev Stack."
      />
    );
  }
  if (associatedStackQuery.isPending && associatedStackQuery.data === null) {
    return (
      <PanelState
        icon="loading"
        title="Loading App Stack"
        description="Resolving the App Dev Stack for this thread worktree."
      />
    );
  }
  if (associatedStackQuery.error) {
    return (
      <PanelState
        icon="warning"
        title="Failed to resolve App Stack"
        description={associatedStackQuery.error}
      />
    );
  }
  if (associatedStack === null) {
    return (
      <PanelState
        title="No App Stack"
        description={`No App Dev Stack is associated with ${associatedWorktreePath}.`}
      />
    );
  }
  if (activeLogsQuery.isPending && result === null) {
    return (
      <PanelState
        icon="loading"
        title="Loading pod logs"
        description="Fetching pods and recent container logs."
      />
    );
  }
  if (activeLogsQuery.error) {
    return (
      <PanelState
        icon="warning"
        title="Failed to load pod logs"
        description={activeLogsQuery.error}
      />
    );
  }

  const visiblePodCount = stackViews.reduce((total, stack) => total + stack.podCount, 0);
  const visibleContainerCount = stackViews.reduce(
    (total, stack) => total + stack.containerCount,
    0,
  );
  const totalStackCount = result?.stacks.length ?? 0;

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-background">
      <div className="surface-subheader flex min-w-0 flex-col gap-3 px-4 py-3 !h-auto !min-h-0 !items-stretch">
        <div className="flex min-w-0 items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-2">
            <ScrollTextIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">App Stack Logs</div>
              <div className="mt-0.5 flex min-w-0 flex-wrap gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
                <span>
                  {totalStackCount === 1 ? "1 stack" : `${String(totalStackCount)} stacks`}
                </span>
                <span>{String(visiblePodCount)} pods</span>
                <span>{String(visibleContainerCount)} containers</span>
                {result ? <span>{stackLogReadLimitLabel(result.limit)}</span> : null}
                {result ? (
                  <span>fetched {formatFetchedAt(result.fetchedAt, props.timestampFormat)}</span>
                ) : null}
              </div>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              size="icon-xs"
              variant="ghost"
              onClick={refresh}
              disabled={
                statusQuery.isPending || associatedStackQuery.isPending || activeLogsQuery.isPending
              }
              aria-label="Refresh App Stack pod logs"
            >
              <RefreshCwIcon
                className={cn(
                  "size-3.5",
                  (statusQuery.isPending ||
                    associatedStackQuery.isPending ||
                    activeLogsQuery.isPending) &&
                    "animate-spin",
                )}
              />
            </Button>
            <Button
              size="icon-xs"
              variant="ghost"
              onClick={() => copyToClipboard(clipboardText)}
              disabled={clipboardText.length === 0 || (result?.stacks.length ?? 0) === 0}
              aria-label="Copy all App Stack pod logs"
            >
              {isCopied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
            </Button>
          </div>
        </div>

        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <div className="flex h-7 shrink-0 items-center gap-2 rounded-md text-xs text-muted-foreground">
            <span>Tail</span>
            <Select
              value={String(tailSelection)}
              onValueChange={(value) => {
                if (value === "all") {
                  setTailSelection("all");
                  setAutoRefresh(false);
                  return;
                }
                const parsed = Number(value) as StackLogTailSelection;
                if (TAIL_LINE_OPTIONS.includes(parsed)) {
                  setTailSelection(parsed);
                }
              }}
            >
              <SelectTrigger size="xs" className="w-32 min-w-0" aria-label="Log tail line count">
                <SelectValue>{stackLogTailSelectionLabel(tailSelection)}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="start" alignItemWithTrigger={false}>
                {TAIL_LINE_OPTIONS.map((value) => (
                  <SelectItem key={value} hideIndicator value={String(value)}>
                    {stackLogTailSelectionLabel(value)}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
          <div className="relative min-w-48 flex-1">
            <SearchIcon className="pointer-events-none absolute left-2 top-1/2 z-10 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              size="sm"
              type="search"
              value={search}
              onChange={(event) => setSearch(event.currentTarget.value)}
              placeholder="Search logs"
              className="[&_[data-slot=input]]:pl-7"
              aria-label="Search pod logs"
            />
          </div>
          <label className="flex h-7 shrink-0 cursor-pointer items-center gap-2 rounded-md px-1 text-xs text-muted-foreground">
            <Checkbox
              checked={hideEmpty}
              onCheckedChange={(checked) => setHideEmpty(Boolean(checked))}
              aria-label="Hide empty log containers"
            />
            <span>Hide empty</span>
          </label>
          <label className="flex h-7 shrink-0 cursor-pointer items-center gap-2 rounded-md px-1 text-xs text-muted-foreground">
            <Switch
              checked={autoRefresh}
              onCheckedChange={(checked) => setAutoRefresh(Boolean(checked))}
              disabled={tailSelection === "all"}
              className="[--thumb-size:--spacing(3.5)]"
              aria-label="Auto-refresh pod logs"
            />
            <span>Auto-refresh</span>
          </label>
        </div>
      </div>

      {stackFailureCount > 0 || partialFailureCount > 0 ? (
        <div className="border-b border-border/60 bg-destructive/5 px-4 py-2 text-xs text-destructive">
          {[
            stackFailureCount === 1
              ? "1 stack failed to load"
              : stackFailureCount > 1
                ? `${String(stackFailureCount)} stacks failed to load`
                : null,
            partialFailureCount === 1
              ? "1 container failed to return logs"
              : partialFailureCount > 1
                ? `${String(partialFailureCount)} containers failed to return logs`
                : null,
          ]
            .filter((value): value is string => value !== null)
            .join("; ")}
          .
        </div>
      ) : null}

      {totalStackCount === 0 ? (
        <PanelState
          title="No App Stack logs"
          description="No pod log result was returned for the App Dev Stack associated with this worktree."
        />
      ) : visiblePodCount === 0 && stackFailureCount === 0 ? (
        <PanelState
          title="No pods"
          description="Kubernetes did not report any pods for these stacks."
        />
      ) : stackViews.length === 0 ? (
        <PanelState
          title="No matching logs"
          description="No stacks or containers match the current filters."
        />
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-3 p-4">
            {stackViews.map((stackView) => (
              <section
                key={`${stackView.stack.namespace}\u0000${stackView.stack.stackId}`}
                className="space-y-3"
              >
                <div className="rounded-md border border-border/70 bg-muted/20 px-3 py-2">
                  <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="min-w-0 truncate text-xs font-semibold text-foreground">
                      {stackView.stackName}
                    </span>
                    <span className="truncate text-[11px] text-muted-foreground">
                      namespace {stackView.stack.namespace}
                    </span>
                    {stackView.stack.managedBy ? (
                      <span className="truncate text-[11px] text-muted-foreground">
                        managed by {stackView.stack.managedBy}
                      </span>
                    ) : null}
                    <span className="text-[11px] text-muted-foreground">
                      {podCountLabel(stackView.podCount)}
                    </span>
                    <span className="text-[11px] text-muted-foreground">
                      {containerCountLabel(stackView.containerCount)}
                    </span>
                    <span className="text-[11px] text-muted-foreground">
                      fetched {formatFetchedAt(stackView.stack.fetchedAt, props.timestampFormat)}
                    </span>
                  </div>
                  {stackView.stack.error ? (
                    <div className="mt-2 flex items-start gap-2 rounded-md border border-destructive/25 bg-destructive/5 px-2 py-1.5 text-xs text-destructive">
                      <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
                      <span className="min-w-0 break-words">{stackView.stack.error}</span>
                    </div>
                  ) : null}
                </div>

                {stackView.filteredEntries.length === 0 ? (
                  <div className="px-2 text-xs text-muted-foreground">
                    No containers match the current filters for this stack.
                  </div>
                ) : (
                  stackView.serviceGroups.map((group) => {
                    const groupKey = `${stackView.stack.namespace}\u0000${group.serviceKey}`;
                    const isCollapsed = collapsedServiceKeys.has(groupKey);
                    return (
                      <section key={group.serviceKey} className="space-y-2">
                        <button
                          type="button"
                          className="flex min-h-9 w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring"
                          aria-expanded={!isCollapsed}
                          onClick={() => toggleServiceGroup(groupKey)}
                        >
                          {isCollapsed ? (
                            <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
                          ) : (
                            <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
                          )}
                          <span className="min-w-0 flex-1 truncate text-xs font-semibold text-foreground">
                            {group.serviceName}
                          </span>
                          <span className="shrink-0 text-[11px] text-muted-foreground">
                            {podCountLabel(group.pods.length)}
                          </span>
                          <span className="shrink-0 text-[11px] text-muted-foreground">
                            {containerCountLabel(group.entryCount)}
                          </span>
                          {group.errorCount > 0 ? (
                            <span className="shrink-0 rounded-full border border-destructive/25 bg-destructive/5 px-1.5 text-[11px] text-destructive">
                              {String(group.errorCount)} errors
                            </span>
                          ) : null}
                        </button>
                        {isCollapsed ? null : (
                          <div className="space-y-3">
                            {group.pods.map((pod) => (
                              <section key={pod.podName} className="space-y-2">
                                <div className="flex min-w-0 items-center gap-2 px-1 text-[11px] text-muted-foreground">
                                  <span className="min-w-0 truncate font-medium">
                                    {pod.podName}
                                  </span>
                                  <span className="shrink-0">
                                    {containerCountLabel(pod.entries.length)}
                                  </span>
                                </div>
                                <div className="space-y-2">
                                  {pod.entries.map((entry) => (
                                    <ContainerLogBlock
                                      key={`${entry.podName}\u0000${entry.containerName}`}
                                      entry={entry}
                                    />
                                  ))}
                                </div>
                              </section>
                            ))}
                          </div>
                        )}
                      </section>
                    );
                  })
                )}
              </section>
            ))}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}
