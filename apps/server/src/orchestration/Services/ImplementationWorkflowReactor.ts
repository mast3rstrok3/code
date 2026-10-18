import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export interface ImplementationWorkflowReactorShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  readonly drain: Effect.Effect<void>;
  readonly flush?: Effect.Effect<void>;
  readonly reconcileStartup: () => Effect.Effect<void>;
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

/**
 * How often `start` runs the retry and stage recovery sweeps. Tests that drive those sweeps by
 * hand turn it off, since advancing the test clock past a grace window would otherwise run a
 * sweep on every interval it crosses.
 */
export const ImplementationRecoverySweepInterval = Context.Reference<Duration.Duration>(
  "t3/orchestration/Services/ImplementationRecoverySweepInterval",
  { defaultValue: () => Duration.seconds(30) },
);

export class ImplementationWorkflowReactor extends Context.Service<
  ImplementationWorkflowReactor,
  ImplementationWorkflowReactorShape
>()("t3/orchestration/Services/ImplementationWorkflowReactor") {}
