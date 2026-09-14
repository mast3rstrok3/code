import { DEFAULT_WORKSPACE_USER_ID } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import {
  AppStack,
  AppStackError,
  EnvironmentId,
  OrchestrationProjectShell,
  OrchestrationThreadShell,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { McpServer, McpSchema } from "effect/unstable/ai";

import { AppStackManager } from "../../../appStack/AppStackManager.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { McpInvocationContext, type McpCapability } from "../../McpInvocationContext.ts";
import { AppStackToolkitRegistrationLive } from "../../McpHttpServer.ts";
import { handlers } from "./handlers.ts";

const thread = Schema.decodeUnknownSync(OrchestrationThreadShell)({
  ownerUserId: DEFAULT_WORKSPACE_USER_ID,
  parentThreadId: null,
  workflowRole: null,
  pullRequests: [],

  id: "thread-1",
  projectId: "project-1",
  title: "Check dev",
  modelSelection: { instanceId: "codex", model: "gpt-5.4" },
  runtimeMode: "full-access",
  branch: "dev",
  worktreePath: null,
  latestTurn: null,
  session: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});
const project = Schema.decodeUnknownSync(OrchestrationProjectShell)({
  id: "project-1",
  title: "Rudi",
  workspaceRoot: "/repo/rudi",
  defaultModelSelection: null,
  scripts: [],
  createdAt: thread.createdAt,
  updatedAt: thread.updatedAt,
});
const stack = Schema.decodeUnknownSync(AppStack)({
  id: "stack-1",
  uuid: "stack-1",
  userId: "user-1",
  worktreePath: "/repo/rudi",
  composePath: "infra/compose/compose.app-dev.yml",
  displayName: "Rudi dev",
  description: null,
  workflowId: "workflow-1",
  status: "running",
  services: [],
  serviceCount: 0,
  lastError: null,
  errorCount: 0,
  createdAt: thread.createdAt,
  updatedAt: thread.updatedAt,
});
const emptyStack = { stack: null, frontendUrl: null, frontendServiceName: null };
const leaseId = "935970a8-0032-4c65-b87f-5c36fd46bb91";
const deviceLease = {
  platform: "android" as const,
  status: "queued",
  leaseId,
  expiresAt: null,
  queueReason: "capacity",
  queuePosition: 2,
  queuedAt: thread.createdAt,
  queueExpiresAt: "2026-01-01T01:00:00.000Z",
  retryAfterSeconds: 10,
  error: null,
  stopReason: null,
};
const invocation = Layer.succeed(McpInvocationContext, {
  threadId: ThreadId.make("thread-1"),
  environmentId: EnvironmentId.make("env-1"),
  providerInstanceId: ProviderInstanceId.make("codex"),
  providerSessionId: "session-1",
  capabilities: new Set<McpCapability>(),
  issuedAt: 1,
});

function harness(
  input: {
    worktreePath?: string;
    missing?: boolean;
    missingProject?: boolean;
    enabled?: boolean;
    fail?: boolean;
    stack?: AppStack;
    createdStack?: AppStack;
    reserved?: boolean;
    failMutation?: boolean;
  } = {},
) {
  const calls: Array<{ worktreePath: string; variant?: string | undefined }> = [];
  const operations: Array<{ operation: string; input: unknown }> = [];
  let currentStack = input.stack ?? null;
  const mutate = (operation: string, request: unknown): Effect.Effect<AppStack, AppStackError> => {
    operations.push({ operation, input: request });
    return input.failMutation
      ? Effect.fail(new AppStackError({ operation, message: "backend unavailable" }))
      : Effect.succeed({ ...(currentStack ?? stack), status: "running" as const });
  };
  const layer = Layer.mergeAll(
    invocation,
    Layer.mock(ProjectionSnapshotQuery)({
      getThreadShellById: (id) => {
        expect(id).toBe(thread.id);
        return Effect.succeed(
          input.missing
            ? Option.none()
            : Option.some({
                ...thread,
                worktreePath: input.worktreePath ?? null,
              }),
        );
      },
      getProjectShellById: (id) => {
        expect(id).toBe(project.id);
        return Effect.succeed(input.missingProject ? Option.none() : Option.some(project));
      },
    }),
    Layer.mock(AppStackManager)({
      startDevice: (request) => {
        operations.push({ operation: "startDevice", input: request });
        return Effect.succeed({ ...deviceLease, platform: request.platform });
      },
      stopDevice: (request) => {
        operations.push({ operation: "stopDevice", input: request });
        return Effect.succeed({
          ...deviceLease,
          platform: request.platform,
          status: "stopped",
          leaseId: null,
        });
      },
      getDeviceLease: (request) => {
        operations.push({ operation: "getDeviceLease", input: request });
        return Effect.succeed({ ...deviceLease, platform: request.platform });
      },
      getDeviceStatus: (request) => {
        operations.push({ operation: "getDeviceStatus", input: request });
        return Effect.succeed({
          present: false,
          phase: "Absent",
          guestAgentConnected: false,
          ready: false,
        });
      },
      status: Effect.succeed({ enabled: input.enabled ?? true, backendUrl: null }),
      getByWorktree: (request) => {
        calls.push(request);
        return input.fail
          ? Effect.fail(new AppStackError({ operation: "getByWorktree", message: "offline" }))
          : Effect.succeed({ ...emptyStack, stack: currentStack });
      },
      autoCreate: (request) =>
        mutate("autoCreate", request).pipe(
          Effect.map(() => ({
            ...emptyStack,
            stack: input.reserved
              ? null
              : (input.createdStack ?? {
                  ...stack,
                  worktreePath: request.worktreePath,
                  variant: request.variant ?? "dev",
                }),
            created: !input.reserved,
            reserved: input.reserved ?? false,
            frontendUrl: input.reserved ? "https://standing.example.test" : null,
          })),
        ),
      stop: (request) => mutate("stop", request),
      restart: (request) =>
        mutate("restart", request).pipe(
          Effect.tap((result) =>
            Effect.sync(() => {
              currentStack = result;
            }),
          ),
        ),
      delete: (request) => mutate("delete", request).pipe(Effect.as({ deleted: true as const })),
      listPods: (request) => {
        operations.push({ operation: "listPods", input: request });
        return Effect.succeed({ stackId: request.stackId, namespace: "rudi-dev", pods: [] });
      },
      getPodLogs: (request) => {
        operations.push({ operation: "getPodLogs", input: request });
        return Effect.succeed({
          ...request,
          namespace: "rudi-dev",
          containerName: request.containerName ?? null,
          tailLines: request.tailLines ?? 200,
          logs: "Server ready",
          fetchedAt: thread.createdAt,
        });
      },
    }),
  );
  return { layer, calls, operations };
}

it.effect("refreshes the authenticated repo-root workspace and defaults to dev", () => {
  const test = harness();
  return Effect.gen(function* () {
    const result = yield* handlers.app_stack_get({});
    yield* handlers.app_stack_get({});
    expect(result).toMatchObject({
      ...emptyStack,
      worktreePath: "/repo/rudi",
      variant: "dev",
      enabled: true,
    });
    expect(result.checkedAt).toMatch(/^\d{4}-/);
    expect(test.calls).toEqual([
      { worktreePath: "/repo/rudi", variant: "dev" },
      { worktreePath: "/repo/rudi", variant: "dev" },
    ]);
  }).pipe(Effect.provide(test.layer));
});

it.effect("keeps an explicit child worktree and prod request scoped to that directory", () => {
  const test = harness({ worktreePath: "/worktrees/feature" });
  return Effect.gen(function* () {
    yield* handlers.app_stack_get({ variant: "prod" });
    expect(test.calls).toEqual([{ worktreePath: "/worktrees/feature", variant: "prod" }]);
  }).pipe(Effect.provide(test.layer));
});

it.effect("reports disabled integration without looking up a stack", () => {
  const test = harness({ enabled: false });
  return Effect.gen(function* () {
    expect((yield* handlers.app_stack_get({})).enabled).toBe(false);
    expect(test.calls).toEqual([]);
  }).pipe(Effect.provide(test.layer));
});

it.effect("rejects a missing thread without falling back to another workspace", () => {
  const test = harness({ missing: true });
  return Effect.gen(function* () {
    const error = yield* handlers.app_stack_get({}).pipe(Effect.flip);
    expect(error.message).toContain("workspace was not found");
    expect(test.calls).toEqual([]);
  }).pipe(Effect.provide(test.layer));
});

it.effect("reports lookup failure instead of claiming no stack exists", () => {
  const test = harness({ fail: true });
  return Effect.gen(function* () {
    const error = yield* handlers.app_stack_get({}).pipe(Effect.flip);
    expect(error.message).toContain("Could not refresh");
  }).pipe(Effect.provide(test.layer));
});

it.effect("registers workspace tools, validates inputs, and returns results through MCP", () => {
  const test = harness({ stack });
  const layer = AppStackToolkitRegistrationLive.pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provideMerge(test.layer),
  );
  return Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const listed = { tools: server.tools.map(({ tool }) => tool) };
      expect(listed.tools.map((tool) => tool.name).toSorted()).toEqual([
        "app_stack_delete",
        "app_stack_device_start",
        "app_stack_device_status",
        "app_stack_device_stop",
        "app_stack_get",
        "app_stack_list_pods",
        "app_stack_logs",
        "app_stack_restart",
        "app_stack_start",
        "app_stack_stop",
      ]);
      for (const tool of listed.tools) {
        expect(tool.inputSchema.type).toBe("object");
        expect(tool.inputSchema.properties).not.toHaveProperty("worktreePath");
        expect(tool.inputSchema.properties).not.toHaveProperty("stackId");
        expect(tool.inputSchema.properties).not.toHaveProperty("namespace");
      }
      expect(
        listed.tools.find((tool) => tool.name === "app_stack_delete")?.annotations?.destructiveHint,
      ).toBe(true);
      const response = yield* server.callTool({ name: "app_stack_get", arguments: {} });
      expect(response.isError).not.toBe(true);
      expect(response.structuredContent).toMatchObject({
        worktreePath: "/repo/rudi",
        variant: "dev",
        enabled: true,
        stack: { id: stack.id },
      });
      const created = yield* server.callTool({
        name: "app_stack_start",
        arguments: {},
      });
      expect(created.isError).not.toBe(true);
      expect(created.structuredContent).toMatchObject({
        created: false,
        stack: { id: stack.id },
      });
      for (const tailLines of [0, -1, 5001, 1.5]) {
        const invalid = yield* server
          .callTool({ name: "app_stack_logs", arguments: { podName: "api-1", tailLines } })
          .pipe(Effect.result);
        expect(invalid._tag === "Failure" || invalid.success.isError === true).toBe(true);
      }
      expect(test.operations).toHaveLength(0);
      for (const arguments_ of [
        { platform: "android" },
        { platform: "android", leaseId: "bad-id" },
        { platform: "ios", leaseId },
        { platform: "windows", leaseId, ttlSeconds: 59 },
        { platform: "windows", leaseId, ttlSeconds: 7201 },
        { platform: "windows", leaseId, ttlSeconds: 60.5 },
      ]) {
        const invalid = yield* server
          .callTool({ name: "app_stack_device_start", arguments: arguments_ })
          .pipe(Effect.result);
        expect(invalid._tag === "Failure" || invalid.success.isError === true).toBe(true);
      }
      expect(test.operations).toHaveLength(0);
      for (const name of [
        "app_stack_stop",
        "app_stack_restart",
        "app_stack_list_pods",
        "app_stack_logs",
        "app_stack_delete",
      ]) {
        const result = yield* server.callTool({
          name,
          arguments: name === "app_stack_logs" ? { podName: "api-1", tailLines: 1 } : {},
        });
        expect(result.isError, name).not.toBe(true);
        expect(result.structuredContent, name).toBeDefined();
      }
      expect(test.operations).toHaveLength(5);
      const leased = yield* server.callTool({
        name: "app_stack_device_start",
        arguments: { platform: "android", leaseId },
      });
      expect(leased.isError).not.toBe(true);
      expect(leased.structuredContent).toMatchObject({
        lease: deviceLease,
        access: { namespace: "rudi-dev" },
      });
      expect(test.operations.at(-1)).toEqual({
        operation: "startDevice",
        input: { stackId: stack.id, platform: "android", leaseId },
      });
    }),
  ).pipe(
    Effect.provide(layer),
    Effect.provideService(McpSchema.McpServerClient, {
      clientId: 1,
      protocolVersion: "2025-06-18",
      clientCapabilities: {},
      clientInfo: { name: "app-stack-test", version: "1" },
      initializePayload: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "app-stack-test", version: "1" },
      },
      getClient: Effect.die("unused"),
    }),
  );
});

it.effect("starts the authenticated worktree with its branch and explicit variant", () => {
  const test = harness({ worktreePath: "/worktrees/feature" });
  return Effect.gen(function* () {
    const result = yield* handlers.app_stack_start({
      variant: "prod",
      displayName: "Feature preview",
    });
    expect(result.created).toBe(true);
    expect(test.operations).toEqual([
      {
        operation: "autoCreate",
        input: {
          worktreePath: "/worktrees/feature",
          gitBranch: "dev",
          variant: "prod",
          displayName: "Feature preview",
        },
      },
    ]);
  }).pipe(Effect.provide(test.layer));
});

it.effect("reuses an existing stack without provisioning or changing its owner", () => {
  const test = harness({ stack });
  return Effect.gen(function* () {
    const result = yield* handlers.app_stack_start({ displayName: "New name" });
    expect(result).toMatchObject({
      created: false,
      alreadyRunning: true,
      stack: { workflowId: "workflow-1" },
    });
    expect(test.operations).toEqual([]);
  }).pipe(Effect.provide(test.layer));
});

for (const status of ["stopped", "error"] as const) {
  it.effect(
    `starts an existing ${status} stack through restart, preserving its configuration`,
    () => {
      const test = harness({ stack: { ...stack, status } });
      return Effect.gen(function* () {
        const result = yield* handlers.app_stack_start({});
        expect(result).toMatchObject({
          created: false,
          stack: { status: "running", workflowId: "workflow-1" },
        });
        expect(test.operations).toEqual([{ operation: "restart", input: { stackId: stack.id } }]);
      }).pipe(Effect.provide(test.layer));
    },
  );
}

it.effect("does not start a stack while it is stopping", () => {
  const test = harness({ stack: { ...stack, status: "stopping" } });
  return Effect.gen(function* () {
    const error = yield* handlers.app_stack_start({}).pipe(Effect.flip);
    expect(error.message).toContain("still stopping");
    expect(test.operations).toEqual([]);
  }).pipe(Effect.provide(test.layer));
});

it.effect("preserves reserved deployment results without claiming a new stack", () => {
  const test = harness({ reserved: true });
  return Effect.gen(function* () {
    const result = yield* handlers.app_stack_start({});
    expect(result).toMatchObject({
      stack: null,
      created: false,
      reserved: true,
      frontendUrl: "https://standing.example.test",
    });
    expect(test.operations[0]).toMatchObject({
      input: { displayName: "rudi dev", variant: "dev" },
    });
  }).pipe(Effect.provide(test.layer));
});

const scopedOperations = [
  { name: "stop", run: () => handlers.app_stack_stop({}).pipe(Effect.asVoid) },
  { name: "restart", run: () => handlers.app_stack_restart({}).pipe(Effect.asVoid) },
  { name: "delete", run: () => handlers.app_stack_delete({}).pipe(Effect.asVoid) },
  { name: "listPods", run: () => handlers.app_stack_list_pods({}).pipe(Effect.asVoid) },
  {
    name: "getPodLogs",
    run: () => handlers.app_stack_logs({ podName: "api-1" }).pipe(Effect.asVoid),
  },
];

for (const operation of scopedOperations) {
  it.effect(`${operation.name} uses only the stack resolved from this thread`, () => {
    const test = harness({ stack });
    return Effect.gen(function* () {
      yield* operation.run();
      expect(test.calls).toEqual([{ worktreePath: "/repo/rudi", variant: "dev" }]);
      expect(test.operations).toEqual([
        {
          operation: operation.name,
          input: {
            stackId: stack.id,
            ...(operation.name === "getPodLogs" ? { podName: "api-1", tailLines: 200 } : {}),
          },
        },
      ]);
    }).pipe(Effect.provide(test.layer));
  });
}

const allOperations = [
  { name: "start", run: () => handlers.app_stack_start({}).pipe(Effect.asVoid) },
  {
    name: "deviceStart",
    run: () =>
      handlers.app_stack_device_start({ platform: "android", leaseId }).pipe(Effect.asVoid),
  },
  {
    name: "deviceStatus",
    run: () => handlers.app_stack_device_status({ platform: "windows" }).pipe(Effect.asVoid),
  },
  {
    name: "deviceStop",
    run: () => handlers.app_stack_device_stop({ platform: "windows", leaseId }).pipe(Effect.asVoid),
  },
  ...scopedOperations,
];

for (const input of [
  { missing: true },
  { missingProject: true },
  { enabled: false },
  { fail: true },
  { stack: { ...stack, worktreePath: "/another-worktree" } },
  { stack: { ...stack, variant: "prod" as const } },
  { stack: { ...stack, composePath: "infra/compose/compose.app-prod.yml" } },
]) {
  it.effect(
    `rejects unresolved or mismatched targets without operating: ${JSON.stringify(input)}`,
    () => {
      const test = harness(input);
      return Effect.gen(function* () {
        for (const operation of allOperations) {
          const error = yield* operation.run().pipe(Effect.flip);
          expect(error._tag).toBe("AppStackError");
        }
        expect(test.operations).toEqual([]);
      }).pipe(Effect.provide(test.layer));
    },
  );
}

it.effect("requires a managed stack for mutations and logs", () => {
  const test = harness();
  return Effect.gen(function* () {
    for (const operation of scopedOperations) {
      const error = yield* operation.run().pipe(Effect.flip);
      expect(error.message).toContain("No managed App Stack");
    }
    expect(test.operations).toEqual([]);
  }).pipe(Effect.provide(test.layer));
});

it.effect("reads the requested prod pod and container with the requested log limit", () => {
  const test = harness({ stack: { ...stack, variant: "prod" } });
  return Effect.gen(function* () {
    const result = yield* handlers.app_stack_logs({
      variant: "prod",
      podName: "backend-1",
      containerName: "api",
      tailLines: 1000,
    });
    expect(result.logs).toBe("Server ready");
    expect(test.calls).toEqual([{ worktreePath: "/repo/rudi", variant: "prod" }]);
    expect(test.operations).toEqual([
      {
        operation: "getPodLogs",
        input: { stackId: stack.id, podName: "backend-1", containerName: "api", tailLines: 1000 },
      },
    ]);
  }).pipe(Effect.provide(test.layer));
});

it.effect("propagates backend mutation failures", () => {
  const test = harness({ stack, failMutation: true });
  return Effect.gen(function* () {
    const error = yield* handlers.app_stack_stop({}).pipe(Effect.flip);
    expect(error.message).toBe("backend unavailable");
  }).pipe(Effect.provide(test.layer));
});

it.effect("rejects a controller create response for another variant", () => {
  const test = harness({ createdStack: { ...stack, variant: "prod" } });
  return Effect.gen(function* () {
    const error = yield* handlers.app_stack_start({}).pipe(Effect.flip);
    expect(error.reason).toBe("invalid_response");
  }).pipe(Effect.provide(test.layer));
});

for (const platform of ["android", "windows"] as const) {
  it.effect(`leases ${platform} for the authenticated worktree without local device access`, () => {
    const test = harness({
      worktreePath: "/repo/feature",
      stack: { ...stack, worktreePath: "/repo/feature", namespace: "dev-feature" },
    });
    return Effect.gen(function* () {
      const result = yield* handlers.app_stack_device_start({ platform, leaseId, ttlSeconds: 300 });
      expect(result.lease).toEqual({ ...deviceLease, platform });
      expect(result.access.namespace).toBe("dev-feature");
      expect(result.access.execPrefix).toEqual([
        "kubectl",
        "-n",
        "dev-feature",
        "exec",
        `deployment/${platform === "android" ? "android-emulator" : "windows-runner"}`,
        "--",
        platform === "android" ? "adb" : "windows",
      ]);
      expect(test.calls).toEqual([{ worktreePath: "/repo/feature", variant: "dev" }]);
      expect(test.operations).toEqual([
        {
          operation: "startDevice",
          input: { stackId: stack.id, platform, leaseId, ttlSeconds: 300 },
        },
      ]);
    }).pipe(Effect.provide(test.layer));
  });
}

it.effect("reports queued Windows readiness and releases only the supplied device lease", () => {
  const test = harness({ stack: { ...stack, variant: "prod", namespace: "dev-feature-prod" } });
  return Effect.gen(function* () {
    const result = yield* handlers.app_stack_device_status({
      platform: "windows",
      variant: "prod",
    });
    expect(result.lease.status).toBe("queued");
    expect(result.lease.retryAfterSeconds).toBe(10);
    expect(result.readiness).toMatchObject({ ready: false, guestAgentConnected: false });
    const released = yield* handlers.app_stack_device_stop({
      platform: "windows",
      variant: "prod",
      leaseId,
    });
    expect(released.status).toBe("stopped");
    expect(test.operations).toEqual([
      { operation: "getDeviceLease", input: { stackId: stack.id, platform: "windows" } },
      { operation: "getDeviceStatus", input: { stackId: stack.id, platform: "windows" } },
      { operation: "stopDevice", input: { stackId: stack.id, platform: "windows", leaseId } },
    ]);
    expect(test.calls).toEqual(
      Array.from({ length: 2 }, () => ({ worktreePath: "/repo/rudi", variant: "prod" })),
    );
  }).pipe(Effect.provide(test.layer));
});
