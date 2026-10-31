import {
  WORKFLOW_STEP_STATUS_LABELS,
  threadStatusAsStepStatus,
} from "@t3tools/client-runtime/workflow-panel";
import type {
  WorkflowStepStatus,
  WorkflowThreadStatus,
} from "@t3tools/client-runtime/workflow-model";

/**
 * The web panel's six hues: sky is moving, amber wants the user, red stopped
 * badly, violet was stopped on purpose, emerald finished, muted has not
 * started. Labels use the theme's own text tokens so both appearances read.
 */
const STEP_STYLE: Record<
  WorkflowStepStatus,
  { readonly dotClassName: string; readonly textClassName: string }
> = {
  running: { dotClassName: "bg-sky-500", textClassName: "text-foreground" },
  awaiting: { dotClassName: "bg-amber-500", textClassName: "text-warning-foreground" },
  blocked: { dotClassName: "bg-red-500", textClassName: "text-danger-foreground" },
  failed: { dotClassName: "bg-red-500", textClassName: "text-danger-foreground" },
  paused: { dotClassName: "bg-violet-500", textClassName: "text-foreground-muted" },
  stopped: { dotClassName: "bg-neutral-400", textClassName: "text-foreground-muted" },
  queued: {
    dotClassName: "border border-neutral-400 bg-neutral-400/20",
    textClassName: "text-foreground-muted",
  },
  skipped: {
    dotClassName: "border border-dashed border-neutral-400",
    textClassName: "text-foreground-muted",
  },
  pending: { dotClassName: "border border-neutral-400", textClassName: "text-foreground-muted" },
  done: { dotClassName: "bg-emerald-500", textClassName: "text-foreground-muted" },
};

export function workflowStepStyle(status: WorkflowStepStatus) {
  return { ...STEP_STYLE[status], label: WORKFLOW_STEP_STATUS_LABELS[status] };
}

export function workflowThreadStyle(status: WorkflowThreadStatus) {
  return STEP_STYLE[threadStatusAsStepStatus(status)];
}
