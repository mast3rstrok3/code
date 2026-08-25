import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  OrchestrationReactor,
  type OrchestrationReactorShape,
} from "../Services/OrchestrationReactor.ts";
import { CheckpointReactor } from "../Services/CheckpointReactor.ts";
import { ImplementationWorkflowReactor } from "../Services/ImplementationWorkflowReactor.ts";
import { AppReviewWorkflowReactor } from "../Services/AppReviewWorkflowReactor.ts";
import { ProviderCommandReactor } from "../Services/ProviderCommandReactor.ts";
import { ProviderRuntimeIngestionService } from "../Services/ProviderRuntimeIngestion.ts";
import { ProductWorkflowReactor } from "../Services/ProductWorkflowReactor.ts";
import { PreviewLifecycleReactor } from "../Services/PreviewLifecycleReactor.ts";
import { ThreadDeletionReactor } from "../Services/ThreadDeletionReactor.ts";
import * as AgentAwarenessRelay from "../../relay/AgentAwarenessRelay.ts";

export const makeOrchestrationReactor = Effect.gen(function* () {
  const providerRuntimeIngestion = yield* ProviderRuntimeIngestionService;
  const providerCommandReactor = yield* ProviderCommandReactor;
  const checkpointReactor = yield* CheckpointReactor;
  const productWorkflowReactor = yield* ProductWorkflowReactor;
  const implementationWorkflowReactor = yield* ImplementationWorkflowReactor;
  const appReviewWorkflowReactor = yield* AppReviewWorkflowReactor;
  const previewLifecycleReactor = yield* PreviewLifecycleReactor;
  const threadDeletionReactor = yield* ThreadDeletionReactor;
  const agentAwarenessRelay = yield* AgentAwarenessRelay.AgentAwarenessRelay;

  const drainPendingProviderCommands = Effect.gen(function* () {
    yield* providerCommandReactor.replayPendingWorkflowTurnStarts;
    yield* providerCommandReactor.drain;
  });

  const reconcilePendingProviderCommands = Effect.gen(function* () {
    // Stale-turn recovery has settled before this phase. Nested App Review
    // settles first so parent ticket recovery sees its durable result.
    yield* appReviewWorkflowReactor.reconcile();
    yield* appReviewWorkflowReactor.flush ?? appReviewWorkflowReactor.drain;
    yield* implementationWorkflowReactor.reconcileStartup();
    yield* implementationWorkflowReactor.flush ?? implementationWorkflowReactor.drain;
    yield* productWorkflowReactor.reconcileStartup();
    yield* productWorkflowReactor.flush ?? productWorkflowReactor.drain;
    yield* providerCommandReactor.replayPendingWorkflowTurnStarts;
    yield* providerCommandReactor.drain;
    yield* threadDeletionReactor.cleanupEmptyWorkflowShells;
  });

  const start: OrchestrationReactorShape["start"] = Effect.fn("start")(function* () {
    yield* providerRuntimeIngestion.start();
    yield* providerCommandReactor.start();
    yield* checkpointReactor.start();
    yield* productWorkflowReactor.start();
    yield* implementationWorkflowReactor.start();
    yield* appReviewWorkflowReactor.start();
    yield* previewLifecycleReactor.start();
    yield* threadDeletionReactor.start();
    yield* agentAwarenessRelay.start();
  });

  const drainForShutdown = Effect.gen(function* () {
    yield* providerRuntimeIngestion.drain;
    yield* appReviewWorkflowReactor.flush ?? appReviewWorkflowReactor.drain;
    yield* implementationWorkflowReactor.flush ?? implementationWorkflowReactor.drain;
    yield* productWorkflowReactor.flush ?? productWorkflowReactor.drain;
    yield* providerCommandReactor.drain;
    yield* checkpointReactor.drain;
    yield* providerRuntimeIngestion.drain;
    yield* checkpointReactor.drain;
  });

  return {
    start,
    drainPendingProviderCommands,
    reconcilePendingProviderCommands,
    drainForShutdown,
  } satisfies OrchestrationReactorShape;
});

export const OrchestrationReactorLive = Layer.effect(
  OrchestrationReactor,
  makeOrchestrationReactor,
);
