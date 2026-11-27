import { WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcSubscriptionAtomFamily } from "./runtime.ts";

export function createAppReviewEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    /** The thread's App Reviews, oldest first; subscribed only while a surface shows them. */
    thread: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "app-review:thread",
      tag: WS_METHODS.appReviewSubscribeThread,
      idleTtlMs: 0,
    }),
  };
}
