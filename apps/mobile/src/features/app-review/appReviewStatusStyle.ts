import type { AppReviewCycleStepStatus } from "@t3tools/client-runtime/app-review";
import type { WorkflowStepStatus } from "@t3tools/client-runtime/workflow-model";
import type { AppReviewRecord, AppReviewWorkflowRun } from "@t3tools/contracts";

import { workflowStepStyle } from "../workflows/workflowStatusStyle";

// App Review states borrow the Workflow sheet's hues, so a review reads the
// same wherever it shows up.
const RUN_STATUS: Record<AppReviewWorkflowRun["status"], WorkflowStepStatus> = {
  running: "running",
  passed: "done",
  exhausted: "awaiting",
  failed: "failed",
};

const STEP_STATUS: Record<AppReviewCycleStepStatus, WorkflowStepStatus> = {
  complete: "done",
  current: "running",
  pending: "pending",
  "not-needed": "skipped",
  failed: "failed",
};

const RECORD_STATUS: Record<AppReviewRecord["status"], WorkflowStepStatus> = {
  pending: "pending",
  running: "running",
  passed: "done",
  failed: "failed",
};

export function appReviewRunStyle(status: AppReviewWorkflowRun["status"]) {
  return workflowStepStyle(RUN_STATUS[status]);
}

export function appReviewStepStyle(status: AppReviewCycleStepStatus) {
  return workflowStepStyle(STEP_STATUS[status]);
}

export function appReviewRecordStyle(status: AppReviewRecord["status"]) {
  return workflowStepStyle(RECORD_STATUS[status]);
}
