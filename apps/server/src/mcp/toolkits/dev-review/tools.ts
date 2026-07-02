import {
  DevReviewDocument,
  DevReviewError,
  DevReviewId,
  DevReviewRecord,
  DevReviewRecordingEvidence,
  DevReviewStatus,
  IsoDateTime,
  OrchestrationDispatchCommandError,
  OrchestrationGetSnapshotError,
  PreviewAutomationError,
  PreviewTabId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import * as ServerConfig from "../../../config.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";

const OptionalReviewIdField = {
  reviewId: Schema.optional(DevReviewId).annotate({
    description:
      "Optional Dev Review record ID. Omit to use the record linked to the current review thread.",
  }),
};

const OptionalTabIdField = {
  tabId: Schema.optional(PreviewTabId).annotate({
    description:
      "Optional collaborative browser tab to target. Omit to use the current preview tab.",
  }),
};

export const DevReviewLookupInput = Schema.Struct(OptionalReviewIdField);

export const DevReviewUpdateInput = Schema.Struct({
  ...OptionalReviewIdField,
  status: Schema.optional(DevReviewStatus).annotate({
    description: "Updated workflow status for the Dev Review.",
  }),
  document: Schema.optional(DevReviewDocument).annotate({
    description:
      "Full serialized Dev Review document with verdict, summary, checks, findings, questions, and next steps.",
  }),
});

export const DevReviewRecordingStartInput = Schema.Struct({
  ...OptionalReviewIdField,
  ...OptionalTabIdField,
});

export const DevReviewRecordingStopInput = Schema.Struct({
  ...OptionalReviewIdField,
  ...OptionalTabIdField,
});

export const DevReviewCaptureScreenshotInput = Schema.Struct({
  ...OptionalReviewIdField,
  ...OptionalTabIdField,
  caption: TrimmedNonEmptyString.annotate({
    description:
      "Short caption describing the application state this screenshot captures, for example 'Task list after creating the first task'.",
  }),
});

export const DevReviewScreenshotResult = Schema.Struct({
  id: TrimmedNonEmptyString,
  caption: Schema.String,
  capturedAt: IsoDateTime,
});

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  OrchestrationEngineService,
  ProjectionSnapshotQuery,
];

const browserDependencies = [
  ...dependencies,
  PreviewAutomationBroker.PreviewAutomationBroker,
  ServerConfig.ServerConfig,
  FileSystem.FileSystem,
  Path.Path,
];

const DevReviewToolFailure = Schema.Union([
  DevReviewError,
  OrchestrationDispatchCommandError,
  OrchestrationGetSnapshotError,
]);

const DevReviewBrowserToolFailure = Schema.Union([
  DevReviewError,
  OrchestrationDispatchCommandError,
  OrchestrationGetSnapshotError,
  PreviewAutomationError,
]);

const devReviewTool = <T extends Tool.Any>(tool: T): T =>
  tool.annotate(Tool.OpenWorld, true).annotate(Tool.Destructive, true) as T;

export const DevReviewGetTool = Tool.make("dev_review_get", {
  description:
    "Load the durable Dev Review record linked to this workflow thread, including status, document, and captured evidence (recording + screenshots).",
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
      "Persist the Dev Review document and/or final status. Send the complete document each time, not a partial patch. A terminal status (passed/failed) requires a saved screen recording and at least one captured screenshot.",
    parameters: DevReviewUpdateInput,
    success: DevReviewRecord,
    failure: DevReviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Update Dev Review record"),
);

export const DevReviewRecordingStartTool = devReviewTool(
  Tool.make("dev_review_recording_start", {
    description:
      "Start the browser screen recording for this Dev Review. Call after preview_open and before exercising the feature. Returns the updated recording evidence.",
    parameters: DevReviewRecordingStartInput,
    success: DevReviewRecordingEvidence,
    failure: DevReviewBrowserToolFailure,
    dependencies: browserDependencies,
  }).annotate(Tool.Title, "Start Dev Review recording"),
);

export const DevReviewRecordingStopTool = devReviewTool(
  Tool.make("dev_review_recording_stop", {
    description:
      "Stop the browser screen recording and attach the saved video to this Dev Review's evidence. Returns the updated recording evidence; status 'failed' means no video was saved.",
    parameters: DevReviewRecordingStopInput,
    success: DevReviewRecordingEvidence,
    failure: DevReviewBrowserToolFailure,
    dependencies: browserDependencies,
  }).annotate(Tool.Title, "Stop Dev Review recording"),
);

export const DevReviewCaptureScreenshotTool = devReviewTool(
  Tool.make("dev_review_capture_screenshot", {
    description:
      "Capture a captioned screenshot of the current preview tab and attach it to this Dev Review's evidence. Use at each meaningful application state; findings can reference the returned id in evidenceIds.",
    parameters: DevReviewCaptureScreenshotInput,
    success: DevReviewScreenshotResult,
    failure: DevReviewBrowserToolFailure,
    dependencies: browserDependencies,
  }).annotate(Tool.Title, "Capture Dev Review screenshot"),
);

export const DevReviewToolkit = Toolkit.make(
  DevReviewGetTool,
  DevReviewUpdateTool,
  DevReviewRecordingStartTool,
  DevReviewRecordingStopTool,
  DevReviewCaptureScreenshotTool,
);
