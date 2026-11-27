import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  AppReviewEvidence,
  AppReviewCheck,
  AppReviewRecord,
  EMPTY_APP_REVIEW_EVIDENCE,
} from "./review.ts";

const decodeAppReviewRecord = Schema.decodeUnknownEffect(AppReviewRecord);
const encodeAppReviewRecord = Schema.encodeEffect(AppReviewRecord);
const decodeAppReviewEvidence = Schema.decodeUnknownEffect(AppReviewEvidence);

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

it.effect("preserves coverage and external blocker classifications and accepts legacy checks", () =>
  Effect.gen(function* () {
    const decode = Schema.decodeUnknownEffect(AppReviewCheck);
    const encode = Schema.encodeEffect(AppReviewCheck);
    for (const blockerKind of [undefined, "coverage-gap", "external-prerequisite"] as const) {
      const input = {
        id: "acceptance",
        label: "Acceptance",
        status: "blocked",
        notes: "Needs follow-up",
        ...(blockerKind === undefined ? {} : { blockerKind }),
      };
      const check = yield* decode(input);
      assert.deepStrictEqual(yield* encode(check), input);
    }
    const invalid = yield* decode({
      id: "acceptance",
      label: "Acceptance",
      status: "blocked",
      notes: "",
      blockerKind: "unknown",
    }).pipe(Effect.result);
    assert.strictEqual(invalid._tag, "Failure");
  }),
);

it.effect("decodes records written by the workflow engine and keeps E2E test evidence", () =>
  Effect.gen(function* () {
    const tests = [
      {
        command: "pnpm e2e",
        executedCommand: "pnpm e2e",
        status: "passed",
        outputMarkdown: "Exit code: 0",
        recordings: [
          { id: "run-1", label: "checkout", path: "/tmp/run-1.rrweb.jsonl", sizeBytes: 12 },
        ],
        completedAt: "2026-01-01T00:02:00.000Z",
      },
    ] as const;
    const record = yield* decodeAppReviewRecord({
      id: "app-review-1",
      sourceThreadId: "thread-source",
      reviewThreadId: "thread-review",
      planningTicketIds: ["ticket-1"],
      sourceProposedPlan: { threadId: "thread-source", planId: "plan-1" },
      sourceTurnId: null,
      status: "passed",
      document: {
        ...emptyDocument,
        checks: [{ id: "c", label: "Checkout", status: "passed", notes: "", carriedFromCycle: 1 }],
      },
      evidence: { ...savedEvidence, tests },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:01.000Z",
    });
    const encoded = yield* encodeAppReviewRecord(record);
    assert.notProperty(encoded, "planningTicketIds");
    assert.notProperty(encoded.document.checks[0], "carriedFromCycle");
    assert.deepStrictEqual(encoded.evidence.tests, tests);
  }),
);
