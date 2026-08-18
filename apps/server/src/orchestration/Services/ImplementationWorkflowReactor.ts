import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export interface ImplementationWorkflowReactorShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  readonly drain: Effect.Effect<void>;
  /**
   * One pass of the automatic retry sweep that `start` otherwise runs every 30s.
   * Exposed so its guards can be exercised without waiting on the schedule.
   */
  readonly recoverRetryableRuns: () => Effect.Effect<void>;
  /**
   * One pass of the stage recovery sweep that `start` otherwise runs every 30s.
   * Exposed so its guards — above all the one that leaves paused runs alone —
   * can be exercised without waiting on the schedule.
   */
  readonly recoverIncompleteStages: () => Effect.Effect<void>;
}

export class ImplementationWorkflowReactor extends Context.Service<
  ImplementationWorkflowReactor,
  ImplementationWorkflowReactorShape
>()("t3/orchestration/Services/ImplementationWorkflowReactor") {}
