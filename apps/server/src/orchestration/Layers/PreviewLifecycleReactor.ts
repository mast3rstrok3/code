import type { OrchestrationEvent, ThreadId } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as PreviewCoordinator from "../../preview/PreviewCoordinator.ts";
import { forkParked } from "../../serverActivation.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  PreviewLifecycleReactor,
  type PreviewLifecycleReactorShape,
} from "../Services/PreviewLifecycleReactor.ts";

type PreviewLifecycleEvent = Extract<
  OrchestrationEvent,
  {
    type:
      | "thread.dev-review-updated"
      | "thread.workflow-subagent-batch-child-updated"
      | "thread.implementation-run-cancel-requested"
      | "thread.dev-review-workflow-cancel-requested"
      | "thread.dev-review-workflow-updated"
      | "thread.deleted";
  }
>;

const terminalDevReviewStatuses = new Set(["passed", "failed", "blocked"]);
const terminalWorkflowChildStatuses = new Set([
  "completed",
  "blocked",
  "rejected",
  "failed",
  "canceled",
]);

export const previewThreadIdForEvent = (event: OrchestrationEvent): ThreadId | null => {
  switch (event.type) {
    case "thread.dev-review-updated":
      return event.payload.status !== undefined &&
        terminalDevReviewStatuses.has(event.payload.status)
        ? event.payload.reviewThreadId
        : null;
    case "thread.workflow-subagent-batch-child-updated":
      return terminalWorkflowChildStatuses.has(event.payload.child.status)
        ? event.payload.child.childThreadId
        : null;
    case "thread.implementation-run-cancel-requested":
      return event.payload.run.activeDevReviewThreadId;
    case "thread.dev-review-workflow-cancel-requested":
      return event.payload.run.cycles.at(-1)?.reviewerThreadId ?? null;
    case "thread.dev-review-workflow-updated":
      return event.payload.run.status === "running"
        ? null
        : (event.payload.run.cycles.at(-1)?.reviewerThreadId ?? null);
    case "thread.deleted":
      return event.payload.threadId;
    default:
      return null;
  }
};

export const closePreviewForEvent = (
  previewCoordinator: PreviewCoordinator.PreviewCoordinator["Service"],
  event: PreviewLifecycleEvent,
) => {
  const threadId = previewThreadIdForEvent(event);
  if (threadId === null) return Effect.void;
  return previewCoordinator.close({ threadId, reason: "workflow-cleanup" }).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause)
        : Effect.logWarning("preview lifecycle cleanup failed", {
            eventType: event.type,
            cause: Cause.pretty(cause),
          }),
    ),
  );
};

export const makePreviewLifecycleReactor = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const previewCoordinator = yield* PreviewCoordinator.PreviewCoordinator;

  const processEvent = Effect.fn("PreviewLifecycleReactor.processEvent")(function* (
    event: PreviewLifecycleEvent,
  ) {
    yield* closePreviewForEvent(previewCoordinator, event);
  });

  const worker = yield* makeDrainableWorker(processEvent);

  const start: PreviewLifecycleReactorShape["start"] = Effect.fn("start")(function* () {
    yield* forkParked(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        const threadId = previewThreadIdForEvent(event);
        return threadId === null ? Effect.void : worker.enqueue(event as PreviewLifecycleEvent);
      }),
    );
  });

  return {
    start,
    drain: worker.drain,
  } satisfies PreviewLifecycleReactorShape;
});

export const PreviewLifecycleReactorLive = Layer.effect(
  PreviewLifecycleReactor,
  makePreviewLifecycleReactor,
);
