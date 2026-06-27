import {
  CommandId,
  DevReviewReplayError,
  OrchestrationDispatchCommandError,
  OrchestrationGetSnapshotError,
  type DevReviewId,
  type DevReviewRecord,
  type DevReviewReplayMetadata,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { DevReviewToolkit } from "./tools.ts";

const replayError = (reviewId: DevReviewId | undefined, message: string, cause?: unknown) =>
  new DevReviewReplayError({
    ...(reviewId === undefined ? {} : { reviewId }),
    message,
    ...(cause === undefined ? {} : { cause }),
  });

const dispatchError = (message: string, cause: unknown) =>
  new OrchestrationDispatchCommandError({
    message,
    cause,
  });

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

let commandIdSequence = 0;
const newCommandId = (prefix: string, reviewId: DevReviewId) =>
  Effect.sync(() => {
    commandIdSequence += 1;
    return CommandId.make(`${prefix}:${reviewId}:${commandIdSequence.toString(36)}`);
  });

const resolveDevReview = Effect.fn("DevReviewToolkit.resolveDevReview")(function* (
  reviewId?: DevReviewId,
) {
  const scope = yield* McpInvocationContext.requireMcpCapability("dev-review").pipe(
    Effect.mapError((cause) => replayError(reviewId, cause.message, cause)),
  );
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const thread = yield* snapshotQuery.getThreadDetailById(scope.threadId).pipe(
    Effect.mapError(
      (cause) =>
        new OrchestrationGetSnapshotError({
          message: `Failed to load thread ${scope.threadId}.`,
          cause,
        }),
    ),
  );
  if (Option.isNone(thread)) {
    return yield* replayError(reviewId, `Thread ${scope.threadId} was not found.`);
  }

  const review =
    reviewId === undefined
      ? (thread.value.devReviews.find((entry) => entry.reviewThreadId === scope.threadId) ??
        thread.value.devReviews[0])
      : thread.value.devReviews.find((entry) => entry.id === reviewId);
  if (review === undefined) {
    return yield* replayError(reviewId, "Dev Review record not found for this thread.");
  }

  return { scope, review };
});

const dispatchReplayMetadataUpdate = Effect.fn("DevReviewToolkit.dispatchReplayMetadataUpdate")(
  function* (input: {
    readonly scope: McpInvocationContext.McpInvocationScope;
    readonly review: DevReviewRecord;
    readonly replay: DevReviewReplayMetadata;
  }) {
    const engine = yield* OrchestrationEngineService;
    const updatedAt = yield* nowIso;
    yield* engine
      .dispatch({
        type: "thread.dev-review.replay-metadata.update",
        commandId: yield* newCommandId("dev-review-replay", input.review.id),
        threadId: input.scope.threadId,
        reviewId: input.review.id,
        replay: input.replay,
        createdAt: updatedAt,
        updatedAt,
      })
      .pipe(
        Effect.mapError((cause) =>
          dispatchError("Failed to persist Dev Review replay metadata.", cause),
        ),
      );
  },
);

const handlers = {
  dev_review_get: (input) =>
    resolveDevReview(input.reviewId).pipe(Effect.map(({ review }) => review)),

  dev_review_update: (input) =>
    Effect.gen(function* () {
      const { scope, review } = yield* resolveDevReview(input.reviewId);
      if (input.status === undefined && input.document === undefined) {
        return yield* replayError(review.id, "Provide status, document, or both.");
      }
      const engine = yield* OrchestrationEngineService;
      const updatedAt = yield* nowIso;
      yield* engine
        .dispatch({
          type: "thread.dev-review.update",
          commandId: yield* newCommandId("dev-review-update", review.id),
          threadId: scope.threadId,
          reviewId: review.id,
          ...(input.status === undefined ? {} : { status: input.status }),
          ...(input.document === undefined ? {} : { document: input.document }),
          createdAt: updatedAt,
          updatedAt,
        })
        .pipe(
          Effect.mapError((cause) => dispatchError("Failed to persist Dev Review update.", cause)),
        );
      return {
        ...review,
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.document === undefined ? {} : { document: input.document }),
        updatedAt,
      };
    }),

  dev_review_replay_start: (input) =>
    Effect.gen(function* () {
      const { scope, review } = yield* resolveDevReview(input.reviewId);
      yield* McpInvocationContext.requireMcpCapability("preview");
      const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
      const replay = yield* broker.invoke<DevReviewReplayMetadata>({
        scope,
        operation: "devReviewReplayStart",
        input: { reviewId: review.id },
      });
      yield* dispatchReplayMetadataUpdate({ scope, review, replay });
      return replay;
    }),

  dev_review_replay_stop: (input) =>
    Effect.gen(function* () {
      const { scope, review } = yield* resolveDevReview(input.reviewId);
      yield* McpInvocationContext.requireMcpCapability("preview");
      const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
      const replay = yield* broker.invoke<DevReviewReplayMetadata>({
        scope,
        operation: "devReviewReplayStop",
        input: { reviewId: review.id },
      });
      yield* dispatchReplayMetadataUpdate({ scope, review, replay });
      return replay;
    }),
} satisfies Parameters<typeof DevReviewToolkit.toLayer>[0];

export const DevReviewToolkitHandlersLive = DevReviewToolkit.toLayer(handlers);
