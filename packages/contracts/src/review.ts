import * as Schema from "effect/Schema";
import {
  GitRefName,
  IsoDateTime,
  NonNegativeInt,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "./baseSchemas.ts";
import { GitCommandError } from "./git.ts";
import { VcsError } from "./vcs.ts";

export const AppReviewId = TrimmedNonEmptyString.pipe(Schema.brand("AppReviewId"));
export type AppReviewId = typeof AppReviewId.Type;

/**
 * Environment variables App Review sets when it runs an E2E command. The preview
 * URL is the target under review, so a suite that tests a deployed frontend hits
 * the stack being reviewed instead of a hardcoded default.
 */
export const APP_REVIEW_PREVIEW_URL_ENV = "APP_REVIEW_PREVIEW_URL";

/** Comma-separated platforms passed to E2E commands and readiness checks. */
export const APP_REVIEW_TEST_PLATFORMS_ENV = "APP_REVIEW_TEST_PLATFORMS";

/**
 * Stacks controller ID of the App Stack serving `APP_REVIEW_PREVIEW_URL`, set
 * for E2E commands when the reviewed worktree has one. Suites that drive the
 * stack itself read it with the `APP_DEV_STACK_API_*` credentials.
 */
export const APP_REVIEW_STACK_ID_ENV = "APP_REVIEW_STACK_ID";

/** Review-owned persistent directory for suites to publish builds and qualification receipts. */
export const APP_REVIEW_ARTIFACT_DIR_ENV = "APP_REVIEW_ARTIFACT_DIR";

/** The commit a change branched from, so `e2eAffectedCommands` can select affected tests. */
export const APP_REVIEW_BASE_REF_ENV = "APP_REVIEW_BASE_REF";

/**
 * `e2eCommands` recording contract: add `APP_REVIEW_RECORDER_SCRIPT` as an init
 * script and expose `APP_REVIEW_RECORDER_BINDING`, which appends each batch as a
 * JSON line to `<APP_REVIEW_RECORDING_DIR>/<test name>.rrweb.jsonl`.
 */
export const APP_REVIEW_RECORDING_DIR_ENV = "APP_REVIEW_RECORDING_DIR";
export const APP_REVIEW_RECORDER_SCRIPT_ENV = "APP_REVIEW_RECORDER_SCRIPT";
export const APP_REVIEW_RECORDER_BINDING_ENV = "APP_REVIEW_RECORDER_BINDING";
export const APP_REVIEW_TEST_RECORDING_SUFFIX = ".rrweb.jsonl";

/**
 * What an App Review verifies: E2E test commands, the app in the preview
 * browser, or both. It decides which evidence a passed verdict needs.
 */
export const AppReviewScope = Schema.Literals(["e2e", "browser", "both"]);
export type AppReviewScope = typeof AppReviewScope.Type;

/** One test's rrweb event log, collected from the command's recording directory. */
export const AppReviewTestRecording = Schema.Struct({
  id: TrimmedNonEmptyString,
  /** The recording's file name without its suffix; suites name files after tests. */
  label: TrimmedNonEmptyString,
  path: TrimmedNonEmptyString,
  sizeBytes: NonNegativeInt,
});
export type AppReviewTestRecording = typeof AppReviewTestRecording.Type;

export const AppReviewTestResult = Schema.Struct({
  command: TrimmedNonEmptyString,
  executedCommand: TrimmedNonEmptyString,
  status: Schema.Literals(["passed", "failed"]),
  outputMarkdown: Schema.String,
  recordings: Schema.optionalKey(Schema.Array(AppReviewTestRecording)),
  completedAt: IsoDateTime,
});
export type AppReviewTestResult = typeof AppReviewTestResult.Type;

export const AppReviewStatus = Schema.Literals(["pending", "running", "passed", "failed"]);
export type AppReviewStatus = typeof AppReviewStatus.Type;

export const AppReviewRecordingStatus = Schema.Literals([
  "not-started",
  "recording",
  "saved",
  "failed",
]);
export type AppReviewRecordingStatus = typeof AppReviewRecordingStatus.Type;

export const AppReviewFindingSeverity = Schema.Literals(["blocker", "major", "minor", "note"]);
export type AppReviewFindingSeverity = typeof AppReviewFindingSeverity.Type;

export const AppReviewCheckStatus = Schema.Literals([
  "pending",
  "passed",
  "failed",
  "blocked",
  "not-applicable",
]);
export type AppReviewCheckStatus = typeof AppReviewCheckStatus.Type;

export const AppReviewVerdict = Schema.Literals(["pending", "passed", "failed"]);
export type AppReviewVerdict = typeof AppReviewVerdict.Type;

export const AppReviewCheck = Schema.Struct({
  id: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  status: AppReviewCheckStatus,
  /** Classifies blocked checks; older records may omit this field. */
  blockerKind: Schema.optionalKey(Schema.Literals(["external-prerequisite", "coverage-gap"])),
  notes: Schema.String,
  /** A test runner's inspectable web replay for this check, when it publishes one. */
  replayUrl: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isPattern(/^https?:\/\//i))),
  replayMimeType: Schema.optionalKey(TrimmedNonEmptyString),
});
export type AppReviewCheck = typeof AppReviewCheck.Type;

export const AppReviewDocument = Schema.Struct({
  /** What the review checks, as the agent stated it when the review started. */
  brief: Schema.optionalKey(Schema.String),
  verdict: AppReviewVerdict,
  summary: Schema.String,
  checks: Schema.Array(AppReviewCheck),
  findings: Schema.Array(
    Schema.Struct({
      id: TrimmedNonEmptyString,
      severity: AppReviewFindingSeverity,
      title: TrimmedNonEmptyString,
      details: Schema.String,
      reproduction: Schema.String,
      evidenceIds: Schema.Array(TrimmedNonEmptyString),
    }),
  ),
  questions: Schema.Array(Schema.String),
  nextSteps: Schema.Array(Schema.String),
});
export type AppReviewDocument = typeof AppReviewDocument.Type;

export const AppReviewRecordingEvidence = Schema.Struct({
  status: AppReviewRecordingStatus,
  path: Schema.NullOr(TrimmedNonEmptyString),
  mimeType: Schema.NullOr(TrimmedNonEmptyString),
  sizeBytes: Schema.NullOr(NonNegativeInt),
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
  error: Schema.NullOr(Schema.String),
});
export type AppReviewRecordingEvidence = typeof AppReviewRecordingEvidence.Type;

export const AppReviewScreenshotEvidence = Schema.Struct({
  id: TrimmedNonEmptyString,
  path: TrimmedNonEmptyString,
  mimeType: Schema.Literal("image/png"),
  caption: Schema.String,
  capturedAt: IsoDateTime,
});
export type AppReviewScreenshotEvidence = typeof AppReviewScreenshotEvidence.Type;

/**
 * What an App Review captured: one browser recording, a captioned screenshot
 * gallery (findings' `evidenceIds` reference screenshot ids), and the E2E
 * commands it ran with their per-test recordings, in run order.
 */
export const AppReviewEvidence = Schema.Struct({
  recording: AppReviewRecordingEvidence,
  screenshots: Schema.Array(AppReviewScreenshotEvidence),
  tests: Schema.optionalKey(Schema.Array(AppReviewTestResult)),
});
export type AppReviewEvidence = typeof AppReviewEvidence.Type;

export const hasCompleteAppReviewEvidence = (evidence: AppReviewEvidence): boolean =>
  evidence.recording.status === "saved" && evidence.screenshots.length > 0;

/** Evidence id used to mint asset URLs for the review's screen recording. */
export const APP_REVIEW_RECORDING_EVIDENCE_ID = "recording";

export const EMPTY_APP_REVIEW_EVIDENCE: AppReviewEvidence = {
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

export const AppReviewRecord = Schema.Struct({
  id: AppReviewId,
  sourceThreadId: ThreadId,
  reviewThreadId: ThreadId,
  /** Absent on older records, which require browser evidence. */
  appReviewScope: Schema.optionalKey(AppReviewScope),
  sourceTurnId: Schema.NullOr(TurnId),
  status: AppReviewStatus,
  document: AppReviewDocument,
  evidence: AppReviewEvidence,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type AppReviewRecord = typeof AppReviewRecord.Type;

export class AppReviewError extends Schema.TaggedError<AppReviewError>()("AppReviewError", {
  reviewId: Schema.optional(AppReviewId),
  message: TrimmedNonEmptyString,
  cause: Schema.optional(Schema.Defect()),
}) {}

// An object id or HEAD, never an option-looking ref, since it is passed to git as a revision.
const ReviewMergeBase = Schema.String.check(
  Schema.isPattern(/^(?:[0-9a-f]{40}|[0-9a-f]{64}|HEAD)$/),
);

export const ReviewDiffChangeType = Schema.Literals([
  "change",
  "rename-pure",
  "rename-changed",
  "new",
  "deleted",
]);
export type ReviewDiffChangeType = typeof ReviewDiffChangeType.Type;

export const ReviewDiffPreviewInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  baseRef: Schema.optional(GitRefName),
  // A branch-range file read reuses its preview's merge base instead of resolving it again.
  mergeBase: Schema.optionalKey(ReviewMergeBase),
  commitSha: Schema.optional(TrimmedNonEmptyString),
  ignoreWhitespace: Schema.optionalKey(Schema.Boolean),
  sourceKind: Schema.optionalKey(Schema.Literals(["working-tree", "branch-range"])),
  trackedOnly: Schema.optionalKey(Schema.Boolean),
  /** From a trackedOnly result, so the complete read adds only the untracked files. */
  completionToken: Schema.optionalKey(Schema.String),
  metadataOnly: Schema.optionalKey(Schema.Boolean),
  file: Schema.optionalKey(
    Schema.Struct({
      path: Schema.NonEmptyString,
      previousPath: Schema.NullOr(Schema.NonEmptyString),
      sourceKind: Schema.Literals(["working-tree", "branch-range", "commit"]),
      // The preview's change type; the server still confirms a tracked path before relying on it.
      changeType: Schema.optionalKey(ReviewDiffChangeType),
    }),
  ),
});
export type ReviewDiffPreviewInput = typeof ReviewDiffPreviewInput.Type;

export const ReviewBranchCommitsInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  baseRef: Schema.optional(GitRefName),
});
export type ReviewBranchCommitsInput = typeof ReviewBranchCommitsInput.Type;

export const ReviewBranchCommitsResult = Schema.Struct({
  commits: Schema.Array(
    Schema.Struct({
      sha: Schema.String,
      subject: Schema.String,
      committedAt: Schema.String,
    }),
  ),
  truncated: Schema.Boolean,
});
export type ReviewBranchCommitsResult = typeof ReviewBranchCommitsResult.Type;

export const ReviewDiffPreviewSourceKind = Schema.Literals([
  "working-tree",
  "branch-range",
  "commit",
]);
export type ReviewDiffPreviewSourceKind = typeof ReviewDiffPreviewSourceKind.Type;

export const ReviewDiffFileStat = Schema.Struct({
  path: Schema.String,
  previousPath: Schema.NullOr(Schema.String),
  // Older servers omit it.
  changeType: Schema.optionalKey(ReviewDiffChangeType),
  additions: Schema.Number,
  deletions: Schema.Number,
});
export type ReviewDiffFileStat = typeof ReviewDiffFileStat.Type;

export const ReviewDiffPreviewSource = Schema.Struct({
  id: TrimmedNonEmptyString,
  kind: ReviewDiffPreviewSourceKind,
  title: TrimmedNonEmptyString,
  commitSubject: Schema.optionalKey(TrimmedNonEmptyString),
  baseRef: Schema.NullOr(GitRefName),
  headRef: Schema.NullOr(GitRefName),
  // Branch-range only; older servers omit it.
  mergeBase: Schema.optionalKey(ReviewMergeBase),
  diff: Schema.String,
  diffHash: TrimmedNonEmptyString,
  truncated: Schema.Boolean,
  patchesDeferred: Schema.optionalKey(Schema.Boolean),
  files: Schema.optionalKey(Schema.Array(ReviewDiffFileStat)),
});
export type ReviewDiffPreviewSource = typeof ReviewDiffPreviewSource.Type;

export const ReviewDiffFileContentsInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  sourceKind: ReviewDiffPreviewSourceKind,
  changeType: ReviewDiffChangeType,
  baseRef: Schema.NullOr(GitRefName),
  headRef: Schema.NullOr(GitRefName),
  oldPath: Schema.NonEmptyString,
  newPath: Schema.NonEmptyString,
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
  incomplete: Schema.optionalKey(Schema.Boolean),
  completionToken: Schema.optionalKey(Schema.String),
});
export type ReviewDiffPreviewResult = typeof ReviewDiffPreviewResult.Type;

export const ReviewDiffPreviewError = Schema.Union([VcsError, GitCommandError]);
export type ReviewDiffPreviewError = typeof ReviewDiffPreviewError.Type;
