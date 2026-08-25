import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "./baseSchemas.ts";
import { GitCommandError } from "./git.ts";
import { VcsError } from "./vcs.ts";

export const AppReviewId = TrimmedNonEmptyString.pipe(Schema.brand("AppReviewId"));
export type AppReviewId = typeof AppReviewId.Type;

/**
 * Environment variable App Review sets when running a project's `e2eCommands`:
 * the review's authoritative preview target, so a suite that tests a deployed
 * frontend hits the stack under review (per-ticket stacks included) instead of
 * a hardcoded default.
 */
export const APP_REVIEW_PREVIEW_URL_ENV = "APP_REVIEW_PREVIEW_URL";

/**
 * How an App Review verifies its target: the project's e2e commands only, the
 * browser only, or both. Tickets carry it as `appReviewScope` next to
 * `appReviewEligible`; absent means both. A run whose project declares no
 * `e2eCommands` degrades to browser whatever the scope says.
 */
export const AppReviewScope = Schema.Literals(["e2e", "browser", "both"]);
export type AppReviewScope = typeof AppReviewScope.Type;

/** Default and hard limit for complete review, gap-analysis, and implementation cycles. */
export const APP_REVIEW_WORKFLOW_DEFAULT_CYCLES = 10;
export const APP_REVIEW_WORKFLOW_MAX_CYCLES = 10;

export const AppReviewWorkflowRunId = TrimmedNonEmptyString.pipe(
  Schema.brand("AppReviewWorkflowRunId"),
);
export type AppReviewWorkflowRunId = typeof AppReviewWorkflowRunId.Type;

const BoundedAppReviewWorkflowCycleBudget = PositiveInt.check(
  Schema.isLessThanOrEqualTo(APP_REVIEW_WORKFLOW_MAX_CYCLES),
);
export const AppReviewWorkflowCycleBudget = PositiveInt.pipe(
  Schema.decodeTo(
    BoundedAppReviewWorkflowCycleBudget,
    SchemaTransformation.transform({
      decode: (value) => Math.min(value, APP_REVIEW_WORKFLOW_MAX_CYCLES),
      encode: (value) => value,
    }),
  ),
);
export type AppReviewWorkflowCycleBudget = typeof AppReviewWorkflowCycleBudget.Type;

export const AppReviewWorkflowOutcome = Schema.Literals(["passed", "failed", "exhausted"]);
export type AppReviewWorkflowOutcome = typeof AppReviewWorkflowOutcome.Type;

export const AppReviewWorkflowRunStatus = Schema.Literals([
  "running",
  "passed",
  "failed",
  "exhausted",
]);
export type AppReviewWorkflowRunStatus = typeof AppReviewWorkflowRunStatus.Type;

export const AppReviewWorkflowPhase = Schema.Literals(["review", "planning", "fixing"]);
export type AppReviewWorkflowPhase = typeof AppReviewWorkflowPhase.Type;

export const AppReviewWorkflowCaller = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("standalone"),
    sourceThreadId: ThreadId,
  }),
  Schema.Struct({
    type: Schema.Literal("implementation"),
    implementationRunId: TrimmedNonEmptyString,
    orchestratorThreadId: ThreadId,
    ticketId: Schema.optionalKey(TrimmedNonEmptyString),
  }),
]);
export type AppReviewWorkflowCaller = typeof AppReviewWorkflowCaller.Type;

/** HEAD plus ReviewService's two canonical diff hashes. */
export const AppReviewWorkflowWorkspaceRevision = Schema.Struct({
  headSha: TrimmedNonEmptyString,
  workingTreeDiffHash: TrimmedNonEmptyString,
  branchDiffHash: TrimmedNonEmptyString,
  fingerprint: TrimmedNonEmptyString,
});
export type AppReviewWorkflowWorkspaceRevision = typeof AppReviewWorkflowWorkspaceRevision.Type;

export const AppReviewWorkflowFixValidation = Schema.Struct({
  command: TrimmedNonEmptyString,
  status: Schema.Literals(["passed", "failed"]),
  outputMarkdown: Schema.String,
  completedAt: IsoDateTime,
});
export type AppReviewWorkflowFixValidation = typeof AppReviewWorkflowFixValidation.Type;

export const AppReviewWorkflowFixResult = Schema.Struct({
  runId: AppReviewWorkflowRunId,
  planId: TrimmedNonEmptyString,
  status: Schema.Literals(["succeeded", "failed", "blocked"]),
  commitSha: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
  validations: Schema.Array(AppReviewWorkflowFixValidation),
  notesMarkdown: Schema.String,
});
export type AppReviewWorkflowFixResult = typeof AppReviewWorkflowFixResult.Type;

export const AppReviewWorkflowRepairTicket = Schema.Struct({
  key: TrimmedNonEmptyString,
  parentTicketKey: Schema.NullOr(TrimmedNonEmptyString),
  title: TrimmedNonEmptyString,
  bodyMarkdown: TrimmedNonEmptyString,
  dependencyKeys: Schema.Array(TrimmedNonEmptyString),
});
export type AppReviewWorkflowRepairTicket = typeof AppReviewWorkflowRepairTicket.Type;

export const AppReviewWorkflowFailureReason = Schema.Literals([
  "review-blocked",
  "plan-missing",
  "plan-malformed",
  "fixer-failed",
  "workspace-stale",
  "automation-unavailable",
  "unexpected-approval",
  "unexpected-user-input",
  "embedded-worktree-dirty",
  "embedded-head-mismatch",
  "preview-unavailable",
  "unknown",
]);
export type AppReviewWorkflowFailureReason = typeof AppReviewWorkflowFailureReason.Type;

export const AppReviewWorkflowFailure = Schema.Struct({
  reason: AppReviewWorkflowFailureReason,
  phase: Schema.NullOr(AppReviewWorkflowPhase),
  cycleNumber: Schema.NullOr(PositiveInt),
  detailMarkdown: TrimmedNonEmptyString,
  failedAt: IsoDateTime,
});
export type AppReviewWorkflowFailure = typeof AppReviewWorkflowFailure.Type;

export const AppReviewWorkflowCycleStatus = Schema.Literals([
  "reviewing",
  "review-failed",
  "planning",
  "fixing",
  "completed",
  /** Automation could not complete the cycle after bounded in-cycle phase retries. */
  "failed",
]);
export type AppReviewWorkflowCycleStatus = typeof AppReviewWorkflowCycleStatus.Type;

export const AppReviewWorkflowCycle = Schema.Struct({
  cycleNumber: PositiveInt,
  status: AppReviewWorkflowCycleStatus,
  reviewId: AppReviewId,
  reviewerThreadId: ThreadId,
  /** Provider launches for the current phase. Runtime failures retry in-cycle. */
  reviewLaunchCount: Schema.optionalKey(NonNegativeInt),
  planningLaunchCount: Schema.optionalKey(NonNegativeInt),
  fixingLaunchCount: Schema.optionalKey(NonNegativeInt),
  /** One-time same-thread continuations claimed while recovering a terminal phase. */
  recoveryContinuationCount: Schema.optionalKey(NonNegativeInt),
  /** Older phase threads replaced by an in-cycle retry. */
  supersededThreadIds: Schema.optionalKey(Schema.Array(ThreadId)),
  reviewVerdict: Schema.NullOr(Schema.Literals(["pending", "passed", "failed"])),
  actionableFindingsMarkdown: Schema.NullOr(Schema.String),
  planId: Schema.NullOr(TrimmedNonEmptyString),
  /**
   * The thread that runs gap analysis and writes the cycle's repair tickets.
   * Absent on cycles recorded before gap analysis moved out of the reviewer
   * thread; those still reconcile against `reviewerThreadId`.
   */
  plannerThreadId: Schema.optionalKey(Schema.NullOr(ThreadId)),
  plannerTurnId: Schema.NullOr(TurnId),
  fixerThreadId: Schema.NullOr(ThreadId),
  repairTickets: Schema.optionalKey(Schema.Array(AppReviewWorkflowRepairTicket)),
  ticketingTurnId: Schema.optionalKey(Schema.NullOr(TurnId)),
  fixResult: Schema.NullOr(AppReviewWorkflowFixResult),
  /**
   * The latest phase failure. A successful phase clears it. The run keeps the
   * final failure here when a phase exhausts its launch limit.
   */
  failure: Schema.optionalKey(Schema.NullOr(AppReviewWorkflowFailure)),
  workspaceRevision: AppReviewWorkflowWorkspaceRevision,
  startedAt: IsoDateTime,
  completedAt: Schema.NullOr(IsoDateTime),
});
export type AppReviewWorkflowCycle = typeof AppReviewWorkflowCycle.Type;

export const AppReviewWorkflowRun = Schema.Struct({
  id: AppReviewWorkflowRunId,
  targetThreadId: ThreadId,
  controllerThreadId: ThreadId,
  caller: AppReviewWorkflowCaller,
  briefMarkdown: TrimmedNonEmptyString,
  supportingContextMarkdown: Schema.NullOr(Schema.String),
  previewTargets: Schema.Array(TrimmedNonEmptyString),
  /**
   * Set when the user named the target themselves. A pinned run reviews
   * exactly `previewTargets`; an unpinned one resolves the worktree's App Dev
   * Stack first and falls back to those targets only when no stack matches.
   */
  previewTargetsPinned: Schema.optionalKey(Schema.Boolean),
  /**
   * Set when the run stops after gap analysis instead of repairing what it
   * found. It still spends its one cycle on the browser review and the repair
   * tickets, and then ends `exhausted` with those findings unresolved, the
   * same way a budget that runs out on a failing review does.
   */
  reviewOnly: Schema.optionalKey(Schema.Boolean),
  /** How this run verifies its target; absent means e2e and browser both. */
  appReviewScope: Schema.optionalKey(AppReviewScope),
  cycleBudget: AppReviewWorkflowCycleBudget.pipe(
    Schema.withDecodingDefault(Effect.succeed(APP_REVIEW_WORKFLOW_DEFAULT_CYCLES)),
  ),
  cyclesUsed: NonNegativeInt,
  status: AppReviewWorkflowRunStatus,
  cycles: Schema.Array(AppReviewWorkflowCycle),
  activePhase: Schema.NullOr(AppReviewWorkflowPhase),
  activeThreadId: Schema.NullOr(ThreadId),
  workspaceRevision: AppReviewWorkflowWorkspaceRevision,
  finalHeadSha: Schema.NullOr(TrimmedNonEmptyString),
  outcome: Schema.NullOr(AppReviewWorkflowOutcome),
  failure: Schema.NullOr(AppReviewWorkflowFailure),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  completedAt: Schema.NullOr(IsoDateTime),
});
export type AppReviewWorkflowRun = typeof AppReviewWorkflowRun.Type;

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

/**
 * One acceptance check in a review's matrix.
 *
 * `carriedFromCycle` names the earlier cycle of the same run whose pass still
 * stands, and is set only when this cycle did not exercise the check again. A
 * repair usually cannot reach most of what already passed, and re-driving the
 * whole flow through the browser every cycle is the run's biggest cost, so a
 * carried check keeps the matrix complete without paying for it twice. The
 * absence of the field means the browser did the work this cycle.
 */
export const AppReviewCheck = Schema.Struct({
  id: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  status: AppReviewCheckStatus,
  notes: Schema.String,
  carriedFromCycle: Schema.optionalKey(PositiveInt),
});
export type AppReviewCheck = typeof AppReviewCheck.Type;

export const AppReviewDocument = Schema.Struct({
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
 * Browser evidence captured during an App Review: one screen recording plus a
 * captioned screenshot gallery (gallery order = array order; findings'
 * `evidenceIds` reference screenshot ids).
 */
export const AppReviewEvidence = Schema.Struct({
  recording: AppReviewRecordingEvidence,
  screenshots: Schema.Array(AppReviewScreenshotEvidence),
});
export type AppReviewEvidence = typeof AppReviewEvidence.Type;

export const hasCompleteAppReviewEvidence = (evidence: AppReviewEvidence): boolean =>
  evidence.recording.status === "saved" && evidence.screenshots.length > 0;

/**
 * A failed recording must not erase product defects that have independent durable evidence.
 * Every actionable finding stays traceable to a captured screenshot and the check matrix records
 * at least one actual failure, so orchestration can safely repair rather than retrying tooling.
 */
export const hasScreenshotBackedAppReviewFailure = (
  document: AppReviewDocument,
  evidence: AppReviewEvidence,
): boolean => {
  const screenshotIds = new Set(evidence.screenshots.map((screenshot) => screenshot.id));
  return (
    document.checks.some((check) => check.status === "failed") &&
    document.findings.length > 0 &&
    document.findings.every((finding) =>
      finding.evidenceIds.some((evidenceId) => screenshotIds.has(evidenceId)),
    )
  );
};

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

/**
 * The proposed plan an App Review anchors to when no Spec exists. Specs anchor
 * reviews through their planning tickets; fast-feature and plan-mode threads
 * only have a proposed plan, so the plan itself is the review's anchor node.
 */
export const AppReviewSourceProposedPlan = Schema.Struct({
  threadId: ThreadId,
  planId: TrimmedNonEmptyString,
});
export type AppReviewSourceProposedPlan = typeof AppReviewSourceProposedPlan.Type;

export const AppReviewRecord = Schema.Struct({
  id: AppReviewId,
  sourceThreadId: ThreadId,
  reviewThreadId: ThreadId,
  planningTicketIds: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
  sourceProposedPlan: Schema.optionalKey(AppReviewSourceProposedPlan),
  sourceTurnId: Schema.NullOr(TurnId),
  status: AppReviewStatus,
  document: AppReviewDocument,
  evidence: AppReviewEvidence,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type AppReviewRecord = typeof AppReviewRecord.Type;

export class AppReviewError extends Schema.TaggedErrorClass<AppReviewError>()("AppReviewError", {
  reviewId: Schema.optional(AppReviewId),
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
