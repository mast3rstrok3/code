import {
  type AppDevStack,
  type AppDevStackAutoCreateInput,
  type AppDevStackAutoCreateResult,
  type AppDevStackBackendStatus,
  type AppDevStackByWorktreeResult,
  type AppDevStackDeleteResult,
  AppDevStackError,
  type AppDevStackGetInput,
  type AppDevStackListInput,
  type AppDevStackListResult,
  type AppDevStackService,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import type { NativeAppDevStackConfig } from "../config.ts";

const NATIVE_USER_ID = "00000000-0000-0000-0000-000000000000";

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
  };
};
