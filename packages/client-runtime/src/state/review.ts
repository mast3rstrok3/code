import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

export function createReviewEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    diffPreview: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:review:diff-preview",
      tag: WS_METHODS.reviewGetDiffPreview,
      staleTimeMs: 5_000,
    }),
    appendDevReviewReplayEvents: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:review:dev-review-replay-append-events",
      tag: WS_METHODS.reviewDevReviewReplayAppendEvents,
    }),
    getDevReviewReplay: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:review:dev-review-replay-get",
      tag: WS_METHODS.reviewDevReviewReplayGet,
      staleTimeMs: 30_000,
    }),
  };
}
