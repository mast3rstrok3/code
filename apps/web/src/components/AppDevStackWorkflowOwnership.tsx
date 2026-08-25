import type { AppDevStack, AppDevStackListResult } from "@t3tools/contracts";
import { TriangleAlertIcon } from "lucide-react";

import {
  appDevStackOwnershipLabel,
  appDevStackWorkflowConflictSummary,
} from "./AppDevStackPanel.logic";

type WorkflowConflict = NonNullable<AppDevStackListResult["workflowConflicts"]>[number];

export function AppDevStackWorkflowOwnershipBadge(props: { readonly stack: AppDevStack }) {
  const label = appDevStackOwnershipLabel(props.stack);
  if (label === null) return null;

  return (
    <span className="inline-flex h-5 items-center rounded-full border border-sky-500/25 bg-sky-500/10 px-2 text-[11px] font-medium text-sky-700 dark:text-sky-400">
      {label}
    </span>
  );
}

export function AppDevStackWorkflowConflictWarning(props: {
  readonly conflicts: ReadonlyArray<WorkflowConflict>;
}) {
  if (props.conflicts.length === 0) return null;

  return (
    <div className="flex gap-2 rounded-lg border border-amber-500/25 bg-amber-500/5 p-3 text-xs text-amber-800 dark:text-amber-400">
      <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" />
      <div className="space-y-1">
        <div className="font-medium">Workflow stack ownership conflicts</div>
        {props.conflicts.map((conflict) => (
          <div
            key={`${conflict.workflowId}:${conflict.kind ?? "legacy"}:${conflict.worktreePaths.join(":")}`}
          >
            {appDevStackWorkflowConflictSummary(conflict)}
          </div>
        ))}
        <div>No stacks were stopped or deleted automatically.</div>
      </div>
    </div>
  );
}
