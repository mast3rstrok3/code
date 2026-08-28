import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  APP_REVIEW_WORKFLOW_DEFAULT_CYCLES,
  AppReviewEvidence,
  AppReviewRecord,
  AppReviewWorkflowRun,
  EMPTY_APP_REVIEW_EVIDENCE,
} from "./review.ts";

const decodeAppReviewRecord = Schema.decodeUnknownEffect(AppReviewRecord);
const encodeAppReviewRecord = Schema.encodeEffect(AppReviewRecord);
const decodeAppReviewEvidence = Schema.decodeUnknownEffect(AppReviewEvidence);
const decodeAppReviewWorkflowRun = Schema.decodeUnknownEffect(AppReviewWorkflowRun);

const emptyDocument = {
  verdict: "pending",
  summary: "",
  checks: [],
  findings: [],
  questions: [],
  nextSteps: [],
} as const;

const savedEvidence = {
  recording: {
    status: "saved",
    path: "/tmp/evidence/recording.webm",
    mimeType: "video/webm",
    sizeBytes: 2048,
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:01:00.000Z",
    error: null,
  },
  screenshots: [
    {
      id: "shot-1",
      path: "/tmp/evidence/shot-1.png",
      mimeType: "image/png",
      caption: "Checkout form after submit",
      capturedAt: "2026-01-01T00:00:30.000Z",
    },
  ],
} as const;

it.effect("round-trips App Review records with browser evidence", () =>
  Effect.gen(function* () {
    const record = yield* decodeAppReviewRecord({
      id: " app-review-1 ",
      sourceThreadId: "thread-source",
      reviewThreadId: "thread-review",
      appReviewScope: "e2e",
      sourceTurnId: null,
      status: "running",
      document: emptyDocument,
      evidence: savedEvidence,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:01.000Z",
    });
    assert.strictEqual(record.id, "app-review-1");
    assert.strictEqual(record.appReviewScope, "e2e");
    assert.strictEqual(record.evidence.recording.status, "saved");
    assert.strictEqual(record.evidence.recording.sizeBytes, 2048);
    assert.strictEqual(record.evidence.screenshots[0]?.id, "shot-1");
    assert.strictEqual(record.evidence.screenshots[0]?.mimeType, "image/png");

    const encoded = yield* encodeAppReviewRecord(record);
    assert.strictEqual(encoded.appReviewScope, "e2e");
    assert.deepStrictEqual(encoded.evidence, savedEvidence);
  }),
);

it.effect("keeps a check's origin cycle when it was carried forward, and omits it otherwise", () =>
  Effect.gen(function* () {
    const record = yield* decodeAppReviewRecord({
      id: "app-review-2",
      sourceThreadId: "thread-source",
      reviewThreadId: "thread-review",
      sourceTurnId: null,
      status: "passed",
      document: {
        ...emptyDocument,
        verdict: "passed",
        checks: [
          { id: "login", label: "Login", status: "passed", notes: "", carriedFromCycle: 1 },
          { id: "submit-recovery", label: "Submit recovery", status: "passed", notes: "" },
        ],
      },
      evidence: savedEvidence,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:01.000Z",
    });
    assert.strictEqual(record.document.checks[0]?.carriedFromCycle, 1);
    assert.strictEqual(record.document.checks[1]?.carriedFromCycle, undefined);

    const encoded = yield* encodeAppReviewRecord(record);
    assert.deepStrictEqual(encoded.document.checks[1], {
      id: "submit-recovery",
      label: "Submit recovery",
      status: "passed",
      notes: "",
    });
  }),
);

it.effect("rejects a carried check that names cycle zero", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decodeAppReviewRecord({
        id: "app-review-3",
        sourceThreadId: "thread-source",
        reviewThreadId: "thread-review",
        sourceTurnId: null,
        status: "passed",
        document: {
          ...emptyDocument,
          checks: [
            { id: "login", label: "Login", status: "passed", notes: "", carriedFromCycle: 0 },
          ],
        },
        evidence: savedEvidence,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:01.000Z",
      }),
    );
    assert.strictEqual(result._tag, "Failure");
  }),
);

it.effect("decodes EMPTY_APP_REVIEW_EVIDENCE against AppReviewEvidence", () =>
  Effect.gen(function* () {
    const decoded = yield* decodeAppReviewEvidence(EMPTY_APP_REVIEW_EVIDENCE);
    assert.deepStrictEqual(decoded, EMPTY_APP_REVIEW_EVIDENCE);
    assert.strictEqual(decoded.recording.status, "not-started");
    assert.deepStrictEqual(decoded.screenshots, []);
  }),
);

it.effect("rejects screenshot evidence whose mimeType is not image/png", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decodeAppReviewEvidence({
        recording: EMPTY_APP_REVIEW_EVIDENCE.recording,
        screenshots: [
          {
            id: "shot-1",
            path: "/tmp/evidence/shot-1.jpg",
            mimeType: "image/jpeg",
            caption: "JPEG screenshots are rejected",
            capturedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
    );
    assert.strictEqual(result._tag, "Failure");
  }),
);

it.effect("rejects malformed App Review recording evidence", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decodeAppReviewRecord({
        id: "app-review-1",
        sourceThreadId: "thread-source",
        reviewThreadId: "thread-review",
        sourceTurnId: null,
        status: "running",
        document: emptyDocument,
        evidence: {
          recording: {
            status: "recording",
            path: null,
            mimeType: null,
            sizeBytes: -1,
            startedAt: "2026-01-01T00:00:00.000Z",
            completedAt: null,
            error: null,
          },
          screenshots: [],
        },
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:01.000Z",
      }),
    );
    assert.strictEqual(result._tag, "Failure");
  }),
);

const workflowRun = {
  id: "app-review-workflow-1",
  targetThreadId: "thread-source",
  controllerThreadId: "thread-controller",
  caller: { type: "standalone", sourceThreadId: "thread-source" },
  briefMarkdown: "Review checkout.",
  supportingContextMarkdown: null,
  previewTargets: ["http://localhost:3000"],
  cyclesUsed: 0,
  status: "running",
  cycles: [],
  activePhase: null,
  activeThreadId: null,
  workspaceRevision: {
    headSha: "abc123",
    workingTreeDiffHash: "worktree-hash",
    branchDiffHash: "branch-hash",
    fingerprint: "fingerprint",
  },
  finalHeadSha: null,
  outcome: null,
  failure: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  completedAt: null,
} as const;

it.effect("defaults App Review runs to ten attempts", () =>
  Effect.gen(function* () {
    const run = yield* decodeAppReviewWorkflowRun(workflowRun);
    assert.strictEqual(run.cycleBudget, APP_REVIEW_WORKFLOW_DEFAULT_CYCLES);
  }),
);

it.effect("allows App Review to resolve preview targets after launch", () =>
  Effect.gen(function* () {
    const run = yield* decodeAppReviewWorkflowRun({ ...workflowRun, previewTargets: [] });
    assert.deepStrictEqual(run.previewTargets, []);
  }),
);

const legacyCycle = {
  cycleNumber: 1,
  status: "planning",
  reviewId: "app-review-1",
  reviewerThreadId: "thread-reviewer",
  reviewVerdict: "failed",
  actionableFindingsMarkdown: "1. [major] Checkout fails",
  planId: null,
  plannerTurnId: null,
  fixerThreadId: null,
  fixResult: null,
  workspaceRevision: {
    headSha: "abc123",
    workingTreeDiffHash: "worktree-hash",
    branchDiffHash: "branch-hash",
    fingerprint: "fingerprint",
  },
  startedAt: "2026-01-01T00:00:00.000Z",
  completedAt: null,
} as const;

it.effect("decodes cycles recorded before gap analysis had its own thread", () =>
  Effect.gen(function* () {
    // Those cycles ran gap analysis on the reviewer; the reactor falls back to
    // reviewerThreadId when plannerThreadId is absent, so it must stay optional.
    const run = yield* decodeAppReviewWorkflowRun({ ...workflowRun, cycles: [legacyCycle] });
    assert.strictEqual(run.cycles[0]?.plannerThreadId, undefined);
  }),
);

it.effect("decodes cycles recorded before a cycle could carry its own failure", () =>
  Effect.gen(function* () {
    const run = yield* decodeAppReviewWorkflowRun({ ...workflowRun, cycles: [legacyCycle] });
    assert.strictEqual(run.cycles[0]?.failure, undefined);
  }),
);

it.effect("decodes cycles recorded before recovery continuation counters", () =>
  Effect.gen(function* () {
    const historical = yield* decodeAppReviewWorkflowRun({
      ...workflowRun,
      cycles: [legacyCycle],
    });
    assert.strictEqual(historical.cycles[0]?.recoveryContinuationCount, undefined);
    assert.strictEqual(historical.cycles[0]?.fixResultContinuationCount, undefined);

    const recovered = yield* decodeAppReviewWorkflowRun({
      ...workflowRun,
      cycles: [{ ...legacyCycle, recoveryContinuationCount: 1, fixResultContinuationCount: 1 }],
    });
    assert.strictEqual(recovered.cycles[0]?.recoveryContinuationCount, 1);
    assert.strictEqual(recovered.cycles[0]?.fixResultContinuationCount, 1);
  }),
);

it.effect("keeps why a spent cycle stopped short", () =>
  Effect.gen(function* () {
    const run = yield* decodeAppReviewWorkflowRun({
      ...workflowRun,
      cycles: [
        {
          ...legacyCycle,
          status: "failed",
          failure: {
            reason: "review-blocked",
            phase: "review",
            cycleNumber: 1,
            detailMarkdown: "You've hit your usage limit.",
            failedAt: "2026-01-01T00:00:00.000Z",
          },
        },
      ],
    });
    assert.strictEqual(run.cycles[0]?.status, "failed");
    assert.strictEqual(run.cycles[0]?.failure?.reason, "review-blocked");
  }),
);

it.effect("carries the gap analysis thread on new cycles", () =>
  Effect.gen(function* () {
    const run = yield* decodeAppReviewWorkflowRun({
      ...workflowRun,
      cycles: [{ ...legacyCycle, plannerThreadId: "thread-planner" }],
    });
    assert.strictEqual(run.cycles[0]?.plannerThreadId, "thread-planner");
  }),
);

it.effect("rejects zero and clamps historical App Review budgets to 10", () =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(decodeAppReviewWorkflowRun({ ...workflowRun, cycleBudget: 0 }));
    assert.strictEqual(exit._tag, "Failure");
    for (const cycleBudget of [1, 10]) {
      const run = yield* decodeAppReviewWorkflowRun({ ...workflowRun, cycleBudget });
      assert.strictEqual(run.cycleBudget, cycleBudget);
    }
    const historical = yield* decodeAppReviewWorkflowRun({ ...workflowRun, cycleBudget: 50 });
    assert.strictEqual(historical.cycleBudget, 10);
  }),
);
