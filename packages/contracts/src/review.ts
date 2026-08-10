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

export const DevReviewRecordingStatus = Schema.Literals([
  "not-started",
  "recording",
  "saved",
  "failed",
]);
export type DevReviewRecordingStatus = typeof DevReviewRecordingStatus.Type;

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

export const DevReviewRecordingEvidence = Schema.Struct({
  status: DevReviewRecordingStatus,
  path: Schema.NullOr(TrimmedNonEmptyString),
  mimeType: Schema.NullOr(TrimmedNonEmptyString),
  sizeBytes: Schema.NullOr(NonNegativeInt),
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
  error: Schema.NullOr(Schema.String),
});
export type DevReviewRecordingEvidence = typeof DevReviewRecordingEvidence.Type;

export const DevReviewScreenshotEvidence = Schema.Struct({
  id: TrimmedNonEmptyString,
  path: TrimmedNonEmptyString,
  mimeType: Schema.Literal("image/png"),
  caption: Schema.String,
  capturedAt: IsoDateTime,
});
export type DevReviewScreenshotEvidence = typeof DevReviewScreenshotEvidence.Type;

/**
 * Browser evidence captured during a Dev Review: one screen recording plus a
 * captioned screenshot gallery (gallery order = array order; findings'
 * `evidenceIds` reference screenshot ids).
 */
export const DevReviewEvidence = Schema.Struct({
  recording: DevReviewRecordingEvidence,
  screenshots: Schema.Array(DevReviewScreenshotEvidence),
});
export type DevReviewEvidence = typeof DevReviewEvidence.Type;

/** Evidence id used to mint asset URLs for the review's screen recording. */
export const DEV_REVIEW_RECORDING_EVIDENCE_ID = "recording";

export const EMPTY_DEV_REVIEW_EVIDENCE: DevReviewEvidence = {
  recording: {
    status: "not-started",
    path: null,
    mimeType: null,
    sizeBytes: null,
    startedAt: null,
    completedAt: null,
    error: null,
  },
  screenshots: [],
};

/**
 * The proposed plan a Dev Review anchors to when no Spec exists. Specs anchor
 * reviews through their planning tickets; fast-feature and plan-mode threads
 * only have a proposed plan, so the plan itself is the review's anchor node.
 */
export const DevReviewSourceProposedPlan = Schema.Struct({
  threadId: ThreadId,
  planId: TrimmedNonEmptyString,
});
export type DevReviewSourceProposedPlan = typeof DevReviewSourceProposedPlan.Type;

export const DevReviewRecord = Schema.Struct({
  id: DevReviewId,
  sourceThreadId: ThreadId,
  reviewThreadId: ThreadId,
  planningTicketIds: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
  sourceProposedPlan: Schema.optionalKey(DevReviewSourceProposedPlan),
  sourceTurnId: Schema.NullOr(TurnId),
  status: DevReviewStatus,
  document: DevReviewDocument,
  evidence: DevReviewEvidence,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type DevReviewRecord = typeof DevReviewRecord.Type;

export class DevReviewError extends Schema.TaggedErrorClass<DevReviewError>()("DevReviewError", {
  reviewId: Schema.optional(DevReviewId),
  message: TrimmedNonEmptyString,
  cause: Schema.optional(Schema.Defect()),
}) {}

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

export const ReviewDiffFileContentsInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  sourceKind: ReviewDiffPreviewSourceKind,
  changeType: Schema.Literals(["change", "rename-pure", "rename-changed", "new", "deleted"]),
  baseRef: Schema.NullOr(TrimmedNonEmptyString),
  headRef: Schema.NullOr(TrimmedNonEmptyString),
  oldPath: TrimmedNonEmptyString,
  newPath: TrimmedNonEmptyString,
});
export type ReviewDiffFileContentsInput = typeof ReviewDiffFileContentsInput.Type;

export const ReviewDiffFileContentsResult = Schema.Struct({
  oldContents: Schema.String,
  newContents: Schema.String,
});
export type ReviewDiffFileContentsResult = typeof ReviewDiffFileContentsResult.Type;

export const ReviewDiffPreviewResult = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  generatedAt: Schema.DateTimeUtc,
  sources: Schema.Array(ReviewDiffPreviewSource),
});
export type ReviewDiffPreviewResult = typeof ReviewDiffPreviewResult.Type;

export const ReviewDiffPreviewError = Schema.Union([VcsError, GitCommandError]);
export type ReviewDiffPreviewError = typeof ReviewDiffPreviewError.Type;
