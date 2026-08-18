import { expect, it } from "vite-plus/test";
import {
  AppReviewId,
  AppReviewWorkflowCycleBudget,
  AppReviewWorkflowRunId,
  ThreadId,
  type AppReviewRecord,
  type AppReviewWorkflowRun,
} from "@t3tools/contracts";

import {
  findAppReviewParentTicket,
  nextAppReviewWorkflowAction,
  selectReviewRunToStart,
  selectStandalonePreviewTargets,
  successfulFixAction,
  terminalReviewAction,
  terminalReviewEvidenceFailure,
  terminalReviewPassFailure,
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
