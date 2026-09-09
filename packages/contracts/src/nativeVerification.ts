import * as Schema from "effect/Schema";
import { IsoDateTime, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { AppReviewWorkflowFixValidation } from "./review.ts";

export const NativeVerificationPlatform = Schema.Literals(["macos", "ios", "windows", "android"]);
export type NativeVerificationPlatform = typeof NativeVerificationPlatform.Type;

export const NativeVerificationResult = Schema.Struct({
  status: Schema.Literals(["passed", "failed", "blocked"]),
  platform: NativeVerificationPlatform,
  commitSha: TrimmedNonEmptyString,
  validations: Schema.Array(AppReviewWorkflowFixValidation),
  summaryMarkdown: TrimmedNonEmptyString,
  evidence: Schema.Array(TrimmedNonEmptyString),
  completedAt: IsoDateTime,
});
export type NativeVerificationResult = typeof NativeVerificationResult.Type;

export const NativeVerificationClaim = Schema.Struct({
  id: TrimmedNonEmptyString,
  environmentId: TrimmedNonEmptyString,
  environmentLabel: TrimmedNonEmptyString,
  threadId: ThreadId,
  projectId: ProjectId,
  platform: NativeVerificationPlatform,
  claimedAt: IsoDateTime,
});
export type NativeVerificationClaim = typeof NativeVerificationClaim.Type;

export const NativeVerificationHandoff = Schema.Struct({
  id: TrimmedNonEmptyString,
  revision: Schema.Int,
  status: Schema.Literals(["ready", "claimed", "completed", "canceled"]),
  requiredPlatforms: Schema.NonEmptyArray(NativeVerificationPlatform),
  repositoryUrl: TrimmedNonEmptyString,
  branch: TrimmedNonEmptyString,
  commitSha: TrimmedNonEmptyString,
  sourceThreadId: ThreadId,
  runId: TrimmedNonEmptyString,
  ticketId: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  instructionsMarkdown: TrimmedNonEmptyString,
  previewTargets: Schema.Array(TrimmedNonEmptyString),
  claim: Schema.NullOr(NativeVerificationClaim),
  results: Schema.Array(NativeVerificationResult),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type NativeVerificationHandoff = typeof NativeVerificationHandoff.Type;

export const NativeVerificationAction = Schema.Union([
  Schema.Struct({ type: Schema.Literal("prepare"), handoff: NativeVerificationHandoff }),
  Schema.Struct({ type: Schema.Literal("claim"), claim: NativeVerificationClaim }),
  Schema.Struct({ type: Schema.Literal("release"), claimId: TrimmedNonEmptyString }),
  Schema.Struct({ type: Schema.Literal("cancel") }),
  Schema.Struct({
    type: Schema.Literal("submit"),
    claimId: TrimmedNonEmptyString,
    result: NativeVerificationResult,
  }),
]);
export type NativeVerificationAction = typeof NativeVerificationAction.Type;

const target = { runId: TrimmedNonEmptyString, ticketId: TrimmedNonEmptyString };
export const NativeVerificationRequest = Schema.Union([
  Schema.Struct({ operation: Schema.Literal("capabilities") }),
  Schema.Struct({
    operation: Schema.Literal("prepare"),
    ...target,
    platforms: Schema.NonEmptyArray(NativeVerificationPlatform),
  }),
  Schema.Struct({
    operation: Schema.Literal("claim"),
    ...target,
    revision: Schema.Int,
    claim: NativeVerificationClaim,
  }),
  Schema.Struct({
    operation: Schema.Literal("release"),
    ...target,
    revision: Schema.Int,
    claimId: TrimmedNonEmptyString,
  }),
  Schema.Struct({ operation: Schema.Literal("cancel"), ...target, revision: Schema.Int }),
  Schema.Struct({
    operation: Schema.Literal("checkout"),
    handoff: NativeVerificationHandoff,
    projectId: ProjectId,
  }),
  Schema.Struct({ operation: Schema.Literal("report"), handoff: NativeVerificationHandoff }),
  Schema.Struct({ operation: Schema.Literal("release-check"), handoff: NativeVerificationHandoff }),
  Schema.Struct({
    operation: Schema.Literal("submit"),
    ...target,
    revision: Schema.Int,
    claimId: TrimmedNonEmptyString,
    result: NativeVerificationResult,
  }),
]);
export type NativeVerificationRequest = typeof NativeVerificationRequest.Type;

export const NativeVerificationResponse = Schema.Union([
  Schema.Struct({ type: Schema.Literal("handoff"), handoff: NativeVerificationHandoff }),
  Schema.Struct({
    type: Schema.Literal("checkout"),
    threadId: ThreadId,
    worktreePath: TrimmedNonEmptyString,
  }),
  Schema.Struct({ type: Schema.Literal("report"), result: NativeVerificationResult }),
  Schema.Struct({ type: Schema.Literal("idle") }),
  Schema.Struct({
    type: Schema.Literal("capabilities"),
    platforms: Schema.Array(NativeVerificationPlatform),
    projects: Schema.Array(Schema.Struct({ id: ProjectId, title: Schema.String })),
  }),
]);
export type NativeVerificationResponse = typeof NativeVerificationResponse.Type;

export class NativeVerificationError extends Schema.TaggedErrorClass<NativeVerificationError>()(
  "NativeVerificationError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 400 },
) {}
