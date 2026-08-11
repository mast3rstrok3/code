import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  OrchestrationReactor,
  type OrchestrationReactorShape,
} from "../Services/OrchestrationReactor.ts";
import { CheckpointReactor } from "../Services/CheckpointReactor.ts";
import { ImplementationWorkflowReactor } from "../Services/ImplementationWorkflowReactor.ts";
import { DevReviewWorkflowReactor } from "../Services/DevReviewWorkflowReactor.ts";
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
  const devReviewWorkflowReactor = yield* DevReviewWorkflowReactor;
  const previewLifecycleReactor = yield* PreviewLifecycleReactor;
  const threadDeletionReactor = yield* ThreadDeletionReactor;
  const agentAwarenessRelay = yield* AgentAwarenessRelay.AgentAwarenessRelay;

  const start: OrchestrationReactorShape["start"] = Effect.fn("start")(function* () {
    yield* providerRuntimeIngestion.start();
    yield* providerCommandReactor.start();
    yield* checkpointReactor.start();
    yield* productWorkflowReactor.start();
    yield* implementationWorkflowReactor.start();
    yield* devReviewWorkflowReactor.start();
    yield* previewLifecycleReactor.start();
    yield* threadDeletionReactor.start();
    yield* agentAwarenessRelay.start();
  });

  return {
    start,
  } satisfies OrchestrationReactorShape;
});

export const OrchestrationReactorLive = Layer.effect(
  OrchestrationReactor,
  makeOrchestrationReactor,
);
