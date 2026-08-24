import { describe, expect, it } from "vite-plus/test";
import {
  AppReviewId,
  AppReviewWorkflowRunId,
  EMPTY_APP_REVIEW_EVIDENCE,
  ThreadId,
  type AppReviewRecord,
  type AppReviewWorkflowRun,
} from "@t3tools/contracts";

import {
  appReviewRunContainsThread,
  appReviewCycleStepStatuses,
  appReviewRunFailureSummary,
  appReviewRunStatusLabel,
  appReviewRunTicketLabel,
  isValidAppReviewWorkflowLaunch,
  selectActiveAppReviewRecord,
  selectAppReviewRunsForPanel,
  selectHeadlineAppReviewRun,
  selectLatestAppReviewControllerRun,
} from "./AppReviewPanel.logic";

describe("selectActiveAppReviewRecord", () => {
  it("prefers the record whose review thread is open", () => {
    const sourceThreadId = ThreadId.make("thread-source");
    const openedReviewThreadId = ThreadId.make("thread-review-open");
    const records = [
      makeAppReviewRecord({
        id: AppReviewId.make("app-review-latest"),
        sourceThreadId,
        reviewThreadId: ThreadId.make("thread-review-latest"),
        createdAt: "2026-03-09T12:00:00.000Z",
      }),
      makeAppReviewRecord({
        id: AppReviewId.make("app-review-open"),
        sourceThreadId,
        reviewThreadId: openedReviewThreadId,
        createdAt: "2026-03-09T11:00:00.000Z",
      }),
    ];

    expect(selectActiveAppReviewRecord(records, openedReviewThreadId)?.id).toBe("app-review-open");
  });

  it("falls back to the latest source-thread record", () => {
    const records = [
      makeAppReviewRecord({
        id: AppReviewId.make("app-review-old"),
        createdAt: "2026-03-09T11:00:00.000Z",
      }),
      makeAppReviewRecord({
        id: AppReviewId.make("app-review-new"),
        createdAt: "2026-03-09T12:00:00.000Z",
      }),
    ];

    expect(selectActiveAppReviewRecord(records, ThreadId.make("thread-source"))?.id).toBe(
      "app-review-new",
    );
  });
});

describe("App Review workflow panel logic", () => {
  it("accepts settled launches with a dynamic 1-10 cycle budget before preview resolution", () => {
    const valid = {
      brief: "Review checkout",
      cycleBudget: 10,
      sourceSettled: true,
      worktreeOwned: false,
    };
    expect(isValidAppReviewWorkflowLaunch(valid)).toBe(true);
    expect(isValidAppReviewWorkflowLaunch({ ...valid, brief: " " })).toBe(false);
    expect(isValidAppReviewWorkflowLaunch({ ...valid, cycleBudget: 0 })).toBe(false);
    expect(isValidAppReviewWorkflowLaunch({ ...valid, cycleBudget: 51 })).toBe(false);
    expect(isValidAppReviewWorkflowLaunch({ ...valid, sourceSettled: false })).toBe(false);
    expect(isValidAppReviewWorkflowLaunch({ ...valid, worktreeOwned: true })).toBe(false);
  });

  it("shows phase and cycle progress and resolves every workflow child", () => {
    const run = makeAppReviewWorkflowRun();
    expect(appReviewRunStatusLabel(run)).toBe("Gap analysis & plan · Cycle 1 of 10");
    for (const threadId of [
      run.targetThreadId,
      run.controllerThreadId,
      run.cycles[0]!.reviewerThreadId,
      run.cycles[0]!.fixerThreadId!,
    ]) {
      expect(appReviewRunContainsThread(run, threadId)).toBe(true);
    }
    expect(
      appReviewRunStatusLabel({
        ...run,
        status: "exhausted",
        outcome: "exhausted",
        activePhase: null,
      }),
    ).toBe("exhausted");
  });

  it("shows review and planning in one cycle before implementation", () => {
    const run = makeAppReviewWorkflowRun();
    expect(appReviewCycleStepStatuses(run.cycles[0]!)).toEqual(["complete", "complete", "pending"]);
    expect(
      appReviewCycleStepStatuses({
        ...run.cycles[0]!,
        status: "fixing",
        fixerThreadId: ThreadId.make("thread-fixer"),
      }),
    ).toEqual(["complete", "complete", "current"]);
    expect(
      appReviewCycleStepStatuses({
        ...run.cycles[0]!,
        status: "completed",
        reviewVerdict: "passed",
        planId: null,
        fixerThreadId: null,
      }),
    ).toEqual(["complete", "not-needed", "not-needed"]);
  });

  it("marks the step a spent cycle broke on and leaves the rest unreached", () => {
    const run = makeAppReviewWorkflowRun();
    const spent = {
      ...run.cycles[0]!,
      status: "failed" as const,
      reviewVerdict: null,
      planId: null,
      fixerThreadId: null,
      failure: {
        reason: "review-blocked" as const,
        phase: "review" as const,
        cycleNumber: 1,
        detailMarkdown: "You've hit your usage limit.",
        failedAt: "2026-01-01T00:01:00.000Z",
      },
    };
    expect(appReviewCycleStepStatuses(spent)).toEqual(["failed", "pending", "pending"]);
    expect(
      appReviewCycleStepStatuses({
        ...spent,
        failure: { ...spent.failure, phase: "planning" as const },
      }),
    ).toEqual(["pending", "failed", "pending"]);
  });

  it("blames the review when a spent cycle predates per-cycle failures", () => {
    const run = makeAppReviewWorkflowRun();
    expect(
      appReviewCycleStepStatuses({
        ...run.cycles[0]!,
        status: "failed",
        reviewVerdict: null,
        planId: null,
        fixerThreadId: null,
      }),
    ).toEqual(["failed", "pending", "pending"]);
  });

  it("selects the latest run controlled by the open thread", () => {
    const threadId = ThreadId.make("thread-controller");
    const older = makeAppReviewWorkflowRun();
    const newer = {
      ...older,
      id: AppReviewWorkflowRunId.make("app-review-workflow-newer"),
      updatedAt: "2026-08-11T00:02:00.000Z",
    };
    const unrelated = {
      ...newer,
      id: AppReviewWorkflowRunId.make("app-review-workflow-unrelated"),
      controllerThreadId: ThreadId.make("thread-other"),
      updatedAt: "2026-08-11T00:03:00.000Z",
    };

    expect(selectLatestAppReviewControllerRun([older, unrelated, newer], threadId)?.id).toBe(
      newer.id,
    );
  });

  it("shows every run from a workflow-scoped artifact response, oldest first", () => {
    const older = makeAppReviewWorkflowRun();
    const newer = {
      ...older,
      id: AppReviewWorkflowRunId.make("app-review-workflow-newer"),
      targetThreadId: ThreadId.make("thread-other-target"),
      controllerThreadId: ThreadId.make("thread-other-controller"),
      createdAt: "2026-08-11T00:02:00.000Z",
    };

    expect(
      selectAppReviewRunsForPanel({
        runs: [older, newer],
        openedThreadId: ThreadId.make("workflow-root"),
        workflowScoped: true,
      }).map((run) => run.id),
    ).toEqual([older.id, newer.id]);
    expect(
      selectAppReviewRunsForPanel({
        runs: [older, newer],
        openedThreadId: older.targetThreadId,
        workflowScoped: false,
      }).map((run) => run.id),
    ).toEqual([older.id]);
  });

  it("orders runs by ticket and then by cycle, with the workflow's own review last", () => {
    const base = makeAppReviewWorkflowRun();
    const secondTicket = makeTicketRun({
      id: "app-review-workflow-ticket-2",
      ticketId: "ticket-2",
      createdAt: "2026-08-11T00:01:00.000Z",
    });
    const firstTicket = makeTicketRun({
      id: "app-review-workflow-ticket-1",
      ticketId: "ticket-1",
      createdAt: "2026-08-11T00:02:00.000Z",
    });
    const firstTicketRerun = makeTicketRun({
      id: "app-review-workflow-ticket-1-again",
      ticketId: "ticket-1",
      createdAt: "2026-08-11T00:03:00.000Z",
    });
    const runLevel = {
      ...base,
      id: AppReviewWorkflowRunId.make("app-review-workflow-run-level"),
      caller: {
        type: "implementation" as const,
        implementationRunId: "implementation-run-1",
        orchestratorThreadId: ThreadId.make("thread-orchestrator"),
      },
      createdAt: "2026-08-11T00:00:00.000Z",
    };

    expect(
      selectAppReviewRunsForPanel({
        runs: [runLevel, firstTicketRerun, secondTicket, firstTicket],
        openedThreadId: ThreadId.make("workflow-root"),
        workflowScoped: true,
        tickets: [makeTicket("ticket-1", 0), makeTicket("ticket-2", 1)],
      }).map((run) => run.id),
    ).toEqual([firstTicket.id, firstTicketRerun.id, secondTicket.id, runLevel.id]);
  });

  it("names a ticket run by its ticket and leaves the workflow's own review unnamed", () => {
    const tickets = [makeTicket("ticket-1", 0)];
    const ticketRun = makeTicketRun({
      id: "app-review-workflow-ticket-1",
      ticketId: "ticket-1",
      createdAt: "2026-08-11T00:02:00.000Z",
    });

    expect(appReviewRunTicketLabel(ticketRun, tickets)).toBe("TICKET-1 · Ticket ticket-1");
    expect(appReviewRunTicketLabel(makeAppReviewWorkflowRun(), tickets)).toBeNull();
    expect(
      appReviewRunTicketLabel(
        makeTicketRun({
          id: "app-review-workflow-dropped",
          ticketId: "ticket-dropped",
          createdAt: "2026-08-11T00:02:00.000Z",
        }),
        tickets,
      ),
    ).toBe("ticket-dropped");
  });

  it("headlines the running review, and the last one when nothing runs", () => {
    const running = makeAppReviewWorkflowRun();
    const settled: AppReviewWorkflowRun = {
      ...running,
      id: AppReviewWorkflowRunId.make("app-review-workflow-settled"),
      status: "passed",
      outcome: "passed",
      activePhase: null,
    };

    expect(selectHeadlineAppReviewRun([settled, running])?.id).toBe(running.id);
    expect(selectHeadlineAppReviewRun([running, settled])?.id).toBe(running.id);
    expect(
      selectHeadlineAppReviewRun([
        { ...settled, id: AppReviewWorkflowRunId.make("first") },
        settled,
      ])?.id,
    ).toBe(settled.id);
    expect(selectHeadlineAppReviewRun([])).toBeNull();
  });

  it("summarizes a launch failure without exposing its stack trace", () => {
    const run = makeAppReviewWorkflowRun();
    const failed: AppReviewWorkflowRun = {
      ...run,
      status: "failed",
      outcome: "failed",
      activePhase: null,
      failure: {
        reason: "automation-unavailable",
        phase: null,
        cycleNumber: null,
        detailMarkdown:
          "App Review automation failed.\n\nVcsRepositoryDetectionError: Workspace rejected.\n    at internal.ts:10:2",
        failedAt: "2026-08-11T00:02:00.000Z",
      },
    };

    expect(appReviewRunFailureSummary(failed)).toBe(
      "App Review automation failed.\nVcsRepositoryDetectionError: Workspace rejected.",
    );
    expect(appReviewRunFailureSummary(run)).toBeNull();
  });
});

function makeAppReviewRecord(overrides: Partial<AppReviewRecord> = {}): AppReviewRecord {
  return {
    id: AppReviewId.make("app-review-1"),
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
    evidence: EMPTY_APP_REVIEW_EVIDENCE,
    createdAt: "2026-03-09T10:00:00.000Z",
    updatedAt: "2026-03-09T10:00:00.000Z",
    ...overrides,
  };
}

function makeAppReviewWorkflowRun(): AppReviewWorkflowRun {
  const revision = {
    headSha: "abc123",
    workingTreeDiffHash: "working-hash",
    branchDiffHash: "branch-hash",
    fingerprint: "fingerprint",
  };
  return {
    id: AppReviewWorkflowRunId.make("app-review-workflow-controller"),
    targetThreadId: ThreadId.make("thread-target"),
    controllerThreadId: ThreadId.make("thread-controller"),
    caller: { type: "standalone", sourceThreadId: ThreadId.make("thread-target") },
    briefMarkdown: "Review checkout",
    supportingContextMarkdown: null,
    previewTargets: ["https://preview.example.test"],
    cycleBudget: 10,
    cyclesUsed: 1,
    status: "running",
    cycles: [
      {
        cycleNumber: 1,
        status: "planning",
        reviewId: AppReviewId.make("review-1"),
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
    activeThreadId: ThreadId.make("thread-reviewer"),
    workspaceRevision: revision,
    finalHeadSha: null,
    outcome: null,
    failure: null,
    createdAt: "2026-08-11T00:00:00.000Z",
    updatedAt: "2026-08-11T00:01:00.000Z",
    completedAt: null,
  };
}

function makeTicket(id: string, ordinal: number) {
  return {
    id,
    key: `TICKET-${String(ordinal + 1)}`,
    specId: "spec-1",
    ordinal,
    title: `Ticket ${id}`,
    bodyMarkdown: "Body",
    plannedFileChanges: [],
    dependencies: [],
    status: "open",
    createdAt: "2026-08-11T00:00:00.000Z",
    updatedAt: "2026-08-11T00:00:00.000Z",
  };
}

function makeTicketRun(input: {
  id: string;
  ticketId: string;
  createdAt: string;
}): AppReviewWorkflowRun {
  return {
    ...makeAppReviewWorkflowRun(),
    id: AppReviewWorkflowRunId.make(input.id),
    caller: {
      type: "implementation",
      implementationRunId: "implementation-run-1",
      orchestratorThreadId: ThreadId.make("thread-orchestrator"),
      ticketId: input.ticketId,
    },
    createdAt: input.createdAt,
  };
}
