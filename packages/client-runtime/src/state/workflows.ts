import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export function createWorkflowEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    snapshot: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "workflows:snapshot",
      tag: WS_METHODS.workflowSubscribe,
    }),
    thread: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "workflows:thread",
      tag: WS_METHODS.workflowGetThread,
      idleTtlMs: 0,
    }),
    dispatchCommand: createEnvironmentRpcCommand(runtime, {
      label: "workflows:dispatch",
      tag: WS_METHODS.workflowDispatchCommand,
    }),
    artifacts: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "workflows:artifacts",
      tag: WS_METHODS.workflowArtifactsGet,
      staleTimeMs: 0,
    }),
  };
}
