/**
 * DrainableWorker - A queue-based worker that exposes a `drain()` effect.
 *
 * Wraps the common `Queue.unbounded` + `Effect.forever` pattern and adds
 * a signal that resolves when the queue is empty **and** the current item
 * has finished processing. This lets tests replace timing-sensitive
 * `Effect.sleep` calls with deterministic `drain()`.
 *
 * @module DrainableWorker
 */
import * as Cause from "effect/Cause";
import * as Scope from "effect/Scope";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TxQueue from "effect/TxQueue";
import * as TxRef from "effect/TxRef";

export interface DrainableWorker<A> {
  /**
   * Enqueue a work item and track it for `drain()`.
   *
   * This wraps `Queue.offer` so drain state is updated atomically with the
   * enqueue path instead of inferring it from queue internals.
   */
  readonly enqueue: (item: A) => Effect.Effect<void>;

  /**
   * Resolves when the queue is empty and the worker is idle (not processing).
   */
  readonly drain: Effect.Effect<void>;

  /**
   * Resolves after every item queued before this call has finished. Items
   * queued after the barrier do not delay it.
   */
  readonly flush: Effect.Effect<void>;
}

export interface KeyedDrainableWorker<A> extends DrainableWorker<A> {}

/**
 * Create a drainable worker that processes items from an unbounded queue.
 *
 * The worker is forked into the current scope and will be interrupted when
 * the scope closes. A finalizer shuts down the queue and drops queued items,
 * so `drain` resolves after the scope closes instead of waiting on them.
 *
 * An item that fails or dies is logged and skipped; the worker keeps
 * processing later items and `drain` still resolves.
 *
 * @param process - The effect to run for each queued item.
 * @returns A `DrainableWorker` with `enqueue` and `drain`.
 */
export const makeDrainableWorker = <A, E, R>(
  process: (item: A) => Effect.Effect<void, E, R>,
): Effect.Effect<DrainableWorker<A>, never, Scope.Scope | R> =>
  Effect.gen(function* () {
    type Entry =
      | { readonly _tag: "item"; readonly value: A }
      | { readonly _tag: "barrier"; readonly completed: Deferred.Deferred<void> };
    const outstanding = yield* TxRef.make(0);
    const queue = yield* Effect.acquireRelease(TxQueue.unbounded<Entry>(), (queue) =>
      // Uncount only the dropped items: an item still running uncounts itself,
      // even when a parallel scope closes it after this finalizer.
      Effect.gen(function* () {
        const dropped = yield* TxQueue.clear(queue).pipe(
          Effect.tap((entries) =>
            TxRef.update(
              outstanding,
              (n) => n - entries.filter((entry) => entry._tag === "item").length,
            ),
          ),
          Effect.tap(() => TxQueue.shutdown(queue)),
          Effect.tx,
        );
        yield* Effect.forEach(dropped, (entry) =>
          entry._tag === "barrier" ? Deferred.succeed(entry.completed, undefined) : Effect.void,
        );
      }),
    );

    yield* TxQueue.take(queue).pipe(
      Effect.flatMap((entry) =>
        entry._tag === "barrier"
          ? Deferred.succeed(entry.completed, undefined).pipe(Effect.asVoid)
          : // `suspend` turns a `process` that throws while building its effect
            // into this item's defect instead of the loop's.
            Effect.suspend(() => process(entry.value)).pipe(
              // Only the item's own failure, defect, or interruption lands here and
              // the loop continues; interrupting the worker fiber still stops it.
              // Callers treat an item that only interrupted itself as cancelled,
              // not failed.
              Effect.catchCause((cause) =>
                Cause.hasInterruptsOnly(cause)
                  ? Effect.void
                  : Effect.logError("DrainableWorker item failed", cause),
              ),
              Effect.ensuring(TxRef.update(outstanding, (n) => n - 1)),
            ),
      ),
      Effect.forever,
      Effect.forkScoped,
    );

    const drain: DrainableWorker<A>["drain"] = TxRef.get(outstanding).pipe(
      Effect.flatMap((n) => (n > 0 ? Effect.txRetry : Effect.void)),
      Effect.tx,
    );

    const enqueue: DrainableWorker<A>["enqueue"] = (element) =>
      TxQueue.offer(queue, { _tag: "item", value: element }).pipe(
        // A shut-down queue refuses the item, so it is never processed.
        Effect.tap((offered) => (offered ? TxRef.update(outstanding, (n) => n + 1) : Effect.void)),
        Effect.tx,
        Effect.asVoid,
      );

    const flush = Effect.gen(function* () {
      const completed = yield* Deferred.make<void>();
      const offered = yield* TxQueue.offer(queue, { _tag: "barrier", completed }).pipe(Effect.tx);
      if (offered) yield* Deferred.await(completed);
    });

    return { enqueue, drain, flush } satisfies DrainableWorker<A>;
  });

/**
 * Processes each key in order while allowing different keys to run concurrently.
 * Idle key groups expire so a long-lived worker does not retain every key it has seen.
 */
export const makeKeyedDrainableWorker = <A, K, E, R>(options: {
  readonly key: (item: A) => K;
  readonly process: (item: A) => Effect.Effect<void, E, R>;
  readonly idleTimeToLive?: Duration.Input;
}): Effect.Effect<KeyedDrainableWorker<A>, never, Scope.Scope | R> =>
  Effect.gen(function* () {
    const queue = yield* Effect.acquireRelease(Queue.unbounded<A>(), Queue.shutdown);
    const outstanding = yield* TxRef.make(0);

    const process = (item: A) =>
      Effect.ensuring(
        options.process(item),
        TxRef.update(outstanding, (count) => count - 1).pipe(Effect.tx),
      );

    yield* Stream.fromQueue(queue).pipe(
      Stream.groupByKey(options.key, {
        bufferSize: Number.POSITIVE_INFINITY,
        idleTimeToLive: options.idleTimeToLive ?? Duration.minutes(5),
      }),
      Stream.mapEffect(([, keyedStream]) => Stream.runForEach(keyedStream, process), {
        concurrency: "unbounded",
      }),
      Stream.runDrain,
      Effect.forkScoped,
    );

    const enqueue: KeyedDrainableWorker<A>["enqueue"] = (item) =>
      TxRef.update(outstanding, (count) => count + 1).pipe(
        Effect.tx,
        Effect.andThen(Queue.offer(queue, item)),
        Effect.asVoid,
      );

    const drain: KeyedDrainableWorker<A>["drain"] = TxRef.get(outstanding).pipe(
      Effect.tap((count) => (count > 0 ? Effect.txRetry : Effect.void)),
      Effect.asVoid,
      Effect.tx,
    );

    return { enqueue, drain, flush: drain } satisfies KeyedDrainableWorker<A>;
  });
