import {
  DevReviewId,
  DevReviewRecord,
  OrchestrationGetSnapshotError,
  OrchestrationPlanningSpec,
  OrchestrationPlanningTicket,
  OrchestrationPlanningTicketId,
  PreviewAutomationUnavailableError,
  ThreadWorkflowContext,
  WorkflowArtifactAccessError,
  WorkflowDocContract,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";

const dependencies = [McpInvocationContext.McpInvocationContext, ProjectionSnapshotQuery];
const failure = Schema.Union([
  WorkflowArtifactAccessError,
  OrchestrationGetSnapshotError,
  PreviewAutomationUnavailableError,
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

export const WorkflowSpecGetTool = readonlyTool(
  Tool.make("workflow_spec_get", {
    description: "Get the canonical Spec for the calling thread's workflow.",
    parameters: Tool.EmptyParams,
    success: Schema.NullOr(OrchestrationPlanningSpec),
    failure,
    dependencies,
  }).annotate(Tool.Title, "Get workflow Spec"),
);

export const WorkflowWayfinderMapGetTool = readonlyTool(
  Tool.make("workflow_wayfinder_map_get", {
    description: "Get the canonical Wayfinder Map for the calling thread's workflow.",
    parameters: Tool.EmptyParams,
    success: Schema.NullOr(OrchestrationPlanningSpec),
    failure,
    dependencies,
  }).annotate(Tool.Title, "Get workflow Wayfinder Map"),
);

export const WorkflowTicketsListTool = readonlyTool(
  Tool.make("workflow_tickets_list", {
    description: "List canonical planning tickets visible to the calling workflow thread.",
    parameters: Tool.EmptyParams,
    success: Schema.Array(OrchestrationPlanningTicket),
    failure,
    dependencies,
  }).annotate(Tool.Title, "List workflow tickets"),
);

export const WorkflowTicketGetTool = readonlyTool(
  Tool.make("workflow_ticket_get", {
    description:
      "Get one canonical planning ticket by ID after workflow and project authorization.",
    parameters: Schema.Struct({ ticketId: OrchestrationPlanningTicketId }),
    success: OrchestrationPlanningTicket,
    failure,
    dependencies,
  }).annotate(Tool.Title, "Get workflow ticket"),
);

export const WorkflowDevReviewsListTool = readonlyTool(
  Tool.make("workflow_dev_reviews_list", {
    description: "List Dev Reviews linked to tickets in the calling thread's workflow.",
    parameters: Tool.EmptyParams,
    success: Schema.Array(DevReviewRecord),
    failure,
    dependencies,
  }).annotate(Tool.Title, "List workflow Dev Reviews"),
);

export const WorkflowDevReviewGetTool = readonlyTool(
  Tool.make("workflow_dev_review_get", {
    description: "Get one Dev Review after workflow and project authorization.",
    parameters: Schema.Struct({ reviewId: DevReviewId }),
    success: DevReviewRecord,
    failure,
    dependencies,
  }).annotate(Tool.Title, "Get workflow Dev Review"),
);

export const WorkflowDocGetTool = readonlyTool(
  Tool.make("workflow_doc_get", {
    description: "Load one built-in supporting document for a workflow skill by document ID.",
    parameters: Schema.Struct({ docId: Schema.String }),
    success: WorkflowDocContract,
    failure,
    dependencies,
  }).annotate(Tool.Title, "Get workflow document"),
);

export const WorkflowArtifactsToolkit = Toolkit.make(
  WorkflowContextGetTool,
  WorkflowSpecGetTool,
  WorkflowWayfinderMapGetTool,
  WorkflowTicketsListTool,
  WorkflowTicketGetTool,
  WorkflowDevReviewsListTool,
  WorkflowDevReviewGetTool,
  WorkflowDocGetTool,
);
