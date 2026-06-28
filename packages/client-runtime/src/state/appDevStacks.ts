import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";

export function createAppDevStackEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const lifecycleScheduler = createAtomCommandScheduler();
  const stackLifecycleConcurrency = {
    mode: "serial" as const,
    key: ({
      environmentId,
      input,
    }: {
      readonly environmentId: string;
      readonly input: { readonly stackId?: string; readonly worktreePath?: string };
    }) => JSON.stringify([environmentId, input.stackId ?? input.worktreePath ?? "unknown"]),
  };

  return {
    status: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:app-dev-stack:status",
      tag: WS_METHODS.appDevStackStatus,
      staleTimeMs: 30_000,
    }),
    list: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:app-dev-stack:list",
      tag: WS_METHODS.appDevStackList,
      staleTimeMs: 5_000,
      idleTtlMs: 60_000,
    }),
    byWorktree: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:app-dev-stack:by-worktree",
      tag: WS_METHODS.appDevStackGetByWorktree,
      staleTimeMs: 5_000,
      idleTtlMs: 60_000,
    }),
    get: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:app-dev-stack:get",
      tag: WS_METHODS.appDevStackGet,
      staleTimeMs: 5_000,
      idleTtlMs: 60_000,
    }),
    autoCreate: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:app-dev-stack:auto-create",
      tag: WS_METHODS.appDevStackAutoCreate,
      scheduler: lifecycleScheduler,
      concurrency: stackLifecycleConcurrency,
    }),
    stop: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:app-dev-stack:stop",
      tag: WS_METHODS.appDevStackStop,
      scheduler: lifecycleScheduler,
      concurrency: stackLifecycleConcurrency,
    }),
    delete: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:app-dev-stack:delete",
      tag: WS_METHODS.appDevStackDelete,
      scheduler: lifecycleScheduler,
      concurrency: stackLifecycleConcurrency,
    }),
    listPods: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:app-dev-stack:list-pods",
      tag: WS_METHODS.appDevStackListPods,
      staleTimeMs: 3_000,
      idleTtlMs: 30_000,
    }),
    getPodLogs: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:app-dev-stack:get-pod-logs",
      tag: WS_METHODS.appDevStackGetPodLogs,
      staleTimeMs: 3_000,
      idleTtlMs: 30_000,
    }),
    getStackPodLogs: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:app-dev-stack:get-stack-pod-logs",
      tag: WS_METHODS.appDevStackGetStackPodLogs,
      staleTimeMs: 3_000,
      idleTtlMs: 30_000,
    }),
  };
}
