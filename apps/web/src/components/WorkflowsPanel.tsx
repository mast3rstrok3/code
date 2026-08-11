import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { WORKFLOW_PRESET_DEFINITION_BY_ID } from "@t3tools/shared/workflowPresets";
import { Archive, ChevronDown, ChevronRight, GitFork } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import {
  resolveWorkflowThreadStatus,
  workflowStatusIsActive,
  workflowThreadKey,
  type WorkflowGroup,
  type WorkflowRoot,
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

function threadStartedAt(thread: EnvironmentThreadShell): string {
  return thread.latestTurn?.startedAt ?? thread.latestTurn?.requestedAt ?? thread.createdAt;
}

function threadEndedAt(
  thread: EnvironmentThreadShell,
  status: WorkflowThreadStatus,
): string | null {
  if (workflowStatusIsActive(status)) return null;
  return (
    thread.archivedAt ??
    thread.latestTurn?.completedAt ??
    thread.settledAt ??
    thread.session?.updatedAt ??
    thread.updatedAt
  );
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

function groupEndedAt(group: WorkflowGroup<EnvironmentThreadShell>): string | null {
  if (group.isActive) return null;
  let latest = group.createdAt;
  for (const row of group.rows) {
    const status = resolveWorkflowThreadStatus(row.thread);
    const endedAt = threadEndedAt(row.thread, status) ?? row.thread.updatedAt;
    if (Date.parse(endedAt) > Date.parse(latest)) latest = endedAt;
  }
  return latest;
}

function ThreadRow(props: {
  readonly row: WorkflowGroup<EnvironmentThreadShell>["rows"][number];
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
  const visualDepth = Math.min(row.depth, 4);

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
          <span aria-hidden>·</span>
          <Elapsed
            startedAt={threadStartedAt(row.thread)}
            endedAt={threadEndedAt(row.thread, status)}
          />
          {status === "archived" ? <Archive className="size-3 shrink-0" aria-hidden /> : null}
        </span>
      </span>
    </button>
  );
}

export function WorkflowsPanel(props: {
  readonly workflow: WorkflowRoot<EnvironmentThreadShell> | null;
  readonly activeThreadKey: string | null;
  readonly onOpenThread: (thread: EnvironmentThreadShell) => void;
}) {
  const groups = props.workflow?.groups ?? [];
  const [expandedById, setExpandedById] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(groups.map((group) => [group.id, group.isActive])),
  );

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

  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="p-3">
        <button
          type="button"
          onClick={() => props.onOpenThread(props.workflow!.root)}
          className="cursor-pointer mb-3 flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent/60"
        >
          <GitFork className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-sm font-medium">
            {props.workflow.root.title}
          </span>
          <span className="text-[11px] text-muted-foreground">Main thread</span>
        </button>

        <div className="space-y-2">
          {groups.map((group) => {
            const expanded = expandedById[group.id] ?? group.isActive;
            const status = groupStatus(group);
            const visual = STATUS_VISUALS[status];
            return (
              <section
                key={group.id}
                className="overflow-hidden rounded-lg border border-border/80 bg-card"
              >
                <button
                  type="button"
                  aria-expanded={expanded}
                  onClick={() =>
                    setExpandedById((current) => ({ ...current, [group.id]: !expanded }))
                  }
                  className="cursor-pointer flex w-full items-start gap-2 p-3 text-left hover:bg-accent/40"
                >
                  {expanded ? (
                    <ChevronDown className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">
                        {groupTitle(group)}
                      </span>
                      <span className={cn("text-[11px]", visual.textClass)}>{visual.label}</span>
                    </span>
                    <span className="mt-1 flex flex-wrap items-center gap-x-1.5 text-[11px] text-muted-foreground">
                      <span>{group.activeCount} active</span>
                      <span aria-hidden>·</span>
                      <span>{group.settledCount} settled</span>
                      <span aria-hidden>·</span>
                      <Elapsed startedAt={group.createdAt} endedAt={groupEndedAt(group)} />
                    </span>
                  </span>
                </button>
                {expanded ? (
                  <div className="border-t border-border/70 p-1">
                    {group.rows.map((row) => (
                      <ThreadRow
                        key={workflowThreadKey(row.thread)}
                        row={row}
                        activeThreadKey={props.activeThreadKey}
                        onOpenThread={props.onOpenThread}
                      />
                    ))}
                  </div>
                ) : null}
              </section>
            );
          })}
        </div>
      </div>
    </ScrollArea>
  );
}
