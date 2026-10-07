import * as Layer from "effect/Layer";
import { OrchestrationLayerLive } from "./runtimeLayer.ts";
import { OrchestrationReactorLive } from "./Layers/OrchestrationReactor.ts";
import { ProviderRuntimeIngestionLive } from "./Layers/ProviderRuntimeIngestion.ts";
import { ImplementationWorkflowReactorLive } from "./Layers/ImplementationWorkflowReactor.ts";
import { AppReviewWorkflowReactorLive } from "./Layers/AppReviewWorkflowReactor.ts";
import { ProductWorkflowReactorLive } from "./Layers/ProductWorkflowReactor.ts";
import { PreviewLifecycleReactorLive } from "./Layers/PreviewLifecycleReactor.ts";
import * as AppStackLifecycleReactor from "./AppStackLifecycleReactor.ts";
import * as WorkflowRuntimeBridge from "./WorkflowRuntimeBridge.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as WorkflowUserInputBroker from "../mcp/WorkflowUserInputBroker.ts";

const layerIngestion = ProviderRuntimeIngestionLive.pipe(
  Layer.provideMerge(WorkflowRuntimeBridge.layerProviderEvents),
  Layer.provideMerge(OrchestrationLayerLive),
);

export const layer = OrchestrationReactorLive.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      WorkflowRuntimeBridge.layer.pipe(Layer.provide(layerIngestion)),
      ImplementationWorkflowReactorLive.pipe(Layer.provide(ProjectSetupScriptRunner.layer)),
      AppReviewWorkflowReactorLive.pipe(Layer.provide(ProcessRunner.layer)),
      ProductWorkflowReactorLive,
      PreviewLifecycleReactorLive,
      AppStackLifecycleReactor.layer,
    ),
  ),
  Layer.provideMerge(OrchestrationLayerLive),
  Layer.provideMerge(WorkflowUserInputBroker.layer),
);
