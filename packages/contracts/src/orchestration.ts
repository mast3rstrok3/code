import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import * as SchemaTransformation from "effect/SchemaTransformation";
import * as Struct from "effect/Struct";
import { ProviderOptionSelections } from "./model.ts";
import { RepositoryIdentity } from "./environment.ts";
import { ChangeRequest } from "./sourceControl.ts";
import {
  DevReviewDocument,
  DevReviewId,
  DevReviewRecord,
  DevReviewReplayMetadata,
} from "./review.ts";
import {
  ApprovalRequestId,
  CheckpointRef,
  CommandId,
  EventId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  ProjectId,
  ProviderItemId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import { DEFAULT_WORKSPACE_USER_ID, WorkspaceUserId, WorkspaceUserView } from "./workspaceUsers.ts";

export const ORCHESTRATION_WS_METHODS = {
  dispatchCommand: "orchestration.dispatchCommand",
  getTurnDiff: "orchestration.getTurnDiff",
  getFullThreadDiff: "orchestration.getFullThreadDiff",
  replayEvents: "orchestration.replayEvents",
  getArchivedShellSnapshot: "orchestration.getArchivedShellSnapshot",
  subscribeShell: "orchestration.subscribeShell",
  subscribeThread: "orchestration.subscribeThread",
} as const;

export const ProviderApprovalPolicy = Schema.Literals([
  "untrusted",
  "on-failure",
  "on-request",
  "never",
]);
export type ProviderApprovalPolicy = typeof ProviderApprovalPolicy.Type;
export const ProviderSandboxMode = Schema.Literals([
  "read-only",
  "workspace-write",
  "danger-full-access",
]);
export type ProviderSandboxMode = typeof ProviderSandboxMode.Type;

/**
 * `ModelSelection` — selection of a model on a configured provider instance.
 *
 * The routing key is `instanceId` (a user-defined slug identifying one
 * configured provider instance). Drivers, credentials, working-directory
 * bindings, and any other per-instance state are recovered from the
 * runtime registry via the instance id.
 *
 * Wire legacy: persisted selections produced before the driver/instance
 * split carried a `provider: <driver-id>` field instead. The schema absorbs
 * that shape via a pre-decoding transform — `{provider, model}` is promoted
 * to `{instanceId: defaultInstanceIdForDriver(provider), model}`. No
 * post-decode compatibility code lives in the runtime; the transform is the
 * only compat surface.
 */
const ModelSelectionWire = Schema.Struct({
  instanceId: ProviderInstanceId,
  model: TrimmedNonEmptyString,
  options: Schema.optionalKey(ProviderOptionSelections),
});

// Source shape for persisted legacy payloads. Fields are typed as
// `Schema.Unknown` so malformed drafts still make it into the transform and
// fail validation through the target schema (with proper error messages)
// rather than at the source-struct layer where the error is less actionable.
const ModelSelectionSource = Schema.Struct({
  provider: Schema.optional(Schema.Unknown),
  instanceId: Schema.optional(Schema.Unknown),
  model: Schema.Unknown,
  options: Schema.optional(Schema.Unknown),
});

export const ModelSelection = ModelSelectionSource.pipe(
  Schema.decodeTo(
    ModelSelectionWire,
    SchemaTransformation.transformOrFail({
      decode: (raw) => {
        // Resolve the routing key: prefer an explicit `instanceId`; fall
        // back to promoting the legacy `provider` slug (the canonical
        // `defaultInstanceIdForDriver` mapping) so persisted rollout-era
        // payloads decode without data loss. The target schema brands the
        // string as `ProviderInstanceId`.
        const instanceIdSource =
          raw.instanceId !== undefined
            ? raw.instanceId
            : typeof raw.provider === "string"
              ? raw.provider
              : undefined;
        const base: Record<string, unknown> = {
          instanceId: instanceIdSource,
          model: raw.model,
        };
        if (raw.options !== undefined) base.options = raw.options;
        return Effect.succeed(base as typeof ModelSelectionWire.Encoded);
      },
      encode: (value) => {
        const base: Record<string, unknown> = {
          model: value.model,
          instanceId: value.instanceId,
        };
        if (value.options !== undefined) base.options = value.options;
        return Effect.succeed(base as typeof ModelSelectionSource.Encoded);
      },
    }),
  ),
);
export type ModelSelection = typeof ModelSelection.Type;

export const RuntimeMode = Schema.Literals([
  "approval-required",
  "auto-accept-edits",
  "full-access",
]);
export type RuntimeMode = typeof RuntimeMode.Type;
export const DEFAULT_RUNTIME_MODE: RuntimeMode = "full-access";
const ProviderInteractionModeWire = Schema.Literals([
  "default",
  "plan",
  "planning-workflow",
  "implementation-workflow",
  "yolo-workflow",
  "product-workflow",
]);
const ProviderInteractionModeCanonical = Schema.Literals([
  "default",
  "plan",
  "planning-workflow",
  "implementation-workflow",
  "product-workflow",
]);
export const ProviderInteractionMode = ProviderInteractionModeWire.pipe(
  Schema.decodeTo(
    ProviderInteractionModeCanonical,
    SchemaTransformation.transformOrFail({
      decode: (mode) =>
        Effect.succeed(mode === "yolo-workflow" ? ("product-workflow" as const) : mode),
      encode: (mode) => Effect.succeed(mode),
    }),
  ),
);
export type ProviderInteractionMode = typeof ProviderInteractionMode.Type;
export const DEFAULT_PROVIDER_INTERACTION_MODE: ProviderInteractionMode = "default";
export const isPlanningWorkflowInteractionMode = (
  mode: ProviderInteractionMode | null | undefined,
): mode is "planning-workflow" | "product-workflow" =>
  mode === "planning-workflow" || mode === "product-workflow";
export const ProviderRequestKind = Schema.Literals(["command", "file-read", "file-change"]);
export type ProviderRequestKind = typeof ProviderRequestKind.Type;
export const AssistantDeliveryMode = Schema.Literals(["buffered", "streaming"]);
export type AssistantDeliveryMode = typeof AssistantDeliveryMode.Type;
export const ProviderApprovalDecision = Schema.Literals([
  "accept",
  "acceptForSession",
  "decline",
  "cancel",
]);
export type ProviderApprovalDecision = typeof ProviderApprovalDecision.Type;
export const ProviderUserInputAnswers = Schema.Record(Schema.String, Schema.Unknown);
export type ProviderUserInputAnswers = typeof ProviderUserInputAnswers.Type;

export const PROVIDER_SEND_TURN_MAX_INPUT_CHARS = 120_000;
export const PROVIDER_SEND_TURN_MAX_ATTACHMENTS = 8;
export const PROVIDER_SEND_TURN_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const PROVIDER_SEND_TURN_MAX_IMAGE_DATA_URL_CHARS = 14_000_000;
const CHAT_ATTACHMENT_ID_MAX_CHARS = 128;
// Correlation id is command id by design in this model.
export const CorrelationId = CommandId;
export type CorrelationId = typeof CorrelationId.Type;

const ChatAttachmentId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(CHAT_ATTACHMENT_ID_MAX_CHARS),
  Schema.isPattern(/^[a-z0-9_-]+$/i),
);
export type ChatAttachmentId = typeof ChatAttachmentId.Type;

export const ChatImageAttachment = Schema.Struct({
  type: Schema.Literal("image"),
  id: ChatAttachmentId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  mimeType: TrimmedNonEmptyString.check(Schema.isMaxLength(100), Schema.isPattern(/^image\//i)),
  sizeBytes: NonNegativeInt.check(Schema.isLessThanOrEqualTo(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES)),
});
export type ChatImageAttachment = typeof ChatImageAttachment.Type;

const UploadChatImageAttachment = Schema.Struct({
  type: Schema.Literal("image"),
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  mimeType: TrimmedNonEmptyString.check(Schema.isMaxLength(100), Schema.isPattern(/^image\//i)),
  sizeBytes: NonNegativeInt.check(Schema.isLessThanOrEqualTo(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES)),
  dataUrl: TrimmedNonEmptyString.check(
    Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_IMAGE_DATA_URL_CHARS),
  ),
});
export type UploadChatImageAttachment = typeof UploadChatImageAttachment.Type;

export const ChatAttachment = Schema.Union([ChatImageAttachment]);
export type ChatAttachment = typeof ChatAttachment.Type;
const UploadChatAttachment = Schema.Union([UploadChatImageAttachment]);
export type UploadChatAttachment = typeof UploadChatAttachment.Type;

export const ProjectScriptIcon = Schema.Literals([
  "play",
  "test",
  "lint",
  "configure",
  "build",
  "debug",
]);
export type ProjectScriptIcon = typeof ProjectScriptIcon.Type;

export const ProjectScript = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  command: TrimmedNonEmptyString,
  icon: ProjectScriptIcon,
  runOnWorktreeCreate: Schema.Boolean,
  /**
   * URL to open in the in-app browser preview when this script runs (or
   * when the user explicitly requests a preview). Optional; only honored on
   * the desktop build.
   */
  previewUrl: Schema.optional(TrimmedNonEmptyString),
  /**
   * When true, automatically open the preview panel pointed at `previewUrl`
   * the moment this script starts. Ignored without `previewUrl` or on web.
   */
  autoOpenPreview: Schema.optional(Schema.Boolean),
});
export type ProjectScript = typeof ProjectScript.Type;

export const OrchestrationProject = Schema.Struct({
  id: ProjectId,
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  repositoryIdentity: Schema.optional(Schema.NullOr(RepositoryIdentity)),
  defaultModelSelection: Schema.NullOr(ModelSelection),
  scripts: Schema.Array(ProjectScript),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  deletedAt: Schema.NullOr(IsoDateTime),
});
export type OrchestrationProject = typeof OrchestrationProject.Type;

export const OrchestrationMessageRole = Schema.Literals(["user", "assistant", "system"]);
export type OrchestrationMessageRole = typeof OrchestrationMessageRole.Type;

export const OrchestrationMessage = Schema.Struct({
  id: MessageId,
  role: OrchestrationMessageRole,
  text: Schema.String,
  attachments: Schema.optional(Schema.Array(ChatAttachment)),
  turnId: Schema.NullOr(TurnId),
  streaming: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OrchestrationMessage = typeof OrchestrationMessage.Type;

export const OrchestrationProposedPlanId = TrimmedNonEmptyString;
export type OrchestrationProposedPlanId = typeof OrchestrationProposedPlanId.Type;

export const OrchestrationProposedPlan = Schema.Struct({
  id: OrchestrationProposedPlanId,
  turnId: Schema.NullOr(TurnId),
  planMarkdown: TrimmedNonEmptyString,
  implementedAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  implementationThreadId: Schema.NullOr(ThreadId).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OrchestrationProposedPlan = typeof OrchestrationProposedPlan.Type;

export const OrchestrationPlanningPrdId = TrimmedNonEmptyString;
export type OrchestrationPlanningPrdId = typeof OrchestrationPlanningPrdId.Type;

export const OrchestrationPlanningPrd = Schema.Struct({
  id: OrchestrationPlanningPrdId,
  title: TrimmedNonEmptyString,
  summaryMarkdown: TrimmedNonEmptyString,
  tenantId: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  teamId: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  sourceThreadId: ThreadId,
  sourceMessageIds: Schema.Array(MessageId).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  createdBy: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  workflowId: TrimmedNonEmptyString,
  issueCount: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OrchestrationPlanningPrd = typeof OrchestrationPlanningPrd.Type;

export const OrchestrationPlanningIssueId = TrimmedNonEmptyString;
export type OrchestrationPlanningIssueId = typeof OrchestrationPlanningIssueId.Type;

export const OrchestrationPlanningIssueDependency = Schema.Struct({
  prdId: OrchestrationPlanningPrdId,
  issueId: OrchestrationPlanningIssueId,
});
export type OrchestrationPlanningIssueDependency = typeof OrchestrationPlanningIssueDependency.Type;

export const OrchestrationPlanningIssue = Schema.Struct({
  id: OrchestrationPlanningIssueId,
  prdId: OrchestrationPlanningPrdId,
  ordinal: NonNegativeInt,
  title: TrimmedNonEmptyString,
  bodyMarkdown: TrimmedNonEmptyString,
  dependencies: Schema.Array(OrchestrationPlanningIssueDependency).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  status: TrimmedNonEmptyString.pipe(Schema.withDecodingDefault(Effect.succeed("open"))),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OrchestrationPlanningIssue = typeof OrchestrationPlanningIssue.Type;

export const OrchestrationPlanningReviewIssueFeedback = Schema.Struct({
  issueId: OrchestrationPlanningIssueId,
  passed: Schema.Boolean,
  feedbackMarkdown: Schema.String,
});
export type OrchestrationPlanningReviewIssueFeedback =
  typeof OrchestrationPlanningReviewIssueFeedback.Type;

export const OrchestrationPlanningReviewCycleStatus = Schema.Literals(["passed", "failed"]);
export type OrchestrationPlanningReviewCycleStatus =
  typeof OrchestrationPlanningReviewCycleStatus.Type;

export const OrchestrationPlanningReviewCycle = Schema.Struct({
  cycleNumber: NonNegativeInt,
  status: OrchestrationPlanningReviewCycleStatus,
  reviewerThreadId: ThreadId,
  reviewerMessageId: MessageId,
  verdictMarkdown: Schema.String,
  failingPlanningIssueIds: Schema.Array(OrchestrationPlanningIssueId).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  dependencyFeedback: Schema.Array(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  perIssueFeedback: Schema.Array(OrchestrationPlanningReviewIssueFeedback).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  createdAt: IsoDateTime,
});
export type OrchestrationPlanningReviewCycle = typeof OrchestrationPlanningReviewCycle.Type;

const OrchestrationPlanningWorkflowStageWire = Schema.Literals([
  "grill",
  "artifact-generation-gate",
  "artifact-generation",
  "prd-authoring",
  "issues-authoring",
  "issue-review",
  "issue-revision",
  "completed",
  "needs-human-attention",
]);

const OrchestrationPlanningWorkflowStageCanonical = Schema.Literals([
  "grill",
  "prd-authoring",
  "issues-authoring",
  "issue-review",
  "issue-revision",
  "completed",
  "needs-human-attention",
]);

export const OrchestrationPlanningWorkflowStage = OrchestrationPlanningWorkflowStageWire.pipe(
  Schema.decodeTo(
    OrchestrationPlanningWorkflowStageCanonical,
    SchemaTransformation.transformOrFail({
      decode: (stage) => {
        switch (stage) {
          case "artifact-generation-gate":
            return Effect.succeed("prd-authoring" as const);
          case "artifact-generation":
            return Effect.succeed("issue-review" as const);
          default:
            return Effect.succeed(stage);
        }
      },
      encode: (stage) => Effect.succeed(stage),
    }),
  ),
);
export type OrchestrationPlanningWorkflowStage = typeof OrchestrationPlanningWorkflowStage.Type;

export const OrchestrationPlanningWorkflow = Schema.Struct({
  stage: OrchestrationPlanningWorkflowStage,
  createIssuesAvailable: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  prd: Schema.NullOr(OrchestrationPlanningPrd),
  issues: Schema.Array(OrchestrationPlanningIssue).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  reviewCycles: Schema.Array(OrchestrationPlanningReviewCycle).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
});
export type OrchestrationPlanningWorkflow = typeof OrchestrationPlanningWorkflow.Type;

export const OrchestrationPlanningPrdBundle = Schema.Struct({
  prd: OrchestrationPlanningPrd,
  issues: Schema.Array(OrchestrationPlanningIssue).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  reviewCycles: Schema.Array(OrchestrationPlanningReviewCycle).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
});
export type OrchestrationPlanningPrdBundle = typeof OrchestrationPlanningPrdBundle.Type;

export const IMPLEMENTATION_RUN_MAX_QA_ATTEMPTS = 5;

export const OrchestrationImplementationRunId = TrimmedNonEmptyString;
export type OrchestrationImplementationRunId = typeof OrchestrationImplementationRunId.Type;

export const OrchestrationImplementationChangeRequest = ChangeRequest.mapFields(
  Struct.assign({
    updatedAt: Schema.Unknown,
  }),
);
export type OrchestrationImplementationChangeRequest =
  typeof OrchestrationImplementationChangeRequest.Type;

export const OrchestrationImplementationChangeRequestFailure = Schema.Struct({
  reason: Schema.Literals([
    "missing-auth",
    "wrong-branch",
    "commit-failed",
    "push-failed",
    "provider-failed",
    "change-request-failed",
    "unknown",
  ]),
  detail: TrimmedNonEmptyString,
  failedAt: IsoDateTime,
});
export type OrchestrationImplementationChangeRequestFailure =
  typeof OrchestrationImplementationChangeRequestFailure.Type;

export const OrchestrationImplementationRunStatus = Schema.Literals([
  "launch-pending",
  "running",
  "integrating",
  "validating",
  "qa-reviewing",
  "fixing",
  "needs-human-attention",
  "completed",
  "canceled",
]);
export type OrchestrationImplementationRunStatus = typeof OrchestrationImplementationRunStatus.Type;

export const OrchestrationImplementationDependencyEdge = Schema.Struct({
  blockingIssueId: OrchestrationPlanningIssueId,
  dependentIssueId: OrchestrationPlanningIssueId,
});
export type OrchestrationImplementationDependencyEdge =
  typeof OrchestrationImplementationDependencyEdge.Type;

export const OrchestrationImplementationPlannedWorker = Schema.Struct({
  issueId: OrchestrationPlanningIssueId,
  dependencyIssueIds: Schema.Array(OrchestrationPlanningIssueId).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  branch: TrimmedNonEmptyString,
  worktreePath: TrimmedNonEmptyString,
});
export type OrchestrationImplementationPlannedWorker =
  typeof OrchestrationImplementationPlannedWorker.Type;

export const OrchestrationImplementationFinalDevReviewPlan = Schema.Struct({
  required: Schema.Boolean,
  completionBlocking: Schema.Literal(true).pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  appDevStackSource: Schema.Literal("orchestrator-worktree"),
  autoStartAppDevStack: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  browserMcpProfile: Schema.Literal("chrome-devtools").pipe(
    Schema.withDecodingDefault(Effect.succeed("chrome-devtools" as const)),
  ),
  maxAttempts: NonNegativeInt.pipe(
    Schema.withDecodingDefault(Effect.succeed(IMPLEMENTATION_RUN_MAX_QA_ATTEMPTS)),
  ),
});
export type OrchestrationImplementationFinalDevReviewPlan =
  typeof OrchestrationImplementationFinalDevReviewPlan.Type;

export const OrchestrationImplementationAppDevStackState = Schema.Struct({
  status: Schema.Literals(["not-requested", "ensuring", "ready", "failed"]).pipe(
    Schema.withDecodingDefault(Effect.succeed("not-requested" as const)),
  ),
  stackId: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  stackStatus: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  frontendUrl: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  frontendServiceName: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  displayName: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  lastErrorMarkdown: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  requestedAt: IsoDateTime.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  updatedAt: IsoDateTime.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
});
export type OrchestrationImplementationAppDevStackState =
  typeof OrchestrationImplementationAppDevStackState.Type;

export const OrchestrationImplementationQaToolingState = Schema.Struct({
  status: Schema.Literals(["unknown", "ready", "failed"]).pipe(
    Schema.withDecodingDefault(Effect.succeed("unknown" as const)),
  ),
  chromePath: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  mcpPackage: TrimmedNonEmptyString.pipe(
    Schema.withDecodingDefault(Effect.succeed("chrome-devtools-mcp@latest")),
  ),
  lastErrorMarkdown: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  checkedAt: IsoDateTime.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
});
export type OrchestrationImplementationQaToolingState =
  typeof OrchestrationImplementationQaToolingState.Type;

export const OrchestrationImplementationLaunchSummary = Schema.Struct({
  prdId: OrchestrationPlanningPrdId,
  planningIssueIds: Schema.Array(OrchestrationPlanningIssueId),
  baseBranch: TrimmedNonEmptyString,
  pinnedCommit: TrimmedNonEmptyString,
  orchestratorBranch: TrimmedNonEmptyString,
  orchestratorWorktreePath: TrimmedNonEmptyString,
  dependencyEdges: Schema.Array(OrchestrationImplementationDependencyEdge).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  initialReadyIssueIds: Schema.Array(OrchestrationPlanningIssueId).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  plannedWorkers: Schema.Array(OrchestrationImplementationPlannedWorker).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  validationCommands: Schema.Array(TrimmedNonEmptyString),
  finalDevReview: OrchestrationImplementationFinalDevReviewPlan,
  createdAt: IsoDateTime,
});
export type OrchestrationImplementationLaunchSummary =
  typeof OrchestrationImplementationLaunchSummary.Type;

export const OrchestrationImplementationValidationResultStatus = Schema.Literals([
  "passed",
  "failed",
]);
export type OrchestrationImplementationValidationResultStatus =
  typeof OrchestrationImplementationValidationResultStatus.Type;

export const OrchestrationImplementationValidationResult = Schema.Struct({
  command: TrimmedNonEmptyString,
  status: OrchestrationImplementationValidationResultStatus,
  outputMarkdown: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  completedAt: IsoDateTime,
});
export type OrchestrationImplementationValidationResult =
  typeof OrchestrationImplementationValidationResult.Type;

export const OrchestrationImplementationDevReviewEvidence = Schema.Struct({
  label: TrimmedNonEmptyString,
  value: Schema.String,
});
export type OrchestrationImplementationDevReviewEvidence =
  typeof OrchestrationImplementationDevReviewEvidence.Type;

export const OrchestrationImplementationDevReviewVerdict = Schema.Literals(["pass", "fail"]);
export type OrchestrationImplementationDevReviewVerdict =
  typeof OrchestrationImplementationDevReviewVerdict.Type;

export const OrchestrationImplementationDevReviewDocument = Schema.Struct({
  kind: Schema.Literal("react-document-preset"),
  preset: Schema.Literal("implementation-dev-review"),
  version: Schema.Literal(1),
  verdict: OrchestrationImplementationDevReviewVerdict,
  runId: OrchestrationImplementationRunId,
  reviewerThreadId: ThreadId,
  featureUrl: Schema.NullOr(TrimmedNonEmptyString),
  overviewMarkdown: Schema.String,
  acceptanceCriteria: Schema.Array(
    Schema.Struct({
      label: TrimmedNonEmptyString,
      status: Schema.Literals(["pass", "fail", "not-tested"]),
      notesMarkdown: Schema.String,
    }),
  ).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  userFlows: Schema.Array(
    Schema.Struct({
      title: TrimmedNonEmptyString,
      steps: Schema.Array(TrimmedNonEmptyString).pipe(
        Schema.withDecodingDefault(Effect.succeed([])),
      ),
      outcomeMarkdown: Schema.String,
      evidenceLabels: Schema.Array(TrimmedNonEmptyString).pipe(
        Schema.withDecodingDefault(Effect.succeed([])),
      ),
    }),
  ).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  issues: Schema.Array(
    Schema.Struct({
      severity: Schema.Literals(["blocker", "major", "minor"]),
      title: TrimmedNonEmptyString,
      reproductionSteps: Schema.Array(TrimmedNonEmptyString).pipe(
        Schema.withDecodingDefault(Effect.succeed([])),
      ),
      expectedMarkdown: Schema.String,
      actualMarkdown: Schema.String,
      suggestedFixMarkdown: Schema.String,
      impactedIssueIds: Schema.Array(OrchestrationPlanningIssueId).pipe(
        Schema.withDecodingDefault(Effect.succeed([])),
      ),
    }),
  ).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  evidence: Schema.Array(
    Schema.Struct({
      kind: Schema.Literals(["url", "screenshot", "recording", "console", "network", "note"]),
      label: TrimmedNonEmptyString,
      value: Schema.String,
    }),
  ).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  nextAction: Schema.Literals(["complete", "fix-and-rerun", "blocked"]),
});
export type OrchestrationImplementationDevReviewDocument =
  typeof OrchestrationImplementationDevReviewDocument.Type;

export const OrchestrationImplementationDevReviewArtifact = Schema.Struct({
  id: TrimmedNonEmptyString,
  runId: OrchestrationImplementationRunId,
  reviewerThreadId: ThreadId,
  verdict: OrchestrationImplementationDevReviewVerdict,
  devReviewMarkdown: Schema.String,
  document: Schema.optionalKey(OrchestrationImplementationDevReviewDocument),
  featureUrl: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
  evidence: Schema.Array(OrchestrationImplementationDevReviewEvidence).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  createdAt: IsoDateTime,
});
export type OrchestrationImplementationDevReviewArtifact =
  typeof OrchestrationImplementationDevReviewArtifact.Type;

const OrchestrationImplementationWorkerResultBase = {
  issueId: OrchestrationPlanningIssueId,
  workerThreadId: ThreadId,
  branch: TrimmedNonEmptyString,
  worktreePath: TrimmedNonEmptyString,
  validations: Schema.Array(OrchestrationImplementationValidationResult).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  notesMarkdown: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  reportedAt: IsoDateTime,
} as const;

export const OrchestrationImplementationWorkerResult = Schema.Union([
  Schema.Struct({
    ...OrchestrationImplementationWorkerResultBase,
    status: Schema.Literal("succeeded"),
    commitSha: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    ...OrchestrationImplementationWorkerResultBase,
    status: Schema.Literal("failed"),
    commitSha: Schema.NullOr(TrimmedNonEmptyString).pipe(
      Schema.withDecodingDefault(Effect.succeed(null)),
    ),
  }),
]);
export type OrchestrationImplementationWorkerResult =
  typeof OrchestrationImplementationWorkerResult.Type;

export const OrchestrationImplementationIssueStateStatus = Schema.Literals([
  "blocked",
  "ready",
  "running",
  "succeeded",
  "failed",
]);
export type OrchestrationImplementationIssueStateStatus =
  typeof OrchestrationImplementationIssueStateStatus.Type;

export const OrchestrationImplementationIssueState = Schema.Struct({
  issueId: OrchestrationPlanningIssueId,
  status: OrchestrationImplementationIssueStateStatus,
  dependencyIssueIds: Schema.Array(OrchestrationPlanningIssueId).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  workerThreadId: Schema.NullOr(ThreadId).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  branch: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  workerResult: Schema.NullOr(OrchestrationImplementationWorkerResult).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  updatedAt: IsoDateTime,
});
export type OrchestrationImplementationIssueState =
  typeof OrchestrationImplementationIssueState.Type;

export const OrchestrationImplementationRun = Schema.Struct({
  id: OrchestrationImplementationRunId,
  prdId: OrchestrationPlanningPrdId,
  planningIssueIds: Schema.Array(OrchestrationPlanningIssueId),
  orchestratorThreadId: ThreadId,
  status: OrchestrationImplementationRunStatus.pipe(
    Schema.withDecodingDefault(Effect.succeed("launch-pending" as const)),
  ),
  baseBranch: TrimmedNonEmptyString,
  pinnedCommit: TrimmedNonEmptyString,
  orchestratorBranch: TrimmedNonEmptyString,
  orchestratorWorktreePath: TrimmedNonEmptyString,
  launchSummary: OrchestrationImplementationLaunchSummary,
  issueStates: Schema.Array(OrchestrationImplementationIssueState).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  workerResults: Schema.Array(OrchestrationImplementationWorkerResult).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  terminalLineageIssueIds: Schema.Array(OrchestrationPlanningIssueId).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  finalValidation: Schema.NullOr(OrchestrationImplementationValidationResult).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  appDevStack: OrchestrationImplementationAppDevStackState.pipe(
    Schema.withDecodingDefault(
      Effect.succeed({
        status: "not-requested" as const,
        stackId: null,
        stackStatus: null,
        frontendUrl: null,
        frontendServiceName: null,
        displayName: null,
        lastErrorMarkdown: null,
        requestedAt: "",
        updatedAt: "",
      }),
    ),
  ),
  qaTooling: OrchestrationImplementationQaToolingState.pipe(
    Schema.withDecodingDefault(
      Effect.succeed({
        status: "unknown" as const,
        chromePath: null,
        mcpPackage: "chrome-devtools-mcp@latest",
        lastErrorMarkdown: null,
        checkedAt: "",
      }),
    ),
  ),
  devReviewIds: Schema.Array(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  devReviews: Schema.Array(OrchestrationImplementationDevReviewArtifact).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  qaAttemptCount: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  handoffTarget: Schema.Literal("orchestrator-worktree").pipe(
    Schema.withDecodingDefault(Effect.succeed("orchestrator-worktree" as const)),
  ),
  baseBranchMergePolicy: Schema.Literal("never-auto-merge").pipe(
    Schema.withDecodingDefault(Effect.succeed("never-auto-merge" as const)),
  ),
  changeRequest: Schema.NullOr(OrchestrationImplementationChangeRequest).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  changeRequestFailure: Schema.NullOr(OrchestrationImplementationChangeRequestFailure).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  changeRequestPublisherUserId: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OrchestrationImplementationRun = typeof OrchestrationImplementationRun.Type;

const SourceProposedPlanReference = Schema.Struct({
  threadId: ThreadId,
  planId: OrchestrationProposedPlanId,
});

export const OrchestrationSessionStatus = Schema.Literals([
  "idle",
  "starting",
  "running",
  "ready",
  "interrupted",
  "stopped",
  "error",
]);
export type OrchestrationSessionStatus = typeof OrchestrationSessionStatus.Type;

export const OrchestrationThreadWorkflowRole = Schema.Literals([
  "planning-orchestrator",
  "planning-reviewer",
  "implementation-orchestrator",
  "implementation-worker",
  "implementation-validator",
  "implementation-qa-reviewer",
  "implementation-fixer",
]);
export type OrchestrationThreadWorkflowRole = typeof OrchestrationThreadWorkflowRole.Type;

export const OrchestrationSession = Schema.Struct({
  threadId: ThreadId,
  status: OrchestrationSessionStatus,
  providerName: Schema.NullOr(TrimmedNonEmptyString),
  providerInstanceId: Schema.optional(ProviderInstanceId),
  runtimeMode: RuntimeMode.pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_RUNTIME_MODE))),
  activeTurnId: Schema.NullOr(TurnId),
  lastError: Schema.NullOr(TrimmedNonEmptyString),
  updatedAt: IsoDateTime,
});
export type OrchestrationSession = typeof OrchestrationSession.Type;

export const OrchestrationCheckpointFile = Schema.Struct({
  path: TrimmedNonEmptyString,
  kind: TrimmedNonEmptyString,
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
});
export type OrchestrationCheckpointFile = typeof OrchestrationCheckpointFile.Type;

export const OrchestrationCheckpointStatus = Schema.Literals(["ready", "missing", "error"]);
export type OrchestrationCheckpointStatus = typeof OrchestrationCheckpointStatus.Type;

export const OrchestrationCheckpointSummary = Schema.Struct({
  turnId: TurnId,
  checkpointTurnCount: NonNegativeInt,
  checkpointRef: CheckpointRef,
  status: OrchestrationCheckpointStatus,
  files: Schema.Array(OrchestrationCheckpointFile),
  assistantMessageId: Schema.NullOr(MessageId),
  completedAt: IsoDateTime,
});
export type OrchestrationCheckpointSummary = typeof OrchestrationCheckpointSummary.Type;

export const OrchestrationThreadActivityTone = Schema.Literals([
  "info",
  "tool",
  "approval",
  "error",
]);
export type OrchestrationThreadActivityTone = typeof OrchestrationThreadActivityTone.Type;

export const OrchestrationThreadActivity = Schema.Struct({
  id: EventId,
  tone: OrchestrationThreadActivityTone,
  kind: TrimmedNonEmptyString,
  summary: TrimmedNonEmptyString,
  payload: Schema.Unknown,
  turnId: Schema.NullOr(TurnId),
  sequence: Schema.optional(NonNegativeInt),
  createdAt: IsoDateTime,
});
export type OrchestrationThreadActivity = typeof OrchestrationThreadActivity.Type;

const OrchestrationLatestTurnState = Schema.Literals([
  "running",
  "interrupted",
  "completed",
  "error",
]);
export type OrchestrationLatestTurnState = typeof OrchestrationLatestTurnState.Type;

export const OrchestrationLatestTurn = Schema.Struct({
  turnId: TurnId,
  state: OrchestrationLatestTurnState,
  requestedAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
  assistantMessageId: Schema.NullOr(MessageId),
  sourceProposedPlan: Schema.optional(SourceProposedPlanReference),
});
export type OrchestrationLatestTurn = typeof OrchestrationLatestTurn.Type;

export const OrchestrationThread = Schema.Struct({
  id: ThreadId,
  projectId: ProjectId,
  ownerUserId: WorkspaceUserId.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_WORKSPACE_USER_ID)),
  ),
  parentThreadId: Schema.NullOr(ThreadId).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  workflowRole: Schema.NullOr(OrchestrationThreadWorkflowRole).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE)),
  ),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  latestTurn: Schema.NullOr(OrchestrationLatestTurn),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  deletedAt: Schema.NullOr(IsoDateTime),
  messages: Schema.Array(OrchestrationMessage),
  proposedPlans: Schema.Array(OrchestrationProposedPlan).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  planningWorkflow: Schema.NullOr(OrchestrationPlanningWorkflow).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  devReviews: Schema.Array(DevReviewRecord).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  activities: Schema.Array(OrchestrationThreadActivity),
  checkpoints: Schema.Array(OrchestrationCheckpointSummary),
  session: Schema.NullOr(OrchestrationSession),
});
export type OrchestrationThread = typeof OrchestrationThread.Type;

export const OrchestrationReadModel = Schema.Struct({
  snapshotSequence: NonNegativeInt,
  projects: Schema.Array(OrchestrationProject),
  threads: Schema.Array(OrchestrationThread),
  implementationRuns: Schema.Array(OrchestrationImplementationRun).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  updatedAt: IsoDateTime,
});
export type OrchestrationReadModel = typeof OrchestrationReadModel.Type;

export const OrchestrationProjectShell = Schema.Struct({
  id: ProjectId,
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  repositoryIdentity: Schema.optional(Schema.NullOr(RepositoryIdentity)),
  defaultModelSelection: Schema.NullOr(ModelSelection),
  scripts: Schema.Array(ProjectScript),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OrchestrationProjectShell = typeof OrchestrationProjectShell.Type;

export const OrchestrationThreadShell = Schema.Struct({
  id: ThreadId,
  projectId: ProjectId,
  ownerUserId: WorkspaceUserId.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_WORKSPACE_USER_ID)),
  ),
  parentThreadId: Schema.NullOr(ThreadId).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  workflowRole: Schema.NullOr(OrchestrationThreadWorkflowRole).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE)),
  ),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  latestTurn: Schema.NullOr(OrchestrationLatestTurn),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  session: Schema.NullOr(OrchestrationSession),
  latestUserMessageAt: Schema.NullOr(IsoDateTime),
  hasPendingApprovals: Schema.Boolean,
  hasPendingUserInput: Schema.Boolean,
  hasActionableProposedPlan: Schema.Boolean,
  planningWorkflowSummary: Schema.optionalKey(
    Schema.Struct({
      stage: OrchestrationPlanningWorkflowStage,
      prdId: Schema.NullOr(OrchestrationPlanningPrdId),
      prdTitle: Schema.optional(TrimmedNonEmptyString),
      prdSourceThreadId: Schema.optional(ThreadId),
      prdWorkflowId: Schema.optional(TrimmedNonEmptyString),
      prdIssueCount: Schema.optional(NonNegativeInt),
      prdCreatedAt: Schema.optional(IsoDateTime),
      prdUpdatedAt: Schema.optional(IsoDateTime),
    }),
  ),
});
export type OrchestrationThreadShell = typeof OrchestrationThreadShell.Type;

export const OrchestrationShellSnapshot = Schema.Struct({
  snapshotSequence: NonNegativeInt,
  projects: Schema.Array(OrchestrationProjectShell),
  threads: Schema.Array(OrchestrationThreadShell),
  implementationRuns: Schema.optionalKey(Schema.Array(OrchestrationImplementationRun)),
  updatedAt: IsoDateTime,
});
export type OrchestrationShellSnapshot = typeof OrchestrationShellSnapshot.Type;

export const OrchestrationShellStreamEvent = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("project-upserted"),
    sequence: NonNegativeInt,
    project: OrchestrationProjectShell,
  }),
  Schema.Struct({
    kind: Schema.Literal("project-removed"),
    sequence: NonNegativeInt,
    projectId: ProjectId,
  }),
  Schema.Struct({
    kind: Schema.Literal("thread-upserted"),
    sequence: NonNegativeInt,
    thread: OrchestrationThreadShell,
  }),
  Schema.Struct({
    kind: Schema.Literal("thread-removed"),
    sequence: NonNegativeInt,
    threadId: ThreadId,
  }),
  Schema.Struct({
    kind: Schema.Literal("implementation-run-upserted"),
    sequence: NonNegativeInt,
    run: OrchestrationImplementationRun,
  }),
]);
export type OrchestrationShellStreamEvent = typeof OrchestrationShellStreamEvent.Type;

export const OrchestrationShellStreamItem = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("snapshot"),
    snapshot: OrchestrationShellSnapshot,
  }),
  OrchestrationShellStreamEvent,
]);
export type OrchestrationShellStreamItem = typeof OrchestrationShellStreamItem.Type;

export const OrchestrationSubscribeShellInput = Schema.Struct({
  userView: WorkspaceUserView.pipe(
    Schema.withDecodingDefault(Effect.succeed({ kind: "all" as const })),
  ),
});
export type OrchestrationSubscribeShellInput = typeof OrchestrationSubscribeShellInput.Type;

export const OrchestrationGetArchivedShellSnapshotInput = Schema.Struct({
  userView: WorkspaceUserView.pipe(
    Schema.withDecodingDefault(Effect.succeed({ kind: "all" as const })),
  ),
});
export type OrchestrationGetArchivedShellSnapshotInput =
  typeof OrchestrationGetArchivedShellSnapshotInput.Type;

export const OrchestrationSubscribeThreadInput = Schema.Struct({
  threadId: ThreadId,
});
export type OrchestrationSubscribeThreadInput = typeof OrchestrationSubscribeThreadInput.Type;

export const OrchestrationThreadDetailSnapshot = Schema.Struct({
  snapshotSequence: NonNegativeInt,
  thread: OrchestrationThread,
  implementationRuns: Schema.optionalKey(Schema.Array(OrchestrationImplementationRun)),
});
export type OrchestrationThreadDetailSnapshot = typeof OrchestrationThreadDetailSnapshot.Type;

export const ProjectCreateCommand = Schema.Struct({
  type: Schema.Literal("project.create"),
  commandId: CommandId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  createWorkspaceRootIfMissing: Schema.optional(Schema.Boolean),
  defaultModelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
  createdAt: IsoDateTime,
});

const ProjectMetaUpdateCommand = Schema.Struct({
  type: Schema.Literal("project.meta.update"),
  commandId: CommandId,
  projectId: ProjectId,
  title: Schema.optional(TrimmedNonEmptyString),
  workspaceRoot: Schema.optional(TrimmedNonEmptyString),
  defaultModelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
  scripts: Schema.optional(Schema.Array(ProjectScript)),
});

const ProjectDeleteCommand = Schema.Struct({
  type: Schema.Literal("project.delete"),
  commandId: CommandId,
  projectId: ProjectId,
  force: Schema.optional(Schema.Boolean),
});

const ThreadCreateCommand = Schema.Struct({
  type: Schema.Literal("thread.create"),
  commandId: CommandId,
  threadId: ThreadId,
  projectId: ProjectId,
  ownerUserId: WorkspaceUserId.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_WORKSPACE_USER_ID)),
  ),
  parentThreadId: Schema.optionalKey(Schema.NullOr(ThreadId)),
  workflowRole: Schema.optionalKey(Schema.NullOr(OrchestrationThreadWorkflowRole)),
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE)),
  ),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
});

const ThreadDeleteCommand = Schema.Struct({
  type: Schema.Literal("thread.delete"),
  commandId: CommandId,
  threadId: ThreadId,
});

const ThreadArchiveCommand = Schema.Struct({
  type: Schema.Literal("thread.archive"),
  commandId: CommandId,
  threadId: ThreadId,
});

const ThreadUnarchiveCommand = Schema.Struct({
  type: Schema.Literal("thread.unarchive"),
  commandId: CommandId,
  threadId: ThreadId,
});

const ThreadMetaUpdateCommand = Schema.Struct({
  type: Schema.Literal("thread.meta.update"),
  commandId: CommandId,
  threadId: ThreadId,
  ownerUserId: Schema.optional(WorkspaceUserId),
  title: Schema.optional(TrimmedNonEmptyString),
  modelSelection: Schema.optional(ModelSelection),
  branch: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  worktreePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
});

const ThreadRuntimeModeSetCommand = Schema.Struct({
  type: Schema.Literal("thread.runtime-mode.set"),
  commandId: CommandId,
  threadId: ThreadId,
  runtimeMode: RuntimeMode,
  createdAt: IsoDateTime,
});

const ThreadInteractionModeSetCommand = Schema.Struct({
  type: Schema.Literal("thread.interaction-mode.set"),
  commandId: CommandId,
  threadId: ThreadId,
  interactionMode: ProviderInteractionMode,
  createdAt: IsoDateTime,
});

const ThreadPlanningPrdCreateCommand = Schema.Struct({
  type: Schema.Literal("thread.planning-prd.create"),
  commandId: CommandId,
  threadId: ThreadId,
  tenantId: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  teamId: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  createdBy: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  createdAt: IsoDateTime,
});

const ThreadPlanningStageStartCommand = Schema.Struct({
  type: Schema.Literal("thread.planning-stage.start"),
  commandId: CommandId,
  threadId: ThreadId,
  stage: Schema.Literals(["prd"]),
  createdAt: IsoDateTime,
});

const ThreadPlanningWorkflowLaunchCommand = Schema.Struct({
  type: Schema.Literal("thread.planning-workflow.launch"),
  commandId: CommandId,
  threadId: ThreadId,
  intentTitle: TrimmedNonEmptyString,
  intentSummaryMarkdown: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
});

const ThreadPlanningWorkflowStageSetCommand = Schema.Struct({
  type: Schema.Literal("thread.planning-workflow.stage.set"),
  commandId: CommandId,
  threadId: ThreadId,
  stage: OrchestrationPlanningWorkflowStage,
  reasonMarkdown: Schema.optional(Schema.String),
  createdAt: IsoDateTime,
});

const ThreadPlanningPrdApplyCommand = Schema.Struct({
  type: Schema.Literal("thread.planning-prd.apply"),
  commandId: CommandId,
  threadId: ThreadId,
  sourceMessageId: MessageId,
  title: TrimmedNonEmptyString,
  summaryMarkdown: TrimmedNonEmptyString,
  tenantId: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  teamId: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  createdBy: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  createdAt: IsoDateTime,
});

export const ThreadPlanningIssueArtifactInput = Schema.Struct({
  key: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  bodyMarkdown: TrimmedNonEmptyString,
  dependencyKeys: Schema.Array(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
});
export type ThreadPlanningIssueArtifactInput = typeof ThreadPlanningIssueArtifactInput.Type;

const ThreadPlanningIssuesApplyCommand = Schema.Struct({
  type: Schema.Literal("thread.planning-issues.apply"),
  commandId: CommandId,
  threadId: ThreadId,
  sourceMessageId: MessageId,
  prdId: OrchestrationPlanningPrdId,
  issues: Schema.Array(ThreadPlanningIssueArtifactInput),
  createdAt: IsoDateTime,
});

const ThreadPlanningIssueReviewRequestCommand = Schema.Struct({
  type: Schema.Literal("thread.planning-issue-review.request"),
  commandId: CommandId,
  threadId: ThreadId,
  prdId: OrchestrationPlanningPrdId,
  createdAt: IsoDateTime,
});

const ThreadPlanningReviewerVerdictApplyCommand = Schema.Struct({
  type: Schema.Literal("thread.planning-reviewer-verdict.apply"),
  commandId: CommandId,
  threadId: ThreadId,
  reviewerThreadId: ThreadId,
  reviewerMessageId: MessageId,
  verdictMarkdown: Schema.String,
  passed: Schema.optional(Schema.Boolean),
  failingPlanningIssueIds: Schema.optional(Schema.Array(OrchestrationPlanningIssueId)),
  dependencyFeedback: Schema.optional(Schema.Array(Schema.String)),
  perIssueFeedback: Schema.optional(Schema.Array(OrchestrationPlanningReviewIssueFeedback)),
  createdAt: IsoDateTime,
});

const ThreadPlanningPrdBundleLoadCommand = Schema.Struct({
  type: Schema.Literal("thread.planning-prd-bundle.load"),
  commandId: CommandId,
  threadId: ThreadId,
  prdId: OrchestrationPlanningPrdId,
  tenantId: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  teamId: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  source: Schema.optional(Schema.Literals(["projection"])),
  bundle: Schema.optional(OrchestrationPlanningPrdBundle),
  createdAt: IsoDateTime,
});

const ThreadImplementationRunLaunchCommand = Schema.Struct({
  type: Schema.Literal("thread.implementation-run.launch"),
  commandId: CommandId,
  threadId: ThreadId,
  prdId: OrchestrationPlanningPrdId,
  baseBranch: TrimmedNonEmptyString,
  pinnedCommit: TrimmedNonEmptyString,
  orchestratorBranch: TrimmedNonEmptyString,
  orchestratorWorktreePath: TrimmedNonEmptyString,
  validationCommands: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  createdAt: IsoDateTime,
});

const ThreadImplementationRunUpdateCommand = Schema.Struct({
  type: Schema.Literal("thread.implementation-run.update"),
  commandId: CommandId,
  threadId: ThreadId,
  run: OrchestrationImplementationRun,
  createdAt: IsoDateTime,
});

const ThreadImplementationChangeRequestRetryCommand = Schema.Struct({
  type: Schema.Literal("thread.implementation-change-request.retry"),
  commandId: CommandId,
  threadId: ThreadId,
  runId: OrchestrationImplementationRunId,
  createdAt: IsoDateTime,
});

const ThreadTurnStartBootstrapCreateThread = Schema.Struct({
  projectId: ProjectId,
  ownerUserId: WorkspaceUserId.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_WORKSPACE_USER_ID)),
  ),
  parentThreadId: Schema.optionalKey(Schema.NullOr(ThreadId)),
  workflowRole: Schema.optionalKey(Schema.NullOr(OrchestrationThreadWorkflowRole)),
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
});

const ThreadTurnStartBootstrapPrepareWorktree = Schema.Struct({
  projectCwd: TrimmedNonEmptyString,
  baseBranch: TrimmedNonEmptyString,
  branch: Schema.optional(TrimmedNonEmptyString),
  startFromOrigin: Schema.optional(Schema.Boolean),
});

const ThreadTurnStartBootstrap = Schema.Struct({
  createThread: Schema.optional(ThreadTurnStartBootstrapCreateThread),
  prepareWorktree: Schema.optional(ThreadTurnStartBootstrapPrepareWorktree),
  runSetupScript: Schema.optional(Schema.Boolean),
});

export type ThreadTurnStartBootstrap = typeof ThreadTurnStartBootstrap.Type;

export const ThreadTurnStartCommand = Schema.Struct({
  type: Schema.Literal("thread.turn.start"),
  commandId: CommandId,
  threadId: ThreadId,
  message: Schema.Struct({
    messageId: MessageId,
    role: Schema.Literal("user"),
    text: Schema.String,
    attachments: Schema.Array(ChatAttachment),
  }),
  modelSelection: Schema.optional(ModelSelection),
  titleSeed: Schema.optional(TrimmedNonEmptyString),
  runtimeMode: RuntimeMode.pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_RUNTIME_MODE))),
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE)),
  ),
  workflowPromptId: Schema.optional(TrimmedNonEmptyString),
  bootstrap: Schema.optional(ThreadTurnStartBootstrap),
  sourceProposedPlan: Schema.optional(SourceProposedPlanReference),
  createdAt: IsoDateTime,
});

const ThreadDevReviewLaunchCommand = Schema.Struct({
  type: Schema.Literal("thread.dev-review.launch"),
  commandId: CommandId,
  sourceThreadId: ThreadId,
  reviewThreadId: ThreadId,
  reviewId: DevReviewId,
  message: Schema.Struct({
    messageId: MessageId,
    role: Schema.Literal("user"),
    text: Schema.String,
    attachments: Schema.Array(ChatAttachment),
  }),
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  workflowPromptId: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
});

const ClientThreadTurnStartCommand = Schema.Struct({
  type: Schema.Literal("thread.turn.start"),
  commandId: CommandId,
  threadId: ThreadId,
  message: Schema.Struct({
    messageId: MessageId,
    role: Schema.Literal("user"),
    text: Schema.String,
    attachments: Schema.Array(UploadChatAttachment),
  }),
  modelSelection: Schema.optional(ModelSelection),
  titleSeed: Schema.optional(TrimmedNonEmptyString),
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  workflowPromptId: Schema.optional(TrimmedNonEmptyString),
  bootstrap: Schema.optional(ThreadTurnStartBootstrap),
  sourceProposedPlan: Schema.optional(SourceProposedPlanReference),
  createdAt: IsoDateTime,
});

const ThreadTurnInterruptCommand = Schema.Struct({
  type: Schema.Literal("thread.turn.interrupt"),
  commandId: CommandId,
  threadId: ThreadId,
  turnId: Schema.optional(TurnId),
  createdAt: IsoDateTime,
});

const ThreadApprovalRespondCommand = Schema.Struct({
  type: Schema.Literal("thread.approval.respond"),
  commandId: CommandId,
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  decision: ProviderApprovalDecision,
  createdAt: IsoDateTime,
});

const ThreadUserInputRespondCommand = Schema.Struct({
  type: Schema.Literal("thread.user-input.respond"),
  commandId: CommandId,
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  answers: ProviderUserInputAnswers,
  createdAt: IsoDateTime,
});

const ThreadCheckpointRevertCommand = Schema.Struct({
  type: Schema.Literal("thread.checkpoint.revert"),
  commandId: CommandId,
  threadId: ThreadId,
  turnCount: NonNegativeInt,
  createdAt: IsoDateTime,
});

const ThreadSessionStopCommand = Schema.Struct({
  type: Schema.Literal("thread.session.stop"),
  commandId: CommandId,
  threadId: ThreadId,
  createdAt: IsoDateTime,
});

const DispatchableClientOrchestrationCommand = Schema.Union([
  ProjectCreateCommand,
  ProjectMetaUpdateCommand,
  ProjectDeleteCommand,
  ThreadCreateCommand,
  ThreadDeleteCommand,
  ThreadArchiveCommand,
  ThreadUnarchiveCommand,
  ThreadMetaUpdateCommand,
  ThreadRuntimeModeSetCommand,
  ThreadInteractionModeSetCommand,
  ThreadPlanningPrdCreateCommand,
  ThreadPlanningStageStartCommand,
  ThreadPlanningWorkflowLaunchCommand,
  ThreadPlanningIssueReviewRequestCommand,
  ThreadPlanningPrdBundleLoadCommand,
  ThreadImplementationRunLaunchCommand,
  ThreadImplementationChangeRequestRetryCommand,
  ThreadDevReviewLaunchCommand,
  ThreadTurnStartCommand,
  ThreadTurnInterruptCommand,
  ThreadApprovalRespondCommand,
  ThreadUserInputRespondCommand,
  ThreadCheckpointRevertCommand,
  ThreadSessionStopCommand,
]);
export type DispatchableClientOrchestrationCommand =
  typeof DispatchableClientOrchestrationCommand.Type;

export const ClientOrchestrationCommand = Schema.Union([
  ProjectCreateCommand,
  ProjectMetaUpdateCommand,
  ProjectDeleteCommand,
  ThreadCreateCommand,
  ThreadDeleteCommand,
  ThreadArchiveCommand,
  ThreadUnarchiveCommand,
  ThreadMetaUpdateCommand,
  ThreadRuntimeModeSetCommand,
  ThreadInteractionModeSetCommand,
  ThreadPlanningPrdCreateCommand,
  ThreadPlanningStageStartCommand,
  ThreadPlanningWorkflowLaunchCommand,
  ThreadPlanningIssueReviewRequestCommand,
  ThreadPlanningPrdBundleLoadCommand,
  ThreadImplementationRunLaunchCommand,
  ThreadImplementationChangeRequestRetryCommand,
  ThreadDevReviewLaunchCommand,
  ClientThreadTurnStartCommand,
  ThreadTurnInterruptCommand,
  ThreadApprovalRespondCommand,
  ThreadUserInputRespondCommand,
  ThreadCheckpointRevertCommand,
  ThreadSessionStopCommand,
]);
export type ClientOrchestrationCommand = typeof ClientOrchestrationCommand.Type;

const ThreadSessionSetCommand = Schema.Struct({
  type: Schema.Literal("thread.session.set"),
  commandId: CommandId,
  threadId: ThreadId,
  session: OrchestrationSession,
  createdAt: IsoDateTime,
});

const ThreadMessageAssistantDeltaCommand = Schema.Struct({
  type: Schema.Literal("thread.message.assistant.delta"),
  commandId: CommandId,
  threadId: ThreadId,
  messageId: MessageId,
  delta: Schema.String,
  turnId: Schema.optional(TurnId),
  createdAt: IsoDateTime,
});

const ThreadMessageAssistantCompleteCommand = Schema.Struct({
  type: Schema.Literal("thread.message.assistant.complete"),
  commandId: CommandId,
  threadId: ThreadId,
  messageId: MessageId,
  turnId: Schema.optional(TurnId),
  createdAt: IsoDateTime,
});

const ThreadProposedPlanUpsertCommand = Schema.Struct({
  type: Schema.Literal("thread.proposed-plan.upsert"),
  commandId: CommandId,
  threadId: ThreadId,
  proposedPlan: OrchestrationProposedPlan,
  createdAt: IsoDateTime,
});

const ThreadTurnDiffCompleteCommand = Schema.Struct({
  type: Schema.Literal("thread.turn.diff.complete"),
  commandId: CommandId,
  threadId: ThreadId,
  turnId: TurnId,
  completedAt: IsoDateTime,
  checkpointRef: CheckpointRef,
  status: OrchestrationCheckpointStatus,
  files: Schema.Array(OrchestrationCheckpointFile),
  assistantMessageId: Schema.optional(MessageId),
  checkpointTurnCount: NonNegativeInt,
  createdAt: IsoDateTime,
});

const ThreadActivityAppendCommand = Schema.Struct({
  type: Schema.Literal("thread.activity.append"),
  commandId: CommandId,
  threadId: ThreadId,
  activity: OrchestrationThreadActivity,
  createdAt: IsoDateTime,
});

const ThreadDevReviewUpdateCommand = Schema.Struct({
  type: Schema.Literal("thread.dev-review.update"),
  commandId: CommandId,
  threadId: ThreadId,
  reviewId: DevReviewId,
  status: Schema.optional(DevReviewRecord.fields.status),
  document: Schema.optional(DevReviewDocument),
  updatedAt: IsoDateTime,
  createdAt: IsoDateTime,
});

const ThreadDevReviewReplayMetadataUpdateCommand = Schema.Struct({
  type: Schema.Literal("thread.dev-review.replay-metadata.update"),
  commandId: CommandId,
  threadId: ThreadId,
  reviewId: DevReviewId,
  replay: DevReviewReplayMetadata,
  updatedAt: IsoDateTime,
  createdAt: IsoDateTime,
});

const ThreadRevertCompleteCommand = Schema.Struct({
  type: Schema.Literal("thread.revert.complete"),
  commandId: CommandId,
  threadId: ThreadId,
  turnCount: NonNegativeInt,
  createdAt: IsoDateTime,
});

const InternalOrchestrationCommand = Schema.Union([
  ThreadSessionSetCommand,
  ThreadMessageAssistantDeltaCommand,
  ThreadMessageAssistantCompleteCommand,
  ThreadProposedPlanUpsertCommand,
  ThreadPlanningPrdApplyCommand,
  ThreadPlanningIssuesApplyCommand,
  ThreadPlanningReviewerVerdictApplyCommand,
  ThreadPlanningWorkflowStageSetCommand,
  ThreadImplementationRunUpdateCommand,
  ThreadTurnDiffCompleteCommand,
  ThreadActivityAppendCommand,
  ThreadDevReviewUpdateCommand,
  ThreadDevReviewReplayMetadataUpdateCommand,
  ThreadRevertCompleteCommand,
]);
export type InternalOrchestrationCommand = typeof InternalOrchestrationCommand.Type;

export const OrchestrationCommand = Schema.Union([
  DispatchableClientOrchestrationCommand,
  InternalOrchestrationCommand,
]);
export type OrchestrationCommand = typeof OrchestrationCommand.Type;

export const OrchestrationEventType = Schema.Literals([
  "project.created",
  "project.meta-updated",
  "project.deleted",
  "thread.created",
  "thread.deleted",
  "thread.archived",
  "thread.unarchived",
  "thread.meta-updated",
  "thread.runtime-mode-set",
  "thread.interaction-mode-set",
  "thread.planning-stage-started",
  "thread.planning-prd-created",
  "thread.planning-issues-created",
  "thread.planning-issues-revised",
  "thread.planning-issue-review-requested",
  "thread.planning-prd-bundle-loaded",
  "thread.planning-workflow-stage-set",
  "thread.implementation-run-launched",
  "thread.implementation-run-updated",
  "thread.implementation-change-request-retry-requested",
  "thread.message-sent",
  "thread.turn-start-requested",
  "thread.turn-interrupt-requested",
  "thread.approval-response-requested",
  "thread.user-input-response-requested",
  "thread.checkpoint-revert-requested",
  "thread.reverted",
  "thread.session-stop-requested",
  "thread.session-set",
  "thread.proposed-plan-upserted",
  "thread.dev-review-created",
  "thread.dev-review-updated",
  "thread.dev-review-replay-metadata-updated",
  "thread.turn-diff-completed",
  "thread.activity-appended",
]);
export type OrchestrationEventType = typeof OrchestrationEventType.Type;

export const OrchestrationAggregateKind = Schema.Literals(["project", "thread"]);
export type OrchestrationAggregateKind = typeof OrchestrationAggregateKind.Type;
export const OrchestrationActorKind = Schema.Literals(["client", "server", "provider"]);

export const ProjectCreatedPayload = Schema.Struct({
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  repositoryIdentity: Schema.optional(Schema.NullOr(RepositoryIdentity)),
  defaultModelSelection: Schema.NullOr(ModelSelection),
  scripts: Schema.Array(ProjectScript),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const ProjectMetaUpdatedPayload = Schema.Struct({
  projectId: ProjectId,
  title: Schema.optional(TrimmedNonEmptyString),
  workspaceRoot: Schema.optional(TrimmedNonEmptyString),
  repositoryIdentity: Schema.optional(Schema.NullOr(RepositoryIdentity)),
  defaultModelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
  scripts: Schema.optional(Schema.Array(ProjectScript)),
  updatedAt: IsoDateTime,
});

export const ProjectDeletedPayload = Schema.Struct({
  projectId: ProjectId,
  deletedAt: IsoDateTime,
});

export const ThreadCreatedPayload = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  ownerUserId: WorkspaceUserId.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_WORKSPACE_USER_ID)),
  ),
  parentThreadId: Schema.optionalKey(Schema.NullOr(ThreadId)),
  workflowRole: Schema.optionalKey(Schema.NullOr(OrchestrationThreadWorkflowRole)),
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode.pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_RUNTIME_MODE))),
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE)),
  ),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const ThreadDeletedPayload = Schema.Struct({
  threadId: ThreadId,
  deletedAt: IsoDateTime,
});

export const ThreadArchivedPayload = Schema.Struct({
  threadId: ThreadId,
  archivedAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const ThreadUnarchivedPayload = Schema.Struct({
  threadId: ThreadId,
  updatedAt: IsoDateTime,
});

export const ThreadMetaUpdatedPayload = Schema.Struct({
  threadId: ThreadId,
  ownerUserId: Schema.optional(WorkspaceUserId),
  title: Schema.optional(TrimmedNonEmptyString),
  modelSelection: Schema.optional(ModelSelection),
  branch: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  worktreePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  updatedAt: IsoDateTime,
});

export const ThreadRuntimeModeSetPayload = Schema.Struct({
  threadId: ThreadId,
  runtimeMode: RuntimeMode,
  updatedAt: IsoDateTime,
});

export const ThreadInteractionModeSetPayload = Schema.Struct({
  threadId: ThreadId,
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE)),
  ),
  updatedAt: IsoDateTime,
});

export const ThreadPlanningStageStartedPayload = Schema.Struct({
  threadId: ThreadId,
  stage: OrchestrationPlanningWorkflowStage,
  startedAt: IsoDateTime,
});

export const ThreadPlanningPrdCreatedPayload = Schema.Struct({
  threadId: ThreadId,
  prd: OrchestrationPlanningPrd,
  stage: Schema.optional(OrchestrationPlanningWorkflowStage),
});

export const ThreadPlanningIssuesCreatedPayload = Schema.Struct({
  threadId: ThreadId,
  prdId: OrchestrationPlanningPrdId,
  issues: Schema.Array(OrchestrationPlanningIssue),
  stage: Schema.optional(OrchestrationPlanningWorkflowStage),
});

export const ThreadPlanningIssuesRevisedPayload = Schema.Struct({
  threadId: ThreadId,
  prdId: OrchestrationPlanningPrdId,
  reviewCycle: Schema.optional(OrchestrationPlanningReviewCycle),
  issues: Schema.Array(OrchestrationPlanningIssue),
  stage: Schema.optional(OrchestrationPlanningWorkflowStage),
  revisedAt: IsoDateTime,
});

export const ThreadPlanningIssueReviewRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  prdId: OrchestrationPlanningPrdId,
  cycleNumber: NonNegativeInt,
  reviewerThreadId: ThreadId,
  reviewerMessageId: MessageId,
  stage: Schema.Literal("issue-review"),
  requestedAt: IsoDateTime,
});

export const ThreadPlanningPrdBundleLoadedPayload = Schema.Struct({
  threadId: ThreadId,
  prdId: OrchestrationPlanningPrdId,
  sourceThreadId: ThreadId,
  bundle: Schema.optional(OrchestrationPlanningPrdBundle),
  loadedAt: IsoDateTime,
});

export const ThreadPlanningWorkflowStageSetPayload = Schema.Struct({
  threadId: ThreadId,
  stage: OrchestrationPlanningWorkflowStage,
  reasonMarkdown: Schema.optional(Schema.String),
  updatedAt: IsoDateTime,
});

export const ThreadImplementationRunLaunchedPayload = Schema.Struct({
  sourceThreadId: ThreadId,
  run: OrchestrationImplementationRun,
});

export const ThreadImplementationRunUpdatedPayload = Schema.Struct({
  sourceThreadId: ThreadId,
  run: OrchestrationImplementationRun,
});

export const ThreadImplementationChangeRequestRetryRequestedPayload = Schema.Struct({
  run: OrchestrationImplementationRun,
});

export const ThreadMessageSentPayload = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  role: OrchestrationMessageRole,
  text: Schema.String,
  attachments: Schema.optional(Schema.Array(ChatAttachment)),
  turnId: Schema.NullOr(TurnId),
  streaming: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const ThreadTurnStartRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  modelSelection: Schema.optional(ModelSelection),
  titleSeed: Schema.optional(TrimmedNonEmptyString),
  runtimeMode: RuntimeMode.pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_RUNTIME_MODE))),
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE)),
  ),
  workflowPromptId: Schema.optional(TrimmedNonEmptyString),
  sourceProposedPlan: Schema.optional(SourceProposedPlanReference),
  createdAt: IsoDateTime,
});

export const ThreadTurnInterruptRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  turnId: Schema.optional(TurnId),
  createdAt: IsoDateTime,
});

export const ThreadApprovalResponseRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  decision: ProviderApprovalDecision,
  createdAt: IsoDateTime,
});

const ThreadUserInputResponseRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  answers: ProviderUserInputAnswers,
  createdAt: IsoDateTime,
});

export const ThreadCheckpointRevertRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  turnCount: NonNegativeInt,
  createdAt: IsoDateTime,
});

export const ThreadRevertedPayload = Schema.Struct({
  threadId: ThreadId,
  turnCount: NonNegativeInt,
});

export const ThreadSessionStopRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  createdAt: IsoDateTime,
});

export const ThreadSessionSetPayload = Schema.Struct({
  threadId: ThreadId,
  session: OrchestrationSession,
});

export const ThreadProposedPlanUpsertedPayload = Schema.Struct({
  threadId: ThreadId,
  proposedPlan: OrchestrationProposedPlan,
});

export const ThreadDevReviewCreatedPayload = Schema.Struct({
  threadId: ThreadId,
  devReview: DevReviewRecord,
});

export const ThreadDevReviewUpdatedPayload = Schema.Struct({
  threadId: ThreadId,
  reviewId: DevReviewId,
  sourceThreadId: ThreadId,
  reviewThreadId: ThreadId,
  status: Schema.optional(DevReviewRecord.fields.status),
  document: Schema.optional(DevReviewDocument),
  updatedAt: IsoDateTime,
});

export const ThreadDevReviewReplayMetadataUpdatedPayload = Schema.Struct({
  threadId: ThreadId,
  reviewId: DevReviewId,
  sourceThreadId: ThreadId,
  reviewThreadId: ThreadId,
  replay: DevReviewReplayMetadata,
  updatedAt: IsoDateTime,
});

export const ThreadTurnDiffCompletedPayload = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  checkpointTurnCount: NonNegativeInt,
  checkpointRef: CheckpointRef,
  status: OrchestrationCheckpointStatus,
  files: Schema.Array(OrchestrationCheckpointFile),
  assistantMessageId: Schema.NullOr(MessageId),
  completedAt: IsoDateTime,
});

export const ThreadActivityAppendedPayload = Schema.Struct({
  threadId: ThreadId,
  activity: OrchestrationThreadActivity,
});

export const OrchestrationEventMetadata = Schema.Struct({
  providerTurnId: Schema.optional(TrimmedNonEmptyString),
  providerItemId: Schema.optional(ProviderItemId),
  adapterKey: Schema.optional(TrimmedNonEmptyString),
  requestId: Schema.optional(ApprovalRequestId),
  ingestedAt: Schema.optional(IsoDateTime),
});
export type OrchestrationEventMetadata = typeof OrchestrationEventMetadata.Type;

const EventBaseFields = {
  sequence: NonNegativeInt,
  eventId: EventId,
  aggregateKind: OrchestrationAggregateKind,
  aggregateId: Schema.Union([ProjectId, ThreadId]),
  occurredAt: IsoDateTime,
  commandId: Schema.NullOr(CommandId),
  causationEventId: Schema.NullOr(EventId),
  correlationId: Schema.NullOr(CommandId),
  metadata: OrchestrationEventMetadata,
} as const;

export const OrchestrationEvent = Schema.Union([
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("project.created"),
    payload: ProjectCreatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("project.meta-updated"),
    payload: ProjectMetaUpdatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("project.deleted"),
    payload: ProjectDeletedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.created"),
    payload: ThreadCreatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.deleted"),
    payload: ThreadDeletedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.archived"),
    payload: ThreadArchivedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.unarchived"),
    payload: ThreadUnarchivedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.meta-updated"),
    payload: ThreadMetaUpdatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.runtime-mode-set"),
    payload: ThreadRuntimeModeSetPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.interaction-mode-set"),
    payload: ThreadInteractionModeSetPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.planning-stage-started"),
    payload: ThreadPlanningStageStartedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.planning-prd-created"),
    payload: ThreadPlanningPrdCreatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.planning-issues-created"),
    payload: ThreadPlanningIssuesCreatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.planning-issues-revised"),
    payload: ThreadPlanningIssuesRevisedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.planning-issue-review-requested"),
    payload: ThreadPlanningIssueReviewRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.planning-prd-bundle-loaded"),
    payload: ThreadPlanningPrdBundleLoadedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.planning-workflow-stage-set"),
    payload: ThreadPlanningWorkflowStageSetPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.implementation-run-launched"),
    payload: ThreadImplementationRunLaunchedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.implementation-run-updated"),
    payload: ThreadImplementationRunUpdatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.implementation-change-request-retry-requested"),
    payload: ThreadImplementationChangeRequestRetryRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.message-sent"),
    payload: ThreadMessageSentPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.turn-start-requested"),
    payload: ThreadTurnStartRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.turn-interrupt-requested"),
    payload: ThreadTurnInterruptRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.approval-response-requested"),
    payload: ThreadApprovalResponseRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.user-input-response-requested"),
    payload: ThreadUserInputResponseRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.checkpoint-revert-requested"),
    payload: ThreadCheckpointRevertRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.reverted"),
    payload: ThreadRevertedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.session-stop-requested"),
    payload: ThreadSessionStopRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.session-set"),
    payload: ThreadSessionSetPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.proposed-plan-upserted"),
    payload: ThreadProposedPlanUpsertedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.dev-review-created"),
    payload: ThreadDevReviewCreatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.dev-review-updated"),
    payload: ThreadDevReviewUpdatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.dev-review-replay-metadata-updated"),
    payload: ThreadDevReviewReplayMetadataUpdatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.turn-diff-completed"),
    payload: ThreadTurnDiffCompletedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.activity-appended"),
    payload: ThreadActivityAppendedPayload,
  }),
]);
export type OrchestrationEvent = typeof OrchestrationEvent.Type;

export const OrchestrationThreadStreamItem = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("snapshot"),
    snapshot: OrchestrationThreadDetailSnapshot,
  }),
  Schema.Struct({
    kind: Schema.Literal("event"),
    event: OrchestrationEvent,
  }),
]);
export type OrchestrationThreadStreamItem = typeof OrchestrationThreadStreamItem.Type;

export const OrchestrationCommandReceiptStatus = Schema.Literals(["accepted", "rejected"]);
export type OrchestrationCommandReceiptStatus = typeof OrchestrationCommandReceiptStatus.Type;

export const TurnCountRange = Schema.Struct({
  fromTurnCount: NonNegativeInt,
  toTurnCount: NonNegativeInt,
}).check(
  Schema.makeFilter(
    (input) =>
      input.fromTurnCount <= input.toTurnCount ||
      new SchemaIssue.InvalidValue(Option.some(input.fromTurnCount), {
        message: "fromTurnCount must be less than or equal to toTurnCount",
      }),
    { identifier: "OrchestrationTurnDiffRange" },
  ),
);

export const ThreadTurnDiff = TurnCountRange.mapFields(
  Struct.assign({
    threadId: ThreadId,
    diff: Schema.String,
  }),
  { unsafePreserveChecks: true },
);

export const ProviderSessionRuntimeStatus = Schema.Literals([
  "starting",
  "running",
  "stopped",
  "error",
]);
export type ProviderSessionRuntimeStatus = typeof ProviderSessionRuntimeStatus.Type;

const ProjectionThreadTurnStatus = Schema.Literals([
  "running",
  "completed",
  "interrupted",
  "error",
]);
export type ProjectionThreadTurnStatus = typeof ProjectionThreadTurnStatus.Type;

const ProjectionCheckpointRow = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  checkpointTurnCount: NonNegativeInt,
  checkpointRef: CheckpointRef,
  status: OrchestrationCheckpointStatus,
  files: Schema.Array(OrchestrationCheckpointFile),
  assistantMessageId: Schema.NullOr(MessageId),
  completedAt: IsoDateTime,
});
export type ProjectionCheckpointRow = typeof ProjectionCheckpointRow.Type;

export const ProjectionPendingApprovalStatus = Schema.Literals(["pending", "resolved"]);
export type ProjectionPendingApprovalStatus = typeof ProjectionPendingApprovalStatus.Type;

export const ProjectionPendingApprovalDecision = Schema.NullOr(ProviderApprovalDecision);
export type ProjectionPendingApprovalDecision = typeof ProjectionPendingApprovalDecision.Type;

export const DispatchResult = Schema.Struct({
  sequence: NonNegativeInt,
});
export type DispatchResult = typeof DispatchResult.Type;

export const OrchestrationGetTurnDiffInput = TurnCountRange.mapFields(
  Struct.assign({
    threadId: ThreadId,
    ignoreWhitespace: Schema.optionalKey(Schema.Boolean),
  }),
  { unsafePreserveChecks: true },
);
export type OrchestrationGetTurnDiffInput = typeof OrchestrationGetTurnDiffInput.Type;

export const OrchestrationGetTurnDiffResult = ThreadTurnDiff;
export type OrchestrationGetTurnDiffResult = typeof OrchestrationGetTurnDiffResult.Type;

export const OrchestrationGetFullThreadDiffInput = Schema.Struct({
  threadId: ThreadId,
  toTurnCount: NonNegativeInt,
  ignoreWhitespace: Schema.optionalKey(Schema.Boolean),
});
export type OrchestrationGetFullThreadDiffInput = typeof OrchestrationGetFullThreadDiffInput.Type;

export const OrchestrationGetFullThreadDiffResult = ThreadTurnDiff;
export type OrchestrationGetFullThreadDiffResult = typeof OrchestrationGetFullThreadDiffResult.Type;

export const OrchestrationReplayEventsInput = Schema.Struct({
  fromSequenceExclusive: NonNegativeInt,
});
export type OrchestrationReplayEventsInput = typeof OrchestrationReplayEventsInput.Type;

const OrchestrationReplayEventsResult = Schema.Array(OrchestrationEvent);
export type OrchestrationReplayEventsResult = typeof OrchestrationReplayEventsResult.Type;

export const OrchestrationRpcSchemas = {
  dispatchCommand: {
    input: ClientOrchestrationCommand,
    output: DispatchResult,
  },
  getTurnDiff: {
    input: OrchestrationGetTurnDiffInput,
    output: OrchestrationGetTurnDiffResult,
  },
  getFullThreadDiff: {
    input: OrchestrationGetFullThreadDiffInput,
    output: OrchestrationGetFullThreadDiffResult,
  },
  replayEvents: {
    input: OrchestrationReplayEventsInput,
    output: OrchestrationReplayEventsResult,
  },
  getArchivedShellSnapshot: {
    input: OrchestrationGetArchivedShellSnapshotInput,
    output: OrchestrationShellSnapshot,
  },
  subscribeThread: {
    input: OrchestrationSubscribeThreadInput,
    output: OrchestrationThreadStreamItem,
  },
  subscribeShell: {
    input: OrchestrationSubscribeShellInput,
    output: OrchestrationShellStreamItem,
  },
} as const;

export class OrchestrationGetSnapshotError extends Schema.TaggedErrorClass<OrchestrationGetSnapshotError>()(
  "OrchestrationGetSnapshotError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class OrchestrationDispatchCommandError extends Schema.TaggedErrorClass<OrchestrationDispatchCommandError>()(
  "OrchestrationDispatchCommandError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class OrchestrationGetTurnDiffError extends Schema.TaggedErrorClass<OrchestrationGetTurnDiffError>()(
  "OrchestrationGetTurnDiffError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class OrchestrationGetFullThreadDiffError extends Schema.TaggedErrorClass<OrchestrationGetFullThreadDiffError>()(
  "OrchestrationGetFullThreadDiffError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class OrchestrationReplayEventsError extends Schema.TaggedErrorClass<OrchestrationReplayEventsError>()(
  "OrchestrationReplayEventsError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
