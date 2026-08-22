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
import * as Scope from "effect/Scope";
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
}

export interface KeyedDrainableWorker<A> extends DrainableWorker<A> {}

/**
 * Create a drainable worker that processes items from an unbounded queue.
 *
 * The worker is forked into the current scope and will be interrupted when
 * the scope closes. A finalizer shuts down the queue.
 *
 * @param process - The effect to run for each queued item.
 * @returns A `DrainableWorker` with `queue` and `drain`.
 */
export const makeDrainableWorker = <A, E, R>(
  process: (item: A) => Effect.Effect<void, E, R>,
): Effect.Effect<DrainableWorker<A>, never, Scope.Scope | R> =>
  Effect.gen(function* () {
    const queue = yield* Effect.acquireRelease(TxQueue.unbounded<A>(), TxQueue.shutdown);
    const outstanding = yield* TxRef.make(0);

    yield* TxQueue.take(queue).pipe(
      Effect.tap((a) =>
        Effect.ensuring(
          process(a),
          TxRef.update(outstanding, (n) => n - 1),
        ),
      ),
      Effect.forever,
      Effect.forkScoped,
    );

    const drain: DrainableWorker<A>["drain"] = TxRef.get(outstanding).pipe(
      Effect.tap((n) => (n > 0 ? Effect.txRetry : Effect.void)),
      Effect.tx,
    );

    const enqueue = (element: A): Effect.Effect<boolean, never, never> =>
      TxQueue.offer(queue, element).pipe(
        Effect.tap(() => TxRef.update(outstanding, (n) => n + 1)),
        Effect.tx,
      );

    return { enqueue, drain } satisfies DrainableWorker<A>;
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

    return { enqueue, drain } satisfies KeyedDrainableWorker<A>;
  });
