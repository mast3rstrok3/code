import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "@effect/vitest";

import { CheckpointReactor } from "../Services/CheckpointReactor.ts";
import { ImplementationWorkflowReactor } from "../Services/ImplementationWorkflowReactor.ts";
import { AppReviewWorkflowReactor } from "../Services/AppReviewWorkflowReactor.ts";
import { ProviderCommandReactor } from "../Services/ProviderCommandReactor.ts";
import { ProviderRuntimeIngestionService } from "../Services/ProviderRuntimeIngestion.ts";
import { ProductWorkflowReactor } from "../Services/ProductWorkflowReactor.ts";
import { PreviewLifecycleReactor } from "../Services/PreviewLifecycleReactor.ts";
import { ThreadDeletionReactor } from "../Services/ThreadDeletionReactor.ts";
import * as ThreadSettlementReactor from "../ThreadSettlementReactor.ts";
import * as PullRequestSyncReactor from "../PullRequestSyncReactor.ts";
import * as ThreadPullRequestReactor from "../ThreadPullRequestReactor.ts";
import { OrchestrationReactor } from "../Services/OrchestrationReactor.ts";
import { makeOrchestrationReactor } from "./OrchestrationReactor.ts";
import * as AgentAwarenessRelay from "../../relay/AgentAwarenessRelay.ts";

describe("OrchestrationReactor", () => {
  it.effect(
    "starts provider ingestion, provider command, checkpoint, workflow, and thread deletion reactors",
    () =>
      Effect.gen(function* () {
        const started: string[] = [];

        const layer = Layer.effect(OrchestrationReactor, makeOrchestrationReactor).pipe(
          Layer.provideMerge(
            Layer.succeed(ProviderRuntimeIngestionService, {
              start: () => {
                started.push("provider-runtime-ingestion");
                return Effect.void;
              },
              drain: Effect.void,
            }),
          ),
          Layer.provideMerge(
            Layer.succeed(ProviderCommandReactor, {
              start: () => {
                started.push("provider-command-reactor");
                return Effect.void;
              },
              replayPendingWorkflowTurnStarts: Effect.sync(() => {
                started.push("provider-command-replay");
              }),
              drain: Effect.sync(() => {
                started.push("provider-command-drain");
              }),
            }),
          ),
          Layer.provideMerge(
            Layer.succeed(CheckpointReactor, {
              start: () => {
                started.push("checkpoint-reactor");
                return Effect.void;
              },
              drain: Effect.void,
            }),
          ),
          Layer.provideMerge(
            Layer.succeed(ProductWorkflowReactor, {
              start: () => {
                started.push("product-workflow-reactor");
                return Effect.void;
              },
              drain: Effect.void,
              flush: Effect.sync(() => {
                started.push("product-workflow-flush");
              }),
              reconcileStartup: () =>
                Effect.sync(() => {
                  started.push("product-workflow-reconcile");
                }),
            }),
          ),
          Layer.provideMerge(
            Layer.succeed(ImplementationWorkflowReactor, {
              start: () => {
                started.push("implementation-workflow-reactor");
                return Effect.void;
              },
              drain: Effect.void,
              flush: Effect.sync(() => {
                started.push("implementation-workflow-flush");
              }),
              reconcileStartup: () =>
                Effect.sync(() => {
                  started.push("implementation-workflow-reconcile");
                }),
              recoverRetryableRuns: () => Effect.void,
              recoverIncompleteStages: () => Effect.void,
            }),
          ),
          Layer.provideMerge(
            Layer.succeed(AppReviewWorkflowReactor, {
              start: () => {
                started.push("app-review-workflow-reactor");
                return Effect.void;
              },
              drain: Effect.void,
              flush: Effect.sync(() => {
                started.push("app-review-workflow-flush");
              }),
              reconcile: () =>
                Effect.sync(() => {
                  started.push("app-review-workflow-reconcile");
                }),
            }),
          ),
          Layer.provideMerge(
            Layer.succeed(PreviewLifecycleReactor, {
              start: () => {
                started.push("preview-lifecycle-reactor");
                return Effect.void;
              },
              drain: Effect.void,
            }),
          ),
          Layer.provideMerge(
            Layer.succeed(ThreadDeletionReactor, {
              start: () => {
                started.push("thread-deletion-reactor");
                return Effect.void;
              },
              cleanupEmptyWorkflowShells: Effect.sync(() => {
                started.push("workflow-shell-cleanup");
                return 0;
              }),
              drainThrough: () => Effect.void,
            }),
          ),
          Layer.provideMerge(
            Layer.succeed(ThreadPullRequestReactor.ThreadPullRequestReactor, {
              start: () => {
                started.push("thread-pull-request-reactor");
                return Effect.void;
              },
              drain: Effect.void,
            }),
          ),
          Layer.provideMerge(
            Layer.succeed(ThreadSettlementReactor.ThreadSettlementReactor, {
              start: () => {
                started.push("thread-settlement-reactor");
                return Effect.void;
              },
              drain: Effect.void,
            }),
          ),
          Layer.provideMerge(
            Layer.succeed(PullRequestSyncReactor.PullRequestSyncReactor, {
              start: () => {
                started.push("pull-request-sync-reactor");
                return Effect.void;
              },
              drain: Effect.void,
              requestSync: () => Effect.void,
            }),
          ),
          Layer.provideMerge(
            Layer.succeed(AgentAwarenessRelay.AgentAwarenessRelay, {
              publishThread: () => Effect.void,
              start: () => {
                started.push("agent-awareness-relay");
                return Effect.void;
              },
            }),
          ),
        );
        const context = yield* Layer.build(layer);
        const reactor = yield* Effect.service(OrchestrationReactor).pipe(
          Effect.provideContext(context),
        );
        yield* reactor.start();

        expect(started).toEqual([
          "provider-runtime-ingestion",
          "provider-command-reactor",
          "checkpoint-reactor",
          "product-workflow-reactor",
          "implementation-workflow-reactor",
          "app-review-workflow-reactor",
          "preview-lifecycle-reactor",
          "thread-deletion-reactor",
          "thread-pull-request-reactor",
          "thread-settlement-reactor",
          "pull-request-sync-reactor",
          "agent-awareness-relay",
        ]);

        yield* reactor.drainPendingProviderCommands;
        yield* reactor.reconcilePendingProviderCommands;
        expect(started).toEqual([
          "provider-runtime-ingestion",
          "provider-command-reactor",
          "checkpoint-reactor",
          "product-workflow-reactor",
          "implementation-workflow-reactor",
          "app-review-workflow-reactor",
          "preview-lifecycle-reactor",
          "thread-deletion-reactor",
          "thread-pull-request-reactor",
          "thread-settlement-reactor",
          "pull-request-sync-reactor",
          "agent-awareness-relay",
          "provider-command-replay",
          "provider-command-drain",
          "app-review-workflow-reconcile",
          "app-review-workflow-flush",
          "implementation-workflow-reconcile",
          "implementation-workflow-flush",
          "product-workflow-reconcile",
          "product-workflow-flush",
          "provider-command-replay",
          "provider-command-drain",
          "workflow-shell-cleanup",
        ]);
      }),
  );
});
