import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  OrchestrationReactor,
  type OrchestrationReactorShape,
} from "../Services/OrchestrationReactor.ts";
import { ImplementationWorkflowReactor } from "../Services/ImplementationWorkflowReactor.ts";
import { AppReviewWorkflowReactor } from "../Services/AppReviewWorkflowReactor.ts";
import { ProductWorkflowReactor } from "../Services/ProductWorkflowReactor.ts";
import { PreviewLifecycleReactor } from "../Services/PreviewLifecycleReactor.ts";
import { WorkflowRuntimeBridge } from "../WorkflowRuntimeBridge.ts";
import { AppStackLifecycleReactor } from "../AppStackLifecycleReactor.ts";

export const makeOrchestrationReactor = Effect.gen(function* () {
  const bridge = yield* WorkflowRuntimeBridge;
  const product = yield* ProductWorkflowReactor;
  const implementation = yield* ImplementationWorkflowReactor;
  const appReview = yield* AppReviewWorkflowReactor;
  const preview = yield* PreviewLifecycleReactor;
  const appStacks = yield* AppStackLifecycleReactor;
  const reconcilePendingProviderCommands = Effect.gen(function* () {
    yield* appReview.reconcile();
    yield* appReview.flush ?? appReview.drain;
    yield* implementation.reconcileStartup();
    yield* implementation.flush ?? implementation.drain;
    yield* product.reconcileStartup();
    yield* product.flush ?? product.drain;
    yield* bridge.drain;
  });
  return {
    start: () =>
      Effect.gen(function* () {
        yield* bridge.start;
        yield* product.start();
        yield* implementation.start();
        yield* appReview.start();
        yield* preview.start();
        yield* appStacks.start();
      }),
    drainPendingProviderCommands: bridge.drain,
    reconcilePendingProviderCommands,
    drainForShutdown: Effect.gen(function* () {
      yield* appReview.flush ?? appReview.drain;
      yield* implementation.flush ?? implementation.drain;
      yield* product.flush ?? product.drain;
      yield* bridge.drain;
      yield* appStacks.drain;
    }),
  } satisfies OrchestrationReactorShape;
});

export const OrchestrationReactorLive = Layer.effect(
  OrchestrationReactor,
  makeOrchestrationReactor,
);
