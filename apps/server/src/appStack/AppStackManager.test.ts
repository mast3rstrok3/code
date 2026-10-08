import { describe } from "vite-plus/test";
// @effect-diagnostics nodeBuiltinImport:off - bundle worktree tests build real git checkouts on disk.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as OtelEnvironment from "@t3tools/shared/otelEnvironment";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { DEFAULT_SIGNAL_EXPORT } from "@t3tools/shared/observability";

import * as ServerConfig from "../config.ts";
import { AppStackManager } from "./AppStackManager.ts";

const backendUrl = new URL("https://api-code-dev.nightingale-ai.com");

const stackJson = {
  id: "11111111-1111-1111-1111-111111111111",
  uuid: "11111111-1111-1111-1111-111111111111",
  userId: "00000000-0000-0000-0000-000000000000",
  worktreePath: "/repo/worktrees/feature",
  composePath: "/repo/worktrees/feature/docker-compose.yml",
  displayName: "feature",
  description: null,
  status: "running",
  services: null,
  serviceCount: 0,
  lastError: null,
  errorCount: 0,
  createdAt: "2026-06-25T00:00:00.000Z",
  updatedAt: "2026-06-25T00:00:00.000Z",
} as const;

const noStackByWorktree = {
  stack: null,
  frontendUrl: null,
  frontendServiceName: null,
} as const;

const deviceLeaseJson = {
  platform: "android" as const,
  status: "queued",
  leaseId: "935970a8-0032-4c65-b87f-5c36fd46bb91",
  expiresAt: null,
  queueReason: "capacity",
  queuePosition: 2,
  queuedAt: "2026-09-13T00:00:00Z",
  queueExpiresAt: "2026-09-13T01:00:00Z",
  retryAfterSeconds: 10,
  error: null,
  stopReason: null,
};

const decodeWorkflowRequest = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ workflow_id: Schema.optional(Schema.String) })),
);

const decodeProtectionRequest = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ protected: Schema.Boolean })),
);

const decodeVariantRequest = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ variant: Schema.String })),
);

const decodeBundleRequest = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      bundle: Schema.optional(Schema.Union([Schema.Literal("all"), Schema.Array(Schema.String)])),
      git_branch: Schema.optional(Schema.NullOr(Schema.String)),
      namespace: Schema.optional(Schema.String),
      omit_services: Schema.optional(Schema.Record(Schema.String, Schema.Array(Schema.String))),
    }),
  ),
);

const requestBody = (
  requests: ReadonlyArray<HttpClientRequest.HttpClientRequest>,
  path: string,
) => {
  const request = requests.find((candidate) => new URL(candidate.url).pathname.endsWith(path));
  if (request?.body._tag !== "Uint8Array") {
    return assert.fail(`expected a JSON body for ${path}`);
  }
  return decodeBundleRequest(new TextDecoder().decode(request.body.body));
};

const derivedPaths = {
  stateDir: "/tmp/t3-app-dev-stack-manager-test/state",
  dbPath: "/tmp/t3-app-dev-stack-manager-test/state/state.sqlite",
  keybindingsConfigPath: "/tmp/t3-app-dev-stack-manager-test/state/keybindings.json",
  settingsPath: "/tmp/t3-app-dev-stack-manager-test/state/settings.json",
  providerStatusCacheDir: "/tmp/t3-app-dev-stack-manager-test/caches",
  worktreesDir: "/tmp/t3-app-dev-stack-manager-test/worktrees",
  browserArtifactsDir: "/tmp/t3-app-dev-stack-manager-test/state/browser-artifacts",
  attachmentsDir: "/tmp/t3-app-dev-stack-manager-test/state/attachments",
  environmentThemesDir: "/tmp/t3-app-dev-stack-manager-test/state/themes",
  logsDir: "/tmp/t3-app-dev-stack-manager-test/state/logs",
  serverTracePath: "/tmp/t3-app-dev-stack-manager-test/state/logs/server.trace.ndjson",
  providerLogsDir: "/tmp/t3-app-dev-stack-manager-test/state/logs/provider",
  providerEventLogPath: "/tmp/t3-app-dev-stack-manager-test/state/logs/provider/events.log",
  terminalLogsDir: "/tmp/t3-app-dev-stack-manager-test/state/logs/terminals",
  anonymousIdPath: "/tmp/t3-app-dev-stack-manager-test/state/anonymous-id",
  environmentIdPath: "/tmp/t3-app-dev-stack-manager-test/state/environment-id",
  serverRuntimeStatePath: "/tmp/t3-app-dev-stack-manager-test/state/server-runtime.json",
  secretsDir: "/tmp/t3-app-dev-stack-manager-test/state/secrets",
} satisfies ServerConfig.ServerDerivedPaths;

const makeConfigLayer = (input?: {
  readonly bearerToken?: string | undefined;
  readonly oidc?:
    | {
        readonly tokenUrl: URL;
        readonly clientId: string;
        readonly clientSecret: string;
      }
    | undefined;
  readonly url?: URL | undefined;
  readonly native?: ServerConfig.NativeAppStackConfig | undefined;
}) =>
  ServerConfig.layer({
    logLevel: "Error",
    traceMinLevel: "Info",
    traceTimingEnabled: true,
    traceBatchWindowMs: 200,
    traceMaxBytes: 10 * 1024 * 1024,
    traceMaxFiles: 10,
    otlpTracesUrl: undefined,
    otlpMetricsUrl: undefined,
    otlpLogsUrl: undefined,
    otlpTracesExport: DEFAULT_SIGNAL_EXPORT,
    otlpMetricsExport: DEFAULT_SIGNAL_EXPORT,
    otlpLogsExport: DEFAULT_SIGNAL_EXPORT,
    otelEnvironment: OtelEnvironment.none,
    mode: "web",
    port: 0,
    host: undefined,
    cwd: process.cwd(),
    baseDir: "/tmp/t3-app-dev-stack-manager-test",
    ...derivedPaths,
    staticDir: undefined,
    devUrl: undefined,
    devAllowedOrigins: [],
    appStackBackendUrl: input?.url ?? backendUrl,
    appStackBackendBearerToken:
      input?.bearerToken === undefined ? undefined : Redacted.make(input.bearerToken),
    appStackBackendOidcTokenUrl: input?.oidc?.tokenUrl,
    appStackBackendOidcClientId: input?.oidc?.clientId,
    appStackBackendOidcClientSecret:
      input?.oidc === undefined ? undefined : Redacted.make(input.oidc.clientSecret),
    appStackNative: input?.native,
    noBrowser: true,
    startupPresentation: "browser",
    desktopBootstrapToken: undefined,
    autoBootstrapProjectFromCwd: false,
    logWebSocketEvents: false,
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
    previewBrowserMode: "auto",
    previewBrowserSource: "auto",
    previewBrowserExecutablePath: undefined,
    previewFfmpegExecutablePath: undefined,
    previewBrowserSandbox: "auto",
    previewBrowserMaxFps: 12,
    previewBrowserMaxFrameWidth: 1600,
    previewBrowserMaxFrameHeight: 1200,
    previewBrowserJpegQuality: 75,
    previewBrowserIdleTtlMs: 600_000,
    previewRecordingMode: "auto",
  });

const makeLayer = (input: {
  readonly bearerToken?: string | undefined;
  readonly oidc?:
    | {
        readonly tokenUrl: URL;
        readonly clientId: string;
        readonly clientSecret: string;
      }
    | undefined;
  readonly response: (request: HttpClientRequest.HttpClientRequest) => Response;
  readonly requests: Array<HttpClientRequest.HttpClientRequest>;
  readonly native?: ServerConfig.NativeAppStackConfig | undefined;
}) =>
  AppStackManager.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        makeConfigLayer({ bearerToken: input.bearerToken, oidc: input.oidc, native: input.native }),
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) => {
            input.requests.push(request);
            return Effect.succeed(HttpClientResponse.fromWeb(request, input.response(request)));
          }),
        ),
      ),
    ),
  );

it.effect("sends the configured backend bearer token when starting a stack", () => {
  const requests: Array<HttpClientRequest.HttpClientRequest> = [];
  const layer = makeLayer({
    bearerToken: "backend-token",
    requests,
    response: (request) =>
      Response.json(
        new URL(request.url).pathname.endsWith("/by-worktree")
          ? noStackByWorktree
          : {
              stack: stackJson,
              created: true,
              frontendUrl: null,
              frontendServiceName: null,
            },
      ),
  });

  return Effect.gen(function* () {
    const manager = yield* AppStackManager;
    yield* manager.autoCreate({
      worktreePath: "/repo/worktrees/feature",
      displayName: "feature",
      gitBranch: "feature",
      workflowId: "workflow-123",
    });

    const request = requests.find((candidate) =>
      new URL(candidate.url).pathname.endsWith("/auto-create"),
    );
    if (request === undefined) {
      assert.fail("expected AppStackManager to send a backend request");
    }
    assert.equal(request.method, "POST");
    assert.equal(
      request.url,
      `${backendUrl.href.replace(/\/+$/u, "")}/api/app-dev-stacks/auto-create`,
    );
    assert.equal(request.headers.authorization, "Bearer backend-token");
    if (request.body._tag !== "Uint8Array") {
      assert.fail("expected JSON request body");
    }
    assert.equal(
      decodeWorkflowRequest(new TextDecoder().decode(request.body.body)).workflow_id,
      "workflow-123",
    );
  }).pipe(Effect.provide(layer));
});

it.effect("reuses an active stack without posting auto-create", () => {
  const requests: Array<HttpClientRequest.HttpClientRequest> = [];
  const layer = makeLayer({
    requests,
    response: () =>
      Response.json({
        stack: stackJson,
        frontendUrl: "https://feature.example.test",
        frontendServiceName: "frontend",
      }),
  });

  return Effect.gen(function* () {
    const manager = yield* AppStackManager;
    const result = yield* manager.autoCreate({
      worktreePath: stackJson.worktreePath,
      displayName: "feature",
      workflowId: "workflow-123",
    });

    assert.equal(result.created, false);
    assert.equal(result.stack?.id, stackJson.id);
    assert.equal(result.frontendUrl, "https://feature.example.test");
    assert.deepEqual(
      requests.map((request) => [request.method, new URL(request.url).pathname]),
      [["GET", "/api/app-dev-stacks/by-worktree"]],
    );
  }).pipe(Effect.provide(layer));
});

it.effect("serializes concurrent creates so only one controller create is posted", () => {
  const requests: Array<HttpClientRequest.HttpClientRequest> = [];
  let created = false;
  const layer = makeLayer({
    requests,
    response: (request) => {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/by-worktree")) {
        return Response.json(
          created
            ? { stack: stackJson, frontendUrl: null, frontendServiceName: null }
            : noStackByWorktree,
        );
      }
      created = true;
      return Response.json({
        stack: stackJson,
        created: true,
        frontendUrl: null,
        frontendServiceName: null,
      });
    },
  });

  return Effect.gen(function* () {
    const manager = yield* AppStackManager;
    yield* Effect.all(
      [
        manager.autoCreate({
          worktreePath: stackJson.worktreePath,
          displayName: "feature",
          workflowId: "workflow-123",
        }),
        manager.autoCreate({
          worktreePath: stackJson.worktreePath,
          displayName: "feature",
          workflowId: "workflow-123",
        }),
      ],
      { concurrency: "unbounded" },
    );

    assert.equal(
      requests.filter((request) => new URL(request.url).pathname.endsWith("/auto-create")).length,
      1,
    );
  }).pipe(Effect.provide(layer));
});

it.effect("uses the configured controller backend before native kubectl mode", () => {
  const requests: Array<HttpClientRequest.HttpClientRequest> = [];
  const layer = makeLayer({
    requests,
    native: {
      id: undefined,
      namespace: undefined,
      worktreePath: undefined,
      composePath: "infra/compose/compose.app-dev.yml",
      displayName: undefined,
      displaySlug: undefined,
      repoName: undefined,
      branchName: undefined,
      kubectlPath: "kubectl-that-should-not-run",
      dockerPath: "docker-that-should-not-run",
      buildctlPath: "buildctl-that-should-not-run",
      imageBuilder: "docker",
      imageRegistry: "registry.example.test",
      imagePushRegistry: undefined,
      imageProject: undefined,
      buildkitAddr: undefined,
      buildkitDockerConfig: undefined,
      buildkitDockerConfigsDir: undefined,
      buildkitHarborCaCert: undefined,
      frontendUrl: undefined,
      backendUrl: undefined,
      keycloakUrl: undefined,
      objectStorageUrl: undefined,
    },
    response: (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/app-dev-stacks/by-worktree") {
        return Response.json(noStackByWorktree);
      }
      if (url.pathname === "/api/app-dev-stacks/auto-create") {
        return Response.json({
          stack: stackJson,
          created: true,
          frontendUrl: null,
          frontendServiceName: null,
        });
      }
      return new Response(`unexpected request ${request.url}`, { status: 404 });
    },
  });

  return Effect.gen(function* () {
    const manager = yield* AppStackManager;
    const result = yield* manager.autoCreate({
      worktreePath: "/home/nils/repos/nils/hero",
      displayName: "hero",
      gitBranch: "main",
      namespace: "hero-dev",
    });

    assert.equal(result.created, true);
    assert.deepEqual(
      requests.map((request) => [request.method, new URL(request.url).pathname]),
      [
        ["GET", "/api/app-dev-stacks/by-worktree"],
        // Asks whether the worktree is a platform worktree; the 404 says no.
        ["POST", "/api/app-dev-stacks/bundle-plan"],
        ["POST", "/api/app-dev-stacks/auto-create"],
      ],
    );
  }).pipe(Effect.provide(layer));
});

it.effect("restarts a stack through get, stop, and auto-create backend calls", () => {
  const requests: Array<HttpClientRequest.HttpClientRequest> = [];
  const layer = makeLayer({
    bearerToken: "backend-token",
    requests,
    response: (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/app-dev-stacks/11111111-1111-1111-1111-111111111111") {
        return Response.json({ ...stackJson, workflowId: "workflow-123" });
      }
      if (url.pathname === "/api/app-dev-stacks/11111111-1111-1111-1111-111111111111/stop") {
        return Response.json({ ...stackJson, status: "stopped" });
      }
      if (url.pathname === "/api/app-dev-stacks/by-worktree") {
        return Response.json({
          ...noStackByWorktree,
          stack: { ...stackJson, status: "stopped", workflowId: "workflow-123" },
        });
      }
      if (url.pathname === "/api/app-dev-stacks/auto-create") {
        return Response.json({
          stack: { ...stackJson, status: "running" },
          created: false,
          frontendUrl: null,
          frontendServiceName: null,
        });
      }
      return new Response(`unexpected request ${request.url}`, { status: 404 });
    },
  });

  return Effect.gen(function* () {
    const manager = yield* AppStackManager;
    const stack = yield* manager.restart({ stackId: stackJson.id });

    assert.equal(stack.id, stackJson.id);
    assert.equal(stack.status, "running");
    assert.deepEqual(
      requests.map((request) => {
        const url = new URL(request.url);
        return [request.method, url.pathname] as const;
      }),
      [
        ["GET", "/api/app-dev-stacks/11111111-1111-1111-1111-111111111111"],
        ["POST", "/api/app-dev-stacks/11111111-1111-1111-1111-111111111111/stop"],
        ["GET", "/api/app-dev-stacks/by-worktree"],
        ["POST", "/api/app-dev-stacks/auto-create"],
      ],
    );
    assert.equal(
      requests.every((request) => request.headers.authorization === "Bearer backend-token"),
      true,
    );
    const createRequest = requests.find((request) =>
      new URL(request.url).pathname.endsWith("/auto-create"),
    );
    if (createRequest?.body._tag !== "Uint8Array") {
      assert.fail("expected restart auto-create JSON body");
    }
    assert.equal(
      decodeWorkflowRequest(new TextDecoder().decode(createRequest.body.body)).workflow_id,
      "workflow-123",
    );
  }).pipe(Effect.provide(layer));
});

it.effect("does not start a stack when restart stop fails", () => {
  const requests: Array<HttpClientRequest.HttpClientRequest> = [];
  const layer = makeLayer({
    bearerToken: "backend-token",
    requests,
    response: (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/app-dev-stacks/11111111-1111-1111-1111-111111111111") {
        return Response.json(stackJson);
      }
      if (url.pathname === "/api/app-dev-stacks/11111111-1111-1111-1111-111111111111/stop") {
        return new Response("stop failed", { status: 500 });
      }
      return new Response(`unexpected request ${request.url}`, { status: 404 });
    },
  });

  return Effect.gen(function* () {
    const manager = yield* AppStackManager;
    const error = yield* manager.restart({ stackId: stackJson.id }).pipe(Effect.flip);

    assert.equal(error.status, 500);
    assert.include(error.message, "stop failed");
    assert.deepEqual(
      requests.map((request) => {
        const url = new URL(request.url);
        return [request.method, url.pathname] as const;
      }),
      [
        ["GET", "/api/app-dev-stacks/11111111-1111-1111-1111-111111111111"],
        ["POST", "/api/app-dev-stacks/11111111-1111-1111-1111-111111111111/stop"],
      ],
    );
  }).pipe(Effect.provide(layer));
});

it.effect("mints and caches an OIDC service token when no static bearer token is set", () => {
  const requests: Array<HttpClientRequest.HttpClientRequest> = [];
  const tokenUrl = new URL("https://auth-code-dev.nightingale-ai.com/realms/code/token");
  const layer = makeLayer({
    oidc: {
      tokenUrl,
      clientId: "cortex-t3code",
      clientSecret: "client-secret",
    },
    requests,
    response: (request) => {
      if (request.url === tokenUrl.href) {
        return Response.json({
          access_token: "oidc-token",
          expires_in: 3600,
          token_type: "Bearer",
        });
      }
      if (new URL(request.url).pathname.endsWith("/by-worktree")) {
        return Response.json(noStackByWorktree);
      }
      return Response.json({
        stack: stackJson,
        created: true,
        frontendUrl: null,
        frontendServiceName: null,
      });
    },
  });

  return Effect.gen(function* () {
    const manager = yield* AppStackManager;
    yield* manager.autoCreate({
      worktreePath: "/repo/worktrees/feature",
      displayName: "feature",
      gitBranch: "feature",
    });
    yield* manager.autoCreate({
      worktreePath: "/repo/worktrees/feature",
      displayName: "feature",
      gitBranch: "feature",
    });

    // One token, then by-worktree, bundle-plan and auto-create for each start.
    assert.equal(requests.length, 7);
    assert.equal(requests[0]?.method, "POST");
    assert.equal(requests[0]?.url, tokenUrl.href);
    for (const request of requests.slice(1)) {
      assert.equal(request.headers.authorization, "Bearer oidc-token");
    }
  }).pipe(Effect.provide(layer));
});

it.effect(
  "names the app stack token env var when the backend rejects unauthenticated calls",
  () => {
    const requests: Array<HttpClientRequest.HttpClientRequest> = [];
    const layer = makeLayer({
      requests,
      response: () => new Response("missing bearer token", { status: 401 }),
    });

    return Effect.gen(function* () {
      const manager = yield* AppStackManager;
      const error = yield* manager
        .autoCreate({
          worktreePath: "/repo/worktrees/feature",
          displayName: "feature",
          gitBranch: "feature",
        })
        .pipe(Effect.flip);

      assert.equal(requests[0]?.headers.authorization, undefined);
      assert.equal(error.status, 401);
      assert.include(error.message, "T3CODE_APP_STACK_BACKEND_BEARER_TOKEN");
    }).pipe(Effect.provide(layer));
  },
);

it.effect("proxies pod list and log reads to the configured backend", () => {
  const requests: Array<HttpClientRequest.HttpClientRequest> = [];
  const layer = makeLayer({
    bearerToken: "backend-token",
    requests,
    response: (request) => {
      if (request.url.endsWith("/api/app-dev-stacks/rudi-dev/pods")) {
        return Response.json({
          stackId: "rudi-dev",
          namespace: "rudi-dev",
          pods: [],
        });
      }
      return Response.json({
        stackId: "rudi-dev",
        namespace: "rudi-dev",
        podName: "backend-pod",
        containerName: "backend",
        tailLines: 300,
        logs: "ok\n",
        fetchedAt: "2026-06-25T00:00:00.000Z",
      });
    },
  });

  return Effect.gen(function* () {
    const manager = yield* AppStackManager;
    yield* manager.listPods({ stackId: "rudi-dev" });
    yield* manager.getPodLogs({
      stackId: "rudi-dev",
      podName: "backend-pod",
      containerName: "backend",
      tailLines: 300,
    });

    assert.equal(
      requests[0]?.url,
      `${backendUrl.href.replace(/\/+$/u, "")}/api/app-dev-stacks/rudi-dev/pods`,
    );
    assert.equal(requests[0]?.headers.authorization, "Bearer backend-token");
    assert.equal(
      requests[1]?.url,
      `${backendUrl.href.replace(/\/+$/u, "")}/api/app-dev-stacks/rudi-dev/pods/backend-pod/logs?containerName=backend&tailLines=300`,
    );
    assert.equal(requests[1]?.headers.authorization, "Bearer backend-token");
  }).pipe(Effect.provide(layer));
});

it.effect("aggregates stack pod logs through existing pod endpoints with backend auth", () => {
  const requests: Array<HttpClientRequest.HttpClientRequest> = [];
  const podList = {
    stackId: "rudi-dev",
    namespace: "rudi-dev",
    pods: [
      {
        name: "backend-pod",
        phase: "Running",
        readyContainerCount: 1,
        totalContainerCount: 2,
        restartCount: 1,
        ownerKind: "ReplicaSet",
        ownerName: "backend-7cdbbbfdd8",
        containers: [
          { name: "backend", ready: true, restartCount: 0, state: "running" },
          { name: "sidecar", ready: false, restartCount: 1, state: "CrashLoopBackOff" },
        ],
      },
    ],
  } as const;
  const layer = makeLayer({
    bearerToken: "backend-token",
    requests,
    response: (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/app-dev-stacks/rudi-dev/pods") {
        return Response.json(podList);
      }
      if (
        url.pathname === "/api/app-dev-stacks/rudi-dev/pods/backend-pod/logs" &&
        url.searchParams.get("containerName") === "backend"
      ) {
        return Response.json({
          stackId: "rudi-dev",
          namespace: "rudi-dev",
          podName: "backend-pod",
          containerName: "backend",
          tailLines: 300,
          logs: "backend ready\n",
          fetchedAt: "2026-06-25T00:00:00.000Z",
        });
      }
      if (
        url.pathname === "/api/app-dev-stacks/rudi-dev/pods/backend-pod/logs" &&
        url.searchParams.get("containerName") === "sidecar"
      ) {
        return new Response("sidecar logs unavailable", { status: 500 });
      }
      return new Response(`unexpected request ${request.url}`, { status: 404 });
    },
  });

  return Effect.gen(function* () {
    const manager = yield* AppStackManager;
    const result = yield* manager.getStackPodLogs({ stackId: "rudi-dev" });

    assert.equal(result.stackId, "rudi-dev");
    assert.equal(result.namespace, "rudi-dev");
    assert.equal(result.tailLines, 300);
    assert.equal(result.pods.length, 1);
    assert.deepEqual(
      result.entries.map((entry) => ({
        podName: entry.podName,
        containerName: entry.containerName,
        logs: entry.logs,
        error: entry.error,
      })),
      [
        {
          podName: "backend-pod",
          containerName: "backend",
          logs: "backend ready\n",
          error: null,
        },
        {
          podName: "backend-pod",
          containerName: "sidecar",
          logs: "",
          error: "App Stack backend responded with 500: sidecar logs unavailable",
        },
      ],
    );
    assert.deepEqual(
      requests.map((request) => {
        const url = new URL(request.url);
        return `${url.pathname}${url.search}`;
      }),
      [
        "/api/app-dev-stacks/rudi-dev/pods",
        "/api/app-dev-stacks/rudi-dev/pods/backend-pod/logs?containerName=backend&tailLines=300",
        "/api/app-dev-stacks/rudi-dev/pods/backend-pod/logs?containerName=sidecar&tailLines=300",
      ],
    );
    assert.equal(
      requests.every((request) => request.headers.authorization === "Bearer backend-token"),
      true,
    );
    assert.equal(
      requests.some((request) => request.url.includes("getStackPodLogs")),
      false,
    );
  }).pipe(Effect.provide(layer));
});

it.effect("aggregates all stack pod logs through remote list and pod endpoints", () => {
  const requests: Array<HttpClientRequest.HttpClientRequest> = [];
  const podList = {
    stackId: "rudi-dev",
    namespace: "rudi-dev",
    pods: [
      {
        name: "backend-pod",
        phase: "Running",
        readyContainerCount: 1,
        totalContainerCount: 1,
        restartCount: 0,
        ownerKind: "ReplicaSet",
        ownerName: "backend-7cdbbbfdd8",
        containers: [{ name: "backend", ready: true, restartCount: 0, state: "running" }],
      },
    ],
  } as const;
  const layer = makeLayer({
    bearerToken: "backend-token",
    requests,
    response: (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/app-dev-stacks") {
        return Response.json([{ ...stackJson, id: "rudi-dev", namespace: "rudi-dev" }]);
      }
      if (url.pathname === "/api/app-dev-stacks/rudi-dev/pods") {
        return Response.json(podList);
      }
      if (url.pathname === "/api/app-dev-stacks/rudi-dev/pods/backend-pod/logs") {
        return Response.json({
          stackId: "rudi-dev",
          namespace: "rudi-dev",
          podName: "backend-pod",
          containerName: "backend",
          tailLines: 1000,
          logs: "backend ready\n",
          fetchedAt: "2026-06-25T00:00:00.000Z",
        });
      }
      return new Response(`unexpected request ${request.url}`, { status: 404 });
    },
  });

  return Effect.gen(function* () {
    const manager = yield* AppStackManager;
    const result = yield* manager.getAllStackPodLogs({
      limit: { mode: "tail", tailLines: 1000 },
    });

    assert.equal(result.limit.mode, "tail");
    assert.equal(result.limit.mode === "tail" ? result.limit.tailLines : null, 1000);
    assert.deepEqual(
      result.stacks.map((stack) => ({
        stackId: stack.stackId,
        namespace: stack.namespace,
        entries: stack.entries.map((entry) => [entry.containerName, entry.logs]),
      })),
      [
        {
          stackId: "rudi-dev",
          namespace: "rudi-dev",
          entries: [["backend", "backend ready\n"]],
        },
      ],
    );
    assert.deepEqual(
      requests.map((request) => {
        const url = new URL(request.url);
        return `${request.method} ${url.pathname}${url.search}`;
      }),
      [
        "GET /api/app-dev-stacks",
        "GET /api/app-dev-stacks/rudi-dev/pods",
        "GET /api/app-dev-stacks/rudi-dev/pods/backend-pod/logs?containerName=backend&tailLines=1000",
      ],
    );
    assert.equal(
      requests.every((request) => request.headers.authorization === "Bearer backend-token"),
      true,
    );
  }).pipe(Effect.provide(layer));
});

it.effect("reports all-mode as unsupported for remote all-stack log reads", () => {
  const requests: Array<HttpClientRequest.HttpClientRequest> = [];
  const layer = makeLayer({
    bearerToken: "backend-token",
    requests,
    response: () => Response.json([]),
  });

  return Effect.gen(function* () {
    const manager = yield* AppStackManager;
    const error = yield* manager.getAllStackPodLogs({ limit: { mode: "all" } }).pipe(Effect.flip);

    assert.include(error.message, "not supported");
    assert.deepEqual(requests, []);
  }).pipe(Effect.provide(layer));
});

it.effect("posts the protection toggle to the controller", () => {
  const requests: Array<HttpClientRequest.HttpClientRequest> = [];
  const layer = makeLayer({
    bearerToken: "backend-token",
    requests,
    response: () => Response.json({ ...stackJson, protected: true }),
  });

  return Effect.gen(function* () {
    const manager = yield* AppStackManager;
    const stack = yield* manager.setProtected({ stackId: stackJson.id, protected: true });

    assert.equal(stack.protected, true);
    const request = requests[0];
    if (request === undefined) assert.fail("expected a protection request");
    assert.equal(request.method, "POST");
    assert.equal(
      request.url,
      `${backendUrl.href.replace(/\/+$/u, "")}/api/app-dev-stacks/${stackJson.id}/protection`,
    );
    if (request.body._tag !== "Uint8Array") assert.fail("expected JSON request body");
    assert.deepStrictEqual(decodeProtectionRequest(new TextDecoder().decode(request.body.body)), {
      protected: true,
    });
  }).pipe(Effect.provide(layer));
});

it.effect("tears a workflow's stacks down in one controller call", () => {
  const requests: Array<HttpClientRequest.HttpClientRequest> = [];
  const layer = makeLayer({
    requests,
    response: () =>
      Response.json({
        stoppedStackIds: ["stack-a"],
        skippedProtectedStackIds: ["stack-b"],
        failedStackIds: [],
      }),
  });

  return Effect.gen(function* () {
    const manager = yield* AppStackManager;
    const result = yield* manager.workflowTeardown({ workflowId: "workflow-123" });

    assert.deepStrictEqual(result.stoppedStackIds, ["stack-a"]);
    assert.deepStrictEqual(result.skippedProtectedStackIds, ["stack-b"]);
    const request = requests[0];
    if (request === undefined) assert.fail("expected a teardown request");
    assert.equal(
      request.url,
      `${backendUrl.href.replace(/\/+$/u, "")}/api/app-dev-stacks/workflow-teardown`,
    );
    if (request.body._tag !== "Uint8Array") assert.fail("expected JSON request body");
    assert.equal(
      decodeWorkflowRequest(new TextDecoder().decode(request.body.body)).workflow_id,
      "workflow-123",
    );
  }).pipe(Effect.provide(layer));
});

it.effect("asks the controller for the prod contract and ignores the worktree's dev stack", () => {
  const requests: Array<HttpClientRequest.HttpClientRequest> = [];
  const prodStackJson = {
    ...stackJson,
    id: "22222222-2222-2222-2222-222222222222",
    uuid: "22222222-2222-2222-2222-222222222222",
    composePath: "/repo/worktrees/feature/infra/compose/compose.app-prod.yml",
  };
  const layer = makeLayer({
    requests,
    response: (request) =>
      Response.json(
        new URL(request.url).pathname.endsWith("/by-worktree")
          ? // The controller keys this on the worktree alone and returns the dev stack.
            {
              stack: stackJson,
              frontendUrl: "https://feature.example.test",
              frontendServiceName: "frontend",
            }
          : request.method === "GET"
            ? [stackJson]
            : { stack: prodStackJson, created: true, frontendUrl: null, frontendServiceName: null },
      ),
  });

  return Effect.gen(function* () {
    const manager = yield* AppStackManager;
    const byWorktree = yield* manager.getByWorktree({
      worktreePath: stackJson.worktreePath,
      variant: "prod",
    });
    assert.equal(byWorktree.stack, null);

    const result = yield* manager.autoCreate({
      worktreePath: stackJson.worktreePath,
      displayName: "feature",
      variant: "prod",
    });
    assert.equal(result.created, true);
    assert.equal(result.stack?.variant, "prod");

    const request = requests.at(-1);
    if (request === undefined || request.body._tag !== "Uint8Array") {
      assert.fail("expected a JSON auto-create request");
    }
    assert.equal(request.method, "POST");
    assert.equal(decodeVariantRequest(new TextDecoder().decode(request.body.body)).variant, "prod");
  }).pipe(Effect.provide(layer));
});

it.effect("finds the exact workspace dev stack when the controller returns its prod stack", () => {
  const dev = {
    ...stackJson,
    composePath: "infra/compose/compose.app-dev.yml",
    previewUrls: { frontend: "https://dev.example.test" },
  };
  const prod = { ...stackJson, composePath: "infra/compose/compose.app-prod.yml" };
  const layer = makeLayer({
    requests: [],
    response: (request) =>
      Response.json(
        new URL(request.url).pathname.endsWith("/by-worktree")
          ? {
              stack: prod,
              frontendUrl: "https://prod.example.test",
              frontendServiceName: "frontend",
            }
          : [{ ...dev, worktreePath: "/another/worktree" }, prod, dev],
      ),
  });
  return Effect.gen(function* () {
    const manager = yield* AppStackManager;
    const result = yield* manager.getByWorktree({ worktreePath: stackJson.worktreePath + "/" });
    assert.equal(result.stack?.worktreePath, stackJson.worktreePath);
    assert.equal(result.stack?.variant, "dev");
    assert.equal(result.frontendUrl, "https://dev.example.test");
  }).pipe(Effect.provide(layer));
});

it.effect("derives the variant from the compose file name for listed stacks", () => {
  const layer = makeLayer({
    requests: [],
    response: () =>
      Response.json([
        stackJson,
        {
          ...stackJson,
          id: "33333333-3333-3333-3333-333333333333",
          uuid: "33333333-3333-3333-3333-333333333333",
          composePath: "infra/compose/compose.app-prod.yml",
        },
      ]),
  });

  return Effect.gen(function* () {
    const manager = yield* AppStackManager;
    const { stacks } = yield* manager.list({});
    assert.deepEqual(
      stacks.map((stack) => stack.variant),
      ["dev", "prod"],
    );
  }).pipe(Effect.provide(layer));
});

describe.each(
  [...(["android", "windows"] as const)].map((scenarioCase) => [scenarioCase] as const),
)("scenario %s", (platform) => {
  it.effect(`authenticates ${platform} lifecycle calls and preserves queue and lease data`, () => {
    const requests: Array<HttpClientRequest.HttpClientRequest> = [];
    const lease = { ...deviceLeaseJson, platform };
    const readiness =
      platform === "android"
        ? {
            present: true,
            booted: true,
            serial: "emulator-5554",
            currentFocus: null,
            viewerUrl: null,
            metroUrl: null,
            message: null,
          }
        : {
            present: true,
            phase: "Running",
            guestAgentConnected: true,
            ready: true,
            conditions: [],
          };
    const layer = makeLayer({
      bearerToken: "backend-token",
      requests,
      response: (request) => Response.json(request.url.endsWith("/status") ? readiness : lease),
    });
    return Effect.gen(function* () {
      const manager = yield* AppStackManager;
      const input = { stackId: stackJson.id, platform };
      assert.deepEqual(yield* manager.startDevice({ ...input, leaseId: lease.leaseId }), lease);
      assert.deepEqual(yield* manager.getDeviceLease(input), lease);
      const status = yield* manager.getDeviceStatus(input);
      assert.equal(status.present, true);
      if ("booted" in status) assert.equal(status.booted, true);
      else assert.equal(status.ready, true);
      yield* manager.stopDevice({ ...input, leaseId: lease.leaseId });
      assert.deepEqual(
        requests.map((r) => [r.method, r.url, r.headers.authorization]),
        [
          [
            "POST",
            `${backendUrl.href}api/app-dev-stacks/${stackJson.id}/${platform}/start`,
            "Bearer backend-token",
          ],
          [
            "GET",
            `${backendUrl.href}api/app-dev-stacks/${stackJson.id}/${platform}/lease`,
            "Bearer backend-token",
          ],
          [
            "GET",
            `${backendUrl.href}api/app-dev-stacks/${stackJson.id}/${platform}/status`,
            "Bearer backend-token",
          ],
          [
            "POST",
            `${backendUrl.href}api/app-dev-stacks/${stackJson.id}/${platform}/stop`,
            "Bearer backend-token",
          ],
        ],
      );
      const bodies = requests
        .filter((r) => r.method === "POST")
        .map((r) => {
          if (r.body._tag !== "Uint8Array") return assert.fail("expected a JSON request body");
          return JSON.parse(new TextDecoder().decode(r.body.body));
        });
      assert.deepEqual(bodies, [
        { leaseId: lease.leaseId, ttlSeconds: 1800 },
        { leaseId: lease.leaseId },
      ]);
    }).pipe(Effect.provide(layer));
  });
});

it.effect("preserves lease conflicts and does not retry a device mutation", () => {
  const requests: Array<HttpClientRequest.HttpClientRequest> = [];
  const layer = makeLayer({
    requests,
    response: () =>
      Response.json({ detail: "Device belongs to another test session" }, { status: 409 }),
  });
  return Effect.gen(function* () {
    const manager = yield* AppStackManager;
    const error = yield* manager
      .stopDevice({ stackId: stackJson.id, platform: "windows", leaseId: deviceLeaseJson.leaseId })
      .pipe(Effect.flip);
    assert.equal(error.status, 409);
    assert.include(error.message, "another test session");
    assert.lengthOf(requests, 1);
  }).pipe(Effect.provide(layer));
});

it.effect("rejects a malformed device response instead of claiming a lease was acquired", () => {
  const layer = makeLayer({ requests: [], response: () => Response.json({ status: "running" }) });
  return Effect.gen(function* () {
    const manager = yield* AppStackManager;
    const error = yield* manager
      .startDevice({ stackId: stackJson.id, platform: "android", leaseId: deviceLeaseJson.leaseId })
      .pipe(Effect.flip);
    assert.equal(error.reason, "invalid_response");
  }).pipe(Effect.provide(layer));
});

const git = (cwd: string, ...args: Array<string>) =>
  NodeChildProcess.execFileSync(
    "git",
    ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args],
    {
      cwd,
      encoding: "utf8",
    },
  ).trim();

// A main checkout cloned from its own bare origin, with a dev branch and,
// optionally, the bundle branch already pushed.
const makeCheckout = (root: string, name: string, pushedBranch: string | null) => {
  const seed = NodePath.join(root, `${name}-seed`);
  const origin = NodePath.join(root, `${name}.git`);
  const checkout = NodePath.join(root, name);
  NodeFS.mkdirSync(seed);
  git(seed, "init", "--quiet", "-b", "dev");
  git(seed, "commit", "--quiet", "--allow-empty", "-m", "dev");
  const devSha = git(seed, "rev-parse", "HEAD");
  let branchSha: string | null = null;
  if (pushedBranch !== null) {
    git(seed, "checkout", "--quiet", "-b", pushedBranch);
    git(seed, "commit", "--quiet", "--allow-empty", "-m", "feature");
    branchSha = git(seed, "rev-parse", "HEAD");
    git(seed, "checkout", "--quiet", "dev");
  }
  git(root, "clone", "--quiet", "--bare", seed, origin);
  git(root, "clone", "--quiet", origin, checkout);
  return { checkout, devSha, branchSha };
};

it.effect("creates missing bundle worktrees from origin before starting the bundle", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-app-stack-bundle-"));
  const branch = "feature/bundle";
  const cortex = makeCheckout(root, "cortex", branch);
  const chat = makeCheckout(root, "chat", null);
  const cortexWorktree = NodePath.join(root, "cortex.worktrees", "feature-bundle");
  const chatWorktree = NodePath.join(root, "chat.worktrees", "feature-bundle");
  const requests: Array<HttpClientRequest.HttpClientRequest> = [];
  const member = (app: string, worktreePath: string, bundleId: string) => ({
    ...stackJson,
    id: bundleId === stackJson.id && app === "rudi" ? stackJson.id : `${app}-stack`,
    uuid: bundleId === stackJson.id && app === "rudi" ? stackJson.id : `${app}-stack`,
    worktreePath,
    app,
    bundleId,
  });
  const layer = makeLayer({
    bearerToken: "backend-token",
    requests,
    response: (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/app-dev-stacks/bundle-plan") {
        return Response.json({
          app: "rudi",
          branch,
          members: [
            {
              app: "rudi",
              repository: "rudi",
              repositoryPath: "/repos/rudi",
              worktreePath: stackJson.worktreePath,
              found: true,
              baseBranch: "dev",
            },
            {
              app: "cortex",
              repository: "cortex",
              repositoryPath: cortex.checkout,
              worktreePath: cortexWorktree,
              found: false,
              baseBranch: "dev",
            },
            {
              app: "chat",
              repository: "chat",
              repositoryPath: chat.checkout,
              worktreePath: chatWorktree,
              found: false,
              baseBranch: "dev",
            },
          ],
        });
      }
      if (url.pathname === "/api/app-dev-stacks/auto-create") {
        return Response.json({
          stack: member("rudi", stackJson.worktreePath, stackJson.id),
          created: true,
          frontendUrl: null,
          frontendServiceName: null,
          bundle: [
            member("rudi", stackJson.worktreePath, stackJson.id),
            member("cortex", cortexWorktree, stackJson.id),
            member("chat", chatWorktree, stackJson.id),
          ],
        });
      }
      return new Response(`unexpected request ${request.url}`, { status: 404 });
    },
  });

  return Effect.gen(function* () {
    const manager = yield* AppStackManager;
    const result = yield* manager.autoCreate({
      worktreePath: stackJson.worktreePath,
      displayName: "feature",
      gitBranch: branch,
      namespace: "ignored-for-bundles",
      bundle: ["cortex", "chat"],
    });

    // No by-worktree shortcut: a running standalone stack joins the bundle.
    assert.deepEqual(
      requests.map((request) => new URL(request.url).pathname),
      ["/api/app-dev-stacks/bundle-plan", "/api/app-dev-stacks/auto-create"],
    );
    assert.deepEqual(requestBody(requests, "/bundle-plan").bundle, ["cortex", "chat"]);
    const createBody = requestBody(requests, "/auto-create");
    assert.deepEqual(createBody.bundle, ["cortex", "chat"]);
    assert.equal(createBody.git_branch, branch);
    assert.equal(createBody.namespace, undefined);
    assert.deepEqual(result.createdWorktreePaths, [cortexWorktree, chatWorktree]);
    assert.deepEqual(result.createdWorktrees, [
      { repositoryPath: cortex.checkout, worktreePath: cortexWorktree },
      { repositoryPath: chat.checkout, worktreePath: chatWorktree },
    ]);
    assert.deepEqual(
      result.bundle?.map((stack) => [stack.app, stack.bundleId, stack.variant]),
      [
        ["rudi", stackJson.id, "dev"],
        ["cortex", stackJson.id, "dev"],
        ["chat", stackJson.id, "dev"],
      ],
    );

    // A branch already on origin is tracked; a new one starts from origin/dev.
    assert.equal(git(cortexWorktree, "rev-parse", "HEAD"), cortex.branchSha);
    assert.equal(git(cortexWorktree, "rev-parse", "--abbrev-ref", "HEAD"), branch);
    assert.equal(
      git(cortexWorktree, "rev-parse", "--abbrev-ref", "@{upstream}"),
      `origin/${branch}`,
    );
    assert.equal(git(chatWorktree, "rev-parse", "HEAD"), chat.devSha);
    assert.equal(git(chatWorktree, "rev-parse", "--abbrev-ref", "HEAD"), branch);
  }).pipe(
    Effect.provide(layer),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true }))),
  );
});

it.effect("removes the worktrees it created when the controller refuses the bundle", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-app-stack-bundle-"));
  const branch = "feature/refused";
  const chat = makeCheckout(root, "chat", null);
  const chatWorktree = NodePath.join(root, "chat.worktrees", "feature-refused");
  const requests: Array<HttpClientRequest.HttpClientRequest> = [];
  const layer = makeLayer({
    bearerToken: "backend-token",
    requests,
    response: (request) =>
      new URL(request.url).pathname === "/api/app-dev-stacks/bundle-plan"
        ? Response.json({
            app: "rudi",
            branch,
            members: [
              {
                app: "chat",
                repository: "chat",
                repositoryPath: chat.checkout,
                worktreePath: chatWorktree,
                found: false,
                baseBranch: "dev",
              },
            ],
          })
        : Response.json({ detail: "chat has no service named web" }, { status: 400 }),
  });

  return Effect.gen(function* () {
    const manager = yield* AppStackManager;
    yield* manager
      .autoCreate({
        worktreePath: stackJson.worktreePath,
        displayName: "feature",
        gitBranch: branch,
        bundle: ["chat"],
        omitServices: { chat: ["web"] },
      })
      .pipe(Effect.flip);
    assert.equal(NodeFS.existsSync(chatWorktree), false);
    assert.notInclude(git(chat.checkout, "worktree", "list"), chatWorktree);
  }).pipe(
    Effect.provide(layer),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true }))),
  );
});

it.effect("restarts a bundle member together with the other members", () => {
  const requests: Array<HttpClientRequest.HttpClientRequest> = [];
  const bundleId = stackJson.id;
  const rudi = { ...stackJson, app: "rudi", bundleId, omittedServices: ["codex-runner"] };
  const cortex = {
    ...stackJson,
    id: "22222222-2222-2222-2222-222222222222",
    uuid: "22222222-2222-2222-2222-222222222222",
    worktreePath: "/repo/cortex.worktrees/feature",
    app: "cortex",
    bundleId,
    omittedServices: null,
  };
  const unrelated = {
    ...stackJson,
    id: "33333333-3333-3333-3333-333333333333",
    uuid: "33333333-3333-3333-3333-333333333333",
    app: "chat",
    bundleId: null,
  };
  const layer = makeLayer({
    bearerToken: "backend-token",
    requests,
    response: (request) => {
      const url = new URL(request.url);
      if (url.pathname === `/api/app-dev-stacks/${rudi.id}`) return Response.json(rudi);
      if (url.pathname === "/api/app-dev-stacks") {
        return Response.json([rudi, cortex, unrelated]);
      }
      if (url.pathname === `/api/app-dev-stacks/${rudi.id}/stop`) {
        return Response.json({ ...rudi, status: "stopped" });
      }
      if (url.pathname === "/api/app-dev-stacks/bundle-plan") {
        return Response.json({
          app: "rudi",
          branch: "feature",
          members: [
            { app: "rudi", repository: "rudi", found: true, baseBranch: "dev" },
            { app: "cortex", repository: "cortex", found: true, baseBranch: "dev" },
          ],
        });
      }
      if (url.pathname === "/api/app-dev-stacks/auto-create") {
        return Response.json({
          stack: rudi,
          created: true,
          frontendUrl: null,
          frontendServiceName: null,
          bundle: [rudi, cortex],
        });
      }
      return new Response(`unexpected request ${request.url}`, { status: 404 });
    },
  });

  return Effect.gen(function* () {
    const manager = yield* AppStackManager;
    yield* manager.restart({ stackId: rudi.id });

    // Restart creates new rows, so each member's omissions are sent again.
    const createBody = requestBody(requests, "/auto-create");
    assert.deepEqual(createBody.bundle, ["cortex"]);
    assert.deepEqual(createBody.omit_services, { rudi: ["codex-runner"] });
  }).pipe(Effect.provide(layer));
});

it.effect("sends an exact shape past the active-stack shortcut and bundles every app", () => {
  const requests: Array<HttpClientRequest.HttpClientRequest> = [];
  const layer = makeLayer({
    bearerToken: "backend-token",
    requests,
    response: (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/app-dev-stacks/bundle-plan") {
        return Response.json({ app: "rudi", branch: "feature", members: [] });
      }
      if (url.pathname === "/api/app-dev-stacks/auto-create") {
        return Response.json({
          stack: { ...stackJson, omittedServices: ["codex-runner"] },
          created: true,
          frontendUrl: null,
          frontendServiceName: null,
        });
      }
      // The by-worktree shortcut would return this running stack as it is.
      return Response.json({ stack: stackJson, frontendUrl: null, frontendServiceName: null });
    },
  });

  return Effect.gen(function* () {
    const manager = yield* AppStackManager;
    const result = yield* manager.autoCreate({
      worktreePath: stackJson.worktreePath,
      displayName: "feature",
      gitBranch: "feature",
      omitServices: { rudi: ["codex-runner"] },
    });
    assert.deepEqual(result.stack?.omittedServices, ["codex-runner"]);
    // The plan only tells whether this is a platform worktree; it is not.
    assert.deepEqual(
      requests.map((request) => new URL(request.url).pathname),
      ["/api/app-dev-stacks/bundle-plan", "/api/app-dev-stacks/auto-create"],
    );
    assert.deepEqual(requestBody(requests, "/auto-create").omit_services, {
      rudi: ["codex-runner"],
    });

    requests.length = 0;
    yield* manager.autoCreate({
      worktreePath: stackJson.worktreePath,
      displayName: "feature",
      gitBranch: "feature",
      bundle: "all",
      omitServices: {},
    });
    assert.equal(requestBody(requests, "/bundle-plan").bundle, "all");
    const bundleBody = requestBody(requests, "/auto-create");
    assert.equal(bundleBody.bundle, "all");
    assert.deepEqual(bundleBody.omit_services, {});
  }).pipe(Effect.provide(layer));
});

it.effect("refuses omitted services when the controller predates them", () => {
  const requests: Array<HttpClientRequest.HttpClientRequest> = [];
  const layer = makeLayer({
    bearerToken: "backend-token",
    requests,
    response: () =>
      Response.json({
        stack: stackJson,
        created: true,
        frontendUrl: null,
        frontendServiceName: null,
      }),
  });

  return Effect.gen(function* () {
    const manager = yield* AppStackManager;
    const error = yield* manager
      .autoCreate({
        worktreePath: stackJson.worktreePath,
        displayName: "feature",
        omitServices: { rudi: ["codex-runner"] },
      })
      .pipe(Effect.flip);
    assert.match(error.message, /too old for omitted services/u);

    // An empty shape needs nothing the old controller lacks.
    const result = yield* manager.autoCreate({
      worktreePath: stackJson.worktreePath,
      displayName: "feature",
      omitServices: {},
    });
    assert.equal(result.stack?.id, stackJson.id);
  }).pipe(Effect.provide(layer));
});

const decodeRestartRequest = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      worktree_path: Schema.String,
      bundle: Schema.Array(Schema.String),
      omit_services: Schema.Record(Schema.String, Schema.Array(Schema.String)),
    }),
  ),
);

const platformRecord = {
  ...stackJson,
  id: "44444444-4444-4444-4444-444444444444",
  uuid: "44444444-4444-4444-4444-444444444444",
  worktreePath: "/repos/features/feature-platform/healthcare-infra",
  composePath: "infra/compose/compose.app-dev.yml",
  app: null,
  bundleId: "44444444-4444-4444-4444-444444444444",
  platform: true,
  omittedServices: [],
  namespace: null,
  services: null,
  serviceCount: 0,
} as const;

it.effect("decodes a platform plan and a platform record", () => {
  const layer = makeLayer({
    requests: [],
    response: (request) =>
      new URL(request.url).pathname === "/api/app-dev-stacks/bundle-plan"
        ? Response.json({
            app: null,
            branch: "feature/platform",
            platform: true,
            members: [
              {
                app: "rudi",
                repository: "rudi",
                repositoryPath: "/repos/rudi",
                worktreePath: "/repos/features/feature-platform/rudi",
                found: false,
                baseBranch: "dev",
                services: ["backend", "codex-runner", "frontend"],
              },
            ],
          })
        : Response.json(platformRecord),
  });

  return Effect.gen(function* () {
    const manager = yield* AppStackManager;
    const plan = yield* manager.bundlePlan({ worktreePath: platformRecord.worktreePath });
    assert.equal(plan.app, null);
    assert.equal(plan.platform, true);
    assert.deepEqual(plan.members[0]?.services, ["backend", "codex-runner", "frontend"]);
    const record = yield* manager.get({ stackId: platformRecord.id });
    assert.equal(record.platform, true);
    assert.equal(record.app, null);
    assert.equal(record.namespace, null);
    assert.equal(record.bundleId, record.id);
    assert.deepEqual(record.omittedServices, []);
  }).pipe(Effect.provide(layer));
});

it.effect(
  "starts a platform worktree with every app after creating the missing worktrees in the feature folder",
  () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-app-stack-platform-"));
    const branch = "feature/platform";
    const rudi = makeCheckout(root, "rudi", null);
    const chat = makeCheckout(root, "chat", branch);
    const infraWorktree = NodePath.join(root, "features", "feature-platform", "healthcare-infra");
    const rudiWorktree = NodePath.join(root, "features", "feature-platform", "rudi");
    const chatWorktree = NodePath.join(root, "chat.worktrees", "feature-platform");
    git(
      chat.checkout,
      "worktree",
      "add",
      "--quiet",
      "-b",
      branch,
      chatWorktree,
      `origin/${branch}`,
    );
    const record = { ...platformRecord, worktreePath: infraWorktree };
    const requests: Array<HttpClientRequest.HttpClientRequest> = [];
    const layer = makeLayer({
      requests,
      response: (request) => {
        const url = new URL(request.url);
        if (url.pathname === "/api/app-dev-stacks/by-worktree") {
          return Response.json(noStackByWorktree);
        }
        if (url.pathname === "/api/app-dev-stacks/bundle-plan") {
          return Response.json({
            app: null,
            branch,
            platform: true,
            members: [
              {
                app: "rudi",
                repository: "rudi",
                repositoryPath: rudi.checkout,
                worktreePath: rudiWorktree,
                found: false,
                baseBranch: "dev",
                services: ["backend", "codex-runner", "frontend"],
              },
              {
                app: "chat",
                repository: "chat",
                repositoryPath: chat.checkout,
                worktreePath: chatWorktree,
                found: true,
                baseBranch: "dev",
                services: ["backend", "web"],
              },
            ],
          });
        }
        if (url.pathname === "/api/app-dev-stacks/auto-create") {
          return Response.json({
            stack: record,
            created: true,
            frontendUrl: null,
            frontendServiceName: null,
            bundle: [
              record,
              {
                ...stackJson,
                worktreePath: rudiWorktree,
                app: "rudi",
                bundleId: record.id,
                omittedServices: ["codex-runner"],
              },
            ],
          });
        }
        return new Response(`unexpected request ${request.url}`, { status: 404 });
      },
    });

    return Effect.gen(function* () {
      const manager = yield* AppStackManager;
      const result = yield* manager.autoCreate({
        worktreePath: infraWorktree,
        displayName: "healthcare-infra feature/platform",
        gitBranch: branch,
        omitServices: { rudi: ["codex-runner"] },
      });

      assert.deepEqual(
        requests.map((request) => new URL(request.url).pathname),
        ["/api/app-dev-stacks/bundle-plan", "/api/app-dev-stacks/auto-create"],
      );
      const createBody = requestBody(requests, "/auto-create");
      assert.equal(createBody.bundle, "all");
      assert.deepEqual(createBody.omit_services, { rudi: ["codex-runner"] });
      assert.deepEqual(result.createdWorktrees, [
        { repositoryPath: rudi.checkout, worktreePath: rudiWorktree },
      ]);
      assert.equal(result.stack?.platform, true);
      // The new worktree sits in the feature folder, on the branch, from origin/dev.
      assert.equal(git(rudiWorktree, "rev-parse", "--abbrev-ref", "HEAD"), branch);
      assert.equal(git(rudiWorktree, "rev-parse", "HEAD"), rudi.devSha);
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true }))),
    );
  },
);

it.effect("creates the missing worktrees of a plan without starting anything", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-app-stack-fan-out-"));
  const branch = "feature/fan-out";
  const cortex = makeCheckout(root, "cortex", branch);
  const cortexWorktree = NodePath.join(root, "features", "feature-fan-out", "cortex");
  const requests: Array<HttpClientRequest.HttpClientRequest> = [];
  const layer = makeLayer({
    requests,
    response: (request) =>
      new URL(request.url).pathname === "/api/app-dev-stacks/bundle-plan"
        ? Response.json({
            app: null,
            branch,
            platform: true,
            members: [
              {
                app: "cortex",
                repository: "cortex",
                repositoryPath: cortex.checkout,
                worktreePath: cortexWorktree,
                found: false,
                baseBranch: "dev",
                services: ["backend", "frontend"],
              },
            ],
          })
        : new Response(`unexpected request ${request.url}`, { status: 404 }),
  });

  return Effect.gen(function* () {
    const manager = yield* AppStackManager;
    const result = yield* manager.createBundleWorktrees({
      worktreePath: platformRecord.worktreePath,
      gitBranch: branch,
      bundle: ["cortex"],
    });
    assert.deepEqual(
      requests.map((request) => new URL(request.url).pathname),
      ["/api/app-dev-stacks/bundle-plan"],
    );
    assert.deepEqual(requestBody(requests, "/bundle-plan").bundle, ["cortex"]);
    assert.deepEqual(result.createdWorktrees, [
      { repositoryPath: cortex.checkout, worktreePath: cortexWorktree },
    ]);
    assert.equal(git(cortexWorktree, "rev-parse", "HEAD"), cortex.branchSha);
  }).pipe(
    Effect.provide(layer),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true }))),
  );
});

it.effect("restarts a platform bundle from its record when asked through an app member", () => {
  const requests: Array<HttpClientRequest.HttpClientRequest> = [];
  const rudi = {
    ...stackJson,
    worktreePath: "/repos/features/feature-platform/rudi",
    app: "rudi",
    bundleId: platformRecord.id,
    omittedServices: ["codex-runner"],
  };
  const chat = {
    ...stackJson,
    id: "55555555-5555-5555-5555-555555555555",
    uuid: "55555555-5555-5555-5555-555555555555",
    worktreePath: "/repos/features/feature-platform/chat",
    app: "chat",
    bundleId: platformRecord.id,
    omittedServices: [],
  };
  const layer = makeLayer({
    requests,
    response: (request) => {
      const url = new URL(request.url);
      if (url.pathname === `/api/app-dev-stacks/${rudi.id}`) return Response.json(rudi);
      if (url.pathname === "/api/app-dev-stacks") {
        return Response.json([platformRecord, rudi, chat]);
      }
      if (url.pathname === `/api/app-dev-stacks/${platformRecord.id}/stop`) {
        return Response.json({ ...platformRecord, status: "stopped" });
      }
      if (url.pathname === "/api/app-dev-stacks/bundle-plan") {
        return Response.json({
          app: null,
          branch: "feature/platform",
          platform: true,
          members: [
            { app: "rudi", repository: "rudi", found: true, baseBranch: "dev" },
            { app: "chat", repository: "chat", found: true, baseBranch: "dev" },
          ],
        });
      }
      if (url.pathname === "/api/app-dev-stacks/auto-create") {
        return Response.json({
          stack: platformRecord,
          created: true,
          frontendUrl: null,
          frontendServiceName: null,
          bundle: [platformRecord, rudi, chat],
        });
      }
      return new Response(`unexpected request ${request.url}`, { status: 404 });
    },
  });

  return Effect.gen(function* () {
    const manager = yield* AppStackManager;
    const restarted = yield* manager.restart({ stackId: rudi.id });

    assert.equal(restarted.id, platformRecord.id);
    assert.deepEqual(
      requests.map((request) => [request.method, new URL(request.url).pathname] as const),
      [
        ["GET", `/api/app-dev-stacks/${rudi.id}`],
        ["GET", "/api/app-dev-stacks"],
        ["POST", `/api/app-dev-stacks/${platformRecord.id}/stop`],
        ["POST", "/api/app-dev-stacks/bundle-plan"],
        ["POST", "/api/app-dev-stacks/auto-create"],
      ],
    );
    const createRequest = requests.find((request) =>
      new URL(request.url).pathname.endsWith("/auto-create"),
    );
    if (createRequest?.body._tag !== "Uint8Array") {
      return assert.fail("expected an auto-create JSON body");
    }
    const createBody = decodeRestartRequest(new TextDecoder().decode(createRequest.body.body));
    assert.equal(createBody.worktree_path, platformRecord.worktreePath);
    assert.deepEqual(createBody.bundle, ["rudi", "chat"]);
    assert.deepEqual(createBody.omit_services, { rudi: ["codex-runner"] });
  }).pipe(Effect.provide(layer));
});

it.effect("skips platform records when reading every stack's logs", () => {
  const requests: Array<HttpClientRequest.HttpClientRequest> = [];
  const layer = makeLayer({
    requests,
    response: (request) =>
      new URL(request.url).pathname === "/api/app-dev-stacks"
        ? Response.json([platformRecord])
        : new Response(`unexpected request ${request.url}`, { status: 404 }),
  });
  return Effect.gen(function* () {
    const manager = yield* AppStackManager;
    const result = yield* manager.getAllStackPodLogs({});
    assert.deepEqual(result.stacks, []);
    assert.equal(requests.length, 1);
  }).pipe(Effect.provide(layer));
});
