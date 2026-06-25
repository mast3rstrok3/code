import type { TimestampFormat } from "@t3tools/contracts/settings";
import {
  CheckCircle2Icon,
  CircleDashedIcon,
  CircleIcon,
  ScrollTextIcon,
  TriangleAlertIcon,
} from "lucide-react";

import {
  type WorkLogEntry,
  workEntryIndicatesToolFailure,
  workEntryIndicatesToolNeutralStatus,
  workEntryIndicatesToolSuccess,
} from "../session-logic";
import { formatShortTimestamp } from "../timestampFormat";
import { cn } from "../lib/utils";

import { Badge } from "./ui/badge";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "./ui/empty";
import { ScrollArea } from "./ui/scroll-area";

interface WorkflowLogsPanelProps {
  readonly entries: ReadonlyArray<WorkLogEntry>;
  readonly timestampFormat: TimestampFormat;
}

function logToneClassName(entry: WorkLogEntry): string {
  if (workEntryIndicatesToolFailure(entry)) {
    return "border-destructive/40 bg-destructive/6 text-destructive";
  }
  if (workEntryIndicatesToolSuccess(entry)) {
    return "border-success/35 bg-success/8 text-success-foreground";
  }
  if (entry.tone === "thinking" || entry.toolLifecycleStatus === "inProgress") {
    return "border-primary/30 bg-primary/8 text-primary";
  }
  return "border-border/70 bg-muted/25 text-muted-foreground";
}

function LogStatusIcon({ entry }: { readonly entry: WorkLogEntry }) {
  if (workEntryIndicatesToolFailure(entry)) {
    return <TriangleAlertIcon className="size-3.5" />;
  }
  if (workEntryIndicatesToolSuccess(entry)) {
    return <CheckCircle2Icon className="size-3.5" />;
  }
  if (entry.tone === "thinking" || entry.toolLifecycleStatus === "inProgress") {
    return <CircleDashedIcon className="size-3.5" />;
  }
  return <CircleIcon className="size-3.5" />;
}

function LogEntryRow({
  entry,
  timestampFormat,
}: {
  readonly entry: WorkLogEntry;
  readonly timestampFormat: TimestampFormat;
}) {
  const detail = entry.detail?.trim();
  const command = entry.command?.trim();
  const changedFiles = entry.changedFiles ?? [];

  return (
    <li className="grid grid-cols-[auto_minmax(0,1fr)] gap-3 border-b border-border/45 px-4 py-3 last:border-b-0">
      <span
        className={cn(
          "mt-0.5 flex size-7 items-center justify-center rounded-md border",
          logToneClassName(entry),
        )}
      >
        <LogStatusIcon entry={entry} />
      </span>
      <div className="min-w-0 space-y-2">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="min-w-0 truncate text-sm font-medium text-foreground/90">
            {entry.toolTitle ?? entry.label}
          </span>
          <span className="shrink-0 text-[11px] text-muted-foreground/60 tabular-nums">
            {formatShortTimestamp(entry.createdAt, timestampFormat)}
          </span>
          {entry.toolLifecycleStatus ? (
            <Badge variant="outline" className="h-5 rounded-md px-1.5 py-0 text-[10px]">
              {entry.toolLifecycleStatus}
            </Badge>
          ) : null}
          {entry.requestKind ? (
            <Badge variant="secondary" className="h-5 rounded-md px-1.5 py-0 text-[10px]">
              {entry.requestKind}
            </Badge>
          ) : null}
        </div>
        {detail ? (
          <p className="line-clamp-4 whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground/80">
            {detail}
          </p>
        ) : null}
        {command ? (
          <pre className="max-h-28 overflow-auto rounded-md border border-border/55 bg-background/70 px-2.5 py-2 font-mono text-[11px] leading-relaxed text-foreground/80">
            {command}
          </pre>
        ) : null}
        {changedFiles.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {changedFiles.slice(0, 8).map((file) => (
              <Badge key={file} variant="secondary" className="rounded-md px-1.5 py-0 text-[10px]">
                {file}
              </Badge>
            ))}
            {changedFiles.length > 8 ? (
              <Badge variant="secondary" className="rounded-md px-1.5 py-0 text-[10px]">
                +{changedFiles.length - 8}
              </Badge>
            ) : null}
          </div>
        ) : null}
      </div>
    </li>
  );
}

export function WorkflowLogsPanel({ entries, timestampFormat }: WorkflowLogsPanelProps) {
  const visibleEntries = entries.filter((entry) => !workEntryIndicatesToolNeutralStatus(entry));

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-background">
      <div className="surface-subheader flex items-center gap-2">
        <ScrollTextIcon className="size-4 text-muted-foreground" />
        <div className="min-w-0">
          <div className="text-sm font-medium">Logs</div>
          <div className="text-[11px] text-muted-foreground">
            {visibleEntries.length === 1
              ? "1 activity"
              : `${visibleEntries.length.toString()} activities`}
          </div>
        </div>
      </div>
      {visibleEntries.length === 0 ? (
        <Empty>
          <EmptyMedia variant="icon">
            <ScrollTextIcon />
          </EmptyMedia>
          <EmptyHeader>
            <EmptyTitle className="text-base">No workflow logs yet</EmptyTitle>
            <EmptyDescription>
              Thread activity and workflow tool logs will appear here as the agent works.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <ol className="divide-y-0">
            {visibleEntries.map((entry) => (
              <LogEntryRow key={entry.id} entry={entry} timestampFormat={timestampFormat} />
            ))}
          </ol>
        </ScrollArea>
      )}
    </div>
  );
}
