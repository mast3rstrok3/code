import {
  AppReviewId,
  type AppReviewStatus,
  type AppReviewWorkflowRun,
  AppReviewWorkflowRunId,
  MessageId,
  ThreadId,
  type OrchestrationV2Run,
  type RuntimeRequestId,
} from "@t3tools/contracts";

import { extractJsonFenceBlocks } from "./workflowDirectives.ts";

/**
 * The Feature workflow (`fast-plan`) runs in one thread and one worktree. The
 * user's message starts in build mode and its turn writes the instruction
 * (user intent, guardrails, goal). Then the same thread implements it
 * test-first, App Review cycles run the project's E2E suites on the
 * worktree's App Stack (or a recorded browser review when the project has
 * none), Code Review cycles review the result in reviewer child threads, and
 * the thread opens the pull request. Review findings come back to the Feature
 * thread as fix turns.
 * A Feature thread holds one Feature, so every step is a message or thread
 * with an ID derived from the thread: the state below is read back from the
 * thread itself and each step starts once.
 */

export const FEATURE_CODE_REVIEW_RESULT_TYPE = "feature-code-review-result";

const REVIEW_THREAD_SEPARATOR = "::feature-review::";
const APP_REVIEW_THREAD_SEPARATOR = "::feature-app-review::";
const STEP_MESSAGE_PREFIX = "feature-";

export function featureImplementMessageId(threadId: ThreadId): MessageId {
  return MessageId.make(`${STEP_MESSAGE_PREFIX}implement:${threadId}`);
}

export function featureFixMessageId(threadId: ThreadId, cycle: number): MessageId {
  return MessageId.make(`${STEP_MESSAGE_PREFIX}fix:${threadId}:${cycle}`);
}

export function featurePullRequestMessageId(threadId: ThreadId): MessageId {
  return MessageId.make(`${STEP_MESSAGE_PREFIX}pull-request:${threadId}`);
}

export function featureReviewThreadId(threadId: ThreadId, cycle: number): ThreadId {
  return ThreadId.make(`${threadId}${REVIEW_THREAD_SEPARATOR}${cycle}`);
}

export function featureReviewMessageId(reviewThreadId: ThreadId): MessageId {
  return MessageId.make(`feature-review:${reviewThreadId}`);
}

/** The thread that runs one App Review cycle: the E2E run's controller, or the browser reviewer. */
export function featureAppReviewThreadId(threadId: ThreadId, cycle: number): ThreadId {
  return ThreadId.make(`${threadId}${APP_REVIEW_THREAD_SEPARATOR}${cycle}`);
}

/** The App Review Workflow run of one E2E cycle, as the decider names it from its controller. */
export function featureE2eAppReviewRunId(
  threadId: ThreadId,
  cycle: number,
): AppReviewWorkflowRunId {
  return AppReviewWorkflowRunId.make(
    `app-review-workflow-${featureAppReviewThreadId(threadId, cycle)}`,
  );
}

export function featureAppReviewId(threadId: ThreadId, cycle: number): AppReviewId {
  return AppReviewId.make(`feature-app-review:${threadId}:${cycle}`);
}

export function featureAppReviewMessageId(appReviewThreadId: ThreadId): MessageId {
  return MessageId.make(`feature-app-review:${appReviewThreadId}`);
}

export function featureAppReviewFixMessageId(threadId: ThreadId, cycle: number): MessageId {
  return MessageId.make(`${STEP_MESSAGE_PREFIX}app-review-fix:${threadId}:${cycle}`);
}

/** Whether a Feature thread message is one the workflow sent rather than the user. */
function isFeatureStepMessage(messageId: MessageId): boolean {
  return messageId.startsWith(STEP_MESSAGE_PREFIX);
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

/** Answers a provider question without a human: the recommendation, the first option, else best judgment. */
export function resolveFeatureQuestionAnswers(payload: unknown): Readonly<Record<string, string>> {
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
  /**
   * Null until the cycle has started. Pending while it runs, or while its reviewer turn
   * failed and waits for the user.
   */
  readonly status: "pending" | "passed" | "failed" | null;
  /** What failed, handed to the Feature thread as its fix turn. */
  readonly reportMarkdown: string;
  /** What the pull request shows its reader: the recorded E2E flows, or the browser recording. */
  readonly evidenceMarkdown: string;
}

/** How App Review ended, which the pull request reports. */
export type FeatureAppReviewOutcome =
  | { readonly status: "passed"; readonly cycle: number; readonly evidenceMarkdown: string }
  | {
      readonly status: "unresolved";
      readonly reportMarkdown: string;
      readonly evidenceMarkdown: string;
    }
  | { readonly status: "skipped"; readonly cycle: number; readonly reason: string };

export interface FeatureWorkflowState {
  readonly threadId: ThreadId;
  readonly runs: ReadonlyArray<
    Pick<OrchestrationV2Run, "id" | "ordinal" | "status" | "userMessageId" | "sourcePlanRef">
  >;
  readonly pendingQuestions: ReadonlyArray<{
    readonly requestId: RuntimeRequestId;
    readonly questions: ReadonlyArray<unknown>;
  }>;
  /** App Reviews, cycle 1 first, up to the first one not started. */
  readonly appReviews: ReadonlyArray<FeatureAppReviewState>;
  readonly appReviewCycleBudget: number;
  /** Why the next App Review cycle cannot run, once its launch found out. */
  readonly appReviewSkippedReason: string | null;
  /** Code Reviews, cycle 1 first, up to the first one not started. */
  readonly reviews: ReadonlyArray<FeatureReviewState>;
  readonly cycleBudget: number;
  readonly pullRequestLinked: boolean;
  /** Whether this Feature already finished (stacks stopped, thread settled). */
  readonly completed: boolean;
}

export type FeatureWorkflowAction =
  | {
      readonly type: "answer-questions";
      readonly requestId: RuntimeRequestId;
      readonly answers: Readonly<Record<string, string>>;
    }
  | { readonly type: "implement" }
  | { readonly type: "app-review"; readonly cycle: number }
  | {
      readonly type: "app-review-fix";
      readonly cycle: number;
      readonly reportMarkdown: string;
    }
  | { readonly type: "review"; readonly cycle: number }
  | {
      readonly type: "fix";
      readonly cycle: number;
      readonly reportMarkdown: string;
    }
  | {
      readonly type: "open-pull-request";
      readonly appReview: FeatureAppReviewOutcome;
      readonly unresolvedFindingsMarkdown: string | null;
    }
  | {
      readonly type: "complete";
      /** Why the workflow ended: its pull request is linked, or the Feature needed no change. */
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

/**
 * The turn that wrote the instruction: the user's latest turn before the implement turn, or
 * before now while there is none. Earlier turns are chat from before the Feature started.
 */
export function featureInstructionRun<
  Run extends Pick<OrchestrationV2Run, "ordinal" | "userMessageId">,
>(threadId: ThreadId, runs: ReadonlyArray<Run>): Run | undefined {
  const implementMessageId = featureImplementMessageId(threadId);
  const implementOrdinal =
    runs.find((run) => run.userMessageId === implementMessageId)?.ordinal ?? Infinity;
  return latestRun(
    runs.filter(
      (run) => run.ordinal < implementOrdinal && !isFeatureStepMessage(run.userMessageId),
    ),
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
  if (state.completed) return [];
  // Features that started in Plan mode, before the instruction step, are finished by hand.
  if (state.runs.some((run) => run.sourcePlanRef?.threadId === state.threadId)) return [];

  // The thread runs unattended, so a provider question in any turn gets its recommended answer.
  const answers: FeatureWorkflowAction[] = state.pendingQuestions.flatMap((request) => {
    const resolved = resolveFeatureQuestionAnswers({ questions: request.questions });
    return Object.keys(resolved).length === 0
      ? []
      : [{ type: "answer-questions" as const, requestId: request.requestId, answers: resolved }];
  });
  return [...answers, ...nextFeatureSteps(state)];
}

function nextFeatureSteps(state: FeatureWorkflowState): ReadonlyArray<FeatureWorkflowAction> {
  const runOf = (messageId: MessageId) =>
    state.runs.find((run) => run.userMessageId === messageId) ?? null;

  const implementRun = runOf(featureImplementMessageId(state.threadId));
  if (implementRun === null) {
    const instructionRun = featureInstructionRun(state.threadId, state.runs);
    return instructionRun?.status === "completed" ? [{ type: "implement" }] : [];
  }
  if (implementRun.status !== "completed") return [];

  // A pull-request turn that already started ends the reviews: only the link it waits for is left.
  const pullRequestRun = runOf(featurePullRequestMessageId(state.threadId));
  if (pullRequestRun !== null) {
    return state.pullRequestLinked && TERMINAL_RUN_STATUSES.has(pullRequestRun.status)
      ? [{ type: "complete", reason: "pull-request-linked" }]
      : [];
  }

  let appReview: FeatureAppReviewOutcome | null = null;
  for (let cycle = 1; appReview === null; cycle += 1) {
    const review = state.appReviews[cycle - 1];
    if (review === undefined || review.status === null) {
      if (state.appReviewSkippedReason === null) return [{ type: "app-review", cycle }];
      appReview = { status: "skipped", cycle, reason: state.appReviewSkippedReason };
      break;
    }
    if (review.status === "pending") return [];
    if (review.status === "passed") {
      appReview = { status: "passed", cycle, evidenceMarkdown: review.evidenceMarkdown };
      break;
    }
    if (cycle >= state.appReviewCycleBudget) {
      appReview = {
        status: "unresolved",
        reportMarkdown: review.reportMarkdown,
        evidenceMarkdown: review.evidenceMarkdown,
      };
      break;
    }
    const fixRun = runOf(featureAppReviewFixMessageId(state.threadId, cycle));
    if (fixRun === null) {
      return [{ type: "app-review-fix", cycle, reportMarkdown: review.reportMarkdown }];
    }
    if (fixRun.status !== "completed") return [];
  }

  let unresolvedFindings: string | null = null;
  for (let cycle = 1; ; cycle += 1) {
    const review = state.reviews[cycle - 1];
    if (review === undefined || review.runStatus === null) {
      return [{ type: "review", cycle }];
    }
    if (review.runStatus !== "completed") return [];
    const result = parseFeatureReviewResult(review.finalText);
    if (result.status === "clean") break;
    if (cycle >= state.cycleBudget) {
      unresolvedFindings = result.reportMarkdown;
      break;
    }
    const fixRun = runOf(featureFixMessageId(state.threadId, cycle));
    if (fixRun === null) {
      return [{ type: "fix", cycle, reportMarkdown: result.reportMarkdown }];
    }
    if (fixRun.status !== "completed") return [];
  }

  return [{ type: "open-pull-request", appReview, unresolvedFindingsMarkdown: unresolvedFindings }];
}

/**
 * An E2E App Review cycle read from its review-only App Review Workflow run. The run's own
 * findings, or why it could not test, become the Feature thread's fix turn.
 */
export function featureE2eAppReviewState(
  run: Pick<AppReviewWorkflowRun, "status" | "cycles" | "failure">,
): FeatureAppReviewState {
  const cycle = run.cycles.at(-1);
  const results = cycle?.e2eExecution?.results ?? [];
  const evidenceMarkdown =
    results.length === 0
      ? "No E2E suite finished, so no flow was recorded."
      : results
          .map((result) => {
            const flows = (result.recordings ?? []).map((recording) => recording.label);
            return [
              `- ${result.status === "passed" ? "Passed" : "Failed"}: \`${result.command}\``,
              flows.length === 0
                ? "  No flow recordings: the suite does not publish rrweb replays."
                : `  Recorded flows: ${flows.join(", ")}`,
            ].join("\n");
          })
          .join("\n");
  if (run.status === "running") return { status: "pending", reportMarkdown: "", evidenceMarkdown };
  if (run.status === "passed") return { status: "passed", reportMarkdown: "", evidenceMarkdown };
  const reportMarkdown =
    cycle?.actionableFindingsMarkdown?.trim() ||
    (run.failure === null
      ? "The E2E App Review failed without a report."
      : `The E2E App Review could not finish (${run.failure.reason}): ${run.failure.detailMarkdown}`);
  return { status: "failed", reportMarkdown, evidenceMarkdown };
}

/** The browser App Review's evidence, which lives in its record rather than in text. */
export const FEATURE_BROWSER_APP_REVIEW_EVIDENCE =
  "A reviewer drove the running app in the browser; its rrweb recording and screenshots are in the Feature's App Review panel in T3 Code.";

export function buildFeatureImplementMessage(): string {
  return "The instruction above is the brief: build what its Goal names for the User intent, inside its Guardrails. Implement it now in this thread, test-first, run the checks, and commit. Do not open the pull request yet: App Review and Code Review run first.";
}

const instructionSection = (instructionMarkdown: string | null) => [
  "## Instruction",
  instructionMarkdown?.trim() ||
    "The instruction is not available; review the change on its own merits.",
];

export function buildFeatureE2eAppReviewBrief(input: {
  readonly cycle: number;
  readonly cycleBudget: number;
  readonly instructionMarkdown: string | null;
  readonly previousReportMarkdown: string | null;
}): string {
  return [
    `End-to-end App Review of a Feature, cycle ${input.cycle} of ${input.cycleBudget}. Run the project's E2E suites against the Feature's App Stack and record each test flow, so the change can be reviewed from its replays.`,
    "",
    ...instructionSection(input.instructionMarkdown),
    ...(input.previousReportMarkdown === null
      ? []
      : [
          "",
          `## Findings of App Review cycle ${input.cycle - 1}`,
          "The Feature thread fixed these since.",
          "",
          input.previousReportMarkdown.trim(),
        ]),
  ].join("\n");
}

export function buildFeatureReviewMessage(input: {
  readonly cycle: number;
  readonly cycleBudget: number;
  readonly worktreePath: string | null;
  readonly branch: string | null;
  readonly baseBranch: string | null;
  readonly instructionMarkdown: string | null;
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
    "Review against the instruction below (its goal, and the guardrails the change must stay inside), the repository's own rules (AGENTS.md, CLAUDE.md, contributing guides), and correctness. Report only problems that must change before the pull request; leave out style preferences the repository does not ask for.",
    "",
    ...instructionSection(input.instructionMarkdown),
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
    "Fix each finding in this worktree test-first where behavior changes, re-run the checks the repository requires for the files you touched, and commit. Do not push or open the pull request: another Code Review cycle follows.",
  ].join("\n");
}

/** The browser reviewer's launch message, used when the project has no E2E suites. */
export function buildFeatureAppReviewMessage(input: {
  readonly cycle: number;
  readonly cycleBudget: number;
  readonly frontendUrl: string;
  readonly stackId: string | null;
  readonly worktreePath: string | null;
  readonly branch: string | null;
  readonly baseBranch: string | null;
  readonly instructionMarkdown: string | null;
  readonly previousReportMarkdown: string | null;
}): string {
  return [
    `Run the App Review of this Feature in the running app. App Review cycle ${input.cycle} of ${input.cycleBudget}.`,
    "",
    "This review is unattended: do not ask the user questions. A human watches its recording and screenshots before reviewing the pull request, so show the behavior the instruction asks for working from the user's point of view, step by step.",
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
    "Sign in with the test user the repository's AGENTS.md names, when the app needs one. Exercise every user-facing behavior the instruction's goal names, and the main flow the change touches. Treat a change with no user-facing behavior as passed once you showed the affected screens still work.",
    "",
    ...instructionSection(input.instructionMarkdown),
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
    "Fix each finding in this worktree test-first, re-run the checks the repository requires for the files you touched, and commit. When an E2E test itself is wrong about the behavior the instruction asks for, fix the test and say why. A finding about the App Stack or the review tooling rather than the change needs no code change; say so in your summary. Do not push or open the pull request: another App Review cycle follows.",
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
  const evidence = (markdown: string) => [
    "",
    "Put what App Review exercised in the pull-request body under an App Review heading, unchanged:",
    "",
    markdown.trim(),
  ];
  switch (appReview.status) {
    case "passed":
      return [
        `App Review passed in cycle ${appReview.cycle}. Say so in the pull-request body.`,
        ...evidence(appReview.evidenceMarkdown),
      ];
    case "unresolved":
      return [
        "App Review used every cycle and the change still fails in the running app. List its last findings in the pull-request body under an Unresolved App Review findings heading, unchanged:",
        "",
        appReview.reportMarkdown.trim(),
        ...evidence(appReview.evidenceMarkdown),
      ];
    case "skipped":
      return [
        `App Review cycle ${appReview.cycle} could not run: ${appReview.reason} Say in the pull-request body that the change was not tested in the running app${appReview.cycle > 1 ? " after the last App Review fixes" : ""}.`,
      ];
  }
}

export function buildFeaturePullRequestMessage(input: {
  readonly baseBranch: string | null;
  readonly appReview: FeatureAppReviewOutcome;
  readonly unresolvedFindingsMarkdown: string | null;
}): string {
  return [
    input.baseBranch === null
      ? "Open the pull request for this change into the branch this worktree started from."
      : `Open the pull request for this change into \`${input.baseBranch}\`.`,
    "",
    "The pull request is where this Feature is reviewed, so its body starts with the instruction this thread wrote first: the User intent, Guardrails, and Goal, each under its own heading.",
    "",
    ...appReviewPullRequestLines(input.appReview),
    ...(input.unresolvedFindingsMarkdown === null
      ? ["", "The last Code Review cycle came back clean."]
      : [
          "",
          "Code Review used every cycle and these findings are still unresolved. List them in the pull-request body under an Unresolved review findings heading, unchanged:",
          "",
          input.unresolvedFindingsMarkdown.trim(),
        ]),
  ].join("\n");
}
