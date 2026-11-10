import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import {
  AppReviewId,
  AppReviewRecord,
  DispatchResult,
  IsoDateTime,
  OrchestrationDispatchCommandError,
  OrchestrationGetSnapshotError,
  OrchestrationImplementationAutomationHalt,
  OrchestrationImplementationRerunTarget,
  OrchestrationImplementationRetryableFailure,
  OrchestrationImplementationRunId,
  OrchestrationImplementationRunStatus,
  OrchestrationImplementationSkipTarget,
  OrchestrationImplementationTicketStateStatus,
  OrchestrationPlanningSpec,
  OrchestrationPlanningTicket,
  OrchestrationPlanningTicketId,
  PreviewAutomationUnavailableError,
  McpCapabilityUnavailableError,
  ThreadId,
  ThreadWorkflowContext,
  WorkflowArtifactAccessError,
  WorkflowDocContract,
} from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";

const dependencies = [
  ThreadManagementService.ThreadManagementService,
  McpInvocationContext.McpInvocationContext,
  ProjectionSnapshotQuery,
];
const failure = Schema.Union([
  OrchestratorMcpFailure,
  WorkflowArtifactAccessError,
  OrchestrationGetSnapshotError,
  OrchestrationDispatchCommandError,
  PreviewAutomationUnavailableError,
  McpCapabilityUnavailableError,
]);
const readonlyTool = <T extends Tool.Any>(tool: T): T =>
  tool
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, false) as T;

export const WorkflowContextGetTool = readonlyTool(
  Tool.make("workflow_context_get", {
    description: "Get the calling thread's workflow ID, root thread, and authorized ticket scope.",
    parameters: Tool.EmptyParams,
    success: ThreadWorkflowContext,
    failure,
    dependencies,
  }).annotate(Tool.Title, "Get workflow context"),
);

// MCP structuredContent requires an object, including for absent artifacts and empty lists.
export const WorkflowSpecGetTool = readonlyTool(
  Tool.make("workflow_spec_get", {
    description: "Get the canonical Spec for the calling thread's workflow.",
    parameters: Tool.EmptyParams,
    success: Schema.Struct({ spec: Schema.NullOr(OrchestrationPlanningSpec) }),
    failure,
    dependencies,
  }).annotate(Tool.Title, "Get workflow Spec"),
);

export const WorkflowWayfinderMapGetTool = readonlyTool(
  Tool.make("workflow_wayfinder_map_get", {
    description: "Get the canonical Wayfinder Map for the calling thread's workflow.",
    parameters: Tool.EmptyParams,
    success: Schema.Struct({ wayfinderMap: Schema.NullOr(OrchestrationPlanningSpec) }),
    failure,
    dependencies,
  }).annotate(Tool.Title, "Get workflow Wayfinder Map"),
);

export const WorkflowTicketsListTool = readonlyTool(
  Tool.make("workflow_tickets_list", {
    description: "List canonical planning tickets visible to the calling workflow thread.",
    parameters: Tool.EmptyParams,
    success: Schema.Struct({ tickets: Schema.Array(OrchestrationPlanningTicket) }),
    failure,
    dependencies,
  }).annotate(Tool.Title, "List workflow tickets"),
);

const WorkflowTicketGetTool = readonlyTool(
  Tool.make("workflow_ticket_get", {
    description:
      "Get one canonical planning ticket by ID after workflow and project authorization.",
    parameters: Schema.Struct({ ticketId: OrchestrationPlanningTicketId }),
    success: OrchestrationPlanningTicket,
    failure,
    dependencies,
  }).annotate(Tool.Title, "Get workflow ticket"),
);

export const WorkflowAppReviewsListTool = readonlyTool(
  Tool.make("workflow_app_reviews_list", {
    description: "List App Reviews linked to tickets in the calling thread's workflow.",
    parameters: Tool.EmptyParams,
    success: Schema.Struct({ appReviews: Schema.Array(AppReviewRecord) }),
    failure,
    dependencies,
  }).annotate(Tool.Title, "List workflow App Reviews"),
);

const WorkflowAppReviewGetTool = readonlyTool(
  Tool.make("workflow_app_review_get", {
    description: "Get one App Review after workflow and project authorization.",
    parameters: Schema.Struct({ reviewId: AppReviewId }),
    success: AppReviewRecord,
    failure,
    dependencies,
  }).annotate(Tool.Title, "Get workflow App Review"),
);

const WorkflowDocGetTool = readonlyTool(
  Tool.make("workflow_doc_get", {
    description: "Load one built-in supporting document for a workflow skill by document ID.",
    parameters: Schema.Struct({ docId: Schema.String }),
    success: WorkflowDocContract,
    failure,
    dependencies,
  }).annotate(Tool.Title, "Get workflow document"),
);

const WorkflowTicketProgress = Schema.Struct({
  ticketId: OrchestrationPlanningTicketId,
  key: Schema.NullOr(Schema.String),
  title: Schema.NullOr(Schema.String),
  status: OrchestrationImplementationTicketStateStatus,
  dependencyTicketIds: Schema.Array(OrchestrationPlanningTicketId),
  workerThreadId: Schema.NullOr(ThreadId),
  codeReviewThreadId: Schema.NullOr(ThreadId),
  updatedAt: IsoDateTime,
});

export const WorkflowRunProgress = Schema.Struct({
  runId: OrchestrationImplementationRunId,
  status: OrchestrationImplementationRunStatus,
  automationHalt: Schema.NullOr(OrchestrationImplementationAutomationHalt),
  retryableFailure: Schema.NullOr(OrchestrationImplementationRetryableFailure),
  skips: Schema.Array(OrchestrationImplementationSkipTarget),
  orchestratorThreadId: ThreadId,
  tickets: Schema.Array(WorkflowTicketProgress),
  updatedAt: IsoDateTime,
});

export const WorkflowStatusGetTool = readonlyTool(
  Tool.make("workflow_status_get", {
    description:
      "Get the progress of the calling workflow's implementation runs: run status, the `automationHalt` that stopped automation (one halt pauses every ticket of the run until it clears), and each ticket's stage and last change.",
    parameters: Tool.EmptyParams,
    success: Schema.Struct({ runs: Schema.Array(WorkflowRunProgress) }),
    failure,
    dependencies,
  }).annotate(Tool.Title, "Get workflow status"),
);

const WorkflowStageRestartTool = Tool.make("workflow_stage_restart", {
  description: [
    "Workflow root thread only. Start one stage of an implementation run again, as the Workflows panel's Rerun and Reset do. Read `workflow_status_get` first and target what `automationHalt` names.",
    "`rerun` starts the stage now in a fresh thread and clears a matching halt. `reset` clears it without starting it; use it for a ticket whose dependency has not succeeded yet, so the run starts it in turn.",
    "Rerun fits `retry-exhausted`, and `review-blocked` or `structural-invariant` once the cause is gone. Do not rerun when the detail names a provider login, usage limit, missing App Stack, CI billing, or uncommitted work that is not yours to commit, and do not rerun the same target twice for the same detail: tell the user instead.",
    "A `rejected` outcome with `live-stage-owner` means the stage is still working.",
  ].join(" "),
  parameters: Schema.Struct({
    runId: OrchestrationImplementationRunId,
    target: OrchestrationImplementationRerunTarget,
    mode: Schema.Literals(["rerun", "reset"]),
  }),
  success: DispatchResult,
  failure,
  dependencies: [...dependencies, OrchestrationEngineService, SecureRandom.SecureRandom],
})
  .annotate(Tool.Title, "Restart workflow stage")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const WorkflowArtifactsToolkit = Toolkit.make(
  WorkflowContextGetTool,
  WorkflowSpecGetTool,
  WorkflowWayfinderMapGetTool,
  WorkflowTicketsListTool,
  WorkflowTicketGetTool,
  WorkflowAppReviewsListTool,
  WorkflowAppReviewGetTool,
  WorkflowDocGetTool,
  WorkflowStatusGetTool,
  WorkflowStageRestartTool,
);
