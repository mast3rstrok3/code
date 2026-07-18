import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export interface StaleTurnReconcilerShape {
  /**
   * Start the background stale-turn reconciler within the provided scope.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class StaleTurnReconciler extends Context.Service<
  StaleTurnReconciler,
  StaleTurnReconcilerShape
>()("t3/orchestration/Services/StaleTurnReconciler") {}
