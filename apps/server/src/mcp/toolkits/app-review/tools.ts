import {
  AppReviewDocument,
  AppReviewError,
  AppReviewId,
  AppReviewRecord,
  AppReviewRecordingEvidence,
  AppReviewScope,
  AppReviewStatus,
  AppReviewTestResult,
  IsoDateTime,
  OrchestratorMcpFailure,
  PreviewAutomationError,
  PreviewTabId,
  ReviewTestPlatforms,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as AppReviewStore from "../../../appReview/AppReviewStore.ts";
import * as AppReviewTests from "../../../appReview/AppReviewTests.ts";
import * as ServerConfig from "../../../config.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import * as PreviewRecordingPolicy from "../../../preview/PreviewRecordingPolicy.ts";

const OptionalTabIdField = {
  tabId: Schema.optional(PreviewTabId).annotate({
    description: "Preview tab to target. Omit for the current tab.",
  }),
};

const AppReviewStartInput = Schema.Struct({
  scope: Schema.optional(AppReviewScope).annotate({
    description:
      "What this review verifies: 'e2e' (test commands), 'browser' (the app in the preview browser), or 'both' (default).",
  }),
  brief: Schema.optional(Schema.String).annotate({
    description: "One or two sentences on what is under review, shown at the top of the review.",
  }),
});

const AppReviewLookupInput = Schema.Struct({
  reviewId: Schema.optional(AppReviewId).annotate({
    description: "A review on this thread. Omit for the active review.",
  }),
});

const AppReviewUpdateInput = Schema.Struct({
  status: Schema.optional(AppReviewStatus).annotate({
    description:
      "Final status: 'passed' or 'failed'. Leave it out while the review is in progress.",
  }),
  document: Schema.optional(AppReviewDocument).annotate({
    description:
      "The complete review document: verdict, summary, checks, findings, questions and next steps. Send it whole each time.",
  }),
});

const AppReviewRunTestInput = Schema.Struct({
  command: TrimmedNonEmptyString.annotate({
    description:
      "Shell command run from the thread's worktree, usually one of t3.json's e2eCommands or e2eAffectedCommands.",
  }),
  previewUrl: Schema.optional(TrimmedNonEmptyString).annotate({
    description:
      "URL under test, passed as APP_REVIEW_PREVIEW_URL. Omit to use the worktree's App Stack frontend.",
  }),
  baseRef: Schema.optional(TrimmedNonEmptyString).annotate({
    description:
      "Commit the change branched from, passed as APP_REVIEW_BASE_REF for e2eAffectedCommands.",
  }),
  testPlatforms: Schema.optional(ReviewTestPlatforms).annotate({
    description:
      "Platforms the suite should test, passed as APP_REVIEW_TEST_PLATFORMS. Default web.",
  }),
});

const AppReviewRecordingInput = Schema.Struct(OptionalTabIdField);

const AppReviewCaptureScreenshotInput = Schema.Struct({
  ...OptionalTabIdField,
  caption: TrimmedNonEmptyString.annotate({
    description: "The application state shown, e.g. 'Task list after creating the first task'.",
  }),
});

const AppReviewScreenshotResult = Schema.Struct({
  id: TrimmedNonEmptyString,
  caption: Schema.String,
  capturedAt: IsoDateTime,
});

const dependencies = [
  ThreadManagementService.ThreadManagementService,
  McpInvocationContext.McpInvocationContext,
  AppReviewStore.AppReviewStore,
];

const browserDependencies = [
  ...dependencies,
  PreviewAutomationBroker.PreviewAutomationBroker,
  PreviewRecordingPolicy.PreviewRecordingPolicy,
  ServerConfig.ServerConfig,
  FileSystem.FileSystem,
  Path.Path,
];

const AppReviewToolFailure = Schema.Union([OrchestratorMcpFailure, AppReviewError]);

const AppReviewBrowserToolFailure = Schema.Union([
  OrchestratorMcpFailure,
  AppReviewError,
  PreviewAutomationError,
]);

const appReviewTool = <T extends Tool.Any>(tool: T): T =>
  tool
    .annotate(Tool.OpenWorld, true)
    .annotate(Tool.Destructive, true)
    .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients) as T;

const AppReviewStartTool = appReviewTool(
  Tool.make("app_review_start", {
    description:
      "Start a new App Review on this thread and make it the active one. Evidence tools start one on first use, so call this to set the scope and brief, or to begin a fresh review after a verdict.",
    parameters: AppReviewStartInput,
    success: AppReviewRecord,
    failure: AppReviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Start App Review"),
);

const AppReviewGetTool = Tool.make("app_review_get", {
  description:
    "Load this thread's App Review: status, document, browser evidence, and E2E test results.",
  parameters: AppReviewLookupInput,
  success: AppReviewRecord,
  failure: AppReviewToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Get App Review")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const AppReviewUpdateTool = appReviewTool(
  Tool.make("app_review_update", {
    description:
      "Save the App Review document and/or its final status. 'passed' needs the evidence its scope covers: a passing latest run of every E2E command, and a saved browser recording plus a screenshot. Mark blocked checks blockerKind 'coverage-gap' when tests can be added in the worktree, or 'external-prerequisite' for missing credentials, services or approvals, and say what would unblock them in notes.",
    parameters: AppReviewUpdateInput,
    success: AppReviewRecord,
    failure: AppReviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Update App Review"),
);

const AppReviewRunTestTool = appReviewTool(
  Tool.make("app_review_run_test", {
    description:
      "Run one E2E test command in this thread's worktree and attach its result to the App Review. Browsers the suite launches are recorded as DOM replays through APP_REVIEW_RECORDER_SCRIPT. Waits for the command (up to 60 minutes) and returns its exit status and output tail.",
    parameters: AppReviewRunTestInput,
    success: AppReviewTestResult,
    failure: AppReviewToolFailure,
    dependencies: [...dependencies, AppReviewTests.AppReviewTests],
  }).annotate(Tool.Title, "Run App Review test"),
);

const AppReviewRecordingStartTool = appReviewTool(
  Tool.make("app_review_recording_start", {
    description:
      "Start recording the preview tab for this App Review. Call after preview_open and before exercising the app.",
    parameters: AppReviewRecordingInput,
    success: AppReviewRecordingEvidence,
    failure: AppReviewBrowserToolFailure,
    dependencies: browserDependencies,
  }).annotate(Tool.Title, "Start App Review recording"),
);

const AppReviewRecordingStopTool = appReviewTool(
  Tool.make("app_review_recording_stop", {
    description:
      "Stop the preview recording and attach it to this App Review. Status 'failed' means nothing was saved.",
    parameters: AppReviewRecordingInput,
    success: AppReviewRecordingEvidence,
    failure: AppReviewBrowserToolFailure,
    dependencies: browserDependencies,
  }).annotate(Tool.Title, "Stop App Review recording"),
);

const AppReviewCaptureScreenshotTool = appReviewTool(
  Tool.make("app_review_capture_screenshot", {
    description:
      "Capture a captioned screenshot of the preview tab for this App Review. Findings reference the returned id in evidenceIds.",
    parameters: AppReviewCaptureScreenshotInput,
    success: AppReviewScreenshotResult,
    failure: AppReviewBrowserToolFailure,
    dependencies: browserDependencies,
  }).annotate(Tool.Title, "Capture App Review screenshot"),
);

export const AppReviewToolkit = Toolkit.make(
  AppReviewStartTool,
  AppReviewGetTool,
  AppReviewUpdateTool,
  AppReviewRunTestTool,
  AppReviewRecordingStartTool,
  AppReviewRecordingStopTool,
  AppReviewCaptureScreenshotTool,
);
