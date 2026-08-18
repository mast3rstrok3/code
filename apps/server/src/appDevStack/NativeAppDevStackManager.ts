import {
  type AppDevStack,
  type AppDevStackAutoCreateInput,
  type AppDevStackAutoCreateResult,
  type AppDevStackBackendStatus,
  type AppDevStackByWorktreeResult,
  type AppDevStackDeleteResult,
  AppDevStackError,
  type AppDevStackGetAllStackPodLogsInput,
  type AppDevStackGetAllStackPodLogsResult,
  type AppDevStackGetPodLogsInput,
  type AppDevStackGetPodLogsResult,
  type AppDevStackGetStackPodLogsInput,
  type AppDevStackGetStackPodLogsResult,
  type AppDevStackGetInput,
  type AppDevStackListPodsInput,
  type AppDevStackListPodsResult,
  type AppDevStackListInput,
  type AppDevStackListResult,
  type AppDevStackPod,
  type AppDevStackPodContainer,
  type AppDevStackPodLogEntry,
  type AppDevStackService,
} from "@t3tools/contracts";
import {
  appDevStackPreviewUrlForService,
  deriveAppDevStackNamespaceFromPath,
  normalizeKubernetesNamespace,
} from "@t3tools/shared/appDevStack";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import type { NativeAppDevStackConfig } from "../config.ts";
import {
  provisionNativeAppDevStack,
  type NativeCommandRunner,
} from "./nativeAppDevStackProvisioning.ts";

const NATIVE_USER_ID = "00000000-0000-0000-0000-000000000000";
const DEFAULT_LOG_TAIL_LINES = 300;
const POD_LOG_FETCH_CONCURRENCY = 4;
const STACK_LOG_FETCH_CONCURRENCY = 3;
const APP_DEV_STACK_COMPONENT_LABEL = "cortex.ai/component";
const APP_DEV_STACK_COMPONENT_VALUE = "app-dev-stack";
const APP_DEV_STACK_STACK_ID_LABEL = "cortex.ai/stack-id";
const APP_DEV_STACK_MANAGED_BY_LABEL = "app.kubernetes.io/managed-by";

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
    readonly name?: string;
    readonly creationTimestamp?: string;
    readonly deletionTimestamp?: string;
    readonly labels?: Record<string, string>;
    readonly annotations?: Record<string, string>;
  };
  readonly status?: {
    readonly phase?: string;
  };
}

interface KubectlNamespaceList {
  readonly items?: ReadonlyArray<KubectlNamespace>;
}

interface KubectlPodList {
  readonly items?: ReadonlyArray<KubectlPod>;
}

interface KubectlPod {
  readonly metadata?: {
    readonly name?: string;
    readonly creationTimestamp?: string;
    readonly labels?: Record<string, string>;
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

interface KubectlIngressRouteList {
  readonly items?: ReadonlyArray<{
    readonly spec?: {
      readonly routes?: ReadonlyArray<{
        readonly match?: string;
        readonly services?: ReadonlyArray<{
          readonly name?: string;
        }>;
      }>;
    };
  }>;
}

interface KubectlIngressList {
  readonly items?: ReadonlyArray<{
    readonly spec?: {
      readonly defaultBackend?: {
        readonly service?: {
          readonly name?: string;
        };
      };
      readonly rules?: ReadonlyArray<{
        readonly host?: string;
        readonly http?: {
          readonly paths?: ReadonlyArray<{
            readonly backend?: {
              readonly service?: {
                readonly name?: string;
              };
            };
          }>;
        };
      }>;
    };
  }>;
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

interface ResolvedNativeAppDevStackConfig {
  readonly id: string;
  readonly namespace: string;
  readonly worktreePath: string;
  readonly composePath: string;
  readonly displayName: string;
  readonly displaySlug: string | undefined;
  readonly repoName: string | undefined;
  readonly branchName: string | undefined;
  readonly kubectlPath: string;
  readonly dockerPath: string;
  readonly buildctlPath: string;
  readonly imageBuilder: NativeAppDevStackConfig["imageBuilder"];
  readonly imageRegistry: string | undefined;
  readonly imagePushRegistry: string | undefined;
  readonly imageProject: string | undefined;
  readonly buildkitAddr: string | undefined;
  readonly buildkitDockerConfig: string | undefined;
  readonly buildkitDockerConfigsDir: string | undefined;
  readonly buildkitHarborCaCert: string | undefined;
  readonly frontendUrl: string | undefined;
  readonly backendUrl: string | undefined;
  readonly keycloakUrl: string | undefined;
  readonly minioUrl: string | undefined;
  readonly preferStackScopedUrls: boolean;
}

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
  readonly restart: (input: AppDevStackGetInput) => Effect.Effect<AppDevStack, AppDevStackError>;
  readonly delete: (
    input: AppDevStackGetInput,
  ) => Effect.Effect<AppDevStackDeleteResult, AppDevStackError>;
  readonly listPods: (
    input: AppDevStackListPodsInput,
  ) => Effect.Effect<AppDevStackListPodsResult, AppDevStackError>;
  readonly getPodLogs: (
    input: AppDevStackGetPodLogsInput,
  ) => Effect.Effect<AppDevStackGetPodLogsResult, AppDevStackError>;
  readonly getStackPodLogs: (
    input: AppDevStackGetStackPodLogsInput,
  ) => Effect.Effect<AppDevStackGetStackPodLogsResult, AppDevStackError>;
  readonly getAllStackPodLogs: (
    input: AppDevStackGetAllStackPodLogsInput,
  ) => Effect.Effect<AppDevStackGetAllStackPodLogsResult, AppDevStackError>;
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

export const makeNativeCommandRunner =
  (spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]): NativeCommandRunner =>
  async (command, args, options) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const child = yield* spawner.spawn(
          ChildProcess.make(command, [...args], {
            cwd: options?.cwd,
            ...(options?.env === undefined
              ? {}
              : { env: { ...process.env, ...options.env } as Record<string, string> }),
          }),
        );
        const [stdout, stderr, exitCode] = yield* Effect.all(
          [
            collectProcessOutput(child.stdout),
            collectProcessOutput(child.stderr),
            child.exitCode.pipe(Effect.map(Number)),
          ],
          { concurrency: "unbounded" },
        );
        if (exitCode !== 0) {
          const commandLine = [command, ...args].join(" ");
          throw new Error(
            stderr.trim() ||
              stdout.trim() ||
              `${commandLine} exited with status ${String(exitCode)}.`,
          );
        }
        return stdout;
      }).pipe(Effect.scoped, Effect.timeout(Duration.minutes(30))),
    );

const parseJson = <Value>(raw: string): Value => JSON.parse(raw) as Value;

const normalizePath = (path: string) => path.trim().replace(/[/\\]+$/u, "") || path.trim();

const pathBasename = (path: string) => {
  const normalized = normalizePath(path);
  const slashIndex = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  return slashIndex === -1 ? normalized : normalized.slice(slashIndex + 1);
};

const normalizeOptionalNamespace = (namespace: string | null | undefined) => {
  const trimmed = namespace?.trim();
  return trimmed ? normalizeKubernetesNamespace(trimmed) : undefined;
};

const optionalConfiguredUrls = (
  config: NativeAppDevStackConfig,
  namespace: string,
): Pick<
  ResolvedNativeAppDevStackConfig,
  "frontendUrl" | "backendUrl" | "keycloakUrl" | "minioUrl"
> =>
  config.namespace !== undefined && normalizeKubernetesNamespace(config.namespace) === namespace
    ? {
        frontendUrl: config.frontendUrl,
        backendUrl: config.backendUrl,
        keycloakUrl: config.keycloakUrl,
        minioUrl: config.minioUrl,
      }
    : {
        frontendUrl: undefined,
        backendUrl: undefined,
        keycloakUrl: undefined,
        minioUrl: undefined,
      };

const nonEmptyString = (value: string | null | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

const labelValue = (
  labels: Readonly<Record<string, string>> | undefined,
  key: string,
): string | undefined => nonEmptyString(labels?.[key]);

const annotationValue = (
  annotations: Readonly<Record<string, string>> | undefined,
  key: string,
): string | undefined => nonEmptyString(annotations?.[key]);

const displayNameFromNamespace = (namespace: string): string =>
  namespace.replace(/-dev$/u, "") || namespace;

const resolveNativeConfigForNamespace = (
  config: NativeAppDevStackConfig,
  namespace: KubectlNamespace,
): ResolvedNativeAppDevStackConfig | null => {
  const rawNamespace = namespace.metadata?.name;
  const normalizedNamespace = normalizeOptionalNamespace(rawNamespace);
  if (normalizedNamespace === undefined) return null;

  const labels = namespace.metadata?.labels;
  const annotations = namespace.metadata?.annotations;
  const stackId = labelValue(labels, APP_DEV_STACK_STACK_ID_LABEL) ?? normalizedNamespace;
  const repoName =
    annotationValue(annotations, "cortex.ai/repo-name") ??
    labelValue(labels, "cortex.ai/repo-name") ??
    displayNameFromNamespace(normalizedNamespace);
  const displayName =
    annotationValue(annotations, "cortex.ai/display-name") ??
    labelValue(labels, "cortex.ai/display-name") ??
    repoName;
  const worktreePath =
    annotationValue(annotations, "cortex.ai/worktree-path") ??
    labelValue(labels, "cortex.ai/worktree-path") ??
    `/app-dev-stacks/${normalizedNamespace}`;

  return {
    id: stackId,
    namespace: normalizedNamespace,
    worktreePath,
    composePath:
      annotationValue(annotations, "cortex.ai/compose-path") ??
      labelValue(labels, "cortex.ai/compose-path") ??
      config.composePath,
    displayName,
    displaySlug:
      annotationValue(annotations, "cortex.ai/display-slug") ??
      labelValue(labels, "cortex.ai/display-slug"),
    repoName,
    branchName:
      annotationValue(annotations, "cortex.ai/branch-name") ??
      labelValue(labels, "cortex.ai/branch-name"),
    kubectlPath: config.kubectlPath,
    dockerPath: config.dockerPath,
    buildctlPath: config.buildctlPath,
    imageBuilder: config.imageBuilder,
    imageRegistry: config.imageRegistry,
    imagePushRegistry: config.imagePushRegistry,
    imageProject: config.imageProject,
    buildkitAddr: config.buildkitAddr,
    buildkitDockerConfig: config.buildkitDockerConfig,
    buildkitDockerConfigsDir: config.buildkitDockerConfigsDir,
    buildkitHarborCaCert: config.buildkitHarborCaCert,
    preferStackScopedUrls:
      config.namespace === undefined ||
      normalizeKubernetesNamespace(config.namespace) !== normalizedNamespace,
    ...optionalConfiguredUrls(config, normalizedNamespace),
  };
};

const resolveNativeConfigForWorktree = (
  config: NativeAppDevStackConfig,
  input: {
    readonly worktreePath: string;
    readonly displayName?: string | null | undefined;
    readonly gitBranch?: string | null | undefined;
    readonly namespace?: string | null | undefined;
    readonly preferConfiguredNamespace?: boolean;
  },
): ResolvedNativeAppDevStackConfig => {
  const worktreePath = normalizePath(input.worktreePath);
  const configuredWorktreeMatches =
    config.worktreePath !== undefined &&
    normalizePath(config.worktreePath) === normalizePath(input.worktreePath);
  const configuredNamespace =
    configuredWorktreeMatches || input.preferConfiguredNamespace === true
      ? normalizeOptionalNamespace(config.namespace)
      : undefined;
  const namespace =
    normalizeOptionalNamespace(input.namespace) ??
    configuredNamespace ??
    deriveAppDevStackNamespaceFromPath(worktreePath);
  const repoName = pathBasename(worktreePath) || namespace.replace(/-dev$/u, "");
  const useConfiguredMetadata = configuredWorktreeMatches || configuredNamespace === namespace;
  const displayName =
    input.displayName?.trim() || (useConfiguredMetadata ? config.displayName : undefined);

  return {
    id: useConfiguredMetadata && config.id !== undefined ? config.id : namespace,
    namespace,
    worktreePath,
    composePath: config.composePath,
    displayName: displayName?.trim() || repoName,
    displaySlug: useConfiguredMetadata ? config.displaySlug : undefined,
    repoName: useConfiguredMetadata && config.repoName !== undefined ? config.repoName : repoName,
    branchName: input.gitBranch?.trim() || (useConfiguredMetadata ? config.branchName : undefined),
    kubectlPath: config.kubectlPath,
    dockerPath: config.dockerPath,
    buildctlPath: config.buildctlPath,
    imageBuilder: config.imageBuilder,
    imageRegistry: config.imageRegistry,
    imagePushRegistry: config.imagePushRegistry,
    imageProject: useConfiguredMetadata ? config.imageProject : undefined,
    buildkitAddr: config.buildkitAddr,
    buildkitDockerConfig: config.buildkitDockerConfig,
    buildkitDockerConfigsDir: config.buildkitDockerConfigsDir,
    buildkitHarborCaCert: config.buildkitHarborCaCert,
    preferStackScopedUrls: !useConfiguredMetadata,
    ...optionalConfiguredUrls(config, namespace),
  };
};

const resolveConfiguredNativeConfig = (
  config: NativeAppDevStackConfig,
): ResolvedNativeAppDevStackConfig | null => {
  if (config.worktreePath === undefined) return null;
  return resolveNativeConfigForWorktree(config, {
    worktreePath: config.worktreePath,
    displayName: config.displayName,
    gitBranch: config.branchName,
    namespace: config.namespace,
    preferConfiguredNamespace: true,
  });
};

const isNotFound = (cause: unknown) =>
  cause instanceof Error &&
  (cause.message.includes("NotFound") ||
    cause.message.includes("not found") ||
    cause.message.includes("namespaces") ||
    cause.message.includes("Namespace"));

const serviceLookupKey = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^-+|-+$/gu, "");

const previewUrlForService = (
  config: ResolvedNativeAppDevStackConfig,
  discoveredPreviewUrls: ReadonlyMap<string, string>,
  name: string,
): string | undefined => {
  const stackScopedUrl = appDevStackPreviewUrlForService({
    namespace: config.namespace,
    serviceName: name,
    frontendUrl: config.frontendUrl,
    backendUrl: config.backendUrl,
    keycloakUrl: config.keycloakUrl,
    minioUrl: config.minioUrl,
  });
  const discoveredUrl = discoveredPreviewUrls.get(serviceLookupKey(name));
  return config.preferStackScopedUrls
    ? (stackScopedUrl ?? discoveredUrl)
    : (discoveredUrl ?? stackScopedUrl ?? undefined);
};

const previewUrlFromHost = (host: string | null | undefined): string | null => {
  const trimmed = host?.trim();
  if (!trimmed) return null;
  return trimmed.includes("://") ? trimmed : `https://${trimmed}`;
};

const addPreviewUrl = (
  previewUrls: Map<string, string>,
  serviceName: string | null | undefined,
  url: string | null | undefined,
) => {
  const serviceKey =
    serviceName === undefined || serviceName === null ? "" : serviceLookupKey(serviceName);
  const previewUrl = url?.trim();
  if (!serviceKey || !previewUrl || previewUrls.has(serviceKey)) return;
  previewUrls.set(serviceKey, previewUrl);
};

const HOST_ARGUMENT_PATTERN = /Host\(([^)]*)\)/gu;
const QUOTED_HOST_PATTERN = /[`'"]([^`'"]+)[`'"]/gu;

const hostsFromTraefikMatch = (match: string | null | undefined): ReadonlyArray<string> => {
  if (!match) return [];
  const hosts: string[] = [];
  for (const hostArguments of match.matchAll(HOST_ARGUMENT_PATTERN)) {
    const rawArguments = hostArguments[1] ?? "";
    for (const host of rawArguments.matchAll(QUOTED_HOST_PATTERN)) {
      const value = host[1]?.trim();
      if (value) hosts.push(value);
    }
  }
  return hosts;
};

const readTraefikPreviewUrls = async (
  config: ResolvedNativeAppDevStackConfig,
  runKubectl: KubectlRunner,
): Promise<Map<string, string> | null> => {
  try {
    const list = parseJson<KubectlIngressRouteList>(
      await runKubectl(["-n", config.namespace, "get", "ingressroutes.traefik.io", "-o", "json"]),
    );
    const previewUrls = new Map<string, string>();
    for (const item of list.items ?? []) {
      for (const route of item.spec?.routes ?? []) {
        const host = hostsFromTraefikMatch(route.match)[0];
        const previewUrl = previewUrlFromHost(host);
        if (previewUrl === null) continue;
        for (const service of route.services ?? []) {
          addPreviewUrl(previewUrls, service.name, previewUrl);
        }
      }
    }
    return previewUrls;
  } catch {
    return null;
  }
};

const readIngressPreviewUrls = async (
  config: ResolvedNativeAppDevStackConfig,
  runKubectl: KubectlRunner,
): Promise<Map<string, string>> => {
  try {
    const list = parseJson<KubectlIngressList>(
      await runKubectl(["-n", config.namespace, "get", "ingress", "-o", "json"]),
    );
    const previewUrls = new Map<string, string>();
    for (const item of list.items ?? []) {
      const defaultUrl = previewUrlFromHost(item.spec?.rules?.[0]?.host);
      addPreviewUrl(previewUrls, item.spec?.defaultBackend?.service?.name, defaultUrl);
      for (const rule of item.spec?.rules ?? []) {
        const previewUrl = previewUrlFromHost(rule.host);
        if (previewUrl === null) continue;
        for (const path of rule.http?.paths ?? []) {
          addPreviewUrl(previewUrls, path.backend?.service?.name, previewUrl);
        }
      }
    }
    return previewUrls;
  } catch {
    return new Map();
  }
};

const readPreviewUrls = async (
  config: ResolvedNativeAppDevStackConfig,
  runKubectl: KubectlRunner,
): Promise<Map<string, string>> => {
  const traefikPreviewUrls = await readTraefikPreviewUrls(config, runKubectl);
  if (traefikPreviewUrls === null || traefikPreviewUrls.size > 0) {
    return traefikPreviewUrls ?? new Map();
  }
  return readIngressPreviewUrls(config, runKubectl);
};

const stripReplicaSetHash = (value: string): string => value.replace(/-[a-z0-9]{8,10}$/u, "");

interface PodPreviewContext {
  readonly config: ResolvedNativeAppDevStackConfig;
  readonly discoveredPreviewUrls: ReadonlyMap<string, string>;
}

const resolvePodPreview = (
  pod: KubectlPod,
  containers: ReadonlyArray<AppDevStackPodContainer>,
  ownerName: string | null,
  previewContext: PodPreviewContext | undefined,
): { readonly serviceName: string; readonly url: string } | null => {
  if (previewContext === undefined) return null;
  const candidates: string[] = [];
  const seen = new Set<string>();
  const addCandidate = (value: string | null | undefined) => {
    const key = value === undefined || value === null ? "" : serviceLookupKey(value);
    if (!key || seen.has(key)) return;
    seen.add(key);
    candidates.push(key);
  };

  const labels = pod.metadata?.labels;
  addCandidate(labels?.["cortex.ai/service"]);
  addCandidate(labels?.["app.kubernetes.io/name"]);
  for (const container of containers) {
    addCandidate(container.name);
  }
  addCandidate(ownerName === null ? null : stripReplicaSetHash(ownerName));

  const podName = serviceLookupKey(pod.metadata?.name ?? "");
  for (const serviceName of previewContext.discoveredPreviewUrls.keys()) {
    if (podName === serviceName || podName.startsWith(`${serviceName}-`)) {
      addCandidate(serviceName);
    }
  }
  for (const serviceName of ["frontend", "web", "app", "backend", "api", "keycloak", "minio"]) {
    if (podName === serviceName || podName.startsWith(`${serviceName}-`)) {
      addCandidate(serviceName);
    }
  }

  for (const serviceName of candidates) {
    const url = previewUrlForService(
      previewContext.config,
      previewContext.discoveredPreviewUrls,
      serviceName,
    );
    if (url !== undefined) return { serviceName, url };
  }
  return null;
};

const serviceOrder = (name: string) => {
  const order = [
    "frontend",
    "web",
    "app",
    "backend",
    "api",
    "keycloak",
    "postgres",
    "redis",
    "minio",
    "codex-runner",
  ];
  const index = order.indexOf(name);
  return index === -1 ? order.length : index;
};

const isTerminatingNamespace = (namespace: KubectlNamespace): boolean =>
  namespace.metadata?.deletionTimestamp !== undefined ||
  namespace.status?.phase?.trim().toLowerCase() === "terminating";

const readNamespace = async (
  config: ResolvedNativeAppDevStackConfig,
  runKubectl: KubectlRunner,
): Promise<KubectlNamespace | null> => {
  try {
    const namespace = parseJson<KubectlNamespace>(
      await runKubectl(["get", "namespace", config.namespace, "-o", "json"]),
    );
    return isTerminatingNamespace(namespace) ? null : namespace;
  } catch (cause) {
    if (isNotFound(cause)) return null;
    throw cause;
  }
};

const readAppDevStackNamespaces = async (
  runKubectl: KubectlRunner,
): Promise<ReadonlyArray<KubectlNamespace>> => {
  const list = parseJson<KubectlNamespaceList>(
    await runKubectl([
      "get",
      "namespaces",
      "-l",
      `${APP_DEV_STACK_COMPONENT_LABEL}=${APP_DEV_STACK_COMPONENT_VALUE}`,
      "-o",
      "json",
    ]),
  );
  // A namespace that is already terminating is on its way out; listing it would
  // resurrect a card the user just deleted.
  return [...(list.items ?? [])]
    .filter((namespace) => !isTerminatingNamespace(namespace))
    .sort((left, right) => (left.metadata?.name ?? "").localeCompare(right.metadata?.name ?? ""));
};

const readDeployments = async (
  config: ResolvedNativeAppDevStackConfig,
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
  config: ResolvedNativeAppDevStackConfig,
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

const buildPods = (
  podList: KubectlPodList,
  previewContext?: PodPreviewContext,
): Array<AppDevStackPod> =>
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
      const ownerName = owner?.name ?? null;
      const preview = resolvePodPreview(pod, containers, ownerName, previewContext);
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
          ownerName,
          previewUrl: preview?.url ?? null,
          previewServiceName: preview?.serviceName ?? null,
          containers,
        },
      ];
    })
    .sort((left, right) => left.name.localeCompare(right.name));

const readPods = async (
  config: ResolvedNativeAppDevStackConfig,
  runKubectl: KubectlRunner,
  previewContext?: PodPreviewContext,
): Promise<Array<AppDevStackPod>> =>
  buildPods(await readPodList(config, runKubectl), previewContext);

const findPodForLogs = async (
  config: ResolvedNativeAppDevStackConfig,
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

const normalizeAllStackLogLimit = (
  limit: AppDevStackGetAllStackPodLogsInput["limit"] | undefined,
): AppDevStackGetAllStackPodLogsResult["limit"] =>
  limit?.mode === "all"
    ? { mode: "all" }
    : {
        mode: "tail",
        tailLines: Math.min(
          5_000,
          Math.max(100, Math.trunc(limit?.tailLines ?? DEFAULT_LOG_TAIL_LINES)),
        ),
      };

const tailLinesFromLimit = (limit: AppDevStackGetAllStackPodLogsResult["limit"]): number | null =>
  limit.mode === "all" ? null : normalizeTailLines(limit.tailLines ?? DEFAULT_LOG_TAIL_LINES);

const kubectlLogArgs = (
  namespace: string,
  podName: string,
  containerName: string | null,
  tailLines: number | null,
): ReadonlyArray<string> => [
  "-n",
  namespace,
  "logs",
  podName,
  ...(containerName === null ? [] : ["-c", containerName]),
  ...(tailLines === null ? [] : [`--tail=${String(tailLines)}`]),
];

const logFailureMessage = (cause: unknown): string =>
  cause instanceof Error && cause.message.trim().length > 0
    ? cause.message
    : "Failed to fetch container logs.";

const buildPodLogEntry = (
  pod: AppDevStackPod,
  container: AppDevStackPodContainer,
  logs: string,
  error: string | null,
  fetchedAt: string,
): AppDevStackPodLogEntry => ({
  podName: pod.name,
  containerName: container.name,
  phase: pod.phase,
  ready: container.ready,
  restartCount: container.restartCount,
  state: container.state,
  ownerKind: pod.ownerKind ?? null,
  ownerName: pod.ownerName ?? null,
  logs,
  error,
  fetchedAt,
});

const buildStack = async (
  config: ResolvedNativeAppDevStackConfig,
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

  const [deployments, discoveredPreviewUrls] = await Promise.all([
    readDeployments(config, runKubectl),
    readPreviewUrls(config, runKubectl),
  ]);
  const services: Array<AppDevStackService> = (deployments.items ?? [])
    .map((deployment) => {
      const name = deployment.metadata?.name ?? "unknown";
      const desired = deployment.spec?.replicas ?? 1;
      const available = deployment.status?.availableReplicas ?? 0;
      const ready = deployment.status?.readyReplicas ?? 0;
      const stopped = desired === 0;
      const running = desired > 0 && available >= desired && ready >= desired;
      const previewUrl = previewUrlForService(config, discoveredPreviewUrls, name) ?? null;
      return {
        name,
        status: stopped ? "stopped" : running ? "running" : "starting",
        health: running ? "healthy" : stopped ? "unknown" : "starting",
        previewUrl,
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

const frontendPreviewForStack = (
  stack: AppDevStack,
  configuredFrontendUrl: string | undefined,
): { readonly frontendUrl: string | null; readonly frontendServiceName: string | null } => {
  if (configuredFrontendUrl !== undefined) {
    return { frontendUrl: configuredFrontendUrl, frontendServiceName: "frontend" };
  }

  for (const candidate of ["frontend", "web", "app"]) {
    const service = stack.services?.find(
      (entry) => serviceLookupKey(entry.name) === candidate && nonEmptyString(entry.previewUrl),
    );
    if (service?.previewUrl) {
      return { frontendUrl: service.previewUrl, frontendServiceName: service.name };
    }
  }

  return { frontendUrl: null, frontendServiceName: null };
};

const isAppDevStackError = Schema.is(AppDevStackError);

const appDevStackError = (operation: string, cause: unknown) =>
  isAppDevStackError(cause)
    ? cause
    : new AppDevStackError({
        operation,
        reason: "request_failed",
        message:
          cause instanceof Error ? cause.message : `Native app-dev stack ${operation} failed.`,
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

const unknownStackError = (operation: string, stackId: string) =>
  new AppDevStackError({
    operation,
    reason: "request_failed",
    status: 404,
    message: `Native app-dev stack "${stackId}" is not configured in this Code server session.`,
  });

export const makeNativeAppDevStackService = (
  config: NativeAppDevStackConfig,
  runKubectl: KubectlRunner,
  runCommand?: NativeCommandRunner,
): NativeAppDevStackService => {
  const configuredStack = resolveConfiguredNativeConfig(config);
  const knownByStackId = new Map<string, ResolvedNativeAppDevStackConfig>();
  const knownByWorktreePath = new Map<string, ResolvedNativeAppDevStackConfig>();
  const knownNamespaceMetadata = new Map<string, KubectlNamespace>();

  const rememberStack = (
    resolved: ResolvedNativeAppDevStackConfig,
    namespace?: KubectlNamespace | undefined,
  ) => {
    knownByStackId.set(resolved.id, resolved);
    knownByStackId.set(resolved.namespace, resolved);
    knownByWorktreePath.set(normalizePath(resolved.worktreePath), resolved);
    if (namespace !== undefined) {
      knownNamespaceMetadata.set(resolved.namespace, namespace);
    }
    return resolved;
  };

  if (configuredStack !== null) {
    rememberStack(configuredStack);
  }

  const knownStacks = () =>
    [...new Set(knownByStackId.values())].sort((left, right) =>
      left.namespace.localeCompare(right.namespace),
    );

  const forgetStack = (resolved: ResolvedNativeAppDevStackConfig) => {
    for (const [key, value] of knownByStackId) {
      if (value.namespace === resolved.namespace) knownByStackId.delete(key);
    }
    for (const [key, value] of knownByWorktreePath) {
      if (value.namespace === resolved.namespace) knownByWorktreePath.delete(key);
    }
    knownNamespaceMetadata.delete(resolved.namespace);
  };

  /**
   * The registry is a cache of the cluster, not a record of its own: a stack
   * whose namespace is gone — deleted here, or by another Code server sharing
   * the cluster — has to leave the list instead of lingering as "stopped".
   * The env-configured stack stays, since it is legitimately known before its
   * namespace is ever provisioned.
   */
  const forgetVanishedStacks = async (liveNamespaces: ReadonlySet<string>) => {
    const candidates = knownStacks().filter(
      (resolved) =>
        !liveNamespaces.has(resolved.namespace) &&
        resolved.namespace !== configuredStack?.namespace,
    );
    await Promise.all(
      candidates.map(async (resolved) => {
        if ((await readNamespace(resolved, runKubectl)) === null) forgetStack(resolved);
      }),
    );
  };

  const discoverAppDevStacks = async () => {
    const namespaces = await readAppDevStackNamespaces(runKubectl);
    const liveNamespaces = new Set<string>();
    for (const namespace of namespaces) {
      const resolved = resolveNativeConfigForNamespace(config, namespace);
      if (resolved !== null) {
        liveNamespaces.add(resolved.namespace);
        rememberStack(resolved, namespace);
      }
    }
    await forgetVanishedStacks(liveNamespaces);
    return knownStacks();
  };

  const resolveKnownStack = (
    operation: string,
    stackId: string,
  ): Effect.Effect<ResolvedNativeAppDevStackConfig, AppDevStackError> =>
    Effect.gen(function* () {
      const known = knownByStackId.get(stackId);
      if (known !== undefined) return known;

      return yield* nativeOperation(operation, async () => {
        await discoverAppDevStacks();
        const discovered = knownByStackId.get(stackId);
        if (discovered === undefined) {
          throw unknownStackError(operation, stackId);
        }
        return discovered;
      });
    });

  const readStack = (operation: string, resolved: ResolvedNativeAppDevStackConfig) =>
    nativeOperation(operation, () => buildStack(resolved, runKubectl));

  const readStackPodLogsForResolved = (
    operation: string,
    resolved: ResolvedNativeAppDevStackConfig,
    tailLines: number | null,
  ) =>
    Effect.gen(function* () {
      const pods = yield* nativeOperation(operation, () => readPods(resolved, runKubectl));
      const podContainers = pods.flatMap((pod) =>
        pod.containers.map((container) => ({ pod, container })),
      );
      const entries = yield* Effect.forEach(
        podContainers,
        ({ pod, container }) =>
          Effect.promise(async () => {
            try {
              const logs = await runKubectl(
                kubectlLogArgs(resolved.namespace, pod.name, container.name, tailLines),
              );
              return buildPodLogEntry(
                pod,
                container,
                logs,
                null,
                DateTime.formatIso(DateTime.nowUnsafe()),
              );
            } catch (cause) {
              return buildPodLogEntry(
                pod,
                container,
                "",
                logFailureMessage(cause),
                DateTime.formatIso(DateTime.nowUnsafe()),
              );
            }
          }),
        { concurrency: POD_LOG_FETCH_CONCURRENCY },
      );
      return {
        pods,
        entries,
        fetchedAt: DateTime.formatIso(DateTime.nowUnsafe()),
      };
    });

  return {
    status: Effect.succeed({
      enabled: true,
      backendUrl:
        configuredStack === null
          ? "native://app-dev-stacks"
          : `native://${configuredStack.namespace}`,
    }),
    list: () =>
      nativeOperation("list", discoverAppDevStacks).pipe(
        Effect.flatMap((resolvedStacks) =>
          Effect.forEach(resolvedStacks, (resolved) => readStack("list", resolved), {
            concurrency: 4,
          }),
        ),
        Effect.map((stacks) => ({ stacks })),
      ),
    getByWorktree: (input) =>
      nativeOperation("getByWorktree", async () => {
        const normalizedPath = normalizePath(input.worktreePath);
        const known = knownByWorktreePath.get(normalizedPath);
        const resolved =
          known ??
          resolveNativeConfigForWorktree(config, {
            worktreePath: input.worktreePath,
          });
        if (known === undefined) {
          const namespace = await readNamespace(resolved, runKubectl);
          if (namespace === null) {
            return { stack: null, frontendUrl: null, frontendServiceName: null };
          }
          rememberStack(resolved);
        }
        const stack = await buildStack(resolved, runKubectl);
        const frontend = frontendPreviewForStack(stack, resolved.frontendUrl);
        return {
          stack,
          ...frontend,
        };
      }),
    get: (input) =>
      resolveKnownStack("get", input.stackId).pipe(
        Effect.flatMap((resolved) => readStack("get", resolved)),
      ),
    autoCreate: (input) =>
      nativeOperation("autoCreate", async () => {
        const resolved = resolveNativeConfigForWorktree(config, {
          worktreePath: input.worktreePath,
          displayName: input.displayName,
          gitBranch: input.gitBranch,
          namespace: input.namespace,
          preferConfiguredNamespace: config.worktreePath === undefined,
        });
        const namespace = await readNamespace(resolved, runKubectl);
        const deployments = namespace === null ? null : await readDeployments(resolved, runKubectl);
        const shouldProvision = namespace === null || (deployments?.items ?? []).length === 0;
        await provisionNativeAppDevStack(resolved, runKubectl, runCommand);
        rememberStack(resolved);
        await runKubectl([
          "-n",
          resolved.namespace,
          "scale",
          "deployment",
          "--all",
          "--replicas=1",
        ]);
        const stack = await buildStack(resolved, runKubectl);
        const frontend = frontendPreviewForStack(stack, resolved.frontendUrl);
        return {
          stack,
          created: shouldProvision,
          ...frontend,
        };
      }),
    stop: (input) =>
      resolveKnownStack("stop", input.stackId).pipe(
        Effect.flatMap((resolved) =>
          nativeOperation("stop", async () => {
            await runKubectl([
              "-n",
              resolved.namespace,
              "scale",
              "deployment",
              "--all",
              "--replicas=0",
            ]);
            return buildStack(resolved, runKubectl);
          }),
        ),
      ),
    restart: (input) =>
      resolveKnownStack("restart", input.stackId).pipe(
        Effect.flatMap((resolved) =>
          nativeOperation("restart", async () => {
            await runKubectl([
              "-n",
              resolved.namespace,
              "scale",
              "deployment",
              "--all",
              "--replicas=0",
            ]);
            await runKubectl([
              "-n",
              resolved.namespace,
              "scale",
              "deployment",
              "--all",
              "--replicas=1",
            ]);
            return buildStack(resolved, runKubectl);
          }),
        ),
      ),
    delete: (input) =>
      resolveKnownStack("delete", input.stackId).pipe(
        Effect.flatMap((resolved) =>
          nativeOperation("delete", async () => {
            await runKubectl(["delete", "namespace", resolved.namespace, "--ignore-not-found"]);
            forgetStack(resolved);
            return { deleted: true };
          }),
        ),
      ),
    listPods: (input) =>
      resolveKnownStack("listPods", input.stackId).pipe(
        Effect.flatMap((resolved) =>
          nativeOperation("listPods", async () => {
            const previewUrls = await readPreviewUrls(resolved, runKubectl);
            return {
              stackId: resolved.id,
              namespace: resolved.namespace,
              pods: await readPods(resolved, runKubectl, {
                config: resolved,
                discoveredPreviewUrls: previewUrls,
              }),
            };
          }),
        ),
      ),
    getPodLogs: (input) =>
      resolveKnownStack("getPodLogs", input.stackId).pipe(
        Effect.flatMap((resolved) =>
          nativeOperation("getPodLogs", async () => {
            const { pod, containerName } = await findPodForLogs(
              resolved,
              runKubectl,
              input.podName,
              input.containerName,
            );
            const tailLines = normalizeTailLines(input.tailLines);
            return {
              stackId: resolved.id,
              namespace: resolved.namespace,
              podName: pod.name,
              containerName,
              tailLines,
              logs: await runKubectl(
                kubectlLogArgs(resolved.namespace, pod.name, containerName, tailLines),
              ),
              fetchedAt: DateTime.formatIso(DateTime.nowUnsafe()),
            };
          }),
        ),
      ),
    getStackPodLogs: (input) =>
      resolveKnownStack("getStackPodLogs", input.stackId).pipe(
        Effect.flatMap((resolved) =>
          Effect.gen(function* () {
            const tailLines = normalizeTailLines(input.tailLines);
            const { pods, entries, fetchedAt } = yield* readStackPodLogsForResolved(
              "getStackPodLogs",
              resolved,
              tailLines,
            );
            return {
              stackId: resolved.id,
              namespace: resolved.namespace,
              tailLines,
              pods,
              entries,
              fetchedAt,
            };
          }),
        ),
      ),
    getAllStackPodLogs: (input) =>
      Effect.gen(function* () {
        const limit = normalizeAllStackLogLimit(input.limit);
        const tailLines = tailLinesFromLimit(limit);
        const resolvedStacks = yield* nativeOperation("getAllStackPodLogs", discoverAppDevStacks);
        const stacks = yield* Effect.forEach(
          resolvedStacks,
          (resolved) =>
            readStackPodLogsForResolved("getAllStackPodLogs", resolved, tailLines).pipe(
              Effect.map(({ pods, entries, fetchedAt }) => {
                const namespace = knownNamespaceMetadata.get(resolved.namespace);
                const managedBy =
                  labelValue(namespace?.metadata?.labels, APP_DEV_STACK_MANAGED_BY_LABEL) ?? null;
                return {
                  stackId: resolved.id,
                  namespace: resolved.namespace,
                  displayName: resolved.displayName,
                  displaySlug: resolved.displaySlug ?? null,
                  repoName: resolved.repoName ?? null,
                  branchName: resolved.branchName ?? null,
                  worktreePath: resolved.worktreePath,
                  managedBy,
                  limit,
                  pods,
                  entries,
                  error: null,
                  fetchedAt,
                };
              }),
              Effect.catch((error) => {
                const namespace = knownNamespaceMetadata.get(resolved.namespace);
                const managedBy =
                  labelValue(namespace?.metadata?.labels, APP_DEV_STACK_MANAGED_BY_LABEL) ?? null;
                return Effect.succeed({
                  stackId: resolved.id,
                  namespace: resolved.namespace,
                  displayName: resolved.displayName,
                  displaySlug: resolved.displaySlug ?? null,
                  repoName: resolved.repoName ?? null,
                  branchName: resolved.branchName ?? null,
                  worktreePath: resolved.worktreePath,
                  managedBy,
                  limit,
                  pods: [],
                  entries: [],
                  error: error.message,
                  fetchedAt: DateTime.formatIso(DateTime.nowUnsafe()),
                });
              }),
            ),
          { concurrency: STACK_LOG_FETCH_CONCURRENCY },
        );
        return {
          limit,
          stacks,
          fetchedAt: DateTime.formatIso(DateTime.nowUnsafe()),
        };
      }),
  };
};
