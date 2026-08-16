import { ThreadId, type OrchestrationEvent } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as PreviewCoordinator from "../../preview/PreviewCoordinator.ts";
import { closePreviewForEvent, previewThreadIdForEvent } from "./PreviewLifecycleReactor.ts";

const asEvent = (type: OrchestrationEvent["type"], payload: unknown): OrchestrationEvent =>
  ({ type, payload }) as OrchestrationEvent;

const reviewThreadId = ThreadId.make("review-thread");
const childThreadId = ThreadId.make("workflow-child");
const sourceThreadId = ThreadId.make("source-thread");

describe("PreviewLifecycleReactor", () => {
  it("closes terminal App Review and workflow-child threads", () => {
    for (const status of ["passed", "failed"] as const) {
      expect(
        previewThreadIdForEvent(asEvent("thread.app-review-updated", { status, reviewThreadId })),
      ).toBe(reviewThreadId);
    }
    for (const status of ["completed", "blocked", "rejected", "failed", "canceled"] as const) {
      expect(
        previewThreadIdForEvent(
          asEvent("thread.workflow-subagent-batch-child-updated", {
            child: { status, childThreadId },
          }),
        ),
      ).toBe(childThreadId);
    }
  });

  it("keeps pending and running workflow previews open", () => {
    expect(
      previewThreadIdForEvent(
        asEvent("thread.app-review-updated", { status: "running", reviewThreadId }),
      ),
    ).toBeNull();
    for (const status of ["pending", "running"] as const) {
      expect(
        previewThreadIdForEvent(
          asEvent("thread.workflow-subagent-batch-child-updated", {
            child: { status, childThreadId },
          }),
        ),
      ).toBeNull();
    }
  });

  it("closes the active App Review on cancellation and any deleted thread", () => {
    expect(
      previewThreadIdForEvent(
        asEvent("thread.implementation-run-cancel-requested", {
          run: { activeAppReviewThreadId: reviewThreadId },
        }),
      ),
    ).toBe(reviewThreadId);
    expect(previewThreadIdForEvent(asEvent("thread.deleted", { threadId: sourceThreadId }))).toBe(
      sourceThreadId,
    );
  });

  it.effect("handles duplicate terminal events harmlessly", () => {
    const closed: ThreadId[] = [];
    const coordinator = {
      close: ({ threadId }: { readonly threadId: ThreadId }) =>
        Effect.sync(() => {
          closed.push(threadId);
        }),
    } as unknown as PreviewCoordinator.PreviewCoordinator["Service"];
    const event = asEvent("thread.app-review-updated", {
      status: "passed",
      reviewThreadId,
    });

    return Effect.all(
      [
        closePreviewForEvent(coordinator, event as never),
        closePreviewForEvent(coordinator, event as never),
      ],
      { discard: true },
    ).pipe(
      Effect.tap(() => Effect.sync(() => expect(closed).toEqual([reviewThreadId, reviewThreadId]))),
    );
  });

  it.effect("does not let cleanup failures block event processing", () => {
    const coordinator = {
      close: () => Effect.die("browser cleanup failed"),
    } as unknown as PreviewCoordinator.PreviewCoordinator["Service"];
    const event = asEvent("thread.deleted", { threadId: sourceThreadId });

    return closePreviewForEvent(coordinator, event as never);
  });
});
