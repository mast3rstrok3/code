import { describe, expect, it } from "vite-plus/test";
import {
  DevReviewId,
  DevReviewWorkflowRunId,
  EMPTY_DEV_REVIEW_EVIDENCE,
  ThreadId,
  type DevReviewRecord,
  type DevReviewWorkflowRun,
} from "@t3tools/contracts";

import {
  devReviewRunContainsThread,
  devReviewRunStatusLabel,
  isValidDevReviewWorkflowLaunch,
  selectActiveDevReviewRecord,
} from "./DevReviewPanel.logic";

describe("selectActiveDevReviewRecord", () => {
  it("prefers the record whose review thread is open", () => {
    const sourceThreadId = ThreadId.make("thread-source");
    const openedReviewThreadId = ThreadId.make("thread-review-open");
    const records = [
      makeDevReviewRecord({
        id: DevReviewId.make("dev-review-latest"),
        sourceThreadId,
        reviewThreadId: ThreadId.make("thread-review-latest"),
        createdAt: "2026-03-09T12:00:00.000Z",
      }),
      makeDevReviewRecord({
        id: DevReviewId.make("dev-review-open"),
        sourceThreadId,
        reviewThreadId: openedReviewThreadId,
        createdAt: "2026-03-09T11:00:00.000Z",
      }),
    ];

    expect(selectActiveDevReviewRecord(records, openedReviewThreadId)?.id).toBe("dev-review-open");
  });

  it("falls back to the latest source-thread record", () => {
    const records = [
      makeDevReviewRecord({
        id: DevReviewId.make("dev-review-old"),
        createdAt: "2026-03-09T11:00:00.000Z",
      }),
      makeDevReviewRecord({
        id: DevReviewId.make("dev-review-new"),
        createdAt: "2026-03-09T12:00:00.000Z",
      }),
    ];

    expect(selectActiveDevReviewRecord(records, ThreadId.make("thread-source"))?.id).toBe(
      "dev-review-new",
    );
  });
});

describe("Dev Review workflow panel logic", () => {
  it("accepts settled launches with a 1-50 attempt budget before preview resolution", () => {
    const valid = {
      brief: "Review checkout",
      cycleBudget: 10,
      sourceSettled: true,
      worktreeOwned: false,
    };
    expect(isValidDevReviewWorkflowLaunch(valid)).toBe(true);
    expect(isValidDevReviewWorkflowLaunch({ ...valid, brief: " " })).toBe(false);
    expect(isValidDevReviewWorkflowLaunch({ ...valid, cycleBudget: 0 })).toBe(false);
    expect(isValidDevReviewWorkflowLaunch({ ...valid, cycleBudget: 51 })).toBe(false);
    expect(isValidDevReviewWorkflowLaunch({ ...valid, sourceSettled: false })).toBe(false);
    expect(isValidDevReviewWorkflowLaunch({ ...valid, worktreeOwned: true })).toBe(false);
  });

  it("shows phase and cycle progress and resolves every workflow child", () => {
    const run = makeDevReviewWorkflowRun();
    expect(devReviewRunStatusLabel(run)).toBe("planning · Cycle 1 of 10");
    for (const threadId of [
      run.targetThreadId,
      run.controllerThreadId,
      run.cycles[0]!.reviewerThreadId,
      run.cycles[0]!.fixerThreadId!,
    ]) {
      expect(devReviewRunContainsThread(run, threadId)).toBe(true);
    }
    expect(
      devReviewRunStatusLabel({
        ...run,
        status: "exhausted",
        outcome: "exhausted",
        activePhase: null,
      }),
    ).toBe("exhausted");
  });
});

function makeDevReviewRecord(overrides: Partial<DevReviewRecord> = {}): DevReviewRecord {
  return {
    id: DevReviewId.make("dev-review-1"),
    sourceThreadId: ThreadId.make("thread-source"),
    reviewThreadId: ThreadId.make("thread-review"),
    sourceTurnId: null,
    status: "pending",
    document: {
      verdict: "pending",
      summary: "",
      checks: [],
      findings: [],
      questions: [],
      nextSteps: [],
    },
    evidence: EMPTY_DEV_REVIEW_EVIDENCE,
    createdAt: "2026-03-09T10:00:00.000Z",
    updatedAt: "2026-03-09T10:00:00.000Z",
    ...overrides,
  };
}

function makeDevReviewWorkflowRun(): DevReviewWorkflowRun {
  const revision = {
    headSha: "abc123",
    workingTreeDiffHash: "working-hash",
    branchDiffHash: "branch-hash",
    fingerprint: "fingerprint",
  };
  return {
    id: DevReviewWorkflowRunId.make("dev-review-workflow-controller"),
    targetThreadId: ThreadId.make("thread-target"),
    controllerThreadId: ThreadId.make("thread-controller"),
    caller: { type: "standalone", sourceThreadId: ThreadId.make("thread-target") },
    briefMarkdown: "Review checkout",
    supportingContextMarkdown: null,
    previewTargets: ["https://preview.example.test"],
    cycleBudget: 10,
    attemptsUsed: 1,
    status: "running",
    cycles: [
      {
        cycleNumber: 1,
        status: "planning",
        reviewId: DevReviewId.make("review-1"),
        reviewerThreadId: ThreadId.make("thread-reviewer"),
        reviewVerdict: "failed",
        actionableFindingsMarkdown: "Fix validation.",
        planId: "plan-1",
        plannerTurnId: null,
        fixerThreadId: ThreadId.make("thread-fixer"),
        fixResult: null,
        workspaceRevision: revision,
        startedAt: "2026-08-11T00:00:00.000Z",
        completedAt: null,
      },
    ],
    activePhase: "planning",
    activeThreadId: ThreadId.make("thread-controller"),
    workspaceRevision: revision,
    finalHeadSha: null,
    outcome: null,
    failure: null,
    createdAt: "2026-08-11T00:00:00.000Z",
    updatedAt: "2026-08-11T00:01:00.000Z",
    completedAt: null,
  };
}
