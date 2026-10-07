import {
  AppStackError,
  DEFAULT_WORKSPACE_USER_ID,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WorkflowId,
  type AppStack,
  type OrchestrationEvent,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { AppStackManager } from "../appStack/AppStackManager.ts";
import { ServerActivation } from "../serverActivation.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import * as AppStackLifecycleReactor from "./AppStackLifecycleReactor.ts";

const NOW = "2026-10-07T12:00:00.000Z";
const PROJECT_ID = ProjectId.make("project");
const WORKTREE = "/workspace/project.worktrees/feature";

function thread(
  id = "thread",
  overrides: Partial<OrchestrationThreadShell> = {},
): OrchestrationThreadShell {
  return {
    id: ThreadId.make(id),
    projectId: PROJECT_ID,
    ownerUserId: DEFAULT_WORKSPACE_USER_ID,
    parentThreadId: null,
    workflowRole: null,
    title: id,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    pullRequests: [],
    branch: "feature",
    worktreePath: WORKTREE,
    latestTurn: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: "settled",
    settledAt: NOW,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

function stack(id = "stack", overrides: Partial<AppStack> = {}): AppStack {
  return {
    id,
    uuid: id,
    userId: "user",
    worktreePath: WORKTREE,
    composePath: "infra/compose/compose.app-dev.yml",
    displayName: id,
    description: null,
    branchName: "feature",
    status: "running",
    services: [],
    serviceCount: 0,
    lastError: null,
    errorCount: 0,
    protected: false,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function snapshot(threads: ReadonlyArray<OrchestrationThreadShell>): OrchestrationShellSnapshot {
  return {
    snapshotSequence: 1,
    threads,
    projects: [
      {
        id: PROJECT_ID,
        ownerUserId: DEFAULT_WORKSPACE_USER_ID,
        title: "Project",
        workspaceRoot: "/workspace/project",
        defaultModelSelection: null,
        scripts: [],
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    updatedAt: NOW,
  };
}

function settledEvent(threadId: ThreadId): OrchestrationEvent {
  return {
    type: "thread.settled",
    sequence: 1,
    eventId: EventId.make(`settled:${threadId}`),
    aggregateKind: "thread",
    aggregateId: threadId,
    occurredAt: NOW,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: { threadId, settledAt: NOW, updatedAt: NOW },
  };
}

const makeHarness = Effect.fn("makeAppStackLifecycleHarness")(function* (
  threads: ReadonlyArray<OrchestrationThreadShell>,
  initialStacks: ReadonlyArray<AppStack>,
  enabled = true,
) {
  const snapshots = yield* Ref.make(snapshot(threads));
  const stacks = yield* Ref.make(initialStacks);
  const stopped = yield* Ref.make<string[]>([]);
  const failedIds = yield* Ref.make(new Set<string>());
  const listCalls = yield* Ref.make(0);
  const getHook = yield* Ref.make<Effect.Effect<void>>(Effect.void);
  const statuses = yield* Queue.unbounded<void>();
  const events = yield* Queue.unbounded<OrchestrationEvent>();
  const activation = yield* Deferred.make<void>();
  const dependencies = Layer.mergeAll(
    Layer.mock(OrchestrationEngineService)({
      subscribeDomainEvents: Effect.succeed(Stream.fromQueue(events)),
    }),
    Layer.mock(ProjectionSnapshotQuery)({
      getShellSnapshot: () => Ref.get(snapshots),
    }),
    Layer.mock(AppStackManager)({
      status: Queue.offer(statuses, undefined).pipe(Effect.as({ enabled, backendUrl: null })),
      list: () =>
        Ref.update(listCalls, (calls) => calls + 1).pipe(
          Effect.andThen(Ref.get(stacks)),
          Effect.map((stacks) => ({ stacks })),
        ),
      get: ({ stackId }) =>
        Effect.gen(function* () {
          const hook = yield* Ref.get(getHook);
          yield* hook;
          const current = (yield* Ref.get(stacks)).find((stack) => stack.id === stackId);
          if (current === undefined) return yield* Effect.die("Unknown test stack");
          return current;
        }),
      stop: ({ stackId }) =>
        Effect.gen(function* () {
          if ((yield* Ref.get(failedIds)).has(stackId)) {
            return yield* new AppStackError({
              operation: "stop",
              reason: "request_failed",
              message: "Stop failed",
            });
          }
          const current = (yield* Ref.get(stacks)).find((stack) => stack.id === stackId);
          if (current === undefined) return yield* Effect.die("Unknown test stack");
          yield* Ref.update(stopped, (ids) => [...ids, stackId]);
          yield* Ref.update(stacks, (members) =>
            members.map((member) =>
              member.id === stackId ||
              (current.bundleId != null && member.bundleId === current.bundleId)
                ? { ...member, status: "stopped" as const }
                : member,
            ),
          );
          return { ...current, status: "stopped" as const };
        }),
    }),
    Layer.succeed(ServerActivation, Deferred.await(activation)),
  );
  const reactor = yield* AppStackLifecycleReactor.make.pipe(Effect.provide(dependencies));
  yield* reactor.start();
  yield* Deferred.succeed(activation, undefined);
  yield* Queue.take(statuses);
  yield* reactor.drain;

  const settle = Effect.fnUntraced(function* (threadId: ThreadId) {
    yield* Queue.offer(events, settledEvent(threadId));
    yield* Queue.take(statuses);
    yield* reactor.drain;
  });

  return { snapshots, stacks, stopped, failedIds, listCalls, getHook, settle };
});

describe("AppStackLifecycleReactor", () => {
  it.effect("cleans up settled threads at startup, including dev and prod stacks", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness(
        [thread()],
        [
          stack("dev", { worktreePath: `${WORKTREE}/` }),
          stack("prod", { composePath: "infra/compose/compose.app-prod.yml", variant: "prod" }),
          stack("other", { worktreePath: "/workspace/other" }),
          stack("stopped", { status: "stopped" }),
          stack("stopping", { status: "stopping" }),
        ],
      );
      expect(yield* Ref.get(h.stopped)).toEqual(["dev", "prod"]);
      yield* h.settle(ThreadId.make("thread"));
      expect(yield* Ref.get(h.stopped)).toEqual(["dev", "prod"]);
    }),
  );

  it.effect("reacts to settlement without waiting for a timer", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness(
        [thread("thread", { settledOverride: null, settledAt: null })],
        [stack()],
      );
      expect(yield* Ref.get(h.listCalls)).toBe(0);
      yield* Ref.set(h.snapshots, snapshot([thread()]));
      yield* h.settle(ThreadId.make("thread"));
      expect(yield* Ref.get(h.stopped)).toEqual(["stack"]);
    }),
  );

  it.effect("keeps a shared worktree running until every thread settles", () =>
    Effect.gen(function* () {
      const child = thread("child", {
        parentThreadId: ThreadId.make("thread"),
        settledOverride: null,
        settledAt: null,
      });
      const h = yield* makeHarness([thread(), child], [stack()]);
      expect(yield* Ref.get(h.stopped)).toEqual([]);
      yield* Ref.set(
        h.snapshots,
        snapshot([thread(), { ...child, settledOverride: "settled", settledAt: NOW }]),
      );
      yield* h.settle(child.id);
      expect(yield* Ref.get(h.stopped)).toEqual(["stack"]);
    }),
  );

  it.effect("resolves threads without a worktree to their project directory", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness(
        [thread("thread", { worktreePath: null })],
        [stack("local", { worktreePath: "/workspace/project" })],
      );
      expect(yield* Ref.get(h.stopped)).toEqual(["local"]);
    }),
  );

  it.effect.each(["dev", "main"])("preserves standing %s deployments", (branchName) =>
    Effect.gen(function* () {
      const h = yield* makeHarness([thread()], [stack("standing", { branchName })]);
      expect(yield* Ref.get(h.stopped)).toEqual([]);
    }),
  );

  it.effect("preserves protected stacks and bundles with a protected member", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness(
        [thread()],
        [
          stack("protected", { protected: true }),
          stack("bundle-root", { bundleId: "bundle" }),
          stack("bundle-protected", {
            bundleId: "bundle",
            worktreePath: "/workspace/bundled",
            protected: true,
          }),
        ],
      );
      expect(yield* Ref.get(h.stopped)).toEqual([]);
    }),
  );

  it.effect("stops a bundle once and preserves bundles used by another project", () =>
    Effect.gen(function* () {
      const active = thread("active", {
        projectId: ProjectId.make("another-project"),
        worktreePath: "/workspace/active",
        settledOverride: null,
        settledAt: null,
      });
      const h = yield* makeHarness(
        [thread(), active],
        [
          stack("root", { bundleId: "idle-bundle" }),
          stack("member", { bundleId: "idle-bundle", worktreePath: "/workspace/bundled" }),
          stack("shared-root", { bundleId: "active-bundle" }),
          stack("shared-member", { bundleId: "active-bundle", worktreePath: "/workspace/active" }),
        ],
      );
      expect(yield* Ref.get(h.stopped)).toEqual(["root"]);
    }),
  );

  it.effect("preserves stacks owned by an active parent workflow", () =>
    Effect.gen(function* () {
      const workflowId = WorkflowId.make("workflow");
      const active = thread("active", {
        worktreePath: "/workspace/active",
        settledOverride: null,
        settledAt: null,
        workflowContext: {
          workflowId: WorkflowId.make("nested"),
          parentWorkflowId: workflowId,
          rootThreadId: ThreadId.make("active"),
          ticketScope: [],
        },
      });
      const h = yield* makeHarness([thread(), active], [stack("owned", { workflowId })]);
      expect(yield* Ref.get(h.stopped)).toEqual([]);
      yield* Ref.set(
        h.snapshots,
        snapshot([thread(), { ...active, settledOverride: "settled", settledAt: NOW }]),
      );
      yield* h.settle(active.id);
      expect(yield* Ref.get(h.stopped)).toEqual(["owned"]);
    }),
  );

  it.effect("keeps a stack while a settled thread has a queued turn", () =>
    Effect.gen(function* () {
      const now = DateTime.formatIso(yield* DateTime.now);
      const h = yield* makeHarness([thread("thread", { latestUserMessageAt: now })], [stack()]);
      expect(yield* Ref.get(h.stopped)).toEqual([]);
      expect(yield* Ref.get(h.listCalls)).toBe(0);
    }),
  );

  it.effect.each(["pending", "starting", "error"] as const)(
    "stops %s stacks because they can still hold resources",
    (status) =>
      Effect.gen(function* () {
        const h = yield* makeHarness([thread()], [stack("unfinished", { status })]);
        expect(yield* Ref.get(h.stopped)).toEqual(["unfinished"]);
      }),
  );

  it.effect("rechecks resumed threads before stopping", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness(
        [thread("thread", { settledOverride: null, settledAt: null })],
        [stack()],
      );
      yield* Ref.set(h.snapshots, snapshot([thread()]));
      yield* Ref.set(
        h.getHook,
        Ref.set(
          h.snapshots,
          snapshot([thread("thread", { settledOverride: "active", settledAt: null })]),
        ),
      );
      yield* h.settle(ThreadId.make("thread"));
      expect(yield* Ref.get(h.stopped)).toEqual([]);
    }),
  );

  it.effect("rechecks protection before stopping", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness(
        [thread("thread", { settledOverride: null, settledAt: null })],
        [stack()],
      );
      yield* Ref.set(h.snapshots, snapshot([thread()]));
      yield* Ref.set(
        h.getHook,
        Ref.update(h.stacks, (stacks) => stacks.map((stack) => ({ ...stack, protected: true }))),
      );
      yield* h.settle(ThreadId.make("thread"));
      expect(yield* Ref.get(h.stopped)).toEqual([]);
    }),
  );

  it.effect("ignores stale settlement events after a thread resumes", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness(
        [thread("thread", { settledOverride: "active", settledAt: null })],
        [stack()],
      );
      yield* h.settle(ThreadId.make("thread"));
      expect(yield* Ref.get(h.stopped)).toEqual([]);
      expect(yield* Ref.get(h.listCalls)).toBe(0);
    }),
  );

  it.effect("a stop failure does not block other stacks or later events", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness(
        [thread("thread", { settledOverride: null, settledAt: null })],
        [stack("failing"), stack("healthy")],
      );
      yield* Ref.set(h.failedIds, new Set(["failing"]));
      yield* Ref.set(h.snapshots, snapshot([thread()]));
      yield* h.settle(ThreadId.make("thread"));
      expect(yield* Ref.get(h.stopped)).toEqual(["healthy"]);
      yield* Ref.set(h.failedIds, new Set());
      yield* h.settle(ThreadId.make("thread"));
      expect(yield* Ref.get(h.stopped)).toEqual(["healthy", "failing"]);
    }),
  );

  it.effect("does not query stacks when the integration is disabled", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness([thread()], [stack()], false);
      yield* h.settle(ThreadId.make("thread"));
      expect(yield* Ref.get(h.listCalls)).toBe(0);
      expect(yield* Ref.get(h.stopped)).toEqual([]);
    }),
  );
});
