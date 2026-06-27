import * as Schema from "effect/Schema";
import {
  IsoDateTime,
  NonNegativeInt,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "./baseSchemas.ts";
import { GitCommandError } from "./git.ts";
import { VcsError } from "./vcs.ts";

export const DevReviewId = TrimmedNonEmptyString.pipe(Schema.brand("DevReviewId"));
export type DevReviewId = typeof DevReviewId.Type;

export const DevReviewStatus = Schema.Literals([
  "pending",
  "running",
  "passed",
  "failed",
  "blocked",
]);
export type DevReviewStatus = typeof DevReviewStatus.Type;

export const DevReviewReplayStatus = Schema.Literals([
  "not-started",
  "recording",
  "saved",
  "failed",
]);
export type DevReviewReplayStatus = typeof DevReviewReplayStatus.Type;

export const DevReviewFindingSeverity = Schema.Literals(["blocker", "major", "minor", "note"]);
export type DevReviewFindingSeverity = typeof DevReviewFindingSeverity.Type;

export const DevReviewCheckStatus = Schema.Literals([
  "pending",
  "passed",
  "failed",
  "blocked",
  "not-applicable",
]);
export type DevReviewCheckStatus = typeof DevReviewCheckStatus.Type;

export const DevReviewVerdict = Schema.Literals(["pending", "passed", "failed", "blocked"]);
export type DevReviewVerdict = typeof DevReviewVerdict.Type;

export const DevReviewDocument = Schema.Struct({
  verdict: DevReviewVerdict,
  summary: Schema.String,
  checks: Schema.Array(
    Schema.Struct({
      id: TrimmedNonEmptyString,
      label: TrimmedNonEmptyString,
      status: DevReviewCheckStatus,
      notes: Schema.String,
    }),
  ),
  findings: Schema.Array(
    Schema.Struct({
      id: TrimmedNonEmptyString,
      severity: DevReviewFindingSeverity,
      title: TrimmedNonEmptyString,
      details: Schema.String,
      reproduction: Schema.String,
      evidenceIds: Schema.Array(TrimmedNonEmptyString),
    }),
  ),
  questions: Schema.Array(Schema.String),
  nextSteps: Schema.Array(Schema.String),
});
export type DevReviewDocument = typeof DevReviewDocument.Type;

export const DevReviewReplayMetadata = Schema.Struct({
  status: DevReviewReplayStatus,
  eventCount: NonNegativeInt,
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
  durationMs: Schema.NullOr(NonNegativeInt),
  error: Schema.NullOr(Schema.String),
});
export type DevReviewReplayMetadata = typeof DevReviewReplayMetadata.Type;

export const DevReviewRecord = Schema.Struct({
  id: DevReviewId,
  sourceThreadId: ThreadId,
  reviewThreadId: ThreadId,
  sourceTurnId: Schema.NullOr(TurnId),
  status: DevReviewStatus,
  document: DevReviewDocument,
  replay: DevReviewReplayMetadata,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type DevReviewRecord = typeof DevReviewRecord.Type;

export const DevReviewReplayAppendEventsInput = Schema.Struct({
  reviewId: DevReviewId,
  events: Schema.Array(Schema.Unknown),
});
export type DevReviewReplayAppendEventsInput = typeof DevReviewReplayAppendEventsInput.Type;

export const DevReviewReplayAppendEventsResult = DevReviewReplayMetadata;
export type DevReviewReplayAppendEventsResult = typeof DevReviewReplayAppendEventsResult.Type;

export const DevReviewReplayGetInput = Schema.Struct({
  reviewId: DevReviewId,
});
export type DevReviewReplayGetInput = typeof DevReviewReplayGetInput.Type;

export const DevReviewReplayGetResult = Schema.Struct({
  reviewId: DevReviewId,
  events: Schema.Array(Schema.Unknown),
});
export type DevReviewReplayGetResult = typeof DevReviewReplayGetResult.Type;

export class DevReviewReplayError extends Schema.TaggedErrorClass<DevReviewReplayError>()(
  "DevReviewReplayError",
  {
    reviewId: Schema.optional(DevReviewId),
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export const ReviewDiffPreviewInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  baseRef: Schema.optional(TrimmedNonEmptyString),
  ignoreWhitespace: Schema.optionalKey(Schema.Boolean),
});
export type ReviewDiffPreviewInput = typeof ReviewDiffPreviewInput.Type;

export const ReviewDiffPreviewSourceKind = Schema.Literals(["working-tree", "branch-range"]);
export type ReviewDiffPreviewSourceKind = typeof ReviewDiffPreviewSourceKind.Type;

export const ReviewDiffPreviewSource = Schema.Struct({
  id: TrimmedNonEmptyString,
  kind: ReviewDiffPreviewSourceKind,
  title: TrimmedNonEmptyString,
  baseRef: Schema.NullOr(TrimmedNonEmptyString),
  headRef: Schema.NullOr(TrimmedNonEmptyString),
  diff: Schema.String,
  diffHash: TrimmedNonEmptyString,
  truncated: Schema.Boolean,
});
export type ReviewDiffPreviewSource = typeof ReviewDiffPreviewSource.Type;

export const ReviewDiffPreviewResult = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  generatedAt: Schema.DateTimeUtc,
  sources: Schema.Array(ReviewDiffPreviewSource),
});
export type ReviewDiffPreviewResult = typeof ReviewDiffPreviewResult.Type;

export const ReviewDiffPreviewError = Schema.Union([VcsError, GitCommandError]);
export type ReviewDiffPreviewError = typeof ReviewDiffPreviewError.Type;
