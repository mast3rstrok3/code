import { MessageId, PlanId, RunId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildFeaturePullRequestMessage,
  featureAppReviewFixMessageId,
  featureAppReviewReportMarkdown,
  featureAppReviewThreadId,
  featureE2eAppReviewState,
  type FeatureWorkflowState,
  featureFixMessageId,
  featureImplementMessageId,
  featureInstructionRun,
  featurePullRequestMessageId,
  featureReviewThreadId,
  featureRootOfReviewThread,
  nextFeatureWorkflowActions,
  parseFeatureReviewResult,
  resolveFeatureQuestionAnswers,
} from "./featureWorkflow.ts";

describe("resolveFeatureQuestionAnswers", () => {
  it("uses a valid recommendation, then the first option, then the free-form fallback", () => {
    expect(
      resolveFeatureQuestionAnswers({
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
      resolveFeatureQuestionAnswers({
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
const instructionRun = (status: Run["status"] = "completed") => run("user-prompt", status);
const implementRun = (status: Run["status"] = "completed") =>
  run(featureImplementMessageId(threadId), status);
const fixRun = (cycle: number, status: Run["status"] = "completed") =>
  run(featureFixMessageId(threadId, cycle), status);
const appReviewFixRun = (cycle: number, status: Run["status"] = "completed") =>
  run(featureAppReviewFixMessageId(threadId, cycle), status);

const passedAppReview = {
  status: "passed" as const,
  reportMarkdown: "",
  evidenceMarkdown: "- Passed: `pnpm e2e`",
};
const failedAppReview = (report: string) => ({
  status: "failed" as const,
  reportMarkdown: report,
  evidenceMarkdown: "- Failed: `pnpm e2e`",
});
const cleanReview = { runStatus: "completed" as const, finalText: review("clean") };

const state = (overrides: Partial<FeatureWorkflowState>): FeatureWorkflowState => ({
  threadId,
  runs: [],
  pendingQuestions: [],
  appReviews: [passedAppReview],
  appReviewCycleBudget: 3,
  appReviewSkippedReason: null,
  reviews: [cleanReview],
  cycleBudget: 5,
  pullRequestLinked: false,
  completed: false,
  ...overrides,
});

describe("nextFeatureWorkflowActions", () => {
  it("answers provider questions and implements once the instruction turn finished, once", () => {
    const pendingQuestions = [
      {
        requestId: RuntimeRequestId.make("request-1"),
        questions: [{ id: "scope", options: [{ label: "Small" }, { label: "Large" }] }],
      },
    ];
    expect(
      nextFeatureWorkflowActions(state({ runs: [instructionRun("running")], pendingQuestions })),
    ).toEqual([{ type: "answer-questions", requestId: "request-1", answers: { scope: "Small" } }]);
    const instruction = instructionRun();
    expect(nextFeatureWorkflowActions(state({ runs: [instruction] }))).toEqual([
      { type: "implement" },
    ]);
    // Once the implement turn exists, the instruction step is over.
    expect(
      nextFeatureWorkflowActions(state({ runs: [instruction, implementRun("running")] })),
    ).toEqual([]);
    expect(nextFeatureWorkflowActions(state({ runs: [] }))).toEqual([]);
    // Later turns run unattended too.
    expect(
      nextFeatureWorkflowActions(
        state({
          runs: [instruction, implementRun(), appReviewFixRun(1, "running")],
          appReviews: [failedAppReview("1 failed")],
          pendingQuestions,
        }),
      ),
    ).toEqual([{ type: "answer-questions", requestId: "request-1", answers: { scope: "Small" } }]);
  });

  it("leaves Features that started in Plan mode to the user", () => {
    const planId = PlanId.make("plan-1");
    expect(
      nextFeatureWorkflowActions(
        state({
          runs: [instructionRun(), run("legacy-implement", "completed", { threadId, planId })],
        }),
      ),
    ).toEqual([]);
  });

  it("runs App Review first, then Code Review, then opens the pull request", () => {
    const runs = [instructionRun(), implementRun()];
    expect(nextFeatureWorkflowActions(state({ runs, appReviews: [], reviews: [] }))).toEqual([
      { type: "app-review", cycle: 1 },
    ]);
    // Launched but not started yet, then running: the same cycle, then nothing to do.
    expect(
      nextFeatureWorkflowActions(
        state({
          runs,
          appReviews: [{ status: null, reportMarkdown: "", evidenceMarkdown: "" }],
          reviews: [],
        }),
      ),
    ).toEqual([{ type: "app-review", cycle: 1 }]);
    expect(
      nextFeatureWorkflowActions(
        state({
          runs,
          appReviews: [{ status: "pending", reportMarkdown: "", evidenceMarkdown: "" }],
          reviews: [],
        }),
      ),
    ).toEqual([]);
    expect(nextFeatureWorkflowActions(state({ runs, reviews: [] }))).toEqual([
      { type: "review", cycle: 1 },
    ]);
    expect(nextFeatureWorkflowActions(state({ runs }))).toEqual([
      {
        type: "open-pull-request",
        appReview: { status: "passed", cycle: 1, evidenceMarkdown: "- Passed: `pnpm e2e`" },
        unresolvedFindingsMarkdown: null,
      },
    ]);
  });

  it("has the Feature thread fix App Review failures, then tests the running app again", () => {
    const base = [instructionRun(), implementRun()];
    const failed = failedAppReview("Suite: pnpm e2e\ncheckout.spec failed");
    expect(
      nextFeatureWorkflowActions(state({ runs: base, appReviews: [failed], reviews: [] })),
    ).toEqual([{ type: "app-review-fix", cycle: 1, reportMarkdown: failed.reportMarkdown }]);
    expect(
      nextFeatureWorkflowActions(
        state({ runs: [...base, appReviewFixRun(1, "running")], appReviews: [failed] }),
      ),
    ).toEqual([]);
    expect(
      nextFeatureWorkflowActions(
        state({ runs: [...base, appReviewFixRun(1)], appReviews: [failed], reviews: [] }),
      ),
    ).toEqual([{ type: "app-review", cycle: 2 }]);
    expect(
      nextFeatureWorkflowActions(
        state({ runs: [...base, appReviewFixRun(1)], appReviews: [failed, passedAppReview] }),
      ),
    ).toEqual([
      {
        type: "open-pull-request",
        appReview: { status: "passed", cycle: 2, evidenceMarkdown: "- Passed: `pnpm e2e`" },
        unresolvedFindingsMarkdown: null,
      },
    ]);
  });

  it("moves on to Code Review with the last App Review findings once every cycle is used", () => {
    const runs = [instructionRun(), implementRun(), appReviewFixRun(1), appReviewFixRun(2)];
    const appReviews = [1, 2, 3].map((cycle) => failedAppReview(`App Review cycle ${cycle}`));
    expect(nextFeatureWorkflowActions(state({ runs, appReviews, reviews: [] }))).toEqual([
      { type: "review", cycle: 1 },
    ]);
    expect(nextFeatureWorkflowActions(state({ runs, appReviews }))).toEqual([
      {
        type: "open-pull-request",
        appReview: {
          status: "unresolved",
          reportMarkdown: "App Review cycle 3",
          evidenceMarkdown: "- Failed: `pnpm e2e`",
        },
        unresolvedFindingsMarkdown: null,
      },
    ]);
  });

  it("moves on to Code Review without App Review when its cycle cannot run", () => {
    const runs = [instructionRun(), implementRun()];
    const skipped = {
      runs,
      appReviews: [],
      appReviewSkippedReason: "its App Stack did not start (no stack).",
    };
    expect(nextFeatureWorkflowActions(state({ ...skipped, reviews: [] }))).toEqual([
      { type: "review", cycle: 1 },
    ]);
    expect(nextFeatureWorkflowActions(state(skipped))).toEqual([
      {
        type: "open-pull-request",
        appReview: {
          status: "skipped",
          cycle: 1,
          reason: "its App Stack did not start (no stack).",
        },
        unresolvedFindingsMarkdown: null,
      },
    ]);
  });

  it("has the Feature thread fix Code Review findings, then reviews again until clean", () => {
    const base = [instructionRun(), implementRun()];
    const findings = { runStatus: "completed" as const, finalText: review("findings", "1. bug") };
    expect(nextFeatureWorkflowActions(state({ runs: base, reviews: [findings] }))).toEqual([
      { type: "fix", cycle: 1, reportMarkdown: "1. bug" },
    ]);
    expect(
      nextFeatureWorkflowActions(
        state({ runs: [...base, fixRun(1, "running")], reviews: [findings] }),
      ),
    ).toEqual([]);
    expect(
      nextFeatureWorkflowActions(state({ runs: [...base, fixRun(1)], reviews: [findings] })),
    ).toEqual([{ type: "review", cycle: 2 }]);
    expect(
      nextFeatureWorkflowActions(
        state({ runs: [...base, fixRun(1)], reviews: [findings, cleanReview] }),
      ),
    ).toEqual([
      {
        type: "open-pull-request",
        appReview: { status: "passed", cycle: 1, evidenceMarkdown: "- Passed: `pnpm e2e`" },
        unresolvedFindingsMarkdown: null,
      },
    ]);
  });

  it("opens the pull request with the last Code Review findings once every cycle is used", () => {
    const runs = [instructionRun(), implementRun(), fixRun(1), fixRun(2), fixRun(3), fixRun(4)];
    const reviews = [1, 2, 3, 4, 5].map((cycle) => ({
      runStatus: "completed" as const,
      finalText: review("findings", `finding from cycle ${cycle}`),
    }));
    expect(nextFeatureWorkflowActions(state({ runs, reviews }))).toEqual([
      {
        type: "open-pull-request",
        appReview: { status: "passed", cycle: 1, evidenceMarkdown: "- Passed: `pnpm e2e`" },
        unresolvedFindingsMarkdown: "finding from cycle 5",
      },
    ]);
  });

  it("finishes once the pull request is linked and its turn is over", () => {
    const runs = [
      instructionRun(),
      implementRun(),
      run(featurePullRequestMessageId(threadId), "completed"),
    ];
    expect(nextFeatureWorkflowActions(state({ runs }))).toEqual([]);
    expect(nextFeatureWorkflowActions(state({ runs, pullRequestLinked: true }))).toEqual([
      { type: "complete", reason: "pull-request-linked" },
    ]);
    // A pull-request turn that already started ends the reviews.
    expect(
      nextFeatureWorkflowActions(
        state({ runs, appReviews: [], reviews: [], pullRequestLinked: true }),
      ),
    ).toEqual([{ type: "complete", reason: "pull-request-linked" }]);
    expect(
      nextFeatureWorkflowActions(state({ runs, pullRequestLinked: true, completed: true })),
    ).toEqual([]);
  });

  it("waits for the user when a step's turn failed", () => {
    expect(nextFeatureWorkflowActions(state({ runs: [instructionRun("failed")] }))).toEqual([]);
    expect(
      nextFeatureWorkflowActions(state({ runs: [instructionRun(), implementRun("failed")] })),
    ).toEqual([]);
    expect(
      nextFeatureWorkflowActions(
        state({
          runs: [instructionRun(), implementRun()],
          reviews: [{ runStatus: "failed", finalText: null }],
        }),
      ),
    ).toEqual([]);
  });
});

describe("featureInstructionRun", () => {
  it("is the user's latest turn before the implement turn, not earlier chat or workflow turns", () => {
    const chat = instructionRun();
    const instruction = instructionRun();
    const implement = implementRun();
    const later = run("user-after-the-feature");
    expect(featureInstructionRun(threadId, [chat, instruction])).toBe(instruction);
    expect(featureInstructionRun(threadId, [chat, instruction, implement, later])).toBe(
      instruction,
    );
  });
});

describe("featureE2eAppReviewState", () => {
  const cycle = (overrides: Record<string, unknown>) =>
    ({
      actionableFindingsMarkdown: null,
      e2eExecution: {
        id: "execution-1",
        commands: [],
        results: [
          {
            command: "pnpm e2e",
            executedCommand: "pnpm e2e",
            status: "failed",
            outputMarkdown: "1 failed",
            recordings: [
              { id: "r1", label: "checkout completes", path: "/r1", sizeBytes: 10 },
              { id: "r2", label: "cart keeps items", path: "/r2", sizeBytes: 10 },
            ],
            completedAt: "2026-10-18T00:00:00.000Z",
          },
        ],
      },
      ...overrides,
    }) as never;

  it("lists the recorded flows and hands the run's findings on as the fix report", () => {
    const failed = featureE2eAppReviewState({
      status: "exhausted",
      failure: null,
      cycles: [cycle({ actionableFindingsMarkdown: "Suite: pnpm e2e\n1 failed" })],
    });
    expect(failed).toEqual({
      status: "failed",
      reportMarkdown: "Suite: pnpm e2e\n1 failed",
      evidenceMarkdown:
        "- Failed: `pnpm e2e`\n  Recorded flows: checkout completes, cart keeps items",
    });
    expect(
      featureE2eAppReviewState({ status: "running", failure: null, cycles: [cycle({})] }).status,
    ).toBe("pending");
  });

  it("reports why a run that could not test failed", () => {
    const failed = featureE2eAppReviewState({
      status: "failed",
      failure: {
        reason: "preview-unavailable",
        phase: "e2e",
        cycleNumber: 1,
        detailMarkdown: "The stack never answered.",
        failedAt: "2026-10-18T00:00:00.000Z",
      },
      cycles: [],
    });
    expect(failed.status).toBe("failed");
    expect(failed.reportMarkdown).toContain("preview-unavailable");
    expect(failed.reportMarkdown).toContain("The stack never answered.");
    expect(failed.evidenceMarkdown).toContain("No E2E suite finished");
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
    expect(featureRootOfReviewThread(featureReviewThreadId(threadId, 3))).toBe(threadId);
    expect(featureRootOfReviewThread(featureAppReviewThreadId(threadId, 2))).toBe(threadId);
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
      appReview: { status: "skipped", cycle: 1, reason: "its App Stack did not start (down)." },
      unresolvedFindingsMarkdown: null,
    });
    expect(skipped).toContain(
      "App Review cycle 1 could not run: its App Stack did not start (down).",
    );
    const unresolved = buildFeaturePullRequestMessage({
      baseBranch: "dev",
      appReview: {
        status: "unresolved",
        reportMarkdown: "1. still broken",
        evidenceMarkdown: "- Failed: `pnpm e2e`",
      },
      unresolvedFindingsMarkdown: null,
    });
    expect(unresolved).toContain(
      "Unresolved App Review findings heading, unchanged:\n\n1. still broken",
    );
    expect(unresolved).toContain("- Failed: `pnpm e2e`");
    expect(unresolved).toContain("User intent, Guardrails, and Goal");
  });
});
