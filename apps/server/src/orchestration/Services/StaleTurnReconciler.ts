import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export interface StaleTurnReconcilerShape {
  /**
   * Reconcile orphaned turns once, then start the periodic reconciler within
   * the provided scope. The startup pass finishes before this effect returns.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class StaleTurnReconciler extends Context.Service<
  StaleTurnReconciler,
  StaleTurnReconcilerShape
>()("t3/orchestration/Services/StaleTurnReconciler") {}
