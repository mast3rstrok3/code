import { expect, it } from "vite-plus/test";
import {
  AppReviewId,
  AppReviewWorkflowCycleBudget,
  AppReviewWorkflowRunId,
  ThreadId,
  type AppReviewCheck,
  type AppReviewRecord,
  type AppReviewWorkflowCycle,
  type AppReviewWorkflowRun,
  type OrchestrationImplementationRun,
} from "@t3tools/contracts";

import {
  ORPHANED_PROVIDER_SESSION_ERROR,
  STALE_TURN_RESUME_ACTIVITY_KIND,
  WORKFLOW_INTERRUPTION_ERROR_MESSAGE,
  WORKFLOW_NUDGE_EXHAUSTED_MESSAGE,
  type WorkflowNudgeThread,
} from "../workflowNudge.ts";
import {
  APP_REVIEW_FIXER_IMPLEMENTATION_ONLY_INSTRUCTION,
  APP_REVIEW_RECOVERY_SWEEP_INTERVAL_MS,
  appReviewPhaseModelStepWorkflowPromptId,
  appReviewPhaseFailureAction,
  appReviewPhaseLaunchCount,
  appReviewRecoveryEvidenceIsNewer,
  appReviewRecoveryTurnPending,
  appReviewPhaseThreadState,
  buildAppReviewFixPrompt,
  buildReviewPrompt,
  e2eCheckIdsForCommands,
  effectiveAppReviewScope,
  resolveEffectiveAppReviewScope,
  recoverableFailedAppReviewPhase,
  reopenFailedAppReviewPhase,
  priorCycleChecks,
  findAppReviewParentTicket,
  isSupersededAppReviewPhaseThread,
  isAppReviewWorkflowActivityKind,
  isAppReviewWorkflowSessionStatus,
  nextAppReviewWorkflowAction,
  phaseTurnCompleted,
  retryReviewPhaseInCycle,
  selectReviewRunToStart,
  selectStandalonePreviewTargets,
  successfulFixAction,
  terminalReviewAction,
  terminalReviewEvidenceFailure,
  terminalReviewPassFailure,
  threadTurnFailed,
} from "./AppReviewWorkflowReactor.ts";

const now = "2026-01-01T00:00:00.000Z";

it("reconciles running App Reviews after projection lag", () => {
  expect(APP_REVIEW_RECOVERY_SWEEP_INTERVAL_MS).toBe(30_000);
});

it("queues only App Review control and directive activities", () => {
  expect(isAppReviewWorkflowActivityKind("approval.requested")).toBe(true);
  expect(isAppReviewWorkflowActivityKind("user-input.requested")).toBe(true);
  expect(isAppReviewWorkflowActivityKind("app-review-repair-tickets")).toBe(true);
  expect(isAppReviewWorkflowActivityKind("app-review-fix-result")).toBe(true);
  expect(isAppReviewWorkflowActivityKind("tool.updated")).toBe(false);
  expect(isAppReviewWorkflowActivityKind("context-window.updated")).toBe(false);
});

it("queues only App Review session states that can advance or stop a phase", () => {
  expect(isAppReviewWorkflowSessionStatus("starting")).toBe(true);
  expect(isAppReviewWorkflowSessionStatus("running")).toBe(true);
  expect(isAppReviewWorkflowSessionStatus("error")).toBe(true);
  expect(isAppReviewWorkflowSessionStatus("ready")).toBe(false);
  expect(isAppReviewWorkflowSessionStatus("stopped")).toBe(false);
});

it("treats a completed one-turn phase as terminal once its session is idle", () => {
  expect(
    phaseTurnCompleted({ latestTurn: { state: "completed" }, session: { status: "ready" } }),
  ).toBe(true);
  expect(
    phaseTurnCompleted({ latestTurn: { state: "completed" }, session: { status: "running" } }),
  ).toBe(false);
  expect(phaseTurnCompleted({ latestTurn: { state: "error" }, session: { status: "error" } })).toBe(
    false,
  );
});

it("identifies phase workers that restart after their cycle was superseded", () => {
  const reviewer = ThreadId.make("thread-reviewer-old");
  const planner = ThreadId.make("thread-planner-old");
  const fixer = ThreadId.make("thread-fixer-old");
  const current = ThreadId.make("thread-reviewer-current");
  const workspaceRevision = {
    headSha: "abc123",
    workingTreeDiffHash: "working",
    branchDiffHash: "branch",
    fingerprint: "abc123:working:branch",
  };
  const workflow = run({
    activeThreadId: current,
    cycles: [
      {
        cycleNumber: 1,
        status: "failed",
        reviewId: AppReviewId.make("app-review-old"),
        reviewerThreadId: reviewer,
        reviewVerdict: null,
        actionableFindingsMarkdown: null,
        planId: null,
        plannerThreadId: planner,
        plannerTurnId: null,
        fixerThreadId: fixer,
        fixResult: null,
        workspaceRevision,
        startedAt: now,
        completedAt: now,
      },
      {
        cycleNumber: 2,
        status: "reviewing",
        reviewId: AppReviewId.make("app-review-current"),
        reviewerThreadId: current,
        reviewVerdict: null,
        actionableFindingsMarkdown: null,
        planId: null,
        plannerThreadId: null,
        plannerTurnId: null,
        fixerThreadId: null,
        fixResult: null,
        workspaceRevision,
        startedAt: now,
        completedAt: null,
      },
    ],
  });

  expect(isSupersededAppReviewPhaseThread(workflow, reviewer)).toBe(true);
  expect(isSupersededAppReviewPhaseThread(workflow, planner)).toBe(true);
  expect(isSupersededAppReviewPhaseThread(workflow, fixer)).toBe(true);
  expect(isSupersededAppReviewPhaseThread(workflow, current)).toBe(false);
  expect(isSupersededAppReviewPhaseThread(workflow, ThreadId.make("thread-unrelated"))).toBe(false);
});

it("keeps App Review fixers in the implementation-only phase", () => {
  expect(APP_REVIEW_FIXER_IMPLEMENTATION_ONLY_INSTRUCTION).toContain(
    "Do not call preview_* or app_review_* tools",
  );
  expect(APP_REVIEW_FIXER_IMPLEMENTATION_ONLY_INSTRUCTION).toContain(
    "starts a fresh reviewer after it receives your app-review-fix-result directive",
  );
});

it("tells a retried App Review fixer to continue inherited work", () => {
  const cycle = {
    ...reviewingRun().cycles[0]!,
    status: "fixing" as const,
    fixingLaunchCount: 2,
  };

  const prompt = buildAppReviewFixPrompt({ run: reviewingRun(), cycle, e2eCommands: [] });

  expect(prompt).toContain("A previous fixer worked in this same worktree");
  expect(prompt).toContain("Inspect Git status, the current diff, and recent commits");
  expect(prompt).toContain("finish every ticket in this durable phase thread");
});

function run(overrides: Partial<AppReviewWorkflowRun> = {}): AppReviewWorkflowRun {
  return {
    id: AppReviewWorkflowRunId.make("app-review-workflow-thread-controller"),
    targetThreadId: ThreadId.make("thread-target"),
    controllerThreadId: ThreadId.make("thread-controller"),
    caller: { type: "standalone", sourceThreadId: ThreadId.make("thread-target") },
    briefMarkdown: "Review checkout.",
    supportingContextMarkdown: null,
    previewTargets: ["http://localhost:3000"],
    cycleBudget: AppReviewWorkflowCycleBudget.make(10),
    cyclesUsed: 0,
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

function review(verdict: "passed" | "failed", withFinding = verdict === "failed"): AppReviewRecord {
  return {
    id: AppReviewId.make("app-review-1"),
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

it("uses separate model scopes for ticket and combined App Review phases", () => {
  expect(
    appReviewPhaseModelStepWorkflowPromptId(
      run({
        caller: {
          type: "implementation",
          implementationRunId: "implementation-run-1",
          orchestratorThreadId: ThreadId.make("thread-orchestrator"),
          ticketId: "ticket-1",
        },
      }),
    ),
  ).toBe("implementation.tdd.codex");
  expect(
    appReviewPhaseModelStepWorkflowPromptId(
      run({
        caller: {
          type: "implementation",
          implementationRunId: "implementation-run-1",
          orchestratorThreadId: ThreadId.make("thread-orchestrator"),
        },
      }),
    ),
  ).toBe("implementation.browser-app-review.codex");
});

it("always begins a nonterminal run with Browser App Review", () => {
  expect(nextAppReviewWorkflowAction(run())).toBe("review");
});

function reviewingRun(cyclesUsed = 1): AppReviewWorkflowRun {
  return run({
    cyclesUsed,
    activePhase: "review",
    activeThreadId: ThreadId.make("thread-reviewer"),
    cycles: [
      {
        cycleNumber: cyclesUsed,
        status: "reviewing",
        reviewId: AppReviewId.make("app-review-1"),
        reviewerThreadId: ThreadId.make("thread-reviewer"),
        reviewVerdict: null,
        actionableFindingsMarkdown: null,
        planId: null,
        plannerTurnId: null,
        fixerThreadId: null,
        fixResult: null,
        workspaceRevision: {
          headSha: "abc123",
          workingTreeDiffHash: "working",
          branchDiffHash: "branch",
          fingerprint: "abc123:working:branch",
        },
        startedAt: now,
        completedAt: null,
      },
    ],
  });
}

it("retries an infrastructure failure inside the current App Review cycle", () => {
  const cycle = reviewingRun().cycles[0]!;

  expect(appReviewPhaseLaunchCount(cycle, "review")).toBe(1);
  expect(appReviewPhaseFailureAction(cycle, "review")).toBe("retry-phase");
  expect(reviewingRun().cyclesUsed).toBe(1);
});

it("reuses the reviewer thread when retrying a review phase", () => {
  const planner = ThreadId.make("thread-old-planner");
  const fixer = ThreadId.make("thread-old-fixer");
  const failure = {
    reason: "review-blocked",
    phase: "review",
    cycleNumber: 4,
    detailMarkdown: "The provider session ended before it recorded a verdict.",
    failedAt: now,
  } as const;
  const workspaceRevision = {
    headSha: "def456",
    workingTreeDiffHash: "working-2",
    branchDiffHash: "branch-2",
    fingerprint: "def456:working-2:branch-2",
  };
  const cycle: AppReviewWorkflowCycle = {
    ...reviewingRun(4).cycles[0]!,
    reviewLaunchCount: 1,
    plannerThreadId: planner,
    plannerTurnId: null,
    fixerThreadId: fixer,
    repairTickets: [],
  };

  const retried = retryReviewPhaseInCycle({
    cycle,
    failure,
    workspaceRevision,
  });

  expect(retried.cycleNumber).toBe(4);
  expect(retried.reviewLaunchCount).toBe(2);
  expect(retried.planningLaunchCount).toBe(0);
  expect(retried.fixingLaunchCount).toBe(0);
  expect(retried.reviewId).toBe(cycle.reviewId);
  expect(retried.reviewerThreadId).toBe(cycle.reviewerThreadId);
  expect(retried.supersededThreadIds).toEqual(cycle.supersededThreadIds);
  expect(retried.plannerThreadId).toBeNull();
  expect(retried.fixerThreadId).toBeNull();
  expect(retried.repairTickets).toEqual([]);
  expect(retried.failure).toEqual(failure);
  expect(retried.workspaceRevision).toEqual(workspaceRevision);
});

it("fails the run after the current phase exhausts its bounded launches", () => {
  const cycle = { ...reviewingRun().cycles[0]!, reviewLaunchCount: 2 };

  expect(appReviewPhaseFailureAction(cycle, "review")).toBe("fail-run");
});

function failedImplementationReview(ticketId?: string): AppReviewWorkflowRun {
  const failure = {
    reason: "fixer-failed" as const,
    phase: "fixing" as const,
    cycleNumber: 1,
    detailMarkdown:
      "fixing exhausted its 2 phase launches.\n\nApp Review fixer completed without the required app-review-fix-result directive.",
    failedAt: now,
  };
  return run({
    caller: {
      type: "implementation",
      implementationRunId: "implementation-run-1",
      orchestratorThreadId: ThreadId.make("thread-implementation-orchestrator"),
      ...(ticketId === undefined ? {} : { ticketId }),
    },
    status: "failed",
    outcome: "failed",
    cyclesUsed: 1,
    activePhase: null,
    activeThreadId: null,
    failure,
    cycles: [
      {
        ...reviewingRun().cycles[0]!,
        status: "failed",
        reviewVerdict: "failed",
        actionableFindingsMarkdown: "The selected row disappears.",
        planId: "app-review-repair-tickets:1",
        plannerThreadId: ThreadId.make("thread-planner"),
        fixerThreadId: ThreadId.make("thread-fixer"),
        repairTickets: [
          {
            key: "TICKET-1.1",
            parentTicketKey: "TICKET-1",
            title: "Preserve the row",
            bodyMarkdown: "Keep the selected row visible.",
            dependencyKeys: [],
          },
        ],
        fixingLaunchCount: 2,
        failure,
        completedAt: now,
      },
    ],
    completedAt: now,
  });
}

it("claims one same-thread continuation for the failed review still owned by its ticket", () => {
  const failed = failedImplementationReview("TICKET-1");
  const parent = {
    id: "implementation-run-1",
    status: "needs-human-attention",
    automationHalt: {
      ticketId: "TICKET-1",
      stage: "app-review",
      category: "review-blocked",
      detail: failed.failure?.detailMarkdown ?? "Review failed.",
      haltedAt: now,
    },
    appReviewWorkflowRunIds: [],
    ticketStates: [
      {
        ticketId: "TICKET-1",
        status: "app-reviewing",
        appReviewWorkflowRunId: failed.id,
      },
    ],
  } as unknown as OrchestrationImplementationRun;

  const claim = recoverableFailedAppReviewPhase({ run: failed, implementationRuns: [parent] });
  expect(claim).toEqual({
    phase: "fixing",
    threadId: ThreadId.make("thread-fixer"),
    mode: "claim",
  });
  const reopened = reopenFailedAppReviewPhase({
    run: failed,
    phase: "fixing",
    workspaceRevision: failed.workspaceRevision,
    occurredAt: "2026-01-01T00:00:01.000Z",
  });
  expect(reopened?.status).toBe("running");
  expect(reopened?.activeThreadId).toBe(ThreadId.make("thread-fixer"));
  expect(reopened?.cycles[0]?.fixerThreadId).toBe(ThreadId.make("thread-fixer"));
  expect(reopened?.cycles[0]?.recoveryContinuationCount).toBe(1);
  expect(
    recoverableFailedAppReviewPhase({ run: reopened!, implementationRuns: [parent] }),
  ).toBeNull();
});

it("finishes or observes a continuation claim interrupted between its run and turn writes", () => {
  const failed = failedImplementationReview("TICKET-1");
  const parent = {
    id: "implementation-run-1",
    status: "needs-human-attention",
    automationHalt: {
      ticketId: "TICKET-1",
      stage: "app-review",
      category: "review-blocked",
      detail: failed.failure?.detailMarkdown ?? "Review failed.",
      haltedAt: now,
    },
    appReviewWorkflowRunIds: [],
    ticketStates: [
      {
        ticketId: "TICKET-1",
        status: "app-reviewing",
        appReviewWorkflowRunId: failed.id,
      },
    ],
  } as unknown as OrchestrationImplementationRun;
  const claimedCycle = {
    ...failed.cycles[0]!,
    recoveryContinuationCount: 1,
  };
  const interruptedClaim = run({
    ...failed,
    cycles: [claimedCycle],
  });

  expect(
    recoverableFailedAppReviewPhase({ run: interruptedClaim, implementationRuns: [parent] }),
  ).toEqual({
    phase: "fixing",
    threadId: ThreadId.make("thread-fixer"),
    mode: "resume-claim",
  });

  const observingParent = {
    ...parent,
    status: "running",
    automationHalt: null,
  } as unknown as OrchestrationImplementationRun;
  const launchedClaim = run({
    ...interruptedClaim,
    cycles: [{ ...claimedCycle, fixingLaunchCount: 3 }],
  });
  expect(
    recoverableFailedAppReviewPhase({
      run: launchedClaim,
      implementationRuns: [observingParent],
    }),
  ).toEqual({
    phase: "fixing",
    threadId: ThreadId.make("thread-fixer"),
    mode: "observe-claim",
  });
});

it("waits for a claimed continuation to replace the phase thread's old turn", () => {
  const failed = failedImplementationReview("TICKET-1");
  const active = run({
    ...failed,
    status: "running",
    outcome: null,
    activePhase: "fixing",
    activeThreadId: ThreadId.make("thread-fixer"),
    cycles: [{ ...failed.cycles[0]!, status: "fixing", recoveryContinuationCount: 1 }],
    failure: null,
    updatedAt: "2026-01-01T00:00:02.000Z",
    completedAt: null,
  });
  const cycle = active.cycles[0]!;

  expect(
    appReviewRecoveryTurnPending(active, cycle, {
      latestTurn: { requestedAt: "2026-01-01T00:00:01.000Z", state: "error" },
      session: { status: "stopped" },
    }),
  ).toBe(true);
  expect(
    appReviewRecoveryTurnPending(active, cycle, {
      latestTurn: { requestedAt: "2026-01-01T00:00:01.000Z", state: "running" },
      session: { status: "running" },
    }),
  ).toBe(false);
  expect(
    appReviewRecoveryTurnPending(active, cycle, {
      latestTurn: { requestedAt: "2026-01-01T00:00:02.000Z", state: "running" },
      session: { status: "stopped" },
    }),
  ).toBe(true);
  expect(
    appReviewRecoveryTurnPending(active, cycle, {
      latestTurn: { requestedAt: "2026-01-01T00:00:02.000Z", state: "running" },
      session: { status: "starting" },
    }),
  ).toBe(false);
});

it("replays only recovery evidence created after the terminal failure", () => {
  const failed = failedImplementationReview("TICKET-1");
  const cycle = failed.cycles[0]!;

  expect(appReviewRecoveryEvidenceIsNewer(failed, cycle, now)).toBe(false);
  expect(appReviewRecoveryEvidenceIsNewer(failed, cycle, "2026-01-01T00:00:01.000Z")).toBe(true);
});

it("does not recover an old failed review that the halted parent no longer owns", () => {
  const failed = failedImplementationReview();
  const parent = {
    id: "implementation-run-1",
    status: "needs-human-attention",
    automationHalt: {
      stage: "app-review",
      category: "review-blocked",
      detail: failed.failure?.detailMarkdown ?? "Review failed.",
      haltedAt: now,
    },
    appReviewWorkflowRunIds: ["app-review-workflow-newer"],
    ticketStates: [],
  } as unknown as OrchestrationImplementationRun;

  expect(recoverableFailedAppReviewPhase({ run: failed, implementationRuns: [parent] })).toBeNull();
});

it("counts legacy planner and fixer threads as their first phase launches", () => {
  const cycle = {
    ...reviewingRun().cycles[0]!,
    plannerThreadId: ThreadId.make("thread-planner"),
    fixerThreadId: ThreadId.make("thread-fixer"),
  };

  expect(appReviewPhaseLaunchCount(cycle, "planning")).toBe(1);
  expect(appReviewPhaseLaunchCount(cycle, "fixing")).toBe(1);
});

it("exhausts a run left between cycles with nothing to spend", () => {
  // The close after the final cycle can be lost to a restart. Reading the
  // action off the run is what finishes it on the next sweep.
  expect(nextAppReviewWorkflowAction(run({ cyclesUsed: 10 }))).toBe("exhaust");
  expect(nextAppReviewWorkflowAction(run({ cyclesUsed: 9 }))).toBe("review");
});

it("selects only the latest idle run for a new review cycle", () => {
  const staleEventRun = run({ updatedAt: "2026-01-01T00:00:01.000Z" });
  const reviewing = run({
    activePhase: "review",
    activeThreadId: ThreadId.make("thread-reviewer"),
    cyclesUsed: 1,
    updatedAt: "2026-01-01T00:00:02.000Z",
  });

  expect(selectReviewRunToStart(staleEventRun.id, [reviewing])).toBeNull();
  expect(selectReviewRunToStart(staleEventRun.id, [staleEventRun])).toBe(staleEventRun);
});

it("resolves standalone previews from the matching running App Dev Stack", () => {
  expect(
    selectStandalonePreviewTargets({
      lookup: {
        stack: {
          id: "stack-1",
          displayName: "feature checkout",
          status: "running",
          services: [{ name: "frontend", status: "running", health: "healthy" }],
        },
        frontendUrl: "https://feature.example.test",
      },
      lookupError: null,
      fallbackTargets: ["http://localhost:3000"],
    }),
  ).toEqual({ _tag: "Resolved", previewTargets: ["https://feature.example.test"] });
});

it("keeps manual preview targets as a fallback when no App Dev Stack matches", () => {
  expect(
    selectStandalonePreviewTargets({
      lookup: { stack: null, frontendUrl: null },
      lookupError: null,
      fallbackTargets: [" http://localhost:3000 ", "http://localhost:3000"],
    }),
  ).toEqual({ _tag: "Resolved", previewTargets: ["http://localhost:3000"] });
});

it("reviews a pinned target instead of the worktree's App Dev Stack", () => {
  expect(
    selectStandalonePreviewTargets({
      lookup: {
        stack: {
          id: "stack-1",
          displayName: "feature checkout",
          status: "running",
          services: [{ name: "frontend", status: "running", health: "healthy" }],
        },
        frontendUrl: "https://feature.example.test",
      },
      lookupError: null,
      fallbackTargets: ["http://localhost:3000"],
      pinnedTargets: [" https://staging.example.test ", "https://staging.example.test"],
    }),
  ).toEqual({ _tag: "Resolved", previewTargets: ["https://staging.example.test"] });
});

it("keeps a pinned target usable while the worktree's App Dev Stack is unhealthy", () => {
  expect(
    selectStandalonePreviewTargets({
      lookup: {
        stack: { id: "stack-1", displayName: null, status: "starting", services: null },
        frontendUrl: null,
      },
      lookupError: null,
      fallbackTargets: [],
      pinnedTargets: ["https://staging.example.test"],
    }),
  ).toEqual({ _tag: "Resolved", previewTargets: ["https://staging.example.test"] });
});

it("blocks before launching a reviewer when the matching App Dev Stack is not ready", () => {
  const resolution = selectStandalonePreviewTargets({
    lookup: {
      stack: {
        id: "stack-1",
        displayName: "feature checkout",
        status: "starting",
        services: null,
      },
      frontendUrl: "https://feature.example.test",
    },
    lookupError: null,
    fallbackTargets: ["http://localhost:3000"],
  });
  expect(resolution._tag).toBe("Blocked");
  if (resolution._tag === "Blocked") {
    expect(resolution.detailMarkdown).toContain("'starting', not 'running'");
  }
});

it("blocks with an actionable message when neither App Dev Stack nor fallback exists", () => {
  const resolution = selectStandalonePreviewTargets({
    lookup: { stack: null, frontendUrl: null },
    lookupError: null,
    fallbackTargets: [],
  });
  expect(resolution._tag).toBe("Blocked");
  if (resolution._tag === "Blocked") {
    expect(resolution.detailMarkdown).toContain("Start the App Dev Stack");
  }
});

it("waits for Implementation to refresh AppDevStack after an embedded repair", () => {
  const embedded = run({
    caller: {
      type: "implementation",
      implementationRunId: "implementation-run-1",
      orchestratorThreadId: ThreadId.make("thread-target"),
    },
    cyclesUsed: 1,
    cycles: [
      {
        cycleNumber: 1,
        status: "completed",
        reviewId: AppReviewId.make("app-review-1"),
        reviewerThreadId: ThreadId.make("thread-reviewer"),
        reviewVerdict: "failed",
        actionableFindingsMarkdown: "Fix checkout.",
        planId: "plan-1",
        plannerTurnId: null,
        fixerThreadId: ThreadId.make("thread-fixer"),
        fixResult: {
          runId: AppReviewWorkflowRunId.make("app-review-workflow-thread-controller"),
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

  expect(nextAppReviewWorkflowAction(embedded)).toBe("none");
});

it("passes on cycle one and plans a repair after an ordinary failed review", () => {
  expect(terminalReviewAction(review("passed"))).toBe("passed");
  expect(terminalReviewAction(review("failed"))).toBe("planning");
});

it("rejects passed reviews that defer or omit required checks", () => {
  const passed = review("passed");
  expect(terminalReviewPassFailure({ run: run(), review: passed, priorReviews: [] })).toContain(
    "without a check matrix",
  );

  const deferred = {
    ...passed,
    document: {
      ...passed.document,
      checks: [
        {
          id: "delete-confirmation",
          label: "Delete confirmation",
          status: "not-applicable" as const,
          notes: "Deferred to another cycle.",
        },
      ],
    },
  } satisfies AppReviewRecord;
  expect(terminalReviewPassFailure({ run: run(), review: deferred, priorReviews: [] })).toContain(
    "delete-confirmation=not-applicable",
  );
});

it("requires repair cycles to verify every prior actionable finding by id", () => {
  const failed = review("failed");
  const passed = {
    ...review("passed"),
    id: AppReviewId.make("app-review-2"),
    reviewThreadId: ThreadId.make("thread-reviewer-2"),
  } satisfies AppReviewRecord;
  const secondCycleRun = run({
    cyclesUsed: 2,
    cycles: [
      {
        cycleNumber: 1,
        status: "completed",
        reviewId: failed.id,
        reviewerThreadId: failed.reviewThreadId,
        reviewVerdict: "failed",
        actionableFindingsMarkdown: "Submit does not recover.",
        planId: "plan-1",
        plannerTurnId: null,
        fixerThreadId: ThreadId.make("thread-fixer"),
        fixResult: null,
        workspaceRevision: run().workspaceRevision,
        startedAt: now,
        completedAt: now,
      },
      {
        cycleNumber: 2,
        status: "reviewing",
        reviewId: passed.id,
        reviewerThreadId: passed.reviewThreadId,
        reviewVerdict: null,
        actionableFindingsMarkdown: null,
        planId: null,
        plannerTurnId: null,
        fixerThreadId: null,
        fixResult: null,
        workspaceRevision: run().workspaceRevision,
        startedAt: now,
        completedAt: null,
      },
    ],
  });
  const unrelatedPass = {
    ...passed,
    document: {
      ...passed.document,
      checks: [
        {
          id: "happy-path",
          label: "Happy path",
          status: "passed" as const,
          notes: "Passed.",
        },
      ],
    },
  } satisfies AppReviewRecord;
  expect(
    terminalReviewPassFailure({
      run: secondCycleRun,
      review: unrelatedPass,
      priorReviews: [failed],
    }),
  ).toContain("finding-1");

  const verifiedPass = {
    ...unrelatedPass,
    document: {
      ...unrelatedPass.document,
      checks: [
        ...unrelatedPass.document.checks,
        {
          id: "finding-1",
          label: "Submit recovery regression",
          status: "passed" as const,
          notes: "The button recovers after rejection.",
        },
      ],
    },
  } satisfies AppReviewRecord;
  expect(
    terminalReviewPassFailure({
      run: secondCycleRun,
      review: verifiedPass,
      priorReviews: [failed],
    }),
  ).toBeNull();
});

function carryCycle(cycleNumber: number, reviewId: AppReviewId): AppReviewWorkflowCycle {
  return {
    cycleNumber,
    status: "completed",
    reviewId,
    reviewerThreadId: ThreadId.make(`thread-reviewer-${cycleNumber}`),
    reviewVerdict: "failed",
    actionableFindingsMarkdown: null,
    planId: null,
    plannerTurnId: null,
    fixerThreadId: null,
    fixResult: null,
    workspaceRevision: run().workspaceRevision,
    startedAt: now,
    completedAt: now,
  };
}

function carryReview(input: {
  readonly id: string;
  readonly verdict: "passed" | "failed";
  readonly checks: ReadonlyArray<AppReviewCheck>;
  readonly findingIds?: ReadonlyArray<string>;
}): AppReviewRecord {
  const base = review(input.verdict, false);
  return {
    ...base,
    id: AppReviewId.make(input.id),
    document: {
      ...base.document,
      checks: input.checks,
      findings: (input.findingIds ?? []).map((findingId) => ({
        id: findingId,
        severity: "major" as const,
        title: "Submit does not recover",
        details: "The button remains disabled.",
        reproduction: "Submit invalid credentials.",
        evidenceIds: [],
      })),
    },
  };
}

const cycleOneReview = carryReview({
  id: "app-review-1",
  verdict: "failed",
  checks: [
    { id: "login", label: "Login", status: "passed", notes: "Signed in." },
    { id: "checkout", label: "Checkout", status: "failed", notes: "Submit stays disabled." },
  ],
  findingIds: ["finding-1"],
});

const secondCycleRun = run({
  cyclesUsed: 2,
  cycles: [carryCycle(1, cycleOneReview.id), carryCycle(2, AppReviewId.make("app-review-2"))],
});

function passedCycleTwo(checks: ReadonlyArray<AppReviewCheck>): AppReviewRecord {
  return carryReview({ id: "app-review-2", verdict: "passed", checks });
}

it("offers only what an earlier cycle passed and the repair has not touched", () => {
  const prior = priorCycleChecks({
    run: secondCycleRun,
    currentCycleNumber: 2,
    priorReviews: [cycleOneReview],
  });
  expect(prior.findingIds).toEqual(["finding-1"]);
  expect(prior.carryable).toEqual([{ id: "login", label: "Login", cycleNumber: 1 }]);

  const prompt = buildReviewPrompt({
    run: secondCycleRun,
    cycle: secondCycleRun.cycles[1]!,
    priorFindingIds: prior.findingIds,
    carryableChecks: prior.carryable,
  });
  expect(prompt).toContain("- login (cycle 1): Login");
  expect(prompt).toContain("- finding-1");
  expect(prompt).not.toContain("- checkout (cycle");
});

it("tells a review-only reviewer that its findings are the whole deliverable", () => {
  const reviewOnlyRun = run({
    reviewOnly: true,
    cycleBudget: AppReviewWorkflowCycleBudget.make(1),
  });
  const prompt = buildReviewPrompt({
    run: reviewOnlyRun,
    cycle: carryCycle(1, AppReviewId.make("app-review-1")),
    priorFindingIds: [],
    carryableChecks: [],
  });
  expect(prompt).toContain("This run reviews once and does not repair.");
  expect(prompt).toContain("Nothing you find will be repaired");
  expect(prompt).not.toContain("cycle 1 of 1");
});

it("still counts cycles for a run that repairs what it finds", () => {
  const prompt = buildReviewPrompt({
    run: run(),
    cycle: carryCycle(1, AppReviewId.make("app-review-1")),
    priorFindingIds: [],
    carryableChecks: [],
  });
  expect(prompt).toContain("Run Browser App Review cycle 1 of");
  expect(prompt).not.toContain("Nothing you find will be repaired");
});

it("says nothing about carrying checks forward on the first cycle", () => {
  const prior = priorCycleChecks({ run: run(), currentCycleNumber: 1, priorReviews: [] });
  expect(prior.carryable).toEqual([]);
  const prompt = buildReviewPrompt({
    run: run(),
    cycle: carryCycle(1, AppReviewId.make("app-review-1")),
    priorFindingIds: prior.findingIds,
    carryableChecks: prior.carryable,
  });
  expect(prompt).not.toContain("These checks already passed earlier in this run.");
});

it("derives stable e2e check ids from command order", () => {
  expect(e2eCheckIdsForCommands(["pnpm test:e2e", "pnpm test:e2e:mobile"])).toEqual([
    "e2e-1",
    "e2e-2",
  ]);
});

it("turns review parts off as a prohibition, degrading only for missing commands", () => {
  const on = { e2e: true, browser: true };
  // Settings turn a part off: it stays off whatever the ticket asked for.
  expect(
    resolveEffectiveAppReviewScope({
      run: {},
      settingsParts: { e2e: true, browser: false },
      e2eCommandCount: 1,
    }),
  ).toBe("e2e");
  expect(
    resolveEffectiveAppReviewScope({
      run: {},
      settingsParts: { e2e: false, browser: true },
      e2eCommandCount: 1,
    }),
  ).toBe("browser");
  expect(
    resolveEffectiveAppReviewScope({
      run: { appReviewScope: "e2e" },
      settingsParts: { e2e: false, browser: true },
      e2eCommandCount: 1,
    }),
  ).toBeNull();
  expect(
    resolveEffectiveAppReviewScope({
      run: {},
      settingsParts: { e2e: false, browser: false },
      e2eCommandCount: 1,
    }),
  ).toBeNull();
  // A missing suite degrades an e2e request to browser when Settings allow it.
  expect(
    resolveEffectiveAppReviewScope({
      run: { appReviewScope: "e2e" },
      settingsParts: on,
      e2eCommandCount: 0,
    }),
  ).toBe("browser");
  expect(
    resolveEffectiveAppReviewScope({
      run: { appReviewScope: "e2e" },
      settingsParts: { e2e: true, browser: false },
      e2eCommandCount: 0,
    }),
  ).toBeNull();
});

it("degrades every scope to browser when the project declares no e2e commands", () => {
  expect(effectiveAppReviewScope({ appReviewScope: "e2e" }, 0)).toBe("browser");
  expect(effectiveAppReviewScope({ appReviewScope: "both" }, 0)).toBe("browser");
  expect(effectiveAppReviewScope({}, 0)).toBe("browser");
  expect(effectiveAppReviewScope({ appReviewScope: "e2e" }, 1)).toBe("e2e");
  expect(effectiveAppReviewScope({ appReviewScope: "browser" }, 1)).toBe("browser");
  expect(effectiveAppReviewScope({}, 1)).toBe("both");
});

it("tells an e2e-only reviewer to skip the browser and its evidence", () => {
  const prompt = buildReviewPrompt({
    run: run(),
    cycle: carryCycle(1, AppReviewId.make("app-review-1")),
    priorFindingIds: [],
    carryableChecks: [],
    e2eCommands: ["pnpm e2e:review"],
    reviewScope: "e2e",
  });
  // Assert on the launch section only; the embedded skill text legitimately
  // describes the browser part for reviews that have one.
  const launchSection = prompt.split("<workflow-skill")[0]!;
  expect(launchSection).toContain("- e2e-1: pnpm e2e:review");
  expect(launchSection).toContain("This review is end-to-end only");
  expect(launchSection).not.toContain("Part two is the browser review");
  expect(launchSection).not.toContain("Record the complete flow, capture captioned screenshots");
});

it("omits the e2e part for a browser-only review even when commands are declared", () => {
  const prompt = buildReviewPrompt({
    run: run(),
    cycle: carryCycle(1, AppReviewId.make("app-review-1")),
    priorFindingIds: [],
    carryableChecks: [],
    e2eCommands: ["pnpm e2e:review"],
    reviewScope: "browser",
  });
  const launchSection = prompt.split("<workflow-skill")[0]!;
  expect(launchSection).not.toContain("e2e-1");
  expect(launchSection).toContain("Record the complete flow, capture captioned screenshots");
});

it("puts the project's e2e commands before browser work with their check ids", () => {
  const prompt = buildReviewPrompt({
    run: run(),
    cycle: carryCycle(1, AppReviewId.make("app-review-1")),
    priorFindingIds: [],
    carryableChecks: [],
    e2eCommands: ["pnpm test:e2e", "pnpm test:e2e:mobile"],
  });
  expect(prompt).toContain("- e2e-1: pnpm test:e2e");
  expect(prompt).toContain("- e2e-2: pnpm test:e2e:mobile");
  expect(prompt).toContain("APP_REVIEW_PREVIEW_URL");
  expect(prompt.indexOf("Part one of this review is the end-to-end test run")).toBeLessThan(
    prompt.indexOf("Use the linked durable App Review record"),
  );
  expect(prompt).toContain("Only failures inside the original acceptance brief");
  expect(prompt).toContain("do not turn them into repair work for this run");
});

it("says nothing about e2e commands when the project declares none", () => {
  const prompt = buildReviewPrompt({
    run: run(),
    cycle: carryCycle(1, AppReviewId.make("app-review-1")),
    priorFindingIds: [],
    carryableChecks: [],
  });
  expect(prompt).not.toContain("e2e-1");
});

it("never offers an e2e check back as carryable", () => {
  const prompt = buildReviewPrompt({
    run: secondCycleRun,
    cycle: secondCycleRun.cycles[1]!,
    priorFindingIds: [],
    carryableChecks: [
      { id: "e2e-1", label: "pnpm test:e2e", cycleNumber: 1 },
      { id: "login", label: "Login", cycleNumber: 1 },
    ],
    e2eCommands: ["pnpm test:e2e"],
  });
  expect(prompt).toContain("- login (cycle 1): Login");
  expect(prompt).not.toContain("- e2e-1 (cycle 1)");
});

it("rejects a pass that skipped a required e2e check", () => {
  const passed = passedCycleTwo([
    { id: "finding-1", label: "Submit recovery", status: "passed", notes: "Recovers now." },
    { id: "login", label: "Login", status: "passed", notes: "Passed." },
  ]);
  expect(
    terminalReviewPassFailure({
      run: secondCycleRun,
      review: passed,
      priorReviews: [cycleOneReview],
      e2eCheckIds: ["e2e-1"],
    }),
  ).toContain("without the required end-to-end checks: e2e-1");
});

it("rejects a pass that carried an e2e check instead of rerunning it", () => {
  const passed = passedCycleTwo([
    { id: "finding-1", label: "Submit recovery", status: "passed", notes: "Recovers now." },
    {
      id: "e2e-1",
      label: "pnpm test:e2e",
      status: "passed",
      notes: "Passed in cycle 1.",
      carriedFromCycle: 1,
    },
  ]);
  expect(
    terminalReviewPassFailure({
      run: secondCycleRun,
      review: passed,
      priorReviews: [cycleOneReview],
      e2eCheckIds: ["e2e-1"],
    }),
  ).toContain("carried end-to-end checks forward");
});

it("accepts a pass whose e2e checks ran fresh this cycle", () => {
  const passed = passedCycleTwo([
    { id: "finding-1", label: "Submit recovery", status: "passed", notes: "Recovers now." },
    { id: "e2e-1", label: "pnpm test:e2e", status: "passed", notes: "42 tests passed." },
  ]);
  expect(
    terminalReviewPassFailure({
      run: secondCycleRun,
      review: passed,
      priorReviews: [cycleOneReview],
      e2eCheckIds: ["e2e-1"],
    }),
  ).toBeNull();
});

it("accepts a pass whose untouched checks are carried from the cycle that ran them", () => {
  const passed = passedCycleTwo([
    { id: "finding-1", label: "Submit recovery", status: "passed", notes: "Recovers now." },
    {
      id: "login",
      label: "Login",
      status: "passed",
      notes: "Passed in cycle 1.",
      carriedFromCycle: 1,
    },
    { id: "checkout", label: "Checkout", status: "passed", notes: "Submit completes." },
  ]);
  expect(
    terminalReviewPassFailure({
      run: secondCycleRun,
      review: passed,
      priorReviews: [cycleOneReview],
    }),
  ).toBeNull();
});

it("rejects a carried check the named cycle never passed", () => {
  const passed = passedCycleTwo([
    { id: "finding-1", label: "Submit recovery", status: "passed", notes: "Recovers now." },
    {
      id: "checkout",
      label: "Checkout",
      status: "passed",
      notes: "Claimed without running it.",
      carriedFromCycle: 1,
    },
  ]);
  expect(
    terminalReviewPassFailure({
      run: secondCycleRun,
      review: passed,
      priorReviews: [cycleOneReview],
    }),
  ).toContain("checkout@1");
});

it("rejects a prior finding carried forward instead of verified again", () => {
  const passed = passedCycleTwo([
    {
      id: "finding-1",
      label: "Submit recovery",
      status: "passed",
      notes: "Assumed fixed.",
      carriedFromCycle: 1,
    },
    { id: "login", label: "Login", status: "passed", notes: "Passed.", carriedFromCycle: 1 },
  ]);
  expect(
    terminalReviewPassFailure({
      run: secondCycleRun,
      review: passed,
      priorReviews: [cycleOneReview],
    }),
  ).toContain("carried prior findings forward");
});

it("credits a twice-carried check to the cycle that actually ran it", () => {
  const cycleTwoReview = carryReview({
    id: "app-review-2",
    verdict: "failed",
    checks: [
      { id: "login", label: "Login", status: "passed", notes: "Carried.", carriedFromCycle: 1 },
      { id: "checkout", label: "Checkout", status: "failed", notes: "Still broken." },
    ],
    findingIds: ["finding-1"],
  });
  const thirdCycleRun = run({
    cyclesUsed: 3,
    cycles: [
      carryCycle(1, cycleOneReview.id),
      carryCycle(2, cycleTwoReview.id),
      carryCycle(3, AppReviewId.make("app-review-3")),
    ],
  });
  const prior = priorCycleChecks({
    run: thirdCycleRun,
    currentCycleNumber: 3,
    priorReviews: [cycleOneReview, cycleTwoReview],
  });
  expect(prior.carryable).toEqual([{ id: "login", label: "Login", cycleNumber: 1 }]);

  const passed = carryReview({
    id: "app-review-3",
    verdict: "passed",
    checks: [
      { id: "finding-1", label: "Submit recovery", status: "passed", notes: "Recovers now." },
      { id: "login", label: "Login", status: "passed", notes: "Carried.", carriedFromCycle: 1 },
      { id: "checkout", label: "Checkout", status: "passed", notes: "Submit completes." },
    ],
  });
  expect(
    terminalReviewPassFailure({
      run: thirdCycleRun,
      review: passed,
      priorReviews: [cycleOneReview, cycleTwoReview],
    }),
  ).toBeNull();
});

it("stops offering a check a later cycle found broken", () => {
  const cycleTwoReview = carryReview({
    id: "app-review-2",
    verdict: "failed",
    checks: [{ id: "login", label: "Login", status: "failed", notes: "Regressed." }],
    findingIds: ["finding-2"],
  });
  const thirdCycleRun = run({
    cyclesUsed: 3,
    cycles: [
      carryCycle(1, cycleOneReview.id),
      carryCycle(2, cycleTwoReview.id),
      carryCycle(3, AppReviewId.make("app-review-3")),
    ],
  });
  expect(
    priorCycleChecks({
      run: thirdCycleRun,
      currentCycleNumber: 3,
      priorReviews: [cycleOneReview, cycleTwoReview],
    }).carryable,
  ).toEqual([]);
});

it("plans a repair after the final failed review so the last budget unit is a full cycle", () => {
  expect(terminalReviewAction(review("failed"))).toBe("planning");
});

it("exhausts only after the final cycle implements its repair plan", () => {
  expect(
    successfulFixAction(
      run({ cyclesUsed: 10, cycleBudget: AppReviewWorkflowCycleBudget.make(10) }),
    ),
  ).toBe("exhausted");
  expect(successfulFixAction(run({ cyclesUsed: 9 }))).toBe("review");
  expect(
    successfulFixAction(
      run({
        cyclesUsed: 9,
        caller: {
          type: "implementation",
          implementationRunId: "implementation-1",
          orchestratorThreadId: ThreadId.make("thread-controller"),
        },
      }),
    ),
  ).toBe("await-preview-refresh");
});

it("routes every non-passing review through gap analysis", () => {
  expect(terminalReviewAction(review("failed"))).toBe("planning");
  expect(terminalReviewAction(review("failed", false))).toBe("planning");
});

it("treats a review without browser evidence as a failed gap to plan", () => {
  const failed = {
    ...review("failed"),
    evidence: {
      recording: {
        status: "not-started" as const,
        path: null,
        mimeType: null,
        sizeBytes: null,
        startedAt: null,
        completedAt: null,
        error: null,
      },
      screenshots: [],
    },
  } satisfies AppReviewRecord;

  const action = terminalReviewAction(failed);

  expect(action).toBe("planning");
  expect(terminalReviewEvidenceFailure(action, failed)).toContain("without a saved recording");
});

it("still requires complete recording evidence for passed reviews", () => {
  const original = review("passed");
  const terminal = {
    ...original,
    evidence: { ...original.evidence, screenshots: [] },
  } satisfies AppReviewRecord;
  const action = terminalReviewAction(terminal);

  expect(terminalReviewEvidenceFailure(action, terminal)).toContain(
    "required durable recording and screenshot evidence",
  );
});

it("accepts screenshot-backed failed findings when recording finalization fails", () => {
  const original = review("failed");
  const terminal = {
    ...original,
    document: {
      ...original.document,
      checks: [
        {
          id: "checkout-submit",
          label: "Submit checkout",
          status: "failed" as const,
          notes: "The submit button remains disabled.",
        },
      ],
      findings: original.document.findings.map((finding) => ({
        ...finding,
        evidenceIds: ["shot-1"],
      })),
    },
    evidence: {
      recording: {
        ...original.evidence.recording,
        status: "failed" as const,
        path: null,
        mimeType: null,
        sizeBytes: null,
        error: "ffmpeg did not finalize in time",
      },
      screenshots: [
        {
          id: "shot-1",
          path: "/tmp/shot-1.png",
          mimeType: "image/png" as const,
          caption: "Checkout submit remains disabled",
          capturedAt: now,
        },
      ],
    },
  } satisfies AppReviewRecord;
  const action = terminalReviewAction(terminal);

  expect(action).toBe("planning");
  expect(terminalReviewEvidenceFailure(action, terminal)).toBeNull();
});

/** A thread as `findAppReviewParentTicket` reads it. */
function ticketThread(
  id: string,
  ticketIds: readonly string[],
): Parameters<typeof findAppReviewParentTicket>[0][number] {
  return {
    id,
    planningWorkflow:
      ticketIds.length === 0
        ? null
        : {
            tickets: ticketIds.map((ticketId, index) => ({
              id: ticketId,
              key: `TICKET-${String(index + 1)}`,
            })),
          },
  };
}

it("finds the reviewed ticket on the planning thread that owns it", () => {
  const threads = [
    ticketThread("thread-planning-root", ["planning-ticket-a", "planning-ticket-b"]),
    ticketThread("thread-implementation-worker", []),
    ticketThread("thread-app-review-reviewer", []),
  ];

  expect(findAppReviewParentTicket(threads, "planning-ticket-b", "thread-planning-root")?.key).toBe(
    "TICKET-2",
  );
});

it("still finds the reviewed ticket when the workflow root does not own it", () => {
  const threads = [
    ticketThread("thread-workflow-root", []),
    ticketThread("thread-planning", ["planning-ticket-a"]),
  ];

  expect(findAppReviewParentTicket(threads, "planning-ticket-a", "thread-workflow-root")?.key).toBe(
    "TICKET-1",
  );
  expect(findAppReviewParentTicket(threads, "planning-ticket-missing", undefined)).toBeUndefined();
});

const blockedAt = "2026-01-01T00:00:00.000Z";
const nudgeNowMs = Date.parse(blockedAt) + 60_000;

function phaseThread(overrides: Partial<WorkflowNudgeThread> = {}): WorkflowNudgeThread {
  return {
    id: "thread-reviewer",
    parentThreadId: "thread-controller",
    workflowPausedAt: null,
    workflowRole: "app-review-reviewer",
    deletedAt: null,
    session: {
      status: "stopped",
      activeTurnId: null,
      lastError: "Claude AI usage limit reached",
      updatedAt: blockedAt,
    },
    latestTurn: { state: "error" },
    ...overrides,
  };
}

const phaseState = (thread: WorkflowNudgeThread) =>
  appReviewPhaseThreadState({ threads: [thread], thread, nowMs: nudgeNowMs });

it("waits out a provider failure on the phase thread instead of failing the run", () => {
  // One API error or usage limit used to cost the whole run, and with it a
  // repair cycle the user paid for.
  expect(phaseState(phaseThread())).toBe("nudging");
});

it("keeps the current phase while stale-turn recovery starts its replacement turn", () => {
  const interruptedTurnId = "turn-interrupted";
  const fixer = phaseThread({
    workflowRole: "app-review-fixer",
    session: {
      status: "error",
      activeTurnId: null,
      lastError: WORKFLOW_INTERRUPTION_ERROR_MESSAGE,
      updatedAt: blockedAt,
    },
    latestTurn: { turnId: interruptedTurnId, state: "interrupted" },
    activities: [
      {
        kind: STALE_TURN_RESUME_ACTIVITY_KIND,
        payload: { interruptedTurnId },
        createdAt: blockedAt,
      },
    ],
  });

  expect(phaseState(fixer)).toBe("nudging");
});

it("keeps the current phase before stale-turn recovery records its claim", () => {
  const fixer = phaseThread({
    workflowRole: "app-review-fixer",
    session: {
      status: "error",
      activeTurnId: null,
      lastError: ORPHANED_PROVIDER_SESSION_ERROR,
      updatedAt: blockedAt,
    },
    latestTurn: { turnId: "turn-orphaned", state: "running" },
    activities: [],
  });

  expect(phaseState(fixer)).toBe("nudging");
});

it("fails the run once nudging gives up or nobody is nudging", () => {
  const exhausted = phaseThread({
    session: {
      status: "error",
      activeTurnId: null,
      lastError: WORKFLOW_NUDGE_EXHAUSTED_MESSAGE,
      updatedAt: blockedAt,
    },
  });
  // A human pressing Stop is not a provider failure, and is never nudged.
  const interrupted = phaseThread({ latestTurn: { state: "interrupted" } });

  expect(phaseState(exhausted)).toBe("failed");
  expect(phaseState(interrupted)).toBe("failed");
});

it("does not apply an old stale-turn recovery marker to a later human stop", () => {
  const interrupted = phaseThread({
    session: {
      status: "error",
      activeTurnId: null,
      lastError: WORKFLOW_INTERRUPTION_ERROR_MESSAGE,
      updatedAt: blockedAt,
    },
    latestTurn: { turnId: "turn-human-stopped", state: "interrupted" },
    activities: [
      {
        kind: STALE_TURN_RESUME_ACTIVITY_KIND,
        payload: { interruptedTurnId: "turn-recovered-earlier" },
        createdAt: blockedAt,
      },
    ],
  });

  expect(phaseState(interrupted)).toBe("failed");
});

it("leaves a queued phase thread alone when its checkpoint failed first", () => {
  // A checkpoint captured while the provider was still starting rewrites the
  // latest turn to "error". The session is the one that knows better.
  expect(
    threadTurnFailed({ latestTurn: { state: "error" }, session: { status: "starting" } }),
  ).toBe(false);
  expect(threadTurnFailed({ latestTurn: { state: "error" }, session: { status: "running" } })).toBe(
    false,
  );
  expect(threadTurnFailed({ latestTurn: { state: "error" }, session: { status: "error" } })).toBe(
    true,
  );
  expect(threadTurnFailed({ latestTurn: { state: "error" }, session: null })).toBe(true);
});

it("leaves a working phase thread alone", () => {
  const working = phaseThread({
    session: { status: "running", activeTurnId: "turn-1", lastError: null, updatedAt: blockedAt },
    latestTurn: { state: "running" },
  });

  expect(phaseState(working)).toBe("working");
});
