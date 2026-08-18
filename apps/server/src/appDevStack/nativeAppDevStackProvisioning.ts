// @effect-diagnostics nodeBuiltinImport:off - Native Kubernetes provisioning writes a kubectl manifest file.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttps from "node:https";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { appDevStackPreviewUrlForService } from "@t3tools/shared/appDevStack";
import { parseYamlValue, stringifyYamlValue } from "@t3tools/shared/schemaYaml";

import type { KubectlRunner } from "./NativeAppDevStackManager.ts";

interface NativeProvisionConfig {
  readonly id: string;
  readonly namespace: string;
  readonly worktreePath: string;
  readonly composePath: string;
  readonly displayName: string;
  readonly displaySlug: string | undefined;
  readonly repoName: string | undefined;
  readonly branchName: string | undefined;
  readonly dockerPath: string;
  readonly buildctlPath: string;
  readonly imageBuilder: "auto" | "docker" | "buildkit";
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

interface PortMapping {
  readonly host: number | null;
  readonly container: number;
  readonly protocol: "tcp" | "udp";
}

interface ParsedComposeBuild {
  readonly context: string;
  readonly dockerfile: string | undefined;
  readonly target: string | undefined;
  readonly args: ReadonlyMap<string, string>;
}

interface ParsedComposeHealthcheck {
  readonly test: unknown;
  readonly interval: unknown;
  readonly timeout: unknown;
  readonly startPeriod: unknown;
  readonly retries: unknown;
}

interface ParsedComposeService {
  readonly name: string;
  readonly image: string;
  readonly imageWasExplicit: boolean;
  readonly build: ParsedComposeBuild | undefined;
  readonly labels: ReadonlyMap<string, string>;
  readonly environment: ReadonlyMap<string, string>;
  readonly ports: ReadonlyArray<PortMapping>;
  readonly volumes: ReadonlyArray<unknown>;
  readonly command: unknown;
  readonly entrypoint: unknown;
  readonly workingDir: string | undefined;
  readonly healthcheck: ParsedComposeHealthcheck | undefined;
}

type KubernetesDocument = Record<string, unknown>;

export interface NativeCommandOptions {
  readonly cwd?: string | undefined;
  readonly env?: Readonly<Record<string, string>> | undefined;
}

export type NativeCommandRunner = (
  command: string,
  args: ReadonlyArray<string>,
  options?: NativeCommandOptions,
) => Promise<string>;

const APP_LABEL_PREFIXES = ["cortex.appDevStack", "rudi.appDevStack"] as const;

/**
 * Shared credentials the backend of an app-dev stack reads from OpenBao through
 * External Secrets. The names match the ExternalSecret already deployed in the
 * rudi-dev namespace, so re-provisioning adopts it in place rather than adding a
 * second one.
 */
const OPENBAO_CLUSTER_SECRET_STORE = "openbao-backend";
const BACKEND_EXTERNAL_SECRET_NAME = "rudi-backend-credentials";
const BACKEND_SECRETS_NAME = "rudi-backend-secrets";
const GOOGLE_OAUTH_OPENBAO_PATH = "rudi/api-keys/google";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringOrUndefined = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

const sanitizeKubernetesName = (value: string, maxLength = 63): string => {
  const sanitized = value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .replace(/-+/gu, "-")
    .slice(0, maxLength)
    .replace(/^-+|-+$/gu, "");
  return sanitized || "app";
};

const makeLabels = (stackId: string, serviceName?: string): Record<string, string> => {
  const labels: Record<string, string> = {
    "app.kubernetes.io/managed-by": "t3code",
    "app.kubernetes.io/part-of": "code-app-dev",
    "cortex.ai/component": "app-dev-stack",
    "cortex.ai/stack-id": stackId,
  };
  if (serviceName !== undefined) {
    const sanitized = sanitizeKubernetesName(serviceName);
    labels["app.kubernetes.io/name"] = sanitized;
    labels["cortex.ai/service"] = sanitized;
  }
  return labels;
};

const isBackendService = (serviceName: string): boolean =>
  sanitizeKubernetesName(serviceName).includes("backend");

const buildBackendExternalSecret = (namespace: string, stackId: string): KubernetesDocument => ({
  apiVersion: "external-secrets.io/v1",
  kind: "ExternalSecret",
  metadata: {
    name: BACKEND_EXTERNAL_SECRET_NAME,
    namespace,
    labels: {
      ...makeLabels(stackId, "backend"),
      "app.kubernetes.io/name": BACKEND_EXTERNAL_SECRET_NAME,
    },
  },
  spec: {
    refreshInterval: "1h",
    secretStoreRef: { kind: "ClusterSecretStore", name: OPENBAO_CLUSTER_SECRET_STORE },
    target: { name: BACKEND_SECRETS_NAME, creationPolicy: "Owner", deletionPolicy: "Retain" },
    data: [
      {
        secretKey: "GOOGLE_CLIENT_ID",
        remoteRef: { key: GOOGLE_OAUTH_OPENBAO_PATH, property: "client_id" },
      },
      {
        secretKey: "GOOGLE_CLIENT_SECRET",
        remoteRef: { key: GOOGLE_OAUTH_OPENBAO_PATH, property: "client_secret" },
      },
    ],
  },
});

const expandEnv = (value: string): string =>
  value.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-(.*?))?\}|\$([A-Za-z_][A-Za-z0-9_]*)/gu,
    (_match, bracedName: string | undefined, defaultValue: string | undefined, bareName: string) =>
      process.env[bracedName ?? bareName] ?? defaultValue ?? "",
  );

const normalizeLabels = (raw: unknown): ReadonlyMap<string, string> => {
  const labels = new Map<string, string>();
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item !== "string") continue;
      const separator = item.indexOf("=");
      if (separator === -1) {
        labels.set(item.trim(), "");
      } else {
        labels.set(item.slice(0, separator).trim(), item.slice(separator + 1).trim());
      }
    }
  } else if (isRecord(raw)) {
    for (const [key, value] of Object.entries(raw)) {
      labels.set(key, String(value));
    }
  }
  return labels;
};

const firstAppLabel = (
  labels: ReadonlyMap<string, string>,
  names: ReadonlyArray<string>,
): string | undefined => {
  for (const prefix of APP_LABEL_PREFIXES) {
    for (const name of names) {
      const value = labels.get(`${prefix}.${name}`)?.trim();
      if (value) return value;
    }
  }
  return undefined;
};

const normalizeEnvironment = (raw: unknown): ReadonlyMap<string, string> => {
  const env = new Map<string, string>();
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item !== "string") continue;
      const separator = item.indexOf("=");
      if (separator === -1) {
        env.set(item, process.env[item] ?? "");
      } else {
        env.set(item.slice(0, separator), expandEnv(item.slice(separator + 1)));
      }
    }
  } else if (isRecord(raw)) {
    for (const [key, value] of Object.entries(raw)) {
      if (value === null || value === undefined) {
        env.set(key, "");
      } else {
        env.set(key, expandEnv(String(value)));
      }
    }
  }
  return env;
};

const parsePortNumber = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 65_535) {
    return value;
  }
  if (typeof value !== "string") return null;
  const firstRangePart = value.trim().split("-")[0];
  const parsed = Number.parseInt(firstRangePart ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535 ? parsed : null;
};

const parsePortString = (value: string): PortMapping | null => {
  const [address, rawProtocol] = value.split("/", 2);
  const protocol = rawProtocol?.toLowerCase() === "udp" ? "udp" : "tcp";
  const segments = (address ?? "")
    .split(":")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  if (segments.length === 0) return null;
  const container = parsePortNumber(segments[segments.length - 1]);
  if (container === null) return null;
  const host = segments.length >= 2 ? parsePortNumber(segments[segments.length - 2]) : null;
  return { host, container, protocol };
};

const parsePortMapping = (raw: unknown): PortMapping | null => {
  if (typeof raw === "string") return parsePortString(raw);
  if (typeof raw === "number") {
    const container = parsePortNumber(raw);
    return container === null ? null : { host: null, container, protocol: "tcp" };
  }
  if (!isRecord(raw)) return null;
  const container = parsePortNumber(raw.target ?? raw.container);
  if (container === null) return null;
  const host = parsePortNumber(raw.published ?? raw.host);
  const protocol = stringOrUndefined(raw.protocol)?.toLowerCase() === "udp" ? "udp" : "tcp";
  return { host, container, protocol };
};

const normalizeBuildArgs = (raw: unknown): ReadonlyMap<string, string> => {
  const args = new Map<string, string>();
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item !== "string") continue;
      const separator = item.indexOf("=");
      if (separator === -1) {
        args.set(item.trim(), process.env[item.trim()] ?? "");
      } else {
        args.set(item.slice(0, separator).trim(), expandEnv(item.slice(separator + 1)));
      }
    }
  } else if (isRecord(raw)) {
    for (const [key, value] of Object.entries(raw)) {
      if (value === null || value === undefined) continue;
      args.set(key, expandEnv(String(value)));
    }
  }
  return args;
};

const parseComposeBuild = (raw: unknown): ParsedComposeBuild | undefined => {
  if (typeof raw === "string") {
    const context = stringOrUndefined(raw);
    return context === undefined
      ? undefined
      : { context, dockerfile: undefined, target: undefined, args: new Map() };
  }
  if (!isRecord(raw)) return undefined;
  return {
    context: stringOrUndefined(raw.context) ?? ".",
    dockerfile: stringOrUndefined(raw.dockerfile),
    target: stringOrUndefined(raw.target),
    args: normalizeBuildArgs(raw.args),
  };
};

const parseComposeHealthcheck = (raw: unknown): ParsedComposeHealthcheck | undefined => {
  if (!isRecord(raw) || raw.disable === true) return undefined;
  return {
    test: raw.test,
    interval: raw.interval,
    timeout: raw.timeout,
    startPeriod: raw.start_period ?? raw.startPeriod,
    retries: raw.retries,
  };
};

const parseComposeServices = (compose: unknown): Array<ParsedComposeService> => {
  if (!isRecord(compose) || !isRecord(compose.services)) return [];
  return Object.entries(compose.services).flatMap(([name, rawService]) => {
    if (!isRecord(rawService)) return [];
    const explicitImage = stringOrUndefined(rawService.image);
    const image = explicitImage ?? `${sanitizeKubernetesName(name)}:latest`;
    const labels = normalizeLabels(rawService.labels);
    const environment = normalizeEnvironment(rawService.environment);
    const ports = Array.isArray(rawService.ports)
      ? rawService.ports.flatMap((port) => {
          const parsed = parsePortMapping(port);
          return parsed === null ? [] : [parsed];
        })
      : [];
    const volumes = Array.isArray(rawService.volumes) ? rawService.volumes : [];
    return [
      {
        name,
        image: expandEnv(image),
        imageWasExplicit: explicitImage !== undefined,
        build: parseComposeBuild(rawService.build),
        labels,
        environment,
        ports,
        volumes,
        command: rawService.command,
        entrypoint: rawService.entrypoint,
        workingDir:
          stringOrUndefined(rawService.working_dir) ?? stringOrUndefined(rawService.workingDir),
        healthcheck: parseComposeHealthcheck(rawService.healthcheck),
      },
    ];
  });
};

interface ComposePortTarget {
  readonly serviceName: string;
  readonly containerPort: number;
}

const composePortTargets = (
  services: ReadonlyArray<ParsedComposeService>,
): ReadonlyMap<number, ComposePortTarget> => {
  const targets = new Map<number, ComposePortTarget>();
  const ambiguousPorts = new Set<number>();
  for (const service of services) {
    for (const port of service.ports) {
      if (port.host === null || port.protocol !== "tcp") continue;
      if (targets.has(port.host)) {
        ambiguousPorts.add(port.host);
        targets.delete(port.host);
        continue;
      }
      if (!ambiguousPorts.has(port.host)) {
        targets.set(port.host, {
          serviceName: sanitizeKubernetesName(service.name),
          containerPort: port.container,
        });
      }
    }
  }
  return targets;
};

const rewriteComposeHostReferences = (
  config: NativeProvisionConfig,
  services: ReadonlyArray<ParsedComposeService>,
): ReadonlyArray<ParsedComposeService> => {
  const targets = composePortTargets(services);
  const publicUrlReplacements = services
    .flatMap((service) => {
      const configuredHost = firstAppLabel(service.labels, ["hostname", "host"]);
      const stackScopedUrl = appDevStackPreviewUrlForService({
        namespace: config.namespace,
        serviceName: service.name,
        frontendUrl: config.frontendUrl,
        backendUrl: config.backendUrl,
        keycloakUrl: config.keycloakUrl,
        minioUrl: config.minioUrl,
      });
      if (
        !config.preferStackScopedUrls ||
        configuredHost === undefined ||
        stackScopedUrl === null
      ) {
        return [];
      }
      const configuredUrl = configuredHost.includes("://")
        ? configuredHost
        : `https://${configuredHost}`;
      const configuredHostname = configuredUrl.replace(/^https?:\/\//u, "").replace(/\/+$/u, "");
      const stackScopedHostname = stackScopedUrl.replace(/^https?:\/\//u, "").replace(/\/+$/u, "");
      return [
        [configuredUrl.replace(/\/+$/u, ""), stackScopedUrl.replace(/\/+$/u, "")],
        [configuredHostname, stackScopedHostname],
      ] as const;
    })
    .sort(([left], [right]) => right.length - left.length);
  return services.map((service) => {
    const environment = new Map(
      [...service.environment].map(([name, value]) => [
        name,
        publicUrlReplacements.reduce(
          (rewritten, [source, target]) => rewritten.replaceAll(source, target),
          value.replace(/host\.containers\.internal:(\d{1,5})/gu, (match, rawPort: string) => {
            const target = targets.get(Number.parseInt(rawPort, 10));
            return target === undefined ? match : `${target.serviceName}:${target.containerPort}`;
          }),
        ),
      ]),
    );
    if (!environment.has("CI")) environment.set("CI", "true");
    return { ...service, environment };
  });
};

const isMissingFileError = (cause: unknown): cause is NodeJS.ErrnoException =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  (cause as { readonly code?: unknown }).code === "ENOENT";

const fileExists = async (path: string) => {
  try {
    await NodeFSP.access(path, NodeFS.constants.R_OK);
    return true;
  } catch (cause) {
    if (isMissingFileError(cause)) return false;
    throw cause;
  }
};

const resolveComposePath = async (config: NativeProvisionConfig): Promise<string> => {
  if (NodePath.isAbsolute(config.composePath)) return config.composePath;

  const firstCandidate = NodePath.resolve(config.worktreePath, config.composePath);
  let currentDir = NodePath.resolve(config.worktreePath);
  for (;;) {
    const candidate = NodePath.resolve(currentDir, config.composePath);
    if (await fileExists(candidate)) return candidate;

    const parentDir = NodePath.dirname(currentDir);
    if (parentDir === currentDir) return firstCandidate;
    currentDir = parentDir;
  }
};

const readComposeFile = async (config: NativeProvisionConfig, composePath: string) => {
  try {
    return await NodeFSP.readFile(composePath, "utf8");
  } catch (cause) {
    if (!isMissingFileError(cause)) throw cause;
    throw new Error(
      `App-dev compose file not found for ${config.worktreePath}: ${composePath}. Add infra/compose/compose.app-dev.yml to the repository or set T3CODE_APP_DEV_STACK_NATIVE_COMPOSE_PATH to an existing compose file.`,
      { cause },
    );
  }
};

const shouldExposeService = (service: ParsedComposeService): boolean => {
  const value = firstAppLabel(service.labels, ["expose", "preview", "public"]);
  return value === undefined || !["false", "0", "no", "off"].includes(value.toLowerCase());
};

const hostnameFromPreviewUrl = (value: string): string => {
  try {
    return new URL(value.includes("://") ? value : `https://${value}`).host;
  } catch {
    return value.replace(/^https?:\/\//u, "").split("/", 1)[0] ?? value;
  }
};

const configuredPreviewUrl = (
  config: NativeProvisionConfig,
  service: ParsedComposeService,
): string | undefined => {
  const stackScopedUrl = appDevStackPreviewUrlForService({
    namespace: config.namespace,
    serviceName: service.name,
    frontendUrl: config.frontendUrl,
    backendUrl: config.backendUrl,
    keycloakUrl: config.keycloakUrl,
    minioUrl: config.minioUrl,
  });
  if (config.preferStackScopedUrls && stackScopedUrl !== null) return stackScopedUrl;

  const explicitUrl = firstAppLabel(service.labels, ["previewUrl", "preview_url", "url"]);
  if (explicitUrl !== undefined)
    return explicitUrl.includes("://") ? explicitUrl : `https://${explicitUrl}`;
  const explicitHost = firstAppLabel(service.labels, ["hostname", "host"]);
  if (explicitHost !== undefined) {
    const host = explicitHost.replace(/^https?:\/\//u, "").replace(/\/+$/u, "");
    return host.length > 0 ? `https://${host}` : undefined;
  }

  return stackScopedUrl ?? undefined;
};

const servicePortDocuments = (
  service: ParsedComposeService,
): ReadonlyArray<Record<string, unknown>> =>
  service.ports.map((port) => ({
    name: `port-${port.container}-${port.protocol}`,
    port: port.container,
    targetPort: port.container,
    protocol: port.protocol.toUpperCase(),
  }));

const hostPathType = (source: string): string => {
  try {
    const stat = NodeFS.statSync(source);
    return stat.isFile() ? "File" : "Directory";
  } catch {
    return NodePath.extname(source).length > 0 ? "FileOrCreate" : "DirectoryOrCreate";
  }
};

const uniqueVolumeName = (base: string, used: Set<string>): string => {
  const root = sanitizeKubernetesName(base, 50);
  let candidate = root;
  let index = 1;
  while (used.has(candidate)) {
    candidate = sanitizeKubernetesName(`${root}-${index}`, 63);
    index += 1;
  }
  used.add(candidate);
  return candidate;
};

const resolveVolumeSource = (source: string, composeDir: string): string => {
  const expanded = expandEnv(source);
  return expanded === "." ||
    expanded === ".." ||
    expanded.startsWith("./") ||
    expanded.startsWith("../")
    ? NodePath.resolve(composeDir, expanded)
    : expanded;
};

const resolveComposeRelativePath = (value: string, composeDir: string): string => {
  const expanded = expandEnv(value);
  return NodePath.isAbsolute(expanded) ? expanded : NodePath.resolve(composeDir, expanded);
};

const splitComposeVolumeSpec = (value: string): ReadonlyArray<string> => {
  const parts: string[] = [];
  let current = "";
  let interpolationDepth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    const next = value[index + 1];
    if (character === "$" && next === "{") {
      interpolationDepth += 1;
      current += "${";
      index += 1;
      continue;
    }
    if (character === "}" && interpolationDepth > 0) {
      interpolationDepth -= 1;
      current += character;
      continue;
    }
    if (character === ":" && interpolationDepth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  parts.push(current);
  return parts;
};

const normalizeRegistry = (registry: string | undefined): string | undefined => {
  const value = registry
    ?.trim()
    .replace(/^https?:\/\//u, "")
    .replace(/\/+$/u, "");
  return value === undefined || value.length === 0 ? undefined : value;
};

const imageWithoutDigest = (image: string): string => image.split("@", 1)[0] ?? image;

const imageRegistrySegment = (image: string): string | undefined => {
  const withoutDigest = imageWithoutDigest(image);
  const firstSlash = withoutDigest.indexOf("/");
  return firstSlash === -1 ? undefined : withoutDigest.slice(0, firstSlash);
};

const isRegistryQualifiedImage = (image: string): boolean => {
  const firstSegment = imageRegistrySegment(image);
  return (
    firstSegment !== undefined &&
    (firstSegment === "localhost" || firstSegment.includes(".") || firstSegment.includes(":"))
  );
};

const imageLastSegment = (image: string): string => {
  const withoutDigest = imageWithoutDigest(image);
  return withoutDigest.split("/").at(-1) ?? withoutDigest;
};

const imageTag = (image: string): string | undefined => {
  const segment = imageLastSegment(image);
  const tagSeparatorIndex = segment.lastIndexOf(":");
  return tagSeparatorIndex === -1 ? undefined : segment.slice(tagSeparatorIndex + 1);
};

const imageRepositoryName = (image: string): string => {
  const segment = imageLastSegment(image);
  const tagSeparatorIndex = segment.lastIndexOf(":");
  return tagSeparatorIndex === -1 ? segment : segment.slice(0, tagSeparatorIndex);
};

const deriveImageProject = (config: NativeProvisionConfig): string =>
  sanitizeKubernetesName(
    config.imageProject ??
      config.repoName ??
      config.displaySlug ??
      config.displayName ??
      config.namespace.replace(/-dev$/u, ""),
  );

const deriveRepositoryPrefix = (config: NativeProvisionConfig): string =>
  sanitizeKubernetesName(
    config.repoName ??
      config.displaySlug ??
      config.displayName ??
      config.namespace.replace(/-dev$/u, ""),
  );

const targetImageForBuildService = (
  config: NativeProvisionConfig,
  service: ParsedComposeService,
): string => {
  if (isRegistryQualifiedImage(service.image)) return service.image;

  const registry = normalizeRegistry(config.imageRegistry);
  if (registry === undefined) {
    throw new Error(
      `Compose service "${service.name}" has a build definition but image "${service.image}" is not registry-qualified. Set T3CODE_APP_DEV_STACK_NATIVE_IMAGE_REGISTRY so Kubernetes can pull the built image.`,
    );
  }

  const repoPrefix = deriveRepositoryPrefix(config);
  const serviceName = sanitizeKubernetesName(service.name);
  const repository = service.imageWasExplicit
    ? sanitizeKubernetesName(imageRepositoryName(service.image))
    : sanitizeKubernetesName(`${repoPrefix}-${serviceName}`);
  return `${registry}/${deriveImageProject(config)}/${repository}:${imageTag(service.image) ?? "latest"}`;
};

const dockerBuildArgsForService = (
  targetImage: string,
  build: ParsedComposeBuild,
  composeDir: string,
): {
  readonly args: ReadonlyArray<string>;
  readonly contextPath: string;
} => {
  const contextPath = resolveComposeRelativePath(build.context, composeDir);
  const args: Array<string> = ["build", "-t", targetImage];
  if (build.dockerfile !== undefined) {
    const dockerfile = expandEnv(build.dockerfile);
    args.push(
      "-f",
      NodePath.isAbsolute(dockerfile) ? dockerfile : NodePath.resolve(contextPath, dockerfile),
    );
  }
  if (build.target !== undefined) {
    args.push("--target", build.target);
  }
  for (const [key, value] of build.args) {
    args.push("--build-arg", `${key}=${value}`);
  }
  args.push(contextPath);
  return { args, contextPath };
};

const dockerfileLocation = (
  build: ParsedComposeBuild,
  contextPath: string,
): {
  readonly dockerfileDir: string;
  readonly dockerfileName: string;
} => {
  const dockerfile = build.dockerfile === undefined ? "Dockerfile" : expandEnv(build.dockerfile);
  const dockerfilePath = NodePath.isAbsolute(dockerfile)
    ? dockerfile
    : NodePath.resolve(contextPath, dockerfile);
  return {
    dockerfileDir: NodePath.dirname(dockerfilePath),
    dockerfileName: NodePath.basename(dockerfilePath),
  };
};

const replaceImageRegistry = (
  image: string,
  expectedRegistry: string | undefined,
  replacementRegistry: string | undefined,
): string => {
  const expected = normalizeRegistry(expectedRegistry);
  const replacement = normalizeRegistry(replacementRegistry);
  if (expected === undefined || replacement === undefined || !isRegistryQualifiedImage(image)) {
    return image;
  }
  if (imageRegistrySegment(image) !== expected) return image;
  const withoutDigest = imageWithoutDigest(image);
  const firstSlash = withoutDigest.indexOf("/");
  return firstSlash === -1 ? image : `${replacement}/${withoutDigest.slice(firstSlash + 1)}`;
};

const buildkitAddrForConfig = (config: NativeProvisionConfig): string =>
  config.buildkitAddr ??
  process.env.BUILDKIT_ADDR ??
  "tcp://buildkit.buildkit.svc.cluster.local:1234";

const dockerConfigDirHasConfig = (dir: string | undefined): dir is string =>
  dir !== undefined && NodeFS.existsSync(NodePath.join(dir, "config.json"));

const buildkitDockerConfigDir = (config: NativeProvisionConfig): string | undefined => {
  const project = deriveImageProject(config);
  const configsDir = config.buildkitDockerConfigsDir ?? process.env.BUILDKIT_DOCKER_CONFIGS_DIR;
  const projectConfigDir =
    configsDir === undefined ? undefined : NodePath.join(configsDir, project);
  if (dockerConfigDirHasConfig(projectConfigDir)) return projectConfigDir;

  const defaultConfigDir = config.buildkitDockerConfig ?? process.env.BUILDKIT_DOCKER_CONFIG;
  return dockerConfigDirHasConfig(defaultConfigDir) ? defaultConfigDir : undefined;
};

const buildkitEnvForConfig = (config: NativeProvisionConfig): Readonly<Record<string, string>> => {
  const env: Record<string, string> = {};
  const dockerConfigDir = buildkitDockerConfigDir(config);
  if (dockerConfigDir !== undefined) env.DOCKER_CONFIG = dockerConfigDir;

  const harborCaCert = config.buildkitHarborCaCert ?? process.env.BUILDKIT_HARBOR_CA_CERT;
  if (harborCaCert !== undefined && NodeFS.existsSync(harborCaCert)) {
    env.SSL_CERT_FILE = harborCaCert;
  }
  return env;
};

const shouldUseBuildkit = (config: NativeProvisionConfig): boolean => {
  switch (config.imageBuilder) {
    case "buildkit":
      return true;
    case "docker":
      return false;
    case "auto":
      return (
        config.buildkitAddr !== undefined ||
        process.env.BUILDKIT_ADDR !== undefined ||
        config.buildkitDockerConfig !== undefined ||
        process.env.BUILDKIT_DOCKER_CONFIG !== undefined
      );
  }
};

const buildkitBuildArgsForService = (
  config: NativeProvisionConfig,
  targetImage: string,
  build: ParsedComposeBuild,
  composeDir: string,
): {
  readonly args: ReadonlyArray<string>;
  readonly contextPath: string;
} => {
  const contextPath = resolveComposeRelativePath(build.context, composeDir);
  const { dockerfileDir, dockerfileName } = dockerfileLocation(build, contextPath);
  const pushImage = replaceImageRegistry(
    targetImage,
    config.imageRegistry,
    config.imagePushRegistry,
  );
  const args: Array<string> = [
    "--addr",
    buildkitAddrForConfig(config),
    "build",
    "--frontend",
    "dockerfile.v0",
    "--local",
    `context=${contextPath}`,
    "--local",
    `dockerfile=${dockerfileDir}`,
    "--opt",
    `filename=${dockerfileName}`,
  ];
  for (const [key, value] of build.args) {
    args.push("--opt", `build-arg:${key}=${value}`);
  }
  if (build.target !== undefined) {
    args.push("--opt", `target=${build.target}`);
  }
  args.push("--output", `type=image,name=${pushImage},push=true`);
  return { args, contextPath };
};

const dockerConfigPath = (dockerConfigDir?: string) =>
  dockerConfigDir === undefined
    ? process.env.DOCKER_CONFIG === undefined
      ? NodePath.join(NodeOS.homedir(), ".docker", "config.json")
      : NodePath.join(process.env.DOCKER_CONFIG, "config.json")
    : NodePath.join(dockerConfigDir, "config.json");

const dockerAuthHeader = async (
  registry: string,
  dockerConfigDir?: string,
): Promise<string | undefined> => {
  let rawConfig: string;
  try {
    rawConfig = await NodeFSP.readFile(dockerConfigPath(dockerConfigDir), "utf8");
  } catch {
    return undefined;
  }
  const config = JSON.parse(rawConfig) as unknown;
  if (!isRecord(config) || !isRecord(config.auths)) return undefined;
  const auths = config.auths;
  const candidates = [registry, `https://${registry}`, `http://${registry}`];
  for (const candidate of candidates) {
    const auth = auths[candidate];
    if (!isRecord(auth)) continue;
    const encoded = stringOrUndefined(auth.auth);
    if (encoded !== undefined) return `Basic ${encoded}`;
    const username = stringOrUndefined(auth.username);
    const password = stringOrUndefined(auth.password);
    if (username !== undefined && password !== undefined) {
      return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
    }
  }
  return undefined;
};

const harborProjectFromImage = (
  image: string,
):
  | {
      readonly registry: string;
      readonly project: string;
    }
  | undefined => {
  const registry = imageRegistrySegment(image);
  if (registry === undefined || !registry.includes("harbor")) return undefined;
  const parts = imageWithoutDigest(image).split("/");
  const project = parts[1]?.trim();
  return project === undefined || project.length === 0 ? undefined : { registry, project };
};

const harborApiRequestStatus = (
  url: string,
  options: {
    readonly method: "GET" | "POST";
    readonly authorization: string;
    readonly body?: string | undefined;
  },
): Promise<number> =>
  new Promise((resolve, reject) => {
    const request = NodeHttps.request(
      url,
      {
        method: options.method,
        headers: {
          authorization: options.authorization,
          ...(options.body === undefined
            ? {}
            : {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(options.body),
              }),
        },
      },
      (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode ?? 0));
      },
    );
    request.on("error", reject);
    if (options.body !== undefined) request.write(options.body);
    request.end();
  });

const ensureHarborProjectForImage = async (
  config: NativeProvisionConfig,
  image: string,
): Promise<void> => {
  const target = harborProjectFromImage(image);
  if (target === undefined) return;
  const authorization = await dockerAuthHeader(target.registry, buildkitDockerConfigDir(config));
  if (authorization === undefined) return;

  try {
    const projectUrl = `https://${target.registry}/api/v2.0/projects/${encodeURIComponent(target.project)}`;
    const existingStatus = await harborApiRequestStatus(projectUrl, {
      method: "GET",
      authorization,
    });
    if (existingStatus === 200) return;
    if (existingStatus !== 404) return;

    await harborApiRequestStatus(`https://${target.registry}/api/v2.0/projects`, {
      method: "POST",
      authorization,
      body: JSON.stringify({
        project_name: target.project,
        metadata: { public: "true" },
      }),
    });
  } catch {
    // Docker push will still provide the authoritative registry error.
  }
};

const prepareServiceImage = async (
  config: NativeProvisionConfig,
  service: ParsedComposeService,
  composeDir: string,
  runCommand: NativeCommandRunner | undefined,
): Promise<ParsedComposeService> => {
  if (service.build === undefined) return service;
  if (runCommand === undefined) {
    throw new Error(
      `Compose service "${service.name}" has a build definition, but native image build support is not wired into this Code server.`,
    );
  }

  const targetImage = targetImageForBuildService(config, service);
  await ensureHarborProjectForImage(config, targetImage);
  if (shouldUseBuildkit(config)) {
    const { args, contextPath } = buildkitBuildArgsForService(
      config,
      targetImage,
      service.build,
      composeDir,
    );
    await runCommand(config.buildctlPath, args, {
      cwd: contextPath,
      env: buildkitEnvForConfig(config),
    });
  } else {
    const { args, contextPath } = dockerBuildArgsForService(targetImage, service.build, composeDir);
    await runCommand(config.dockerPath, args, { cwd: contextPath });
    await runCommand(config.dockerPath, ["push", targetImage], { cwd: contextPath });
  }
  return targetImage === service.image ? service : { ...service, image: targetImage };
};

const prepareServices = async (
  config: NativeProvisionConfig,
  services: ReadonlyArray<ParsedComposeService>,
  composeDir: string,
  runCommand: NativeCommandRunner | undefined,
): Promise<ReadonlyArray<ParsedComposeService>> => {
  const prepared: Array<ParsedComposeService> = [];
  for (const service of services) {
    prepared.push(await prepareServiceImage(config, service, composeDir, runCommand));
  }
  return prepared;
};

interface AnonymousVolumeSeed {
  readonly name: string;
  readonly sourcePath: string;
}

const volumeMountDocuments = (
  service: ParsedComposeService,
  composeDir: string,
): {
  readonly volumeMounts: Array<Record<string, unknown>>;
  readonly volumes: Array<Record<string, unknown>>;
  readonly anonymousVolumeSeeds: ReadonlyArray<AnonymousVolumeSeed>;
} => {
  const usedNames = new Set<string>();
  const volumeMounts: Array<Record<string, unknown>> = [];
  const volumes: Array<Record<string, unknown>> = [];
  const anonymousVolumeSeeds: AnonymousVolumeSeed[] = [];

  const addEmptyDir = (
    nameBase: string,
    mountPath: string,
    readOnly = false,
    seedFromImage = false,
  ) => {
    const name = uniqueVolumeName(nameBase, usedNames);
    volumeMounts.push({ name, mountPath, readOnly });
    volumes.push({ name, emptyDir: {} });
    if (seedFromImage) anonymousVolumeSeeds.push({ name, sourcePath: mountPath });
  };

  const addHostPath = (source: string, mountPath: string, readOnly = false) => {
    const resolvedSource = resolveVolumeSource(source, composeDir);
    const name = uniqueVolumeName(NodePath.basename(mountPath) || "bind", usedNames);
    volumeMounts.push({ name, mountPath, readOnly });
    volumes.push({
      name,
      hostPath: {
        path: resolvedSource,
        type: hostPathType(resolvedSource),
      },
    });
  };

  for (const rawVolume of service.volumes) {
    if (typeof rawVolume === "string") {
      const parts = splitComposeVolumeSpec(rawVolume);
      if (parts.length === 1) {
        const mountPath = parts[0]?.trim();
        if (mountPath?.startsWith("/")) addEmptyDir(mountPath, mountPath, false, true);
        continue;
      }
      const source = parts[0]?.trim();
      const mountPath = parts[1]?.trim();
      if (!source || !mountPath) continue;
      const readOnly = parts.slice(2).some((part) => part.split(",").includes("ro"));
      if (
        source === "." ||
        source === ".." ||
        source.startsWith("./") ||
        source.startsWith("../") ||
        source.startsWith("/") ||
        source.startsWith("$")
      ) {
        addHostPath(source, mountPath, readOnly);
      } else {
        addEmptyDir(source, mountPath, readOnly);
      }
      continue;
    }

    if (!isRecord(rawVolume)) continue;
    const target = stringOrUndefined(rawVolume.target);
    if (target === undefined) continue;
    const source = stringOrUndefined(rawVolume.source);
    const readOnly = rawVolume.read_only === true || rawVolume.readOnly === true;
    if (rawVolume.type === "bind" && source !== undefined) {
      addHostPath(source, target, readOnly);
    } else {
      addEmptyDir(source ?? target, target, readOnly);
    }
  }

  return { volumeMounts, volumes, anonymousVolumeSeeds };
};

const shellQuote = (value: string): string => `'${value.replace(/'/gu, `'\\''`)}'`;

const anonymousVolumeInitContainer = (
  service: ParsedComposeService,
  seeds: ReadonlyArray<AnonymousVolumeSeed>,
): Record<string, unknown> | null => {
  if (seeds.length === 0) return null;
  const volumeMounts = seeds.map((seed, index) => ({
    name: seed.name,
    mountPath: `/t3code-volume-init/${index}`,
  }));
  const script = seeds
    .map((seed, index) => {
      const source = shellQuote(seed.sourcePath);
      const target = shellQuote(`/t3code-volume-init/${index}`);
      return `if [ -d ${source} ]; then cp -a ${source}/. ${target}/; fi`;
    })
    .join("\n");
  return {
    name: "anonymous-volume-init",
    image: service.image,
    imagePullPolicy: imagePullPolicyForImage(service.image),
    command: ["/bin/sh", "-ec"],
    args: [script],
    volumeMounts,
    resources: {
      requests: { cpu: "10m", memory: "32Mi" },
    },
  };
};

const splitComposeCommand = (value: string): Array<string> => {
  const args: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  const flush = () => {
    if (current.length === 0) return;
    args.push(current);
    current = "";
  };

  for (const character of value) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote !== null) {
      if (character === quote) quote = null;
      else current += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (/\s/u.test(character)) {
      flush();
      continue;
    }
    current += character;
  }
  if (escaped) current += "\\";
  flush();
  return args;
};

const commandArray = (value: unknown): Array<string> | undefined => {
  if (Array.isArray(value)) return value.map((item) => expandEnv(String(item)));
  if (typeof value === "string" && value.trim().length > 0) {
    const args = splitComposeCommand(expandEnv(value));
    return args.length > 0 ? args : undefined;
  }
  return undefined;
};

const durationSeconds = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.max(1, Math.ceil(value / 1_000_000_000));
  }
  if (typeof value !== "string") return undefined;
  const match = /^(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h)$/u.exec(value.trim());
  if (match === null) return undefined;
  const amount = Number.parseFloat(match[1] ?? "");
  const unit = match[2];
  const multiplier =
    unit === "h"
      ? 3600
      : unit === "m"
        ? 60
        : unit === "s"
          ? 1
          : unit === "ms"
            ? 0.001
            : unit === "us" || unit === "µs"
              ? 0.000001
              : 0.000000001;
  return Math.max(1, Math.ceil(amount * multiplier));
};

const positiveInteger = (value: unknown): number | undefined => {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
};

const healthcheckCommand = (test: unknown): ReadonlyArray<string> | undefined => {
  if (typeof test === "string" && test.trim().length > 0) {
    return ["/bin/sh", "-c", expandEnv(test)];
  }
  if (!Array.isArray(test) || test.length === 0) return undefined;
  const [rawMode, ...rawCommand] = test;
  const mode = String(rawMode).toUpperCase();
  if (mode === "NONE") return undefined;
  if (mode === "CMD") return rawCommand.map((item) => expandEnv(String(item)));
  if (mode === "CMD-SHELL") {
    return ["/bin/sh", "-c", rawCommand.map((item) => expandEnv(String(item))).join(" ")];
  }
  return test.map((item) => expandEnv(String(item)));
};

const readinessProbeForHealthcheck = (
  healthcheck: ParsedComposeHealthcheck | undefined,
): Record<string, unknown> | null => {
  if (healthcheck === undefined) return null;
  const command = healthcheckCommand(healthcheck.test);
  if (command === undefined || command.length === 0) return null;
  return {
    exec: { command },
    periodSeconds: durationSeconds(healthcheck.interval) ?? 30,
    timeoutSeconds: durationSeconds(healthcheck.timeout) ?? 30,
    initialDelaySeconds: durationSeconds(healthcheck.startPeriod) ?? 0,
    failureThreshold: positiveInteger(healthcheck.retries) ?? 3,
  };
};

/**
 * Identity a Code server reads back when it discovers a stack it did not create
 * in this process: without it the panel can only show the raw namespace, and
 * start/restart have no worktree to provision from. Annotations rather than
 * labels, since display names and paths are not valid label values.
 */
const buildNamespaceAnnotations = (config: NativeProvisionConfig): Record<string, string> => {
  const annotations: Record<string, string> = {
    "cortex.ai/display-name": config.displayName,
    "cortex.ai/worktree-path": config.worktreePath,
    "cortex.ai/compose-path": config.composePath,
  };
  if (config.displaySlug !== undefined) annotations["cortex.ai/display-slug"] = config.displaySlug;
  if (config.repoName !== undefined) annotations["cortex.ai/repo-name"] = config.repoName;
  if (config.branchName !== undefined) annotations["cortex.ai/branch-name"] = config.branchName;
  return annotations;
};

const buildNamespace = (config: NativeProvisionConfig): KubernetesDocument => ({
  apiVersion: "v1",
  kind: "Namespace",
  metadata: {
    name: config.namespace,
    labels: {
      ...makeLabels(config.id),
      "pod-security.kubernetes.io/enforce": "privileged",
    },
    annotations: buildNamespaceAnnotations(config),
  },
});

const buildForwardedProtoMiddleware = (namespace: string, stackId: string): KubernetesDocument => ({
  apiVersion: "traefik.io/v1alpha1",
  kind: "Middleware",
  metadata: {
    name: "forwarded-proto",
    namespace,
    labels: makeLabels(stackId),
  },
  spec: {
    headers: {
      customRequestHeaders: {
        "X-Forwarded-Proto": "https",
        "X-Forwarded-Port": "443",
      },
    },
  },
});

const buildConfigMap = (
  namespace: string,
  stackId: string,
  service: ParsedComposeService,
): KubernetesDocument | null => {
  if (service.environment.size === 0) return null;
  const name = sanitizeKubernetesName(service.name);
  return {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: {
      name: `${name}-env`,
      namespace,
      labels: makeLabels(stackId, service.name),
    },
    data: Object.fromEntries(service.environment),
  };
};

const imagePullPolicyForImage = (image: string) => {
  if (image.includes("@")) return "IfNotPresent";
  const imageName = image.split("/").at(-1) ?? image;
  const tagSeparatorIndex = imageName.lastIndexOf(":");
  return tagSeparatorIndex === -1 || imageName.slice(tagSeparatorIndex + 1) === "latest"
    ? "Always"
    : "IfNotPresent";
};

const environmentHash = (environment: ReadonlyMap<string, string>): string =>
  NodeCrypto.createHash("sha256")
    .update(JSON.stringify([...environment].sort(([left], [right]) => left.localeCompare(right))))
    .digest("hex");

const buildDeployment = (
  namespace: string,
  stackId: string,
  service: ParsedComposeService,
  composeDir: string,
): KubernetesDocument => {
  const name = sanitizeKubernetesName(service.name);
  const labels = makeLabels(stackId, service.name);
  const { volumeMounts, volumes, anonymousVolumeSeeds } = volumeMountDocuments(service, composeDir);
  const container: Record<string, unknown> = {
    name,
    image: service.image,
    imagePullPolicy: imagePullPolicyForImage(service.image),
  };

  const ports = service.ports.map((port) => ({
    containerPort: port.container,
    protocol: port.protocol.toUpperCase(),
  }));
  if (ports.length > 0) container.ports = ports;
  // The Secret is listed after the ConfigMap so an OpenBao-backed value wins over
  // an empty placeholder of the same name, and marked optional because External
  // Secrets has not materialized it yet in a freshly created namespace.
  const envFrom: Array<Record<string, unknown>> = [];
  if (service.environment.size > 0) {
    envFrom.push({ configMapRef: { name: `${name}-env` } });
  }
  if (isBackendService(service.name)) {
    envFrom.push({ secretRef: { name: BACKEND_SECRETS_NAME, optional: true } });
  }
  if (envFrom.length > 0) container.envFrom = envFrom;
  const command = commandArray(service.entrypoint);
  if (command !== undefined) container.command = command;
  const args = commandArray(service.command);
  if (args !== undefined) container.args = args;
  if (service.workingDir !== undefined) container.workingDir = service.workingDir;
  if (volumeMounts.length > 0) container.volumeMounts = volumeMounts;
  const readinessProbe = readinessProbeForHealthcheck(service.healthcheck);
  if (readinessProbe !== null) container.readinessProbe = readinessProbe;
  container.resources = {
    requests: { cpu: "25m", memory: "128Mi" },
  };

  const podSpec: Record<string, unknown> = {
    containers: [container],
    restartPolicy: "Always",
  };
  if (volumes.length > 0) podSpec.volumes = volumes;
  const initContainer = anonymousVolumeInitContainer(service, anonymousVolumeSeeds);
  if (initContainer !== null) podSpec.initContainers = [initContainer];

  return {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name, namespace, labels },
    spec: {
      replicas: 1,
      selector: { matchLabels: { "app.kubernetes.io/name": name } },
      template: {
        metadata: {
          labels,
          annotations: {
            "t3code.dev/environment-hash": environmentHash(service.environment),
          },
        },
        spec: podSpec,
      },
    },
  };
};

const buildService = (
  namespace: string,
  stackId: string,
  service: ParsedComposeService,
): KubernetesDocument => {
  const name = sanitizeKubernetesName(service.name);
  const ports = servicePortDocuments(service);
  return {
    apiVersion: "v1",
    kind: "Service",
    metadata: {
      name,
      namespace,
      labels: makeLabels(stackId, service.name),
    },
    spec:
      ports.length === 0
        ? {
            clusterIP: "None",
            selector: { "app.kubernetes.io/name": name },
          }
        : {
            type: "ClusterIP",
            selector: { "app.kubernetes.io/name": name },
            ports,
          },
  };
};

const buildIngressRoute = (
  namespace: string,
  stackId: string,
  service: ParsedComposeService,
  previewUrl: string,
): KubernetesDocument | null => {
  if (service.ports.length === 0 || !shouldExposeService(service)) return null;
  const name = sanitizeKubernetesName(service.name);
  return {
    apiVersion: "traefik.io/v1alpha1",
    kind: "IngressRoute",
    metadata: {
      name: `${namespace}-${name}`,
      namespace,
      labels: makeLabels(stackId, service.name),
    },
    spec: {
      entryPoints: ["web"],
      routes: [
        {
          match: `Host(\`${hostnameFromPreviewUrl(previewUrl)}\`)`,
          kind: "Rule",
          services: [{ name, port: service.ports[0]?.container ?? 80 }],
          middlewares: [{ name: "forwarded-proto" }],
        },
      ],
    },
  };
};

export const generateNativeAppDevStackManifests = async (
  config: NativeProvisionConfig,
  runCommand?: NativeCommandRunner,
): Promise<ReadonlyArray<KubernetesDocument>> => {
  const composePath = await resolveComposePath(config);
  const composeRaw = await readComposeFile(config, composePath);
  const compose = parseYamlValue(composeRaw);
  const namespace = config.namespace;
  const stackId = config.id;
  const parsedServices = rewriteComposeHostReferences(config, parseComposeServices(compose));
  if (parsedServices.length === 0) {
    throw new Error(`No services found in app-dev compose file: ${composePath}`);
  }
  const composeDir = NodePath.dirname(composePath);
  const services = await prepareServices(config, parsedServices, composeDir, runCommand);
  const documents: Array<KubernetesDocument> = [
    buildNamespace(config),
    buildForwardedProtoMiddleware(namespace, stackId),
  ];
  // Ahead of the Deployments: the backend reads the Secret this produces via
  // envFrom, so External Secrets should be working on it first.
  if (services.some((service) => isBackendService(service.name))) {
    documents.push(buildBackendExternalSecret(namespace, stackId));
  }

  for (const service of services) {
    const configMap = buildConfigMap(namespace, stackId, service);
    if (configMap !== null) documents.push(configMap);
    documents.push(buildDeployment(namespace, stackId, service, composeDir));
    documents.push(buildService(namespace, stackId, service));
    const previewUrl = configuredPreviewUrl(config, service);
    if (previewUrl !== undefined) {
      const ingressRoute = buildIngressRoute(namespace, stackId, service, previewUrl);
      if (ingressRoute !== null) documents.push(ingressRoute);
    }
  }

  return documents;
};

const stringifyDocuments = (documents: ReadonlyArray<KubernetesDocument>): string =>
  documents
    .map((document) => `---\n${stringifyYamlValue(document, { lineWidth: 1000, version: "1.1" })}`)
    .join("");

export const provisionNativeAppDevStack = async (
  config: NativeProvisionConfig,
  runKubectl: KubectlRunner,
  runCommand?: NativeCommandRunner,
): Promise<void> => {
  const documents = await generateNativeAppDevStackManifests(config, runCommand);
  const tempDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-app-dev-stack-"));
  const manifestPath = NodePath.join(tempDir, `${config.namespace}.yaml`);
  try {
    await NodeFSP.writeFile(manifestPath, stringifyDocuments(documents));
    await runKubectl(["apply", "-f", manifestPath]);
  } finally {
    await NodeFSP.rm(tempDir, { force: true, recursive: true });
  }
};
