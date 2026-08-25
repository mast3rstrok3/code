import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderOptionSelections } from "./model.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const WorkflowStageExecutionState = Schema.Literals([
  "queued",
  "starting",
  "running",
  "retry-wait",
  "reconciling",
  "halted",
  "succeeded",
  "skipped",
]);
export type WorkflowStageExecutionState = typeof WorkflowStageExecutionState.Type;

export const WorkflowFailureCategory = Schema.Literals([
  "planned-restart",
  "server-crash",
  "provider-rate-limit",
  "provider-transport",
  "provider-terminal",
  "structural-invariant",
  "missing-directive",
  "review-findings",
  "validation-failed",
  "dependency-failed",
]);
export type WorkflowFailureCategory = typeof WorkflowFailureCategory.Type;

export const WorkflowCanonicalNextAction = Schema.Literals([
  "claim-stage",
  "continue-stage",
  "wait-for-retry",
  "wait-for-dependencies",
  "resume-workflow",
  "rerun-stage",
  "review-findings",
  "fix-authentication",
  "fix-configuration",
  "repair-validation",
  "inspect-workflow",
  "none",
]);
export type WorkflowCanonicalNextAction = typeof WorkflowCanonicalNextAction.Type;

export const WorkflowStageTarget = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("run"),
    runId: TrimmedNonEmptyString,
    stage: Schema.Literals([
      "integration",
      "merge-gate",
      "app-review",
      "code-review",
      "validation",
      "publication",
      "babysitting",
    ]),
  }),
  Schema.Struct({
    kind: Schema.Literal("ticket"),
    runId: TrimmedNonEmptyString,
    ticketId: TrimmedNonEmptyString,
    stage: Schema.Literals(["implementation", "app-review", "code-review", "validation"]),
  }),
  Schema.Struct({
    kind: Schema.Literal("app-review-phase"),
    runId: TrimmedNonEmptyString,
    cycleNumber: PositiveInt,
    phase: Schema.Literals(["review", "planning", "fixing"]),
  }),
]);
export type WorkflowStageTarget = typeof WorkflowStageTarget.Type;

export const WorkflowRecoveryModel = Schema.Struct({
  instanceId: ProviderInstanceId,
  model: TrimmedNonEmptyString,
  options: Schema.optionalKey(ProviderOptionSelections),
});
export type WorkflowRecoveryModel = typeof WorkflowRecoveryModel.Type;

export const WorkflowStageFailure = Schema.Struct({
  category: WorkflowFailureCategory,
  detail: TrimmedNonEmptyString,
  failedAt: IsoDateTime,
  nextAction: WorkflowCanonicalNextAction,
});
export type WorkflowStageFailure = typeof WorkflowStageFailure.Type;

export const WorkflowRecoveryFallbackAttempt = Schema.Struct({
  model: WorkflowRecoveryModel,
  category: WorkflowFailureCategory,
  attemptedAt: IsoDateTime,
  detail: Schema.optionalKey(TrimmedNonEmptyString),
});
export type WorkflowRecoveryFallbackAttempt = typeof WorkflowRecoveryFallbackAttempt.Type;

export const WorkflowRecoveryEpisode = Schema.Struct({
  cause: WorkflowFailureCategory,
  startedAt: IsoDateTime,
  deadlineAt: Schema.NullOr(IsoDateTime),
  attempts: NonNegativeInt,
  selectedModel: Schema.NullOr(WorkflowRecoveryModel),
  fallbackHistory: Schema.Array(WorkflowRecoveryFallbackAttempt),
  retryAt: Schema.NullOr(IsoDateTime),
});
export type WorkflowRecoveryEpisode = typeof WorkflowRecoveryEpisode.Type;

export const WorkflowStageExecution = Schema.Struct({
  target: WorkflowStageTarget,
  generation: NonNegativeInt,
  executionId: TrimmedNonEmptyString,
  state: WorkflowStageExecutionState,
  queuedAt: IsoDateTime,
  claimedAt: Schema.NullOr(IsoDateTime),
  leaseRenewedAt: Schema.NullOr(IsoDateTime),
  leaseExpiresAt: Schema.NullOr(IsoDateTime),
  lastProgressAt: IsoDateTime,
  durableJobId: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
  failure: Schema.NullOr(WorkflowStageFailure),
  recovery: Schema.NullOr(WorkflowRecoveryEpisode),
  updatedAt: IsoDateTime,
});
export type WorkflowStageExecution = typeof WorkflowStageExecution.Type;

export const DurableValidationJobStatus = Schema.Literals([
  "queued",
  "running",
  "succeeded",
  "failed",
  "canceled",
]);
export type DurableValidationJobStatus = typeof DurableValidationJobStatus.Type;

export const DurableValidationJob = Schema.Struct({
  id: TrimmedNonEmptyString,
  target: WorkflowStageTarget,
  generation: NonNegativeInt,
  command: TrimmedNonEmptyString,
  workingDirectory: TrimmedNonEmptyString,
  status: DurableValidationJobStatus,
  heartbeatAt: Schema.NullOr(IsoDateTime),
  queuedAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
  outputSummary: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  resultReceipt: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
});
export type DurableValidationJob = typeof DurableValidationJob.Type;

export const WorkflowDrainStatus = Schema.Literals(["accepting", "draining", "ready", "forced"]);
export type WorkflowDrainStatus = typeof WorkflowDrainStatus.Type;

export const WorkflowDrainState = Schema.Struct({
  status: WorkflowDrainStatus,
  operationId: Schema.NullOr(TrimmedNonEmptyString),
  requestedAt: Schema.NullOr(IsoDateTime),
  deadlineAt: Schema.NullOr(IsoDateTime),
});
export type WorkflowDrainState = typeof WorkflowDrainState.Type;
