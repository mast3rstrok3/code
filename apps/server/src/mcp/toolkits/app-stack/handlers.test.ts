import { DEFAULT_WORKSPACE_USER_ID } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import {
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
const emptyStack = { stack: null, frontendUrl: null, frontendServiceName: null };
const invocation = Layer.succeed(McpInvocationContext, {
  threadId: ThreadId.make("thread-1"),
  environmentId: EnvironmentId.make("env-1"),
  providerInstanceId: ProviderInstanceId.make("codex"),
  providerSessionId: "session-1",
  capabilities: new Set<McpCapability>(),
  issuedAt: 1,
});

function harness(
  input: { worktreePath?: string; missing?: boolean; enabled?: boolean; fail?: boolean } = {},
) {
  const calls: Array<{ worktreePath: string; variant?: string | undefined }> = [];
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
        return Effect.succeed(Option.some(project));
      },
    }),
    Layer.mock(AppStackManager)({
      status: Effect.succeed({ enabled: input.enabled ?? true, backendUrl: null }),
      getByWorktree: (request) => {
        calls.push(request);
        return input.fail
          ? Effect.fail(new AppStackError({ operation: "getByWorktree", message: "offline" }))
          : Effect.succeed(emptyStack);
      },
    }),
  );
  return { layer, calls };
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

it.effect("registers app_stack_get and returns workspace status through MCP", () => {
  const test = harness();
  const layer = AppStackToolkitRegistrationLive.pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provideMerge(test.layer),
  );
  return Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const response = yield* server.callTool({ name: "app_stack_get", arguments: {} });
      expect(response.isError).not.toBe(true);
      expect(response.structuredContent).toMatchObject({
        worktreePath: "/repo/rudi",
        variant: "dev",
        enabled: true,
        stack: null,
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
