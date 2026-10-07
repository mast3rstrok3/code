import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeOrchestrationReactor } from "./OrchestrationReactor.ts";
import { WorkflowRuntimeBridge } from "../WorkflowRuntimeBridge.ts";
import { ProductWorkflowReactor } from "../Services/ProductWorkflowReactor.ts";
import { ImplementationWorkflowReactor } from "../Services/ImplementationWorkflowReactor.ts";
import { AppReviewWorkflowReactor } from "../Services/AppReviewWorkflowReactor.ts";
import { PreviewLifecycleReactor } from "../Services/PreviewLifecycleReactor.ts";
import { AppStackLifecycleReactor } from "../AppStackLifecycleReactor.ts";

it.effect(
  "starts the native bridge before workflow recovery and drains workflow effects before shutdown",
  () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const record = (label: string) =>
        Effect.sync(() => {
          calls.push(label);
        });
      const workflow = (label: string) => ({
        start: () => record(`${label}:start`),
        drain: record(`${label}:drain`),
        flush: record(`${label}:flush`),
        reconcileStartup: () => record(`${label}:recover`),
      });
      const dependencies = Layer.mergeAll(
        Layer.mock(WorkflowRuntimeBridge)({
          start: record("native:start"),
          drain: record("native:drain"),
        }),
        Layer.succeed(ProductWorkflowReactor, workflow("product")),
        Layer.succeed(ImplementationWorkflowReactor, {
          ...workflow("implementation"),
          recoverRetryableRuns: () => Effect.void,
          recoverIncompleteStages: () => Effect.void,
        }),
        Layer.succeed(AppReviewWorkflowReactor, {
          ...workflow("app-review"),
          reconcile: () => record("app-review:recover"),
        }),
        Layer.succeed(PreviewLifecycleReactor, {
          start: () => record("preview:start"),
          drain: Effect.void,
        }),
        Layer.succeed(AppStackLifecycleReactor, {
          start: () => record("app-stack:start"),
          drain: record("app-stack:drain"),
        }),
      );
      yield* Effect.gen(function* () {
        const reactor = yield* makeOrchestrationReactor;
        yield* reactor.start();
        yield* reactor.reconcilePendingProviderCommands;
        yield* reactor.drainForShutdown;
      }).pipe(Effect.provide(dependencies));
      expect(calls).toEqual([
        "native:start",
        "product:start",
        "implementation:start",
        "app-review:start",
        "preview:start",
        "app-stack:start",
        "app-review:recover",
        "app-review:flush",
        "implementation:recover",
        "implementation:flush",
        "product:recover",
        "product:flush",
        "native:drain",
        "app-review:flush",
        "implementation:flush",
        "product:flush",
        "native:drain",
        "app-stack:drain",
      ]);
    }),
);
