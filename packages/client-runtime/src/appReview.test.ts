import { describe, expect, it } from "vite-plus/test";
import {
  AppReviewId,
  CommandId,
  ProviderInstanceId,
  AppReviewWorkflowRunId,
  EMPTY_APP_REVIEW_EVIDENCE,
  ThreadId,
  type AppReviewRecord,
  type AppReviewWorkflowRun,
} from "@t3tools/contracts";

import {
  appReviewRunContainsThread,
  appReviewCycleReplayCount,
  appReviewCycleSteps,
  appReviewCycleStepStatuses,
  appReviewLaunchSummary,
  appReviewPhaseRerunDisabledReason,
  appReviewRunFailureSummary,
  appReviewRunReplayCount,
  appReviewRunStatusLabel,
  appReviewRunTicketLabel,
  appReviewTargetLabel,
  appReviewWorkflowLaunchCommand,
  isValidAppReviewWorkflowLaunch,
  selectActiveAppReviewRecord,
  selectAppReviewRunsForPanel,
  selectHeadlineAppReviewRun,
  selectLatestAppReviewControllerRun,
} from "./appReview.ts";

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
  it("labels a stoppable review as waiting while its readiness check retries", () => {
    const run = makeAppReviewWorkflowRun();
    expect(
      appReviewRunStatusLabel({
        ...run,
        prerequisiteCheck: {
          phase: "e2e",
          cycleNumber: 1,
          cwd: "/assigned",
          previewUrl: null,
          command: "check",
          nextCheckAt: run.updatedAt,
        },
      }),
    ).toBe("Waiting for test prerequisites");
  });
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
    expect(appReviewCycleStepStatuses(run.cycles[0]!)).toEqual([
      "not-needed",
      "complete",
      "complete",
      "pending",
    ]);
    expect(
      appReviewCycleStepStatuses({
        ...run.cycles[0]!,
        status: "fixing",
        fixerThreadId: ThreadId.make("thread-fixer"),
      }),
    ).toEqual(["not-needed", "complete", "complete", "current"]);
    expect(
      appReviewCycleStepStatuses({
        ...run.cycles[0]!,
        status: "completed",
        reviewVerdict: "passed",
        planId: null,
        fixerThreadId: null,
      }),
    ).toEqual(["not-needed", "complete", "not-needed", "not-needed"]);
  });

  it("shows E2E and browser review as consecutive steps", () => {
    const run = makeAppReviewWorkflowRun();
    const cycle = {
      ...run.cycles[0]!,
      appReviewScope: "both" as const,
      status: "reviewing" as const,
      e2eReviewId: AppReviewId.make("review-e2e-1"),
      e2eThreadId: ThreadId.make("thread-e2e"),
      e2eVerdict: "passed" as const,
      reviewVerdict: null,
      planId: null,
    };

    expect(appReviewCycleStepStatuses(cycle)).toEqual([
      "complete",
      "current",
      "pending",
      "pending",
    ]);
  });

  it("skips browser review for an E2E-only cycle", () => {
    const run = makeAppReviewWorkflowRun();
    expect(
      appReviewCycleStepStatuses({
        ...run.cycles[0]!,
        appReviewScope: "e2e",
        status: "planning",
        planId: null,
        e2eReviewId: AppReviewId.make("review-e2e-1"),
        e2eThreadId: ThreadId.make("thread-e2e"),
        e2eVerdict: "failed",
        reviewVerdict: "failed",
      }),
    ).toEqual(["complete", "not-needed", "current", "pending"]);
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
    expect(appReviewCycleStepStatuses(spent)).toEqual([
      "not-needed",
      "failed",
      "pending",
      "pending",
    ]);
    expect(
      appReviewCycleStepStatuses({
        ...spent,
        failure: { ...spent.failure, phase: "planning" as const },
      }),
    ).toEqual(["not-needed", "pending", "failed", "pending"]);
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
    ).toEqual(["not-needed", "failed", "pending", "pending"]);
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

  it("counts the recorded tests a cycle and its run can replay", () => {
    const run = makeAppReviewWorkflowRun();
    const recording = (id: string) => ({
      id,
      label: `test-${id}`,
      path: `/recordings/${id}.rrweb.jsonl`,
      sizeBytes: 1024,
    });
    const result = (command: string, recordings?: ReturnType<typeof recording>[]) => ({
      command,
      executedCommand: command,
      status: "failed" as const,
      outputMarkdown: "",
      ...(recordings === undefined ? {} : { recordings }),
      completedAt: "2026-08-11T00:02:00.000Z",
    });
    const firstCycle = {
      ...run.cycles[0]!,
      e2eExecution: {
        id: "execution-1",
        commands: [
          { command: "pnpm e2e web", retryCommand: "pnpm e2e web" },
          { command: "pnpm e2e api", retryCommand: "pnpm e2e api" },
        ],
        results: [result("pnpm e2e web", [recording("1"), recording("2")]), result("pnpm e2e api")],
      },
    };
    const secondCycle = {
      ...run.cycles[0]!,
      cycleNumber: 2,
      e2eExecution: {
        id: "execution-2",
        commands: [{ command: "pnpm e2e web", retryCommand: "pnpm e2e web" }],
        results: [result("pnpm e2e web", [recording("3")])],
      },
    };

    expect(appReviewCycleReplayCount(firstCycle)).toBe(2);
    expect(appReviewCycleReplayCount(run.cycles[0]!)).toBe(0);
    expect(appReviewRunReplayCount({ cycles: [firstCycle, secondCycle] })).toBe(3);
    expect(appReviewRunReplayCount(run)).toBe(0);
  });
});

describe("appReviewTargetLabel", () => {
  it("names the host a launch will drive", () => {
    expect(appReviewTargetLabel("localhost:5173")).toBe("localhost:5173");
    expect(appReviewTargetLabel("https://staging.example.test/app")).toBe("staging.example.test");
  });

  it("falls back to the worktree's App Stack without a usable URL", () => {
    expect(appReviewTargetLabel("")).toBe("App Stack");
    expect(appReviewTargetLabel("not a url")).toBe("App Stack");
  });
});

describe("appReviewLaunchSummary", () => {
  it("counts cycles for a run that repairs", () => {
    expect(appReviewLaunchSummary({ cycleBudget: 10, reviewUrl: "", reviewOnly: false })).toBe(
      "10 cycles · App Stack",
    );
    expect(appReviewLaunchSummary({ cycleBudget: 1, reviewUrl: "", reviewOnly: false })).toBe(
      "1 cycle · App Stack",
    );
  });

  it("drops the count when nothing will be repaired", () => {
    expect(
      appReviewLaunchSummary({ cycleBudget: 10, reviewUrl: "localhost:5173", reviewOnly: true }),
    ).toBe("Review only · localhost:5173");
  });
});

describe("appReviewWorkflowLaunchCommand", () => {
  const base = {
    commandId: CommandId.make("command-1"),
    targetThreadId: ThreadId.make("thread-target"),
    controllerThreadId: ThreadId.make("thread-controller"),
    supportingContextMarkdown: null,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-sol" },
    createdAt: "2026-08-11T00:00:00.000Z",
  };

  it("pins a named review URL and resolves the App Stack without one", () => {
    const pinned = appReviewWorkflowLaunchCommand({
      ...base,
      request: {
        brief: "Check login",
        cycleBudget: 3,
        reviewUrl: "localhost:5173",
        reviewOnly: false,
      },
    });
    expect(pinned).toMatchObject({
      caller: { type: "standalone", sourceThreadId: "thread-target" },
      previewTargets: ["localhost:5173"],
      previewTargetsPinned: true,
      cycleBudget: 3,
    });
    const resolved = appReviewWorkflowLaunchCommand({
      ...base,
      request: { brief: "Check login", cycleBudget: 3, reviewUrl: "", reviewOnly: false },
    });
    expect(resolved).toMatchObject({ previewTargets: [], previewTargetsPinned: false });
  });

  it("spends exactly one cycle when it only reviews", () => {
    const command = appReviewWorkflowLaunchCommand({
      ...base,
      request: { brief: "Check login", cycleBudget: 8, reviewUrl: "", reviewOnly: true },
    });
    expect(command).toMatchObject({ reviewOnly: true, cycleBudget: 1 });
  });
});

describe("appReviewCycleSteps", () => {
  it("lists all four steps for a browser cycle", () => {
    const cycle = makeAppReviewWorkflowRun().cycles[0]!;
    expect(appReviewCycleSteps(cycle).map((step) => [step.number, step.title])).toEqual([
      [1, "End-to-end test"],
      [2, "Human-style UI review"],
      [3, "Gap analysis & repair tickets"],
      [4, "Implement the repair tickets"],
    ]);
  });

  it("renumbers an E2E-only cycle and sends planning to the E2E thread", () => {
    const cycle = {
      ...makeAppReviewWorkflowRun().cycles[0]!,
      appReviewScope: "e2e" as const,
      e2eThreadId: ThreadId.make("thread-e2e"),
      plannerThreadId: null,
    };
    const steps = appReviewCycleSteps(cycle);
    expect(steps.map((step) => step.number)).toEqual([1, 2, 3]);
    expect(steps[1]).toMatchObject({
      title: "Gap analysis & repair tickets",
      threadId: "thread-e2e",
    });
  });
});

describe("appReviewPhaseRerunDisabledReason", () => {
  const run = makeAppReviewWorkflowRun();
  const input = {
    phaseLabel: "Gap analysis",
    phase: "planning" as const,
    cycle: run.cycles[0]!,
    isCurrentCycle: true,
    callerBusyReason: null,
    cyclesUsed: 1,
    cycleBudget: 10,
    activeThread: undefined,
  };

  it("allows the current cycle's phase once what it needs exists", () => {
    expect(appReviewPhaseRerunDisabledReason(input)).toBeNull();
  });

  it("refuses older cycles, live agents, and spent budgets", () => {
    expect(appReviewPhaseRerunDisabledReason({ ...input, isCurrentCycle: false })).toBe(
      "Only the newest cycle can start again.",
    );
    expect(
      appReviewPhaseRerunDisabledReason({
        ...input,
        activeThread: { session: { status: "running" } },
      }),
    ).toBe("This App Review is still running. Stop it before starting a phase again.");
    expect(appReviewPhaseRerunDisabledReason({ ...input, phase: "review", cyclesUsed: 10 })).toBe(
      "Every one of the 10 review cycles has been used.",
    );
  });

  it("needs repair tickets before the repair can run again", () => {
    expect(appReviewPhaseRerunDisabledReason({ ...input, phase: "fixing" })).toBe(
      "The repair needs the tickets gap analysis writes.",
    );
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
    phaseExecution: null,
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
