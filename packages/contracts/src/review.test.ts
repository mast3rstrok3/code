import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  DevReviewReplayAppendEventsInput,
  DevReviewReplayGetResult,
  DevReviewRecord,
} from "./review.ts";

const decodeDevReviewRecord = Schema.decodeUnknownEffect(DevReviewRecord);
const decodeAppendReplayEventsInput = Schema.decodeUnknownEffect(DevReviewReplayAppendEventsInput);
const decodeReplayGetResult = Schema.decodeUnknownEffect(DevReviewReplayGetResult);

const emptyDocument = {
  verdict: "pending",
  summary: "",
  checks: [],
  findings: [],
  questions: [],
  nextSteps: [],
} as const;

it.effect("decodes Dev Review records and replay RPC payloads", () =>
  Effect.gen(function* () {
    const record = yield* decodeDevReviewRecord({
      id: " dev-review-1 ",
      sourceThreadId: "thread-source",
      reviewThreadId: "thread-review",
      sourceTurnId: null,
      status: "running",
      document: emptyDocument,
      replay: {
        status: "recording",
        eventCount: 2,
        startedAt: "2026-01-01T00:00:00.000Z",
        completedAt: null,
        durationMs: null,
        error: null,
      },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:01.000Z",
    });
    assert.strictEqual(record.id, "dev-review-1");
    assert.strictEqual(record.replay.eventCount, 2);

    const appendInput = yield* decodeAppendReplayEventsInput({
      reviewId: "dev-review-1",
      events: [{ type: 2, data: { node: { id: 1 } } }],
    });
    assert.deepStrictEqual(appendInput.events, [{ type: 2, data: { node: { id: 1 } } }]);

    const replay = yield* decodeReplayGetResult({
      reviewId: "dev-review-1",
      events: [{ type: 4 }, { type: 5 }],
    });
    assert.deepStrictEqual(
      replay.events.map((event) => (event as { readonly type: number }).type),
      [4, 5],
    );
  }),
);

it.effect("rejects malformed Dev Review replay metadata", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decodeDevReviewRecord({
        id: "dev-review-1",
        sourceThreadId: "thread-source",
        reviewThreadId: "thread-review",
        sourceTurnId: null,
        status: "running",
        document: emptyDocument,
        replay: {
          status: "recording",
          eventCount: -1,
          startedAt: "2026-01-01T00:00:00.000Z",
          completedAt: null,
          durationMs: null,
          error: null,
        },
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:01.000Z",
      }),
    );
    assert.strictEqual(result._tag, "Failure");
  }),
);
