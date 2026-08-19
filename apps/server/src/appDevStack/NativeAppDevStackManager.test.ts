// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import type { NativeAppDevStackConfig } from "../config.ts";
import { makeNativeAppDevStackService, type KubectlRunner } from "./NativeAppDevStackManager.ts";
import {
  generateNativeAppDevStackManifests,
  type NativeCommandRunner,
} from "./nativeAppDevStackProvisioning.ts";

const nativeConfig = {
  id: "rudi-dev",
  namespace: "rudi-dev",
  worktreePath: "/home/nils/repos/nils/rudi",
  composePath: "infra/compose/compose.app-dev.yml",
  displayName: "rudi",
  displaySlug: "rudi",
  repoName: "rudi",
  branchName: "dev",
  kubectlPath: "kubectl",
  dockerPath: "docker",
  buildctlPath: "buildctl",
  imageBuilder: "docker",
  imageRegistry: "harbor.nightingale-ai.com",
  imagePushRegistry: undefined,
  imageProject: undefined,
  buildkitAddr: undefined,
  buildkitDockerConfig: undefined,
  buildkitDockerConfigsDir: undefined,
  buildkitHarborCaCert: undefined,
  frontendUrl: "https://rudi-dev.nightingale-ai.com",
  backendUrl: "https://api-rudi-dev.nightingale-ai.com",
  keycloakUrl: "https://rudi-dev-keycloak.nightingale-ai.com",
  minioUrl: "https://minio-rudi-dev.nightingale-ai.com",
} satisfies NativeAppDevStackConfig;

const namespaceJson = JSON.stringify({
  metadata: { creationTimestamp: "2026-06-25T15:50:50.000Z" },
});

const deploymentsJson = JSON.stringify({
  items: [
    {
      metadata: { name: "backend" },
      spec: { replicas: 1 },
      status: { availableReplicas: 1, readyReplicas: 1 },
    },
    {
      metadata: { name: "frontend" },
      spec: { replicas: 1 },
      status: { availableReplicas: 1, readyReplicas: 1 },
    },
  ],
});

const podsJson = JSON.stringify({
  items: [
    {
      metadata: {
        name: "backend-7cdbbbfdd8-l9mpx",
        creationTimestamp: "2026-06-25T16:00:00.000Z",
        ownerReferences: [{ kind: "ReplicaSet", name: "backend-7cdbbbfdd8" }],
      },
      spec: {
        nodeName: "kind-worker",
        containers: [{ name: "backend" }, { name: "sidecar" }],
      },
      status: {
        phase: "Running",
        containerStatuses: [
          {
            name: "backend",
            ready: true,
            restartCount: 1,
            state: { running: {} },
          },
          {
            name: "sidecar",
            ready: false,
            restartCount: 2,
            state: { waiting: { reason: "CrashLoopBackOff" } },
          },
        ],
      },
    },
  ],
});

const makeTempHeroComposeWorktree = (
  serviceLines: ReadonlyArray<string> = [
    "    image: hero-web:latest",
    "    environment:",
    "      PORT: '3000'",
    "    ports:",
    "      - '3000:3000'",
  ],
  basename?: string,
) => {
  const tempRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-native-app-dev-"));
  const tempDir = basename === undefined ? tempRoot : NodePath.join(tempRoot, basename);
  const composeDir = NodePath.join(tempDir, "infra", "compose");
  NodeFS.mkdirSync(composeDir, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(composeDir, "compose.app-dev.yml"),
    ["services:", "  web:", ...serviceLines, ""].join("\n"),
  );
  return tempDir;
};

it.effect("stamps stack identity on the namespace so discovery can name it", () => {
  const tempDir = makeTempHeroComposeWorktree(["    image: hero-web:latest"]);

  return Effect.gen(function* () {
    const documents = yield* Effect.promise(() =>
      generateNativeAppDevStackManifests({
        id: "hero-dev",
        namespace: "hero-dev",
        worktreePath: tempDir,
        composePath: "infra/compose/compose.app-dev.yml",
        displayName: "hero fix-auth",
        displaySlug: "hero-fix-auth",
        repoName: "hero",
        branchName: "fix-auth",
        dockerPath: "docker",
        buildctlPath: "buildctl",
        imageBuilder: "docker",
        imageRegistry: undefined,
        imagePushRegistry: undefined,
        imageProject: undefined,
        buildkitAddr: undefined,
        buildkitDockerConfig: undefined,
        buildkitDockerConfigsDir: undefined,
        buildkitHarborCaCert: undefined,
        frontendUrl: undefined,
        backendUrl: undefined,
        keycloakUrl: undefined,
        minioUrl: undefined,
        preferStackScopedUrls: true,
      }),
    );
    const namespace = documents.find((document) => document.kind === "Namespace");
    const metadata = namespace?.metadata as
      | { readonly annotations?: Record<string, string> }
      | undefined;

    assert.deepEqual(metadata?.annotations, {
      "cortex.ai/display-name": "hero fix-auth",
      "cortex.ai/worktree-path": tempDir,
      "cortex.ai/compose-path": "infra/compose/compose.app-dev.yml",
      "cortex.ai/display-slug": "hero-fix-auth",
      "cortex.ai/repo-name": "hero",
      "cortex.ai/branch-name": "fix-auth",
    });
  }).pipe(
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { force: true, recursive: true }))),
  );
});

it.effect("names a discovered stack from its namespace annotations", () => {
  const namespacesJson = JSON.stringify({
    items: [
      {
        metadata: {
          name: "hero-dev",
          creationTimestamp: "2026-06-25T15:00:00.000Z",
          labels: {
            "cortex.ai/component": "app-dev-stack",
            "cortex.ai/stack-id": "hero-stack",
          },
          annotations: {
            "cortex.ai/display-name": "hero fix-auth",
            "cortex.ai/worktree-path": "/worktrees/hero-fix-auth",
            "cortex.ai/branch-name": "fix-auth",
            "cortex.ai/repo-name": "hero",
          },
        },
      },
    ],
  });
  const runKubectl: KubectlRunner = async (args) => {
    if (args.join(" ") === "get namespaces -l cortex.ai/component=app-dev-stack -o json") {
      return namespacesJson;
    }
    if (args.join(" ") === "get namespace hero-dev -o json") return namespaceJson;
    if (args.join(" ") === "-n hero-dev get deployments -o json") return deploymentsJson;
    throw new Error(`unexpected kubectl call: ${args.join(" ")}`);
  };
  const service = makeNativeAppDevStackService(
    {
      ...nativeConfig,
      id: undefined,
      namespace: undefined,
      worktreePath: undefined,
      displayName: undefined,
      repoName: undefined,
      branchName: undefined,
    },
    runKubectl,
  );

  return Effect.gen(function* () {
    const result = yield* service.list({});

    assert.deepEqual(
      result.stacks.map((stack) => [stack.displayName, stack.branchName, stack.worktreePath]),
      [["hero fix-auth", "fix-auth", "/worktrees/hero-fix-auth"]],
    );
  });
});

it.effect("drops a discovered stack once its namespace leaves the cluster", () => {
  let namespaceExists = true;
  const namespaceItem = {
    metadata: {
      name: "hero-dev",
      creationTimestamp: "2026-06-25T15:00:00.000Z",
      labels: {
        "cortex.ai/component": "app-dev-stack",
        "cortex.ai/stack-id": "hero-stack",
      },
    },
  };
  const runKubectl: KubectlRunner = async (args) => {
    if (args.join(" ") === "get namespaces -l cortex.ai/component=app-dev-stack -o json") {
      return JSON.stringify({ items: namespaceExists ? [namespaceItem] : [] });
    }
    if (args.join(" ") === "get namespace hero-dev -o json") {
      if (!namespaceExists) throw new Error('namespaces "hero-dev" not found');
      return namespaceJson;
    }
    if (args.join(" ") === "-n hero-dev get deployments -o json") return deploymentsJson;
    throw new Error(`unexpected kubectl call: ${args.join(" ")}`);
  };
  const service = makeNativeAppDevStackService(
    {
      ...nativeConfig,
      id: undefined,
      namespace: undefined,
      worktreePath: undefined,
      displayName: undefined,
      repoName: undefined,
      branchName: undefined,
    },
    runKubectl,
  );

  return Effect.gen(function* () {
    const before = yield* service.list({});
    assert.deepEqual(
      before.stacks.map((stack) => stack.namespace),
      ["hero-dev"],
    );

    namespaceExists = false;
    const after = yield* service.list({});
    assert.deepEqual(after.stacks, []);
  });
});

it.effect("keeps a terminating namespace out of the list after delete", () => {
  let deleted = false;
  const namespaceItem = (terminating: boolean) => ({
    metadata: {
      name: "hero-dev",
      creationTimestamp: "2026-06-25T15:00:00.000Z",
      ...(terminating ? { deletionTimestamp: "2026-06-25T16:00:00.000Z" } : {}),
      labels: {
        "cortex.ai/component": "app-dev-stack",
        "cortex.ai/stack-id": "hero-stack",
      },
    },
    ...(terminating ? { status: { phase: "Terminating" } } : {}),
  });
  const runKubectl: KubectlRunner = async (args) => {
    if (args.join(" ") === "get namespaces -l cortex.ai/component=app-dev-stack -o json") {
      return JSON.stringify({ items: [namespaceItem(deleted)] });
    }
    if (args.join(" ") === "delete namespace hero-dev --ignore-not-found") {
      deleted = true;
      return "";
    }
    if (args.join(" ") === "get namespace hero-dev -o json") {
      return JSON.stringify(namespaceItem(deleted));
    }
    if (args.join(" ") === "-n hero-dev get deployments -o json") return deploymentsJson;
    throw new Error(`unexpected kubectl call: ${args.join(" ")}`);
  };
  const service = makeNativeAppDevStackService(
    {
      ...nativeConfig,
      id: undefined,
      namespace: undefined,
      worktreePath: undefined,
      displayName: undefined,
      repoName: undefined,
      branchName: undefined,
    },
    runKubectl,
  );

  return Effect.gen(function* () {
    yield* service.list({});
    const result = yield* service.delete({ stackId: "hero-stack" });
    assert.equal(result.deleted, true);

    const after = yield* service.list({});
    assert.deepEqual(after.stacks, []);
  });
});

it.effect("translates interpolated bind mounts and string commands for Kubernetes", () => {
  const tempDir = makeTempHeroComposeWorktree([
    "    image: quay.io/minio/minio:latest",
    '    command: server /data --console-address ":9001"',
    "    volumes:",
    "      - ${T3_TEST_APP_DATA_PATH:-../t3-app-data}:/data:rw",
    "    ports:",
    "      - '9000:9000'",
  ]);

  return Effect.gen(function* () {
    const documents = yield* Effect.promise(() =>
      generateNativeAppDevStackManifests({
        id: "hero-dev",
        namespace: "hero-dev",
        worktreePath: tempDir,
        composePath: "infra/compose/compose.app-dev.yml",
        displayName: "hero",
        displaySlug: undefined,
        repoName: "hero",
        branchName: "main",
        dockerPath: "docker",
        buildctlPath: "buildctl",
        imageBuilder: "docker",
        imageRegistry: undefined,
        imagePushRegistry: undefined,
        imageProject: undefined,
        buildkitAddr: undefined,
        buildkitDockerConfig: undefined,
        buildkitDockerConfigsDir: undefined,
        buildkitHarborCaCert: undefined,
        frontendUrl: undefined,
        backendUrl: undefined,
        keycloakUrl: undefined,
        minioUrl: undefined,
        preferStackScopedUrls: true,
      }),
    );
    const deployment = documents.find((document) => document.kind === "Deployment");
    const spec = deployment?.spec as
      | {
          readonly template: {
            readonly spec: {
              readonly containers: ReadonlyArray<{ readonly args?: unknown }>;
              readonly volumes: ReadonlyArray<{
                readonly hostPath?: { readonly path?: unknown };
              }>;
            };
          };
        }
      | undefined;
    const container = spec?.template.spec.containers[0];

    assert.deepEqual(container?.args, ["server", "/data", "--console-address", ":9001"]);
    assert.equal(
      spec?.template.spec.volumes[0]?.hostPath?.path,
      NodePath.join(tempDir, "infra", "t3-app-data"),
    );
  }).pipe(
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { force: true, recursive: true }))),
  );
});

it.effect("rewrites Compose host port references to Kubernetes service DNS", () => {
  const tempDir = makeTempHeroComposeWorktree([
    "    image: hero-web:latest",
    "    labels:",
    "      rudi.appDevStack.hostname: rudi-dev.nightingale-ai.com",
    "    environment:",
    "      DATABASE_URL: postgresql://host.containers.internal:7013/hero",
    "      EXTERNAL_URL: http://host.containers.internal:7999",
    "      PUBLIC_URL: https://rudi-dev.nightingale-ai.com/assets",
    "  postgres:",
    "    image: postgres:17-alpine",
    "    ports:",
    "      - '7013:5432'",
  ]);

  return Effect.gen(function* () {
    const documents = yield* Effect.promise(() =>
      generateNativeAppDevStackManifests({
        id: "hero-dev",
        namespace: "hero-dev",
        worktreePath: tempDir,
        composePath: "infra/compose/compose.app-dev.yml",
        displayName: "hero",
        displaySlug: undefined,
        repoName: "hero",
        branchName: "main",
        dockerPath: "docker",
        buildctlPath: "buildctl",
        imageBuilder: "docker",
        imageRegistry: undefined,
        imagePushRegistry: undefined,
        imageProject: undefined,
        buildkitAddr: undefined,
        buildkitDockerConfig: undefined,
        buildkitDockerConfigsDir: undefined,
        buildkitHarborCaCert: undefined,
        frontendUrl: undefined,
        backendUrl: undefined,
        keycloakUrl: undefined,
        minioUrl: undefined,
        preferStackScopedUrls: true,
      }),
    );
    const configMap = documents.find(
      (document) =>
        document.kind === "ConfigMap" &&
        (document.metadata as { readonly name?: unknown } | undefined)?.name === "web-env",
    );
    const deployment = documents.find(
      (document) =>
        document.kind === "Deployment" &&
        (document.metadata as { readonly name?: unknown } | undefined)?.name === "web",
    );
    const data = configMap?.data as Readonly<Record<string, unknown>> | undefined;
    const templateMetadata = (
      deployment?.spec as
        | {
            readonly template?: {
              readonly metadata?: { readonly annotations?: Readonly<Record<string, unknown>> };
            };
          }
        | undefined
    )?.template?.metadata;

    assert.equal(data?.DATABASE_URL, "postgresql://postgres:5432/hero");
    assert.equal(data?.EXTERNAL_URL, "http://host.containers.internal:7999");
    assert.equal(data?.PUBLIC_URL, "https://hero-dev.nightingale-ai.com/assets");
    assert.equal(data?.CI, "true");
    assert.match(
      String(templateMetadata?.annotations?.["t3code.dev/environment-hash"]),
      /^[a-f\d]{64}$/u,
    );
  }).pipe(
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { force: true, recursive: true }))),
  );
});

it.effect("seeds anonymous Compose volumes from the container image", () => {
  const tempDir = makeTempHeroComposeWorktree([
    "    image: hero-web:latest",
    "    healthcheck:",
    "      test: ['CMD', 'wget', '-qO-', 'http://127.0.0.1:3000/health']",
    "      interval: 5s",
    "      timeout: 2s",
    "      start_period: 10s",
    "      retries: 4",
    "    volumes:",
    "      - /app/node_modules",
    "      - /app/packages/ui/node_modules",
    "      - hero-data:/data",
  ]);

  return Effect.gen(function* () {
    const documents = yield* Effect.promise(() =>
      generateNativeAppDevStackManifests({
        id: "hero-dev",
        namespace: "hero-dev",
        worktreePath: tempDir,
        composePath: "infra/compose/compose.app-dev.yml",
        displayName: "hero",
        displaySlug: undefined,
        repoName: "hero",
        branchName: "main",
        dockerPath: "docker",
        buildctlPath: "buildctl",
        imageBuilder: "docker",
        imageRegistry: undefined,
        imagePushRegistry: undefined,
        imageProject: undefined,
        buildkitAddr: undefined,
        buildkitDockerConfig: undefined,
        buildkitDockerConfigsDir: undefined,
        buildkitHarborCaCert: undefined,
        frontendUrl: undefined,
        backendUrl: undefined,
        keycloakUrl: undefined,
        minioUrl: undefined,
        preferStackScopedUrls: true,
      }),
    );
    const deployment = documents.find((document) => document.kind === "Deployment");
    const podSpec = (
      deployment?.spec as
        | {
            readonly template?: {
              readonly spec?: {
                readonly initContainers?: ReadonlyArray<Readonly<Record<string, unknown>>>;
                readonly containers?: ReadonlyArray<Readonly<Record<string, unknown>>>;
              };
            };
          }
        | undefined
    )?.template?.spec;
    const initContainer = podSpec?.initContainers?.[0];
    const container = podSpec?.containers?.[0];
    const initMounts = initContainer?.volumeMounts as
      | ReadonlyArray<{ readonly name?: unknown; readonly mountPath?: unknown }>
      | undefined;

    assert.deepEqual(initContainer?.command, ["/bin/sh", "-ec"]);
    assert.lengthOf(initMounts ?? [], 2);
    assert.notInclude(
      (initMounts ?? []).map((mount) => mount.name),
      "hero-data",
    );
    assert.include(
      String((initContainer?.args as ReadonlyArray<unknown> | undefined)?.[0]),
      "/app/node_modules",
    );
    assert.include(
      String((initContainer?.args as ReadonlyArray<unknown> | undefined)?.[0]),
      "/app/packages/ui/node_modules",
    );
    assert.deepEqual(container?.readinessProbe, {
      exec: { command: ["wget", "-qO-", "http://127.0.0.1:3000/health"] },
      periodSeconds: 5,
      timeoutSeconds: 2,
      initialDelaySeconds: 10,
      failureThreshold: 4,
    });
    assert.notProperty(
      (initContainer?.resources as Readonly<Record<string, unknown>> | undefined) ?? {},
      "limits",
    );
    assert.notProperty(
      (container?.resources as Readonly<Record<string, unknown>> | undefined) ?? {},
      "limits",
    );
  }).pipe(
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { force: true, recursive: true }))),
  );
});

it.effect("reports the configured Rudi stack from Kubernetes deployments", () => {
  const calls: Array<ReadonlyArray<string>> = [];
  const runKubectl: KubectlRunner = async (args) => {
    calls.push(args);
    if (args.join(" ") === "get namespace rudi-dev -o json") return namespaceJson;
    if (args.join(" ") === "-n rudi-dev get deployments -o json") return deploymentsJson;
    throw new Error(`unexpected kubectl call: ${args.join(" ")}`);
  };
  const service = makeNativeAppDevStackService(nativeConfig, runKubectl);

  return Effect.gen(function* () {
    const result = yield* service.getByWorktree({ worktreePath: "/home/nils/repos/nils/rudi/" });

    assert.equal(result.frontendUrl, "https://rudi-dev.nightingale-ai.com");
    assert.equal(result.frontendServiceName, "frontend");
    assert.equal(result.stack?.status, "running");
    assert.equal(result.stack?.namespace, "rudi-dev");
    assert.deepEqual(
      result.stack?.services?.map((item) => [item.name, item.status, item.previewUrl]),
      [
        ["frontend", "running", "https://rudi-dev.nightingale-ai.com"],
        ["backend", "running", "https://api-rudi-dev.nightingale-ai.com"],
      ],
    );
    assert.deepEqual(calls, [
      ["get", "namespace", "rudi-dev", "-o", "json"],
      ["-n", "rudi-dev", "get", "deployments", "-o", "json"],
      ["-n", "rudi-dev", "get", "ingressroutes.traefik.io", "-o", "json"],
    ]);
  });
});

it.effect(
  "reports conventional preview URLs for native web, api, keycloak, and minio services",
  () => {
    const deployments = JSON.stringify({
      items: [
        {
          metadata: { name: "web" },
          spec: { replicas: 1 },
          status: { availableReplicas: 1, readyReplicas: 1 },
        },
        {
          metadata: { name: "api" },
          spec: { replicas: 1 },
          status: { availableReplicas: 1, readyReplicas: 1 },
        },
        {
          metadata: { name: "keycloak" },
          spec: { replicas: 1 },
          status: { availableReplicas: 1, readyReplicas: 1 },
        },
        {
          metadata: { name: "minio" },
          spec: { replicas: 1 },
          status: { availableReplicas: 1, readyReplicas: 1 },
        },
      ],
    });
    const runKubectl: KubectlRunner = async (args) => {
      if (args.join(" ") === "get namespace hero-dev -o json") return namespaceJson;
      if (args.join(" ") === "-n hero-dev get deployments -o json") return deployments;
      if (args.join(" ") === "-n hero-dev get ingressroutes.traefik.io -o json") {
        return JSON.stringify({ items: [] });
      }
      if (args.join(" ") === "-n hero-dev get ingress -o json") {
        return JSON.stringify({ items: [] });
      }
      throw new Error(`unexpected kubectl call: ${args.join(" ")}`);
    };
    const service = makeNativeAppDevStackService(nativeConfig, runKubectl);

    return Effect.gen(function* () {
      const result = yield* service.getByWorktree({ worktreePath: "/home/nils/repos/nils/hero" });
      const urls = new Map(result.stack?.services?.map((item) => [item.name, item.previewUrl]));

      assert.equal(urls.get("web"), "https://hero-dev.nightingale-ai.com");
      assert.equal(urls.get("api"), "https://api-hero-dev.nightingale-ai.com");
      assert.equal(urls.get("keycloak"), "https://hero-dev-keycloak.nightingale-ai.com");
      assert.equal(urls.get("minio"), "https://minio-hero-dev.nightingale-ai.com");
      assert.equal(result.frontendUrl, "https://hero-dev.nightingale-ai.com");
      assert.equal(result.frontendServiceName, "web");
      assert.deepEqual(result.stack?.previewUrls, {
        web: "https://hero-dev.nightingale-ai.com",
        api: "https://api-hero-dev.nightingale-ai.com",
        keycloak: "https://hero-dev-keycloak.nightingale-ai.com",
        minio: "https://minio-hero-dev.nightingale-ai.com",
      });
    });
  },
);

it.effect("keeps derived worktree preview URLs scoped to their namespace", () => {
  const deployments = JSON.stringify({
    items: [
      {
        metadata: { name: "web" },
        spec: { replicas: 1 },
        status: { availableReplicas: 1, readyReplicas: 1 },
      },
    ],
  });
  const ingressRoutes = JSON.stringify({
    items: [
      {
        spec: {
          routes: [
            {
              match: "Host(`hero-preview.example.test`)",
              services: [{ name: "web" }],
            },
          ],
        },
      },
    ],
  });
  const runKubectl: KubectlRunner = async (args) => {
    if (args.join(" ") === "get namespace hero-dev -o json") return namespaceJson;
    if (args.join(" ") === "-n hero-dev get deployments -o json") return deployments;
    if (args.join(" ") === "-n hero-dev get ingressroutes.traefik.io -o json") {
      return ingressRoutes;
    }
    throw new Error(`unexpected kubectl call: ${args.join(" ")}`);
  };
  const service = makeNativeAppDevStackService(nativeConfig, runKubectl);

  return Effect.gen(function* () {
    const result = yield* service.getByWorktree({ worktreePath: "/home/nils/repos/nils/hero" });

    assert.equal(result.stack?.services?.[0]?.previewUrl, "https://hero-dev.nightingale-ai.com");
    assert.equal(result.frontendUrl, "https://hero-dev.nightingale-ai.com");
    assert.deepEqual(result.stack?.previewUrls, {
      web: "https://hero-dev.nightingale-ai.com",
    });
  });
});

it.effect("lists pods with container readiness and restart counts", () => {
  const calls: Array<ReadonlyArray<string>> = [];
  const runKubectl: KubectlRunner = async (args) => {
    calls.push(args);
    if (args.join(" ") === "-n rudi-dev get pods -o json") return podsJson;
    throw new Error(`unexpected kubectl call: ${args.join(" ")}`);
  };
  const service = makeNativeAppDevStackService(nativeConfig, runKubectl);

  return Effect.gen(function* () {
    const result = yield* service.listPods({ stackId: "rudi-dev" });

    assert.equal(result.stackId, "rudi-dev");
    assert.equal(result.namespace, "rudi-dev");
    assert.deepEqual(
      result.pods.map((pod) => ({
        name: pod.name,
        phase: pod.phase,
        readyContainerCount: pod.readyContainerCount,
        totalContainerCount: pod.totalContainerCount,
        restartCount: pod.restartCount,
        ownerKind: pod.ownerKind,
        ownerName: pod.ownerName,
        previewUrl: pod.previewUrl,
        previewServiceName: pod.previewServiceName,
        containers: pod.containers,
      })),
      [
        {
          name: "backend-7cdbbbfdd8-l9mpx",
          phase: "Running",
          readyContainerCount: 1,
          totalContainerCount: 2,
          restartCount: 3,
          ownerKind: "ReplicaSet",
          ownerName: "backend-7cdbbbfdd8",
          previewUrl: "https://api-rudi-dev.nightingale-ai.com",
          previewServiceName: "backend",
          containers: [
            { name: "backend", ready: true, restartCount: 1, state: "running" },
            { name: "sidecar", ready: false, restartCount: 2, state: "CrashLoopBackOff" },
          ],
        },
      ],
    );
    assert.deepEqual(calls, [
      ["-n", "rudi-dev", "get", "ingressroutes.traefik.io", "-o", "json"],
      ["-n", "rudi-dev", "get", "pods", "-o", "json"],
    ]);
  });
});

it.effect("reads bounded logs for a validated pod container", () => {
  const calls: Array<ReadonlyArray<string>> = [];
  const runKubectl: KubectlRunner = async (args) => {
    calls.push(args);
    if (args.join(" ") === "-n rudi-dev get pods -o json") return podsJson;
    if (args.join(" ") === "-n rudi-dev logs backend-7cdbbbfdd8-l9mpx -c sidecar --tail=42") {
      return "sidecar log line\n";
    }
    throw new Error(`unexpected kubectl call: ${args.join(" ")}`);
  };
  const service = makeNativeAppDevStackService(nativeConfig, runKubectl);

  return Effect.gen(function* () {
    const result = yield* service.getPodLogs({
      stackId: "rudi-dev",
      podName: "backend-7cdbbbfdd8-l9mpx",
      containerName: "sidecar",
      tailLines: 42,
    });

    assert.equal(result.podName, "backend-7cdbbbfdd8-l9mpx");
    assert.equal(result.containerName, "sidecar");
    assert.equal(result.tailLines, 42);
    assert.equal(result.logs, "sidecar log line\n");
    assert.deepEqual(calls, [
      ["-n", "rudi-dev", "get", "pods", "-o", "json"],
      ["-n", "rudi-dev", "logs", "backend-7cdbbbfdd8-l9mpx", "-c", "sidecar", "--tail=42"],
    ]);
  });
});

it.effect("aggregates logs for every reported pod container with the default tail", () => {
  const calls: Array<ReadonlyArray<string>> = [];
  const runKubectl: KubectlRunner = async (args) => {
    calls.push(args);
    if (args.join(" ") === "-n rudi-dev get pods -o json") return podsJson;
    if (args.join(" ") === "-n rudi-dev logs backend-7cdbbbfdd8-l9mpx -c backend --tail=300") {
      return "backend log line\n";
    }
    if (args.join(" ") === "-n rudi-dev logs backend-7cdbbbfdd8-l9mpx -c sidecar --tail=300") {
      return "sidecar log line\n";
    }
    throw new Error(`unexpected kubectl call: ${args.join(" ")}`);
  };
  const service = makeNativeAppDevStackService(nativeConfig, runKubectl);

  return Effect.gen(function* () {
    const result = yield* service.getStackPodLogs({ stackId: "rudi-dev" });

    assert.equal(result.stackId, "rudi-dev");
    assert.equal(result.namespace, "rudi-dev");
    assert.equal(result.tailLines, 300);
    assert.deepEqual(
      result.entries.map((entry) => ({
        podName: entry.podName,
        containerName: entry.containerName,
        phase: entry.phase,
        ready: entry.ready,
        restartCount: entry.restartCount,
        state: entry.state,
        ownerKind: entry.ownerKind,
        ownerName: entry.ownerName,
        logs: entry.logs,
        error: entry.error,
      })),
      [
        {
          podName: "backend-7cdbbbfdd8-l9mpx",
          containerName: "backend",
          phase: "Running",
          ready: true,
          restartCount: 1,
          state: "running",
          ownerKind: "ReplicaSet",
          ownerName: "backend-7cdbbbfdd8",
          logs: "backend log line\n",
          error: null,
        },
        {
          podName: "backend-7cdbbbfdd8-l9mpx",
          containerName: "sidecar",
          phase: "Running",
          ready: false,
          restartCount: 2,
          state: "CrashLoopBackOff",
          ownerKind: "ReplicaSet",
          ownerName: "backend-7cdbbbfdd8",
          logs: "sidecar log line\n",
          error: null,
        },
      ],
    );
    assert.deepEqual(calls, [
      ["-n", "rudi-dev", "get", "pods", "-o", "json"],
      ["-n", "rudi-dev", "logs", "backend-7cdbbbfdd8-l9mpx", "-c", "backend", "--tail=300"],
      ["-n", "rudi-dev", "logs", "backend-7cdbbbfdd8-l9mpx", "-c", "sidecar", "--tail=300"],
    ]);
  });
});

it.effect("honors bounded aggregate log tail values", () => {
  const calls: Array<ReadonlyArray<string>> = [];
  const runKubectl: KubectlRunner = async (args) => {
    calls.push(args);
    if (args.join(" ") === "-n rudi-dev get pods -o json") return podsJson;
    if (args.join(" ") === "-n rudi-dev logs backend-7cdbbbfdd8-l9mpx -c backend --tail=5000") {
      return "backend log line\n";
    }
    if (args.join(" ") === "-n rudi-dev logs backend-7cdbbbfdd8-l9mpx -c sidecar --tail=5000") {
      return "sidecar log line\n";
    }
    throw new Error(`unexpected kubectl call: ${args.join(" ")}`);
  };
  const service = makeNativeAppDevStackService(nativeConfig, runKubectl);

  return Effect.gen(function* () {
    const result = yield* service.getStackPodLogs({ stackId: "rudi-dev", tailLines: 5000 });

    assert.equal(result.tailLines, 5000);
    assert.deepEqual(calls, [
      ["-n", "rudi-dev", "get", "pods", "-o", "json"],
      ["-n", "rudi-dev", "logs", "backend-7cdbbbfdd8-l9mpx", "-c", "backend", "--tail=5000"],
      ["-n", "rudi-dev", "logs", "backend-7cdbbbfdd8-l9mpx", "-c", "sidecar", "--tail=5000"],
    ]);
  });
});

it.effect("keeps successful aggregate log entries when a container log read fails", () => {
  const calls: Array<ReadonlyArray<string>> = [];
  const runKubectl: KubectlRunner = async (args) => {
    calls.push(args);
    if (args.join(" ") === "-n rudi-dev get pods -o json") return podsJson;
    if (args.join(" ") === "-n rudi-dev logs backend-7cdbbbfdd8-l9mpx -c backend --tail=1000") {
      return "backend log line\n";
    }
    if (args.join(" ") === "-n rudi-dev logs backend-7cdbbbfdd8-l9mpx -c sidecar --tail=1000") {
      throw new Error("sidecar logs unavailable");
    }
    throw new Error(`unexpected kubectl call: ${args.join(" ")}`);
  };
  const service = makeNativeAppDevStackService(nativeConfig, runKubectl);

  return Effect.gen(function* () {
    const result = yield* service.getStackPodLogs({ stackId: "rudi-dev", tailLines: 1000 });

    assert.deepEqual(
      result.entries.map((entry) => ({
        containerName: entry.containerName,
        logs: entry.logs,
        error: entry.error,
      })),
      [
        { containerName: "backend", logs: "backend log line\n", error: null },
        { containerName: "sidecar", logs: "", error: "sidecar logs unavailable" },
      ],
    );
    assert.deepEqual(calls, [
      ["-n", "rudi-dev", "get", "pods", "-o", "json"],
      ["-n", "rudi-dev", "logs", "backend-7cdbbbfdd8-l9mpx", "-c", "backend", "--tail=1000"],
      ["-n", "rudi-dev", "logs", "backend-7cdbbbfdd8-l9mpx", "-c", "sidecar", "--tail=1000"],
    ]);
  });
});

it.effect(
  "discovers app-dev stack namespaces by component label and includes t3code and tilt stacks",
  () => {
    const calls: Array<ReadonlyArray<string>> = [];
    const namespacesJson = JSON.stringify({
      items: [
        {
          metadata: {
            name: "hero-dev",
            creationTimestamp: "2026-06-25T15:00:00.000Z",
            labels: {
              "cortex.ai/component": "app-dev-stack",
              "cortex.ai/stack-id": "hero-stack",
              "app.kubernetes.io/managed-by": "tilt",
            },
          },
        },
        {
          metadata: {
            name: "rudi-dev",
            creationTimestamp: "2026-06-25T15:30:00.000Z",
            labels: {
              "cortex.ai/component": "app-dev-stack",
              "cortex.ai/stack-id": "rudi-dev",
              "app.kubernetes.io/managed-by": "t3code",
            },
          },
        },
      ],
    });
    const runKubectl: KubectlRunner = async (args) => {
      calls.push(args);
      if (args.join(" ") === "get namespaces -l cortex.ai/component=app-dev-stack -o json") {
        return namespacesJson;
      }
      if (args.join(" ") === "get namespace hero-dev -o json") return namespaceJson;
      if (args.join(" ") === "get namespace rudi-dev -o json") return namespaceJson;
      if (args.join(" ") === "-n hero-dev get deployments -o json") return deploymentsJson;
      if (args.join(" ") === "-n rudi-dev get deployments -o json") return deploymentsJson;
      throw new Error(`unexpected kubectl call: ${args.join(" ")}`);
    };
    const service = makeNativeAppDevStackService(
      {
        ...nativeConfig,
        id: undefined,
        namespace: undefined,
        worktreePath: undefined,
        displayName: undefined,
        repoName: undefined,
        branchName: undefined,
      },
      runKubectl,
    );

    return Effect.gen(function* () {
      const result = yield* service.list({});

      assert.deepEqual(
        result.stacks.map((stack) => [stack.id, stack.namespace]),
        [
          ["hero-stack", "hero-dev"],
          ["rudi-dev", "rudi-dev"],
        ],
      );
      assert.deepEqual(calls[0], [
        "get",
        "namespaces",
        "-l",
        "cortex.ai/component=app-dev-stack",
        "-o",
        "json",
      ]);
    });
  },
);

it.effect("resolves an unknown stack id after app-dev namespace discovery", () => {
  const calls: Array<ReadonlyArray<string>> = [];
  const namespacesJson = JSON.stringify({
    items: [
      {
        metadata: {
          name: "hero-dev",
          labels: {
            "cortex.ai/component": "app-dev-stack",
            "cortex.ai/stack-id": "hero-stack",
            "app.kubernetes.io/managed-by": "tilt",
          },
        },
      },
    ],
  });
  const runKubectl: KubectlRunner = async (args) => {
    calls.push(args);
    if (args.join(" ") === "get namespaces -l cortex.ai/component=app-dev-stack -o json") {
      return namespacesJson;
    }
    if (args.join(" ") === "-n hero-dev get pods -o json") return podsJson;
    throw new Error(`unexpected kubectl call: ${args.join(" ")}`);
  };
  const service = makeNativeAppDevStackService(
    {
      ...nativeConfig,
      id: undefined,
      namespace: undefined,
      worktreePath: undefined,
      displayName: undefined,
      repoName: undefined,
      branchName: undefined,
    },
    runKubectl,
  );

  return Effect.gen(function* () {
    const result = yield* service.listPods({ stackId: "hero-stack" });

    assert.equal(result.stackId, "hero-stack");
    assert.equal(result.namespace, "hero-dev");
    assert.equal(result.pods.length, 1);
    assert.deepEqual(calls, [
      ["get", "namespaces", "-l", "cortex.ai/component=app-dev-stack", "-o", "json"],
      ["-n", "hero-dev", "get", "ingressroutes.traefik.io", "-o", "json"],
      ["-n", "hero-dev", "get", "pods", "-o", "json"],
    ]);
  });
});

it.effect(
  "aggregates all discovered stack logs while isolating stack and container failures",
  () => {
    const calls: Array<ReadonlyArray<string>> = [];
    const namespacesJson = JSON.stringify({
      items: [
        {
          metadata: {
            name: "hero-dev",
            labels: {
              "cortex.ai/component": "app-dev-stack",
              "cortex.ai/stack-id": "hero-stack",
              "app.kubernetes.io/managed-by": "tilt",
            },
          },
        },
        {
          metadata: {
            name: "rudi-dev",
            labels: {
              "cortex.ai/component": "app-dev-stack",
              "cortex.ai/stack-id": "rudi-dev",
              "app.kubernetes.io/managed-by": "t3code",
            },
          },
        },
      ],
    });
    const runKubectl: KubectlRunner = async (args) => {
      calls.push(args);
      if (args.join(" ") === "get namespaces -l cortex.ai/component=app-dev-stack -o json") {
        return namespacesJson;
      }
      if (args.join(" ") === "-n hero-dev get pods -o json") return podsJson;
      if (args.join(" ") === "-n rudi-dev get pods -o json") throw new Error("rudi API timeout");
      if (args.join(" ") === "-n hero-dev logs backend-7cdbbbfdd8-l9mpx -c backend --tail=300") {
        return "backend log line\n";
      }
      if (args.join(" ") === "-n hero-dev logs backend-7cdbbbfdd8-l9mpx -c sidecar --tail=300") {
        throw new Error("sidecar logs unavailable");
      }
      throw new Error(`unexpected kubectl call: ${args.join(" ")}`);
    };
    const service = makeNativeAppDevStackService(
      {
        ...nativeConfig,
        id: undefined,
        namespace: undefined,
        worktreePath: undefined,
        displayName: undefined,
        repoName: undefined,
        branchName: undefined,
      },
      runKubectl,
    );

    return Effect.gen(function* () {
      const result = yield* service.getAllStackPodLogs({});

      assert.deepEqual(
        result.stacks.map((stack) => ({
          stackId: stack.stackId,
          namespace: stack.namespace,
          managedBy: stack.managedBy,
          entryErrors: stack.entries.map((entry) => entry.error),
          error: stack.error,
        })),
        [
          {
            stackId: "hero-stack",
            namespace: "hero-dev",
            managedBy: "tilt",
            entryErrors: [null, "sidecar logs unavailable"],
            error: null,
          },
          {
            stackId: "rudi-dev",
            namespace: "rudi-dev",
            managedBy: "t3code",
            entryErrors: [],
            error: "rudi API timeout",
          },
        ],
      );
      assert.equal(result.limit.mode, "tail");
      assert.equal(result.limit.mode === "tail" ? result.limit.tailLines : null, 300);
    });
  },
);

it.effect("omits kubectl --tail when reading all available discovered stack logs", () => {
  const calls: Array<ReadonlyArray<string>> = [];
  const namespacesJson = JSON.stringify({
    items: [
      {
        metadata: {
          name: "hero-dev",
          labels: {
            "cortex.ai/component": "app-dev-stack",
            "cortex.ai/stack-id": "hero-stack",
          },
        },
      },
    ],
  });
  const runKubectl: KubectlRunner = async (args) => {
    calls.push(args);
    if (args.join(" ") === "get namespaces -l cortex.ai/component=app-dev-stack -o json") {
      return namespacesJson;
    }
    if (args.join(" ") === "-n hero-dev get pods -o json") return podsJson;
    if (args.join(" ") === "-n hero-dev logs backend-7cdbbbfdd8-l9mpx -c backend") {
      return "backend log line\n";
    }
    if (args.join(" ") === "-n hero-dev logs backend-7cdbbbfdd8-l9mpx -c sidecar") {
      return "sidecar log line\n";
    }
    throw new Error(`unexpected kubectl call: ${args.join(" ")}`);
  };
  const service = makeNativeAppDevStackService(
    {
      ...nativeConfig,
      id: undefined,
      namespace: undefined,
      worktreePath: undefined,
      displayName: undefined,
      repoName: undefined,
      branchName: undefined,
    },
    runKubectl,
  );

  return Effect.gen(function* () {
    const result = yield* service.getAllStackPodLogs({ limit: { mode: "all" } });

    assert.equal(result.limit.mode, "all");
    assert.equal(
      calls.some((args) => args.some((arg) => arg.startsWith("--tail="))),
      false,
    );
  });
});

it.effect("scales deployments when auto-creating an existing native stack", () => {
  const tempDir = makeTempHeroComposeWorktree(undefined, "rudi");
  const calls: Array<ReadonlyArray<string>> = [];
  const runKubectl: KubectlRunner = async (args) => {
    calls.push(args);
    if (args.join(" ") === "get namespace rudi-dev -o json") return namespaceJson;
    if (args.join(" ") === "-n rudi-dev get deployments -o json") return deploymentsJson;
    if (args[0] === "apply" && args[1] === "-f" && typeof args[2] === "string") return "";
    if (args.join(" ") === "-n rudi-dev scale deployment --all --replicas=1") return "";
    throw new Error(`unexpected kubectl call: ${args.join(" ")}`);
  };
  const service = makeNativeAppDevStackService(
    {
      ...nativeConfig,
      worktreePath: tempDir,
    },
    runKubectl,
  );

  return Effect.gen(function* () {
    const result = yield* service.autoCreate({
      worktreePath: tempDir,
      displayName: "rudi",
      gitBranch: "dev",
    });

    assert.equal(result.created, false);
    assert.equal(result.stack?.status, "running");
    assert.deepEqual(calls, [
      ["get", "namespace", "rudi-dev", "-o", "json"],
      ["-n", "rudi-dev", "get", "deployments", "-o", "json"],
      ["apply", "-f", calls[2]?.[2] ?? ""],
      ["-n", "rudi-dev", "scale", "deployment", "--all", "--replicas=1"],
      ["get", "namespace", "rudi-dev", "-o", "json"],
      ["-n", "rudi-dev", "get", "deployments", "-o", "json"],
      ["-n", "rudi-dev", "get", "ingressroutes.traefik.io", "-o", "json"],
    ]);
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => NodeFS.rmSync(NodePath.dirname(tempDir), { force: true, recursive: true })),
    ),
  );
});

it.effect("derives a native namespace for a different worktree instead of rejecting it", () => {
  const tempDir = makeTempHeroComposeWorktree(undefined, "hero");
  const calls: Array<ReadonlyArray<string>> = [];
  const runKubectl: KubectlRunner = async (args) => {
    calls.push(args);
    if (args.join(" ") === "get namespace hero-dev -o json") return namespaceJson;
    if (args.join(" ") === "-n hero-dev get deployments -o json") return deploymentsJson;
    if (args[0] === "apply" && args[1] === "-f" && typeof args[2] === "string") return "";
    if (args.join(" ") === "-n hero-dev scale deployment --all --replicas=1") return "";
    throw new Error(`unexpected kubectl call: ${args.join(" ")}`);
  };
  const service = makeNativeAppDevStackService(nativeConfig, runKubectl);

  return Effect.gen(function* () {
    const result = yield* service.autoCreate({
      worktreePath: tempDir,
      displayName: "hero",
      gitBranch: "main",
    });

    assert.equal(result.created, false);
    assert.equal(result.stack?.id, "hero-dev");
    assert.equal(result.stack?.namespace, "hero-dev");
    assert.equal(result.stack?.worktreePath, tempDir);
    assert.equal(result.stack?.repoName, "hero");
    assert.equal(result.stack?.branchName, "main");
    assert.equal(result.frontendUrl, "https://hero-dev.nightingale-ai.com");
    assert.equal(result.frontendServiceName, "frontend");
    assert.deepEqual(calls, [
      ["get", "namespace", "hero-dev", "-o", "json"],
      ["-n", "hero-dev", "get", "deployments", "-o", "json"],
      ["apply", "-f", calls[2]?.[2] ?? ""],
      ["-n", "hero-dev", "scale", "deployment", "--all", "--replicas=1"],
      ["get", "namespace", "hero-dev", "-o", "json"],
      ["-n", "hero-dev", "get", "deployments", "-o", "json"],
      ["-n", "hero-dev", "get", "ingressroutes.traefik.io", "-o", "json"],
    ]);
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => NodeFS.rmSync(NodePath.dirname(tempDir), { force: true, recursive: true })),
    ),
  );
});

it.effect("uses an explicit native namespace for a new worktree when provided", () => {
  const tempDir = makeTempHeroComposeWorktree(undefined, "hero");
  const calls: Array<ReadonlyArray<string>> = [];
  const runKubectl: KubectlRunner = async (args) => {
    calls.push(args);
    if (args.join(" ") === "get namespace hero-preview -o json") return namespaceJson;
    if (args.join(" ") === "-n hero-preview get deployments -o json") return deploymentsJson;
    if (args[0] === "apply" && args[1] === "-f" && typeof args[2] === "string") return "";
    if (args.join(" ") === "-n hero-preview scale deployment --all --replicas=1") return "";
    throw new Error(`unexpected kubectl call: ${args.join(" ")}`);
  };
  const service = makeNativeAppDevStackService(
    {
      ...nativeConfig,
      id: undefined,
      namespace: undefined,
      worktreePath: undefined,
      displayName: undefined,
      repoName: undefined,
      branchName: undefined,
      frontendUrl: undefined,
      backendUrl: undefined,
      keycloakUrl: undefined,
      minioUrl: undefined,
    },
    runKubectl,
  );

  return Effect.gen(function* () {
    const result = yield* service.autoCreate({
      worktreePath: tempDir,
      displayName: "hero",
      gitBranch: "main",
      namespace: "Hero Preview",
    });

    assert.equal(result.stack?.id, "hero-preview");
    assert.equal(result.stack?.namespace, "hero-preview");
    assert.deepEqual(calls, [
      ["get", "namespace", "hero-preview", "-o", "json"],
      ["-n", "hero-preview", "get", "deployments", "-o", "json"],
      ["apply", "-f", calls[2]?.[2] ?? ""],
      ["-n", "hero-preview", "scale", "deployment", "--all", "--replicas=1"],
      ["get", "namespace", "hero-preview", "-o", "json"],
      ["-n", "hero-preview", "get", "deployments", "-o", "json"],
      ["-n", "hero-preview", "get", "ingressroutes.traefik.io", "-o", "json"],
    ]);
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => NodeFS.rmSync(NodePath.dirname(tempDir), { force: true, recursive: true })),
    ),
  );
});

it.effect("provisions Kubernetes resources when auto-creating a missing native namespace", () => {
  const tempDir = makeTempHeroComposeWorktree([
    "    image: hero-web:latest",
    "    command: redis-server --appendonly yes",
    "    labels:",
    "      rudi.appDevStack.hostname: rudi-dev.nightingale-ai.com",
    "    environment:",
    "      PORT: '3000'",
    "    ports:",
    "      - '3000:3000'",
  ]);
  const calls: Array<ReadonlyArray<string>> = [];
  let appliedManifest = "";
  const runKubectl: KubectlRunner = async (args) => {
    calls.push(args);
    if (args.join(" ") === "get namespace hero-dev -o json") {
      if (appliedManifest.length === 0) throw new Error('namespaces "hero-dev" not found');
      return namespaceJson;
    }
    if (args[0] === "apply" && args[1] === "-f" && typeof args[2] === "string") {
      appliedManifest = NodeFS.readFileSync(args[2], "utf8");
      return "";
    }
    if (args.join(" ") === "-n hero-dev scale deployment --all --replicas=1") return "";
    if (args.join(" ") === "-n hero-dev get deployments -o json") return deploymentsJson;
    throw new Error(`unexpected kubectl call: ${args.join(" ")}`);
  };
  const service = makeNativeAppDevStackService(
    {
      ...nativeConfig,
      id: undefined,
      namespace: undefined,
      worktreePath: undefined,
      displayName: undefined,
      repoName: undefined,
      branchName: undefined,
      frontendUrl: undefined,
      backendUrl: undefined,
      keycloakUrl: undefined,
      minioUrl: undefined,
    },
    runKubectl,
  );

  return Effect.gen(function* () {
    const result = yield* service.autoCreate({
      worktreePath: tempDir,
      displayName: "hero",
      gitBranch: "main",
      namespace: "hero-dev",
    });

    assert.equal(result.created, true);
    assert.equal(result.stack?.namespace, "hero-dev");
    assert.include(appliedManifest, "kind: Namespace");
    assert.include(appliedManifest, "name: hero-dev");
    assert.include(appliedManifest, "kind: Deployment");
    assert.include(appliedManifest, "image: hero-web:latest");
    assert.include(appliedManifest, "imagePullPolicy: Always");
    assert.include(appliedManifest, '- "yes"');
    assert.include(appliedManifest, "kind: IngressRoute");
    assert.include(appliedManifest, "Host(`hero-dev.nightingale-ai.com`)");
    assert.notInclude(appliedManifest, "Host(`rudi-dev.nightingale-ai.com`)");
    assert.deepEqual(
      calls.map((args) => args.slice(0, 2)),
      [
        ["get", "namespace"],
        ["apply", "-f"],
        ["-n", "hero-dev"],
        ["get", "namespace"],
        ["-n", "hero-dev"],
        ["-n", "hero-dev"],
      ],
    );
  }).pipe(
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { force: true, recursive: true }))),
  );
});

it.effect("builds and pushes compose build services before applying Kubernetes resources", () => {
  const tempDir = makeTempHeroComposeWorktree(
    [
      "    image: hero-web:latest",
      "    build:",
      "      context: ../..",
      "      dockerfile: Dockerfile",
      "      args:",
      "        VITE_FLAG: '1'",
      "    environment:",
      "      PORT: '3000'",
      "    ports:",
      "      - '3000:3000'",
    ],
    "hero",
  );
  NodeFS.writeFileSync(NodePath.join(tempDir, "Dockerfile"), "FROM scratch\n");
  const calls: Array<ReadonlyArray<string>> = [];
  const commandCalls: Array<{
    readonly command: string;
    readonly args: ReadonlyArray<string>;
    readonly cwd: string | undefined;
  }> = [];
  let appliedManifest = "";
  const runKubectl: KubectlRunner = async (args) => {
    calls.push(args);
    if (args.join(" ") === "get namespace hero-dev -o json") {
      if (appliedManifest.length === 0) throw new Error('namespaces "hero-dev" not found');
      return namespaceJson;
    }
    if (args[0] === "apply" && args[1] === "-f" && typeof args[2] === "string") {
      appliedManifest = NodeFS.readFileSync(args[2], "utf8");
      return "";
    }
    if (args.join(" ") === "-n hero-dev scale deployment --all --replicas=1") return "";
    if (args.join(" ") === "-n hero-dev get deployments -o json") return deploymentsJson;
    throw new Error(`unexpected kubectl call: ${args.join(" ")}`);
  };
  const runCommand: NativeCommandRunner = async (command, args, options) => {
    commandCalls.push({ command, args, cwd: options?.cwd });
    return "";
  };
  const service = makeNativeAppDevStackService(
    {
      ...nativeConfig,
      id: undefined,
      namespace: undefined,
      worktreePath: undefined,
      displayName: undefined,
      repoName: undefined,
      branchName: undefined,
      imageRegistry: "registry.example.test",
      frontendUrl: undefined,
      backendUrl: undefined,
      keycloakUrl: undefined,
      minioUrl: undefined,
    },
    runKubectl,
    runCommand,
  );

  return Effect.gen(function* () {
    const result = yield* service.autoCreate({
      worktreePath: tempDir,
      displayName: "hero",
      gitBranch: "main",
      namespace: "hero-dev",
    });

    const targetImage = "registry.example.test/hero/hero-web:latest";
    assert.equal(result.created, true);
    assert.deepEqual(commandCalls, [
      {
        command: "docker",
        args: [
          "build",
          "-t",
          targetImage,
          "-f",
          NodePath.join(tempDir, "Dockerfile"),
          "--build-arg",
          "VITE_FLAG=1",
          tempDir,
        ],
        cwd: tempDir,
      },
      {
        command: "docker",
        args: ["push", targetImage],
        cwd: tempDir,
      },
    ]);
    assert.include(appliedManifest, `image: ${targetImage}`);
    assert.include(appliedManifest, "imagePullPolicy: Always");
    assert.deepEqual(
      calls.map((args) => args.slice(0, 2)),
      [
        ["get", "namespace"],
        ["apply", "-f"],
        ["-n", "hero-dev"],
        ["get", "namespace"],
        ["-n", "hero-dev"],
        ["-n", "hero-dev"],
      ],
    );
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => NodeFS.rmSync(NodePath.dirname(tempDir), { force: true, recursive: true })),
    ),
  );
});

it.effect("can build and push compose build services through BuildKit", () => {
  const tempDir = makeTempHeroComposeWorktree(
    [
      "    image: hero-web:latest",
      "    build:",
      "      context: ../..",
      "      dockerfile: Dockerfile",
      "      target: runner",
      "      args:",
      "        VITE_FLAG: '1'",
      "    ports:",
      "      - '3000:3000'",
    ],
    "hero",
  );
  NodeFS.writeFileSync(NodePath.join(tempDir, "Dockerfile"), "FROM scratch\n");
  const tempRoot = NodePath.dirname(tempDir);
  const dockerConfigDir = NodePath.join(tempRoot, "docker-config");
  const harborCaCert = NodePath.join(tempRoot, "harbor-ca.crt");
  NodeFS.mkdirSync(dockerConfigDir, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(dockerConfigDir, "config.json"), "{}\n");
  NodeFS.writeFileSync(harborCaCert, "test-ca\n");

  const calls: Array<ReadonlyArray<string>> = [];
  const commandCalls: Array<{
    readonly command: string;
    readonly args: ReadonlyArray<string>;
    readonly cwd: string | undefined;
    readonly env: Readonly<Record<string, string>> | undefined;
  }> = [];
  let appliedManifest = "";
  const runKubectl: KubectlRunner = async (args) => {
    calls.push(args);
    if (args.join(" ") === "get namespace hero-dev -o json") {
      if (appliedManifest.length === 0) throw new Error('namespaces "hero-dev" not found');
      return namespaceJson;
    }
    if (args[0] === "apply" && args[1] === "-f" && typeof args[2] === "string") {
      appliedManifest = NodeFS.readFileSync(args[2], "utf8");
      return "";
    }
    if (args.join(" ") === "-n hero-dev scale deployment --all --replicas=1") return "";
    if (args.join(" ") === "-n hero-dev get deployments -o json") return deploymentsJson;
    throw new Error(`unexpected kubectl call: ${args.join(" ")}`);
  };
  const runCommand: NativeCommandRunner = async (command, args, options) => {
    commandCalls.push({ command, args, cwd: options?.cwd, env: options?.env });
    return "";
  };
  const service = makeNativeAppDevStackService(
    {
      ...nativeConfig,
      id: undefined,
      namespace: undefined,
      worktreePath: undefined,
      displayName: undefined,
      repoName: undefined,
      branchName: undefined,
      imageBuilder: "buildkit",
      imageRegistry: "harbor.nightingale-ai.com",
      imagePushRegistry: "harbor-core.harbor-system.svc.cluster.local",
      buildkitAddr: "tcp://buildkit.test:1234",
      buildkitDockerConfig: dockerConfigDir,
      buildkitHarborCaCert: harborCaCert,
      frontendUrl: undefined,
      backendUrl: undefined,
      keycloakUrl: undefined,
      minioUrl: undefined,
    },
    runKubectl,
    runCommand,
  );

  return Effect.gen(function* () {
    yield* service.autoCreate({
      worktreePath: tempDir,
      displayName: "hero",
      gitBranch: "main",
      namespace: "hero-dev",
    });

    const targetImage = "harbor.nightingale-ai.com/hero/hero-web:latest";
    const pushImage = "harbor-core.harbor-system.svc.cluster.local/hero/hero-web:latest";
    assert.equal(commandCalls.length, 1);
    assert.equal(commandCalls[0]?.command, "buildctl");
    assert.equal(commandCalls[0]?.cwd, tempDir);
    assert.deepEqual(commandCalls[0]?.env, {
      DOCKER_CONFIG: dockerConfigDir,
      SSL_CERT_FILE: harborCaCert,
    });
    assert.include(commandCalls[0]?.args.join("\n") ?? "", "--addr\ntcp://buildkit.test:1234");
    assert.include(commandCalls[0]?.args.join("\n") ?? "", `context=${tempDir}`);
    assert.include(commandCalls[0]?.args.join("\n") ?? "", `dockerfile=${tempDir}`);
    assert.include(commandCalls[0]?.args.join("\n") ?? "", "filename=Dockerfile");
    assert.include(commandCalls[0]?.args.join("\n") ?? "", "build-arg:VITE_FLAG=1");
    assert.include(commandCalls[0]?.args.join("\n") ?? "", "target=runner");
    assert.include(
      commandCalls[0]?.args.join("\n") ?? "",
      `type=image,name=${pushImage},push=true`,
    );
    assert.include(appliedManifest, `image: ${targetImage}`);
  }).pipe(
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempRoot, { force: true, recursive: true }))),
  );
});

it.effect("finds the app-dev compose file from a nested worktree path", () => {
  const tempDir = makeTempHeroComposeWorktree();
  const nestedDir = NodePath.join(tempDir, "apps", "server");
  NodeFS.mkdirSync(nestedDir, { recursive: true });
  const calls: Array<ReadonlyArray<string>> = [];
  let appliedManifest = "";
  const runKubectl: KubectlRunner = async (args) => {
    calls.push(args);
    if (args.join(" ") === "get namespace hero-dev -o json") {
      if (appliedManifest.length === 0) throw new Error('namespaces "hero-dev" not found');
      return namespaceJson;
    }
    if (args[0] === "apply" && args[1] === "-f" && typeof args[2] === "string") {
      appliedManifest = NodeFS.readFileSync(args[2], "utf8");
      return "";
    }
    if (args.join(" ") === "-n hero-dev scale deployment --all --replicas=1") return "";
    if (args.join(" ") === "-n hero-dev get deployments -o json") return deploymentsJson;
    throw new Error(`unexpected kubectl call: ${args.join(" ")}`);
  };
  const service = makeNativeAppDevStackService(
    {
      ...nativeConfig,
      id: undefined,
      namespace: undefined,
      worktreePath: undefined,
      displayName: undefined,
      repoName: undefined,
      branchName: undefined,
      frontendUrl: undefined,
      backendUrl: undefined,
      keycloakUrl: undefined,
      minioUrl: undefined,
    },
    runKubectl,
  );

  return Effect.gen(function* () {
    const result = yield* service.autoCreate({
      worktreePath: nestedDir,
      displayName: "hero",
      gitBranch: "main",
      namespace: "hero-dev",
    });

    assert.equal(result.created, true);
    assert.equal(result.stack?.namespace, "hero-dev");
    assert.include(appliedManifest, "image: hero-web:latest");
    assert.include(appliedManifest, "imagePullPolicy: Always");
    assert.include(appliedManifest, "kind: Deployment");
  }).pipe(
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { force: true, recursive: true }))),
  );
});

it.effect("reports a clear error when the worktree is missing an app-dev compose file", () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-native-app-dev-missing-"));
  const calls: Array<ReadonlyArray<string>> = [];
  const expectedComposePath = NodePath.join(tempDir, "infra", "compose", "compose.app-dev.yml");
  const runKubectl: KubectlRunner = async (args) => {
    calls.push(args);
    if (args.join(" ") === "get namespace hero-dev -o json") {
      throw new Error('namespaces "hero-dev" not found');
    }
    throw new Error(`unexpected kubectl call: ${args.join(" ")}`);
  };
  const service = makeNativeAppDevStackService(
    {
      ...nativeConfig,
      id: undefined,
      namespace: undefined,
      worktreePath: undefined,
      displayName: undefined,
      repoName: undefined,
      branchName: undefined,
      frontendUrl: undefined,
      backendUrl: undefined,
      keycloakUrl: undefined,
      minioUrl: undefined,
    },
    runKubectl,
  );

  return Effect.gen(function* () {
    const error = yield* service
      .autoCreate({
        worktreePath: tempDir,
        displayName: "hero",
        gitBranch: "main",
        namespace: "hero-dev",
      })
      .pipe(Effect.flip);

    assert.include(error.message, "App-dev compose file not found");
    assert.include(error.message, expectedComposePath);
    assert.include(error.message, "T3CODE_APP_DEV_STACK_NATIVE_COMPOSE_PATH");
    assert.deepEqual(calls, [["get", "namespace", "hero-dev", "-o", "json"]]);
  }).pipe(
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { force: true, recursive: true }))),
  );
});

it.effect("restores Kubernetes resources when auto-creating an empty native namespace", () => {
  const tempDir = makeTempHeroComposeWorktree();
  const calls: Array<ReadonlyArray<string>> = [];
  let appliedManifest = "";
  const emptyDeploymentsJson = JSON.stringify({ items: [] });
  const runKubectl: KubectlRunner = async (args) => {
    calls.push(args);
    if (args.join(" ") === "get namespace hero-dev -o json") return namespaceJson;
    if (args.join(" ") === "-n hero-dev get deployments -o json") {
      return appliedManifest.length === 0 ? emptyDeploymentsJson : deploymentsJson;
    }
    if (args[0] === "apply" && args[1] === "-f" && typeof args[2] === "string") {
      appliedManifest = NodeFS.readFileSync(args[2], "utf8");
      return "";
    }
    if (args.join(" ") === "-n hero-dev scale deployment --all --replicas=1") return "";
    throw new Error(`unexpected kubectl call: ${args.join(" ")}`);
  };
  const service = makeNativeAppDevStackService(
    {
      ...nativeConfig,
      id: undefined,
      namespace: undefined,
      worktreePath: undefined,
      displayName: undefined,
      repoName: undefined,
      branchName: undefined,
      frontendUrl: undefined,
      backendUrl: undefined,
      keycloakUrl: undefined,
      minioUrl: undefined,
    },
    runKubectl,
  );

  return Effect.gen(function* () {
    const result = yield* service.autoCreate({
      worktreePath: tempDir,
      displayName: "hero",
      gitBranch: "main",
      namespace: "hero-dev",
    });

    assert.equal(result.created, true);
    assert.equal(result.stack?.status, "running");
    assert.include(appliedManifest, "kind: Deployment");
    assert.deepEqual(
      calls.map((args) => args.slice(0, 2)),
      [
        ["get", "namespace"],
        ["-n", "hero-dev"],
        ["apply", "-f"],
        ["-n", "hero-dev"],
        ["get", "namespace"],
        ["-n", "hero-dev"],
        ["-n", "hero-dev"],
      ],
    );
  }).pipe(
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { force: true, recursive: true }))),
  );
});

it.effect("does not report a derived worktree stack before its namespace exists", () => {
  const calls: Array<ReadonlyArray<string>> = [];
  const runKubectl: KubectlRunner = async (args) => {
    calls.push(args);
    if (args.join(" ") === "get namespace hero-dev -o json") {
      throw new Error('namespaces "hero-dev" not found');
    }
    throw new Error(`unexpected kubectl call: ${args.join(" ")}`);
  };
  const service = makeNativeAppDevStackService(
    {
      ...nativeConfig,
      id: undefined,
      namespace: undefined,
      worktreePath: undefined,
      displayName: undefined,
      repoName: undefined,
      branchName: undefined,
      frontendUrl: undefined,
      backendUrl: undefined,
      keycloakUrl: undefined,
      minioUrl: undefined,
    },
    runKubectl,
  );

  return Effect.gen(function* () {
    const result = yield* service.getByWorktree({ worktreePath: "/home/nils/repos/nils/hero" });

    assert.equal(result.stack, null);
    assert.equal(result.frontendUrl, null);
    assert.deepEqual(calls, [["get", "namespace", "hero-dev", "-o", "json"]]);
  });
});

it.effect("scales native deployments down and back up when restarting", () => {
  const calls: Array<ReadonlyArray<string>> = [];
  const runKubectl: KubectlRunner = async (args) => {
    calls.push(args);
    if (args.join(" ") === "-n rudi-dev scale deployment --all --replicas=0") return "";
    if (args.join(" ") === "-n rudi-dev scale deployment --all --replicas=1") return "";
    if (args.join(" ") === "get namespace rudi-dev -o json") return namespaceJson;
    if (args.join(" ") === "-n rudi-dev get deployments -o json") return deploymentsJson;
    throw new Error(`unexpected kubectl call: ${args.join(" ")}`);
  };
  const service = makeNativeAppDevStackService(nativeConfig, runKubectl);

  return Effect.gen(function* () {
    const result = yield* service.restart({ stackId: "rudi-dev" });

    assert.equal(result.status, "running");
    assert.deepEqual(calls, [
      ["-n", "rudi-dev", "scale", "deployment", "--all", "--replicas=0"],
      ["-n", "rudi-dev", "scale", "deployment", "--all", "--replicas=1"],
      ["get", "namespace", "rudi-dev", "-o", "json"],
      ["-n", "rudi-dev", "get", "deployments", "-o", "json"],
      ["-n", "rudi-dev", "get", "ingressroutes.traefik.io", "-o", "json"],
    ]);
  });
});

const documentName = (document: Record<string, unknown>): string | undefined =>
  (document.metadata as { readonly name?: string } | undefined)?.name;

it.effect("wires the backend's OpenBao-backed Google OAuth credentials", () => {
  const tempDir = makeTempHeroComposeWorktree([
    "    image: hero-web:latest",
    "    environment:",
    "      PORT: '3000'",
    "  backend:",
    "    image: rudi-backend-dev:latest",
    "    environment:",
    "      PORT: '8000'",
  ]);

  return Effect.gen(function* () {
    const documents = yield* Effect.promise(() =>
      generateNativeAppDevStackManifests({
        id: "rudi-dev",
        namespace: "rudi-dev",
        worktreePath: tempDir,
        composePath: "infra/compose/compose.app-dev.yml",
        displayName: "rudi",
        displaySlug: undefined,
        repoName: "rudi",
        branchName: "dev",
        dockerPath: "docker",
        buildctlPath: "buildctl",
        imageBuilder: "docker",
        imageRegistry: undefined,
        imagePushRegistry: undefined,
        imageProject: undefined,
        buildkitAddr: undefined,
        buildkitDockerConfig: undefined,
        buildkitDockerConfigsDir: undefined,
        buildkitHarborCaCert: undefined,
        frontendUrl: undefined,
        backendUrl: undefined,
        keycloakUrl: undefined,
        minioUrl: undefined,
        preferStackScopedUrls: true,
      }),
    );

    const externalSecrets = documents.filter((document) => document.kind === "ExternalSecret");
    assert.equal(externalSecrets.length, 1);
    const externalSecret = externalSecrets[0];
    assert.equal(
      externalSecret === undefined ? undefined : documentName(externalSecret),
      "rudi-backend-credentials",
    );
    assert.deepEqual(externalSecret?.spec, {
      refreshInterval: "1h",
      secretStoreRef: { kind: "ClusterSecretStore", name: "openbao-backend" },
      target: {
        name: "rudi-backend-secrets",
        creationPolicy: "Owner",
        deletionPolicy: "Retain",
      },
      data: [
        {
          secretKey: "GOOGLE_CLIENT_ID",
          remoteRef: { key: "rudi/api-keys/google", property: "client_id" },
        },
        {
          secretKey: "GOOGLE_CLIENT_SECRET",
          remoteRef: { key: "rudi/api-keys/google", property: "client_secret" },
        },
      ],
    });

    // The ExternalSecret has to be applied before the Deployment that reads it.
    assert.isBelow(
      documents.findIndex((document) => document.kind === "ExternalSecret"),
      documents.findIndex((document) => document.kind === "Deployment"),
    );

    const envFromFor = (serviceName: string) => {
      const deployment = documents.find(
        (document) => document.kind === "Deployment" && documentName(document) === serviceName,
      );
      const spec = deployment?.spec as
        | {
            readonly template: {
              readonly spec: {
                readonly containers: ReadonlyArray<{ readonly envFrom?: unknown }>;
              };
            };
          }
        | undefined;
      return spec?.template.spec.containers[0]?.envFrom;
    };

    assert.deepEqual(envFromFor("backend"), [
      { configMapRef: { name: "backend-env" } },
      { secretRef: { name: "rudi-backend-secrets", optional: true } },
    ]);
    assert.deepEqual(envFromFor("web"), [{ configMapRef: { name: "web-env" } }]);
  }).pipe(
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { force: true, recursive: true }))),
  );
});

it.effect("omits the credential wiring for stacks without a backend service", () => {
  const tempDir = makeTempHeroComposeWorktree();

  return Effect.gen(function* () {
    const documents = yield* Effect.promise(() =>
      generateNativeAppDevStackManifests({
        id: "hero-dev",
        namespace: "hero-dev",
        worktreePath: tempDir,
        composePath: "infra/compose/compose.app-dev.yml",
        displayName: "hero",
        displaySlug: undefined,
        repoName: "hero",
        branchName: "main",
        dockerPath: "docker",
        buildctlPath: "buildctl",
        imageBuilder: "docker",
        imageRegistry: undefined,
        imagePushRegistry: undefined,
        imageProject: undefined,
        buildkitAddr: undefined,
        buildkitDockerConfig: undefined,
        buildkitDockerConfigsDir: undefined,
        buildkitHarborCaCert: undefined,
        frontendUrl: undefined,
        backendUrl: undefined,
        keycloakUrl: undefined,
        minioUrl: undefined,
        preferStackScopedUrls: true,
      }),
    );

    assert.deepEqual(
      documents.filter((document) => document.kind === "ExternalSecret"),
      [],
    );
  }).pipe(
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { force: true, recursive: true }))),
  );
});

const workflowNamespacesJson = JSON.stringify({
  items: [
    {
      metadata: {
        name: "ticket-a-dev",
        creationTimestamp: "2026-08-19T10:00:00.000Z",
        labels: {
          "cortex.ai/component": "app-dev-stack",
          "cortex.ai/stack-id": "ticket-a",
        },
        annotations: {
          "cortex.ai/worktree-path": "/worktrees/ticket-a",
          "cortex.ai/workflow-id": "workflow-123",
        },
      },
    },
    {
      metadata: {
        name: "ticket-b-dev",
        creationTimestamp: "2026-08-19T10:00:00.000Z",
        labels: {
          "cortex.ai/component": "app-dev-stack",
          "cortex.ai/stack-id": "ticket-b",
        },
        annotations: {
          "cortex.ai/worktree-path": "/worktrees/ticket-b",
          "cortex.ai/workflow-id": "workflow-123",
          "cortex.ai/protected": "true",
        },
      },
    },
    {
      metadata: {
        name: "other-dev",
        creationTimestamp: "2026-08-19T10:00:00.000Z",
        labels: {
          "cortex.ai/component": "app-dev-stack",
          "cortex.ai/stack-id": "other",
        },
        annotations: {
          "cortex.ai/worktree-path": "/worktrees/other",
          "cortex.ai/workflow-id": "workflow-999",
        },
      },
    },
  ],
});

it.effect("workflow teardown scales down only the workflow's unprotected stacks", () => {
  const calls: Array<string> = [];
  const runKubectl: KubectlRunner = async (args) => {
    const call = args.join(" ");
    calls.push(call);
    if (call === "get namespaces -l cortex.ai/component=app-dev-stack -o json") {
      return workflowNamespacesJson;
    }
    if (call === "-n ticket-a-dev scale deployment --all --replicas=0") return "";
    throw new Error(`unexpected kubectl call: ${call}`);
  };
  const service = makeNativeAppDevStackService(
    {
      ...nativeConfig,
      id: undefined,
      namespace: undefined,
      worktreePath: undefined,
    },
    runKubectl,
  );

  return Effect.gen(function* () {
    const result = yield* service.workflowTeardown({ workflowId: "workflow-123" });

    assert.deepEqual(result.stoppedStackIds, ["ticket-a"]);
    assert.deepEqual(result.skippedProtectedStackIds, ["ticket-b"]);
    assert.deepEqual(result.failedStackIds, []);
    assert.deepEqual(
      calls.filter((call) => call.includes("scale")),
      ["-n ticket-a-dev scale deployment --all --replicas=0"],
    );
  });
});

it.effect("protection is stored as a namespace annotation and read back", () => {
  const calls: Array<string> = [];
  let protectedAnnotation: string | undefined;
  const runKubectl: KubectlRunner = async (args) => {
    const call = args.join(" ");
    calls.push(call);
    if (call === "get namespaces -l cortex.ai/component=app-dev-stack -o json") {
      return workflowNamespacesJson;
    }
    if (call.startsWith("annotate namespace ticket-a-dev cortex.ai/protected=")) {
      protectedAnnotation = call.split("cortex.ai/protected=")[1]?.split(" ")[0];
      return "";
    }
    if (call === "get namespace ticket-a-dev -o json") {
      return JSON.stringify({
        metadata: {
          name: "ticket-a-dev",
          creationTimestamp: "2026-08-19T10:00:00.000Z",
          annotations: {
            "cortex.ai/workflow-id": "workflow-123",
            ...(protectedAnnotation === undefined
              ? {}
              : { "cortex.ai/protected": protectedAnnotation }),
          },
        },
      });
    }
    if (call === "-n ticket-a-dev get deployments -o json") return deploymentsJson;
    if (call.startsWith("-n ticket-a-dev get ingressroutes")) return JSON.stringify({ items: [] });
    throw new Error(`unexpected kubectl call: ${call}`);
  };
  const service = makeNativeAppDevStackService(
    {
      ...nativeConfig,
      id: undefined,
      namespace: undefined,
      worktreePath: undefined,
      frontendUrl: undefined,
      backendUrl: undefined,
      keycloakUrl: undefined,
      minioUrl: undefined,
    },
    runKubectl,
  );

  return Effect.gen(function* () {
    const stack = yield* service.setProtected({ stackId: "ticket-a", protected: true });

    assert.equal(protectedAnnotation, "true");
    assert.equal(stack.protected, true);
    assert.equal(stack.workflowId, "workflow-123");
  });
});
