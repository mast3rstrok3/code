/**
 * Which threads still have provider runtime events queued for ingestion.
 *
 * Ingestion keeps one queue per thread, and every event it writes waits its
 * turn at the orchestration engine. When the engine falls behind, a thread's
 * queue can hold its turn completion and its workflow result for an hour after
 * the provider finished. The projection then shows a turn that stopped without
 * reporting, so the stale-turn reconciler settles it and stage recovery
 * relaunches the agent, spending its launch budget on work that already
 * succeeded. Those checks ask here first: a thread with queued events is not
 * finished, it has just not been heard yet.
 *
 * Optional for consumers (`Effect.serviceOption`), so test layers without it
 * behave as if nothing is ever queued.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

export class ProviderIngestionBacklog extends Context.Service<
  ProviderIngestionBacklog,
  {
    /** Record an event queued for `threadId`. Pair every call with `settle`. */
    readonly track: (threadId: string) => Effect.Effect<void>;
    /** Record that one queued event for `threadId` was processed. */
    readonly settle: (threadId: string) => Effect.Effect<void>;
    /** Threads with at least one queued event right now. */
    readonly pendingThreadIds: Effect.Effect<ReadonlySet<string>>;
  }
>()("t3/orchestration/ProviderIngestionBacklog") {}

export const make = Effect.sync(() => {
  const pending = new Map<string, number>();
  return ProviderIngestionBacklog.of({
    track: (threadId) =>
      Effect.sync(() => {
        pending.set(threadId, (pending.get(threadId) ?? 0) + 1);
      }),
    settle: (threadId) =>
      Effect.sync(() => {
        const count = (pending.get(threadId) ?? 0) - 1;
        if (count > 0) pending.set(threadId, count);
        else pending.delete(threadId);
      }),
    pendingThreadIds: Effect.sync(() => new Set(pending.keys())),
  });
});

export const layer = Layer.effect(ProviderIngestionBacklog, make);

/** Pending thread ids from an optional backlog; empty when none is provided. */
export const pendingIngestionThreadIds = (
  backlog: Option.Option<ProviderIngestionBacklog["Service"]>,
): Effect.Effect<ReadonlySet<string>> =>
  Option.isSome(backlog) ? backlog.value.pendingThreadIds : Effect.succeed(new Set<string>());
