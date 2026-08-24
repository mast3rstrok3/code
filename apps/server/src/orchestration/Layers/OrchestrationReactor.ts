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

  const reconcilePendingProviderCommands = Effect.gen(function* () {
    // Restart recovery can enqueue workflow events that create continuation
    // turns. Materialize those turns before replaying provider starts so the
    // server does not report ready with recovered work still unlaunched.
    yield* productWorkflowReactor.drain;
    yield* implementationWorkflowReactor.drain;
    yield* appReviewWorkflowReactor.drain;
    yield* providerCommandReactor.replayPendingWorkflowTurnStarts;
    yield* providerCommandReactor.drain;
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
    // Workflow reactors can persist new turn starts while their own startup
    // reconciliation runs. Sweep once more after every subscriber is active,
    // then wait for provider-side launch work before startup can report ready.
    yield* reconcilePendingProviderCommands;
  });

  return {
    start,
    reconcilePendingProviderCommands,
  } satisfies OrchestrationReactorShape;
});

export const OrchestrationReactorLive = Layer.effect(
  OrchestrationReactor,
  makeOrchestrationReactor,
);
