import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { DevReviewEvidence, DevReviewRecord, EMPTY_DEV_REVIEW_EVIDENCE } from "./review.ts";

const decodeDevReviewRecord = Schema.decodeUnknownEffect(DevReviewRecord);
const encodeDevReviewRecord = Schema.encodeEffect(DevReviewRecord);
const decodeDevReviewEvidence = Schema.decodeUnknownEffect(DevReviewEvidence);

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

it.effect("round-trips Dev Review records with browser evidence", () =>
  Effect.gen(function* () {
    const record = yield* decodeDevReviewRecord({
      id: " dev-review-1 ",
      sourceThreadId: "thread-source",
      reviewThreadId: "thread-review",
      sourceTurnId: null,
      status: "running",
      document: emptyDocument,
      evidence: savedEvidence,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:01.000Z",
    });
    assert.strictEqual(record.id, "dev-review-1");
    assert.strictEqual(record.evidence.recording.status, "saved");
    assert.strictEqual(record.evidence.recording.sizeBytes, 2048);
    assert.strictEqual(record.evidence.screenshots[0]?.id, "shot-1");
    assert.strictEqual(record.evidence.screenshots[0]?.mimeType, "image/png");

    const encoded = yield* encodeDevReviewRecord(record);
    assert.deepStrictEqual(encoded.evidence, savedEvidence);
  }),
);

it.effect("decodes EMPTY_DEV_REVIEW_EVIDENCE against DevReviewEvidence", () =>
  Effect.gen(function* () {
    const decoded = yield* decodeDevReviewEvidence(EMPTY_DEV_REVIEW_EVIDENCE);
    assert.deepStrictEqual(decoded, EMPTY_DEV_REVIEW_EVIDENCE);
    assert.strictEqual(decoded.recording.status, "not-started");
    assert.deepStrictEqual(decoded.screenshots, []);
  }),
);

it.effect("rejects screenshot evidence whose mimeType is not image/png", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decodeDevReviewEvidence({
        recording: EMPTY_DEV_REVIEW_EVIDENCE.recording,
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

it.effect("rejects malformed Dev Review recording evidence", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decodeDevReviewRecord({
        id: "dev-review-1",
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
