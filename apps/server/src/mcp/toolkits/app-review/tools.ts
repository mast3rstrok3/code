import {
  AppReviewDocument,
  AppReviewError,
  AppReviewId,
  AppReviewRecord,
  AppReviewRecordingEvidence,
  AppReviewStatus,
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
  reviewId: Schema.optional(AppReviewId).annotate({
    description:
      "Optional App Review record ID. Omit to use the record linked to the current review thread.",
  }),
};

const OptionalTabIdField = {
  tabId: Schema.optional(PreviewTabId).annotate({
    description:
      "Optional collaborative browser tab to target. Omit to use the current preview tab.",
  }),
};

export const AppReviewLookupInput = Schema.Struct(OptionalReviewIdField);

export const AppReviewUpdateInput = Schema.Struct({
  ...OptionalReviewIdField,
  status: Schema.optional(AppReviewStatus).annotate({
    description: "Updated workflow status for the App Review.",
  }),
  document: Schema.optional(AppReviewDocument).annotate({
    description:
      "Full serialized App Review document with verdict, summary, checks, findings, questions, and next steps.",
  }),
});

export const AppReviewRecordingStartInput = Schema.Struct({
  ...OptionalReviewIdField,
  ...OptionalTabIdField,
});

export const AppReviewRecordingStopInput = Schema.Struct({
  ...OptionalReviewIdField,
  ...OptionalTabIdField,
});

export const AppReviewCaptureScreenshotInput = Schema.Struct({
  ...OptionalReviewIdField,
  ...OptionalTabIdField,
  caption: TrimmedNonEmptyString.annotate({
    description:
      "Short caption describing the application state this screenshot captures, for example 'Task list after creating the first task'.",
  }),
});

export const AppReviewScreenshotResult = Schema.Struct({
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

const AppReviewToolFailure = Schema.Union([
  AppReviewError,
  OrchestrationDispatchCommandError,
  OrchestrationGetSnapshotError,
]);

const AppReviewBrowserToolFailure = Schema.Union([
  AppReviewError,
  OrchestrationDispatchCommandError,
  OrchestrationGetSnapshotError,
  PreviewAutomationError,
]);

const appReviewTool = <T extends Tool.Any>(tool: T): T =>
  tool.annotate(Tool.OpenWorld, true).annotate(Tool.Destructive, true) as T;

export const AppReviewGetTool = Tool.make("app_review_get", {
  description:
    "Load the durable App Review record linked to this workflow thread, including status, document, and captured evidence (recording + screenshots).",
  parameters: AppReviewLookupInput,
  success: AppReviewRecord,
  failure: AppReviewToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Get App Review record")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const AppReviewUpdateTool = appReviewTool(
  Tool.make("app_review_update", {
    description:
      "Persist the App Review document and/or final status. Send the complete document each time, not a partial patch. Passed requires a saved recording and screenshot. Failed accepts the same complete evidence, or screenshot-backed findings with failed checks when recording finalization failed. A check this cycle did not exercise, because an earlier cycle of the same run passed it and the repair could not reach it, is repeated with status passed and carriedFromCycle set to the cycle that ran it.",
    parameters: AppReviewUpdateInput,
    success: AppReviewRecord,
    failure: AppReviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Update App Review record"),
);

export const AppReviewRecordingStartTool = appReviewTool(
  Tool.make("app_review_recording_start", {
    description:
      "Start the browser screen recording for this App Review. Call after preview_open and before exercising the feature. Returns the updated recording evidence.",
    parameters: AppReviewRecordingStartInput,
    success: AppReviewRecordingEvidence,
    failure: AppReviewBrowserToolFailure,
    dependencies: browserDependencies,
  }).annotate(Tool.Title, "Start App Review recording"),
);

export const AppReviewRecordingStopTool = appReviewTool(
  Tool.make("app_review_recording_stop", {
    description:
      "Stop the browser screen recording and attach the saved video to this App Review's evidence. Returns the updated recording evidence; status 'failed' means no video was saved.",
    parameters: AppReviewRecordingStopInput,
    success: AppReviewRecordingEvidence,
    failure: AppReviewBrowserToolFailure,
    dependencies: browserDependencies,
  }).annotate(Tool.Title, "Stop App Review recording"),
);

export const AppReviewCaptureScreenshotTool = appReviewTool(
  Tool.make("app_review_capture_screenshot", {
    description:
      "Capture a captioned screenshot of the current preview tab and attach it to this App Review's evidence. Use at each meaningful application state; findings can reference the returned id in evidenceIds.",
    parameters: AppReviewCaptureScreenshotInput,
    success: AppReviewScreenshotResult,
    failure: AppReviewBrowserToolFailure,
    dependencies: browserDependencies,
  }).annotate(Tool.Title, "Capture App Review screenshot"),
);

export const AppReviewToolkit = Toolkit.make(
  AppReviewGetTool,
  AppReviewUpdateTool,
  AppReviewRecordingStartTool,
  AppReviewRecordingStopTool,
  AppReviewCaptureScreenshotTool,
);
