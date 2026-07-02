import { describe, expect, it } from "vite-plus/test";
import {
  DevReviewId,
  EMPTY_DEV_REVIEW_EVIDENCE,
  ThreadId,
  type DevReviewRecord,
} from "@t3tools/contracts";

import { selectActiveDevReviewRecord } from "./DevReviewPanel.logic";

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

function makeDevReviewRecord(overrides: Partial<DevReviewRecord> = {}): DevReviewRecord {
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
    evidence: EMPTY_DEV_REVIEW_EVIDENCE,
    createdAt: "2026-03-09T10:00:00.000Z",
    updatedAt: "2026-03-09T10:00:00.000Z",
    ...overrides,
  };
}
