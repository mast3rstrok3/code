import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  DEFAULT_WORKSPACE_USER_ID,
  AppReviewId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
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
  });

  const reactorLayer = ImplementationWorkflowReactorLive.pipe(
    Layer.provide(coreLayer),
    Layer.provide(serverSettingsLayerTest({})),
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

/**
 * Seed a stale-turn-resumed activity as if a prior sweep had appended it. Pass
 * `asReconcilerCommand: true` to reuse the reconciler's deterministic
 * commandId, mimicking a crash between the activity append and the turn start.
 */
function seedResumeActivity(
  system: ReconcilerSystem,
  input: {
    readonly threadId: ThreadId;
    readonly interruptedTurnId: TurnId;
    readonly tag: string;
    readonly asReconcilerCommand?: boolean;
  },
) {
  return system.engine.dispatch({
    type: "thread.activity.append",
    commandId:
      input.asReconcilerCommand === true
        ? CommandId.make(`server:stale-turn:resumed:${input.threadId}:${input.interruptedTurnId}`)
        : commandId(`seed-resume-${input.tag}`),
    threadId: input.threadId,
    activity: {
      id: eventId(`seed-resume-${input.tag}`),
      tone: "info",
      kind: STALE_TURN_RESUME_ACTIVITY_KIND,
      summary: "Resumed after interrupted turn (attempt 1/2)",
      payload: {
        type: STALE_TURN_RESUME_ACTIVITY_KIND,
        attempt: 1,
        maxAttempts: 2,
        interruptedTurnId: input.interruptedTurnId,
        resumeMessageId: `message-stale-turn-resume-${input.threadId}-${input.interruptedTurnId}`,
        workflowPromptId: null,
        reason: "provider-session-lost",
        resumedAt: now,
      },
      turnId: null,
      createdAt: now,
    },
    createdAt: now,
  });
}

/**
 * Seed a fully completed prior resume: the activity AND the resume turn.start
 * receipt under the reconciler's deterministic commandIds, exactly the state a
 * finished resume leaves behind. Keeps later sweeps' safety-net replays
 * no-ops, as in production.
 */
function seedCompletedResume(
  system: ReconcilerSystem,
  input: {
    readonly threadId: ThreadId;
    readonly interruptedTurnId: TurnId;
    readonly tag: string;
  },
) {
  return Effect.gen(function* () {
    yield* seedResumeActivity(system, { ...input, asReconcilerCommand: true });
    yield* system.engine.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make(
        `server:stale-turn:resume:${input.threadId}:${input.interruptedTurnId}`,
      ),
      threadId: input.threadId,
      message: {
        messageId: messageId(`seed-resume-turn-${input.tag}`),
        role: "user",
        text: "Seeded prior resume turn.",
        attachments: [],
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: now,
    });
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

function appendCleanCodeReview(
  system: ReconcilerSystem,
  run: OrchestrationImplementationRun,
  threadId: ThreadId,
  tag: string,
) {
  return Effect.gen(function* () {
    yield* system.engine.dispatch({
      type: "thread.activity.append",
      commandId: commandId(`code-review-${tag}`),
      threadId,
      activity: {
        id: eventId(`code-review-${tag}`),
        tone: "info",
        kind: "implementation-code-review-result",
        summary: "Code review clean",
        payload: {
          type: "implementation-code-review-result",
          runId: run.id,
          status: "clean",
          validations: [],
          reportMarkdown: "## Standards\n- clean\n\n## Spec\n- clean",
        },
        turnId: null,
        createdAt: "2026-01-01T00:00:02.500Z",
      },
      createdAt: "2026-01-01T00:00:02.500Z",
    });
    yield* system.reactor.drain;
  });
}

function passMergeGate(system: ReconcilerSystem, run: OrchestrationImplementationRun) {
  return Effect.gen(function* () {
    const snapshot = yield* system.query.getSnapshot();
    // The run names the validator it is waiting on, and the handler ignores a
    // result from any other thread. A run reaches the gate more than once.
    const validatorThreadId = snapshot.implementationRuns.find(
      (candidate) => candidate.id === run.id,
    )?.activeValidatorThreadId;
    if (!validatorThreadId) throw new Error("Validator missing.");
    yield* system.engine.dispatch({
      type: "thread.activity.append",
      commandId: commandId(`merge-gate-pass-${validatorThreadId}`),
      threadId: validatorThreadId,
      activity: {
        id: eventId(`merge-gate-pass-${validatorThreadId}`),
        tone: "info",
        kind: "implementation-merge-gate-result",
        summary: "Merge gate passed",
        payload: {
          type: "implementation-merge-gate-result",
          runId: run.id,
          status: "passed",
          // The integration gate takes focused validation. Reporting one of the
          // run's complete commands here is what the final gate is for, and the
          // gate rejects it.
          validations: [
            {
              command: "vp test run src/ticket-1.test.ts",
              status: "passed",
              outputMarkdown: "ok",
              completedAt: "2026-01-01T00:00:02.000Z",
            },
          ],
          summaryMarkdown: "ok",
        },
        turnId: null,
        createdAt: "2026-01-01T00:00:02.000Z",
      },
      createdAt: "2026-01-01T00:00:02.000Z",
    });
    yield* system.reactor.drain;
    // A passing gate hands the integrated change to one Code Review before App
    // Review, and App Review only starts once that comes back clean.
    const reviewingSnapshot = yield* system.query.getSnapshot();
    const reviewingRun = reviewingSnapshot.implementationRuns.find(
      (candidate) => candidate.id === run.id,
    );
    if (reviewingRun?.status === "code-reviewing" && reviewingRun.activeCodeReviewThreadId) {
      yield* appendCleanCodeReview(
        system,
        run,
        reviewingRun.activeCodeReviewThreadId,
        "combined-before-app-review",
      );
    }
  });
}

function passAppReview(system: ReconcilerSystem, run: OrchestrationImplementationRun) {
  return Effect.gen(function* () {
    const snapshot = yield* system.query.getSnapshot();
    const reviewingRun = snapshot.implementationRuns.find((entry) => entry.id === run.id);
    const reviewId = reviewingRun?.appReviewIds[0];
    if (reviewId === undefined) throw new Error("App review missing.");
    yield* system.engine.dispatch({
      type: "thread.app-review.update",
      commandId: commandId("app-review-pass"),
      threadId: run.orchestratorThreadId,
      reviewId: AppReviewId.make(reviewId),
      status: "passed",
      updatedAt: "2026-01-01T00:00:03.000Z",
      createdAt: "2026-01-01T00:00:03.000Z",
    });
    yield* system.reactor.drain;
  });
}

function failAppReview(system: ReconcilerSystem, run: OrchestrationImplementationRun) {
  return Effect.gen(function* () {
    const snapshot = yield* system.query.getSnapshot();
    const reviewingRun = snapshot.implementationRuns.find((entry) => entry.id === run.id);
    const reviewId = reviewingRun?.appReviewIds.at(-1);
    if (reviewId === undefined) throw new Error("App review missing.");
    yield* system.engine.dispatch({
      type: "thread.app-review.update",
      commandId: commandId("app-review-fail"),
      threadId: run.orchestratorThreadId,
      reviewId: AppReviewId.make(reviewId),
      status: "failed",
      updatedAt: "2026-01-01T00:00:03.000Z",
      createdAt: "2026-01-01T00:00:03.000Z",
    });
    yield* system.reactor.drain;
  });
}

/**
 * The newest thread holding a role.
 *
 * A run reaches some stages more than once: the integrated change gets one Code
 * Review before App Review and another after it. These tests always mean the
 * stage the run is in now, which is the last thread created for that role.
 */
function findThreadByRole(system: ReconcilerSystem, role: string) {
  return system.query
    .getSnapshot()
    .pipe(
      Effect.map((snapshot) => snapshot.threads.findLast((thread) => thread.workflowRole === role)),
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

  it.live("resumes an orphaned worker turn instead of failing the run", () =>
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
            resumeActivities(system, workerThreadId).pipe(
              Effect.map((activities) => activities.length === 1),
            ),
            "worker resume activity",
          );
          yield* system.reactor.drain;

          const workerThread = yield* getThread(system, workerThreadId);
          expect(workerThread?.session?.status).toBe("error");
          expect(workerThread?.session?.activeTurnId).toBeNull();

          const resumes = yield* resumeActivities(system, workerThreadId);
          expect(resumes).toHaveLength(1);
          expect(resumes[0]?.tone).toBe("info");
          const payload = resumes[0]?.payload as Record<string, unknown>;
          expect(payload["attempt"]).toBe(1);
          expect(payload["maxAttempts"]).toBe(2);
          expect(payload["interruptedTurnId"]).toBe(turnId);
          expect(payload["workflowPromptId"]).toBe(WORKFLOW_PROMPT_IDS.implementationTddCodex);

          const messages = yield* resumeMessages(system, workerThreadId);
          expect(messages).toHaveLength(1);

          const binding = Option.getOrUndefined(yield* system.directory.getBinding(workerThreadId));
          expect(binding?.status).toBe("stopped");
          expect(binding?.resumeCursor).toEqual({ opaque: "resume-worker" });

          const settledRun = yield* getRun(system, run.id);
          expect(settledRun?.status).toBe("running");
          expect(settledRun?.ticketStates[0]?.status).toBe("running");
          expect(settledRun?.workerResults).toHaveLength(0);
          const workerResultActivities = (workerThread?.activities ?? []).filter(
            (activity) => activity.kind === "implementation-worker-result",
          );
          expect(workerResultActivities).toHaveLength(0);
        }),
      { reconciler: bootOnlyOptions },
    ),
  );

  it.live("fails the ticket when the worker resume budget is exhausted", () =>
    withSystem(
      (system) =>
        Effect.gen(function* () {
          const { run } = yield* launchRun(system);
          const workerThreadId = requireWorkerThreadId(run);

          yield* system.reconciler.start();

          yield* setThreadSession(system, {
            threadId: workerThreadId,
            status: "running",
            activeTurnId: TurnId.make("turn-stale-worker-budget-1"),
            tag: "budget-1",
          });
          yield* waitUntil(
            resumeActivities(system, workerThreadId).pipe(
              Effect.map((activities) => activities.length === 1),
            ),
            "first worker resume",
          );

          yield* setThreadSession(system, {
            threadId: workerThreadId,
            status: "running",
            activeTurnId: TurnId.make("turn-stale-worker-budget-2"),
            tag: "budget-2",
          });
          yield* waitUntil(
            resumeActivities(system, workerThreadId).pipe(
              Effect.map((activities) => activities.length === 2),
            ),
            "second worker resume",
          );

          yield* setThreadSession(system, {
            threadId: workerThreadId,
            status: "running",
            activeTurnId: TurnId.make("turn-stale-worker-budget-3"),
            tag: "budget-3",
          });
          yield* waitUntil(
            getRun(system, run.id).pipe(
              Effect.map((entry) => entry?.ticketStates[0]?.status === "failed"),
            ),
            "ticket to fail",
          );
          yield* system.reactor.drain;

          // A blocked stage no longer stops the run. The ticket carries the
          // failure and integration goes on with whatever branches are usable.
          const settledRun = yield* getRun(system, run.id);
          expect(settledRun?.ticketStates[0]?.status).toBe("failed");
          expect(settledRun?.status).toBe("validating");
          expect(settledRun?.workerResults).toHaveLength(1);
          expect(settledRun?.workerResults[0]?.status).toBe("failed");
          expect(yield* resumeActivities(system, workerThreadId)).toHaveLength(2);
          expect(yield* resumeMessages(system, workerThreadId)).toHaveLength(2);
        }),
      { reconciler: { sweepIntervalMs: 100, graceMs: 0, confirmDelayMs: 0 } },
    ),
  );

  it.live("does not duplicate resume artifacts across repeated sweeps", () =>
    withSystem(
      (system) =>
        Effect.gen(function* () {
          const { run } = yield* launchRun(system);
          const workerThreadId = requireWorkerThreadId(run);
          const turnId = TurnId.make("turn-stale-worker-repeat");
          yield* setThreadSession(system, {
            threadId: workerThreadId,
            status: "running",
            activeTurnId: turnId,
            tag: "worker-orphan",
          });

          yield* system.reconciler.start();
          yield* waitUntil(
            resumeActivities(system, workerThreadId).pipe(
              Effect.map((activities) => activities.length === 1),
            ),
            "worker resume activity",
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

          expect(yield* resumeActivities(system, workerThreadId)).toHaveLength(1);
          expect(yield* resumeMessages(system, workerThreadId)).toHaveLength(1);
          const settledRun = yield* getRun(system, run.id);
          expect(settledRun?.workerResults).toHaveLength(0);
        }),
      { reconciler: { sweepIntervalMs: 100, graceMs: 0, confirmDelayMs: 0 } },
    ),
  );

  it.live("resumes an orphaned validator turn", () =>
    withSystem(
      (system) =>
        Effect.gen(function* () {
          const { run } = yield* launchRun(system);
          yield* appendWorkerSuccess(system, run);
          const validator = yield* findThreadByRole(system, "implementation-validator");
          if (!validator) throw new Error("Validator missing.");
          const turnId = TurnId.make("turn-stale-validator-resume");
          yield* setThreadSession(system, {
            threadId: validator.id,
            status: "running",
            activeTurnId: turnId,
            tag: "validator-orphan",
          });

          yield* system.reconciler.start();
          yield* waitUntil(
            resumeActivities(system, validator.id).pipe(
              Effect.map((activities) => activities.length === 1),
            ),
            "validator resume activity",
          );
          yield* system.reactor.drain;

          const resumes = yield* resumeActivities(system, validator.id);
          const payload = resumes[0]?.payload as Record<string, unknown>;
          expect(payload["workflowPromptId"]).toBe(
            WORKFLOW_PROMPT_IDS.implementationMergeGateCodex,
          );
          expect(yield* resumeMessages(system, validator.id)).toHaveLength(1);
          expect(yield* sessionStatus(system, validator.id)).toBe("error");

          const settledRun = yield* getRun(system, run.id);
          expect(settledRun?.status).toBe("validating");
          expect(settledRun?.finalValidation ?? null).toBeNull();
        }),
      { reconciler: bootOnlyOptions },
    ),
  );

  it.live("starts a merge-gate fixer when the validator resume budget is exhausted", () =>
    withSystem(
      (system) =>
        Effect.gen(function* () {
          const { run } = yield* launchRun(system);
          yield* appendWorkerSuccess(system, run);
          const validator = yield* findThreadByRole(system, "implementation-validator");
          if (!validator) throw new Error("Validator missing.");
          yield* seedCompletedResume(system, {
            threadId: validator.id,
            interruptedTurnId: TurnId.make("turn-stale-validator-prior-1"),
            tag: "validator-prior-1",
          });
          yield* seedCompletedResume(system, {
            threadId: validator.id,
            interruptedTurnId: TurnId.make("turn-stale-validator-prior-2"),
            tag: "validator-prior-2",
          });
          yield* setThreadSession(system, {
            threadId: validator.id,
            status: "running",
            activeTurnId: TurnId.make("turn-stale-validator"),
            tag: "validator-orphan",
          });

          yield* system.reconciler.start();
          yield* waitUntil(
            getRun(system, run.id).pipe(Effect.map((entry) => entry?.status === "fixing")),
            "run to start merge-gate fixing",
          );

          const settledRun = yield* getRun(system, run.id);
          expect(settledRun?.status).toBe("fixing");
          expect(settledRun?.activeFixerThreadId).not.toBeNull();
          // The gate a worker's success hands to is the integration one, and
          // only the final gate records a finalValidation.
          expect(settledRun?.activeValidationKind).toBe("integration");
          expect(yield* sessionStatus(system, validator.id)).toBe("error");
          expect(yield* resumeActivities(system, validator.id)).toHaveLength(2);
        }),
      { reconciler: bootOnlyOptions },
    ),
  );

  it.live("publishes work in progress when the code reviewer resume budget is exhausted", () =>
    withSystem(
      (system) =>
        Effect.gen(function* () {
          const { run } = yield* launchRun(system);
          yield* appendWorkerSuccess(system, run);
          yield* passMergeGate(system, run);
          yield* passAppReview(system, run);
          const reviewer = yield* findThreadByRole(system, "implementation-code-reviewer");
          if (!reviewer) throw new Error("Code reviewer missing.");
          const runBefore = yield* getRun(system, run.id);
          expect(runBefore?.status).toBe("code-reviewing");
          yield* seedCompletedResume(system, {
            threadId: reviewer.id,
            interruptedTurnId: TurnId.make("turn-stale-reviewer-prior-1"),
            tag: "reviewer-prior-1",
          });
          yield* seedCompletedResume(system, {
            threadId: reviewer.id,
            interruptedTurnId: TurnId.make("turn-stale-reviewer-prior-2"),
            tag: "reviewer-prior-2",
          });
          yield* setThreadSession(system, {
            threadId: reviewer.id,
            status: "running",
            activeTurnId: TurnId.make("turn-stale-code-reviewer"),
            tag: "code-reviewer-orphan",
          });

          yield* system.reconciler.start();
          // Review problems do not interrupt the pipeline: the run files what it
          // has and hands the pull request to the check babysitter.
          yield* waitUntil(
            getRun(system, run.id).pipe(
              Effect.map((entry) => entry?.status === "babysitting-change-request"),
            ),
            "run to publish its change request",
          );

          expect(yield* sessionStatus(system, reviewer.id)).toBe("error");
        }),
      { reconciler: bootOnlyOptions },
    ),
  );

  it.live("replaces a fixer whose resume budget is exhausted", () =>
    withSystem(
      (system) =>
        Effect.gen(function* () {
          const { run } = yield* launchRun(system);
          yield* appendWorkerSuccess(system, run);
          yield* passMergeGate(system, run);
          // A failing App Review is what spawns a fixer for spec-driven runs; Code Review no longer
          // does, because it lands its own fixes in a single pass.
          yield* failAppReview(system, run);
          const fixer = yield* findThreadByRole(system, "implementation-fixer");
          if (!fixer) throw new Error("Fixer missing.");
          const runBefore = yield* getRun(system, run.id);
          expect(runBefore?.status).toBe("fixing");
          yield* seedCompletedResume(system, {
            threadId: fixer.id,
            interruptedTurnId: TurnId.make("turn-stale-fixer-prior-1"),
            tag: "fixer-prior-1",
          });
          yield* seedCompletedResume(system, {
            threadId: fixer.id,
            interruptedTurnId: TurnId.make("turn-stale-fixer-prior-2"),
            tag: "fixer-prior-2",
          });
          yield* setThreadSession(system, {
            threadId: fixer.id,
            status: "running",
            activeTurnId: TurnId.make("turn-stale-fixer"),
            tag: "fixer-orphan",
          });

          yield* system.reconciler.start();
          // Settling the exhausted fixer leaves the stage incomplete, and stage
          // recovery starts a fresh one rather than stopping the run.
          yield* waitUntil(
            system.query
              .getSnapshot()
              .pipe(
                Effect.map(
                  (snapshot) =>
                    snapshot.threads.filter(
                      (thread) => thread.workflowRole === "implementation-fixer",
                    ).length === 2,
                ),
              ),
            "a replacement fixer",
          );

          expect(yield* sessionStatus(system, fixer.id)).toBe("error");
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

  it.live("re-dispatches the resume turn when a prior resume crashed before starting it", () =>
    withSystem(
      (system) =>
        Effect.gen(function* () {
          const { run } = yield* launchRun(system);
          const workerThreadId = requireWorkerThreadId(run);
          const turnId = TurnId.make("turn-stale-safety-replay");
          // Mimic a crash between the resume-activity append and the turn
          // start: the activity exists under the reconciler's own commandId
          // and the session is already settled, but no resume turn started.
          yield* seedResumeActivity(system, {
            threadId: workerThreadId,
            interruptedTurnId: turnId,
            tag: "safety-replay",
            asReconcilerCommand: true,
          });
          yield* setThreadSession(system, {
            threadId: workerThreadId,
            status: "error",
            activeTurnId: null,
            tag: "safety-replay-settled",
          });

          yield* system.reconciler.start();
          yield* waitUntil(
            resumeMessages(system, workerThreadId).pipe(
              Effect.map((messages) => messages.length === 1),
            ),
            "resume turn to dispatch",
          );
          // Let several more sweeps run to prove the dispatch is idempotent.
          yield* Effect.sleep(Duration.millis(500));
          yield* system.reactor.drain;

          expect(yield* resumeMessages(system, workerThreadId)).toHaveLength(1);
          expect(yield* resumeActivities(system, workerThreadId)).toHaveLength(1);
          const settledRun = yield* getRun(system, run.id);
          expect(settledRun?.status).toBe("running");
          expect(settledRun?.ticketStates[0]?.status).toBe("running");
        }),
      { reconciler: { sweepIntervalMs: 100, graceMs: 0, confirmDelayMs: 0 } },
    ),
  );

  it.live("propagates the failure when the safety-net resume budget is exhausted", () =>
    withSystem(
      (system) =>
        Effect.gen(function* () {
          const { run } = yield* launchRun(system);
          const workerThreadId = requireWorkerThreadId(run);
          yield* seedCompletedResume(system, {
            threadId: workerThreadId,
            interruptedTurnId: TurnId.make("turn-stale-safety-prior-1"),
            tag: "safety-prior-1",
          });
          yield* seedCompletedResume(system, {
            threadId: workerThreadId,
            interruptedTurnId: TurnId.make("turn-stale-safety-prior-2"),
            tag: "safety-prior-2",
          });
          yield* setThreadSession(system, {
            threadId: workerThreadId,
            status: "error",
            activeTurnId: null,
            tag: "safety-budget-settled",
          });

          yield* system.reconciler.start();
          yield* waitUntil(
            getRun(system, run.id).pipe(
              Effect.map((entry) => entry?.ticketStates[0]?.status === "failed"),
            ),
            "ticket to fail",
          );
          yield* system.reactor.drain;

          const settledRun = yield* getRun(system, run.id);
          expect(settledRun?.ticketStates[0]?.status).toBe("failed");
          expect(settledRun?.status).toBe("validating");
          expect(settledRun?.workerResults).toHaveLength(1);
          expect(settledRun?.workerResults[0]?.status).toBe("failed");
          expect(yield* resumeActivities(system, workerThreadId)).toHaveLength(2);
          expect(yield* resumeMessages(system, workerThreadId)).toHaveLength(0);
        }),
      { reconciler: { ...bootOnlyOptions, maxResumeAttempts: 1 } },
    ),
  );

  it.live("leaves errored workflow sessions alone when the reconciler never resumed them", () =>
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
          // Untouched: the reconciler's settle would have stamped lastError.
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

  it.live("nudges a worker blocked by a failed turn instead of replacing it", () =>
    withSystem(
      (system) =>
        Effect.gen(function* () {
          const { run } = yield* launchRun(system);
          const workerThreadId = requireWorkerThreadId(run);
          yield* blockThreadOnFailedTurn(system, {
            threadId: workerThreadId,
            turnId: TurnId.make("turn-nudge-worker"),
            tag: "nudge-worker",
          });

          yield* system.reconciler.start();
          yield* waitUntil(
            nudgeActivities(system, workerThreadId).pipe(
              Effect.map((activities) => activities.length === 1),
            ),
            "worker nudge activity",
          );
          yield* system.reactor.drain;

          const nudges = yield* nudgeActivities(system, workerThreadId);
          const payload = nudges[0]?.payload as Record<string, unknown>;
          expect(payload["attempt"]).toBe(1);
          expect(payload["workflowPromptId"]).toBe(WORKFLOW_PROMPT_IDS.implementationTddCodex);
          expect(yield* nudgeMessages(system, workerThreadId)).toHaveLength(1);
          // A nudge is not a settle: the provider's own failure state stands.
          expect(yield* resumeActivities(system, workerThreadId)).toHaveLength(0);

          const nudgedRun = yield* getRun(system, run.id);
          expect(nudgedRun?.status).toBe("running");
          expect(nudgedRun?.ticketStates[0]?.status).toBe("running");
          expect(nudgedRun?.ticketStates[0]?.workerThreadId).toBe(workerThreadId);
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

  it.live("gives up after the nudge budget and hands the thread back to its stage", () =>
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
          yield* blockThreadOnFailedTurn(system, {
            threadId: workerThreadId,
            turnId: TurnId.make("turn-nudge-exhaust"),
            tag: "nudge-exhaust",
            blockedAt,
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

          expect(yield* nudgeActivities(system, workerThreadId)).toHaveLength(1);
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
});
