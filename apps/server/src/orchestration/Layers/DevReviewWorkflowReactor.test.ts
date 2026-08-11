import { expect, it } from "vite-plus/test";
import {
  DevReviewId,
  DevReviewWorkflowCycleBudget,
  DevReviewWorkflowRunId,
  ThreadId,
  type DevReviewRecord,
  type DevReviewWorkflowRun,
} from "@t3tools/contracts";

import { nextDevReviewWorkflowAction, terminalReviewAction } from "./DevReviewWorkflowReactor.ts";

const now = "2026-01-01T00:00:00.000Z";

function run(overrides: Partial<DevReviewWorkflowRun> = {}): DevReviewWorkflowRun {
  return {
    id: DevReviewWorkflowRunId.make("dev-review-workflow-thread-controller"),
    targetThreadId: ThreadId.make("thread-target"),
    controllerThreadId: ThreadId.make("thread-controller"),
    caller: { type: "standalone", sourceThreadId: ThreadId.make("thread-target") },
    briefMarkdown: "Review checkout.",
    supportingContextMarkdown: null,
    previewTargets: ["http://localhost:3000"],
    cycleBudget: DevReviewWorkflowCycleBudget.make(10),
    attemptsUsed: 0,
    status: "running",
    cycles: [],
    activePhase: null,
    activeThreadId: null,
    workspaceRevision: {
      headSha: "abc123",
      workingTreeDiffHash: "working",
      branchDiffHash: "branch",
      fingerprint: "abc123:working:branch",
    },
    finalHeadSha: null,
    outcome: null,
    failure: null,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    ...overrides,
  };
}

function review(
  verdict: "passed" | "failed" | "blocked",
  withFinding = verdict === "failed",
): DevReviewRecord {
  return {
    id: DevReviewId.make("dev-review-1"),
    sourceThreadId: ThreadId.make("thread-controller"),
    reviewThreadId: ThreadId.make("thread-reviewer"),
    sourceTurnId: null,
    status: verdict,
    document: {
      verdict,
      summary: `${verdict} review`,
      checks: [],
      findings: withFinding
        ? [
            {
              id: "finding-1",
              severity: "major",
              title: "Submit does not recover",
              details: "The button remains disabled.",
              reproduction: "Submit invalid credentials.",
              evidenceIds: [],
            },
          ]
        : [],
      questions: [],
      nextSteps: [],
    },
    evidence: {
      recording: {
        status: "saved",
        path: "/tmp/recording.webm",
        mimeType: "video/webm",
        sizeBytes: 10,
        startedAt: now,
        completedAt: now,
        error: null,
      },
      screenshots: [],
    },
    createdAt: now,
    updatedAt: now,
  };
}

it("always begins a nonterminal run with Browser Dev Review", () => {
  expect(nextDevReviewWorkflowAction(run())).toBe("review");
});

it("waits for Implementation to refresh AppDevStack after an embedded repair", () => {
  const embedded = run({
    caller: {
      type: "implementation",
      implementationRunId: "implementation-run-1",
      orchestratorThreadId: ThreadId.make("thread-target"),
    },
    attemptsUsed: 1,
    cycles: [
      {
        cycleNumber: 1,
        status: "completed",
        reviewId: DevReviewId.make("dev-review-1"),
        reviewerThreadId: ThreadId.make("thread-reviewer"),
        reviewVerdict: "failed",
        actionableFindingsMarkdown: "Fix checkout.",
        planId: "plan-1",
        plannerTurnId: null,
        fixerThreadId: ThreadId.make("thread-fixer"),
        fixResult: {
          runId: DevReviewWorkflowRunId.make("dev-review-workflow-thread-controller"),
          planId: "plan-1",
          status: "succeeded",
          commitSha: "def456",
          validations: [
            {
              command: "vp test run checkout.test.ts",
              status: "passed",
              outputMarkdown: "ok",
              completedAt: now,
            },
          ],
          notesMarkdown: "Fixed checkout.",
        },
        workspaceRevision: {
          headSha: "abc123",
          workingTreeDiffHash: "working",
          branchDiffHash: "branch",
          fingerprint: "abc123:working:branch",
        },
        startedAt: now,
        completedAt: now,
      },
    ],
  });

  expect(nextDevReviewWorkflowAction(embedded)).toBe("none");
});

it("passes on cycle one and plans a repair after an ordinary failed review", () => {
  expect(terminalReviewAction(run({ attemptsUsed: 1 }), review("passed"))).toBe("passed");
  expect(terminalReviewAction(run({ attemptsUsed: 1 }), review("failed"))).toBe("planning");
});

it("exhausts on the final failed review without scheduling another repair", () => {
  expect(
    terminalReviewAction(
      run({ attemptsUsed: 10, cycleBudget: DevReviewWorkflowCycleBudget.make(10) }),
      review("failed"),
    ),
  ).toBe("exhausted");
});

it("treats blocked reviews and failures without actionable findings as blocked", () => {
  expect(terminalReviewAction(run({ attemptsUsed: 1 }), review("blocked"))).toBe("blocked");
  expect(terminalReviewAction(run({ attemptsUsed: 1 }), review("failed", false))).toBe("blocked");
});
