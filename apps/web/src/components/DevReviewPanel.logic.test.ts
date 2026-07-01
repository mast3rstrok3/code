import { describe, expect, it } from "vite-plus/test";
import { DevReviewId, ThreadId, type DevReviewRecord } from "@t3tools/contracts";

import {
  devReviewReplayRefreshRevision,
  selectActiveDevReviewRecord,
  shouldRefreshDevReviewReplay,
} from "./DevReviewPanel.logic";

describe("selectActiveDevReviewRecord", () => {
  it("prefers the record whose review thread is open", () => {
    const sourceThreadId = ThreadId.make("thread-source");
    const openedReviewThreadId = ThreadId.make("thread-review-open");
    const records = [
      makeDevReviewRecord({
        id: DevReviewId.make("dev-review-latest"),
        sourceThreadId,
        reviewThreadId: ThreadId.make("thread-review-latest"),
        createdAt: "2026-03-09T12:00:00.000Z",
      }),
      makeDevReviewRecord({
        id: DevReviewId.make("dev-review-open"),
        sourceThreadId,
        reviewThreadId: openedReviewThreadId,
        createdAt: "2026-03-09T11:00:00.000Z",
      }),
    ];

    expect(selectActiveDevReviewRecord(records, openedReviewThreadId)?.id).toBe("dev-review-open");
  });

  it("falls back to the latest source-thread record", () => {
    const records = [
      makeDevReviewRecord({
        id: DevReviewId.make("dev-review-old"),
        createdAt: "2026-03-09T11:00:00.000Z",
      }),
      makeDevReviewRecord({
        id: DevReviewId.make("dev-review-new"),
        createdAt: "2026-03-09T12:00:00.000Z",
      }),
    ];

    expect(selectActiveDevReviewRecord(records, ThreadId.make("thread-source"))?.id).toBe(
      "dev-review-new",
    );
  });
});

describe("shouldRefreshDevReviewReplay", () => {
  it("refreshes when metadata reports saved events but the cached replay is empty", () => {
    const record = makeDevReviewRecord({
      replay: {
        status: "saved",
        eventCount: 2,
        startedAt: "2026-03-09T10:00:00.000Z",
        completedAt: "2026-03-09T10:01:00.000Z",
        durationMs: 60_000,
        error: null,
      },
    });

    expect(
      shouldRefreshDevReviewReplay({
        record,
        data: { reviewId: record.id, events: [] },
        isPending: false,
        lastRefreshRevision: null,
      }),
    ).toEqual({ refresh: true, revision: devReviewReplayRefreshRevision(record) });
  });

  it("does not repeatedly refresh the same replay metadata revision", () => {
    const record = makeDevReviewRecord({
      replay: {
        status: "saved",
        eventCount: 2,
        startedAt: "2026-03-09T10:00:00.000Z",
        completedAt: "2026-03-09T10:01:00.000Z",
        durationMs: 60_000,
        error: null,
      },
    });
    const revision = devReviewReplayRefreshRevision(record);

    expect(
      shouldRefreshDevReviewReplay({
        record,
        data: { reviewId: record.id, events: [] },
        isPending: false,
        lastRefreshRevision: revision,
      }),
    ).toEqual({ refresh: false, revision });
  });
});

function makeDevReviewRecord(overrides: Partial<DevReviewRecord> = {}): DevReviewRecord {
  const replay = overrides.replay ?? {
    status: "not-started",
    eventCount: 0,
    startedAt: null,
    completedAt: null,
    durationMs: null,
    error: null,
  };
  return {
    id: DevReviewId.make("dev-review-1"),
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
    replay,
    createdAt: "2026-03-09T10:00:00.000Z",
    updatedAt: "2026-03-09T10:00:00.000Z",
    ...overrides,
  };
}
