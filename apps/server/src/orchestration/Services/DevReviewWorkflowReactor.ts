import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export interface DevReviewWorkflowReactorShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  readonly drain: Effect.Effect<void>;
  readonly reconcile: () => Effect.Effect<void>;
}

export class DevReviewWorkflowReactor extends Context.Service<
  DevReviewWorkflowReactor,
  DevReviewWorkflowReactorShape
>()("t3/orchestration/Services/DevReviewWorkflowReactor") {}
