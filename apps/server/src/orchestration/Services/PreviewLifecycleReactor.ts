/**
 * PreviewLifecycleReactor - Closes workflow-owned browser previews when their work ends.
 *
 * @module PreviewLifecycleReactor
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export interface PreviewLifecycleReactorShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  readonly drain: Effect.Effect<void>;
}

export class PreviewLifecycleReactor extends Context.Service<
  PreviewLifecycleReactor,
  PreviewLifecycleReactorShape
>()("t3/orchestration/Services/PreviewLifecycleReactor") {}
