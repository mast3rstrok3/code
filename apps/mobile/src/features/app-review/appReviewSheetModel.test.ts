import { describe, expect, it } from "@effect/vitest";
import {
  AppReviewId,
  AppReviewWorkflowRunId,
  EMPTY_APP_REVIEW_EVIDENCE,
  ThreadId,
  type AppReviewRecord,
  type AppReviewWorkflowCycle,
  type AppReviewWorkflowRun,
} from "@t3tools/contracts";

import { buildAppReviewSheetRows } from "./appReviewSheetModel";

const revision = {
  headSha: "abc123",
  workingTreeDiffHash: "working-hash",
  branchDiffHash: "branch-hash",
  fingerprint: "fingerprint",
};

function cycle(cycleNumber: number, overrides: Partial<AppReviewWorkflowCycle> = {}) {
  return {
    cycleNumber,
    status: "planning",
    reviewId: AppReviewId.make(`review-${String(cycleNumber)}`),
    reviewerThreadId: ThreadId.make(`reviewer-${String(cycleNumber)}`),
    reviewVerdict: "failed",
    actionableFindingsMarkdown: "Fix validation.",
    planId: null,
    plannerTurnId: null,
    fixerThreadId: null,
    fixResult: null,
    workspaceRevision: revision,
    startedAt: "2026-08-11T00:00:00.000Z",
    completedAt: null,
    ...overrides,
  } satisfies AppReviewWorkflowCycle;
}

function run(id: string, overrides: Partial<AppReviewWorkflowRun> = {}): AppReviewWorkflowRun {
  return {
    id: AppReviewWorkflowRunId.make(id),
    targetThreadId: ThreadId.make("target"),
    controllerThreadId: ThreadId.make(`controller-${id}`),
    caller: { type: "standalone", sourceThreadId: ThreadId.make("target") },
    briefMarkdown: "Review checkout",
    supportingContextMarkdown: null,
    previewTargets: [],
    cycleBudget: 3,
    cyclesUsed: 2,
    status: "running",
    cycles: [cycle(1, { status: "completed" }), cycle(2)],
    activePhase: "planning",
    activeThreadId: ThreadId.make("reviewer-2"),
    phaseExecution: null,
    workspaceRevision: revision,
    finalHeadSha: null,
    outcome: null,
    failure: null,
    createdAt: "2026-08-11T00:00:00.000Z",
    updatedAt: "2026-08-11T00:01:00.000Z",
    completedAt: null,
    ...overrides,
  };
}

function record(id: string): AppReviewRecord {
  return {
    id: AppReviewId.make(id),
    sourceThreadId: ThreadId.make("target"),
    reviewThreadId: ThreadId.make(`thread-${id}`),
    sourceTurnId: null,
    status: "passed",
    document: {
      verdict: "passed",
      summary: "",
      checks: [],
      findings: [],
      questions: [],
      nextSteps: [],
    },
    evidence: EMPTY_APP_REVIEW_EVIDENCE,
    createdAt: "2026-08-11T00:00:00.000Z",
    updatedAt: "2026-08-11T00:00:00.000Z",
  };
}

function rowsFor(input: {
  readonly runs: readonly AppReviewWorkflowRun[];
  readonly records?: readonly AppReviewRecord[];
  readonly expanded?: Record<string, boolean>;
  readonly sessionStatus?: string;
}) {
  return buildAppReviewSheetRows({
    runs: input.runs,
    allRuns: input.runs,
    headlineRunId: input.runs.find((candidate) => candidate.status === "running")?.id ?? null,
    records: input.records ?? [],
    tickets: [],
    expanded: input.expanded ?? {},
    sessionStatusFor: () => input.sessionStatus,
  });
}

describe("buildAppReviewSheetRows", () => {
  it("opens the headline run and only its newest cycle's steps", () => {
    const rows = rowsFor({
      runs: [run("done", { status: "passed", outcome: "passed" }), run("live")],
    });
    expect(rows.map((row) => row.id)).toEqual([
      "run:done",
      "run:live",
      "run:live:detail",
      "run:live:cycle:1",
      "run:live:cycle:2",
      "run:live:cycle:2:e2e",
      "run:live:cycle:2:review",
      "run:live:cycle:2:planning",
      "run:live:cycle:2:fixing",
    ]);
    expect(rows[0]).toMatchObject({ label: "App Review 1", statusLabel: "passed" });
  });

  it("offers a rerun only on the newest cycle, with the server's refusal reasons", () => {
    const rows = rowsFor({
      runs: [run("live")],
      expanded: { "run:live:cycle:1": true },
      sessionStatus: "running",
    });
    const steps = rows.flatMap((row) => (row.kind === "step" ? [row] : []));
    expect(steps.filter((row) => row.cycle.cycleNumber === 1).every((row) => !row.rerun)).toBe(
      true,
    );
    expect(steps.find((row) => row.id === "run:live:cycle:2:planning")?.rerun).toEqual({
      disabledReason: "This App Review is still running. Stop it before starting a phase again.",
    });
  });

  it("lists reviews no run owns under their own heading", () => {
    const rows = rowsFor({
      runs: [run("live", { status: "passed" })],
      records: [record("review-1"), record("legacy")],
      expanded: { "run:live": false },
    });
    expect(rows.map((row) => row.id)).toEqual(["run:live", "legacy", "record:legacy"]);
  });
});
