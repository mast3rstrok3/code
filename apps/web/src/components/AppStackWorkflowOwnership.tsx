import type { AppStack, AppStackListResult } from "@t3tools/contracts";
import { TriangleAlertIcon } from "lucide-react";

import { appStackOwnershipLabel, appStackWorkflowConflictSummary } from "./AppStackPanel.logic";

type WorkflowConflict = NonNullable<AppStackListResult["workflowConflicts"]>[number];

export function AppStackWorkflowOwnershipBadge(props: { readonly stack: AppStack }) {
  const label = appStackOwnershipLabel(props.stack);
  if (label === null) return null;

  return (
    <span className="inline-flex h-5 items-center rounded-full border border-info/25 bg-info/10 px-2 text-2xs font-medium text-info-foreground">
      {label}
    </span>
  );
}

export function AppStackWorkflowConflictWarning(props: {
  readonly conflicts: ReadonlyArray<WorkflowConflict>;
}) {
  if (props.conflicts.length === 0) return null;

  return (
    <div className="flex gap-2 rounded-lg border border-warning/25 bg-warning/5 p-3 text-xs text-warning-foreground">
      <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" />
      <div className="space-y-1">
        <div className="font-medium">Workflow stack ownership conflicts</div>
        {props.conflicts.map((conflict) => (
          <div
            key={`${conflict.workflowId}:${conflict.kind ?? "legacy"}:${conflict.worktreePaths.join(":")}`}
          >
            {appStackWorkflowConflictSummary(conflict)}
          </div>
        ))}
        <div>No stacks were stopped or deleted automatically.</div>
      </div>
    </div>
  );
}
