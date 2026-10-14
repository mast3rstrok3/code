import { MessageId, PlanId, RunId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildFeaturePullRequestMessage,
  featureAppReviewFixMessageId,
  featureAppReviewReportMarkdown,
  featureAppReviewThreadId,
  type FeatureWorkflowState,
  featureFixMessageId,
  featureImplementMessageId,
  featurePullRequestMessageId,
  featureReviewThreadId,
  featureRootOfReviewThread,
  nextFeatureWorkflowActions,
  parseFeatureReviewResult,
  resolvePlanQuestionAnswers,
} from "./featureWorkflow.ts";

describe("resolvePlanQuestionAnswers", () => {
  it("uses a valid recommendation, then the first option, then the free-form fallback", () => {
    expect(
      resolvePlanQuestionAnswers({
        questions: [
          {
            id: "approach",
            options: [{ label: "Small" }, { label: "Complete" }],
            recommendation: { optionLabel: "Complete" },
          },
          {
            id: "tests",
            options: [{ label: "Focused" }, { label: "Broad" }],
          },
          { id: "unknown", options: [] },
        ],
      }),
    ).toEqual({
      approach: "Complete",
      tests: "Focused",
      unknown: "Use your best judgment and continue.",
    });
  });

  it("ignores malformed questions and invalid recommendations", () => {
    expect(
      resolvePlanQuestionAnswers({
        questions: [
          null,
          { options: [{ label: "Missing id" }] },
          {
            id: "approach",
            options: [{ label: "Safe" }],
            recommendation: { optionLabel: "Unavailable" },
          },
        ],
      }),
    ).toEqual({ approach: "Safe" });
  });
});

const threadId = ThreadId.make("thread-feature");
const planId = PlanId.make("plan-1");

const review = (status: "clean" | "findings", report = `${status} report`) =>
  [
    "Review done.",
    "```json",
    JSON.stringify({ type: "feature-code-review-result", status, reportMarkdown: report }),
    "```",
  ].join("\n");

type Run = FeatureWorkflowState["runs"][number];
let ordinal = 0;
const run = (
  userMessageId: string,
  status: Run["status"] = "completed",
  sourcePlanRef?: Run["sourcePlanRef"],
): Run => {
  ordinal += 1;
  return {
    id: RunId.make(`run-${ordinal}`),
    ordinal,
    status,
    userMessageId: MessageId.make(userMessageId),
    ...(sourcePlanRef === undefined ? {} : { sourcePlanRef }),
  };
};
const planningRun = () => run("user-prompt");
const implementRun = (status: Run["status"] = "completed") =>
  run(featureImplementMessageId(threadId, planId), status, { threadId, planId });
const fixRun = (cycle: number, status: Run["status"] = "completed") =>
  run(featureFixMessageId(threadId, planId, cycle), status);

const passedAppReview = {
  runStatus: "completed" as const,
  recordStatus: "passed" as const,
  reportMarkdown: "It works.",
};
const failedAppReview = (report: string) => ({
  runStatus: "completed" as const,
  recordStatus: "failed" as const,
  reportMarkdown: report,
});
const appReviewFixRun = (cycle: number, status: Run["status"] = "completed") =>
  run(featureAppReviewFixMessageId(threadId, planId, cycle), status);

const state = (overrides: Partial<FeatureWorkflowState>): FeatureWorkflowState => ({
  threadId,
  interactionMode: "default",
  runs: [],
  plans: [],
  pendingQuestions: [],
  reviews: [],
  cycleBudget: 5,
  appReviews: [passedAppReview],
  appReviewCycleBudget: 3,
  appReviewSkippedReason: null,
  pullRequestLinked: false,
  completed: false,
  ...overrides,
});

describe("nextFeatureWorkflowActions", () => {
  it("answers planning questions and implements the finished plan in the same thread, once", () => {
    const planning = planningRun();
    const plans = [{ id: planId, kind: "proposed_plan", status: "active", runId: planning.id }];
    const pendingQuestions = [
      {
        requestId: RuntimeRequestId.make("request-1"),
        questions: [{ id: "scope", options: [{ label: "Small" }, { label: "Large" }] }],
      },
    ];
    expect(
      nextFeatureWorkflowActions(
        state({
          interactionMode: "plan",
          runs: [{ ...planning, status: "running" }],
          plans,
          pendingQuestions,
        }),
      ),
    ).toEqual([{ type: "answer-questions", requestId: "request-1", answers: { scope: "Small" } }]);
    expect(
      nextFeatureWorkflowActions(state({ interactionMode: "plan", runs: [planning], plans })),
    ).toEqual([{ type: "implement", planId }]);
    // Once a run starts from the plan, the plan stage is over.
    expect(
      nextFeatureWorkflowActions(
        state({ interactionMode: "default", runs: [planning, implementRun("running")], plans }),
      ),
    ).toEqual([]);
  });

  it("runs App Review after a clean first review, then opens the pull request", () => {
    const runs = [planningRun(), implementRun()];
    const reviews = [{ runStatus: "completed" as const, finalText: review("clean") }];
    expect(nextFeatureWorkflowActions(state({ runs, appReviews: [] }))).toEqual([
      { type: "review", planId, cycle: 1 },
    ]);
    expect(nextFeatureWorkflowActions(state({ runs, reviews, appReviews: [] }))).toEqual([
      { type: "app-review", planId, cycle: 1 },
    ]);
    // Launched but not started yet, then running: the same cycle, then nothing to do.
    expect(
      nextFeatureWorkflowActions(
        state({
          runs,
          reviews,
          appReviews: [{ runStatus: null, recordStatus: "running", reportMarkdown: "" }],
        }),
      ),
    ).toEqual([{ type: "app-review", planId, cycle: 1 }]);
    expect(
      nextFeatureWorkflowActions(
        state({
          runs,
          reviews,
          appReviews: [{ runStatus: "running", recordStatus: "running", reportMarkdown: "" }],
        }),
      ),
    ).toEqual([]);
    expect(nextFeatureWorkflowActions(state({ runs, reviews }))).toEqual([
      {
        type: "open-pull-request",
        planId,
        unresolvedFindingsMarkdown: null,
        appReview: { status: "passed", cycle: 1 },
      },
    ]);
  });

  it("has the Feature thread fix App Review failures, then reviews the running app again", () => {
    const base = [planningRun(), implementRun()];
    const reviews = [{ runStatus: "completed" as const, finalText: review("clean") }];
    const failed = failedAppReview("1. **Save does nothing** (blocker)");
    expect(
      nextFeatureWorkflowActions(state({ runs: base, reviews, appReviews: [failed] })),
    ).toEqual([
      { type: "app-review-fix", planId, cycle: 1, reportMarkdown: failed.reportMarkdown },
    ]);
    expect(
      nextFeatureWorkflowActions(
        state({ runs: [...base, appReviewFixRun(1, "running")], reviews, appReviews: [failed] }),
      ),
    ).toEqual([]);
    expect(
      nextFeatureWorkflowActions(
        state({ runs: [...base, appReviewFixRun(1)], reviews, appReviews: [failed] }),
      ),
    ).toEqual([{ type: "app-review", planId, cycle: 2 }]);
    expect(
      nextFeatureWorkflowActions(
        state({
          runs: [...base, appReviewFixRun(1)],
          reviews,
          appReviews: [failed, passedAppReview],
        }),
      ),
    ).toEqual([
      {
        type: "open-pull-request",
        planId,
        unresolvedFindingsMarkdown: null,
        appReview: { status: "passed", cycle: 2 },
      },
    ]);
  });

  it("treats a reviewer that ended without a verdict as a failed App Review", () => {
    const runs = [planningRun(), implementRun()];
    const reviews = [{ runStatus: "completed" as const, finalText: review("clean") }];
    const noVerdict = {
      runStatus: "completed" as const,
      recordStatus: "running" as const,
      reportMarkdown: "no verdict",
    };
    expect(nextFeatureWorkflowActions(state({ runs, reviews, appReviews: [noVerdict] }))).toEqual([
      { type: "app-review-fix", planId, cycle: 1, reportMarkdown: "no verdict" },
    ]);
  });

  it("opens the pull request with the last App Review findings once every cycle is used", () => {
    const runs = [planningRun(), implementRun(), appReviewFixRun(1), appReviewFixRun(2)];
    const reviews = [{ runStatus: "completed" as const, finalText: review("clean") }];
    const appReviews = [1, 2, 3].map((cycle) => failedAppReview(`App Review cycle ${cycle}`));
    expect(nextFeatureWorkflowActions(state({ runs, reviews, appReviews }))).toEqual([
      {
        type: "open-pull-request",
        planId,
        unresolvedFindingsMarkdown: null,
        appReview: { status: "unresolved", reportMarkdown: "App Review cycle 3" },
      },
    ]);
  });

  it("opens the pull request without App Review when its cycle cannot run", () => {
    const runs = [planningRun(), implementRun()];
    const reviews = [{ runStatus: "completed" as const, finalText: review("clean") }];
    expect(
      nextFeatureWorkflowActions(
        state({
          runs,
          reviews,
          appReviews: [],
          appReviewSkippedReason: "its App Stack did not start (no stack).",
        }),
      ),
    ).toEqual([
      {
        type: "open-pull-request",
        planId,
        unresolvedFindingsMarkdown: null,
        appReview: {
          status: "skipped",
          cycle: 1,
          reason: "its App Stack did not start (no stack).",
        },
      },
    ]);
  });

  it("has the Feature thread fix findings, then reviews again until clean", () => {
    const base = [planningRun(), implementRun()];
    const findings = { runStatus: "completed" as const, finalText: review("findings", "1. bug") };
    expect(nextFeatureWorkflowActions(state({ runs: base, reviews: [findings] }))).toEqual([
      { type: "fix", planId, cycle: 1, reportMarkdown: "1. bug" },
    ]);
    expect(
      nextFeatureWorkflowActions(
        state({ runs: [...base, fixRun(1, "running")], reviews: [findings] }),
      ),
    ).toEqual([]);
    expect(
      nextFeatureWorkflowActions(state({ runs: [...base, fixRun(1)], reviews: [findings] })),
    ).toEqual([{ type: "review", planId, cycle: 2 }]);
    expect(
      nextFeatureWorkflowActions(
        state({
          runs: [...base, fixRun(1)],
          reviews: [findings, { runStatus: "completed", finalText: review("clean") }],
        }),
      ),
    ).toEqual([
      {
        type: "open-pull-request",
        planId,
        unresolvedFindingsMarkdown: null,
        appReview: { status: "passed", cycle: 1 },
      },
    ]);
  });

  it("opens the pull request with the last findings once every cycle is used", () => {
    const runs = [planningRun(), implementRun(), fixRun(1), fixRun(2), fixRun(3), fixRun(4)];
    const reviews = [1, 2, 3, 4, 5].map((cycle) => ({
      runStatus: "completed" as const,
      finalText: review("findings", `finding from cycle ${cycle}`),
    }));
    expect(nextFeatureWorkflowActions(state({ runs, reviews }))).toEqual([
      {
        type: "open-pull-request",
        planId,
        unresolvedFindingsMarkdown: "finding from cycle 5",
        appReview: { status: "passed", cycle: 1 },
      },
    ]);
  });

  it("finishes once the pull request is linked and its turn is over", () => {
    const runs = [
      planningRun(),
      implementRun(),
      run(featurePullRequestMessageId(threadId, planId), "completed"),
    ];
    const reviews = [{ runStatus: "completed" as const, finalText: review("clean") }];
    expect(nextFeatureWorkflowActions(state({ runs, reviews }))).toEqual([]);
    expect(nextFeatureWorkflowActions(state({ runs, reviews, pullRequestLinked: true }))).toEqual([
      { type: "complete", planId, reason: "pull-request-linked" },
    ]);
    // A Feature that opened its pull request before App Review existed does not start one now.
    expect(
      nextFeatureWorkflowActions(state({ runs, reviews, appReviews: [], pullRequestLinked: true })),
    ).toEqual([{ type: "complete", planId, reason: "pull-request-linked" }]);
    expect(
      nextFeatureWorkflowActions(
        state({ runs, reviews, pullRequestLinked: true, completed: true }),
      ),
    ).toEqual([]);
  });

  it("waits for the user when a step's turn failed", () => {
    expect(nextFeatureWorkflowActions(state({ runs: [implementRun("failed")] }))).toEqual([]);
    expect(
      nextFeatureWorkflowActions(
        state({ runs: [implementRun()], reviews: [{ runStatus: "failed", finalText: null }] }),
      ),
    ).toEqual([]);
  });
});

describe("Feature review results and ids", () => {
  it("reads the reviewer verdict and treats a missing one as findings", () => {
    expect(parseFeatureReviewResult(review("clean", "ok"))).toEqual({
      status: "clean",
      reportMarkdown: "ok",
    });
    const missing = parseFeatureReviewResult("I looked around and it seems fine.");
    expect(missing.status).toBe("findings");
    expect(missing.reportMarkdown).toContain("I looked around");
  });

  it("finds the Feature thread behind a reviewer thread", () => {
    expect(featureRootOfReviewThread(featureReviewThreadId(threadId, planId, 3))).toBe(threadId);
    expect(featureRootOfReviewThread(featureAppReviewThreadId(threadId, planId, 2))).toBe(threadId);
    expect(featureRootOfReviewThread(threadId)).toBeNull();
  });

  it("hands the App Review record and its outcome on as text", () => {
    expect(
      featureAppReviewReportMarkdown({
        status: "failed",
        document: {
          summary: "Saving fails.",
          findings: [
            {
              severity: "blocker",
              title: "Save does nothing",
              details: "The button stays disabled.",
              reproduction: "Open the form and click Save.",
            },
          ],
        },
      }),
    ).toBe(
      [
        "Saving fails.",
        "",
        "1. **Save does nothing** (blocker)",
        "   The button stays disabled.",
        "   Reproduction: Open the form and click Save.",
      ].join("\n"),
    );
    expect(
      featureAppReviewReportMarkdown({
        status: "running",
        document: { summary: "", findings: [] },
      }),
    ).toContain("without a verdict");
    const skipped = buildFeaturePullRequestMessage({
      baseBranch: "dev",
      unresolvedFindingsMarkdown: null,
      appReview: { status: "skipped", cycle: 1, reason: "its App Stack did not start (down)." },
    });
    expect(skipped).toContain(
      "App Review cycle 1 could not run: its App Stack did not start (down).",
    );
    expect(
      buildFeaturePullRequestMessage({
        baseBranch: "dev",
        unresolvedFindingsMarkdown: null,
        appReview: { status: "unresolved", reportMarkdown: "1. still broken" },
      }),
    ).toContain("Unresolved App Review findings heading, unchanged:\n\n1. still broken");
  });
});
