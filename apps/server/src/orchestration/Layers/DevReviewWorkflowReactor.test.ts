import { expect, it } from "vite-plus/test";
import {
  DevReviewId,
  DevReviewWorkflowCycleBudget,
  DevReviewWorkflowRunId,
  ThreadId,
  type DevReviewRecord,
  type DevReviewWorkflowRun,
} from "@t3tools/contracts";

import {
  nextDevReviewWorkflowAction,
  selectStandalonePreviewTargets,
  terminalReviewAction,
  terminalReviewEvidenceFailure,
} from "./DevReviewWorkflowReactor.ts";

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

it("preserves a blocked review reason when browser evidence could not be captured", () => {
  const blocked = {
    ...review("blocked"),
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
  } satisfies DevReviewRecord;

  const action = terminalReviewAction(run({ attemptsUsed: 1 }), blocked);

  expect(action).toBe("blocked");
  expect(terminalReviewEvidenceFailure(action, blocked)).toBeNull();
});

it("still requires complete recording evidence for passed reviews", () => {
  const original = review("passed");
  const terminal = {
    ...original,
    evidence: { ...original.evidence, screenshots: [] },
  } satisfies DevReviewRecord;
  const action = terminalReviewAction(run({ attemptsUsed: 1 }), terminal);

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
  } satisfies DevReviewRecord;
  const action = terminalReviewAction(run({ attemptsUsed: 1 }), terminal);

  expect(action).toBe("planning");
  expect(terminalReviewEvidenceFailure(action, terminal)).toBeNull();
});
