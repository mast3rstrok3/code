import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import * as SchemaTransformation from "effect/SchemaTransformation";
import * as Struct from "effect/Struct";
import { ProviderOptionSelections } from "./model.ts";
import { RepositoryIdentity, ThreadEnvMode } from "./environment.ts";
import { ChangeRequest } from "./sourceControl.ts";
import {
  APP_REVIEW_WORKFLOW_DEFAULT_CYCLES,
  AppReviewDocument,
  AppReviewEvidence,
  AppReviewId,
  AppReviewRecord,
  AppReviewWorkflowCaller,
  AppReviewWorkflowPhase,
  AppReviewWorkflowCycleBudget,
  AppReviewWorkflowRun,
  AppReviewWorkflowRunId,
  AppReviewWorkflowWorkspaceRevision,
} from "./review.ts";

export { APP_REVIEW_WORKFLOW_DEFAULT_CYCLES, APP_REVIEW_WORKFLOW_MAX_CYCLES } from "./review.ts";
export const OrchestrationAppReviewWorkflowRun = AppReviewWorkflowRun;
export type OrchestrationAppReviewWorkflowRun = AppReviewWorkflowRun;
import {
  ApprovalRequestId,
  CheckpointRef,
  CommandId,
  EventId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ProviderItemId,
  ThreadId,
  TrimmedNonEmptyString,
  TrimmedString,
  TurnId,
} from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import { DEFAULT_WORKSPACE_USER_ID, WorkspaceUserId, WorkspaceUserView } from "./workspaceUsers.ts";

export const ORCHESTRATION_WS_METHODS = {
  dispatchCommand: "orchestration.dispatchCommand",
  getWorkflowScript: "orchestration.getWorkflowScript",
  getTurnDiff: "orchestration.getTurnDiff",
  getFullThreadDiff: "orchestration.getFullThreadDiff",
  searchThreads: "orchestration.searchThreads",
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
  "auto",
  "full-access",
]);
export type RuntimeMode = typeof RuntimeMode.Type;

/**
 * Runtime mode for automated workflow phases. The human gate for workflows is
 * the grill; every stage after it runs without approval prompts regardless of
 * the mode the root thread was grilled in.
 */
export const WORKFLOW_AUTOMATION_RUNTIME_MODE: RuntimeMode = "full-access";
export const DEFAULT_RUNTIME_MODE: RuntimeMode = "full-access";
export const ProviderInteractionMode = Schema.Literals([
  "default",
  "plan",
  "planning-workflow",
  "implementation-workflow",
  "product-workflow",
]);
export type ProviderInteractionMode = typeof ProviderInteractionMode.Type;
export const DEFAULT_PROVIDER_INTERACTION_MODE: ProviderInteractionMode = "default";
export const WorkflowPreset = Schema.Literals([
  "fix",
  "fast-feature",
  "full-feature",
  "product-planning",
  "wayfinder",
  "implementation",
  "planning",
  "app-review",
]);
export type WorkflowPreset = typeof WorkflowPreset.Type;
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

export const ProjectFaviconPath = TrimmedNonEmptyString.check(
  Schema.isMaxLength(1024),
  Schema.isPattern(/\.(?:avif|gif|ico|jpe?g|png|svg|webp)$/i),
);
export type ProjectFaviconPath = typeof ProjectFaviconPath.Type;

/**
 * Which recorder captures this project's App Reviews. `auto` prefers the DOM
 * recorder and falls back to video; `video` pins the encoder for apps drawn in
 * canvas or WebGL, which the DOM recorder replays blank.
 */
export const PreviewRecordingMode = Schema.Literals(["auto", "dom", "video"]);
export type PreviewRecordingMode = typeof PreviewRecordingMode.Type;

export const OrchestrationProject = Schema.Struct({
  id: ProjectId,
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  repositoryIdentity: Schema.optional(Schema.NullOr(RepositoryIdentity)),
  defaultModelSelection: Schema.NullOr(ModelSelection),
  // Per-project override for where new threads start. Null/absent means
  // "no override": clients fall back to t3.json, then the global setting.
  defaultThreadEnvMode: Schema.optional(Schema.NullOr(ThreadEnvMode)),
  // Null/absent means "no override": the server's own recording mode applies.
  previewRecordingMode: Schema.optional(Schema.NullOr(PreviewRecordingMode)),
  // Optional on the wire so cached snapshots from older servers still decode.
  faviconPath: Schema.optional(Schema.NullOr(ProjectFaviconPath)),
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
  workflowPromptId: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
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

export const OrchestrationPlanningSpecId = TrimmedNonEmptyString;
export type OrchestrationPlanningSpecId = typeof OrchestrationPlanningSpecId.Type;

export const WorkflowId = TrimmedNonEmptyString.pipe(Schema.brand("WorkflowId"));
export type WorkflowId = typeof WorkflowId.Type;

export const ThreadWorkflowContext = Schema.Struct({
  workflowId: WorkflowId,
  // Optional so snapshots and events written before nested workflow identity
  // was introduced continue to decode. New workflow controllers write it
  // explicitly (`null` for a top-level run).
  parentWorkflowId: Schema.optional(Schema.NullOr(WorkflowId)),
  rootThreadId: ThreadId,
  ticketScope: Schema.Array(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
});
export type ThreadWorkflowContext = typeof ThreadWorkflowContext.Type;

/**
 * One workflow step pinned to an explicit provider instance and model.
 *
 * Keyed by the step's workflow prompt id — the same id the step's skill is
 * registered under — so the pin survives step reordering and applies to every
 * later spawn of that step in the run. No entry means the step stays in auto
 * mode and inherits the workflow root's selection.
 */
export const WorkflowStepModelOverride = Schema.Struct({
  workflowPromptId: TrimmedNonEmptyString,
  /**
   * The step this pin is scoped to, when the pin targets one sub-step rather
   * than a whole step. A step starts several kinds of agent and the same agent
   * prompt appears under more than one step — a per-ticket Code Review runs
   * inside "Execute ticket waves" and again as the final Code Review — so only
   * the pair identifies a sub-step. Absent means the pin covers the step named
   * by `workflowPromptId` and every agent it starts.
   */
  stepWorkflowPromptId: Schema.optionalKey(TrimmedNonEmptyString),
  modelSelection: ModelSelection,
});
export type WorkflowStepModelOverride = typeof WorkflowStepModelOverride.Type;

/**
 * How many times one workflow step repeats before the run moves on.
 *
 * Only steps that loop can carry one — App Review reviews, plans a repair and
 * fixes until it passes; Planning ticket review revises until the reviewer is
 * satisfied. `workflowStepCycles` in `@t3tools/shared/workflowStepCycles` is
 * the catalog of which steps those are and what each one's ceiling is.
 *
 * Keyed exactly like a model pin, so the same (step, sub-step) pair addresses
 * both: a ticket App Review and the final App Review run the same agent under
 * different steps and get separate budgets.
 */
export const WorkflowStepCycleOverride = Schema.Struct({
  workflowPromptId: TrimmedNonEmptyString,
  /** Set when the budget targets one sub-step of a step rather than the step. */
  stepWorkflowPromptId: Schema.optionalKey(TrimmedNonEmptyString),
  maxCycles: PositiveInt,
});
export type WorkflowStepCycleOverride = typeof WorkflowStepCycleOverride.Type;

export const OrchestrationPlanningSpec = Schema.Struct({
  id: OrchestrationPlanningSpecId,
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
  workflowId: WorkflowId,
  ticketCount: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OrchestrationPlanningSpec = typeof OrchestrationPlanningSpec.Type;

export const OrchestrationPlanningTicketId = TrimmedNonEmptyString;
export type OrchestrationPlanningTicketId = typeof OrchestrationPlanningTicketId.Type;

export const OrchestrationPlanningTicketKey = TrimmedNonEmptyString;
export type OrchestrationPlanningTicketKey = typeof OrchestrationPlanningTicketKey.Type;

export const OrchestrationPlanningFileChangeAction = Schema.Literals([
  "create",
  "update",
  "delete",
]);
export type OrchestrationPlanningFileChangeAction =
  typeof OrchestrationPlanningFileChangeAction.Type;

export const OrchestrationPlanningFileChange = Schema.Struct({
  path: TrimmedNonEmptyString,
  action: OrchestrationPlanningFileChangeAction,
});
export type OrchestrationPlanningFileChange = typeof OrchestrationPlanningFileChange.Type;

export const NonEmptyOrchestrationPlanningFileChanges = Schema.Array(
  OrchestrationPlanningFileChange,
).check(Schema.isMinLength(1));

export const OrchestrationPlanningTicketDependency = Schema.Struct({
  specId: OrchestrationPlanningSpecId,
  ticketId: OrchestrationPlanningTicketId,
});
export type OrchestrationPlanningTicketDependency =
  typeof OrchestrationPlanningTicketDependency.Type;

export const OrchestrationPlanningTicket = Schema.Struct({
  id: OrchestrationPlanningTicketId,
  key: Schema.optionalKey(OrchestrationPlanningTicketKey),
  specId: OrchestrationPlanningSpecId,
  ordinal: NonNegativeInt,
  title: TrimmedNonEmptyString,
  bodyMarkdown: TrimmedNonEmptyString,
  plannedFileChanges: Schema.Array(OrchestrationPlanningFileChange).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  dependencies: Schema.Array(OrchestrationPlanningTicketDependency).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  appReviewEligible: Schema.optionalKey(Schema.Boolean),
  appReviewPlanMarkdown: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
  status: TrimmedNonEmptyString.pipe(Schema.withDecodingDefault(Effect.succeed("open"))),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OrchestrationPlanningTicket = typeof OrchestrationPlanningTicket.Type;

export const OrchestrationPlanningReviewTicketFeedback = Schema.Struct({
  ticketId: OrchestrationPlanningTicketId,
  passed: Schema.Boolean,
  feedbackMarkdown: Schema.String,
});
export type OrchestrationPlanningReviewTicketFeedback =
  typeof OrchestrationPlanningReviewTicketFeedback.Type;

/**
 * Ticket review and revision cycles a Planning run does before it gives up and
 * completes with warnings. A per-step cycle budget raises or lowers it for one
 * run; `PLANNING_REVIEW_MAX_CYCLES` is the ceiling no budget can pass.
 */
export const PLANNING_REVIEW_DEFAULT_CYCLES = 5;
export const PLANNING_REVIEW_MAX_CYCLES = 20;

export const OrchestrationPlanningReviewMode = Schema.Literals(["full", "targeted"]);
export type OrchestrationPlanningReviewMode = typeof OrchestrationPlanningReviewMode.Type;

export const OrchestrationPlanningReviewCycleStatus = Schema.Literals([
  "passed",
  "failed",
  "revised",
  "runtime-failed",
]);
export type OrchestrationPlanningReviewCycleStatus =
  typeof OrchestrationPlanningReviewCycleStatus.Type;

export const OrchestrationPlanningReviewCycle = Schema.Struct({
  cycleNumber: NonNegativeInt,
  mode: OrchestrationPlanningReviewMode.pipe(
    Schema.withDecodingDefault(Effect.succeed("full" as const)),
  ),
  status: OrchestrationPlanningReviewCycleStatus,
  reviewerThreadId: ThreadId,
  reviewerMessageId: MessageId,
  verdictMarkdown: Schema.String,
  failingPlanningTicketIds: Schema.Array(OrchestrationPlanningTicketId).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  targetPlanningTicketIds: Schema.Array(OrchestrationPlanningTicketId).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  editedPlanningTicketIds: Schema.Array(OrchestrationPlanningTicketId).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  dependencyFeedback: Schema.Array(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  perTicketFeedback: Schema.Array(OrchestrationPlanningReviewTicketFeedback).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  createdAt: IsoDateTime,
});
export type OrchestrationPlanningReviewCycle = typeof OrchestrationPlanningReviewCycle.Type;

export const OrchestrationPlanningWorkflowStage = Schema.Literals([
  "grill",
  "spec-authoring",
  "tickets-authoring",
  "ticket-review",
  "ticket-revision",
  "completed",
  "completed-with-warnings",
  "needs-human-attention",
]);
export type OrchestrationPlanningWorkflowStage = typeof OrchestrationPlanningWorkflowStage.Type;

export const OrchestrationPlanningActiveReviewRequest = Schema.Struct({
  cycleNumber: NonNegativeInt,
  mode: OrchestrationPlanningReviewMode,
  reviewerThreadId: ThreadId,
  targetPlanningTicketIds: Schema.Array(OrchestrationPlanningTicketId),
  requestedAt: IsoDateTime,
});
export type OrchestrationPlanningActiveReviewRequest =
  typeof OrchestrationPlanningActiveReviewRequest.Type;

export const OrchestrationPlanningWorkflow = Schema.Struct({
  stage: OrchestrationPlanningWorkflowStage,
  createTicketsAvailable: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  spec: Schema.NullOr(OrchestrationPlanningSpec),
  wayfinderMap: Schema.optionalKey(Schema.NullOr(OrchestrationPlanningSpec)),
  tickets: Schema.Array(OrchestrationPlanningTicket).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  reviewCycles: Schema.Array(OrchestrationPlanningReviewCycle).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  activeReview: Schema.optionalKey(Schema.NullOr(OrchestrationPlanningActiveReviewRequest)),
});
export type OrchestrationPlanningWorkflow = typeof OrchestrationPlanningWorkflow.Type;

export const OrchestrationPlanningSpecBundle = Schema.Struct({
  spec: OrchestrationPlanningSpec,
  tickets: Schema.Array(OrchestrationPlanningTicket).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  reviewCycles: Schema.Array(OrchestrationPlanningReviewCycle).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
});
export type OrchestrationPlanningSpecBundle = typeof OrchestrationPlanningSpecBundle.Type;

/** Maximum number of fresh automated AppDevStack/App Review repair agents per run. */
export const IMPLEMENTATION_RUN_MAX_QA_REPAIRS = 10;
/** Maximum number of fresh nested App Review runs launched after consecutive blocked outcomes. */
export const IMPLEMENTATION_RUN_MAX_APP_REVIEW_UNBLOCK_ATTEMPTS = 3;
/** Maximum number of complete Code Review and final-validation cycles before WIP publication. */
export const IMPLEMENTATION_RUN_MAX_REVIEW_GATE_CYCLES = 3;
/** @deprecated Use IMPLEMENTATION_RUN_MAX_QA_REPAIRS. */
export const IMPLEMENTATION_RUN_MAX_QA_CYCLES = IMPLEMENTATION_RUN_MAX_QA_REPAIRS;
/** @deprecated Use IMPLEMENTATION_RUN_MAX_QA_REPAIRS. */
export const IMPLEMENTATION_RUN_MAX_QA_ATTEMPTS = IMPLEMENTATION_RUN_MAX_QA_REPAIRS;

export const OrchestrationImplementationRunId = TrimmedNonEmptyString;
export type OrchestrationImplementationRunId = typeof OrchestrationImplementationRunId.Type;

export const SourceProposedPlanReference = Schema.Struct({
  threadId: ThreadId,
  planId: OrchestrationProposedPlanId,
});
export type SourceProposedPlanReference = typeof SourceProposedPlanReference.Type;

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
  "code-reviewing",
  "code-review-fixing",
  "publishing-change-request",
  "babysitting-change-request",
  "needs-human-attention",
  "completed",
  "canceled",
]);
export type OrchestrationImplementationRunStatus = typeof OrchestrationImplementationRunStatus.Type;

export const OrchestrationImplementationArtifactSource = Schema.Literals([
  "planning-spec",
  "proposed-plan",
]);
export type OrchestrationImplementationArtifactSource =
  typeof OrchestrationImplementationArtifactSource.Type;

export const OrchestrationImplementationRetryableFailure = Schema.Struct({
  stage: Schema.Literals([
    "source-dirty",
    "worktree-setup",
    "worker-setup",
    "worker-execution",
    "integration",
    "merge-gate",
    "app-dev-stack",
    "app-review",
    "code-review",
    "fixer",
    "build",
    "change-request",
  ]),
  detail: TrimmedNonEmptyString,
  failedAt: IsoDateTime,
  attemptCount: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(1))),
  maxAttempts: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(3))),
  // Set by the blocking call site, not derived from `stage`: `worktree-setup` covers
  // both a conflicting worktree (human must act) and a generic retry failure (transient).
  // The automatic recovery sweep skips human-blocked failures so their attempt budget
  // survives until the human can actually clear the condition.
  humanBlocked: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
});
export type OrchestrationImplementationRetryableFailure =
  typeof OrchestrationImplementationRetryableFailure.Type;

export const OrchestrationImplementationDependencyEdge = Schema.Struct({
  blockingTicketId: OrchestrationPlanningTicketId,
  dependentTicketId: OrchestrationPlanningTicketId,
});
export type OrchestrationImplementationDependencyEdge =
  typeof OrchestrationImplementationDependencyEdge.Type;

export const OrchestrationImplementationPlannedWorker = Schema.Struct({
  ticketId: OrchestrationPlanningTicketId,
  dependencyTicketIds: Schema.Array(OrchestrationPlanningTicketId).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  branch: TrimmedNonEmptyString,
  worktreePath: TrimmedNonEmptyString,
});
export type OrchestrationImplementationPlannedWorker =
  typeof OrchestrationImplementationPlannedWorker.Type;

export const OrchestrationImplementationFinalAppReviewPlan = Schema.Struct({
  required: Schema.Boolean,
  completionBlocking: Schema.Literal(true).pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  appDevStackSource: Schema.Literal("orchestrator-worktree"),
  autoStartAppDevStack: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  browserMcpProfile: Schema.Literal("agent-browser").pipe(
    Schema.withDecodingDefault(Effect.succeed("agent-browser" as const)),
  ),
  maxCycles: NonNegativeInt.pipe(
    Schema.withDecodingDefault(Effect.succeed(IMPLEMENTATION_RUN_MAX_QA_REPAIRS)),
  ),
});
export type OrchestrationImplementationFinalAppReviewPlan =
  typeof OrchestrationImplementationFinalAppReviewPlan.Type;

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
  agentBrowserPackage: TrimmedNonEmptyString.pipe(
    Schema.withDecodingDefault(Effect.succeed("agent-browser@0.31.1")),
  ),
  lastErrorMarkdown: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  checkedAt: IsoDateTime.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
});
export type OrchestrationImplementationQaToolingState =
  typeof OrchestrationImplementationQaToolingState.Type;

export const OrchestrationImplementationLaunchSummary = Schema.Struct({
  specId: Schema.NullOr(OrchestrationPlanningSpecId),
  planningTicketIds: Schema.Array(OrchestrationPlanningTicketId),
  baseBranch: TrimmedNonEmptyString,
  pinnedCommit: TrimmedNonEmptyString,
  orchestratorBranch: TrimmedNonEmptyString,
  orchestratorWorktreePath: TrimmedNonEmptyString,
  dependencyEdges: Schema.Array(OrchestrationImplementationDependencyEdge).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  initialReadyTicketIds: Schema.Array(OrchestrationPlanningTicketId).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  plannedWorkers: Schema.Array(OrchestrationImplementationPlannedWorker).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  validationCommands: Schema.Array(TrimmedNonEmptyString),
  finalAppReview: OrchestrationImplementationFinalAppReviewPlan.pipe(
    Schema.withDecodingDefault(
      Effect.succeed({
        required: true,
        completionBlocking: true,
        appDevStackSource: "orchestrator-worktree" as const,
        autoStartAppDevStack: true,
        browserMcpProfile: "agent-browser" as const,
        maxCycles: IMPLEMENTATION_RUN_MAX_QA_REPAIRS,
      }),
    ),
  ),
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

export const OrchestrationImplementationFastBuildResult = Schema.Union([
  Schema.Struct({
    runId: OrchestrationImplementationRunId,
    status: Schema.Literal("succeeded"),
    commitSha: TrimmedNonEmptyString,
    validations: Schema.Array(OrchestrationImplementationValidationResult),
    notesMarkdown: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  }),
  Schema.Struct({
    runId: OrchestrationImplementationRunId,
    status: Schema.Literals(["failed", "blocked"]),
    commitSha: Schema.NullOr(TrimmedNonEmptyString).pipe(
      Schema.withDecodingDefault(Effect.succeed(null)),
    ),
    validations: Schema.Array(OrchestrationImplementationValidationResult).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
    ),
    notesMarkdown: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  }),
]);
export type OrchestrationImplementationFastBuildResult =
  typeof OrchestrationImplementationFastBuildResult.Type;

export const OrchestrationImplementationAppReviewEvidence = Schema.Struct({
  label: TrimmedNonEmptyString,
  value: Schema.String,
});
export type OrchestrationImplementationAppReviewEvidence =
  typeof OrchestrationImplementationAppReviewEvidence.Type;

export const OrchestrationImplementationAppReviewVerdict = Schema.Literals(["pass", "fail"]);
export type OrchestrationImplementationAppReviewVerdict =
  typeof OrchestrationImplementationAppReviewVerdict.Type;

export const OrchestrationImplementationAppReviewDocument = Schema.Struct({
  kind: Schema.Literal("react-document-preset"),
  preset: Schema.Literal("implementation-app-review"),
  version: Schema.Literal(1),
  verdict: OrchestrationImplementationAppReviewVerdict,
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
  tickets: Schema.Array(
    Schema.Struct({
      severity: Schema.Literals(["blocker", "major", "minor"]),
      title: TrimmedNonEmptyString,
      reproductionSteps: Schema.Array(TrimmedNonEmptyString).pipe(
        Schema.withDecodingDefault(Effect.succeed([])),
      ),
      expectedMarkdown: Schema.String,
      actualMarkdown: Schema.String,
      suggestedFixMarkdown: Schema.String,
      impactedTicketIds: Schema.Array(OrchestrationPlanningTicketId).pipe(
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
export type OrchestrationImplementationAppReviewDocument =
  typeof OrchestrationImplementationAppReviewDocument.Type;

export const OrchestrationImplementationAppReviewArtifact = Schema.Struct({
  id: TrimmedNonEmptyString,
  runId: OrchestrationImplementationRunId,
  reviewerThreadId: ThreadId,
  verdict: OrchestrationImplementationAppReviewVerdict,
  appReviewMarkdown: Schema.String,
  document: Schema.optionalKey(OrchestrationImplementationAppReviewDocument),
  featureUrl: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
  evidence: Schema.Array(OrchestrationImplementationAppReviewEvidence).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  createdAt: IsoDateTime,
});
export type OrchestrationImplementationAppReviewArtifact =
  typeof OrchestrationImplementationAppReviewArtifact.Type;

export const OrchestrationImplementationQaFailure = Schema.Struct({
  kind: Schema.Literals(["app-dev-stack", "app-review"]),
  status: TrimmedNonEmptyString,
  detailMarkdown: Schema.String,
  reviewId: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  headSha: TrimmedNonEmptyString,
  occurredAt: IsoDateTime,
});
export type OrchestrationImplementationQaFailure = typeof OrchestrationImplementationQaFailure.Type;

const OrchestrationImplementationWorkerResultBase = {
  ticketId: OrchestrationPlanningTicketId,
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

export const OrchestrationImplementationTicketStateStatus = Schema.Literals([
  "blocked",
  "ready",
  "running",
  "app-reviewing",
  "code-reviewing",
  "succeeded",
  "failed",
]);
export type OrchestrationImplementationTicketStateStatus =
  typeof OrchestrationImplementationTicketStateStatus.Type;

export const OrchestrationImplementationTicketState = Schema.Struct({
  ticketId: OrchestrationPlanningTicketId,
  status: OrchestrationImplementationTicketStateStatus,
  dependencyTicketIds: Schema.Array(OrchestrationPlanningTicketId).pipe(
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
  appReviewWorkflowRunId: Schema.optionalKey(Schema.NullOr(AppReviewWorkflowRunId)),
  appReviewOutcome: Schema.optionalKey(
    Schema.NullOr(Schema.Literals(["passed", "failed", "exhausted", "skipped"])),
  ),
  codeReviewThreadId: Schema.optionalKey(Schema.NullOr(ThreadId)),
  codeReviewOutcome: Schema.optionalKey(
    Schema.NullOr(Schema.Literals(["clean", "findings", "blocked"])),
  ),
  warningMarkdown: Schema.optionalKey(Schema.NullOr(Schema.String)),
  attemptCount: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  updatedAt: IsoDateTime,
});
export type OrchestrationImplementationTicketState =
  typeof OrchestrationImplementationTicketState.Type;

/** The stages of one ticket a user can start again from the Workflows panel. */
export const OrchestrationImplementationRerunTicketStage = Schema.Literals([
  "implementation",
  "app-review",
  "code-review",
]);
export type OrchestrationImplementationRerunTicketStage =
  typeof OrchestrationImplementationRerunTicketStage.Type;

/** The run-wide stages a user can start again once the run has reached them. */
export const OrchestrationImplementationRerunRunStage = Schema.Literals([
  "integration",
  "merge-gate",
  "app-review",
  "code-review",
]);
export type OrchestrationImplementationRerunRunStage =
  typeof OrchestrationImplementationRerunRunStage.Type;

/**
 * What the run is told not to do.
 *
 * A skip is a standing decision rather than a state, so it survives the stage
 * being reached and can be taken back. Omitting `stage` skips the whole ticket:
 * it keeps its place in the dependency graph and its branch, so what depends on
 * it still builds on it, and simply carries no work of its own.
 */
export const OrchestrationImplementationSkipTarget = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("ticket"),
    ticketId: OrchestrationPlanningTicketId,
    stage: Schema.optionalKey(OrchestrationImplementationRerunTicketStage),
  }),
  Schema.Struct({
    kind: Schema.Literal("run"),
    stage: OrchestrationImplementationRerunRunStage,
  }),
]);
export type OrchestrationImplementationSkipTarget =
  typeof OrchestrationImplementationSkipTarget.Type;

/**
 * What a re-run starts again.
 *
 * A ticket target rewinds one ticket to the named stage and leaves its siblings
 * alone; a run target re-enters a stage the whole run shares. Either way the
 * stage runs in a fresh thread, so the previous attempt stays readable.
 */
export const OrchestrationImplementationRerunTarget = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("ticket"),
    ticketId: OrchestrationPlanningTicketId,
    stage: OrchestrationImplementationRerunTicketStage,
  }),
  Schema.Struct({
    kind: Schema.Literal("run"),
    stage: OrchestrationImplementationRerunRunStage,
  }),
]);
export type OrchestrationImplementationRerunTarget =
  typeof OrchestrationImplementationRerunTarget.Type;

export const OrchestrationImplementationRun = Schema.Struct({
  id: OrchestrationImplementationRunId,
  artifactSource: OrchestrationImplementationArtifactSource.pipe(
    Schema.withDecodingDefault(Effect.succeed("planning-spec" as const)),
  ),
  specId: Schema.NullOr(OrchestrationPlanningSpecId),
  sourceProposedPlan: Schema.NullOr(SourceProposedPlanReference).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  planningTicketIds: Schema.Array(OrchestrationPlanningTicketId),
  orchestratorThreadId: ThreadId,
  status: OrchestrationImplementationRunStatus.pipe(
    Schema.withDecodingDefault(Effect.succeed("launch-pending" as const)),
  ),
  baseBranch: TrimmedNonEmptyString,
  pinnedCommit: TrimmedNonEmptyString,
  orchestratorBranch: TrimmedNonEmptyString,
  orchestratorWorktreePath: TrimmedNonEmptyString,
  launchSummary: OrchestrationImplementationLaunchSummary,
  ticketStates: Schema.Array(OrchestrationImplementationTicketState).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  workerResults: Schema.Array(OrchestrationImplementationWorkerResult).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  terminalLineageTicketIds: Schema.Array(OrchestrationPlanningTicketId).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  /** Stages the run has been told to pass over. Empty on runs recorded before skips existed. */
  skips: Schema.Array(OrchestrationImplementationSkipTarget).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  integrationHeadSha: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  finalValidation: Schema.NullOr(OrchestrationImplementationValidationResult).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  finalValidationResults: Schema.Array(OrchestrationImplementationValidationResult).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  validatedHeadSha: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  activeValidationHeadSha: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  activeValidationKind: Schema.NullOr(Schema.Literals(["integration", "final"])).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  activeValidatorThreadId: Schema.NullOr(ThreadId).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  mergeGateAttemptCount: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
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
        agentBrowserPackage: "agent-browser@0.31.1",
        lastErrorMarkdown: null,
        checkedAt: "",
      }),
    ),
  ),
  appReviewIds: Schema.Array(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  appReviewStrategy: Schema.Literals(["legacy-inline", "nested-workflow"]).pipe(
    Schema.withDecodingDefault(Effect.succeed("legacy-inline" as const)),
  ),
  appReviewWorkflowRunIds: Schema.Array(AppReviewWorkflowRunId).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  latestAppReviewWorkflowOutcome: Schema.NullOr(
    Schema.Literals(["passed", "failed", "exhausted"]),
  ).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  appReviewUnblockAttemptCount: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  appReviews: Schema.Array(OrchestrationImplementationAppReviewArtifact).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  appReviewedHeadSha: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  activeAppReviewHeadSha: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  activeAppReviewThreadId: Schema.NullOr(ThreadId).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  // Wire-compatible legacy name: this counts consumed fresh QA repair-agent slots.
  qaCycleCount: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  qaAttemptCount: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  qaExhaustedAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  qaExhaustionReason: Schema.NullOr(Schema.Literals(["app-dev-stack", "app-review"])).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  lastQaFailure: Schema.NullOr(OrchestrationImplementationQaFailure).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  // Set when automated QA used every allowed repair without passing. The run still continues to
  // Code Review and change-request publication; the unpassed review is surfaced instead of blocking.
  appReviewExhaustedAt: Schema.NullOr(IsoDateTime).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  codeReviewedHeadSha: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  activeCodeReviewHeadSha: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  activeCodeReviewThreadId: Schema.NullOr(ThreadId).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  activeChangeRequestBabysitterThreadId: Schema.NullOr(ThreadId).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  codeReviewAttemptCount: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  reviewGateExhaustedAt: Schema.NullOr(IsoDateTime).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  reviewGateExhaustionReason: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  activeFixerThreadId: Schema.NullOr(ThreadId).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  fixOrigin: Schema.NullOr(
    Schema.Literals(["merge-gate", "app-dev-stack", "app-review", "code-review"]),
  ).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  latestCodeReviewReportMarkdown: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
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
  fastBuildResult: Schema.NullOr(OrchestrationImplementationFastBuildResult).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  retryableFailure: Schema.NullOr(OrchestrationImplementationRetryableFailure).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OrchestrationImplementationRun = typeof OrchestrationImplementationRun.Type;

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
  "implementation-code-reviewer",
  "implementation-change-request-babysitter",
  "product-fix-implementer",
  "fast-feature-implementer",
  "app-review-orchestrator",
  "app-review-reviewer",
  "app-review-planner",
  "app-review-fixer",
]);
export type OrchestrationThreadWorkflowRole = typeof OrchestrationThreadWorkflowRole.Type;

export const WorkflowSubagentBatchId = TrimmedNonEmptyString.pipe(
  Schema.brand("WorkflowSubagentBatchId"),
);
export type WorkflowSubagentBatchId = typeof WorkflowSubagentBatchId.Type;

export const WorkflowSubagentAppReviewMode = Schema.Literals(["feedback", "full"]);
export type WorkflowSubagentAppReviewMode = typeof WorkflowSubagentAppReviewMode.Type;

export const OrchestrationWorkflowSubagentBatchChildStatus = Schema.Literals([
  "pending",
  "running",
  "completed",
  "blocked",
  "rejected",
  "failed",
  "canceled",
]);
export type OrchestrationWorkflowSubagentBatchChildStatus =
  typeof OrchestrationWorkflowSubagentBatchChildStatus.Type;

export const OrchestrationWorkflowSubagentBatchStatus = Schema.Literals([
  "launching",
  "running",
  "completed",
]);
export type OrchestrationWorkflowSubagentBatchStatus =
  typeof OrchestrationWorkflowSubagentBatchStatus.Type;

export const OrchestrationWorkflowSubagentBatchChild = Schema.Struct({
  index: NonNegativeInt,
  workflowPromptId: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  expectedResult: TrimmedNonEmptyString,
  appReviewMode: Schema.NullOr(WorkflowSubagentAppReviewMode).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  childThreadId: Schema.NullOr(ThreadId).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  appReviewId: Schema.NullOr(AppReviewId).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  status: OrchestrationWorkflowSubagentBatchChildStatus,
  resultMarkdown: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  failureDetail: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  createdAt: IsoDateTime,
  completedAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
});
export type OrchestrationWorkflowSubagentBatchChild =
  typeof OrchestrationWorkflowSubagentBatchChild.Type;

export const OrchestrationWorkflowSubagentBatch = Schema.Struct({
  id: WorkflowSubagentBatchId,
  parentThreadId: ThreadId,
  sourceAssistantMessageId: MessageId,
  status: OrchestrationWorkflowSubagentBatchStatus,
  children: Schema.Array(OrchestrationWorkflowSubagentBatchChild),
  createdAt: IsoDateTime,
  completedAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
});
export type OrchestrationWorkflowSubagentBatch = typeof OrchestrationWorkflowSubagentBatch.Type;

export const WorkflowSubagentBatchProvenance = Schema.Struct({
  batchId: WorkflowSubagentBatchId,
  childIndex: NonNegativeInt,
});
export type WorkflowSubagentBatchProvenance = typeof WorkflowSubagentBatchProvenance.Type;

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

export const ThreadTitleRegeneration = Schema.Struct({
  requestId: CommandId,
  startedAt: IsoDateTime,
});
export type ThreadTitleRegeneration = typeof ThreadTitleRegeneration.Type;

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
  workflowContext: Schema.optionalKey(Schema.NullOr(ThreadWorkflowContext)),
  workflowSubagentBatchProvenance: Schema.optionalKey(
    Schema.NullOr(WorkflowSubagentBatchProvenance),
  ),
  /**
   * Per-step model pins for the workflow rooted at this thread. Only workflow
   * root threads carry entries; every other thread omits the key.
   */
  workflowStepModels: Schema.optionalKey(Schema.Array(WorkflowStepModelOverride)),
  /**
   * Per-step cycle budgets for the workflow rooted at this thread. Like the
   * model pins, only workflow root threads carry entries.
   */
  workflowStepCycles: Schema.optionalKey(Schema.Array(WorkflowStepCycleOverride)),
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE)),
  ),
  workflowPreset: Schema.optionalKey(Schema.NullOr(WorkflowPreset)),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  latestTurn: Schema.NullOr(OrchestrationLatestTurn),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  settledOverride: Schema.NullOr(Schema.Literals(["settled", "active"])).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  settledAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  // A workflow pause is its own fact, not a settle. Settling parks a thread in
  // the inbox and any real activity clears it again; a pause has to survive
  // exactly that, because the agents it stopped keep writing for a while after
  // the click. Set on the scope the user stopped, read through ancestors.
  // Optional so payloads from pre-pause servers still decode.
  workflowPausedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  // Snooze is an overlay on the active lifecycle, not a fourth destination:
  // a snoozed thread stays "active" in the model and is only suppressed from
  // the inbox until snoozedUntil passes (or the thread raises its hand).
  // Optional so payloads from pre-snooze servers still decode.
  snoozedUntil: Schema.optional(Schema.NullOr(IsoDateTime)),
  snoozedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  // A pin overrides the settled/snoozed lifecycle: while pinnedAt is set the
  // thread renders in the pinned block and never classifies into a shelf.
  // Optional so payloads from pre-pinning servers still decode.
  pinnedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  // Fractional index for user-arranged pinned order. Keyed threads sort by
  // string comparison ahead of keyless ones (which keep creation order), so
  // servers never need each other's threads to agree on the merged list.
  // Optional so payloads from pre-reorder servers still decode.
  pinOrderKey: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  // Pending-only state. Optional so older servers remain compatible.
  titleRegeneration: Schema.optional(Schema.NullOr(ThreadTitleRegeneration)),
  deletedAt: Schema.NullOr(IsoDateTime),
  messages: Schema.Array(OrchestrationMessage),
  proposedPlans: Schema.Array(OrchestrationProposedPlan).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  planningWorkflow: Schema.NullOr(OrchestrationPlanningWorkflow).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  appReviews: Schema.Array(AppReviewRecord).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  workflowSubagentBatches: Schema.optionalKey(Schema.Array(OrchestrationWorkflowSubagentBatch)),
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
  appReviewWorkflowRuns: Schema.optionalKey(Schema.Array(AppReviewWorkflowRun)),
  updatedAt: IsoDateTime,
});
export type OrchestrationReadModel = typeof OrchestrationReadModel.Type;

export const OrchestrationProjectShell = Schema.Struct({
  id: ProjectId,
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  repositoryIdentity: Schema.optional(Schema.NullOr(RepositoryIdentity)),
  defaultModelSelection: Schema.NullOr(ModelSelection),
  defaultThreadEnvMode: Schema.optional(Schema.NullOr(ThreadEnvMode)),
  previewRecordingMode: Schema.optional(Schema.NullOr(PreviewRecordingMode)),
  // Optional on the wire so cached snapshots from older servers still decode.
  faviconPath: Schema.optional(Schema.NullOr(ProjectFaviconPath)),
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
  workflowContext: Schema.optionalKey(Schema.NullOr(ThreadWorkflowContext)),
  workflowSubagentBatchProvenance: Schema.optionalKey(
    Schema.NullOr(WorkflowSubagentBatchProvenance),
  ),
  /**
   * Per-step model pins for the workflow rooted at this thread. Only workflow
   * root threads carry entries; every other thread omits the key.
   */
  workflowStepModels: Schema.optionalKey(Schema.Array(WorkflowStepModelOverride)),
  /**
   * Per-step cycle budgets for the workflow rooted at this thread. Like the
   * model pins, only workflow root threads carry entries.
   */
  workflowStepCycles: Schema.optionalKey(Schema.Array(WorkflowStepCycleOverride)),
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE)),
  ),
  workflowPreset: Schema.optionalKey(Schema.NullOr(WorkflowPreset)),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  latestTurn: Schema.NullOr(OrchestrationLatestTurn),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  settledOverride: Schema.NullOr(Schema.Literals(["settled", "active"])).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  settledAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  workflowPausedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  snoozedUntil: Schema.optional(Schema.NullOr(IsoDateTime)),
  snoozedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  pinnedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  pinOrderKey: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  titleRegeneration: Schema.optional(Schema.NullOr(ThreadTitleRegeneration)),
  session: Schema.NullOr(OrchestrationSession),
  latestUserMessageAt: Schema.NullOr(IsoDateTime),
  hasPendingApprovals: Schema.Boolean,
  hasPendingUserInput: Schema.Boolean,
  hasActionableProposedPlan: Schema.Boolean,
  planningWorkflowSummary: Schema.optionalKey(
    Schema.Struct({
      stage: OrchestrationPlanningWorkflowStage,
      specId: Schema.NullOr(OrchestrationPlanningSpecId),
      specTitle: Schema.optional(TrimmedNonEmptyString),
      specSourceThreadId: Schema.optional(ThreadId),
      specWorkflowId: Schema.optional(TrimmedNonEmptyString),
      specTicketCount: Schema.optional(NonNegativeInt),
      specCreatedAt: Schema.optional(IsoDateTime),
      specUpdatedAt: Schema.optional(IsoDateTime),
    }),
  ),
  /**
   * Native background work alive after the turn settles: "working" while
   * subagents/workflows run, "monitoring" when watch loops are the only
   * live work. Optional so old servers/clients interop; absent = none.
   */
  backgroundLiveness: Schema.optional(Schema.NullOr(Schema.Literals(["working", "monitoring"]))),
  /**
   * Current plan step while a turn runs, for the Working indicators
   * (sidebar row, in-chat working line). Cleared when the turn settles —
   * never persists as stale UI. Optional so old servers/clients interop.
   */
  planProgress: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        step: TrimmedNonEmptyString,
        completedSteps: NonNegativeInt,
        totalSteps: NonNegativeInt,
      }),
    ),
  ),
});
export type OrchestrationThreadShell = typeof OrchestrationThreadShell.Type;

export const OrchestrationShellSnapshot = Schema.Struct({
  snapshotSequence: NonNegativeInt,
  projects: Schema.Array(OrchestrationProjectShell),
  threads: Schema.Array(OrchestrationThreadShell),
  implementationRuns: Schema.optionalKey(Schema.Array(OrchestrationImplementationRun)),
  appReviewWorkflowRuns: Schema.optionalKey(Schema.Array(AppReviewWorkflowRun)),
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
  Schema.Struct({
    kind: Schema.Literal("app-review-workflow-run-upserted"),
    sequence: NonNegativeInt,
    run: AppReviewWorkflowRun,
  }),
]);
export type OrchestrationShellStreamEvent = typeof OrchestrationShellStreamEvent.Type;

export const OrchestrationShellStreamItem = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("synchronized"),
  }),
  Schema.Struct({
    kind: Schema.Literal("snapshot"),
    snapshot: OrchestrationShellSnapshot,
  }),
  OrchestrationShellStreamEvent,
]);
export type OrchestrationShellStreamItem = typeof OrchestrationShellStreamItem.Type;

export const OrchestrationSubscribeShellInput = Schema.Struct({
  userView: Schema.optionalKey(WorkspaceUserView),
  /**
   * When provided, the server skips the initial full shell snapshot and instead
   * replays shell events after this sequence before streaming live events.
   * Clients that already hold a cached (or HTTP-loaded) shell snapshot pass its
   * sequence here so the subscription resumes without re-sending the entire
   * projects/threads list (overlapping events are deduped by sequence on the
   * client).
   */
  afterSequence: Schema.optionalKey(NonNegativeInt),
  /**
   * Requests an explicit marker after the subscription has emitted its initial
   * snapshot or catch-up replay and before it begins emitting live events.
   */
  requestCompletionMarker: Schema.optionalKey(Schema.Boolean),
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
  /**
   * When provided, the server skips the initial snapshot frame and instead
   * replays events after this sequence before streaming live events. Clients
   * that load the snapshot over HTTP pass the snapshot's sequence here so the
   * live subscription resumes without a gap (overlapping events are deduped by
   * sequence on the client).
   */
  afterSequence: Schema.optionalKey(NonNegativeInt),
  /**
   * Requests an explicit marker after the subscription has emitted its initial
   * snapshot or catch-up replay and before it begins emitting live events.
   */
  requestCompletionMarker: Schema.optionalKey(Schema.Boolean),
  /**
   * When provided, the fallback snapshot frame (sent when `afterSequence` is
   * missing or the catch-up gap is too large) is windowed to the last
   * `turnLimit` user-anchored turns and carries `page` metadata. Absent means
   * the fallback snapshot is the full thread, preserving pre-pagination client
   * behavior. Live events are unaffected either way.
   */
  turnLimit: Schema.optionalKey(PositiveInt),
});
export type OrchestrationSubscribeThreadInput = typeof OrchestrationSubscribeThreadInput.Type;

/**
 * Bounds a thread detail read to a window of recent turns. `turnLimit` counts
 * turns with a user pending message (subagent/fan-out turns between them ride
 * along), so the window always contains the last N user prompts. `beforeCursor`
 * requests the disjoint page of older turns strictly before a previously
 * returned cursor. Requests without a window get the full thread; pagination is
 * strictly opt-in so older clients keep today's behavior on both HTTP and the
 * WebSocket fallback snapshot.
 */
export const OrchestrationThreadDetailWindow = Schema.Struct({
  turnLimit: Schema.optionalKey(PositiveInt),
  beforeCursor: Schema.optionalKey(TrimmedNonEmptyString),
});
export type OrchestrationThreadDetailWindow = typeof OrchestrationThreadDetailWindow.Type;

/**
 * Page metadata for a windowed thread detail read. `beforeCursor` is opaque and
 * exclusive: passing it back returns the adjacent disjoint slice of older
 * turns. `null` means the thread is fully loaded below this page. The
 * `snapshotSequence` mirrors the top-level snapshot sequence so history pages
 * can be sequence-checked against live state before merging.
 */
export const OrchestrationThreadDetailPage = Schema.Struct({
  beforeCursor: Schema.NullOr(TrimmedNonEmptyString),
  hasMore: Schema.Boolean,
  snapshotSequence: NonNegativeInt,
  /**
   * Highest event sequence applied to THIS thread at page read time. The
   * global `snapshotSequence` advances with every thread's events, so a
   * client cannot wait for it via its per-thread subscription; this
   * thread-scoped watermark is reachable. A client merging an older page
   * must first have applied live events up to it — otherwise a streaming
   * turn outside the loaded window could have deltas replayed on top of
   * page content that already includes them, duplicating text.
   */
  threadSequence: Schema.optionalKey(NonNegativeInt),
});
export type OrchestrationThreadDetailPage = typeof OrchestrationThreadDetailPage.Type;

export const OrchestrationThreadDetailSnapshot = Schema.Struct({
  snapshotSequence: NonNegativeInt,
  thread: OrchestrationThread,
  implementationRuns: Schema.optionalKey(Schema.Array(OrchestrationImplementationRun)),
  appReviewWorkflowRuns: Schema.optionalKey(Schema.Array(AppReviewWorkflowRun)),
  // Present only on windowed responses. Absent on full snapshots (and from
  // pre-pagination servers), which clients treat as fully loaded.
  page: Schema.optional(OrchestrationThreadDetailPage),
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
  // Absent = leave unchanged; null = clear the override.
  defaultThreadEnvMode: Schema.optional(Schema.NullOr(ThreadEnvMode)),
  previewRecordingMode: Schema.optional(Schema.NullOr(PreviewRecordingMode)),
  faviconPath: Schema.optional(Schema.NullOr(ProjectFaviconPath)),
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
  workflowContext: Schema.optionalKey(Schema.NullOr(ThreadWorkflowContext)),
  workflowSubagentBatchProvenance: Schema.optionalKey(
    Schema.NullOr(WorkflowSubagentBatchProvenance),
  ),
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE)),
  ),
  workflowPreset: Schema.optionalKey(Schema.NullOr(WorkflowPreset)),
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

const ThreadSettleCommand = Schema.Struct({
  type: Schema.Literal("thread.settle"),
  commandId: CommandId,
  threadId: ThreadId,
});

const ThreadWorkflowPauseCommand = Schema.Struct({
  type: Schema.Literal("thread.workflow.pause"),
  commandId: CommandId,
  threadId: ThreadId,
  createdAt: IsoDateTime,
});

/**
 * The reverse of a pause: un-settle the paused subtree so the run's reactors can
 * re-enter whichever stage it stopped at. Worktrees, branches, and App Dev
 * Stacks are untouched — resuming starts fresh agents on the work as it stands.
 */
const ThreadWorkflowResumeCommand = Schema.Struct({
  type: Schema.Literal("thread.workflow.resume"),
  commandId: CommandId,
  threadId: ThreadId,
  createdAt: IsoDateTime,
});

/**
 * Pin one workflow step to an explicit provider instance and model, or clear
 * the pin (`modelSelection: null`) so the step returns to auto mode.
 */
const ThreadWorkflowStepModelSetCommand = Schema.Struct({
  type: Schema.Literal("thread.workflow.step-model.set"),
  commandId: CommandId,
  threadId: ThreadId,
  workflowPromptId: TrimmedNonEmptyString,
  /** Set when the pin targets one sub-step of a step rather than the step. */
  stepWorkflowPromptId: Schema.optionalKey(TrimmedNonEmptyString),
  modelSelection: Schema.NullOr(ModelSelection),
  createdAt: IsoDateTime,
});

/**
 * Set how many cycles one looping workflow step gets, or clear the budget
 * (`maxCycles: null`) so the step falls back to the standing default.
 */
const ThreadWorkflowStepCyclesSetCommand = Schema.Struct({
  type: Schema.Literal("thread.workflow.step-cycles.set"),
  commandId: CommandId,
  threadId: ThreadId,
  workflowPromptId: TrimmedNonEmptyString,
  /** Set when the budget targets one sub-step of a step rather than the step. */
  stepWorkflowPromptId: Schema.optionalKey(TrimmedNonEmptyString),
  maxCycles: Schema.NullOr(PositiveInt),
  createdAt: IsoDateTime,
});

const ThreadUnsettleCommand = Schema.Struct({
  type: Schema.Literal("thread.unsettle"),
  commandId: CommandId,
  threadId: ThreadId,
  // Commands only carry "user": activity un-settles are decided server-side
  // (the decider emits thread.unsettled(reason: "activity") events directly,
  // never through this command), so a client cannot forge the neutral reset.
  reason: Schema.Literal("user"),
});

const ThreadSnoozeCommand = Schema.Struct({
  type: Schema.Literal("thread.snooze"),
  commandId: CommandId,
  threadId: ThreadId,
  // The wake time. Event-based wake conditions (PR merged, review posted)
  // will arrive as an optional condition field alongside this; time-based
  // snooze is just the first kind of condition.
  snoozedUntil: IsoDateTime,
});

const ThreadUnsnoozeCommand = Schema.Struct({
  type: Schema.Literal("thread.unsnooze"),
  commandId: CommandId,
  threadId: ThreadId,
  // Commands only carry "user": activity wakes are decided server-side (the
  // decider emits thread.unsnoozed(reason: "activity") directly), and timer
  // wakes need no event at all — clients derive visibility from snoozedUntil,
  // so a passed wake time simply stops classifying as snoozed.
  reason: Schema.Literal("user"),
});

const ThreadPinCommand = Schema.Struct({
  type: Schema.Literal("thread.pin"),
  commandId: CommandId,
  threadId: ThreadId,
  // Initial slot in the user-arranged pinned order (see ThreadPinReorderCommand).
  // Optional: clients on pre-reorder servers omit it, and the pinned block
  // falls back to creation order for keyless threads.
  orderKey: Schema.optional(TrimmedNonEmptyString),
});

const ThreadUnpinCommand = Schema.Struct({
  type: Schema.Literal("thread.unpin"),
  commandId: CommandId,
  threadId: ThreadId,
});

const ThreadPinReorderCommand = Schema.Struct({
  type: Schema.Literal("thread.pin.reorder"),
  commandId: CommandId,
  threadId: ThreadId,
  // Fractional index key: pinned threads sort by plain string comparison of
  // these keys, so a drag writes one key to one thread — neighbors (possibly
  // on other servers) are never touched. Clients compute a key that sorts
  // between the dropped position's neighbors.
  orderKey: TrimmedNonEmptyString,
});

const ThreadMetaUpdateCommand = Schema.Struct({
  type: Schema.Literal("thread.meta.update"),
  commandId: CommandId,
  threadId: ThreadId,
  ownerUserId: Schema.optional(WorkspaceUserId),
  title: Schema.optional(TrimmedNonEmptyString),
  regenerateTitle: Schema.optional(Schema.Literal(true)),
  modelSelection: Schema.optional(ModelSelection),
  branch: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  expectedBranch: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  worktreePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
}).check(
  Schema.makeFilter(
    (input) =>
      !(input.title !== undefined && input.regenerateTitle === true) ||
      "title and regenerateTitle cannot be specified together",
  ),
);

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

const ThreadComposerModeSetCommand = Schema.Struct({
  type: Schema.Literal("thread.composer-mode.set"),
  commandId: CommandId,
  threadId: ThreadId,
  interactionMode: ProviderInteractionMode,
  workflowPreset: Schema.NullOr(WorkflowPreset),
  createdAt: IsoDateTime,
});

const ThreadPlanningSpecCreateCommand = Schema.Struct({
  type: Schema.Literal("thread.planning-spec.create"),
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
  stage: Schema.Literals(["grill", "spec", "tickets"]),
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

const ThreadPlanningSpecApplyCommand = Schema.Struct({
  type: Schema.Literal("thread.planning-spec.apply"),
  commandId: CommandId,
  threadId: ThreadId,
  sourceMessageId: MessageId,
  title: TrimmedNonEmptyString,
  summaryMarkdown: TrimmedNonEmptyString,
  artifactKind: Schema.optional(Schema.Literals(["spec", "wayfinder-map"])),
  tenantId: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  teamId: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  createdBy: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  createdAt: IsoDateTime,
});

export const ThreadPlanningTicketArtifactInput = Schema.Struct({
  key: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  bodyMarkdown: TrimmedNonEmptyString,
  plannedFileChanges: NonEmptyOrchestrationPlanningFileChanges,
  dependencyKeys: Schema.Array(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  appReviewEligible: Schema.optionalKey(Schema.Boolean),
  appReviewPlanMarkdown: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
});
export type ThreadPlanningTicketArtifactInput = typeof ThreadPlanningTicketArtifactInput.Type;

export const PlanningReviewerTicketEdit = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("update"),
    ticketId: OrchestrationPlanningTicketId,
    title: Schema.optional(TrimmedNonEmptyString),
    bodyMarkdown: Schema.optional(TrimmedNonEmptyString),
    plannedFileChanges: Schema.optional(NonEmptyOrchestrationPlanningFileChanges),
    dependencyKeys: Schema.optional(Schema.Array(OrchestrationPlanningTicketKey)),
    appReviewEligible: Schema.optional(Schema.Boolean),
    appReviewPlanMarkdown: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  }),
  Schema.Struct({
    type: Schema.Literal("create"),
    key: OrchestrationPlanningTicketKey,
    title: TrimmedNonEmptyString,
    bodyMarkdown: TrimmedNonEmptyString,
    plannedFileChanges: NonEmptyOrchestrationPlanningFileChanges,
    dependencyKeys: Schema.Array(OrchestrationPlanningTicketKey).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
    ),
    appReviewEligible: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
    appReviewPlanMarkdown: Schema.NullOr(TrimmedNonEmptyString).pipe(
      Schema.withDecodingDefault(Effect.succeed(null)),
    ),
    replacesPlanningTicketIds: Schema.Array(OrchestrationPlanningTicketId).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
    ),
  }),
  Schema.Struct({
    type: Schema.Literal("delete"),
    ticketId: OrchestrationPlanningTicketId,
  }),
  Schema.Struct({
    type: Schema.Literal("update-dependencies"),
    ticketId: OrchestrationPlanningTicketId,
    dependencyKeys: Schema.Array(OrchestrationPlanningTicketKey),
  }),
]);
export type PlanningReviewerTicketEdit = typeof PlanningReviewerTicketEdit.Type;

const ThreadPlanningTicketsApplyCommand = Schema.Struct({
  type: Schema.Literal("thread.planning-tickets.apply"),
  commandId: CommandId,
  threadId: ThreadId,
  sourceMessageId: MessageId,
  specId: OrchestrationPlanningSpecId,
  tickets: Schema.Array(ThreadPlanningTicketArtifactInput),
  createdAt: IsoDateTime,
});

const ThreadPlanningTicketReviewRequestCommand = Schema.Struct({
  type: Schema.Literal("thread.planning-ticket-review.request"),
  commandId: CommandId,
  threadId: ThreadId,
  specId: OrchestrationPlanningSpecId,
  createdAt: IsoDateTime,
});

const ThreadPlanningReviewerVerdictApplyCommand = Schema.Struct({
  type: Schema.Literal("thread.planning-reviewer-verdict.apply"),
  commandId: CommandId,
  threadId: ThreadId,
  reviewerThreadId: ThreadId,
  reviewerMessageId: MessageId,
  cycleNumber: Schema.optional(NonNegativeInt),
  mode: Schema.optional(OrchestrationPlanningReviewMode),
  targetPlanningTicketIds: Schema.optional(Schema.Array(OrchestrationPlanningTicketId)),
  ticketEdits: Schema.optional(Schema.Array(PlanningReviewerTicketEdit)),
  runtimeFailure: Schema.optional(Schema.Boolean),
  verdictMarkdown: Schema.String,
  passed: Schema.optional(Schema.Boolean),
  failingPlanningTicketIds: Schema.optional(Schema.Array(OrchestrationPlanningTicketId)),
  dependencyFeedback: Schema.optional(Schema.Array(Schema.String)),
  perTicketFeedback: Schema.optional(Schema.Array(OrchestrationPlanningReviewTicketFeedback)),
  createdAt: IsoDateTime,
});

const ThreadPlanningSpecBundleLoadCommand = Schema.Struct({
  type: Schema.Literal("thread.planning-spec-bundle.load"),
  commandId: CommandId,
  threadId: ThreadId,
  specId: OrchestrationPlanningSpecId,
  tenantId: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  teamId: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  source: Schema.optional(Schema.Literals(["projection"])),
  bundle: Schema.optional(OrchestrationPlanningSpecBundle),
  createdAt: IsoDateTime,
});

const ThreadImplementationRunLaunchCommand = Schema.Struct({
  type: Schema.Literal("thread.implementation-run.launch"),
  commandId: CommandId,
  threadId: ThreadId,
  specId: OrchestrationPlanningSpecId,
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

const ThreadFastFeatureRunLaunchCommand = Schema.Struct({
  type: Schema.Literal("thread.fast-feature-run.launch"),
  commandId: CommandId,
  threadId: ThreadId,
  proposedPlanId: OrchestrationProposedPlanId,
  baseBranch: Schema.optional(TrimmedNonEmptyString),
  pinnedCommit: Schema.optional(TrimmedNonEmptyString),
  orchestratorBranch: Schema.optional(TrimmedNonEmptyString),
  orchestratorWorktreePath: Schema.optional(TrimmedNonEmptyString),
  validationCommands: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  createdAt: IsoDateTime,
});

const ThreadImplementationRunRetryCommand = Schema.Struct({
  type: Schema.Literal("thread.implementation-run.retry"),
  commandId: CommandId,
  threadId: ThreadId,
  runId: OrchestrationImplementationRunId,
  createdAt: IsoDateTime,
});

const ThreadImplementationRunRerunCommand = Schema.Struct({
  type: Schema.Literal("thread.implementation-run.rerun"),
  commandId: CommandId,
  threadId: ThreadId,
  runId: OrchestrationImplementationRunId,
  target: OrchestrationImplementationRerunTarget,
  /**
   * Pin the model for the stage before it starts again. The pin is the same one
   * the Workflows panel writes, so it also governs every later agent that stage
   * starts. Omit it to keep whatever the stage resolves to today.
   */
  modelSelection: Schema.optionalKey(ModelSelection),
  createdAt: IsoDateTime,
});

/**
 * Clear a stage without starting it.
 *
 * The same clearing a re-run does, stopping there: the stage's threads,
 * results and outcomes go, the ticket is clean from that point on, and the
 * branch, worktree and every commit stay. Starting it again is a separate
 * decision, which is what makes this useful when the work has to be looked at
 * before it is redone.
 */
const ThreadImplementationRunResetCommand = Schema.Struct({
  type: Schema.Literal("thread.implementation-run.reset"),
  commandId: CommandId,
  threadId: ThreadId,
  runId: OrchestrationImplementationRunId,
  target: OrchestrationImplementationRerunTarget,
  createdAt: IsoDateTime,
});

/**
 * A thread as the pause walk needs it: an id, its parent, and its own pause
 * mark. Both the server's decider and a client's workflow panel pass their own
 * thread shape in.
 */
export interface WorkflowPauseThread {
  readonly id: string;
  readonly parentThreadId: string | null;
  readonly workflowPausedAt?: string | null | undefined;
}

/**
 * The paused scope covering `threadId`: the thread itself or its nearest
 * paused ancestor, or null when nothing above it is paused.
 *
 * A pause is stamped once, on the scope the user stopped, and inherited
 * downward by this walk, so a thread the run created after the click is
 * covered too. Unknown ids are not paused: a thread the read model has not seen
 * yet cannot be under a pause the user set.
 */
export function findWorkflowPauseScope<TThread extends WorkflowPauseThread>(
  threads: ReadonlyArray<TThread>,
  threadId: string,
): TThread | null {
  const seen = new Set<string>();
  let current = threads.find((thread) => thread.id === threadId);
  while (current !== undefined && !seen.has(current.id)) {
    if (current.workflowPausedAt != null) return current;
    seen.add(current.id);
    const parentId: string | null = current.parentThreadId;
    current = parentId === null ? undefined : threads.find((thread) => thread.id === parentId);
  }
  return null;
}

/** True when `threadId` or any of its ancestors is paused. */
export function isWorkflowThreadPaused<TThread extends WorkflowPauseThread>(
  threads: ReadonlyArray<TThread>,
  threadId: string,
): boolean {
  return findWorkflowPauseScope(threads, threadId) !== null;
}

/**
 * Whether the run has been told to pass over a ticket's stage.
 *
 * A whole-ticket skip covers every stage of it, so a caller asking about one
 * stage does not have to know how the skip was expressed.
 */
export function isTicketStageSkipped(
  skips: ReadonlyArray<OrchestrationImplementationSkipTarget>,
  ticketId: string,
  stage: OrchestrationImplementationRerunTicketStage,
): boolean {
  return skips.some(
    (skip) =>
      skip.kind === "ticket" &&
      skip.ticketId === ticketId &&
      (skip.stage === undefined || skip.stage === stage),
  );
}

/** Whether the whole ticket is skipped, rather than one of its stages. */
export function isTicketSkipped(
  skips: ReadonlyArray<OrchestrationImplementationSkipTarget>,
  ticketId: string,
): boolean {
  return skips.some(
    (skip) => skip.kind === "ticket" && skip.ticketId === ticketId && skip.stage === undefined,
  );
}

/** Whether the run has been told to pass over one of its own stages. */
export function isRunStageSkipped(
  skips: ReadonlyArray<OrchestrationImplementationSkipTarget>,
  stage: OrchestrationImplementationRerunRunStage,
): boolean {
  return skips.some((skip) => skip.kind === "run" && skip.stage === stage);
}

/**
 * Apply a skip decision, keeping the list free of entries the decision covers.
 *
 * Skipping a whole ticket replaces any stage skips it already had, and lifting
 * a whole-ticket skip lifts those with it: two ways of saying the same thing
 * would otherwise disagree the moment one of them is taken back.
 */
export function applyImplementationSkip(
  skips: ReadonlyArray<OrchestrationImplementationSkipTarget>,
  target: OrchestrationImplementationSkipTarget,
  skipped: boolean,
): ReadonlyArray<OrchestrationImplementationSkipTarget> {
  const covers = (skip: OrchestrationImplementationSkipTarget): boolean => {
    if (target.kind === "run") return skip.kind === "run" && skip.stage === target.stage;
    if (skip.kind !== "ticket" || skip.ticketId !== target.ticketId) return false;
    return target.stage === undefined || skip.stage === undefined || skip.stage === target.stage;
  };
  const remaining = skips.filter((skip) => !covers(skip));
  return skipped ? [...remaining, target] : remaining;
}

/** Set or lift a skip. One command both ways, so a skip is never a one-way door. */
const ThreadImplementationRunSkipCommand = Schema.Struct({
  type: Schema.Literal("thread.implementation-run.skip"),
  commandId: CommandId,
  threadId: ThreadId,
  runId: OrchestrationImplementationRunId,
  target: OrchestrationImplementationSkipTarget,
  skipped: Schema.Boolean,
  createdAt: IsoDateTime,
});

const ThreadImplementationRunCancelCommand = Schema.Struct({
  type: Schema.Literal("thread.implementation-run.cancel"),
  commandId: CommandId,
  threadId: ThreadId,
  runId: OrchestrationImplementationRunId,
  reason: Schema.optional(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
});

const ThreadTurnStartBootstrapCreateThread = Schema.Struct({
  projectId: ProjectId,
  ownerUserId: WorkspaceUserId.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_WORKSPACE_USER_ID)),
  ),
  parentThreadId: Schema.optionalKey(Schema.NullOr(ThreadId)),
  workflowRole: Schema.optionalKey(Schema.NullOr(OrchestrationThreadWorkflowRole)),
  workflowContext: Schema.optionalKey(Schema.NullOr(ThreadWorkflowContext)),
  workflowSubagentBatchProvenance: Schema.optionalKey(
    Schema.NullOr(WorkflowSubagentBatchProvenance),
  ),
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  workflowPreset: Schema.optionalKey(Schema.NullOr(WorkflowPreset)),
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

export const ThreadAppReviewWorkflowLaunchCommand = Schema.Struct({
  type: Schema.Literal("thread.app-review-workflow.launch"),
  commandId: CommandId,
  targetThreadId: ThreadId,
  controllerThreadId: ThreadId,
  caller: AppReviewWorkflowCaller,
  briefMarkdown: TrimmedNonEmptyString,
  supportingContextMarkdown: Schema.optionalKey(Schema.NullOr(Schema.String)),
  previewTargets: Schema.Array(TrimmedNonEmptyString),
  /** Reviews `previewTargets` as given instead of resolving an App Dev Stack. */
  previewTargetsPinned: Schema.optionalKey(Schema.Boolean),
  /** Reviews and writes repair tickets once, without repairing. Forces one cycle. */
  reviewOnly: Schema.optionalKey(Schema.Boolean),
  cycleBudget: AppReviewWorkflowCycleBudget.pipe(
    Schema.withDecodingDefault(Effect.succeed(APP_REVIEW_WORKFLOW_DEFAULT_CYCLES)),
  ),
  modelSelection: ModelSelection,
  workspaceRevision: Schema.optionalKey(AppReviewWorkflowWorkspaceRevision),
  bootstrap: Schema.optional(ThreadTurnStartBootstrap),
  createdAt: IsoDateTime,
});

const ThreadAppReviewWorkflowCancelCommand = Schema.Struct({
  type: Schema.Literal("thread.app-review-workflow.cancel"),
  commandId: CommandId,
  threadId: ThreadId,
  runId: AppReviewWorkflowRunId,
  reason: Schema.optional(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
});

const ThreadAppReviewWorkflowResumeCommand = Schema.Struct({
  type: Schema.Literal("thread.app-review-workflow.resume"),
  commandId: CommandId,
  threadId: ThreadId,
  runId: AppReviewWorkflowRunId,
  previewTargets: Schema.Array(TrimmedNonEmptyString).check(Schema.isMinLength(1)),
  workspaceRevision: AppReviewWorkflowWorkspaceRevision,
  createdAt: IsoDateTime,
});

const ThreadAppReviewWorkflowRerunCommand = Schema.Struct({
  type: Schema.Literal("thread.app-review-workflow.rerun"),
  commandId: CommandId,
  threadId: ThreadId,
  runId: AppReviewWorkflowRunId,
  /**
   * Which phase of the run's current cycle starts again. The phases after it
   * are discarded; earlier phases keep what they produced.
   */
  phase: AppReviewWorkflowPhase,
  /** Pins the phase's model before it starts again, same as the Models list. */
  modelSelection: Schema.optionalKey(ModelSelection),
  createdAt: IsoDateTime,
});

const ThreadAppReviewLaunchCommand = Schema.Struct({
  type: Schema.Literal("thread.app-review.launch"),
  commandId: CommandId,
  sourceThreadId: ThreadId,
  reviewThreadId: ThreadId,
  reviewId: AppReviewId,
  planningTicketIds: Schema.optional(Schema.Array(OrchestrationPlanningTicketId)),
  message: Schema.Struct({
    messageId: MessageId,
    role: Schema.Literal("user"),
    text: Schema.String,
    attachments: Schema.Array(ChatAttachment),
  }),
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  workflowPromptId: TrimmedNonEmptyString,
  batchProvenance: Schema.optionalKey(WorkflowSubagentBatchProvenance),
  createdAt: IsoDateTime,
});

const ThreadWorkflowSubagentBatchCreateCommand = Schema.Struct({
  type: Schema.Literal("thread.workflow-subagent-batch.create"),
  commandId: CommandId,
  threadId: ThreadId,
  batch: OrchestrationWorkflowSubagentBatch,
  createdAt: IsoDateTime,
});

const ThreadWorkflowSubagentLaunchCommand = Schema.Struct({
  type: Schema.Literal("thread.workflow-subagent.launch"),
  commandId: CommandId,
  threadId: ThreadId,
  batchId: WorkflowSubagentBatchId,
  childIndex: NonNegativeInt,
  projectId: ProjectId,
  ownerUserId: WorkspaceUserId,
  parentThreadId: ThreadId,
  workflowRole: Schema.NullOr(OrchestrationThreadWorkflowRole),
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  message: Schema.Struct({
    messageId: MessageId,
    role: Schema.Literal("user"),
    text: Schema.String,
    attachments: Schema.Array(ChatAttachment),
  }),
  workflowPromptId: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
});

const WorkflowSubagentBatchChildSettleBase = {
  commandId: CommandId,
  threadId: ThreadId,
  batchId: WorkflowSubagentBatchId,
  childIndex: NonNegativeInt,
  completedAt: IsoDateTime,
  createdAt: IsoDateTime,
} as const;

const ThreadWorkflowSubagentBatchChildRejectCommand = Schema.Struct({
  type: Schema.Literal("thread.workflow-subagent-batch.child.reject"),
  ...WorkflowSubagentBatchChildSettleBase,
  failureDetail: Schema.String,
});

const ThreadWorkflowSubagentBatchChildFailCommand = Schema.Struct({
  type: Schema.Literal("thread.workflow-subagent-batch.child.fail"),
  ...WorkflowSubagentBatchChildSettleBase,
  failureDetail: Schema.String,
  status: Schema.optionalKey(Schema.Literals(["failed", "canceled"])),
});

const ThreadWorkflowSubagentBatchChildCompleteCommand = Schema.Struct({
  type: Schema.Literal("thread.workflow-subagent-batch.child.complete"),
  ...WorkflowSubagentBatchChildSettleBase,
  status: Schema.Literals(["completed", "blocked"]),
  resultMarkdown: Schema.String,
});

const ThreadWorkflowSubagentBatchCompleteCommand = Schema.Struct({
  type: Schema.Literal("thread.workflow-subagent-batch.complete"),
  commandId: CommandId,
  threadId: ThreadId,
  batchId: WorkflowSubagentBatchId,
  message: Schema.Struct({
    messageId: MessageId,
    role: Schema.Literal("user"),
    text: Schema.String,
    attachments: Schema.Array(ChatAttachment),
  }),
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  completedAt: IsoDateTime,
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
  // Settle-cleanup stops are conditional: the decider drops the stop if the
  // thread was re-engaged (unsettled, session starting/running, or a queued
  // turn start) between the settle and this command. Guarding in the decider
  // closes the race a post-settle snapshot read cannot: commands are decided
  // serially against the authoritative read model.
  onlyIfSettled: Schema.optional(Schema.Boolean),
});

const DispatchableClientOrchestrationCommand = Schema.Union([
  ProjectCreateCommand,
  ProjectMetaUpdateCommand,
  ProjectDeleteCommand,
  ThreadCreateCommand,
  ThreadDeleteCommand,
  ThreadArchiveCommand,
  ThreadUnarchiveCommand,
  ThreadSettleCommand,
  ThreadWorkflowPauseCommand,
  ThreadWorkflowResumeCommand,
  ThreadWorkflowStepModelSetCommand,
  ThreadWorkflowStepCyclesSetCommand,
  ThreadUnsettleCommand,
  ThreadSnoozeCommand,
  ThreadUnsnoozeCommand,
  ThreadPinCommand,
  ThreadUnpinCommand,
  ThreadPinReorderCommand,
  ThreadMetaUpdateCommand,
  ThreadRuntimeModeSetCommand,
  ThreadInteractionModeSetCommand,
  ThreadComposerModeSetCommand,
  ThreadPlanningSpecCreateCommand,
  ThreadPlanningStageStartCommand,
  ThreadPlanningWorkflowLaunchCommand,
  ThreadPlanningTicketReviewRequestCommand,
  ThreadPlanningSpecBundleLoadCommand,
  ThreadImplementationRunLaunchCommand,
  ThreadFastFeatureRunLaunchCommand,
  ThreadImplementationRunRetryCommand,
  ThreadImplementationRunRerunCommand,
  ThreadImplementationRunResetCommand,
  ThreadImplementationRunSkipCommand,
  ThreadImplementationRunCancelCommand,
  ThreadImplementationChangeRequestRetryCommand,
  ThreadAppReviewWorkflowLaunchCommand,
  ThreadAppReviewWorkflowCancelCommand,
  ThreadAppReviewWorkflowResumeCommand,
  ThreadAppReviewWorkflowRerunCommand,
  ThreadAppReviewLaunchCommand,
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
  ThreadSettleCommand,
  ThreadWorkflowPauseCommand,
  ThreadWorkflowResumeCommand,
  ThreadWorkflowStepModelSetCommand,
  ThreadWorkflowStepCyclesSetCommand,
  ThreadUnsettleCommand,
  ThreadSnoozeCommand,
  ThreadUnsnoozeCommand,
  ThreadPinCommand,
  ThreadUnpinCommand,
  ThreadPinReorderCommand,
  ThreadMetaUpdateCommand,
  ThreadRuntimeModeSetCommand,
  ThreadInteractionModeSetCommand,
  ThreadComposerModeSetCommand,
  ThreadPlanningSpecCreateCommand,
  ThreadPlanningStageStartCommand,
  ThreadPlanningWorkflowLaunchCommand,
  ThreadPlanningTicketReviewRequestCommand,
  ThreadPlanningSpecBundleLoadCommand,
  ThreadImplementationRunLaunchCommand,
  ThreadFastFeatureRunLaunchCommand,
  ThreadImplementationRunRetryCommand,
  ThreadImplementationRunRerunCommand,
  ThreadImplementationRunResetCommand,
  ThreadImplementationRunSkipCommand,
  ThreadImplementationRunCancelCommand,
  ThreadImplementationChangeRequestRetryCommand,
  ThreadAppReviewWorkflowLaunchCommand,
  ThreadAppReviewWorkflowCancelCommand,
  ThreadAppReviewWorkflowResumeCommand,
  ThreadAppReviewWorkflowRerunCommand,
  ThreadAppReviewLaunchCommand,
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

const ThreadAppReviewUpdateCommand = Schema.Struct({
  type: Schema.Literal("thread.app-review.update"),
  commandId: CommandId,
  threadId: ThreadId,
  reviewId: AppReviewId,
  status: Schema.optional(AppReviewRecord.fields.status),
  document: Schema.optional(AppReviewDocument),
  updatedAt: IsoDateTime,
  createdAt: IsoDateTime,
});

const ThreadAppReviewEvidenceUpdateCommand = Schema.Struct({
  type: Schema.Literal("thread.app-review.evidence.update"),
  commandId: CommandId,
  threadId: ThreadId,
  reviewId: AppReviewId,
  evidence: AppReviewEvidence,
  updatedAt: IsoDateTime,
  createdAt: IsoDateTime,
});

const ThreadAppReviewWorkflowUpdateCommand = Schema.Struct({
  type: Schema.Literal("thread.app-review-workflow.update"),
  commandId: CommandId,
  threadId: ThreadId,
  run: AppReviewWorkflowRun,
  createdAt: IsoDateTime,
});

const ThreadRevertCompleteCommand = Schema.Struct({
  type: Schema.Literal("thread.revert.complete"),
  commandId: CommandId,
  threadId: ThreadId,
  turnCount: NonNegativeInt,
  createdAt: IsoDateTime,
});

const ThreadTitleRegenerationCompleteCommand = Schema.Struct({
  type: Schema.Literal("thread.title.regeneration.complete"),
  commandId: CommandId,
  threadId: ThreadId,
  requestId: CommandId,
  title: Schema.optional(TrimmedNonEmptyString),
});

const InternalOrchestrationCommand = Schema.Union([
  ThreadSessionSetCommand,
  ThreadMessageAssistantDeltaCommand,
  ThreadMessageAssistantCompleteCommand,
  ThreadProposedPlanUpsertCommand,
  ThreadPlanningSpecApplyCommand,
  ThreadPlanningTicketsApplyCommand,
  ThreadPlanningReviewerVerdictApplyCommand,
  ThreadPlanningWorkflowStageSetCommand,
  ThreadImplementationRunUpdateCommand,
  ThreadTurnDiffCompleteCommand,
  ThreadActivityAppendCommand,
  ThreadAppReviewUpdateCommand,
  ThreadAppReviewEvidenceUpdateCommand,
  ThreadAppReviewWorkflowUpdateCommand,
  ThreadWorkflowSubagentBatchCreateCommand,
  ThreadWorkflowSubagentLaunchCommand,
  ThreadWorkflowSubagentBatchChildRejectCommand,
  ThreadWorkflowSubagentBatchChildFailCommand,
  ThreadWorkflowSubagentBatchChildCompleteCommand,
  ThreadWorkflowSubagentBatchCompleteCommand,
  ThreadRevertCompleteCommand,
  ThreadTitleRegenerationCompleteCommand,
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
  "thread.settled",
  "thread.unsettled",
  "thread.snoozed",
  "thread.unsnoozed",
  "thread.pinned",
  "thread.unpinned",
  "thread.pin-reordered",
  "thread.meta-updated",
  "thread.runtime-mode-set",
  "thread.interaction-mode-set",
  "thread.composer-mode-set",
  "thread.planning-stage-started",
  "thread.planning-spec-created",
  "thread.planning-tickets-created",
  "thread.planning-tickets-revised",
  "thread.planning-ticket-review-requested",
  "thread.planning-spec-bundle-loaded",
  "thread.planning-workflow-stage-set",
  "thread.workflow-step-model-set",
  "thread.workflow-step-cycles-set",
  "thread.workflow-paused",
  "thread.workflow-resumed",
  "thread.implementation-run-launched",
  "thread.implementation-run-updated",
  "thread.implementation-run-retry-requested",
  "thread.implementation-run-rerun-requested",
  "thread.implementation-run-reset-requested",
  "thread.implementation-run-skip-set",
  "thread.implementation-run-cancel-requested",
  "thread.implementation-change-request-retry-requested",
  "thread.app-review-workflow-launched",
  "thread.app-review-workflow-updated",
  "thread.app-review-workflow-cancel-requested",
  "thread.app-review-workflow-resume-requested",
  "thread.app-review-workflow-rerun-requested",
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
  "thread.app-review-created",
  "thread.app-review-updated",
  "thread.app-review-evidence-updated",
  "thread.workflow-subagent-batch-created",
  "thread.workflow-subagent-batch-child-updated",
  "thread.workflow-subagent-batch-completed",
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
  // Optional so persisted events from older servers still decode.
  faviconPath: Schema.optional(Schema.NullOr(ProjectFaviconPath)),
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
  defaultThreadEnvMode: Schema.optional(Schema.NullOr(ThreadEnvMode)),
  previewRecordingMode: Schema.optional(Schema.NullOr(PreviewRecordingMode)),
  faviconPath: Schema.optional(Schema.NullOr(ProjectFaviconPath)),
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
  workflowContext: Schema.optionalKey(Schema.NullOr(ThreadWorkflowContext)),
  workflowSubagentBatchProvenance: Schema.optionalKey(
    Schema.NullOr(WorkflowSubagentBatchProvenance),
  ),
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode.pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_RUNTIME_MODE))),
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE)),
  ),
  workflowPreset: Schema.optionalKey(Schema.NullOr(WorkflowPreset)),
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

export const ThreadSettledPayload = Schema.Struct({
  threadId: ThreadId,
  settledAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const ThreadUnsettledPayload = Schema.Struct({
  threadId: ThreadId,
  reason: Schema.Literals(["user", "activity"]),
  updatedAt: IsoDateTime,
});

/**
 * A workflow pause on one scope of a run: the workflow root, a ticket's
 * worker, a stage's thread. Every thread beneath the scope is paused with it,
 * derived by walking parents rather than stamped on each descendant, so a
 * thread created after the click is covered too.
 */
export const ThreadWorkflowPausedPayload = Schema.Struct({
  threadId: ThreadId,
  pausedAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const ThreadWorkflowResumedPayload = Schema.Struct({
  threadId: ThreadId,
  updatedAt: IsoDateTime,
});

export const ThreadSnoozedPayload = Schema.Struct({
  threadId: ThreadId,
  snoozedUntil: IsoDateTime,
  snoozedAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const ThreadUnsnoozedPayload = Schema.Struct({
  threadId: ThreadId,
  // user: explicit "wake now". activity: real work arrived (user message /
  // session coming alive) and the decider cleared the snooze — mirrors
  // thread.unsettled's activity resets. Timer wakes emit no event: clients
  // derive them from snoozedUntil passing.
  reason: Schema.Literals(["user", "activity"]),
  updatedAt: IsoDateTime,
});

export const ThreadPinnedPayload = Schema.Struct({
  threadId: ThreadId,
  pinnedAt: IsoDateTime,
  // Absent on re-pins of an already-pinned thread (the existing key wins)
  // and on pins from clients that predate reordering.
  pinOrderKey: Schema.optional(TrimmedNonEmptyString),
  updatedAt: IsoDateTime,
});

export const ThreadUnpinnedPayload = Schema.Struct({
  threadId: ThreadId,
  updatedAt: IsoDateTime,
});

export const ThreadPinReorderedPayload = Schema.Struct({
  threadId: ThreadId,
  orderKey: TrimmedNonEmptyString,
  updatedAt: IsoDateTime,
});

export const ThreadMetaUpdatedPayload = Schema.Struct({
  threadId: ThreadId,
  ownerUserId: Schema.optional(WorkspaceUserId),
  title: Schema.optional(TrimmedNonEmptyString),
  /** Intent marker consumed by the title-generation reactor. Keeping this on
      the existing event lets older clients safely ignore the new field. */
  regenerateTitle: Schema.optional(Schema.Literal(true)),
  /** Title at request time, used to avoid overwriting a later manual rename. */
  previousTitle: Schema.optional(TrimmedNonEmptyString),
  /** Pending state shared with clients. Null clears a matching request. */
  titleRegeneration: Schema.optional(Schema.NullOr(ThreadTitleRegeneration)),
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

export const ThreadWorkflowStepModelSetPayload = Schema.Struct({
  threadId: ThreadId,
  workflowPromptId: TrimmedNonEmptyString,
  /** Set when the pin targets one sub-step of a step rather than the step. */
  stepWorkflowPromptId: Schema.optionalKey(TrimmedNonEmptyString),
  /** Null clears the pin and returns the step to auto mode. */
  modelSelection: Schema.NullOr(ModelSelection),
  updatedAt: IsoDateTime,
});

export const ThreadWorkflowStepCyclesSetPayload = Schema.Struct({
  threadId: ThreadId,
  workflowPromptId: TrimmedNonEmptyString,
  /** Set when the budget targets one sub-step of a step rather than the step. */
  stepWorkflowPromptId: Schema.optionalKey(TrimmedNonEmptyString),
  /** Null clears the budget and returns the step to the standing default. */
  maxCycles: Schema.NullOr(PositiveInt),
  updatedAt: IsoDateTime,
});

export const ThreadInteractionModeSetPayload = Schema.Struct({
  threadId: ThreadId,
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE)),
  ),
  updatedAt: IsoDateTime,
});

export const ThreadComposerModeSetPayload = Schema.Struct({
  threadId: ThreadId,
  interactionMode: ProviderInteractionMode,
  workflowPreset: Schema.NullOr(WorkflowPreset),
  updatedAt: IsoDateTime,
});

export const ThreadPlanningStageStartedPayload = Schema.Struct({
  threadId: ThreadId,
  stage: OrchestrationPlanningWorkflowStage,
  startedAt: IsoDateTime,
  /** Stamps a workflow context onto threads that plan in place (product roots). */
  workflowContext: Schema.optional(ThreadWorkflowContext),
});

export const ThreadPlanningSpecCreatedPayload = Schema.Struct({
  threadId: ThreadId,
  spec: OrchestrationPlanningSpec,
  artifactKind: Schema.optional(Schema.Literals(["spec", "wayfinder-map"])),
  stage: Schema.optional(OrchestrationPlanningWorkflowStage),
});

export const ThreadPlanningTicketsCreatedPayload = Schema.Struct({
  threadId: ThreadId,
  specId: OrchestrationPlanningSpecId,
  spec: Schema.optionalKey(OrchestrationPlanningSpec),
  tickets: Schema.Array(OrchestrationPlanningTicket),
  stage: Schema.optional(OrchestrationPlanningWorkflowStage),
});

export const ThreadPlanningTicketsRevisedPayload = Schema.Struct({
  threadId: ThreadId,
  specId: OrchestrationPlanningSpecId,
  reviewCycle: Schema.optional(OrchestrationPlanningReviewCycle),
  tickets: Schema.Array(OrchestrationPlanningTicket),
  stage: Schema.optional(OrchestrationPlanningWorkflowStage),
  revisedAt: IsoDateTime,
});

export const ThreadPlanningTicketReviewRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  specId: OrchestrationPlanningSpecId,
  cycleNumber: NonNegativeInt,
  mode: OrchestrationPlanningReviewMode.pipe(
    Schema.withDecodingDefault(Effect.succeed("full" as const)),
  ),
  targetPlanningTicketIds: Schema.Array(OrchestrationPlanningTicketId).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  reviewerThreadId: ThreadId,
  reviewerMessageId: MessageId,
  stage: Schema.Literal("ticket-review"),
  requestedAt: IsoDateTime,
});

export const ThreadPlanningSpecBundleLoadedPayload = Schema.Struct({
  threadId: ThreadId,
  specId: OrchestrationPlanningSpecId,
  sourceThreadId: ThreadId,
  bundle: Schema.optional(OrchestrationPlanningSpecBundle),
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

export const ThreadImplementationRunRetryRequestedPayload = Schema.Struct({
  run: OrchestrationImplementationRun,
});

export const ThreadImplementationRunRerunRequestedPayload = Schema.Struct({
  run: OrchestrationImplementationRun,
  target: OrchestrationImplementationRerunTarget,
});

export const ThreadImplementationRunResetRequestedPayload = Schema.Struct({
  run: OrchestrationImplementationRun,
  target: OrchestrationImplementationRerunTarget,
});

export const ThreadImplementationRunSkipSetPayload = Schema.Struct({
  run: OrchestrationImplementationRun,
  target: OrchestrationImplementationSkipTarget,
  skipped: Schema.Boolean,
});

export const ThreadImplementationRunCancelRequestedPayload = Schema.Struct({
  sourceThreadId: ThreadId,
  run: OrchestrationImplementationRun,
  reason: Schema.optional(Schema.String),
});

export const ThreadAppReviewWorkflowLaunchedPayload = Schema.Struct({
  sourceThreadId: ThreadId,
  run: AppReviewWorkflowRun,
});

export const ThreadAppReviewWorkflowUpdatedPayload = Schema.Struct({
  sourceThreadId: ThreadId,
  run: AppReviewWorkflowRun,
});

export const ThreadAppReviewWorkflowCancelRequestedPayload = Schema.Struct({
  sourceThreadId: ThreadId,
  run: AppReviewWorkflowRun,
  reason: Schema.optional(Schema.String),
});

export const ThreadAppReviewWorkflowResumeRequestedPayload = Schema.Struct({
  sourceThreadId: ThreadId,
  run: AppReviewWorkflowRun,
});

export const ThreadAppReviewWorkflowRerunRequestedPayload = Schema.Struct({
  sourceThreadId: ThreadId,
  run: AppReviewWorkflowRun,
  /** The phase of the run's current cycle that starts again. */
  phase: AppReviewWorkflowPhase,
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

export const ThreadAppReviewCreatedPayload = Schema.Struct({
  threadId: ThreadId,
  appReview: AppReviewRecord,
});

export const ThreadAppReviewUpdatedPayload = Schema.Struct({
  threadId: ThreadId,
  reviewId: AppReviewId,
  sourceThreadId: ThreadId,
  reviewThreadId: ThreadId,
  status: Schema.optional(AppReviewRecord.fields.status),
  document: Schema.optional(AppReviewDocument),
  updatedAt: IsoDateTime,
});

export const ThreadAppReviewEvidenceUpdatedPayload = Schema.Struct({
  threadId: ThreadId,
  reviewId: AppReviewId,
  sourceThreadId: ThreadId,
  reviewThreadId: ThreadId,
  evidence: AppReviewEvidence,
  updatedAt: IsoDateTime,
});

export const ThreadWorkflowSubagentBatchCreatedPayload = Schema.Struct({
  threadId: ThreadId,
  batch: OrchestrationWorkflowSubagentBatch,
});

export const ThreadWorkflowSubagentBatchChildUpdatedPayload = Schema.Struct({
  threadId: ThreadId,
  batchId: WorkflowSubagentBatchId,
  child: OrchestrationWorkflowSubagentBatchChild,
  batchStatus: OrchestrationWorkflowSubagentBatchStatus,
});

export const ThreadWorkflowSubagentBatchCompletedPayload = Schema.Struct({
  threadId: ThreadId,
  batchId: WorkflowSubagentBatchId,
  completedAt: IsoDateTime,
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
    type: Schema.Literal("thread.settled"),
    payload: ThreadSettledPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.unsettled"),
    payload: ThreadUnsettledPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.workflow-paused"),
    payload: ThreadWorkflowPausedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.workflow-resumed"),
    payload: ThreadWorkflowResumedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.snoozed"),
    payload: ThreadSnoozedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.unsnoozed"),
    payload: ThreadUnsnoozedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.pinned"),
    payload: ThreadPinnedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.unpinned"),
    payload: ThreadUnpinnedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.pin-reordered"),
    payload: ThreadPinReorderedPayload,
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
    type: Schema.Literal("thread.composer-mode-set"),
    payload: ThreadComposerModeSetPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.planning-stage-started"),
    payload: ThreadPlanningStageStartedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.planning-spec-created"),
    payload: ThreadPlanningSpecCreatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.planning-tickets-created"),
    payload: ThreadPlanningTicketsCreatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.planning-tickets-revised"),
    payload: ThreadPlanningTicketsRevisedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.planning-ticket-review-requested"),
    payload: ThreadPlanningTicketReviewRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.planning-spec-bundle-loaded"),
    payload: ThreadPlanningSpecBundleLoadedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.planning-workflow-stage-set"),
    payload: ThreadPlanningWorkflowStageSetPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.workflow-step-model-set"),
    payload: ThreadWorkflowStepModelSetPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.workflow-step-cycles-set"),
    payload: ThreadWorkflowStepCyclesSetPayload,
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
    type: Schema.Literal("thread.implementation-run-retry-requested"),
    payload: ThreadImplementationRunRetryRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.implementation-run-rerun-requested"),
    payload: ThreadImplementationRunRerunRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.implementation-run-reset-requested"),
    payload: ThreadImplementationRunResetRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.implementation-run-skip-set"),
    payload: ThreadImplementationRunSkipSetPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.implementation-run-cancel-requested"),
    payload: ThreadImplementationRunCancelRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.implementation-change-request-retry-requested"),
    payload: ThreadImplementationChangeRequestRetryRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.app-review-workflow-launched"),
    payload: ThreadAppReviewWorkflowLaunchedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.app-review-workflow-updated"),
    payload: ThreadAppReviewWorkflowUpdatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.app-review-workflow-cancel-requested"),
    payload: ThreadAppReviewWorkflowCancelRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.app-review-workflow-resume-requested"),
    payload: ThreadAppReviewWorkflowResumeRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.app-review-workflow-rerun-requested"),
    payload: ThreadAppReviewWorkflowRerunRequestedPayload,
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
    type: Schema.Literal("thread.app-review-created"),
    payload: ThreadAppReviewCreatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.app-review-updated"),
    payload: ThreadAppReviewUpdatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.app-review-evidence-updated"),
    payload: ThreadAppReviewEvidenceUpdatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.workflow-subagent-batch-created"),
    payload: ThreadWorkflowSubagentBatchCreatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.workflow-subagent-batch-child-updated"),
    payload: ThreadWorkflowSubagentBatchChildUpdatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.workflow-subagent-batch-completed"),
    payload: ThreadWorkflowSubagentBatchCompletedPayload,
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
    kind: Schema.Literal("synchronized"),
  }),
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
      new SchemaIssue.InvalidValue({
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

export const OrchestrationThreadSearchSource = Schema.Literals(["user", "assistant"]);
export type OrchestrationThreadSearchSource = typeof OrchestrationThreadSearchSource.Type;

// The server's SQLite client is synchronous and single-connection. Bound both
// scan input and response size so a search cannot monopolize that connection.
export const OrchestrationSearchThreadsInput = Schema.Struct({
  query: TrimmedString.check(Schema.isMinLength(2), Schema.isMaxLength(200)),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
});
export type OrchestrationSearchThreadsInput = typeof OrchestrationSearchThreadsInput.Type;

export const OrchestrationThreadSearchMatch = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  source: OrchestrationThreadSearchSource,
  snippet: Schema.String.check(Schema.isMaxLength(240)),
  messageCreatedAt: Schema.NullOr(IsoDateTime),
});
export type OrchestrationThreadSearchMatch = typeof OrchestrationThreadSearchMatch.Type;

export const OrchestrationSearchThreadsResult = Schema.Struct({
  matches: Schema.Array(OrchestrationThreadSearchMatch),
});
export type OrchestrationSearchThreadsResult = typeof OrchestrationSearchThreadsResult.Type;

export const OrchestrationGetWorkflowScriptInput = Schema.Struct({
  threadId: ThreadId,
  /** Absolute path from the workflow's runHandles.scriptPath. The server
   * re-derives containment; the client value is a hint, never trusted. */
  scriptPath: TrimmedNonEmptyString,
});
export type OrchestrationGetWorkflowScriptInput = typeof OrchestrationGetWorkflowScriptInput.Type;

export const OrchestrationGetWorkflowScriptResult = Schema.Struct({
  scriptPath: TrimmedNonEmptyString,
  contents: Schema.String,
  truncated: Schema.Boolean,
});
export type OrchestrationGetWorkflowScriptResult = typeof OrchestrationGetWorkflowScriptResult.Type;

const WORKFLOW_SCRIPT_ERROR_MESSAGES = {
  "invalid-path": "Workflow scripts must be absolute .js paths.",
  "root-unavailable": "Script root unavailable.",
  "not-found": "Script not found.",
  "outside-root": "Script path is outside the workflow scripts root.",
  "not-js": "Resolved script is not a .js file.",
  "not-regular-file": "Script is not a regular file.",
  "changed-during-read": "Script changed between resolution and open.",
  "read-failed": "Script read failed.",
} as const;

export class OrchestrationGetWorkflowScriptError extends Schema.TaggedErrorClass<OrchestrationGetWorkflowScriptError>()(
  "OrchestrationGetWorkflowScriptError",
  {
    reason: Schema.Literals([
      "invalid-path",
      "root-unavailable",
      "not-found",
      "outside-root",
      "not-js",
      "not-regular-file",
      "changed-during-read",
      "read-failed",
    ]),
    scriptPath: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return WORKFLOW_SCRIPT_ERROR_MESSAGES[this.reason];
  }
}

export const OrchestrationRpcSchemas = {
  dispatchCommand: {
    input: ClientOrchestrationCommand,
    output: DispatchResult,
  },
  getWorkflowScript: {
    input: OrchestrationGetWorkflowScriptInput,
    output: OrchestrationGetWorkflowScriptResult,
  },
  getTurnDiff: {
    input: OrchestrationGetTurnDiffInput,
    output: OrchestrationGetTurnDiffResult,
  },
  getFullThreadDiff: {
    input: OrchestrationGetFullThreadDiffInput,
    output: OrchestrationGetFullThreadDiffResult,
  },
  searchThreads: {
    input: OrchestrationSearchThreadsInput,
    output: OrchestrationSearchThreadsResult,
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

export class OrchestrationSearchThreadsError extends Schema.TaggedErrorClass<OrchestrationSearchThreadsError>()(
  "OrchestrationSearchThreadsError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
