import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export interface ProductWorkflowReactorShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  readonly drain: Effect.Effect<void>;
}

export class ProductWorkflowReactor extends Context.Service<
  ProductWorkflowReactor,
  ProductWorkflowReactorShape
>()("t3/orchestration/Services/ProductWorkflowReactor") {}
