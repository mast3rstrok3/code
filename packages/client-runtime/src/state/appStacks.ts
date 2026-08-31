import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";

export function createAppStackEnvironmentAtoms<R, E>(
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
      label: "environment-data:app-stack:status",
      tag: WS_METHODS.appStackStatus,
      staleTimeMs: 30_000,
    }),
    list: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:app-stack:list",
      tag: WS_METHODS.appStackList,
      staleTimeMs: 5_000,
      idleTtlMs: 60_000,
    }),
    byWorktree: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:app-stack:by-worktree",
      tag: WS_METHODS.appStackGetByWorktree,
      staleTimeMs: 5_000,
      idleTtlMs: 60_000,
    }),
    get: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:app-stack:get",
      tag: WS_METHODS.appStackGet,
      staleTimeMs: 5_000,
      idleTtlMs: 60_000,
    }),
    autoCreate: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:app-stack:auto-create",
      tag: WS_METHODS.appStackAutoCreate,
      scheduler: lifecycleScheduler,
      concurrency: stackLifecycleConcurrency,
    }),
    stop: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:app-stack:stop",
      tag: WS_METHODS.appStackStop,
      scheduler: lifecycleScheduler,
      concurrency: stackLifecycleConcurrency,
    }),
    setProtected: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:app-stack:set-protected",
      tag: WS_METHODS.appStackSetProtected,
      scheduler: lifecycleScheduler,
      concurrency: stackLifecycleConcurrency,
    }),
    restart: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:app-stack:restart",
      tag: WS_METHODS.appStackRestart,
      scheduler: lifecycleScheduler,
      concurrency: stackLifecycleConcurrency,
    }),
    delete: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:app-stack:delete",
      tag: WS_METHODS.appStackDelete,
      scheduler: lifecycleScheduler,
      concurrency: stackLifecycleConcurrency,
    }),
    listPods: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:app-stack:list-pods",
      tag: WS_METHODS.appStackListPods,
      staleTimeMs: 3_000,
      idleTtlMs: 30_000,
    }),
    getPodLogs: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:app-stack:get-pod-logs",
      tag: WS_METHODS.appStackGetPodLogs,
      staleTimeMs: 3_000,
      idleTtlMs: 30_000,
    }),
    getStackPodLogs: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:app-stack:get-stack-pod-logs",
      tag: WS_METHODS.appStackGetStackPodLogs,
      staleTimeMs: 3_000,
      idleTtlMs: 30_000,
    }),
    getAllStackPodLogs: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:app-stack:get-all-stack-pod-logs",
      tag: WS_METHODS.appStackGetAllStackPodLogs,
      staleTimeMs: 3_000,
      idleTtlMs: 30_000,
    }),
  };
}
