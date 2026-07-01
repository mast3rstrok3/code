import {
  DevReviewDocument,
  DevReviewId,
  DevReviewRecord,
  DevReviewReplayMetadata,
  DevReviewStatus,
  DevReviewReplayError,
  OrchestrationDispatchCommandError,
  OrchestrationGetSnapshotError,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { DevReviewReplayCapture } from "../../../review/DevReviewReplayCapture.ts";

export const DevReviewLookupInput = Schema.Struct({
  reviewId: Schema.optional(DevReviewId).annotate({
    description:
      "Optional Dev Review record ID. Omit to use the record linked to the current review thread.",
  }),
});

export const DevReviewUpdateInput = Schema.Struct({
  reviewId: Schema.optional(DevReviewId).annotate({
    description:
      "Optional Dev Review record ID. Omit to use the record linked to the current review thread.",
  }),
  status: Schema.optional(DevReviewStatus).annotate({
    description: "Updated workflow status for the Dev Review.",
  }),
  document: Schema.optional(DevReviewDocument).annotate({
    description:
      "Full serialized Dev Review document with verdict, summary, checks, findings, questions, and next steps.",
  }),
});

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  DevReviewReplayCapture,
  OrchestrationEngineService,
  ProjectionSnapshotQuery,
];

const DevReviewToolFailure = Schema.Union([
  DevReviewReplayError,
  OrchestrationDispatchCommandError,
  OrchestrationGetSnapshotError,
]);

const devReviewTool = <T extends Tool.Any>(tool: T): T =>
  tool.annotate(Tool.OpenWorld, true).annotate(Tool.Destructive, true) as T;

export const DevReviewGetTool = Tool.make("dev_review_get", {
  description:
    "Load the durable Dev Review record linked to this workflow thread, including status, document, and replay metadata.",
  parameters: DevReviewLookupInput,
  success: DevReviewRecord,
  failure: DevReviewToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Get Dev Review record")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const DevReviewUpdateTool = devReviewTool(
  Tool.make("dev_review_update", {
    description:
      "Persist the Dev Review document and/or final status. Send the complete document each time, not a partial patch.",
    parameters: DevReviewUpdateInput,
    success: DevReviewRecord,
    failure: DevReviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Update Dev Review record"),
);

export const DevReviewReplayStartTool = devReviewTool(
  Tool.make("dev_review_replay_start", {
    description:
      "Prepare Agent Browser RRweb replay capture before opening the target URL. Returns namespace, session, evidenceDir, initScriptPath, and replay metadata.",
    parameters: DevReviewLookupInput,
    success: DevReviewReplayMetadata,
    failure: DevReviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Start Dev Review replay capture"),
);

export const DevReviewReplayStopTool = devReviewTool(
  Tool.make("dev_review_replay_stop", {
    description:
      "Finalize Agent Browser RRweb replay capture and persist compact replay metadata. A zero-event capture returns failed metadata.",
    parameters: DevReviewLookupInput,
    success: DevReviewReplayMetadata,
    failure: DevReviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Stop Dev Review replay capture"),
);

export const DevReviewToolkit = Toolkit.make(
  DevReviewGetTool,
  DevReviewUpdateTool,
  DevReviewReplayStartTool,
  DevReviewReplayStopTool,
);
