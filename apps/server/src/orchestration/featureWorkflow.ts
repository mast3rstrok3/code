import {
  AppReviewId,
  type AppReviewStatus,
  MessageId,
  ThreadId,
  type OrchestrationV2Run,
  type PlanId,
  type RuntimeRequestId,
} from "@t3tools/contracts";

import { extractJsonFenceBlocks } from "./workflowDirectives.ts";

/**
 * The Feature workflow (`fast-plan`) runs in one thread and one worktree:
 * native Plan mode, an implement turn, Code Review cycles in reviewer child
 * threads whose findings the Feature thread fixes, App Review cycles in which
 * a reviewer drives the App Stack in the preview browser and records it, then
 * a pull-request turn.
 * Every step is a message or thread with an ID derived from the plan, so the
 * state below is read back from the thread itself and each step starts once.
 */

export const FEATURE_CODE_REVIEW_RESULT_TYPE = "feature-code-review-result";

const REVIEW_THREAD_SEPARATOR = "::feature-review::";
const APP_REVIEW_THREAD_SEPARATOR = "::feature-app-review::";

export function featureImplementMessageId(threadId: ThreadId, planId: PlanId): MessageId {
  return MessageId.make(`feature-implement:${threadId}:${planId}`);
}

export function featureFixMessageId(threadId: ThreadId, planId: PlanId, cycle: number): MessageId {
  return MessageId.make(`feature-fix:${threadId}:${planId}:${cycle}`);
}

export function featurePullRequestMessageId(threadId: ThreadId, planId: PlanId): MessageId {
  return MessageId.make(`feature-pull-request:${threadId}:${planId}`);
}

export function featureReviewThreadId(threadId: ThreadId, planId: PlanId, cycle: number): ThreadId {
  return ThreadId.make(`${threadId}${REVIEW_THREAD_SEPARATOR}${planId}::${cycle}`);
}

export function featureReviewMessageId(reviewThreadId: ThreadId): MessageId {
  return MessageId.make(`feature-review:${reviewThreadId}`);
}

export function featureAppReviewThreadId(
  threadId: ThreadId,
  planId: PlanId,
  cycle: number,
): ThreadId {
  return ThreadId.make(`${threadId}${APP_REVIEW_THREAD_SEPARATOR}${planId}::${cycle}`);
}

export function featureAppReviewId(threadId: ThreadId, planId: PlanId, cycle: number): AppReviewId {
  return AppReviewId.make(`feature-app-review:${threadId}:${planId}:${cycle}`);
}

export function featureAppReviewMessageId(appReviewThreadId: ThreadId): MessageId {
  return MessageId.make(`feature-app-review:${appReviewThreadId}`);
}

export function featureAppReviewFixMessageId(
  threadId: ThreadId,
  planId: PlanId,
  cycle: number,
): MessageId {
  return MessageId.make(`feature-app-review-fix:${threadId}:${planId}:${cycle}`);
}

/** The Feature thread a Code Review or App Review thread belongs to, or null for any other thread. */
export function featureRootOfReviewThread(threadId: ThreadId): ThreadId | null {
  for (const separator of [REVIEW_THREAD_SEPARATOR, APP_REVIEW_THREAD_SEPARATOR]) {
    const index = threadId.indexOf(separator);
    if (index > 0) return ThreadId.make(threadId.slice(0, index));
  }
  return null;
}

export interface FeatureReviewResult {
  readonly status: "clean" | "findings";
  readonly reportMarkdown: string;
}

/**
 * The reviewer's verdict from its final message. A reviewer that finished
 * without one is treated as reporting findings, so the loop keeps moving and
 * the pull request names what went wrong.
 */
export function parseFeatureReviewResult(text: string | null): FeatureReviewResult {
  for (const block of [...extractJsonFenceBlocks(text ?? "")].toReversed()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(block);
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== "object") continue;
    const record = parsed as Record<string, unknown>;
    if (record["type"] !== FEATURE_CODE_REVIEW_RESULT_TYPE) continue;
    const status = record["status"];
    const report = typeof record["reportMarkdown"] === "string" ? record["reportMarkdown"] : "";
    if (status === "clean") return { status: "clean", reportMarkdown: report };
    if (status === "findings") {
      return {
        status: "findings",
        reportMarkdown: report.trim() || "The reviewer reported findings without describing them.",
      };
    }
  }
  return {
    status: "findings",
    reportMarkdown: [
      "The reviewer finished without a feature-code-review-result. Its last message:",
      "",
      text?.trim() || "(empty)",
    ].join("\n"),
  };
}

/** Answers a planning question without a human: the first option, else best judgment. */
export function resolvePlanQuestionAnswers(payload: unknown): Readonly<Record<string, string>> {
  if (payload === null || typeof payload !== "object") return {};
  const questions = (payload as Record<string, unknown>).questions;
  if (!Array.isArray(questions)) return {};
  return Object.fromEntries(
    questions.flatMap((candidate) => {
      if (candidate === null || typeof candidate !== "object") return [];
      const question = candidate as Record<string, unknown>;
      const id = typeof question.id === "string" ? question.id : null;
      if (id === null) return [];
      const options = Array.isArray(question.options)
        ? question.options.flatMap((option) => {
            if (option === null || typeof option !== "object") return [];
            const label = (option as Record<string, unknown>).label;
            return typeof label === "string" && label.length > 0 ? [label] : [];
          })
        : [];
      const recommendation =
        question.recommendation !== null && typeof question.recommendation === "object"
          ? (question.recommendation as Record<string, unknown>).optionLabel
          : undefined;
      const answer =
        typeof recommendation === "string" && options.includes(recommendation)
          ? recommendation
          : (options[0] ?? "Use your best judgment and continue.");
      return [[id, answer] as const];
    }),
  );
}

export interface FeatureReviewState {
  /** Null while the reviewer thread has no run yet. */
  readonly runStatus: OrchestrationV2Run["status"] | null;
  /** The reviewer's final assistant message, once its run completed. */
  readonly finalText: string | null;
}

export interface FeatureAppReviewState {
  /** Null while the reviewer thread has no run yet. */
  readonly runStatus: OrchestrationV2Run["status"] | null;
  /** The App Review record's status, which the reviewer sets with its verdict. */
  readonly recordStatus: AppReviewStatus | null;
  /** The reviewer's summary and findings, handed to the Feature thread when it failed. */
  readonly reportMarkdown: string;
}

/** How App Review ended, which the pull request reports. */
export type FeatureAppReviewOutcome =
  | { readonly status: "passed"; readonly cycle: number }
  | { readonly status: "unresolved"; readonly reportMarkdown: string }
  | { readonly status: "skipped"; readonly cycle: number; readonly reason: string };

export interface FeatureWorkflowState {
  readonly threadId: ThreadId;
  readonly interactionMode: string;
  readonly runs: ReadonlyArray<
    Pick<OrchestrationV2Run, "id" | "ordinal" | "status" | "userMessageId" | "sourcePlanRef">
  >;
  readonly plans: ReadonlyArray<{
    readonly id: PlanId;
    readonly kind: string;
    readonly status: string;
    readonly runId: string | null;
  }>;
  readonly pendingQuestions: ReadonlyArray<{
    readonly requestId: RuntimeRequestId;
    readonly questions: ReadonlyArray<unknown>;
  }>;
  /** Reviews of the plan being implemented, cycle 1 first, up to the first one not started. */
  readonly reviews: ReadonlyArray<FeatureReviewState>;
  readonly cycleBudget: number;
  /** App Reviews of the plan being implemented, cycle 1 first, up to the first one not started. */
  readonly appReviews: ReadonlyArray<FeatureAppReviewState>;
  readonly appReviewCycleBudget: number;
  /** Why the next App Review cycle cannot run, once its launch found out. */
  readonly appReviewSkippedReason: string | null;
  readonly pullRequestLinked: boolean;
  /** Whether this plan's workflow already finished (stacks stopped, thread settled). */
  readonly completed: boolean;
}

export type FeatureWorkflowAction =
  | {
      readonly type: "answer-questions";
      readonly requestId: RuntimeRequestId;
      readonly answers: Readonly<Record<string, string>>;
    }
  | { readonly type: "implement"; readonly planId: PlanId }
  | { readonly type: "review"; readonly planId: PlanId; readonly cycle: number }
  | {
      readonly type: "fix";
      readonly planId: PlanId;
      readonly cycle: number;
      readonly reportMarkdown: string;
    }
  | { readonly type: "app-review"; readonly planId: PlanId; readonly cycle: number }
  | {
      readonly type: "app-review-fix";
      readonly planId: PlanId;
      readonly cycle: number;
      readonly reportMarkdown: string;
    }
  | {
      readonly type: "open-pull-request";
      readonly planId: PlanId;
      readonly unresolvedFindingsMarkdown: string | null;
      readonly appReview: FeatureAppReviewOutcome;
    }
  | {
      readonly type: "complete";
      readonly planId: PlanId;
      /** Why the workflow ended: its pull request is linked, or the plan needed no change. */
      readonly reason: FeatureCompletionReason;
    };

export type FeatureCompletionReason = "pull-request-linked" | "no-changes";

/** The run with the highest ordinal, which is the latest one. */
export function latestRun<Run extends { readonly ordinal: number }>(
  runs: ReadonlyArray<Run>,
): Run | undefined {
  return runs.reduce<Run | undefined>(
    (latest, run) => (latest === undefined || run.ordinal > latest.ordinal ? run : latest),
    undefined,
  );
}

/** The plan this Feature implements: the latest one a run was started from. */
export function currentFeaturePlanId(state: Pick<FeatureWorkflowState, "threadId" | "runs">) {
  return (
    latestRun(state.runs.filter((run) => run.sourcePlanRef?.threadId === state.threadId))
      ?.sourcePlanRef?.planId ?? null
  );
}

const TERMINAL_RUN_STATUSES = new Set(["completed", "interrupted", "failed", "cancelled"]);

/**
 * The steps due now. A step whose turn failed or was interrupted waits for the
 * user: the workflow resumes once they finish that turn by hand and it completes.
 */
export function nextFeatureWorkflowActions(
  state: FeatureWorkflowState,
): ReadonlyArray<FeatureWorkflowAction> {
  const planId = currentFeaturePlanId(state);
  if (planId === null) {
    if (state.interactionMode !== "plan") return [];
    const answers: FeatureWorkflowAction[] = state.pendingQuestions.flatMap((request) => {
      const resolved = resolvePlanQuestionAnswers({ questions: request.questions });
      return Object.keys(resolved).length === 0
        ? []
        : [{ type: "answer-questions" as const, requestId: request.requestId, answers: resolved }];
    });
    const runStatus = (runId: string | null) =>
      state.runs.find((run) => run.id === runId)?.status ?? null;
    const plan = state.plans.findLast(
      (candidate) =>
        candidate.kind === "proposed_plan" &&
        candidate.status === "active" &&
        runStatus(candidate.runId) === "completed",
    );
    return plan === undefined ? answers : [...answers, { type: "implement", planId: plan.id }];
  }
  if (state.completed) return [];

  const runOf = (messageId: MessageId) =>
    state.runs.find((run) => run.userMessageId === messageId) ?? null;
  const implementRun = latestRun(state.runs.filter((run) => run.sourcePlanRef?.planId === planId));
  if (implementRun?.status !== "completed") return [];

  let unresolvedFindings: string | null = null;
  for (let cycle = 1; ; cycle += 1) {
    const review = state.reviews[cycle - 1];
    if (review === undefined || review.runStatus === null) {
      return [{ type: "review", planId, cycle }];
    }
    if (review.runStatus !== "completed") return [];
    const result = parseFeatureReviewResult(review.finalText);
    if (result.status === "clean") break;
    if (cycle >= state.cycleBudget) {
      unresolvedFindings = result.reportMarkdown;
      break;
    }
    const fixRun = runOf(featureFixMessageId(state.threadId, planId, cycle));
    if (fixRun === null) {
      return [{ type: "fix", planId, cycle, reportMarkdown: result.reportMarkdown }];
    }
    if (fixRun.status !== "completed") return [];
  }

  // A pull-request turn already started (also on Features from before App Review existed) ends
  // the reviews: only the link it is waiting for is left.
  const pullRequestRun = runOf(featurePullRequestMessageId(state.threadId, planId));
  if (pullRequestRun !== null) {
    return state.pullRequestLinked && TERMINAL_RUN_STATUSES.has(pullRequestRun.status)
      ? [{ type: "complete", planId, reason: "pull-request-linked" }]
      : [];
  }

  let appReview: FeatureAppReviewOutcome | null = null;
  for (let cycle = 1; appReview === null; cycle += 1) {
    const review = state.appReviews[cycle - 1];
    if (review === undefined || review.runStatus === null) {
      if (state.appReviewSkippedReason === null) return [{ type: "app-review", planId, cycle }];
      appReview = { status: "skipped", cycle, reason: state.appReviewSkippedReason };
      break;
    }
    if (review.runStatus !== "completed") return [];
    // A reviewer that ended without a verdict failed: it never showed the change working.
    if (review.recordStatus === "passed") {
      appReview = { status: "passed", cycle };
      break;
    }
    if (cycle >= state.appReviewCycleBudget) {
      appReview = { status: "unresolved", reportMarkdown: review.reportMarkdown };
      break;
    }
    const fixRun = runOf(featureAppReviewFixMessageId(state.threadId, planId, cycle));
    if (fixRun === null) {
      return [{ type: "app-review-fix", planId, cycle, reportMarkdown: review.reportMarkdown }];
    }
    if (fixRun.status !== "completed") return [];
  }

  return [
    {
      type: "open-pull-request",
      planId,
      unresolvedFindingsMarkdown: unresolvedFindings,
      appReview,
    },
  ];
}

export function buildFeatureImplementMessage(): string {
  return "The proposed plan is accepted. Implement it now in this thread, run the checks, and commit. Do not open the pull request yet: Code Review and App Review run first.";
}

export function buildFeatureReviewMessage(input: {
  readonly cycle: number;
  readonly cycleBudget: number;
  readonly worktreePath: string | null;
  readonly branch: string | null;
  readonly baseBranch: string | null;
  readonly planMarkdown: string | null;
}): string {
  return [
    `Review the Feature change in this worktree. Code Review cycle ${input.cycle} of ${input.cycleBudget}.`,
    "",
    `Worktree: ${input.worktreePath ?? "the thread's workspace"}`,
    `Branch: ${input.branch ?? "the checked-out branch"}`,
    input.baseBranch === null
      ? "Base branch: unknown. Review the commits this branch adds over the repository's default branch."
      : `Base branch: ${input.baseBranch}. Review \`git diff $(git merge-base HEAD ${input.baseBranch})...HEAD\`; use origin/${input.baseBranch} when the local branch is behind or missing.`,
    "",
    "Review only. Do not edit files, commit, push, or open a pull request: the Feature thread fixes what you report, then another cycle reviews the result.",
    "",
    "Review against the plan below, the repository's own rules (AGENTS.md, CLAUDE.md, contributing guides), and correctness. Report only problems that must change before the pull request; leave out style preferences the repository does not ask for.",
    "",
    "## Plan",
    input.planMarkdown?.trim() || "The plan is not available; review the change on its own merits.",
    "",
    "Finish with exactly one fenced JSON block:",
    "```json",
    JSON.stringify(
      {
        type: FEATURE_CODE_REVIEW_RESULT_TYPE,
        status: "findings",
        reportMarkdown: "1. `path/to/file.ts`: what is wrong and the change you expect.",
      },
      null,
      2,
    ),
    "```",
    'Use "clean" with a short reportMarkdown when nothing must change. Use "findings" and number each finding with its file, the problem, and the fix you expect.',
  ].join("\n");
}

export function buildFeatureFixMessage(input: {
  readonly cycle: number;
  readonly cycleBudget: number;
  readonly reportMarkdown: string;
}): string {
  return [
    `Code Review cycle ${input.cycle} of ${input.cycleBudget} found problems in this change.`,
    "",
    input.reportMarkdown.trim(),
    "",
    "Fix each finding in this worktree with focused tests where behavior changes, re-run the checks the repository requires for the files you touched, and commit. Do not push or open the pull request: another Code Review cycle follows.",
  ].join("\n");
}

export function buildFeatureAppReviewMessage(input: {
  readonly cycle: number;
  readonly cycleBudget: number;
  readonly frontendUrl: string;
  readonly stackId: string | null;
  readonly worktreePath: string | null;
  readonly branch: string | null;
  readonly baseBranch: string | null;
  readonly planMarkdown: string | null;
  readonly previousReportMarkdown: string | null;
}): string {
  return [
    `Run the App Review of this Feature in the running app. App Review cycle ${input.cycle} of ${input.cycleBudget}.`,
    "",
    "This review is unattended: do not ask the user questions. A human watches its recording and screenshots in the App Review panel before testing the change themselves, so show the planned behavior working from the user's point of view, step by step.",
    "",
    `Feature URL: ${input.frontendUrl}`,
    "The Feature URL is the App Stack of this Feature's worktree. Do not substitute a deployment URL from repository documentation, earlier messages, or browser history.",
    input.stackId === null
      ? "The stack may still be starting. If the Feature URL does not load yet, wait and retry for up to 20 minutes before you fail the review on it."
      : `App Stack: ${input.stackId}. It may still be starting: call \`app_stack_get\` and wait until it runs (up to 20 minutes) before you fail the review on it.`,
    `Worktree: ${input.worktreePath ?? "the thread's workspace"}`,
    `Branch: ${input.branch ?? "the checked-out branch"}`,
    input.baseBranch === null
      ? "Read the commits this branch adds to see what changed."
      : `Read \`git diff $(git merge-base HEAD ${input.baseBranch})...HEAD\` to see what changed.`,
    "",
    "Test only. Do not edit files, commit, or push: the Feature thread fixes what you report, then another App Review cycle runs.",
    "",
    "Sign in with the test user the repository's AGENTS.md names, when the app needs one. Exercise every user-facing behavior the plan names, and the main flow the change touches. Treat a change with no user-facing behavior as passed once you showed the affected screens still work.",
    "",
    "## Plan",
    input.planMarkdown?.trim() || "The plan is not available; review the change on its own merits.",
    ...(input.previousReportMarkdown === null
      ? []
      : [
          "",
          `## Findings of App Review cycle ${input.cycle - 1}`,
          "The Feature thread fixed these since. Check each one again first.",
          "",
          input.previousReportMarkdown.trim(),
        ]),
  ].join("\n");
}

export function buildFeatureAppReviewFixMessage(input: {
  readonly cycle: number;
  readonly cycleBudget: number;
  readonly reportMarkdown: string;
}): string {
  return [
    `App Review cycle ${input.cycle} of ${input.cycleBudget} failed in the running app.`,
    "",
    input.reportMarkdown.trim(),
    "",
    "Fix each finding in this worktree with focused tests where behavior changes, re-run the checks the repository requires for the files you touched, and commit. A finding about the App Stack or the review tooling rather than the change needs no code change; say so in your summary. Do not push or open the pull request: another App Review cycle follows.",
  ].join("\n");
}

/** The App Review record as the Feature thread and the pull request read it. */
export function featureAppReviewReportMarkdown(
  record: {
    readonly status: AppReviewStatus;
    readonly document: {
      readonly summary: string;
      readonly findings: ReadonlyArray<{
        readonly severity: string;
        readonly title: string;
        readonly details: string;
        readonly reproduction: string;
      }>;
    };
  } | null,
): string {
  if (record === null) return "The App Review has no record.";
  const summary =
    record.document.summary.trim() ||
    (record.status === "passed" || record.status === "failed"
      ? "The reviewer wrote no summary."
      : "The reviewer finished without a verdict, so the change was not shown working.");
  const findings = record.document.findings.map((finding, index) =>
    [
      `${index + 1}. **${finding.title}** (${finding.severity})`,
      ...(finding.details.trim() ? [`   ${finding.details.trim()}`] : []),
      ...(finding.reproduction.trim() ? [`   Reproduction: ${finding.reproduction.trim()}`] : []),
    ].join("\n"),
  );
  return [summary, ...(findings.length === 0 ? [] : ["", ...findings])].join("\n");
}

function appReviewPullRequestLines(appReview: FeatureAppReviewOutcome): ReadonlyArray<string> {
  switch (appReview.status) {
    case "passed":
      return [
        "",
        `App Review passed in cycle ${appReview.cycle}. Say so in the pull-request body; its recording and screenshots are in the Feature's App Review panel in T3 Code.`,
      ];
    case "unresolved":
      return [
        "",
        "App Review used every cycle and the change still fails in the running app. List its last findings in the pull-request body under an Unresolved App Review findings heading, unchanged:",
        "",
        appReview.reportMarkdown.trim(),
      ];
    case "skipped":
      return [
        "",
        `App Review cycle ${appReview.cycle} could not run: ${appReview.reason} Say in the pull-request body that the change was not reviewed in the running app${appReview.cycle > 1 ? " after the last App Review fixes" : ""}.`,
      ];
  }
}

export function buildFeaturePullRequestMessage(input: {
  readonly baseBranch: string | null;
  readonly unresolvedFindingsMarkdown: string | null;
  readonly appReview: FeatureAppReviewOutcome;
}): string {
  return [
    input.baseBranch === null
      ? "Open the pull request for this change into the branch this worktree started from."
      : `Open the pull request for this change into \`${input.baseBranch}\`.`,
    ...(input.unresolvedFindingsMarkdown === null
      ? ["", "The last Code Review cycle came back clean."]
      : [
          "",
          "Code Review used every cycle and these findings are still unresolved. List them in the pull-request body under an Unresolved review findings heading, unchanged:",
          "",
          input.unresolvedFindingsMarkdown.trim(),
        ]),
    ...appReviewPullRequestLines(input.appReview),
  ].join("\n");
}
