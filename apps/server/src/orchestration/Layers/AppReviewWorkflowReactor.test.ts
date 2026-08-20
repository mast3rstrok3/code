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
} from "@t3tools/contracts";

import { WORKFLOW_NUDGE_EXHAUSTED_MESSAGE, type WorkflowNudgeThread } from "../workflowNudge.ts";
import {
  appReviewPhaseThreadState,
  buildReviewPrompt,
  cycleFailureAction,
  e2eCheckIdsForCommands,
  priorCycleChecks,
  findAppReviewParentTicket,
  nextAppReviewWorkflowAction,
  selectReviewRunToStart,
  spendFailedCycle,
  selectStandalonePreviewTargets,
  successfulFixAction,
  terminalReviewAction,
  terminalReviewEvidenceFailure,
  terminalReviewPassFailure,
  threadTurnFailed,
} from "./AppReviewWorkflowReactor.ts";

const now = "2026-01-01T00:00:00.000Z";

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

it("always begins a nonterminal run with Browser App Review", () => {
  expect(nextAppReviewWorkflowAction(run())).toBe("review");
});

it("spends a broken cycle and reviews again instead of ending the run", () => {
  expect(cycleFailureAction(run({ cyclesUsed: 1 }))).toBe("next-cycle");
  expect(cycleFailureAction(run({ cyclesUsed: 9 }))).toBe("next-cycle");
});

it("stops once a broken cycle spends the last of the budget", () => {
  expect(cycleFailureAction(run({ cyclesUsed: 10 }))).toBe("exhausted");
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

const blocked = {
  reason: "review-blocked",
  phase: "review",
  cycleNumber: 1,
  detailMarkdown: "You've hit your usage limit.",
  failedAt: "2026-01-01T00:01:00.000Z",
} as const;

const movedRevision = {
  headSha: "def456",
  workingTreeDiffHash: "working",
  branchDiffHash: "branch",
  fingerprint: "def456:working:branch",
} as const;

it("keeps a broken cycle's reason on the cycle and leaves the run running", () => {
  const spent = spendFailedCycle({
    run: reviewingRun(),
    failure: blocked,
    workspaceRevision: movedRevision,
  });

  expect(spent.status).toBe("running");
  expect(spent.outcome).toBeNull();
  expect(spent.activePhase).toBeNull();
  expect(spent.activeThreadId).toBeNull();
  expect(spent.cycles[0]?.status).toBe("failed");
  expect(spent.cycles[0]?.failure).toEqual(blocked);
  expect(spent.cycles[0]?.completedAt).toBe(blocked.failedAt);
});

it("re-baselines the workspace a repair may have moved before the next cycle", () => {
  const spent = spendFailedCycle({
    run: reviewingRun(),
    failure: blocked,
    workspaceRevision: movedRevision,
  });

  expect(spent.workspaceRevision).toEqual(movedRevision);
  expect(selectReviewRunToStart(spent.id, [spent])).toBe(spent);
});

it("leaves earlier cycles untouched when a later one breaks", () => {
  const twoCycles = {
    ...reviewingRun(2),
    cycles: [...reviewingRun(1).cycles, ...reviewingRun(2).cycles],
  };
  const spent = spendFailedCycle({
    run: twoCycles,
    failure: blocked,
    workspaceRevision: movedRevision,
  });

  expect(spent.cycles[0]?.status).toBe("reviewing");
  expect(spent.cycles[1]?.status).toBe("failed");
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
  expect(prompt.indexOf("Before any browser work")).toBeLessThan(
    prompt.indexOf("Use the linked durable App Review record"),
  );
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
