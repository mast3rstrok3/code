import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  DEFAULT_WORKSPACE_USER_ID,
  DevReviewId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationImplementationRun,
  type OrchestrationSessionStatus,
  type ProviderSession,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import { describe } from "vite-plus/test";

import { AppDevStackManager } from "../../appDevStack/AppDevStackManager.ts";
import { ServerConfig } from "../../config.ts";
import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
import { layerTest as serverSettingsLayerTest } from "../../serverSettings.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as ProviderSessionRuntime from "../../persistence/ProviderSessionRuntime.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { ProviderSessionDirectory } from "../../provider/Services/ProviderSessionDirectory.ts";
import { ProviderSessionDirectoryLive } from "../../provider/Layers/ProviderSessionDirectory.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ImplementationWorkflowReactorLive } from "./ImplementationWorkflowReactor.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import {
  makeStaleTurnReconcilerLive,
  type StaleTurnReconcilerLiveOptions,
} from "./StaleTurnReconciler.ts";
import {
  ImplementationWorkflowReactor,
  type ImplementationWorkflowReactorShape,
} from "../Services/ImplementationWorkflowReactor.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../Services/ProjectionSnapshotQuery.ts";
import {
  StaleTurnReconciler,
  type StaleTurnReconcilerShape,
} from "../Services/StaleTurnReconciler.ts";

const now = "2026-01-01T00:00:00.000Z";
const projectId = ProjectId.make("project-stale-turn-reconciler");
const sourceThreadId = ThreadId.make("thread-stale-turn-source");

interface ReconcilerSystem {
  readonly engine: OrchestrationEngineShape;
  readonly query: ProjectionSnapshotQueryShape;
  readonly reactor: ImplementationWorkflowReactorShape;
  readonly reconciler: StaleTurnReconcilerShape;
  readonly directory: ProviderSessionDirectory["Service"];
  readonly turns: ProjectionTurnRepository["Service"];
  readonly liveSessions: Ref.Ref<ReadonlyArray<ProviderSession>>;
}

function commandId(value: string) {
  return CommandId.make(`cmd-${value}`);
}

function messageId(value: string) {
  return MessageId.make(`message-${value}`);
}

function eventId(value: string) {
  return EventId.make(`event-${value}`);
}

function makeTestLayer(
  liveSessions: Ref.Ref<ReadonlyArray<ProviderSession>>,
  reconcilerOptions?: StaleTurnReconcilerLiveOptions,
) {
  const coreLayer = Layer.mergeAll(
    OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
    ),
    OrchestrationProjectionSnapshotQueryLive,
  ).pipe(
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provide(SqlitePersistenceMemory),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "stale-turn-reconciler-" })),
    Layer.provideMerge(NodeServices.layer),
  );

  const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
    Layer.provide(SqlitePersistenceMemory),
    Layer.provide(NodeServices.layer),
  );
  const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));

  const providerServiceLayer = Layer.mock(ProviderService)({
    listSessions: () => Ref.get(liveSessions),
  });

  const reactorLayer = ImplementationWorkflowReactorLive.pipe(
    Layer.provide(coreLayer),
    Layer.provide(serverSettingsLayerTest({})),
    Layer.provide(
      Layer.mock(GitWorkflowService)({
        createWorktree: (input) =>
          Effect.succeed({
            worktree: {
              path: input.path ?? "/tmp/generated-worktree",
              refName: input.newRefName ?? "HEAD",
            },
          }),
        createOrOpenChangeRequest: () =>
          Effect.succeed({
            provider: "github" as const,
            number: 1,
            title: "Implementation PR",
            url: "https://example.test/pr/1",
            baseRefName: "main",
            headRefName: "implementation/checkout",
            state: "open" as const,
            updatedAt: Option.none(),
          }),
      }),
    ),
    Layer.provide(
      Layer.mock(AppDevStackManager)({
        autoCreate: (input) =>
          Effect.succeed({
            created: true,
            frontendUrl: "http://127.0.0.1:5173",
            frontendServiceName: "frontend",
            stack: {
              id: "stack-1",
              uuid: "stack-uuid-1",
              userId: "user-1",
              worktreePath: input.worktreePath,
              composePath: "/tmp/compose.yml",
              displayName: input.displayName,
              description: null,
              status: "running" as const,
              services: null,
              serviceCount: 0,
              lastError: null,
              errorCount: 0,
              createdAt: now,
              updatedAt: now,
            },
          }),
      }),
    ),
  );

  return Layer.mergeAll(
    coreLayer,
    directoryLayer,
    ProjectionTurnRepositoryLive.pipe(
      Layer.provide(SqlitePersistenceMemory),
      Layer.provide(NodeServices.layer),
    ),
    reactorLayer,
    makeStaleTurnReconcilerLive(reconcilerOptions).pipe(
      Layer.provide(coreLayer),
      Layer.provide(directoryLayer),
      Layer.provide(providerServiceLayer),
    ),
  );
}

function withSystem<A, E>(
  use: (system: ReconcilerSystem) => Effect.Effect<A, E, Scope.Scope>,
  options?: { readonly reconciler?: StaleTurnReconcilerLiveOptions },
) {
  return Effect.gen(function* () {
    const liveSessions = yield* Ref.make<ReadonlyArray<ProviderSession>>([]);

    return yield* Effect.scoped(
      Effect.gen(function* () {
        const engine = yield* OrchestrationEngineService;
        const query = yield* ProjectionSnapshotQuery;
        const reactor = yield* ImplementationWorkflowReactor;
        const reconciler = yield* StaleTurnReconciler;
        const directory = yield* ProviderSessionDirectory;
        const turns = yield* ProjectionTurnRepository;
        yield* reactor.start();
        return yield* use({
          engine,
          query,
          reactor,
          reconciler,
          directory,
          turns,
          liveSessions,
        });
      }),
    ).pipe(Effect.provide(makeTestLayer(liveSessions, options?.reconciler)));
  });
}

function waitUntil<E>(predicate: Effect.Effect<boolean, E>, label: string) {
  return Effect.gen(function* () {
    const deadline = (yield* Clock.currentTimeMillis) + 5_000;
    while (true) {
      if (yield* predicate) return;
      if ((yield* Clock.currentTimeMillis) >= deadline) {
        return yield* Effect.die(new Error(`Timed out waiting for ${label}.`));
      }
      yield* Effect.sleep(Duration.millis(10));
    }
  });
}

function getThread(system: ReconcilerSystem, threadId: ThreadId) {
  return system.query
    .getSnapshot()
    .pipe(Effect.map((snapshot) => snapshot.threads.find((thread) => thread.id === threadId)));
}

function sessionStatus(system: ReconcilerSystem, threadId: ThreadId) {
  return getThread(system, threadId).pipe(Effect.map((thread) => thread?.session?.status));
}

function setThreadSession(
  system: ReconcilerSystem,
  input: {
    readonly threadId: ThreadId;
    readonly status: OrchestrationSessionStatus;
    readonly activeTurnId: TurnId | null;
    readonly updatedAt?: string;
    readonly tag: string;
  },
) {
  return system.engine.dispatch({
    type: "thread.session.set",
    commandId: commandId(`session-set-${input.tag}`),
    threadId: input.threadId,
    session: {
      threadId: input.threadId,
      status: input.status,
      providerName: "codex",
      runtimeMode: "full-access",
      activeTurnId: input.activeTurnId,
      lastError: null,
      updatedAt: input.updatedAt ?? now,
    },
    createdAt: input.updatedAt ?? now,
  });
}

function createPlainThread(system: ReconcilerSystem, threadId: ThreadId, tag: string) {
  return system.engine.dispatch({
    type: "thread.create",
    commandId: commandId(`thread-create-${tag}`),
    threadId,
    projectId,
    ownerUserId: DEFAULT_WORKSPACE_USER_ID,
    parentThreadId: null,
    workflowRole: null,
    title: `Thread ${tag}`,
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdAt: now,
  });
}

function seedProject(system: ReconcilerSystem) {
  return system.engine.dispatch({
    type: "project.create",
    commandId: commandId("project-create"),
    projectId,
    title: "Stale Turn Reconciler",
    workspaceRoot: "/tmp/stale-turn-reconciler",
    createdAt: now,
  });
}

function seedPlanning(system: ReconcilerSystem) {
  return Effect.gen(function* () {
    yield* seedProject(system);
    yield* system.engine.dispatch({
      type: "thread.create",
      commandId: commandId("thread-create-source"),
      threadId: sourceThreadId,
      projectId,
      ownerUserId: DEFAULT_WORKSPACE_USER_ID,
      parentThreadId: null,
      workflowRole: null,
      title: "Planning",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      runtimeMode: "full-access",
      interactionMode: "planning-workflow",
      branch: "main",
      worktreePath: "/tmp/stale-turn-reconciler",
      createdAt: now,
    });
    yield* system.engine.dispatch({
      type: "thread.planning-spec.apply",
      commandId: commandId("spec-apply"),
      threadId: sourceThreadId,
      sourceMessageId: messageId("spec-source"),
      title: "Checkout",
      summaryMarkdown: "Build checkout.",
      createdAt: now,
    });
    const snapshotAfterSpec = yield* system.query.getSnapshot();
    const spec = snapshotAfterSpec.threads.find((thread) => thread.id === sourceThreadId)
      ?.planningWorkflow?.spec;
    if (!spec) throw new Error("Spec missing.");
    yield* system.engine.dispatch({
      type: "thread.planning-tickets.apply",
      commandId: commandId("tickets-apply"),
      threadId: sourceThreadId,
      sourceMessageId: messageId("tickets-source"),
      specId: spec.id,
      tickets: [
        {
          key: "TICKET-1",
          title: "Checkout tracer",
          bodyMarkdown: "Implement checkout tracer.",
          dependencyKeys: [],
        },
      ],
      createdAt: now,
    });
    return { spec };
  });
}

function launchRun(system: ReconcilerSystem) {
  return Effect.gen(function* () {
    const { spec } = yield* seedPlanning(system);
    yield* system.engine.dispatch({
      type: "thread.implementation-run.launch",
      commandId: commandId("implementation-launch"),
      threadId: sourceThreadId,
      specId: spec.id,
      baseBranch: "main",
      pinnedCommit: "abc123",
      orchestratorBranch: "implementation/checkout",
      orchestratorWorktreePath: "/tmp/stale-turn-reconciler.worktrees/checkout",
      validationCommands: ["vp check"],
      createdAt: now,
    });
    yield* system.reactor.drain;
    const snapshot = yield* system.query.getSnapshot();
    const run = snapshot.implementationRuns[0];
    if (!run) throw new Error("Run missing.");
    return { run };
  });
}

function appendWorkerSuccess(system: ReconcilerSystem, run: OrchestrationImplementationRun) {
  return Effect.gen(function* () {
    const state = run.ticketStates[0];
    if (!state?.workerThreadId || !state.branch || !state.worktreePath) {
      throw new Error("Worker was not started.");
    }
    yield* system.engine.dispatch({
      type: "thread.activity.append",
      commandId: commandId("worker-succeeded"),
      threadId: state.workerThreadId,
      activity: {
        id: eventId("worker-succeeded"),
        tone: "info",
        kind: "implementation-worker-result",
        summary: "Worker succeeded",
        payload: {
          type: "implementation-worker-result",
          ticketId: state.ticketId,
          workerThreadId: state.workerThreadId,
          branch: state.branch,
          worktreePath: state.worktreePath,
          status: "succeeded",
          commitSha: "def456",
          validations: [],
          notesMarkdown: "succeeded",
          reportedAt: "2026-01-01T00:00:01.000Z",
        },
        turnId: null,
        createdAt: "2026-01-01T00:00:01.000Z",
      },
      createdAt: "2026-01-01T00:00:01.000Z",
    });
    yield* system.reactor.drain;
  });
}

function passMergeGate(system: ReconcilerSystem, run: OrchestrationImplementationRun) {
  return Effect.gen(function* () {
    const snapshot = yield* system.query.getSnapshot();
    const validator = snapshot.threads.find(
      (thread) => thread.workflowRole === "implementation-validator",
    );
    if (!validator) throw new Error("Validator missing.");
    yield* system.engine.dispatch({
      type: "thread.activity.append",
      commandId: commandId("merge-gate-pass"),
      threadId: validator.id,
      activity: {
        id: eventId("merge-gate-pass"),
        tone: "info",
        kind: "implementation-merge-gate-result",
        summary: "Merge gate passed",
        payload: {
          type: "implementation-merge-gate-result",
          runId: run.id,
          status: "passed",
          validations: [],
          summaryMarkdown: "ok",
        },
        turnId: null,
        createdAt: "2026-01-01T00:00:02.000Z",
      },
      createdAt: "2026-01-01T00:00:02.000Z",
    });
    yield* system.reactor.drain;
  });
}

function passDevReview(system: ReconcilerSystem, run: OrchestrationImplementationRun) {
  return Effect.gen(function* () {
    const snapshot = yield* system.query.getSnapshot();
    const reviewingRun = snapshot.implementationRuns.find((entry) => entry.id === run.id);
    const reviewId = reviewingRun?.devReviewIds[0];
    if (reviewId === undefined) throw new Error("Dev review missing.");
    yield* system.engine.dispatch({
      type: "thread.dev-review.update",
      commandId: commandId("dev-review-pass"),
      threadId: run.orchestratorThreadId,
      reviewId: DevReviewId.make(reviewId),
      status: "passed",
      updatedAt: "2026-01-01T00:00:03.000Z",
      createdAt: "2026-01-01T00:00:03.000Z",
    });
    yield* system.reactor.drain;
  });
}

function findThreadByRole(system: ReconcilerSystem, role: string) {
  return system.query
    .getSnapshot()
    .pipe(
      Effect.map((snapshot) => snapshot.threads.find((thread) => thread.workflowRole === role)),
    );
}

function getRun(system: ReconcilerSystem, runId: string) {
  return system.query
    .getSnapshot()
    .pipe(Effect.map((snapshot) => snapshot.implementationRuns.find((run) => run.id === runId)));
}

const bootOnlyOptions: StaleTurnReconcilerLiveOptions = {
  sweepIntervalMs: 3_600_000,
  graceMs: 0,
  confirmDelayMs: 0,
};

describe("StaleTurnReconciler", () => {
  it.live("settles orphaned running turns at boot without touching non-workflow threads", () =>
    withSystem(
      (system) =>
        Effect.gen(function* () {
          const threadId = ThreadId.make("thread-stale-plain");
          const turnId = TurnId.make("turn-stale-plain");
          yield* seedProject(system);
          yield* createPlainThread(system, threadId, "plain");
          yield* setThreadSession(system, {
            threadId,
            status: "running",
            activeTurnId: turnId,
            tag: "orphan-plain",
          });
          yield* system.directory.upsert({
            threadId,
            provider: ProviderDriverKind.make("codex"),
            providerInstanceId: ProviderInstanceId.make("codex"),
            status: "running",
            runtimeMode: "full-access",
            resumeCursor: { opaque: "resume-plain" },
          });

          yield* system.reconciler.start();
          yield* waitUntil(
            sessionStatus(system, threadId).pipe(Effect.map((status) => status === "error")),
            "orphaned session to settle",
          );

          const thread = yield* getThread(system, threadId);
          expect(thread?.session?.status).toBe("error");
          expect(thread?.session?.activeTurnId).toBeNull();
          expect(thread?.session?.lastError).toContain("stale-turn reconciler");
          expect(thread?.activities ?? []).toHaveLength(0);

          // The snapshot's latestTurn join is keyed on activeTurnId (nulled by
          // the settle), so the settled turn state is asserted on the
          // projection_turns row directly.
          const turnRows = yield* system.turns.listByThreadId({ threadId });
          const settledTurn = turnRows.find((turn) => turn.turnId === turnId);
          expect(settledTurn?.state).toBe("error");

          const binding = Option.getOrUndefined(yield* system.directory.getBinding(threadId));
          expect(binding?.status).toBe("stopped");
          expect(binding?.resumeCursor).toEqual({ opaque: "resume-plain" });
        }),
      { reconciler: bootOnlyOptions },
    ),
  );

  it.live("skips threads whose provider session is still live", () =>
    withSystem(
      (system) =>
        Effect.gen(function* () {
          const liveThreadId = ThreadId.make("thread-stale-live");
          const orphanThreadId = ThreadId.make("thread-stale-orphan");
          const liveTurnId = TurnId.make("turn-stale-live");
          yield* seedProject(system);
          yield* createPlainThread(system, liveThreadId, "live");
          yield* createPlainThread(system, orphanThreadId, "orphan");
          yield* setThreadSession(system, {
            threadId: liveThreadId,
            status: "running",
            activeTurnId: liveTurnId,
            tag: "live",
          });
          yield* setThreadSession(system, {
            threadId: orphanThreadId,
            status: "running",
            activeTurnId: TurnId.make("turn-stale-orphan"),
            tag: "orphan",
          });
          yield* Ref.set(system.liveSessions, [
            {
              provider: ProviderDriverKind.make("codex"),
              status: "running",
              runtimeMode: "full-access",
              threadId: liveThreadId,
              activeTurnId: liveTurnId,
              createdAt: now,
              updatedAt: now,
            },
          ]);

          yield* system.reconciler.start();
          // The orphan settling proves the boot sweep has completed a full pass.
          yield* waitUntil(
            sessionStatus(system, orphanThreadId).pipe(Effect.map((status) => status === "error")),
            "orphaned sentinel to settle",
          );

          expect(yield* sessionStatus(system, liveThreadId)).toBe("running");
        }),
      { reconciler: bootOnlyOptions },
    ),
  );

  it.live("leaves fresh sessions alone until the grace period elapses", () =>
    withSystem(
      (system) =>
        Effect.gen(function* () {
          const freshThreadId = ThreadId.make("thread-stale-fresh");
          const staleThreadId = ThreadId.make("thread-stale-old");
          yield* seedProject(system);
          yield* createPlainThread(system, freshThreadId, "fresh");
          yield* createPlainThread(system, staleThreadId, "old");

          // Start before orphaning so the grace-free boot pass sees nothing.
          yield* system.reconciler.start();

          const freshIso = DateTime.formatIso(yield* DateTime.now);
          yield* setThreadSession(system, {
            threadId: freshThreadId,
            status: "running",
            activeTurnId: TurnId.make("turn-stale-fresh"),
            updatedAt: freshIso,
            tag: "fresh",
          });
          yield* setThreadSession(system, {
            threadId: staleThreadId,
            status: "running",
            activeTurnId: TurnId.make("turn-stale-old"),
            updatedAt: "2020-01-01T00:00:00.000Z",
            tag: "old",
          });

          // The past-grace thread settling proves periodic sweeps are running.
          yield* waitUntil(
            sessionStatus(system, staleThreadId).pipe(Effect.map((status) => status === "error")),
            "past-grace session to settle",
          );

          expect(yield* sessionStatus(system, freshThreadId)).toBe("running");
        }),
      { reconciler: { sweepIntervalMs: 50, graceMs: 60_000, confirmDelayMs: 0 } },
    ),
  );

  it.live("does not settle a turn that completes during the confirm window", () =>
    withSystem(
      (system) =>
        Effect.gen(function* () {
          const threadId = ThreadId.make("thread-stale-confirm");
          const turnId = TurnId.make("turn-stale-confirm");
          yield* seedProject(system);
          yield* createPlainThread(system, threadId, "confirm");

          // Start before orphaning so the confirm-free boot pass sees nothing.
          yield* system.reconciler.start();

          yield* setThreadSession(system, {
            threadId,
            status: "running",
            activeTurnId: turnId,
            tag: "confirm-orphan",
          });

          // Give periodic sweeps time to observe the orphan and enter the
          // confirm delay, then complete the turn inside that window.
          yield* Effect.sleep(Duration.millis(250));
          yield* setThreadSession(system, {
            threadId,
            status: "ready",
            activeTurnId: null,
            tag: "confirm-complete",
          });
          yield* Effect.sleep(Duration.millis(1_500));

          const thread = yield* getThread(system, threadId);
          expect(thread?.session?.status).toBe("ready");
          expect(thread?.session?.lastError).toBeNull();
          const turnRows = yield* system.turns.listByThreadId({ threadId });
          const settledTurn = turnRows.find((turn) => turn.turnId === turnId);
          expect(settledTurn?.state).toBe("completed");
        }),
      { reconciler: { sweepIntervalMs: 100, graceMs: 0, confirmDelayMs: 1_000 } },
    ),
  );

  it.live("fails the ticket and flips the run when a worker turn is orphaned", () =>
    withSystem(
      (system) =>
        Effect.gen(function* () {
          const { run } = yield* launchRun(system);
          const workerThreadId = run.ticketStates[0]?.workerThreadId;
          if (!workerThreadId) throw new Error("Worker was not started.");
          yield* setThreadSession(system, {
            threadId: workerThreadId,
            status: "running",
            activeTurnId: TurnId.make("turn-stale-worker"),
            tag: "worker-orphan",
          });

          yield* system.reconciler.start();
          yield* waitUntil(
            getRun(system, run.id).pipe(
              Effect.map((entry) => entry?.status === "needs-human-attention"),
            ),
            "run to need human attention",
          );
          yield* system.reactor.drain;

          const settledRun = yield* getRun(system, run.id);
          expect(settledRun?.status).toBe("needs-human-attention");
          expect(settledRun?.ticketStates[0]?.status).toBe("failed");
          expect(settledRun?.workerResults).toHaveLength(1);
          expect(settledRun?.workerResults[0]?.status).toBe("failed");
          expect(settledRun?.workerResults[0]?.branch).toBe(run.ticketStates[0]?.branch);
          expect(yield* sessionStatus(system, workerThreadId)).toBe("error");
        }),
      { reconciler: bootOnlyOptions },
    ),
  );

  it.live("does not duplicate worker failure results across repeated sweeps", () =>
    withSystem(
      (system) =>
        Effect.gen(function* () {
          const { run } = yield* launchRun(system);
          const workerThreadId = run.ticketStates[0]?.workerThreadId;
          if (!workerThreadId) throw new Error("Worker was not started.");
          const turnId = TurnId.make("turn-stale-worker-repeat");
          yield* setThreadSession(system, {
            threadId: workerThreadId,
            status: "running",
            activeTurnId: turnId,
            tag: "worker-orphan",
          });

          yield* system.reconciler.start();
          yield* waitUntil(
            sessionStatus(system, workerThreadId).pipe(Effect.map((status) => status === "error")),
            "worker session to settle",
          );

          // Re-orphan the same turn (as if the settle had been lost) and use a
          // later plain orphan as the sentinel that another sweep re-processed
          // the worker thread.
          yield* setThreadSession(system, {
            threadId: workerThreadId,
            status: "running",
            activeTurnId: turnId,
            tag: "worker-reorphan",
          });
          const sentinelThreadId = ThreadId.make("thread-stale-sentinel");
          yield* createPlainThread(system, sentinelThreadId, "sentinel");
          yield* setThreadSession(system, {
            threadId: sentinelThreadId,
            status: "running",
            activeTurnId: TurnId.make("turn-stale-sentinel"),
            tag: "sentinel",
          });
          yield* waitUntil(
            sessionStatus(system, sentinelThreadId).pipe(
              Effect.map((status) => status === "error"),
            ),
            "sentinel session to settle",
          );
          yield* system.reactor.drain;

          const settledRun = yield* getRun(system, run.id);
          expect(settledRun?.workerResults).toHaveLength(1);
          const workerThread = yield* getThread(system, workerThreadId);
          const workerResultActivities = (workerThread?.activities ?? []).filter(
            (activity) => activity.kind === "implementation-worker-result",
          );
          expect(workerResultActivities).toHaveLength(1);
        }),
      { reconciler: { sweepIntervalMs: 100, graceMs: 0, confirmDelayMs: 0 } },
    ),
  );

  it.live("settles without propagation when the ticket already succeeded", () =>
    withSystem(
      (system) =>
        Effect.gen(function* () {
          const { run } = yield* launchRun(system);
          const workerThreadId = run.ticketStates[0]?.workerThreadId;
          if (!workerThreadId) throw new Error("Worker was not started.");
          yield* appendWorkerSuccess(system, run);

          yield* setThreadSession(system, {
            threadId: workerThreadId,
            status: "running",
            activeTurnId: TurnId.make("turn-stale-succeeded"),
            tag: "succeeded-orphan",
          });

          yield* system.reconciler.start();
          yield* waitUntil(
            sessionStatus(system, workerThreadId).pipe(Effect.map((status) => status === "error")),
            "worker session to settle",
          );
          yield* system.reactor.drain;

          const settledRun = yield* getRun(system, run.id);
          expect(settledRun?.status).toBe("validating");
          expect(settledRun?.ticketStates[0]?.status).toBe("succeeded");
          expect(settledRun?.workerResults).toHaveLength(1);
          expect(settledRun?.workerResults[0]?.status).toBe("succeeded");
        }),
      { reconciler: bootOnlyOptions },
    ),
  );

  it.live("propagates a merge-gate failure when a validator turn is orphaned", () =>
    withSystem(
      (system) =>
        Effect.gen(function* () {
          const { run } = yield* launchRun(system);
          yield* appendWorkerSuccess(system, run);
          const validator = yield* findThreadByRole(system, "implementation-validator");
          if (!validator) throw new Error("Validator missing.");
          yield* setThreadSession(system, {
            threadId: validator.id,
            status: "running",
            activeTurnId: TurnId.make("turn-stale-validator"),
            tag: "validator-orphan",
          });

          yield* system.reconciler.start();
          yield* waitUntil(
            getRun(system, run.id).pipe(
              Effect.map((entry) => entry?.status === "needs-human-attention"),
            ),
            "run to need human attention",
          );

          const settledRun = yield* getRun(system, run.id);
          expect(settledRun?.status).toBe("needs-human-attention");
          expect(settledRun?.finalValidation?.status).toBe("failed");
          expect(yield* sessionStatus(system, validator.id)).toBe("error");
        }),
      { reconciler: bootOnlyOptions },
    ),
  );

  it.live("blocks the run when a code reviewer turn is orphaned", () =>
    withSystem(
      (system) =>
        Effect.gen(function* () {
          const { run } = yield* launchRun(system);
          yield* appendWorkerSuccess(system, run);
          yield* passMergeGate(system, run);
          yield* passDevReview(system, run);
          const reviewer = yield* findThreadByRole(system, "implementation-code-reviewer");
          if (!reviewer) throw new Error("Code reviewer missing.");
          const runBefore = yield* getRun(system, run.id);
          expect(runBefore?.status).toBe("code-reviewing");
          yield* setThreadSession(system, {
            threadId: reviewer.id,
            status: "running",
            activeTurnId: TurnId.make("turn-stale-code-reviewer"),
            tag: "code-reviewer-orphan",
          });

          yield* system.reconciler.start();
          yield* waitUntil(
            getRun(system, run.id).pipe(
              Effect.map((entry) => entry?.status === "needs-human-attention"),
            ),
            "run to need human attention",
          );

          expect(yield* sessionStatus(system, reviewer.id)).toBe("error");
        }),
      { reconciler: bootOnlyOptions },
    ),
  );

  it.live("blocks the run when a fixer turn is orphaned", () =>
    withSystem(
      (system) =>
        Effect.gen(function* () {
          const { run } = yield* launchRun(system);
          yield* appendWorkerSuccess(system, run);
          yield* passMergeGate(system, run);
          yield* passDevReview(system, run);
          const reviewer = yield* findThreadByRole(system, "implementation-code-reviewer");
          if (!reviewer) throw new Error("Code reviewer missing.");
          yield* system.engine.dispatch({
            type: "thread.activity.append",
            commandId: commandId("code-review-findings"),
            threadId: reviewer.id,
            activity: {
              id: eventId("code-review-findings"),
              tone: "info",
              kind: "implementation-code-review-result",
              summary: "Implementation code review findings",
              payload: {
                type: "implementation-code-review-result",
                runId: run.id,
                status: "findings",
                reportMarkdown: "## Findings\n- fix this",
              },
              turnId: null,
              createdAt: "2026-01-01T00:00:04.000Z",
            },
            createdAt: "2026-01-01T00:00:04.000Z",
          });
          yield* system.reactor.drain;
          const fixer = yield* findThreadByRole(system, "implementation-fixer");
          if (!fixer) throw new Error("Fixer missing.");
          const runBefore = yield* getRun(system, run.id);
          expect(runBefore?.status).toBe("code-review-fixing");
          yield* setThreadSession(system, {
            threadId: fixer.id,
            status: "running",
            activeTurnId: TurnId.make("turn-stale-fixer"),
            tag: "fixer-orphan",
          });

          yield* system.reconciler.start();
          yield* waitUntil(
            getRun(system, run.id).pipe(
              Effect.map((entry) => entry?.status === "needs-human-attention"),
            ),
            "run to need human attention",
          );

          expect(yield* sessionStatus(system, fixer.id)).toBe("error");
        }),
      { reconciler: bootOnlyOptions },
    ),
  );
});
