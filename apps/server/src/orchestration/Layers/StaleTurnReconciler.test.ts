import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  DEFAULT_WORKSPACE_USER_ID,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  WORKFLOW_RECOVERY_FALLBACK_MODEL_PIN,
  ThreadId,
  TurnId,
  type OrchestrationImplementationRun,
  type OrchestrationPlanningWorkflowStage,
  type OrchestrationSessionStatus,
  type OrchestrationThreadWorkflowRole,
  type ProviderInteractionMode,
  type ProviderSession,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
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
import { T3ProjectFileLoader } from "../../project/T3ProjectFileLoader.ts";
import { WORKFLOW_PROMPT_IDS } from "../../provider/WorkflowPromptRegistry.ts";
import { ProviderSessionDirectory } from "../../provider/Services/ProviderSessionDirectory.ts";
import { ProviderSessionDirectoryLive } from "../../provider/Layers/ProviderSessionDirectory.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ImplementationWorkflowReactorLive } from "./ImplementationWorkflowReactor.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import {
  ORPHANED_PROVIDER_SESSION_ERROR,
  WORKFLOW_NUDGE_ACTIVITY_KIND,
  WORKFLOW_NUDGE_EXHAUSTED_MESSAGE,
} from "../workflowNudge.ts";
import {
  makeStaleTurnReconcilerLive,
  STALE_TURN_RESUME_ACTIVITY_KIND,
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

const RESUME_MESSAGE_MARKER = "interrupted by a server restart";

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
  settingsOverrides?: Parameters<typeof serverSettingsLayerTest>[0],
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
    Layer.provideMerge(ThreadBackgroundLiveness.layer),
    Layer.provideMerge(ThreadPlanProgress.layer),
  );

  const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
    Layer.provide(SqlitePersistenceMemory),
    Layer.provide(NodeServices.layer),
  );
  const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));

  const providerServiceLayer = Layer.mock(ProviderService)({
    listSessions: () => Ref.get(liveSessions),
    getInstanceInfo: (instanceId) => {
      const driverKind = ProviderDriverKind.make(
        String(instanceId).startsWith("claude") ? "claudeAgent" : String(instanceId),
      );
      return Effect.succeed({
        instanceId,
        driverKind,
        displayName: undefined,
        enabled: true,
        continuationIdentity: {
          driverKind,
          continuationKey: `${driverKind}:instance:${instanceId}`,
        },
      });
    },
  });

  const reactorLayer = ImplementationWorkflowReactorLive.pipe(
    Layer.provide(coreLayer),
    Layer.provide(serverSettingsLayerTest(settingsOverrides)),
    Layer.provide(
      Layer.succeed(T3ProjectFileLoader, {
        load: () => Effect.succeed(Option.none()),
      }),
    ),
    // The reactor probes the App Review frontend URL; answer it without real network I/O.
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.succeed(HttpClientResponse.fromWeb(request, new Response("ok", { status: 200 }))),
        ),
      ),
    ),
    Layer.provide(
      Layer.mock(GitWorkflowService)({
        createWorktree: (input) =>
          Effect.succeed({
            worktree: {
              path: input.path ?? "/tmp/generated-worktree",
              refName: input.newRefName ?? "HEAD",
            },
          }),
        resolveCommit: () => Effect.succeed({ commitSha: "def456" }),
        localStatus: (input) =>
          Effect.succeed({
            isRepo: true,
            hasPrimaryRemote: true,
            isDefaultRef: false,
            refName: input.cwd.endsWith("checkout-ticket-1")
              ? "implementation/checkout-ticket-1"
              : "implementation/checkout",
            hasWorkingTreeChanges: false,
            workingTree: { files: [], insertions: 0, deletions: 0 },
          }),
        listChangedFiles: () => Effect.succeed([]),
        isAncestor: () => Effect.succeed(true),
        mergeRef: () => Effect.succeed({ status: "merged" as const }),
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
        getByWorktree: (input) =>
          Effect.succeed({
            stack: {
              id: "stack-1",
              uuid: "stack-uuid-1",
              userId: "user-1",
              worktreePath: input.worktreePath,
              composePath: "/tmp/compose.yml",
              displayName: "Stale turn reconciler test",
              description: null,
              status: "running" as const,
              services: null,
              serviceCount: 0,
              lastError: null,
              errorCount: 0,
              createdAt: now,
              updatedAt: now,
            },
            frontendUrl: "http://127.0.0.1:5173",
            frontendServiceName: "frontend",
          }),
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
        stop: () =>
          Effect.succeed({
            id: "stack-1",
            uuid: "stack-uuid-1",
            userId: "user-1",
            worktreePath: "/tmp/stale-turn-reconciler",
            composePath: "/tmp/compose.yml",
            displayName: "Stale turn reconciler test",
            description: null,
            status: "stopped" as const,
            services: null,
            serviceCount: 0,
            lastError: null,
            errorCount: 0,
            createdAt: now,
            updatedAt: now,
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
      Layer.provide(serverSettingsLayerTest(settingsOverrides)),
    ),
  );
}

function withSystem<A, E>(
  use: (system: ReconcilerSystem) => Effect.Effect<A, E, Scope.Scope>,
  options?: {
    readonly reconciler?: StaleTurnReconcilerLiveOptions;
    readonly settings?: Parameters<typeof serverSettingsLayerTest>[0];
  },
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
    ).pipe(Effect.provide(makeTestLayer(liveSessions, options?.reconciler, options?.settings)));
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

function resumeActivities(system: ReconcilerSystem, threadId: ThreadId) {
  return getThread(system, threadId).pipe(
    Effect.map((thread) =>
      (thread?.activities ?? []).filter(
        (activity) => activity.kind === STALE_TURN_RESUME_ACTIVITY_KIND,
      ),
    ),
  );
}

function resumeMessages(system: ReconcilerSystem, threadId: ThreadId) {
  return getThread(system, threadId).pipe(
    Effect.map((thread) =>
      (thread?.messages ?? []).filter((message) => message.text.includes(RESUME_MESSAGE_MARKER)),
    ),
  );
}

const NUDGE_MESSAGE_MARKER = "stopped on a provider failure";

function nudgeActivities(system: ReconcilerSystem, threadId: ThreadId) {
  return getThread(system, threadId).pipe(
    Effect.map((thread) =>
      (thread?.activities ?? []).filter(
        (activity) => activity.kind === WORKFLOW_NUDGE_ACTIVITY_KIND,
      ),
    ),
  );
}

function nudgeMessages(system: ReconcilerSystem, threadId: ThreadId) {
  return getThread(system, threadId).pipe(
    Effect.map((thread) =>
      (thread?.messages ?? []).filter((message) => message.text.includes(NUDGE_MESSAGE_MARKER)),
    ),
  );
}

/**
 * Put a thread where a provider failure leaves it: the turn ran, failed, and
 * the session went down with it.
 */
function blockThreadOnFailedTurn(
  system: ReconcilerSystem,
  input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
    readonly tag: string;
    readonly blockedAt?: string;
  },
) {
  return Effect.gen(function* () {
    const blockedAt = input.blockedAt ?? now;
    yield* setThreadSession(system, {
      threadId: input.threadId,
      status: "running",
      activeTurnId: input.turnId,
      updatedAt: blockedAt,
      tag: `${input.tag}-running`,
    });
    yield* setThreadSession(system, {
      threadId: input.threadId,
      status: "error",
      activeTurnId: null,
      updatedAt: blockedAt,
      tag: `${input.tag}-failed`,
    });
    // Claude tears the session down after an API failure; the failed turn is
    // what stays behind.
    yield* setThreadSession(system, {
      threadId: input.threadId,
      status: "stopped",
      activeTurnId: null,
      updatedAt: blockedAt,
      tag: `${input.tag}-stopped`,
    });
  });
}

function appendProviderTurnFailure(
  system: ReconcilerSystem,
  input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
    readonly tag: string;
    readonly createdAt: string;
    readonly disposition?: "retryable" | "terminal" | "unknown";
    readonly reason?: "overloaded" | "authentication" | "unknown";
  },
) {
  return system.engine.dispatch({
    type: "thread.activity.append",
    commandId: commandId(`provider-failure-${input.tag}`),
    threadId: input.threadId,
    activity: {
      id: eventId(`provider-failure-${input.tag}`),
      tone: "error",
      kind: "provider.turn.failed",
      summary: `Provider turn failed: ${input.reason ?? "unknown"}`,
      payload: {
        turnId: input.turnId,
        recovery: {
          disposition: input.disposition ?? "retryable",
          reason: input.reason ?? "overloaded",
          statusCode: input.reason === "authentication" ? 401 : 503,
        },
      },
      turnId: input.turnId,
      createdAt: input.createdAt,
    },
    createdAt: input.createdAt,
  });
}

function setThreadSession(
  system: ReconcilerSystem,
  input: {
    readonly threadId: ThreadId;
    readonly status: OrchestrationSessionStatus;
    readonly activeTurnId: TurnId | null;
    readonly lastError?: string | null;
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
      lastError: input.lastError ?? null,
      updatedAt: input.updatedAt ?? now,
    },
    createdAt: input.updatedAt ?? now,
  });
}

function createThread(
  system: ReconcilerSystem,
  threadId: ThreadId,
  tag: string,
  options?: {
    readonly workflowRole?: OrchestrationThreadWorkflowRole | null;
    readonly interactionMode?: ProviderInteractionMode;
    readonly parentThreadId?: ThreadId | null;
  },
) {
  return system.engine.dispatch({
    type: "thread.create",
    commandId: commandId(`thread-create-${tag}`),
    threadId,
    projectId,
    ownerUserId: DEFAULT_WORKSPACE_USER_ID,
    parentThreadId: options?.parentThreadId ?? null,
    workflowRole: options?.workflowRole ?? null,
    title: `Thread ${tag}`,
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    },
    runtimeMode: "full-access",
    interactionMode: options?.interactionMode ?? "default",
    branch: null,
    worktreePath: null,
    createdAt: now,
  });
}

function createPlainThread(system: ReconcilerSystem, threadId: ThreadId, tag: string) {
  return createThread(system, threadId, tag);
}

function createPlanningOrchestratorThread(
  system: ReconcilerSystem,
  threadId: ThreadId,
  tag: string,
  stage: OrchestrationPlanningWorkflowStage,
) {
  return Effect.gen(function* () {
    yield* createThread(system, threadId, tag, {
      workflowRole: "planning-orchestrator",
      interactionMode: "planning-workflow",
    });
    yield* system.engine.dispatch({
      type: "thread.planning-workflow.stage.set",
      commandId: commandId(`stage-set-${tag}`),
      threadId,
      stage,
      createdAt: now,
    });
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
          plannedFileChanges: [{ path: "src/checkout.ts", action: "update" }],
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
    // These tests are about resuming and settling stage threads, so they pin the
    // App Review strategy the way the Implementation reactor's own suite does.
    // A nested review would put its stages in a workflow this layer does not
    // run, leaving the stages under test unreachable.
    const legacyRun = { ...run, appReviewStrategy: "legacy-inline" as const };
    yield* system.engine.dispatch({
      type: "thread.implementation-run.update",
      commandId: commandId("implementation-mark-legacy-inline"),
      threadId: sourceThreadId,
      run: legacyRun,
      createdAt: now,
    });
    yield* system.reactor.drain;
    return { run: legacyRun };
  });
}

function requireWorkerThreadId(run: OrchestrationImplementationRun) {
  const workerThreadId = run.ticketStates[0]?.workerThreadId;
  if (!workerThreadId) throw new Error("Worker was not started.");
  return workerThreadId;
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
          validations: ["vp check", "vp run typecheck"].map((command) => ({
            command,
            status: "passed" as const,
            outputMarkdown: "ok",
            completedAt: "2026-01-01T00:00:02.000Z",
          })),
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
  it.live("finishes the boot reconciliation before start returns", () =>
    withSystem(
      (system) =>
        Effect.gen(function* () {
          const threadId = ThreadId.make("thread-stale-awaited-boot");
          yield* seedProject(system);
          yield* createPlainThread(system, threadId, "awaited boot");
          yield* setThreadSession(system, {
            threadId,
            status: "running",
            activeTurnId: TurnId.make("turn-stale-awaited-boot"),
            tag: "awaited-boot",
          });

          yield* system.reconciler.start();

          const thread = yield* getThread(system, threadId);
          expect(thread?.session?.status).toBe("error");
          expect(thread?.session?.activeTurnId).toBeNull();
        }),
      { reconciler: bootOnlyOptions },
    ),
  );

  it.live("resumes an owned workflow after startup cleared its active turn", () =>
    withSystem(
      (system) =>
        Effect.gen(function* () {
          const threadId = ThreadId.make("thread-stale-startup-cleared");
          const turnId = TurnId.make("turn-stale-startup-cleared");
          yield* seedProject(system);
          yield* createPlanningOrchestratorThread(
            system,
            threadId,
            "startup-cleared",
            "spec-authoring",
          );
          const failedAt = DateTime.formatIso(
            DateTime.subtract(yield* DateTime.now, { minutes: 5 }),
          );
          yield* setThreadSession(system, {
            threadId,
            status: "running",
            activeTurnId: turnId,
            updatedAt: failedAt,
            tag: "startup-cleared-running",
          });
          yield* setThreadSession(system, {
            threadId,
            status: "error",
            activeTurnId: null,
            lastError: ORPHANED_PROVIDER_SESSION_ERROR,
            updatedAt: failedAt,
            tag: "startup-cleared-error",
          });

          yield* system.reconciler.start();

          expect(yield* nudgeActivities(system, threadId)).toHaveLength(1);
          expect(yield* nudgeMessages(system, threadId)).toHaveLength(1);
        }),
      { reconciler: bootOnlyOptions },
    ),
  );

  it.live("starts an owned workflow whose first turn was never recorded", () =>
    withSystem(
      (system) =>
        Effect.gen(function* () {
          const threadId = ThreadId.make("thread-stale-missing-turn");
          yield* seedProject(system);
          yield* createPlanningOrchestratorThread(
            system,
            threadId,
            "missing-turn",
            "spec-authoring",
          );

          yield* system.reconciler.start();

          expect(yield* resumeActivities(system, threadId)).toHaveLength(1);
          expect(yield* resumeMessages(system, threadId)).toHaveLength(1);
        }),
      { reconciler: bootOnlyOptions },
    ),
  );

  it.live("does not settle a provider launch created during startup recovery", () =>
    withSystem(
      (system) =>
        Effect.gen(function* () {
          const threadId = ThreadId.make("thread-starting-provider-launch");
          yield* seedProject(system);
          yield* createPlanningOrchestratorThread(
            system,
            threadId,
            "starting-provider-launch",
            "spec-authoring",
          );
          const updatedAt = DateTime.formatIso(yield* DateTime.now);
          yield* setThreadSession(system, {
            threadId,
            status: "starting",
            activeTurnId: null,
            updatedAt,
            tag: "starting-provider-launch",
          });

          yield* system.reconciler.start();
          yield* Effect.sleep(Duration.millis(100));

          expect(yield* sessionStatus(system, threadId)).toBe("starting");
          expect(yield* resumeActivities(system, threadId)).toHaveLength(0);
        }),
      { reconciler: { ...bootOnlyOptions, graceMs: 60_000 } },
    ),
  );

  it.live("gives a starting provider launch a longer periodic grace", () =>
    withSystem(
      (system) =>
        Effect.gen(function* () {
          const launchThreadId = ThreadId.make("thread-starting-provider-periodic");
          const sentinelThreadId = ThreadId.make("thread-starting-provider-sentinel");
          yield* seedProject(system);
          yield* createPlainThread(system, launchThreadId, "starting provider periodic");
          yield* createPlainThread(system, sentinelThreadId, "starting provider sentinel");

          yield* system.reconciler.start();

          const updatedAt = DateTime.formatIso(yield* DateTime.now);
          yield* setThreadSession(system, {
            threadId: launchThreadId,
            status: "starting",
            activeTurnId: null,
            updatedAt,
            tag: "starting-provider-periodic",
          });
          yield* setThreadSession(system, {
            threadId: sentinelThreadId,
            status: "running",
            activeTurnId: TurnId.make("turn-starting-provider-sentinel"),
            updatedAt: "2020-01-01T00:00:00.000Z",
            tag: "starting-provider-sentinel",
          });

          yield* waitUntil(
            sessionStatus(system, sentinelThreadId).pipe(
              Effect.map((status) => status === "error"),
            ),
            "periodic sweep sentinel to settle",
          );

          expect(yield* sessionStatus(system, launchThreadId)).toBe("starting");
        }),
      {
        reconciler: {
          sweepIntervalMs: 50,
          graceMs: 0,
          startingProviderLaunchGraceMs: 60_000,
          confirmDelayMs: 0,
        },
      },
    ),
  );

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
          expect(thread?.messages ?? []).toHaveLength(0);

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

  it.live("continues an interrupted worker in place and halts after the second interruption", () =>
    withSystem(
      (system) =>
        Effect.gen(function* () {
          const { run } = yield* launchRun(system);
          const workerThreadId = requireWorkerThreadId(run);
          const turnId = TurnId.make("turn-stale-worker-resume");
          yield* system.directory.upsert({
            threadId: workerThreadId,
            provider: ProviderDriverKind.make("codex"),
            providerInstanceId: ProviderInstanceId.make("codex"),
            status: "running",
            runtimeMode: "full-access",
            resumeCursor: { opaque: "resume-worker" },
          });
          yield* setThreadSession(system, {
            threadId: workerThreadId,
            status: "running",
            activeTurnId: turnId,
            tag: "worker-orphan",
          });

          yield* system.reconciler.start();
          yield* waitUntil(
            getThread(system, workerThreadId).pipe(
              Effect.map(
                (thread) =>
                  (thread?.activities ?? []).filter(
                    (activity) => activity.kind === "implementation-worker-result",
                  ).length === 1,
              ),
            ),
            "worker failure handoff",
          );
          yield* system.reactor.drain;
          yield* waitUntil(
            getRun(system, run.id).pipe(
              Effect.map((entry) => entry?.ticketStates[0]?.attemptCount === 2),
            ),
            "worker retry state",
          );

          const workerThread = yield* getThread(system, workerThreadId);
          expect(workerThread?.session?.status).toBe("error");
          expect(workerThread?.session?.activeTurnId).toBeNull();

          const resumes = yield* resumeActivities(system, workerThreadId);
          expect(resumes).toHaveLength(0);

          const messages = yield* resumeMessages(system, workerThreadId);
          expect(messages).toHaveLength(0);

          const binding = Option.getOrUndefined(yield* system.directory.getBinding(workerThreadId));
          expect(binding?.status).toBe("stopped");
          expect(binding?.resumeCursor).toEqual({ opaque: "resume-worker" });

          const settledRun = yield* getRun(system, run.id);
          expect(settledRun?.status).toBe("running");
          expect(settledRun?.ticketStates[0]?.status).toBe("running");
          expect(settledRun?.ticketStates[0]?.attemptCount).toBe(2);
          expect(settledRun?.ticketStates[0]?.workerThreadId).toBe(workerThreadId);
          expect(settledRun?.retryableFailure?.attemptCount).toBe(1);
          expect(settledRun?.workerResults).toHaveLength(0);
          const workerResultActivities = (workerThread?.activities ?? []).filter(
            (activity) => activity.kind === "implementation-worker-result",
          );
          expect(workerResultActivities).toHaveLength(1);

          yield* setThreadSession(system, {
            threadId: workerThreadId,
            status: "running",
            activeTurnId: TurnId.make("turn-stale-worker-retry"),
            tag: "worker-retry-orphan",
          });
          yield* waitUntil(
            getRun(system, run.id).pipe(
              Effect.map((entry) => entry?.automationHalt?.category === "retry-exhausted"),
            ),
            "worker retry budget to halt",
          );
          yield* system.reactor.drain;

          const haltedRun = yield* getRun(system, run.id);
          expect(haltedRun?.status).toBe("needs-human-attention");
          expect(haltedRun?.retryableFailure?.attemptCount).toBe(2);
          expect(haltedRun?.automationHalt).toMatchObject({
            ticketId: run.ticketStates[0]?.ticketId,
            stage: "implementation",
            category: "retry-exhausted",
          });
          expect(haltedRun?.workerResults).toHaveLength(0);
        }),
      { reconciler: { sweepIntervalMs: 100, graceMs: 0, confirmDelayMs: 0 } },
    ),
  );

  it.live("ends a paused thread's lost session instead of resuming it", () =>
    withSystem(
      (system) =>
        Effect.gen(function* () {
          // A pause stops the agents, but the last session write can be lost
          // with the process. Resuming here would dispatch a turn the decider
          // refuses under a pause, and the session would read "running" in
          // every client until the user gave up and resumed the run.
          const { run } = yield* launchRun(system);
          const workerThreadId = requireWorkerThreadId(run);
          const turnId = TurnId.make("turn-stale-worker-paused");
          yield* system.directory.upsert({
            threadId: workerThreadId,
            provider: ProviderDriverKind.make("codex"),
            providerInstanceId: ProviderInstanceId.make("codex"),
            status: "running",
            runtimeMode: "full-access",
            resumeCursor: { opaque: "resume-paused-worker" },
          });
          yield* setThreadSession(system, {
            threadId: workerThreadId,
            status: "running",
            activeTurnId: turnId,
            tag: "worker-paused-orphan",
          });
          yield* system.engine.dispatch({
            type: "thread.workflow.pause",
            commandId: CommandId.make("cmd-pause-stale-worker"),
            threadId: workerThreadId,
            createdAt: DateTime.formatIso(yield* DateTime.now),
          });
          yield* setThreadSession(system, {
            threadId: workerThreadId,
            status: "error",
            activeTurnId: null,
            lastError: ORPHANED_PROVIDER_SESSION_ERROR,
            tag: "worker-paused-startup-cleared",
          });

          yield* system.reconciler.start();
          yield* waitUntil(
            getThread(system, workerThreadId).pipe(
              Effect.map((thread) => thread?.session?.status === "stopped"),
            ),
            "paused worker session ended",
          );
          yield* system.reactor.drain;

          const workerThread = yield* getThread(system, workerThreadId);
          expect(workerThread?.session?.status).toBe("stopped");
          expect(workerThread?.session?.activeTurnId).toBeNull();
          // Stopped by a pause, not by a fault: no error text to explain away.
          expect(workerThread?.session?.lastError ?? null).toBeNull();

          // No resume was attempted, so nothing was queued for the run to pick
          // up when the user resumes it.
          const resumes = yield* resumeActivities(system, workerThreadId);
          expect(resumes).toHaveLength(0);

          const binding = Option.getOrUndefined(yield* system.directory.getBinding(workerThreadId));
          expect(binding?.status).toBe("stopped");
        }),
      { reconciler: bootOnlyOptions },
    ),
  );

  it.live("resumes a planning orchestrator mid-stage and settles it outside resumable stages", () =>
    withSystem(
      (system) =>
        Effect.gen(function* () {
          const specThreadId = ThreadId.make("thread-stale-planning-spec");
          const stuckThreadId = ThreadId.make("thread-stale-planning-stuck");
          yield* seedProject(system);
          yield* createPlanningOrchestratorThread(
            system,
            specThreadId,
            "planning-spec",
            "spec-authoring",
          );
          yield* createPlanningOrchestratorThread(
            system,
            stuckThreadId,
            "planning-stuck",
            "needs-human-attention",
          );
          yield* setThreadSession(system, {
            threadId: specThreadId,
            status: "running",
            activeTurnId: TurnId.make("turn-stale-planning-spec"),
            tag: "planning-spec-orphan",
          });
          yield* setThreadSession(system, {
            threadId: stuckThreadId,
            status: "running",
            activeTurnId: TurnId.make("turn-stale-planning-stuck"),
            tag: "planning-stuck-orphan",
          });

          yield* system.reconciler.start();
          yield* waitUntil(
            Effect.zipWith(
              sessionStatus(system, specThreadId),
              sessionStatus(system, stuckThreadId),
              (spec, stuck) => spec === "error" && stuck === "error",
            ),
            "planning sessions to settle",
          );

          const resumes = yield* resumeActivities(system, specThreadId);
          expect(resumes).toHaveLength(1);
          const payload = resumes[0]?.payload as Record<string, unknown>;
          expect(payload["workflowPromptId"]).toBe(WORKFLOW_PROMPT_IDS.planningSpecCodex);
          expect(yield* resumeMessages(system, specThreadId)).toHaveLength(1);

          expect(yield* resumeActivities(system, stuckThreadId)).toHaveLength(0);
          const stuckThread = yield* getThread(system, stuckThreadId);
          expect(stuckThread?.messages ?? []).toHaveLength(0);
        }),
      { reconciler: bootOnlyOptions },
    ),
  );

  it.live("settles without resume artifacts when the ticket already succeeded", () =>
    withSystem(
      (system) =>
        Effect.gen(function* () {
          const { run } = yield* launchRun(system);
          const workerThreadId = requireWorkerThreadId(run);
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
          expect(yield* resumeActivities(system, workerThreadId)).toHaveLength(0);
          expect(yield* resumeMessages(system, workerThreadId)).toHaveLength(0);
        }),
      { reconciler: bootOnlyOptions },
    ),
  );

  it.live("leaves errored workflow sessions alone when the turn did not fail", () =>
    withSystem(
      (system) =>
        Effect.gen(function* () {
          const { run } = yield* launchRun(system);
          const workerThreadId = requireWorkerThreadId(run);
          yield* setThreadSession(system, {
            threadId: workerThreadId,
            status: "error",
            activeTurnId: null,
            tag: "plain-error",
          });
          const sentinelThreadId = ThreadId.make("thread-stale-containment-sentinel");
          yield* createPlainThread(system, sentinelThreadId, "containment-sentinel");
          yield* setThreadSession(system, {
            threadId: sentinelThreadId,
            status: "running",
            activeTurnId: TurnId.make("turn-stale-containment-sentinel"),
            tag: "containment-sentinel",
          });

          yield* system.reconciler.start();
          yield* waitUntil(
            sessionStatus(system, sentinelThreadId).pipe(
              Effect.map((status) => status === "error"),
            ),
            "sentinel session to settle",
          );
          yield* system.reactor.drain;

          const workerThread = yield* getThread(system, workerThreadId);
          expect(workerThread?.session?.lastError).toBeNull();
          expect(yield* resumeActivities(system, workerThreadId)).toHaveLength(0);
          expect(yield* resumeMessages(system, workerThreadId)).toHaveLength(0);
          const settledRun = yield* getRun(system, run.id);
          expect(settledRun?.status).toBe("running");
          expect(settledRun?.ticketStates[0]?.status).toBe("running");
        }),
      { reconciler: bootOnlyOptions },
    ),
  );

  it.live("never nudges a thread that is still running", () =>
    withSystem(
      (system) =>
        Effect.gen(function* () {
          const { run } = yield* launchRun(system);
          const workerThreadId = requireWorkerThreadId(run);
          yield* setThreadSession(system, {
            threadId: workerThreadId,
            status: "running",
            activeTurnId: TurnId.make("turn-nudge-live-worker"),
            tag: "nudge-live-worker",
          });
          yield* Ref.set(system.liveSessions, [
            {
              threadId: workerThreadId,
              provider: ProviderDriverKind.make("codex"),
              providerInstanceId: ProviderInstanceId.make("codex"),
              status: "running",
              driver: ProviderDriverKind.make("codex"),
            } as unknown as ProviderSession,
          ]);

          // The sentinel shares the sweep with the worker, so its settle proves
          // the pass ran and left the working thread untouched.
          const sentinelThreadId = ThreadId.make("thread-nudge-sentinel");
          yield* createPlainThread(system, sentinelThreadId, "nudge-sentinel");
          yield* setThreadSession(system, {
            threadId: sentinelThreadId,
            status: "running",
            activeTurnId: TurnId.make("turn-nudge-sentinel"),
            tag: "nudge-sentinel",
          });

          yield* system.reconciler.start();
          yield* waitUntil(
            sessionStatus(system, sentinelThreadId).pipe(
              Effect.map((status) => status === "error"),
            ),
            "sentinel session to settle",
          );
          yield* system.reactor.drain;

          expect(yield* nudgeActivities(system, workerThreadId)).toHaveLength(0);
          expect(yield* nudgeMessages(system, workerThreadId)).toHaveLength(0);
          expect(yield* sessionStatus(system, workerThreadId)).toBe("running");
        }),
      { reconciler: bootOnlyOptions },
    ),
  );

  it.live("nudges a failed turn when the adapter still lists an errored session", () =>
    withSystem(
      (system) =>
        Effect.gen(function* () {
          const { run } = yield* launchRun(system);
          const workerThreadId = requireWorkerThreadId(run);
          const failedTurnId = TurnId.make("turn-nudge-listed-error");
          const blockedAt = DateTime.formatIso(
            DateTime.subtract(yield* DateTime.now, { hours: 9 }),
          );
          yield* blockThreadOnFailedTurn(system, {
            threadId: workerThreadId,
            turnId: failedTurnId,
            tag: "nudge-listed-error",
            blockedAt,
          });
          yield* system.directory.upsert({
            threadId: workerThreadId,
            provider: ProviderDriverKind.make("opencode"),
            providerInstanceId: ProviderInstanceId.make("opencode"),
            status: "running",
            runtimeMode: "full-access",
            resumeCursor: { sessionId: "ses_stale" },
          });
          yield* Ref.set(system.liveSessions, [
            {
              threadId: workerThreadId,
              provider: ProviderDriverKind.make("opencode"),
              providerInstanceId: ProviderInstanceId.make("opencode"),
              status: "error",
              runtimeMode: "full-access",
              createdAt: blockedAt,
              updatedAt: blockedAt,
              lastError: "Upstream service unavailable",
            },
          ]);

          yield* system.reconciler.start();

          const recoveryAttempts = yield* nudgeActivities(system, workerThreadId);
          expect(recoveryAttempts).toHaveLength(1);
          expect(recoveryAttempts[0]?.payload).toMatchObject({
            attempt: 1,
            phase: "primary",
            selectedProviderInstanceId: "codex",
            selectedModel: "gpt-5-codex",
          });
          expect(yield* nudgeMessages(system, workerThreadId)).toHaveLength(1);
          const binding = Option.getOrUndefined(yield* system.directory.getBinding(workerThreadId));
          expect(binding?.status).toBe("stopped");
        }),
      { reconciler: bootOnlyOptions },
    ),
  );

  it.live("moves the second retryable recovery attempt to the configured backup", () =>
    withSystem(
      (system) =>
        Effect.gen(function* () {
          const { run } = yield* launchRun(system);
          const workerThreadId = requireWorkerThreadId(run);
          const original = yield* getThread(system, workerThreadId);
          const assignmentMessageId = original?.messages.find(
            (message) => message.role === "user",
          )?.id;
          expect(assignmentMessageId).toBeDefined();

          const recoveryStartedAt = DateTime.formatIso(
            DateTime.subtract(yield* DateTime.now, { minutes: 5 }),
          );
          const firstTurnId = TurnId.make("turn-backup-first-failure");
          const firstNudgeMessageId = messageId("backup-primary-retry");
          yield* blockThreadOnFailedTurn(system, {
            threadId: workerThreadId,
            turnId: firstTurnId,
            tag: "backup-first-failure",
            blockedAt: recoveryStartedAt,
          });
          yield* appendProviderTurnFailure(system, {
            threadId: workerThreadId,
            turnId: firstTurnId,
            tag: "backup-first-failure",
            createdAt: recoveryStartedAt,
          });
          const firstAttemptAt = DateTime.formatIso(
            DateTime.subtract(yield* DateTime.now, { minutes: 3 }),
          );
          yield* system.engine.dispatch({
            type: "thread.activity.append",
            commandId: commandId("backup-primary-recovery-record"),
            threadId: workerThreadId,
            activity: {
              id: eventId("backup-primary-recovery-record"),
              tone: "info",
              kind: WORKFLOW_NUDGE_ACTIVITY_KIND,
              summary: "Recovery primary attempt 1/48",
              payload: {
                type: WORKFLOW_NUDGE_ACTIVITY_KIND,
                attempt: 1,
                attemptCeiling: 48,
                blockedTurnId: firstTurnId,
                nudgeMessageId: firstNudgeMessageId,
                reason: "turn-failed",
                recoveryStartedAt,
                recoveryDeadlineAt: DateTime.formatIso(
                  DateTime.add(DateTime.makeUnsafe(Date.parse(recoveryStartedAt)), { hours: 8 }),
                ),
                phase: "primary",
                primaryModelSelection: {
                  instanceId: ProviderInstanceId.make("codex"),
                  model: "gpt-5-codex",
                },
                assignmentMessageIds: [assignmentMessageId!],
                scheduledRetryAt: firstAttemptAt,
              },
              turnId: null,
              createdAt: firstAttemptAt,
            },
            createdAt: firstAttemptAt,
          });
          yield* system.engine.dispatch({
            type: "thread.turn.start",
            commandId: commandId("backup-primary-recovery-turn"),
            threadId: workerThreadId,
            message: {
              messageId: firstNudgeMessageId,
              role: "user",
              text: "Primary recovery attempt",
              attachments: [],
            },
            interactionMode: "implementation-workflow",
            workflowPromptId: WORKFLOW_PROMPT_IDS.implementationTddCodex,
            runtimeMode: "full-access",
            createdAt: firstAttemptAt,
          });

          const secondFailureAt = DateTime.formatIso(
            DateTime.subtract(yield* DateTime.now, { minutes: 2 }),
          );
          const secondTurnId = TurnId.make("turn-backup-second-failure");
          yield* blockThreadOnFailedTurn(system, {
            threadId: workerThreadId,
            turnId: secondTurnId,
            tag: "backup-second-failure",
            blockedAt: secondFailureAt,
          });
          yield* appendProviderTurnFailure(system, {
            threadId: workerThreadId,
            turnId: secondTurnId,
            tag: "backup-second-failure",
            createdAt: secondFailureAt,
          });

          yield* system.reconciler.start();

          const attempts = yield* nudgeActivities(system, workerThreadId);
          expect(attempts).toHaveLength(2);
          expect(attempts[1]?.payload).toMatchObject({
            attempt: 2,
            phase: "backup",
            selectedProviderInstanceId: "claudeBackup",
            selectedModel: "claude-sonnet-5",
          });
          const recovered = yield* getThread(system, workerThreadId);
          const recoveryPrompt = recovered?.messages.at(-1)?.text ?? "";
          expect(recoveryPrompt).toContain(`Assignment message ${assignmentMessageId}`);
          expect(recoveryPrompt).toContain(
            "Inspect Git status, the current diff, and recent commits",
          );
          expect(recoveryPrompt.length).toBeLessThan(120_000);
        }),
      {
        reconciler: bootOnlyOptions,
        settings: {
          providerInstances: {
            [ProviderInstanceId.make("claudeBackup")]: {
              driver: ProviderDriverKind.make("claudeAgent"),
              enabled: true,
            },
          },
          workflowStepModels: [
            {
              workflowPromptId: WORKFLOW_RECOVERY_FALLBACK_MODEL_PIN,
              modelSelection: {
                instanceId: ProviderInstanceId.make("claudeBackup"),
                model: "claude-sonnet-5",
              },
            },
          ],
        },
      },
    ),
  );

  it.live("hands terminal authentication failures to the stage owner without retrying", () =>
    withSystem(
      (system) =>
        Effect.gen(function* () {
          const { run } = yield* launchRun(system);
          const workerThreadId = requireWorkerThreadId(run);
          // Blocked long enough ago to be due for its next nudge, recently
          // enough that the stage is still deferring to it.
          const blockedAt = DateTime.formatIso(
            DateTime.subtract(yield* DateTime.now, { minutes: 5 }),
          );
          const failedTurnId = TurnId.make("turn-nudge-exhaust");
          yield* blockThreadOnFailedTurn(system, {
            threadId: workerThreadId,
            turnId: failedTurnId,
            tag: "nudge-exhaust",
            blockedAt,
          });
          yield* system.engine.dispatch({
            type: "thread.activity.append",
            commandId: commandId("terminal-auth-failure"),
            threadId: workerThreadId,
            activity: {
              id: eventId("terminal-auth-failure"),
              tone: "error",
              kind: "provider.turn.failed",
              summary: "Provider turn failed: authentication",
              payload: {
                turnId: failedTurnId,
                recovery: {
                  disposition: "terminal",
                  reason: "authentication",
                  statusCode: 401,
                },
              },
              turnId: failedTurnId,
              createdAt: blockedAt,
            },
            createdAt: blockedAt,
          });

          yield* system.reconciler.start();
          yield* waitUntil(
            getThread(system, workerThreadId).pipe(
              Effect.map(
                (thread) => thread?.session?.lastError === WORKFLOW_NUDGE_EXHAUSTED_MESSAGE,
              ),
            ),
            "nudge budget to be exhausted",
          );
          yield* system.reactor.drain;

          expect(yield* nudgeActivities(system, workerThreadId)).toHaveLength(0);
          const thread = yield* getThread(system, workerThreadId);
          const reported = (thread?.activities ?? []).filter(
            (activity) => activity.kind === "implementation-worker-result",
          );
          expect(reported).toHaveLength(1);
          const failure = reported[0]?.payload as Record<string, unknown> | undefined;
          expect(failure?.["status"]).toBe("failed");
        }),
      {
        reconciler: {
          sweepIntervalMs: 25,
          graceMs: 0,
          confirmDelayMs: 0,
          maxNudgeAttempts: 1,
          nudgeIntervalMs: 0,
        },
      },
    ),
  );

  it.live("emits one exhaustion result after the original eight-hour deadline", () =>
    withSystem(
      (system) =>
        Effect.gen(function* () {
          const { run } = yield* launchRun(system);
          const workerThreadId = requireWorkerThreadId(run);
          const failedTurnId = TurnId.make("turn-recovery-expired");
          const failedAt = DateTime.formatIso(DateTime.subtract(yield* DateTime.now, { hours: 9 }));
          yield* blockThreadOnFailedTurn(system, {
            threadId: workerThreadId,
            turnId: failedTurnId,
            tag: "recovery-expired",
            blockedAt: failedAt,
          });
          yield* appendProviderTurnFailure(system, {
            threadId: workerThreadId,
            turnId: failedTurnId,
            tag: "recovery-expired",
            createdAt: failedAt,
          });

          yield* system.reconciler.start();
          yield* waitUntil(
            getThread(system, workerThreadId).pipe(
              Effect.map(
                (thread) => thread?.session?.lastError === WORKFLOW_NUDGE_EXHAUSTED_MESSAGE,
              ),
            ),
            "expired recovery handoff",
          );
          yield* system.reactor.drain;

          const thread = yield* getThread(system, workerThreadId);
          expect(
            thread?.activities.filter(
              (activity) => activity.kind === "workflow-recovery-exhausted",
            ),
          ).toHaveLength(1);
          expect(
            thread?.activities.filter(
              (activity) => activity.kind === "implementation-worker-result",
            ),
          ).toHaveLength(1);
          expect(yield* nudgeActivities(system, workerThreadId)).toHaveLength(0);
        }),
      { reconciler: bootOnlyOptions },
    ),
  );
});
