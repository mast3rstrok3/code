import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import * as ServerConfig from "../config.ts";
import { AppDevStackManager } from "./AppDevStackManager.ts";

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

const derivedPaths = {
  stateDir: "/tmp/t3-app-dev-stack-manager-test/state",
  dbPath: "/tmp/t3-app-dev-stack-manager-test/state/state.sqlite",
  keybindingsConfigPath: "/tmp/t3-app-dev-stack-manager-test/state/keybindings.json",
  settingsPath: "/tmp/t3-app-dev-stack-manager-test/state/settings.json",
  providerStatusCacheDir: "/tmp/t3-app-dev-stack-manager-test/caches",
  worktreesDir: "/tmp/t3-app-dev-stack-manager-test/worktrees",
  attachmentsDir: "/tmp/t3-app-dev-stack-manager-test/state/attachments",
  logsDir: "/tmp/t3-app-dev-stack-manager-test/state/logs",
  serverLogPath: "/tmp/t3-app-dev-stack-manager-test/state/logs/server.log",
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
    otlpExportIntervalMs: 10_000,
    otlpServiceName: "t3-server",
    mode: "web",
    port: 0,
    host: undefined,
    cwd: process.cwd(),
    baseDir: "/tmp/t3-app-dev-stack-manager-test",
    ...derivedPaths,
    staticDir: undefined,
    devUrl: undefined,
    appDevStackBackendUrl: input?.url ?? backendUrl,
    appDevStackBackendBearerToken:
      input?.bearerToken === undefined ? undefined : Redacted.make(input.bearerToken),
    appDevStackBackendOidcTokenUrl: input?.oidc?.tokenUrl,
    appDevStackBackendOidcClientId: input?.oidc?.clientId,
    appDevStackBackendOidcClientSecret:
      input?.oidc === undefined ? undefined : Redacted.make(input.oidc.clientSecret),
    appDevStackNative: undefined,
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
    previewBrowserSandbox: "auto",
    previewBrowserMaxFps: 12,
    previewBrowserMaxFrameWidth: 1600,
    previewBrowserMaxFrameHeight: 1200,
    previewBrowserJpegQuality: 75,
    previewBrowserIdleTtlMs: 600_000,
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
}) =>
  AppDevStackManager.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        makeConfigLayer({ bearerToken: input.bearerToken, oidc: input.oidc }),
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
    response: () =>
      Response.json({
        stack: stackJson,
        created: true,
        frontendUrl: null,
        frontendServiceName: null,
      }),
  });

  return Effect.gen(function* () {
    const manager = yield* AppDevStackManager;
    yield* manager.autoCreate({
      worktreePath: "/repo/worktrees/feature",
      displayName: "feature",
      gitBranch: "feature",
    });

    const request = requests[0];
    if (request === undefined) {
      assert.fail("expected AppDevStackManager to send a backend request");
    }
    assert.equal(request.method, "POST");
    assert.equal(
      request.url,
      `${backendUrl.href.replace(/\/+$/u, "")}/api/app-dev-stacks/auto-create`,
    );
    assert.equal(request.headers.authorization, "Bearer backend-token");
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
      return Response.json({
        stack: stackJson,
        created: true,
        frontendUrl: null,
        frontendServiceName: null,
      });
    },
  });

  return Effect.gen(function* () {
    const manager = yield* AppDevStackManager;
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

    assert.equal(requests.length, 3);
    assert.equal(requests[0]?.method, "POST");
    assert.equal(requests[0]?.url, tokenUrl.href);
    assert.equal(requests[1]?.headers.authorization, "Bearer oidc-token");
    assert.equal(requests[2]?.headers.authorization, "Bearer oidc-token");
  }).pipe(Effect.provide(layer));
});

it.effect(
  "names the app dev stack token env var when the backend rejects unauthenticated calls",
  () => {
    const requests: Array<HttpClientRequest.HttpClientRequest> = [];
    const layer = makeLayer({
      requests,
      response: () => new Response("missing bearer token", { status: 401 }),
    });

    return Effect.gen(function* () {
      const manager = yield* AppDevStackManager;
      const error = yield* manager
        .autoCreate({
          worktreePath: "/repo/worktrees/feature",
          displayName: "feature",
          gitBranch: "feature",
        })
        .pipe(Effect.flip);

      assert.equal(requests[0]?.headers.authorization, undefined);
      assert.equal(error.status, 401);
      assert.include(error.message, "T3CODE_APP_DEV_STACK_BACKEND_BEARER_TOKEN");
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
    const manager = yield* AppDevStackManager;
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
    const manager = yield* AppDevStackManager;
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
          error: "App Dev Stack backend responded with 500: sidecar logs unavailable",
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
