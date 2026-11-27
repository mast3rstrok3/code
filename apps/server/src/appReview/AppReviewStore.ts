/**
 * A review belongs to the thread whose agent writes it (`sourceThreadId = reviewThreadId`),
 * and the newest one it owns is active. Evidence starts a review on first use, and a fresh
 * one once the active review has a verdict, so evidence never lands on a finished review.
 */
import {
  AppReviewError,
  AppReviewId,
  EMPTY_APP_REVIEW_EVIDENCE,
  type AppReviewRecord,
  type AppReviewScope,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { ProjectionThreadAppReviewRepositoryLive } from "../persistence/Layers/ProjectionThreadAppReviews.ts";
import {
  appReviewRecordToProjection,
  projectionThreadAppReviewToRecord,
  ProjectionThreadAppReviewRepository,
} from "../persistence/Services/ProjectionThreadAppReviews.ts";

const EMPTY_DOCUMENT: AppReviewRecord["document"] = {
  verdict: "pending",
  summary: "",
  checks: [],
  findings: [],
  questions: [],
  nextSteps: [],
};

const isFinished = (record: AppReviewRecord) =>
  record.status === "passed" || record.status === "failed";

/** Records written before scopes existed required browser evidence. */
const widenAppReviewScope = (
  current: AppReviewScope | undefined,
  needed: AppReviewScope,
): AppReviewScope => {
  const scope = current ?? "browser";
  return scope === needed ? scope : "both";
};

interface AppReviewUpdateTarget {
  readonly threadId: ThreadId;
  /**
   * The evidence the change adds. With it, a thread without an active review, or
   * whose active review is finished, gets a new one. Without it the change must
   * apply to an existing review.
   */
  readonly evidence?: AppReviewScope | undefined;
}

export class AppReviewStore extends Context.Service<
  AppReviewStore,
  {
    /** Every review the thread wrote or was reviewed by, oldest first. */
    readonly listForThread: (
      threadId: ThreadId,
    ) => Effect.Effect<ReadonlyArray<AppReviewRecord>, AppReviewError>;
    readonly get: (
      reviewId: AppReviewId,
    ) => Effect.Effect<Option.Option<AppReviewRecord>, AppReviewError>;
    /** The newest review the thread owns. */
    readonly active: (
      threadId: ThreadId,
    ) => Effect.Effect<Option.Option<AppReviewRecord>, AppReviewError>;
    readonly start: (input: {
      readonly threadId: ThreadId;
      readonly scope: AppReviewScope;
      readonly brief?: string | undefined;
    }) => Effect.Effect<AppReviewRecord, AppReviewError>;
    /** Apply `change` to the thread's active review and persist the result. */
    readonly update: <E, R>(
      target: AppReviewUpdateTarget,
      change: (record: AppReviewRecord) => Effect.Effect<AppReviewRecord, E, R>,
    ) => Effect.Effect<AppReviewRecord, AppReviewError | E, R>;
    /** The thread's reviews now, then again after every change to one of them. */
    readonly subscribeThread: (
      threadId: ThreadId,
    ) => Stream.Stream<ReadonlyArray<AppReviewRecord>, AppReviewError>;
  }
>()("t3/appReview/AppReviewStore") {}

const make = Effect.gen(function* () {
  const repository = yield* ProjectionThreadAppReviewRepository;
  const random = yield* SecureRandom.SecureRandom;
  const changes = yield* PubSub.unbounded<ThreadId>();
  const writes = yield* Semaphore.make(1);

  const storageError = (cause: unknown, reviewId?: AppReviewId) =>
    new AppReviewError({
      ...(reviewId === undefined ? {} : { reviewId }),
      message: "App Review storage failed.",
      cause,
    });

  const listForThread = Effect.fn("AppReviewStore.listForThread")(function* (threadId: ThreadId) {
    const rows = yield* repository
      .listByThreadId({ threadId })
      .pipe(Effect.mapError((cause) => storageError(cause)));
    return rows.map(projectionThreadAppReviewToRecord);
  });

  const get = Effect.fn("AppReviewStore.get")(function* (reviewId: AppReviewId) {
    const row = yield* repository
      .getById({ reviewId })
      .pipe(Effect.mapError((cause) => storageError(cause, reviewId)));
    return Option.map(row, projectionThreadAppReviewToRecord);
  });

  const active = Effect.fn("AppReviewStore.active")(function* (threadId: ThreadId) {
    const records = yield* listForThread(threadId);
    return Option.fromNullishOr(records.findLast((record) => record.reviewThreadId === threadId));
  });

  const save = Effect.fn("AppReviewStore.save")(function* (record: AppReviewRecord) {
    yield* repository
      .upsert(appReviewRecordToProjection(record))
      .pipe(Effect.mapError((cause) => storageError(cause, record.id)));
    yield* PubSub.publish(changes, record.reviewThreadId);
    return record;
  });

  const create = Effect.fn("AppReviewStore.create")(function* (input: {
    readonly threadId: ThreadId;
    readonly scope: AppReviewScope;
    readonly brief?: string | undefined;
  }) {
    const now = DateTime.formatIso(yield* DateTime.now);
    const id = AppReviewId.make(`app-review-${yield* random.uuidV4()}`);
    return {
      id,
      sourceThreadId: input.threadId,
      reviewThreadId: input.threadId,
      appReviewScope: input.scope,
      sourceTurnId: null,
      status: "running",
      document:
        input.brief === undefined ? EMPTY_DOCUMENT : { ...EMPTY_DOCUMENT, brief: input.brief },
      evidence: EMPTY_APP_REVIEW_EVIDENCE,
      createdAt: now,
      updatedAt: now,
    } satisfies AppReviewRecord;
  });

  const start: AppReviewStore["Service"]["start"] = (input) =>
    writes.withPermit(create(input).pipe(Effect.flatMap(save)));

  const update: AppReviewStore["Service"]["update"] = Effect.fn("AppReviewStore.update")(function* <
    E,
    R,
  >(
    target: AppReviewUpdateTarget,
    change: (record: AppReviewRecord) => Effect.Effect<AppReviewRecord, E, R>,
  ) {
    return yield* writes.withPermit(
      Effect.gen(function* () {
        const current = Option.getOrUndefined(yield* active(target.threadId));
        const evidence = target.evidence;
        let record: AppReviewRecord;
        if (current !== undefined && (evidence === undefined || !isFinished(current))) {
          record =
            evidence === undefined
              ? current
              : {
                  ...current,
                  appReviewScope: widenAppReviewScope(current.appReviewScope, evidence),
                };
        } else if (evidence !== undefined) {
          record = yield* create({ threadId: target.threadId, scope: evidence });
        } else {
          return yield* new AppReviewError({
            message:
              "This thread has no App Review yet. Call app_review_start, or run a test or start a recording to begin one.",
          });
        }
        const changed = yield* change(record);
        return yield* save({ ...changed, updatedAt: DateTime.formatIso(yield* DateTime.now) });
      }),
    );
  });

  const subscribeThread: AppReviewStore["Service"]["subscribeThread"] = (threadId) =>
    Stream.unwrap(
      Effect.gen(function* () {
        // Subscribe before the first read so a change in between is not lost.
        const subscription = yield* PubSub.subscribe(changes);
        return Stream.concat(
          Stream.fromEffect(listForThread(threadId)),
          Stream.fromSubscription(subscription).pipe(
            Stream.filter((changed) => changed === threadId),
            Stream.mapEffect(() => listForThread(threadId)),
          ),
        );
      }),
    );

  return AppReviewStore.of({ listForThread, get, active, start, update, subscribeThread });
});

export const layer = Layer.effect(AppReviewStore, make).pipe(
  Layer.provide(ProjectionThreadAppReviewRepositoryLive),
);
