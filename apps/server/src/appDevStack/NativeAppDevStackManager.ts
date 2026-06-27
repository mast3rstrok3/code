import {
  type AppDevStack,
  type AppDevStackAutoCreateInput,
  type AppDevStackAutoCreateResult,
  type AppDevStackBackendStatus,
  type AppDevStackByWorktreeResult,
  type AppDevStackDeleteResult,
  AppDevStackError,
  type AppDevStackGetPodLogsInput,
  type AppDevStackGetPodLogsResult,
  type AppDevStackGetInput,
  type AppDevStackListPodsInput,
  type AppDevStackListPodsResult,
  type AppDevStackListInput,
  type AppDevStackListResult,
  type AppDevStackPod,
  type AppDevStackPodContainer,
  type AppDevStackService,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import type { NativeAppDevStackConfig } from "../config.ts";

const NATIVE_USER_ID = "00000000-0000-0000-0000-000000000000";
const DEFAULT_LOG_TAIL_LINES = 300;

interface KubectlDeploymentList {
  readonly items?: ReadonlyArray<{
    readonly metadata?: {
      readonly name?: string;
    };
    readonly spec?: {
      readonly replicas?: number;
    };
    readonly status?: {
      readonly availableReplicas?: number;
      readonly readyReplicas?: number;
      readonly replicas?: number;
    };
  }>;
}

interface KubectlNamespace {
  readonly metadata?: {
    readonly creationTimestamp?: string;
  };
}

interface KubectlPodList {
  readonly items?: ReadonlyArray<KubectlPod>;
}

interface KubectlPod {
  readonly metadata?: {
    readonly name?: string;
    readonly creationTimestamp?: string;
    readonly ownerReferences?: ReadonlyArray<{
      readonly kind?: string;
      readonly name?: string;
    }>;
  };
  readonly spec?: {
    readonly containers?: ReadonlyArray<{
      readonly name?: string;
    }>;
    readonly nodeName?: string;
  };
  readonly status?: {
    readonly phase?: string;
    readonly containerStatuses?: ReadonlyArray<KubectlContainerStatus>;
  };
}

interface KubectlContainerStatus {
  readonly name?: string;
  readonly ready?: boolean;
  readonly restartCount?: number;
  readonly state?: {
    readonly waiting?: {
      readonly reason?: string;
    };
    readonly running?: Record<string, unknown>;
    readonly terminated?: {
      readonly reason?: string;
    };
  };
}

export type KubectlRunner = (args: ReadonlyArray<string>) => Promise<string>;

export interface NativeAppDevStackService {
  readonly status: Effect.Effect<AppDevStackBackendStatus>;
  readonly list: (
    input: AppDevStackListInput,
  ) => Effect.Effect<AppDevStackListResult, AppDevStackError>;
  readonly getByWorktree: (input: {
    readonly worktreePath: string;
  }) => Effect.Effect<AppDevStackByWorktreeResult, AppDevStackError>;
  readonly get: (input: AppDevStackGetInput) => Effect.Effect<AppDevStack, AppDevStackError>;
  readonly autoCreate: (
    input: AppDevStackAutoCreateInput,
  ) => Effect.Effect<AppDevStackAutoCreateResult, AppDevStackError>;
  readonly stop: (input: AppDevStackGetInput) => Effect.Effect<AppDevStack, AppDevStackError>;
  readonly delete: (
    input: AppDevStackGetInput,
  ) => Effect.Effect<AppDevStackDeleteResult, AppDevStackError>;
  readonly listPods: (
    input: AppDevStackListPodsInput,
  ) => Effect.Effect<AppDevStackListPodsResult, AppDevStackError>;
  readonly getPodLogs: (
    input: AppDevStackGetPodLogsInput,
  ) => Effect.Effect<AppDevStackGetPodLogsResult, AppDevStackError>;
}

const collectProcessOutput = <E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (acc, chunk) => acc + chunk,
    ),
  );

export const makeKubectlRunner =
  (
    kubectlPath: string,
    spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  ): KubectlRunner =>
  async (args) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const child = yield* spawner.spawn(ChildProcess.make(kubectlPath, [...args]));
        const [stdout, stderr, exitCode] = yield* Effect.all(
          [
            collectProcessOutput(child.stdout),
            collectProcessOutput(child.stderr),
            child.exitCode.pipe(Effect.map(Number)),
          ],
          { concurrency: "unbounded" },
        );
        if (exitCode !== 0) {
          throw new Error(
            stderr.trim() || `kubectl ${args.join(" ")} exited with status ${String(exitCode)}.`,
          );
        }
        return stdout;
      }).pipe(Effect.scoped, Effect.timeout(Duration.seconds(30))),
    );

const parseJson = <Value>(raw: string): Value => JSON.parse(raw) as Value;

const normalizePath = (path: string) => path.replace(/\/+$/u, "");

const isNotFound = (cause: unknown) =>
  cause instanceof Error &&
  (cause.message.includes("NotFound") ||
    cause.message.includes("not found") ||
    cause.message.includes("namespaces") ||
    cause.message.includes("Namespace"));

const previewUrlForService = (config: NativeAppDevStackConfig, name: string) => {
  switch (name) {
    case "frontend":
      return config.frontendUrl;
    case "backend":
      return config.backendUrl;
    case "keycloak":
      return config.keycloakUrl;
    case "minio":
      return config.minioUrl;
    default:
      return undefined;
  }
};

const serviceOrder = (name: string) => {
  const order = ["frontend", "backend", "keycloak", "postgres", "redis", "minio", "codex-runner"];
  const index = order.indexOf(name);
  return index === -1 ? order.length : index;
};

const readNamespace = async (
  config: NativeAppDevStackConfig,
  runKubectl: KubectlRunner,
): Promise<KubectlNamespace | null> => {
  try {
    return parseJson<KubectlNamespace>(
      await runKubectl(["get", "namespace", config.namespace, "-o", "json"]),
    );
  } catch (cause) {
    if (isNotFound(cause)) return null;
    throw cause;
  }
};

const readDeployments = async (
  config: NativeAppDevStackConfig,
  runKubectl: KubectlRunner,
): Promise<KubectlDeploymentList> => {
  try {
    return parseJson<KubectlDeploymentList>(
      await runKubectl(["-n", config.namespace, "get", "deployments", "-o", "json"]),
    );
  } catch (cause) {
    if (isNotFound(cause)) return { items: [] };
    throw cause;
  }
};

const readPodList = async (
  config: NativeAppDevStackConfig,
  runKubectl: KubectlRunner,
): Promise<KubectlPodList> => {
  try {
    return parseJson<KubectlPodList>(
      await runKubectl(["-n", config.namespace, "get", "pods", "-o", "json"]),
    );
  } catch (cause) {
    if (isNotFound(cause)) return { items: [] };
    throw cause;
  }
};

const containerState = (status: KubectlContainerStatus | undefined): string | null => {
  if (status?.state?.waiting !== undefined) {
    return status.state.waiting.reason ?? "waiting";
  }
  if (status?.state?.running !== undefined) {
    return "running";
  }
  if (status?.state?.terminated !== undefined) {
    return status.state.terminated.reason ?? "terminated";
  }
  return null;
};

const buildPodContainer = (
  container: { readonly name?: string },
  statusByName: ReadonlyMap<string, KubectlContainerStatus>,
): AppDevStackPodContainer | null => {
  const name = container.name?.trim();
  if (!name) return null;
  const status = statusByName.get(name);
  return {
    name,
    ready: status?.ready === true,
    restartCount: Math.max(0, status?.restartCount ?? 0),
    state: containerState(status),
  };
};

const buildPods = (podList: KubectlPodList): Array<AppDevStackPod> =>
  (podList.items ?? [])
    .flatMap((pod) => {
      const name = pod.metadata?.name?.trim();
      if (!name) return [];
      const statuses = pod.status?.containerStatuses ?? [];
      const statusByName = new Map<string, KubectlContainerStatus>();
      for (const status of statuses) {
        const statusName = status.name?.trim();
        if (statusName) statusByName.set(statusName, status);
      }
      const containers = (pod.spec?.containers ?? [])
        .flatMap((container) => {
          const record = buildPodContainer(container, statusByName);
          return record === null ? [] : [record];
        })
        .sort((left, right) => left.name.localeCompare(right.name));
      const readyContainerCount = containers.filter((container) => container.ready).length;
      const restartCount = containers.reduce(
        (total, container) => total + container.restartCount,
        0,
      );
      const owner = pod.metadata?.ownerReferences?.[0];
      return [
        {
          name,
          phase: pod.status?.phase?.trim() || "Unknown",
          readyContainerCount,
          totalContainerCount: containers.length,
          restartCount,
          createdAt: pod.metadata?.creationTimestamp ?? null,
          nodeName: pod.spec?.nodeName ?? null,
          ownerKind: owner?.kind ?? null,
          ownerName: owner?.name ?? null,
          containers,
        },
      ];
    })
    .sort((left, right) => left.name.localeCompare(right.name));

const readPods = async (
  config: NativeAppDevStackConfig,
  runKubectl: KubectlRunner,
): Promise<Array<AppDevStackPod>> => buildPods(await readPodList(config, runKubectl));

const findPodForLogs = async (
  config: NativeAppDevStackConfig,
  runKubectl: KubectlRunner,
  podName: string,
  containerName: string | null | undefined,
) => {
  const pods = await readPods(config, runKubectl);
  const pod = pods.find((item) => item.name === podName);
  if (pod === undefined) {
    throw new Error(`Pod "${podName}" was not found in namespace "${config.namespace}".`);
  }
  const trimmedContainerName = containerName?.trim() || null;
  const selectedContainer =
    trimmedContainerName === null
      ? (pod.containers[0]?.name ?? null)
      : (pod.containers.find((container) => container.name === trimmedContainerName)?.name ?? null);
  if (trimmedContainerName !== null && selectedContainer === null) {
    throw new Error(
      `Container "${trimmedContainerName}" was not found in pod "${podName}" in namespace "${config.namespace}".`,
    );
  }
  return { pod, containerName: selectedContainer };
};

const normalizeTailLines = (tailLines: number | undefined): number =>
  tailLines === undefined || !Number.isFinite(tailLines)
    ? DEFAULT_LOG_TAIL_LINES
    : Math.min(5_000, Math.max(1, Math.trunc(tailLines)));

const buildStack = async (
  config: NativeAppDevStackConfig,
  runKubectl: KubectlRunner,
): Promise<AppDevStack> => {
  const namespace = await readNamespace(config, runKubectl);
  const now = DateTime.formatIso(DateTime.nowUnsafe());
  if (namespace === null) {
    return {
      id: config.id,
      uuid: config.id,
      userId: NATIVE_USER_ID,
      worktreePath: config.worktreePath,
      composePath: config.composePath,
      displayName: config.displayName,
      displaySlug: config.displaySlug ?? null,
      repoName: config.repoName ?? null,
      branchName: config.branchName ?? null,
      description: null,
      status: "stopped",
      namespace: config.namespace,
      services: null,
      serviceCount: 0,
      selectedServices: null,
      lastError: null,
      errorCount: 0,
      createdAt: now,
      updatedAt: now,
      lastStartedAt: null,
      lastStoppedAt: now,
      previewUrls: null,
    };
  }

  const deployments = await readDeployments(config, runKubectl);
  const services: Array<AppDevStackService> = (deployments.items ?? [])
    .map((deployment) => {
      const name = deployment.metadata?.name ?? "unknown";
      const desired = deployment.spec?.replicas ?? 1;
      const available = deployment.status?.availableReplicas ?? 0;
      const ready = deployment.status?.readyReplicas ?? 0;
      const stopped = desired === 0;
      const running = desired > 0 && available >= desired && ready >= desired;
      return {
        name,
        status: stopped ? "stopped" : running ? "running" : "starting",
        health: running ? "healthy" : stopped ? "unknown" : "starting",
        previewUrl: previewUrlForService(config, name) ?? null,
      };
    })
    .sort((left, right) => serviceOrder(left.name) - serviceOrder(right.name));
  const hasRunningDesired = services.some((service) => service.status !== "stopped");
  const allRunning =
    services.length > 0 && services.every((service) => service.status === "running");
  const status =
    services.length === 0 || !hasRunningDesired ? "stopped" : allRunning ? "running" : "starting";
  const previewUrls = Object.fromEntries(
    services
      .filter((service) => service.previewUrl !== null && service.previewUrl !== undefined)
      .map((service) => [service.name, service.previewUrl as string]),
  );

  return {
    id: config.id,
    uuid: config.id,
    userId: NATIVE_USER_ID,
    worktreePath: config.worktreePath,
    composePath: config.composePath,
    displayName: config.displayName,
    displaySlug: config.displaySlug ?? null,
    repoName: config.repoName ?? null,
    branchName: config.branchName ?? null,
    description: null,
    status,
    namespace: config.namespace,
    services,
    serviceCount: services.length,
    selectedServices: null,
    lastError: null,
    errorCount: 0,
    createdAt: namespace.metadata?.creationTimestamp ?? now,
    updatedAt: now,
    lastStartedAt: status === "stopped" ? null : now,
    lastStoppedAt: status === "stopped" ? now : null,
    previewUrls: Object.keys(previewUrls).length > 0 ? previewUrls : null,
  };
};

const appDevStackError = (operation: string, cause: unknown) =>
  new AppDevStackError({
    operation,
    reason: "request_failed",
    message: cause instanceof Error ? cause.message : `Native app-dev stack ${operation} failed.`,
    cause,
  });

const nativeOperation = <Value>(
  operation: string,
  run: () => Promise<Value>,
): Effect.Effect<Value, AppDevStackError> =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => appDevStackError(operation, cause),
  });

const ensureKnownStack = (
  config: NativeAppDevStackConfig,
  operation: string,
  stackId: string,
): Effect.Effect<void, AppDevStackError> =>
  stackId === config.id || stackId === config.namespace
    ? Effect.void
    : Effect.fail(
        new AppDevStackError({
          operation,
          reason: "request_failed",
          status: 404,
          message: `Native app-dev stack "${stackId}" is not configured.`,
        }),
      );

export const makeNativeAppDevStackService = (
  config: NativeAppDevStackConfig,
  runKubectl: KubectlRunner,
): NativeAppDevStackService => {
  const readStack = (operation: string) =>
    nativeOperation(operation, () => buildStack(config, runKubectl));

  return {
    status: Effect.succeed({
      enabled: true,
      backendUrl: `native://${config.namespace}`,
    }),
    list: () => readStack("list").pipe(Effect.map((stack) => ({ stacks: [stack] }))),
    getByWorktree: (input) =>
      readStack("getByWorktree").pipe(
        Effect.map((stack) =>
          normalizePath(input.worktreePath) === normalizePath(config.worktreePath)
            ? {
                stack,
                frontendUrl: config.frontendUrl ?? null,
                frontendServiceName: config.frontendUrl ? "frontend" : null,
              }
            : { stack: null, frontendUrl: null, frontendServiceName: null },
        ),
      ),
    get: (input) =>
      ensureKnownStack(config, "get", input.stackId).pipe(Effect.flatMap(() => readStack("get"))),
    autoCreate: (input) =>
      nativeOperation("autoCreate", async () => {
        if (normalizePath(input.worktreePath) !== normalizePath(config.worktreePath)) {
          throw new Error(
            `Native app-dev stack only manages ${config.worktreePath}; received ${input.worktreePath}.`,
          );
        }
        const namespace = await readNamespace(config, runKubectl);
        if (namespace === null) {
          throw new Error(
            `Native app-dev stack namespace "${config.namespace}" does not exist. Restore the Kubernetes stack before starting it from Code.`,
          );
        }
        await runKubectl(["-n", config.namespace, "scale", "deployment", "--all", "--replicas=1"]);
        const stack = await buildStack(config, runKubectl);
        return {
          stack,
          created: false,
          frontendUrl: config.frontendUrl ?? null,
          frontendServiceName: config.frontendUrl ? "frontend" : null,
        };
      }),
    stop: (input) =>
      ensureKnownStack(config, "stop", input.stackId).pipe(
        Effect.flatMap(() =>
          nativeOperation("stop", async () => {
            await runKubectl([
              "-n",
              config.namespace,
              "scale",
              "deployment",
              "--all",
              "--replicas=0",
            ]);
            return buildStack(config, runKubectl);
          }),
        ),
      ),
    delete: (input) =>
      ensureKnownStack(config, "delete", input.stackId).pipe(
        Effect.flatMap(() =>
          nativeOperation("delete", async () => {
            await runKubectl(["delete", "namespace", config.namespace, "--ignore-not-found"]);
            return { deleted: true };
          }),
        ),
      ),
    listPods: (input) =>
      ensureKnownStack(config, "listPods", input.stackId).pipe(
        Effect.flatMap(() =>
          nativeOperation("listPods", async () => ({
            stackId: config.id,
            namespace: config.namespace,
            pods: await readPods(config, runKubectl),
          })),
        ),
      ),
    getPodLogs: (input) =>
      ensureKnownStack(config, "getPodLogs", input.stackId).pipe(
        Effect.flatMap(() =>
          nativeOperation("getPodLogs", async () => {
            const { pod, containerName } = await findPodForLogs(
              config,
              runKubectl,
              input.podName,
              input.containerName,
            );
            const tailLines = normalizeTailLines(input.tailLines);
            const logArgs = [
              "-n",
              config.namespace,
              "logs",
              pod.name,
              ...(containerName === null ? [] : ["-c", containerName]),
              `--tail=${String(tailLines)}`,
            ];
            return {
              stackId: config.id,
              namespace: config.namespace,
              podName: pod.name,
              containerName,
              tailLines,
              logs: await runKubectl(logArgs),
              fetchedAt: DateTime.formatIso(DateTime.nowUnsafe()),
            };
          }),
        ),
      ),
  };
};
