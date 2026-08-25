// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  OrchestrationReadModel,
  ProviderDriverKind,
  ProviderRuntimeEvent,
  ProviderSession,
  ProviderInstanceId,
} from "@t3tools/contracts";
import {
  ApprovalRequestId,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_WORKSPACE_USER_ID,
  AppReviewId,
  EventId,
  MessageId,
  type OrchestrationCommand,
  ProjectId,
  ProviderItemId,
  type ServerSettings,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { type DeepPartial } from "@t3tools/shared/Struct";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { it as effectIt } from "@effect/vitest";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import {
  MAX_PRODUCT_INTENT_LOCK_REJECTION_BOUNCES,
  ProviderRuntimeIngestionLive,
  turnOwesWorkflowDirective,
} from "./ProviderRuntimeIngestion.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import { DEFAULT_THREAD_TITLE } from "../threadTitles.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProviderRuntimeIngestionService } from "../Services/ProviderRuntimeIngestion.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ServerActivation } from "../../serverActivation.ts";
import { WORKFLOW_PROMPT_IDS } from "../../provider/WorkflowPromptRegistry.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";

function makeTestServerSettingsLayer(overrides: DeepPartial<ServerSettings> = {}) {
  return ServerSettingsService.layerTest(overrides);
}

const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asItemId = (value: string): ProviderItemId => ProviderItemId.make(value);
const asEventId = (value: string): EventId => EventId.make(value);
const asMessageId = (value: string): MessageId => MessageId.make(value);
const asThreadId = (value: string): ThreadId => ThreadId.make(value);
const asTurnId = (value: string): TurnId => TurnId.make(value);

it("requires workflow directives only from cleanly completed turns", () => {
  const base = {
    eventId: asEventId("event-workflow-directive-terminal-state"),
    provider: ProviderDriverKind.make("codex"),
    createdAt: "2026-01-01T00:00:00.000Z",
    threadId: asThreadId("thread-workflow-directive-terminal-state"),
    turnId: asTurnId("turn-workflow-directive-terminal-state"),
  };

  expect(
    turnOwesWorkflowDirective({ ...base, type: "turn.completed", payload: { state: "completed" } }),
  ).toBe(true);
  expect(
    turnOwesWorkflowDirective({
      ...base,
      type: "turn.completed",
      payload: { state: "failed", errorMessage: "Provider endpoint is unavailable." },
    }),
  ).toBe(false);
  expect(
    turnOwesWorkflowDirective({
      ...base,
      type: "turn.completed",
      payload: { state: "interrupted" },
    }),
  ).toBe(false);
  expect(
    turnOwesWorkflowDirective({ ...base, type: "turn.aborted", payload: { reason: "Stopped" } }),
  ).toBe(false);
});

type LegacyProviderRuntimeEvent = {
  readonly type: string;
  readonly eventId: EventId;
  readonly provider: ProviderRuntimeEvent["provider"];
  readonly createdAt: string;
  readonly threadId: ThreadId;
  readonly turnId?: string | undefined;
  readonly itemId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly payload?: unknown | undefined;
  readonly [key: string]: unknown;
};

type LegacyTurnCompletedEvent = LegacyProviderRuntimeEvent & {
  readonly type: "turn.completed";
  readonly payload?: undefined;
  readonly status: "completed" | "failed" | "interrupted" | "cancelled";
  readonly errorMessage?: string | undefined;
};

function isLegacyTurnCompletedEvent(
  event: LegacyProviderRuntimeEvent,
): event is LegacyTurnCompletedEvent {
  return (
    event.type === "turn.completed" &&
    event.payload === undefined &&
    typeof event.status === "string"
  );
}

function createProviderServiceHarness() {
  const runtimeEventPubSub = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());
  const runtimeSessions: ProviderSession[] = [];

  const unsupported = () => Effect.die(new Error("Unsupported provider call in test")) as never;
  const service: ProviderServiceShape = {
    startSession: () => unsupported(),
    sendTurn: () => unsupported(),
    interruptTurn: () => unsupported(),
    respondToRequest: () => unsupported(),
    respondToUserInput: () => unsupported(),
    stopSession: () => unsupported(),
    listSessions: () => Effect.succeed([...runtimeSessions]),
    getCapabilities: () => Effect.succeed({ sessionModelSwitch: "in-session" }),
    getInstanceInfo: (instanceId) => {
      const driverKind = ProviderDriverKind.make(String(instanceId));
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
    rollbackConversation: () => unsupported(),
    get streamEvents() {
      return Stream.fromPubSub(runtimeEventPubSub);
    },
  };

  const setSession = (session: ProviderSession): void => {
    const existingIndex = runtimeSessions.findIndex((entry) => entry.threadId === session.threadId);
    if (existingIndex >= 0) {
      runtimeSessions[existingIndex] = session;
      return;
    }
    runtimeSessions.push(session);
  };

  const normalizeLegacyEvent = (event: LegacyProviderRuntimeEvent): ProviderRuntimeEvent => {
    if (isLegacyTurnCompletedEvent(event)) {
      const normalized: Extract<ProviderRuntimeEvent, { type: "turn.completed" }> = {
        ...(event as Omit<Extract<ProviderRuntimeEvent, { type: "turn.completed" }>, "payload">),
        payload: {
          state: event.status,
          ...(typeof event.errorMessage === "string" ? { errorMessage: event.errorMessage } : {}),
        },
      };
      return normalized;
    }

    return event as ProviderRuntimeEvent;
  };

  const emit = (event: LegacyProviderRuntimeEvent): void => {
    Effect.runSync(PubSub.publish(runtimeEventPubSub, normalizeLegacyEvent(event)));
  };

  return {
    service,
    emit,
    setSession,
  };
}

type ProviderRuntimeTestReadModel = OrchestrationReadModel;
type ProviderRuntimeTestThread = ProviderRuntimeTestReadModel["threads"][number];
type ProviderRuntimeTestMessage = ProviderRuntimeTestThread["messages"][number];
type ProviderRuntimeTestProposedPlan = ProviderRuntimeTestThread["proposedPlans"][number];
type ProviderRuntimeTestActivity = ProviderRuntimeTestThread["activities"][number];
type ProviderRuntimeTestCheckpoint = ProviderRuntimeTestThread["checkpoints"][number];

async function waitForThread(
  readModel: () => Promise<ProviderRuntimeTestReadModel>,
  predicate: (thread: ProviderRuntimeTestThread) => boolean,
  timeoutMs = 2000,
  threadId: ThreadId = asThreadId("thread-1"),
) {
  const deadline = (await Effect.runPromise(Clock.currentTimeMillis)) + timeoutMs;
  const poll = async (): Promise<ProviderRuntimeTestThread> => {
    const snapshot = await readModel();
    const thread = snapshot.threads.find((entry) => entry.id === threadId);
    if (thread && predicate(thread)) {
      return thread;
    }
    if ((await Effect.runPromise(Clock.currentTimeMillis)) >= deadline) {
      throw new Error("Timed out waiting for thread state");
    }
    await Effect.runPromise(Effect.yieldNow);
    return poll();
  };
  return poll();
}

async function waitForReadModel(
  readModel: () => Promise<ProviderRuntimeTestReadModel>,
  predicate: (snapshot: ProviderRuntimeTestReadModel) => boolean,
  timeoutMs = 2000,
) {
  const deadline = (await Effect.runPromise(Clock.currentTimeMillis)) + timeoutMs;
  const poll = async (): Promise<ProviderRuntimeTestReadModel> => {
    const snapshot = await readModel();
    if (predicate(snapshot)) {
      return snapshot;
    }
    if ((await Effect.runPromise(Clock.currentTimeMillis)) >= deadline) {
      throw new Error("Timed out waiting for read model state");
    }
    await Effect.runPromise(Effect.yieldNow);
    return poll();
  };
  return poll();
}

describe("ProviderRuntimeIngestion", () => {
  let runtime: ManagedRuntime.ManagedRuntime<
    OrchestrationEngineService | ProviderRuntimeIngestionService | ProjectionSnapshotQuery,
    unknown
  > | null = null;
  let scope: Scope.Closeable | null = null;
  const tempDirs: string[] = [];

  function makeTempDir(prefix: string): string {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    if (scope) {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
    scope = null;
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
    for (const dir of tempDirs.splice(0)) {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });

  async function createHarness(options?: {
    activation?: Effect.Effect<void>;
    serverSettings?: DeepPartial<ServerSettings>;
    threadTitle?: string;
  }) {
    const workspaceRoot = makeTempDir("t3-provider-project-");
    NodeFS.mkdirSync(NodePath.join(workspaceRoot, ".git"));
    const provider = createProviderServiceHarness();
    const orchestrationLayer = OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provide(RepositoryIdentityResolver.layer),
      Layer.provide(SqlitePersistenceMemory),
    );
    const projectionSnapshotLayer = OrchestrationProjectionSnapshotQueryLive.pipe(
      Layer.provide(RepositoryIdentityResolver.layer),
      Layer.provide(SqlitePersistenceMemory),
    );
    const layer = ProviderRuntimeIngestionLive.pipe(
      Layer.provideMerge(orchestrationLayer),
      Layer.provideMerge(projectionSnapshotLayer),
      // Single shared liveness instance across ingestion (writer), the
      // engine, and the snapshot query (reader).
      Layer.provideMerge(ThreadBackgroundLiveness.layer),
      Layer.provideMerge(ThreadPlanProgress.layer),
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(Layer.succeed(ProviderService, provider.service)),
      Layer.provideMerge(makeTestServerSettingsLayer(options?.serverSettings)),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
      Layer.provideMerge(Layer.succeed(ServerActivation, options?.activation)),
      Layer.provideMerge(NodeServices.layer),
    );
    runtime = ManagedRuntime.make(layer);
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const snapshotQuery = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
    const ingestion = await runtime.runPromise(Effect.service(ProviderRuntimeIngestionService));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(ingestion.start().pipe(Scope.provide(scope)));
    const drain = () => Effect.runPromise(ingestion.drain);
    const dispatch = (command: OrchestrationCommand) => Effect.runPromise(engine.dispatch(command));

    const createdAt = "2026-01-01T00:00:00.000Z";
    await dispatch({
      type: "project.create",
      commandId: CommandId.make("cmd-provider-project-create"),
      projectId: asProjectId("project-1"),
      title: "Provider Project",
      workspaceRoot,
      defaultModelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      createdAt,
    });
    await dispatch({
      type: "thread.create",
      commandId: CommandId.make("cmd-thread-create"),
      threadId: ThreadId.make("thread-1"),
      projectId: asProjectId("project-1"),
      ownerUserId: DEFAULT_WORKSPACE_USER_ID,
      title: options?.threadTitle ?? "Thread",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      branch: null,
      worktreePath: null,
      createdAt,
    });
    await dispatch({
      type: "thread.session.set",
      commandId: CommandId.make("cmd-session-seed"),
      threadId: ThreadId.make("thread-1"),
      session: {
        threadId: ThreadId.make("thread-1"),
        status: "ready",
        providerName: "codex",
        runtimeMode: "approval-required",
        activeTurnId: null,
        updatedAt: createdAt,
        lastError: null,
      },
      createdAt,
    });
    provider.setSession({
      provider: ProviderDriverKind.make("codex"),
      status: "ready",
      runtimeMode: "approval-required",
      threadId: ThreadId.make("thread-1"),
      createdAt,
      updatedAt: createdAt,
    });

    return {
      engine,
      dispatch,
      readModel: () => Effect.runPromise(snapshotQuery.getSnapshot()),
      emit: provider.emit,
      setProviderSession: provider.setSession,
      drain,
    };
  }

  it("maps turn started/completed events into thread session updates", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started"),
      provider: ProviderDriverKind.make("codex"),
      threadId: asThreadId("thread-1"),
      createdAt: now,
      turnId: asTurnId("turn-1"),
    });

    await waitForThread(
      harness.readModel,
      (thread) => thread.session?.status === "running" && thread.session?.activeTurnId === "turn-1",
    );

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed"),
      provider: ProviderDriverKind.make("codex"),
      threadId: asThreadId("thread-1"),
      createdAt: "2026-01-01T00:00:00.000Z",
      turnId: asTurnId("turn-1"),
      payload: {
        state: "failed",
        errorMessage: "turn failed",
        recovery: {
          disposition: "retryable",
          reason: "overloaded",
          statusCode: 503,
          retryAt: "2026-01-01T00:05:00.000Z",
        },
      },
    });

    const thread = await waitForThread(
      harness.readModel,
      (entry) =>
        entry.session?.status === "error" &&
        entry.session?.activeTurnId === null &&
        entry.session?.lastError === "turn failed" &&
        entry.activities.some((activity) => activity.kind === "provider.turn.failed"),
    );
    expect(thread.session?.status).toBe("error");
    expect(thread.session?.lastError).toBe("turn failed");
    expect(
      thread.activities.find((activity) => activity.kind === "provider.turn.failed"),
    ).toMatchObject({
      turnId: "turn-1",
      payload: {
        provider: "codex",
        recovery: {
          disposition: "retryable",
          reason: "overloaded",
          statusCode: 503,
          retryAt: "2026-01-01T00:05:00.000Z",
        },
      },
    });
  });

  it("subscribes to hot provider events before server activation", async () => {
    const harness = await createHarness({ activation: Effect.never });
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-before-activation"),
      provider: ProviderDriverKind.make("codex"),
      threadId: asThreadId("thread-1"),
      createdAt: now,
      turnId: asTurnId("turn-before-activation"),
    });

    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-before-activation",
    );
  });

  it("applies provider session.state.changed transitions directly", async () => {
    const harness = await createHarness();
    const waitingAt = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "session.state.changed",
      eventId: asEventId("evt-session-state-waiting"),
      provider: ProviderDriverKind.make("codex"),
      threadId: asThreadId("thread-1"),
      createdAt: waitingAt,
      payload: {
        state: "waiting",
        reason: "awaiting approval",
      },
    });

    let thread = await waitForThread(
      harness.readModel,
      (entry) => entry.session?.status === "running" && entry.session?.activeTurnId === null,
    );
    expect(thread.session?.status).toBe("running");
    expect(thread.session?.lastError).toBeNull();

    harness.emit({
      type: "session.state.changed",
      eventId: asEventId("evt-session-state-error"),
      provider: ProviderDriverKind.make("codex"),
      threadId: asThreadId("thread-1"),
      createdAt: "2026-01-01T00:00:00.000Z",
      payload: {
        state: "error",
        reason: "provider crashed",
      },
    });

    thread = await waitForThread(
      harness.readModel,
      (entry) =>
        entry.session?.status === "error" &&
        entry.session?.activeTurnId === null &&
        entry.session?.lastError === "provider crashed",
    );
    expect(thread.session?.status).toBe("error");
    expect(thread.session?.lastError).toBe("provider crashed");

    harness.emit({
      type: "session.state.changed",
      eventId: asEventId("evt-session-state-stopped"),
      provider: ProviderDriverKind.make("codex"),
      threadId: asThreadId("thread-1"),
      createdAt: "2026-01-01T00:00:00.000Z",
      payload: {
        state: "stopped",
      },
    });

    thread = await waitForThread(
      harness.readModel,
      (entry) =>
        entry.session?.status === "stopped" &&
        entry.session?.activeTurnId === null &&
        entry.session?.lastError === "provider crashed",
    );
    expect(thread.session?.status).toBe("stopped");
    expect(thread.session?.lastError).toBe("provider crashed");

    harness.emit({
      type: "session.state.changed",
      eventId: asEventId("evt-session-state-ready"),
      provider: ProviderDriverKind.make("codex"),
      threadId: asThreadId("thread-1"),
      createdAt: "2026-01-01T00:00:00.000Z",
      payload: {
        state: "ready",
      },
    });

    thread = await waitForThread(
      harness.readModel,
      (entry) =>
        entry.session?.status === "ready" &&
        entry.session?.activeTurnId === null &&
        entry.session?.lastError === null,
    );
    expect(thread.session?.status).toBe("ready");
    expect(thread.session?.lastError).toBeNull();
  });

  it("clears active turn when provider session becomes ready", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-session-ready"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-session-ready"),
    });

    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-session-ready",
      10_000,
    );

    harness.emit({
      type: "session.state.changed",
      eventId: asEventId("evt-session-state-ready-with-active-turn"),
      provider: ProviderDriverKind.make("codex"),
      threadId: asThreadId("thread-1"),
      createdAt: "2026-01-01T00:00:01.000Z",
      payload: {
        state: "ready",
      },
    });

    const thread = await waitForThread(
      harness.readModel,
      (entry) =>
        entry.session?.status === "ready" &&
        entry.session?.activeTurnId === null &&
        entry.session?.lastError === null,
      10_000,
    );
    expect(thread.session?.status).toBe("ready");
    expect(thread.session?.activeTurnId).toBeNull();
    expect(thread.session?.lastError).toBeNull();
  });

  effectIt.effect(
    "keeps a reconnecting pending turn starting while ready clears stale active state",
    () =>
      Effect.gen(function* () {
        const harness = yield* Effect.promise(() => createHarness());
        const threadId = asThreadId("thread-1");
        const staleTurnId = asTurnId("turn-stale-before-reconnect");

        yield* harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-turn-start-pending-reconnect"),
          threadId,
          message: {
            messageId: MessageId.make("message-pending-reconnect"),
            role: "user",
            text: "resume after reconnect",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: "2026-01-01T00:00:01.000Z",
        });
        yield* harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("cmd-session-starting-pending-reconnect"),
          threadId,
          session: {
            threadId,
            status: "starting",
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: staleTurnId,
            lastError: null,
            updatedAt: "2026-01-01T00:00:01.000Z",
          },
          createdAt: "2026-01-01T00:00:01.000Z",
        });

        harness.emit({
          type: "session.state.changed",
          eventId: asEventId("evt-session-ready-pending-reconnect"),
          provider: ProviderDriverKind.make("codex"),
          threadId,
          createdAt: "2026-01-01T00:00:02.000Z",
          payload: { state: "ready" },
        });

        let thread = yield* Effect.promise(() =>
          waitForThread(
            harness.readModel,
            (entry) => entry.session?.status === "starting" && entry.session.activeTurnId === null,
          ),
        );
        expect(thread.session?.status).toBe("starting");
        expect(thread.session?.activeTurnId).toBeNull();

        harness.emit({
          type: "session.started",
          eventId: asEventId("evt-session-started-pending-reconnect"),
          provider: ProviderDriverKind.make("codex"),
          threadId,
          createdAt: "2026-01-01T00:00:03.000Z",
        });
        yield* Effect.promise(() => harness.drain());
        thread = (yield* Effect.promise(() => harness.readModel())).threads.find(
          (entry) => entry.id === threadId,
        )!;
        expect(thread.session?.status).toBe("starting");
        expect(thread.session?.activeTurnId).toBeNull();

        harness.emit({
          type: "turn.started",
          eventId: asEventId("evt-turn-started-pending-reconnect"),
          provider: ProviderDriverKind.make("codex"),
          threadId,
          turnId: asTurnId("turn-after-reconnect"),
          createdAt: "2026-01-01T00:00:04.000Z",
        });
        thread = yield* Effect.promise(() =>
          waitForThread(
            harness.readModel,
            (entry) =>
              entry.session?.status === "running" &&
              entry.session.activeTurnId === asTurnId("turn-after-reconnect"),
          ),
        );
        expect(thread.session?.status).toBe("running");

        harness.emit({
          type: "session.started",
          eventId: asEventId("evt-session-started-duplicate-midturn"),
          provider: ProviderDriverKind.make("codex"),
          threadId,
          createdAt: "2026-01-01T00:00:05.000Z",
        });
        yield* Effect.promise(() => harness.drain());
        thread = (yield* Effect.promise(() => harness.readModel())).threads.find(
          (entry) => entry.id === threadId,
        )!;
        expect(thread.session?.status).toBe("running");
        expect(thread.session?.activeTurnId).toBe(asTurnId("turn-after-reconnect"));
      }),
  );

  effectIt.effect("keeps an aborted pending start stopped across duplicate exit events", () =>
    Effect.gen(function* () {
      const harness = yield* Effect.promise(() => createHarness());
      const threadId = asThreadId("thread-1");
      const stoppedAt = "2026-01-01T00:00:02.000Z";

      yield* harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-before-stop"),
        threadId,
        message: {
          messageId: MessageId.make("message-before-stop"),
          role: "user",
          text: "stop this startup",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:01.000Z",
      });
      yield* harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-starting-before-stop"),
        threadId,
        session: {
          threadId,
          status: "starting",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: "2026-01-01T00:00:01.000Z",
        },
        createdAt: "2026-01-01T00:00:01.000Z",
      });
      yield* harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-stop-pending-start"),
        threadId,
        session: {
          threadId,
          status: "stopped",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: stoppedAt,
        },
        createdAt: stoppedAt,
      });

      harness.emit({
        type: "session.exited",
        eventId: asEventId("evt-session-exited-after-stop"),
        provider: ProviderDriverKind.make("codex"),
        threadId,
        createdAt: "2026-01-01T00:00:03.000Z",
      });
      harness.emit({
        type: "session.exited",
        eventId: asEventId("evt-duplicate-session-exited-after-stop"),
        provider: ProviderDriverKind.make("codex"),
        threadId,
        createdAt: "2026-01-01T00:00:04.000Z",
      });

      yield* Effect.promise(() => harness.drain());
      const thread = (yield* Effect.promise(() => harness.readModel())).threads.find(
        (entry) => entry.id === threadId,
      );
      expect(thread?.session?.status).toBe("stopped");
      expect(thread?.session?.activeTurnId).toBeNull();
    }),
  );

  it("does not clear active turn when session/thread started arrives mid-turn", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-midturn-lifecycle"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-midturn-lifecycle"),
    });

    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-midturn-lifecycle",
      10_000,
    );

    harness.emit({
      type: "thread.started",
      eventId: asEventId("evt-thread-started-midturn-lifecycle"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: asThreadId("thread-1"),
    });
    harness.emit({
      type: "session.started",
      eventId: asEventId("evt-session-started-midturn-lifecycle"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: asThreadId("thread-1"),
    });

    await harness.drain();
    const midReadModel = await harness.readModel();
    const midThread = midReadModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(midThread?.session?.status).toBe("running");
    expect(midThread?.session?.activeTurnId).toBe("turn-midturn-lifecycle");

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-midturn-lifecycle"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-midturn-lifecycle"),
      status: "completed",
    });

    await waitForThread(
      harness.readModel,
      (thread) => thread.session?.status === "ready" && thread.session?.activeTurnId === null,
      10_000,
    );
  });

  it("accepts claude turn lifecycle when seeded thread id is a synthetic placeholder", async () => {
    const harness = await createHarness();
    const seededAt = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-seed-claude-placeholder"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "claudeAgent",
          runtimeMode: "approval-required",
          activeTurnId: null,
          updatedAt: seededAt,
          lastError: null,
        },
        createdAt: seededAt,
      }),
    );

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-claude-placeholder"),
      provider: ProviderDriverKind.make("claudeAgent"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-claude-placeholder"),
    });

    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-claude-placeholder",
    );

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-claude-placeholder"),
      provider: ProviderDriverKind.make("claudeAgent"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-claude-placeholder"),
      status: "completed",
    });

    await waitForThread(
      harness.readModel,
      (thread) => thread.session?.status === "ready" && thread.session?.activeTurnId === null,
    );
  });

  it("ignores auxiliary turn completions from a different provider thread", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-primary"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-primary"),
    });

    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === "running" && thread.session?.activeTurnId === "turn-primary",
    );

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-aux"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-aux"),
      status: "completed",
    });

    await harness.drain();
    const midReadModel = await harness.readModel();
    const midThread = midReadModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(midThread?.session?.status).toBe("running");
    expect(midThread?.session?.activeTurnId).toBe("turn-primary");

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-primary"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-primary"),
      status: "completed",
    });

    await waitForThread(
      harness.readModel,
      (thread) => thread.session?.status === "ready" && thread.session?.activeTurnId === null,
    );
  });

  it("rejects an untargeted turn.completed when no turn is active", async () => {
    const harness = await createHarness();
    const seededAt = "2026-01-01T00:00:00.000Z";

    // A turn start is pending: the session reads "starting" with no active
    // turn tracked yet. This is the window the Claude resume handshake's
    // phantom (turn.completed with no turnId) used to slip through, stomping
    // "starting" back to "ready" for a turn that never existed.
    await harness.dispatch({
      type: "thread.session.set",
      commandId: CommandId.make("cmd-session-seed-untargeted-completion"),
      threadId: ThreadId.make("thread-1"),
      session: {
        threadId: ThreadId.make("thread-1"),
        status: "starting",
        providerName: "claudeAgent",
        runtimeMode: "approval-required",
        activeTurnId: null,
        updatedAt: seededAt,
        lastError: null,
      },
      createdAt: seededAt,
    });

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-untargeted"),
      provider: ProviderDriverKind.make("claudeAgent"),
      createdAt: seededAt,
      threadId: asThreadId("thread-1"),
      status: "completed",
    });

    await harness.drain();
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session?.status).toBe("starting");
    expect(thread?.session?.activeTurnId).toBeNull();
  });

  it("accepts a targeted turn.completed when no turn is active", async () => {
    const harness = await createHarness();
    const seededAt = "2026-01-01T00:00:00.000Z";

    // A completion that names its turn still lands even when no active turn
    // is tracked (e.g. its turn.started was lost). Only untargeted
    // completions are rejected.
    await harness.dispatch({
      type: "thread.session.set",
      commandId: CommandId.make("cmd-session-seed-targeted-completion"),
      threadId: ThreadId.make("thread-1"),
      session: {
        threadId: ThreadId.make("thread-1"),
        status: "starting",
        providerName: "claudeAgent",
        runtimeMode: "approval-required",
        activeTurnId: null,
        updatedAt: seededAt,
        lastError: null,
      },
      createdAt: seededAt,
    });

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-targeted-late"),
      provider: ProviderDriverKind.make("claudeAgent"),
      createdAt: seededAt,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-late"),
      status: "completed",
    });

    await waitForThread(harness.readModel, (thread) => thread.session?.status === "ready");
  });

  it("ignores non-active turn completion when runtime omits thread id", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-guarded"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-guarded-main"),
    });

    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-guarded-main",
    );

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-guarded-other"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-guarded-other"),
      status: "completed",
    });

    await harness.drain();
    const midReadModel = await harness.readModel();
    const midThread = midReadModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(midThread?.session?.status).toBe("running");
    expect(midThread?.session?.activeTurnId).toBe("turn-guarded-main");

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-guarded-main"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-guarded-main"),
      status: "completed",
    });

    await waitForThread(
      harness.readModel,
      (thread) => thread.session?.status === "ready" && thread.session?.activeTurnId === null,
    );
  });

  it("maps canonical content delta/item completed into finalized assistant messages", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-1"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-2"),
      itemId: asItemId("item-1"),
      payload: {
        streamKind: "assistant_text",
        delta: "hello",
      },
    });
    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-2"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-2"),
      itemId: asItemId("item-1"),
      payload: {
        streamKind: "assistant_text",
        delta: " world",
      },
    });
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-message-completed"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-2"),
      itemId: asItemId("item-1"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-1" && !message.streaming,
      ),
    );
    const message = thread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-1",
    );
    expect(message?.text).toBe("hello world");
    expect(message?.streaming).toBe(false);
  });

  it("uses assistant item completion detail when no assistant deltas were streamed", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-assistant-item-completed-no-delta"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-no-delta"),
      itemId: asItemId("item-no-delta"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
        detail: "assistant-only final text",
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-no-delta" && !message.streaming,
      ),
    );
    const message = thread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-no-delta",
    );
    expect(message?.text).toBe("assistant-only final text");
    expect(message?.streaming).toBe(false);
  });

  it("preserves completed tool metadata on projected tool activities", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-tool-completed-with-data"),
      provider: ProviderDriverKind.make("cursor"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-tool-completed"),
      itemId: asItemId("item-tool-completed"),
      payload: {
        itemType: "dynamic_tool_call",
        status: "completed",
        title: "Read file",
        data: {
          toolCallId: "tool-read-1",
          kind: "read",
          rawOutput: {
            content: 'import * as Effect from "effect/Effect"\n',
          },
        },
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.id === "evt-tool-completed-with-data",
      ),
    );
    const activity = thread.activities.find(
      (entry: ProviderRuntimeTestActivity) => entry.id === "evt-tool-completed-with-data",
    );
    const payload =
      activity?.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : undefined;
    const data =
      payload?.data && typeof payload.data === "object"
        ? (payload.data as Record<string, unknown>)
        : undefined;
    const rawOutput =
      data?.rawOutput && typeof data.rawOutput === "object"
        ? (data.rawOutput as Record<string, unknown>)
        : undefined;

    expect(activity?.kind).toBe("tool.completed");
    expect(activity?.summary).toBe("Read file");
    expect(payload?.itemType).toBe("dynamic_tool_call");
    expect(payload?.detail).toBeUndefined();
    expect(data?.toolCallId).toBe("tool-read-1");
    expect(data?.kind).toBe("read");
    expect(rawOutput?.content).toBe('import * as Effect from "effect/Effect"\n');
  });

  it("normalizes command execution activities to ran-command summaries", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-command-completed"),
      provider: ProviderDriverKind.make("cursor"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-command-completed"),
      itemId: asItemId("item-command-completed"),
      payload: {
        itemType: "command_execution",
        status: "completed",
        title: "Ran command",
        detail: "bun run lint",
        data: {
          toolCallId: "tool-command-1",
          kind: "execute",
          command: "bun run lint",
        },
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.id === "evt-command-completed",
      ),
    );
    const activity = thread.activities.find(
      (entry: ProviderRuntimeTestActivity) => entry.id === "evt-command-completed",
    );
    const payload =
      activity?.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : undefined;

    expect(activity?.summary).toBe("Ran command");
    expect(payload?.detail).toBe("bun run lint");
  });

  it("uses structured read-file paths when available", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-read-path-completed"),
      provider: ProviderDriverKind.make("cursor"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-read-path"),
      itemId: asItemId("item-read-path"),
      payload: {
        itemType: "dynamic_tool_call",
        status: "completed",
        title: "Read file",
        detail: "/tmp/app.ts",
        data: {
          toolCallId: "tool-read-path-1",
          kind: "read",
          locations: [{ path: "/tmp/app.ts" }],
        },
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.id === "evt-read-path-completed",
      ),
    );
    const activity = thread.activities.find(
      (entry: ProviderRuntimeTestActivity) => entry.id === "evt-read-path-completed",
    );
    const payload =
      activity?.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : undefined;

    expect(activity?.summary).toBe("Read file");
    expect(payload?.detail).toBe("/tmp/app.ts");
  });

  it("projects completed plan items into first-class proposed plans", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "turn.proposed.completed",
      eventId: asEventId("evt-plan-item-completed"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-plan-final"),
      payload: {
        planMarkdown: "## Ship plan\n\n- wire projection\n- render follow-up",
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.proposedPlans.some(
        (proposedPlan: ProviderRuntimeTestProposedPlan) =>
          proposedPlan.id === "plan:thread-1:turn:turn-plan-final",
      ),
    );
    const proposedPlan = thread.proposedPlans.find(
      (entry: ProviderRuntimeTestProposedPlan) => entry.id === "plan:thread-1:turn:turn-plan-final",
    );
    expect(proposedPlan?.planMarkdown).toBe(
      "## Ship plan\n\n- wire projection\n- render follow-up",
    );
  });

  it("marks the source proposed plan implemented only after the target turn starts", async () => {
    const harness = await createHarness();
    const sourceThreadId = asThreadId("thread-plan");
    const targetThreadId = asThreadId("thread-implement");
    const sourceTurnId = asTurnId("turn-plan-source");
    const targetTurnId = asTurnId("turn-plan-implement");
    const createdAt = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-create-plan-source"),
        threadId: sourceThreadId,
        projectId: asProjectId("project-1"),
        ownerUserId: DEFAULT_WORKSPACE_USER_ID,
        title: "Plan Source",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: "plan",
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-plan-source"),
        threadId: sourceThreadId,
        session: {
          threadId: sourceThreadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          updatedAt: createdAt,
          lastError: null,
        },
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-create-plan-target"),
        threadId: targetThreadId,
        projectId: asProjectId("project-1"),
        ownerUserId: DEFAULT_WORKSPACE_USER_ID,
        title: "Plan Target",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-plan-target"),
        threadId: targetThreadId,
        session: {
          threadId: targetThreadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          updatedAt: createdAt,
          lastError: null,
        },
        createdAt,
      }),
    );
    harness.setProviderSession({
      provider: ProviderDriverKind.make("codex"),
      status: "ready",
      runtimeMode: "approval-required",
      threadId: targetThreadId,
      createdAt,
      updatedAt: createdAt,
      activeTurnId: targetTurnId,
    });

    harness.emit({
      type: "turn.proposed.completed",
      eventId: asEventId("evt-plan-source-completed"),
      provider: ProviderDriverKind.make("codex"),
      createdAt,
      threadId: sourceThreadId,
      turnId: sourceTurnId,
      payload: {
        planMarkdown: "# Source plan",
      },
    });

    const sourceThreadWithPlan = await waitForThread(
      harness.readModel,
      (thread) =>
        thread.proposedPlans.some(
          (proposedPlan: ProviderRuntimeTestProposedPlan) =>
            proposedPlan.id === "plan:thread-plan:turn:turn-plan-source" &&
            proposedPlan.implementedAt === null,
        ),
      2_000,
      sourceThreadId,
    );
    const sourcePlan = sourceThreadWithPlan.proposedPlans.find(
      (entry: ProviderRuntimeTestProposedPlan) =>
        entry.id === "plan:thread-plan:turn:turn-plan-source",
    );
    expect(sourcePlan).toBeDefined();
    if (!sourcePlan) {
      throw new Error("Expected source plan to exist.");
    }

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-plan-target"),
        threadId: targetThreadId,
        message: {
          messageId: asMessageId("msg-plan-target"),
          role: "user",
          text: "PLEASE IMPLEMENT THIS PLAN:\n# Source plan",
          attachments: [],
        },
        sourceProposedPlan: {
          threadId: sourceThreadId,
          planId: sourcePlan.id,
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    const sourceThreadBeforeStart = await waitForThread(
      harness.readModel,
      (thread) =>
        thread.proposedPlans.some(
          (proposedPlan: ProviderRuntimeTestProposedPlan) =>
            proposedPlan.id === sourcePlan.id && proposedPlan.implementedAt === null,
        ),
      2_000,
      sourceThreadId,
    );
    expect(
      sourceThreadBeforeStart.proposedPlans.find((entry) => entry.id === sourcePlan.id),
    ).toMatchObject({
      implementedAt: null,
      implementationThreadId: null,
    });

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-plan-target-started"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: targetThreadId,
      turnId: targetTurnId,
    });

    const sourceThreadAfterStart = await waitForThread(
      harness.readModel,
      (thread) =>
        thread.proposedPlans.some(
          (proposedPlan: ProviderRuntimeTestProposedPlan) =>
            proposedPlan.id === sourcePlan.id &&
            proposedPlan.implementedAt !== null &&
            proposedPlan.implementationThreadId === targetThreadId,
        ),
      2_000,
      sourceThreadId,
    );
    expect(
      sourceThreadAfterStart.proposedPlans.find((entry) => entry.id === sourcePlan.id),
    ).toMatchObject({
      implementationThreadId: "thread-implement",
    });
  });

  it("does not mark the source proposed plan implemented for a rejected turn.started event", async () => {
    const harness = await createHarness();
    const sourceThreadId = asThreadId("thread-plan");
    const targetThreadId = asThreadId("thread-1");
    const sourceTurnId = asTurnId("turn-plan-source");
    const activeTurnId = asTurnId("turn-already-running");
    const staleTurnId = asTurnId("turn-stale-start");
    const createdAt = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      Effect.andThen(
        harness.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-thread-create-plan-source-guarded"),
          threadId: sourceThreadId,
          projectId: asProjectId("project-1"),
          ownerUserId: DEFAULT_WORKSPACE_USER_ID,
          title: "Plan Source",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: "plan",
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt,
        }),
        harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("cmd-session-set-plan-source-guarded"),
          threadId: sourceThreadId,
          session: {
            threadId: sourceThreadId,
            status: "ready",
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: null,
            updatedAt: createdAt,
            lastError: null,
          },
          createdAt,
        }),
      ),
    );
    harness.setProviderSession({
      provider: ProviderDriverKind.make("codex"),
      status: "running",
      runtimeMode: "approval-required",
      threadId: targetThreadId,
      createdAt,
      updatedAt: createdAt,
      activeTurnId,
    });

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-already-running"),
      provider: ProviderDriverKind.make("codex"),
      createdAt,
      threadId: targetThreadId,
      turnId: activeTurnId,
    });

    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === "running" && thread.session?.activeTurnId === activeTurnId,
      2_000,
      targetThreadId,
    );

    harness.emit({
      type: "turn.proposed.completed",
      eventId: asEventId("evt-plan-source-completed-guarded"),
      provider: ProviderDriverKind.make("codex"),
      createdAt,
      threadId: sourceThreadId,
      turnId: sourceTurnId,
      payload: {
        planMarkdown: "# Source plan",
      },
    });

    const sourceThreadWithPlan = await waitForThread(
      harness.readModel,
      (thread) =>
        thread.proposedPlans.some(
          (proposedPlan: ProviderRuntimeTestProposedPlan) =>
            proposedPlan.id === "plan:thread-plan:turn:turn-plan-source" &&
            proposedPlan.implementedAt === null,
        ),
      2_000,
      sourceThreadId,
    );
    const sourcePlan = sourceThreadWithPlan.proposedPlans.find(
      (entry: ProviderRuntimeTestProposedPlan) =>
        entry.id === "plan:thread-plan:turn:turn-plan-source",
    );
    expect(sourcePlan).toBeDefined();
    if (!sourcePlan) {
      throw new Error("Expected source plan to exist.");
    }

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-plan-target-guarded"),
        threadId: targetThreadId,
        message: {
          messageId: asMessageId("msg-plan-target-guarded"),
          role: "user",
          text: "PLEASE IMPLEMENT THIS PLAN:\n# Source plan",
          attachments: [],
        },
        sourceProposedPlan: {
          threadId: sourceThreadId,
          planId: sourcePlan.id,
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-stale-plan-implementation"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: targetThreadId,
      turnId: staleTurnId,
    });

    await harness.drain();

    const readModel = await harness.readModel();
    const sourceThreadAfterRejectedStart = readModel.threads.find(
      (entry) => entry.id === sourceThreadId,
    );
    expect(
      sourceThreadAfterRejectedStart?.proposedPlans.find((entry) => entry.id === sourcePlan.id),
    ).toMatchObject({
      implementedAt: null,
      implementationThreadId: null,
    });

    const targetThreadAfterRejectedStart = readModel.threads.find(
      (entry) => entry.id === targetThreadId,
    );
    expect(targetThreadAfterRejectedStart?.session?.status).toBe("running");
    expect(targetThreadAfterRejectedStart?.session?.activeTurnId).toBe(activeTurnId);
  });

  it("accepts a conflicting turn.started for a pending turn start when the provider expects that turn", async () => {
    // Steering a running turn: the server requests a new turn while the old
    // one is still active, and providers like opencode open the new turn
    // without ever completing the superseded one. The new turn.started must
    // replace the active turn instead of being rejected as stale.
    const harness = await createHarness();
    const threadId = asThreadId("thread-1");
    const oldTurnId = asTurnId("turn-steered-over");
    const newTurnId = asTurnId("turn-from-steer");
    const createdAt = "2026-01-01T00:00:00.000Z";

    harness.setProviderSession({
      provider: ProviderDriverKind.make("codex"),
      status: "running",
      runtimeMode: "approval-required",
      threadId,
      createdAt,
      updatedAt: createdAt,
      activeTurnId: oldTurnId,
    });
    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-steered-over"),
      provider: ProviderDriverKind.make("codex"),
      createdAt,
      threadId,
      turnId: oldTurnId,
    });
    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === "running" && thread.session?.activeTurnId === oldTurnId,
      2_000,
      threadId,
    );

    // The steer: a user-requested turn start while the old turn still runs.
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-steer"),
        threadId,
        message: {
          messageId: asMessageId("msg-steer"),
          role: "user",
          text: "actually, do 15 instead",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt,
      }),
    );

    // The provider session tracks the new turn before emitting turn.started
    // (sendTurn updates the session first).
    harness.setProviderSession({
      provider: ProviderDriverKind.make("codex"),
      status: "running",
      runtimeMode: "approval-required",
      threadId,
      createdAt,
      updatedAt: createdAt,
      activeTurnId: newTurnId,
    });
    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-from-steer"),
      provider: ProviderDriverKind.make("codex"),
      createdAt,
      threadId,
      turnId: newTurnId,
    });

    const threadAfterSteer = await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === "running" && thread.session?.activeTurnId === newTurnId,
      2_000,
      threadId,
    );
    expect(threadAfterSteer.session?.activeTurnId).toBe(newTurnId);
    expect(threadAfterSteer.latestTurn?.turnId).toBe(newTurnId);
    expect(threadAfterSteer.latestTurn?.state).toBe("running");
  });

  it("does not mark the source proposed plan implemented for an unrelated turn.started when no thread active turn is tracked", async () => {
    const harness = await createHarness();
    const sourceThreadId = asThreadId("thread-plan");
    const targetThreadId = asThreadId("thread-implement");
    const sourceTurnId = asTurnId("turn-plan-source");
    const expectedTurnId = asTurnId("turn-plan-implement");
    const replayedTurnId = asTurnId("turn-replayed");
    const createdAt = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-create-plan-source-unrelated"),
        threadId: sourceThreadId,
        projectId: asProjectId("project-1"),
        ownerUserId: DEFAULT_WORKSPACE_USER_ID,
        title: "Plan Source",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: "plan",
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-plan-source-unrelated"),
        threadId: sourceThreadId,
        session: {
          threadId: sourceThreadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          updatedAt: createdAt,
          lastError: null,
        },
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-create-plan-target-unrelated"),
        threadId: targetThreadId,
        projectId: asProjectId("project-1"),
        ownerUserId: DEFAULT_WORKSPACE_USER_ID,
        title: "Plan Target",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-plan-target-unrelated"),
        threadId: targetThreadId,
        session: {
          threadId: targetThreadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          updatedAt: createdAt,
          lastError: null,
        },
        createdAt,
      }),
    );

    harness.emit({
      type: "turn.proposed.completed",
      eventId: asEventId("evt-plan-source-completed-unrelated"),
      provider: ProviderDriverKind.make("codex"),
      createdAt,
      threadId: sourceThreadId,
      turnId: sourceTurnId,
      payload: {
        planMarkdown: "# Source plan",
      },
    });

    const sourceThreadWithPlan = await waitForThread(
      harness.readModel,
      (thread) =>
        thread.proposedPlans.some(
          (proposedPlan: ProviderRuntimeTestProposedPlan) =>
            proposedPlan.id === "plan:thread-plan:turn:turn-plan-source" &&
            proposedPlan.implementedAt === null,
        ),
      2_000,
      sourceThreadId,
    );
    const sourcePlan = sourceThreadWithPlan.proposedPlans.find(
      (entry: ProviderRuntimeTestProposedPlan) =>
        entry.id === "plan:thread-plan:turn:turn-plan-source",
    );
    expect(sourcePlan).toBeDefined();
    if (!sourcePlan) {
      throw new Error("Expected source plan to exist.");
    }

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-plan-target-unrelated"),
        threadId: targetThreadId,
        message: {
          messageId: asMessageId("msg-plan-target-unrelated"),
          role: "user",
          text: "PLEASE IMPLEMENT THIS PLAN:\n# Source plan",
          attachments: [],
        },
        sourceProposedPlan: {
          threadId: sourceThreadId,
          planId: sourcePlan.id,
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    harness.setProviderSession({
      provider: ProviderDriverKind.make("codex"),
      status: "running",
      runtimeMode: "approval-required",
      threadId: targetThreadId,
      createdAt,
      updatedAt: createdAt,
      activeTurnId: expectedTurnId,
    });

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-unrelated-plan-implementation"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: targetThreadId,
      turnId: replayedTurnId,
    });

    await harness.drain();

    const readModel = await harness.readModel();
    const sourceThreadAfterUnrelatedStart = readModel.threads.find(
      (entry) => entry.id === sourceThreadId,
    );
    expect(
      sourceThreadAfterUnrelatedStart?.proposedPlans.find((entry) => entry.id === sourcePlan.id),
    ).toMatchObject({
      implementedAt: null,
      implementationThreadId: null,
    });
  });

  it("finalizes buffered proposed-plan deltas into a first-class proposed plan on turn completion", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-plan-buffer"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-plan-buffer"),
    });

    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === "running" && thread.session?.activeTurnId === "turn-plan-buffer",
    );

    harness.emit({
      type: "turn.proposed.delta",
      eventId: asEventId("evt-plan-delta-1"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-plan-buffer"),
      payload: {
        delta: "## Buffered plan\n\n- first",
      },
    });
    harness.emit({
      type: "turn.proposed.delta",
      eventId: asEventId("evt-plan-delta-2"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-plan-buffer"),
      payload: {
        delta: "\n- second",
      },
    });
    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-plan-buffer"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-plan-buffer"),
      payload: {
        state: "completed",
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.proposedPlans.some(
        (proposedPlan: ProviderRuntimeTestProposedPlan) =>
          proposedPlan.id === "plan:thread-1:turn:turn-plan-buffer",
      ),
    );
    const proposedPlan = thread.proposedPlans.find(
      (entry: ProviderRuntimeTestProposedPlan) =>
        entry.id === "plan:thread-1:turn:turn-plan-buffer",
    );
    expect(proposedPlan?.planMarkdown).toBe("## Buffered plan\n\n- first\n- second");
  });

  it("buffers assistant deltas by default until completion", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-buffered"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered"),
    });
    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === "running" && thread.session?.activeTurnId === "turn-buffered",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-buffered"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered"),
      itemId: asItemId("item-buffered"),
      payload: {
        streamKind: "assistant_text",
        delta: "buffer me",
      },
    });

    await harness.drain();
    const midReadModel = await harness.readModel();
    const midThread = midReadModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(
      midThread?.messages.some(
        (message: ProviderRuntimeTestMessage) => message.id === "assistant:item-buffered",
      ),
    ).toBe(false);

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-message-completed-buffered"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered"),
      itemId: asItemId("item-buffered"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-buffered" && !message.streaming,
      ),
    );
    const message = thread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-buffered",
    );
    expect(message?.text).toBe("buffer me");
    expect(message?.streaming).toBe(false);
  });

  it("flushes and completes buffered assistant text when an approval request opens", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-buffered-request-flush"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered-request-flush"),
    });
    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-buffered-request-flush",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-buffered-request-flush"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered-request-flush"),
      itemId: asItemId("item-buffered-request-flush"),
      payload: {
        streamKind: "assistant_text",
        delta: "visible before approval",
      },
    });
    harness.emit({
      type: "request.opened",
      eventId: asEventId("evt-request-opened-buffered-request-flush"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered-request-flush"),
      requestId: ApprovalRequestId.make("req-buffered-request-flush"),
      payload: {
        requestType: "command_execution_approval",
        detail: "pwd",
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-buffered-request-flush" &&
          !message.streaming &&
          message.text === "visible before approval",
      ),
    );
    const message = thread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-buffered-request-flush",
    );
    expect(message?.streaming).toBe(false);
  });

  it("flushes and completes buffered assistant text when user input is requested", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-buffered-user-input-flush"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered-user-input-flush"),
    });
    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-buffered-user-input-flush",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-buffered-user-input-flush"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered-user-input-flush"),
      itemId: asItemId("item-buffered-user-input-flush"),
      payload: {
        streamKind: "assistant_text",
        delta: "visible before user input",
      },
    });
    harness.emit({
      type: "user-input.requested",
      eventId: asEventId("evt-user-input-requested-buffered-user-input-flush"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered-user-input-flush"),
      requestId: ApprovalRequestId.make("req-buffered-user-input-flush"),
      payload: {
        questions: [
          {
            id: "choice",
            header: "Choice",
            question: "Pick one",
            options: [{ label: "A", description: "Option A" }],
          },
        ],
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-buffered-user-input-flush" &&
          !message.streaming &&
          message.text === "visible before user input",
      ),
    );
    const message = thread.messages.find(
      (entry: ProviderRuntimeTestMessage) =>
        entry.id === "assistant:item-buffered-user-input-flush",
    );
    expect(message?.streaming).toBe(false);
  });

  it("does not create assistant segments for whitespace-only buffered text at approval boundaries", async () => {
    const harness = await createHarness();
    const startedAt = "2026-03-28T06:28:00.000Z";
    const pausedAt = "2026-03-28T06:28:01.000Z";

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-buffered-whitespace-request"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: startedAt,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered-whitespace-request"),
    });
    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-buffered-whitespace-request",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-buffered-whitespace-request"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: startedAt,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered-whitespace-request"),
      itemId: asItemId("item-buffered-whitespace-request"),
      payload: {
        streamKind: "assistant_text",
        delta: "\n\n\n",
      },
    });
    harness.emit({
      type: "request.opened",
      eventId: asEventId("evt-request-opened-buffered-whitespace-request"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: pausedAt,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered-whitespace-request"),
      requestId: ApprovalRequestId.make("req-buffered-whitespace-request"),
      payload: {
        requestType: "command_execution_approval",
        detail: "pwd",
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.kind === "approval.requested",
      ),
    );
    expect(
      thread.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-buffered-whitespace-request",
      ),
    ).toBe(false);
  });

  it("starts a new buffered assistant message segment after approval and completes without duplication", async () => {
    const harness = await createHarness();
    const startedAt = "2026-03-28T06:07:00.000Z";
    const pausedAt = "2026-03-28T06:07:01.000Z";
    const resumedAt = "2026-03-28T06:07:02.000Z";
    const completedAt = "2026-03-28T06:07:03.000Z";

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-buffered-request-append"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: startedAt,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered-request-append"),
    });
    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-buffered-request-append",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-buffered-request-append-initial"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: startedAt,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered-request-append"),
      itemId: asItemId("item-buffered-request-append"),
      payload: {
        streamKind: "assistant_text",
        delta: "first half",
      },
    });
    harness.emit({
      type: "request.opened",
      eventId: asEventId("evt-request-opened-buffered-request-append"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: pausedAt,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered-request-append"),
      requestId: ApprovalRequestId.make("req-buffered-request-append"),
      payload: {
        requestType: "command_execution_approval",
        detail: "pwd",
      },
    });

    await waitForThread(harness.readModel, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-buffered-request-append" &&
          !message.streaming &&
          message.text === "first half",
      ),
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-buffered-request-append-followup"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: resumedAt,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered-request-append"),
      itemId: asItemId("item-buffered-request-append"),
      payload: {
        streamKind: "assistant_text",
        delta: " second half",
      },
    });
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-message-completed-buffered-request-append"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: completedAt,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered-request-append"),
      itemId: asItemId("item-buffered-request-append"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-buffered-request-append:segment:1" &&
          !message.streaming &&
          message.text === " second half",
      ),
    );
    const firstMessage = thread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-buffered-request-append",
    );
    const resumedMessage = thread.messages.find(
      (entry: ProviderRuntimeTestMessage) =>
        entry.id === "assistant:item-buffered-request-append:segment:1",
    );
    expect(firstMessage?.text).toBe("first half");
    expect(firstMessage?.streaming).toBe(false);
    expect(resumedMessage?.text).toBe(" second half");
    expect(resumedMessage?.streaming).toBe(false);

    const events = await runtime!.runPromise(
      Stream.runCollect(harness.engine.readEvents(0)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      ),
    );
    const assistantEvents = events.filter(
      (event): event is Extract<(typeof events)[number], { type: "thread.message-sent" }> =>
        event.type === "thread.message-sent" &&
        event.payload.messageId.startsWith("assistant:item-buffered-request-append"),
    );
    expect(assistantEvents).toHaveLength(4);
    expect(assistantEvents[0]?.payload.streaming).toBe(true);
    expect(assistantEvents[0]?.payload.text).toBe("first half");
    expect(assistantEvents[1]?.payload.streaming).toBe(false);
    expect(assistantEvents[1]?.payload.text).toBe("");
    expect(assistantEvents[2]?.payload.messageId).toBe(
      "assistant:item-buffered-request-append:segment:1",
    );
    expect(assistantEvents[2]?.payload.streaming).toBe(true);
    expect(assistantEvents[2]?.payload.text).toBe(" second half");
    expect(assistantEvents[3]?.payload.messageId).toBe(
      "assistant:item-buffered-request-append:segment:1",
    );
    expect(assistantEvents[3]?.payload.streaming).toBe(false);
    expect(assistantEvents[3]?.payload.text).toBe("");
  });

  it("starts a new streaming assistant message segment after approval", async () => {
    const harness = await createHarness({ serverSettings: { enableLegacyTokenStreaming: true } });
    const startedAt = "2026-03-28T07:00:00.000Z";
    const pausedAt = "2026-03-28T07:00:01.000Z";
    const resumedAt = "2026-03-28T07:00:02.000Z";
    const completedAt = "2026-03-28T07:00:03.000Z";

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-streaming-request-segment"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: startedAt,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-streaming-request-segment"),
    });
    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-streaming-request-segment",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-streaming-request-segment-initial"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: startedAt,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-streaming-request-segment"),
      itemId: asItemId("item-streaming-request-segment"),
      payload: {
        streamKind: "assistant_text",
        delta: "before approval",
      },
    });
    harness.emit({
      type: "request.opened",
      eventId: asEventId("evt-request-opened-streaming-request-segment"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: pausedAt,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-streaming-request-segment"),
      requestId: ApprovalRequestId.make("req-streaming-request-segment"),
      payload: {
        requestType: "command_execution_approval",
        detail: "pwd",
      },
    });

    await waitForThread(harness.readModel, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-streaming-request-segment" &&
          !message.streaming &&
          message.text === "before approval",
      ),
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-streaming-request-segment-followup"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: resumedAt,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-streaming-request-segment"),
      itemId: asItemId("item-streaming-request-segment"),
      payload: {
        streamKind: "assistant_text",
        delta: " after approval",
      },
    });
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-message-completed-streaming-request-segment"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: completedAt,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-streaming-request-segment"),
      itemId: asItemId("item-streaming-request-segment"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-streaming-request-segment:segment:1" &&
          !message.streaming &&
          message.text === " after approval",
      ),
    );
    expect(
      thread.messages.find(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-streaming-request-segment",
      )?.text,
    ).toBe("before approval");
    expect(
      thread.messages.find(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-streaming-request-segment:segment:1",
      )?.text,
    ).toBe(" after approval");
  });

  it("streams assistant deltas when thread.turn.start requests streaming mode", async () => {
    const harness = await createHarness({ serverSettings: { enableLegacyTokenStreaming: true } });
    const now = "2026-01-01T00:00:00.000Z";

    await runtime!.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-streaming-mode"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("message-streaming-mode"),
          role: "user",
          text: "stream please",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await harness.drain();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-streaming-mode"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-streaming-mode"),
    });
    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-streaming-mode",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-streaming-mode"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-streaming-mode"),
      itemId: asItemId("item-streaming-mode"),
      payload: {
        streamKind: "assistant_text",
        delta: "hello live",
      },
    });

    const liveThread = await waitForThread(harness.readModel, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-streaming-mode" &&
          message.streaming &&
          message.text === "hello live",
      ),
    );
    const liveMessage = liveThread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-streaming-mode",
    );
    expect(liveMessage?.streaming).toBe(true);

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-message-completed-streaming-mode"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-streaming-mode"),
      itemId: asItemId("item-streaming-mode"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
        detail: "hello live",
      },
    });

    const finalThread = await waitForThread(harness.readModel, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-streaming-mode" && !message.streaming,
      ),
    );
    const finalMessage = finalThread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-streaming-mode",
    );
    expect(finalMessage?.text).toBe("hello live");
    expect(finalMessage?.streaming).toBe(false);
  });

  it("spills oversized buffered deltas and still finalizes full assistant text", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    const oversizedText = "x".repeat(40_000);

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-buffer-spill"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffer-spill"),
    });
    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-buffer-spill",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-buffer-spill"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffer-spill"),
      itemId: asItemId("item-buffer-spill"),
      payload: {
        streamKind: "assistant_text",
        delta: oversizedText,
      },
    });
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-message-completed-buffer-spill"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffer-spill"),
      itemId: asItemId("item-buffer-spill"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-buffer-spill" && !message.streaming,
      ),
    );
    const message = thread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-buffer-spill",
    );
    expect(message?.text.length).toBe(oversizedText.length);
    expect(message?.text).toBe(oversizedText);
    expect(message?.streaming).toBe(false);
  });

  it("does not duplicate assistant completion when item.completed is followed by turn.completed", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-for-complete-dedup"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-complete-dedup"),
    });

    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-complete-dedup",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-for-complete-dedup"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-complete-dedup"),
      itemId: asItemId("item-complete-dedup"),
      payload: {
        streamKind: "assistant_text",
        delta: "done",
      },
    });
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-message-completed-for-complete-dedup"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-complete-dedup"),
      itemId: asItemId("item-complete-dedup"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
      },
    });
    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-for-complete-dedup"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-complete-dedup"),
      payload: {
        state: "completed",
      },
    });

    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === "ready" &&
        thread.session?.activeTurnId === null &&
        thread.messages.some(
          (message: ProviderRuntimeTestMessage) =>
            message.id === "assistant:item-complete-dedup" && !message.streaming,
        ),
    );

    const events = await runtime!.runPromise(
      Stream.runCollect(harness.engine.readEvents(0)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      ),
    );
    const completionEvents = events.filter((event) => {
      if (event.type !== "thread.message-sent") {
        return false;
      }
      return (
        event.payload.messageId === "assistant:item-complete-dedup" &&
        event.payload.streaming === false
      );
    });
    expect(completionEvents).toHaveLength(1);
  });

  it("maps canonical request events into approval activities with requestKind", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "request.opened",
      eventId: asEventId("evt-request-opened"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      requestId: ApprovalRequestId.make("req-open"),
      payload: {
        requestType: "command_execution_approval",
        detail: "pwd",
      },
    });

    harness.emit({
      type: "request.resolved",
      eventId: asEventId("evt-request-resolved"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      requestId: ApprovalRequestId.make("req-open"),
      payload: {
        requestType: "command_execution_approval",
        decision: "accept",
      },
    });

    await waitForThread(
      harness.readModel,
      (entry) =>
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "approval.requested",
        ) &&
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "approval.resolved",
        ),
    );

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread).toBeDefined();

    const requested = thread?.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-request-opened",
    );
    const requestedPayload =
      requested?.payload && typeof requested.payload === "object"
        ? (requested.payload as Record<string, unknown>)
        : undefined;
    expect(requestedPayload?.requestKind).toBe("command");
    expect(requestedPayload?.requestType).toBe("command_execution_approval");

    const resolved = thread?.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-request-resolved",
    );
    const resolvedPayload =
      resolved?.payload && typeof resolved.payload === "object"
        ? (resolved.payload as Record<string, unknown>)
        : undefined;
    expect(resolvedPayload?.requestKind).toBe("command");
    expect(resolvedPayload?.requestType).toBe("command_execution_approval");
  });

  it("maps runtime.error into errored session state", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "runtime.error",
      eventId: asEventId("evt-runtime-error"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-3"),
      payload: {
        message: "runtime exploded",
      },
    });

    const thread = await waitForThread(
      harness.readModel,
      (entry) =>
        entry.session?.status === "error" &&
        entry.session?.activeTurnId === "turn-3" &&
        entry.session?.lastError === "runtime exploded",
    );
    expect(thread.session?.status).toBe("error");
    expect(thread.session?.lastError).toBe("runtime exploded");
  });

  it("records runtime.error activities from the typed payload message", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "runtime.error",
      eventId: asEventId("evt-runtime-error-activity"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-runtime-error-activity"),
      payload: {
        message: "runtime activity exploded",
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.activities.some((activity) => activity.id === "evt-runtime-error-activity"),
    );
    const activity = thread.activities.find(
      (entry: ProviderRuntimeTestActivity) => entry.id === "evt-runtime-error-activity",
    );
    const activityPayload =
      activity?.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : undefined;

    expect(activity?.kind).toBe("runtime.error");
    expect(activityPayload?.message).toBe("runtime activity exploded");
  });

  it("keeps the session running when a runtime.warning arrives during an active turn", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-warning-turn-started"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-warning"),
      payload: {},
    });

    harness.emit({
      type: "runtime.warning",
      eventId: asEventId("evt-warning-runtime"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-warning"),
      payload: {
        message: "Reconnecting... 2/5",
        detail: {
          willRetry: true,
        },
      },
    });

    const thread = await waitForThread(
      harness.readModel,
      (entry) =>
        entry.session?.status === "running" &&
        entry.session?.activeTurnId === "turn-warning" &&
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) =>
            activity.id === "evt-warning-runtime" && activity.kind === "runtime.warning",
        ),
    );
    expect(thread.session?.status).toBe("running");
    expect(thread.session?.activeTurnId).toBe("turn-warning");
    expect(thread.session?.lastError).toBeNull();
  });

  it("maps session/thread lifecycle and item.started into session/activity projections", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "session.started",
      eventId: asEventId("evt-session-started"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      message: "session started",
    });
    harness.emit({
      type: "thread.started",
      eventId: asEventId("evt-thread-started"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
    });
    harness.emit({
      type: "item.started",
      eventId: asEventId("evt-tool-started"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-9"),
      itemId: asItemId("tool-call-9"),
      payload: {
        itemType: "command_execution",
        status: "inProgress",
        title: "Command run",
        detail: "Bash: vp test run",
        data: {
          toolName: "Bash",
          input: { command: "vp test run" },
        },
      },
    });

    const thread = await waitForThread(
      harness.readModel,
      (entry) =>
        entry.session?.status === "ready" &&
        entry.session?.activeTurnId === null &&
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "tool.started",
        ),
    );

    expect(thread.session?.status).toBe("ready");
    const activity = thread.activities.find(
      (entry: ProviderRuntimeTestActivity) => entry.kind === "tool.started",
    );
    const payload = activity?.payload as Record<string, unknown> | undefined;
    expect(payload).toMatchObject({
      itemType: "command_execution",
      toolCallId: "tool-call-9",
      status: "inProgress",
      detail: "Bash: vp test run",
      data: {
        toolName: "Bash",
        input: { command: "vp test run" },
      },
    });
  });

  it("consumes P1 runtime events into thread metadata, diff checkpoints, and activities", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "thread.metadata.updated",
      eventId: asEventId("evt-thread-metadata-updated"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      payload: {
        name: "Renamed by provider",
        metadata: { source: "provider" },
      },
    });

    harness.emit({
      type: "turn.plan.updated",
      eventId: asEventId("evt-turn-plan-updated"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-p1"),
      payload: {
        explanation: "Working through the plan",
        plan: [
          { step: "Inspect files", status: "completed" },
          { step: "Apply patch", status: "in_progress" },
        ],
      },
    });

    harness.emit({
      type: "item.updated",
      eventId: asEventId("evt-item-updated"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-p1"),
      itemId: asItemId("item-p1-tool"),
      payload: {
        itemType: "command_execution",
        status: "in_progress",
        title: "Run tests",
        detail: "bun test",
        data: { pid: 123 },
      },
    });

    harness.emit({
      type: "runtime.warning",
      eventId: asEventId("evt-runtime-warning"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-p1"),
      payload: {
        message: "Provider got slow",
        detail: { latencyMs: 1500 },
      },
    });

    harness.emit({
      type: "turn.diff.updated",
      eventId: asEventId("evt-turn-diff-updated"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-p1"),
      itemId: asItemId("item-p1-assistant"),
      payload: {
        unifiedDiff: "diff --git a/file.txt b/file.txt\n+hello\n",
      },
    });

    const thread = await waitForThread(
      harness.readModel,
      (entry) =>
        entry.title === "Thread" &&
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "turn.plan.updated",
        ) &&
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "tool.updated",
        ) &&
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "runtime.warning",
        ) &&
        entry.checkpoints.some(
          (checkpoint: ProviderRuntimeTestCheckpoint) => checkpoint.turnId === "turn-p1",
        ),
    );

    expect(thread.title).toBe("Thread");

    const planActivity = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-turn-plan-updated",
    );
    const planPayload =
      planActivity?.payload && typeof planActivity.payload === "object"
        ? (planActivity.payload as Record<string, unknown>)
        : undefined;
    expect(planActivity?.kind).toBe("turn.plan.updated");
    expect(Array.isArray(planPayload?.plan)).toBe(true);

    const toolUpdate = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-item-updated",
    );
    const toolUpdatePayload =
      toolUpdate?.payload && typeof toolUpdate.payload === "object"
        ? (toolUpdate.payload as Record<string, unknown>)
        : undefined;
    expect(toolUpdate?.kind).toBe("tool.updated");
    expect(toolUpdatePayload?.itemType).toBe("command_execution");
    expect(toolUpdatePayload?.status).toBe("in_progress");
    expect(toolUpdatePayload?.toolCallId).toBe("item-p1-tool");

    const warning = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-runtime-warning",
    );
    const warningPayload =
      warning?.payload && typeof warning.payload === "object"
        ? (warning.payload as Record<string, unknown>)
        : undefined;
    expect(warning?.kind).toBe("runtime.warning");
    expect(warningPayload?.message).toBe("Provider got slow");

    const checkpoint = thread.checkpoints.find(
      (entry: ProviderRuntimeTestCheckpoint) => entry.turnId === "turn-p1",
    );
    expect(checkpoint?.status).toBe("missing");
    expect(checkpoint?.assistantMessageId).toBe("assistant:item-p1-assistant");
    expect(checkpoint?.checkpointRef).toBe("provider-diff:evt-turn-diff-updated");
  });

  it("mirrors a provider title only while the thread still has the default title", async () => {
    const harness = await createHarness({ threadTitle: DEFAULT_THREAD_TITLE });
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "thread.metadata.updated",
      eventId: asEventId("evt-thread-metadata-default"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      payload: {
        name: "Renamed by provider",
        metadata: { source: "provider" },
      },
    });

    const thread = await waitForThread(
      harness.readModel,
      (entry) => entry.title === "Renamed by provider",
    );
    expect(thread.title).toBe("Renamed by provider");
  });

  it("rejects a provider title once the thread has a real title", async () => {
    const harness = await createHarness({ threadTitle: "User-set title" });
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "thread.metadata.updated",
      eventId: asEventId("evt-thread-metadata-real"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      payload: {
        name: "Renamed by provider",
        metadata: { source: "provider" },
      },
    });

    await harness.drain();
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.title).toBe("User-set title");
  });

  it("projects context window updates into normalized thread activities", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "thread.token-usage.updated",
      eventId: asEventId("evt-thread-token-usage-updated"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      payload: {
        usage: {
          usedTokens: 1075,
          totalProcessedTokens: 10_200,
          maxTokens: 128_000,
          inputTokens: 1000,
          cachedInputTokens: 500,
          outputTokens: 50,
          reasoningOutputTokens: 25,
          lastUsedTokens: 1075,
          lastInputTokens: 1000,
          lastCachedInputTokens: 500,
          lastOutputTokens: 50,
          lastReasoningOutputTokens: 25,
          compactsAutomatically: true,
        },
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.kind === "context-window.updated",
      ),
    );

    const usageActivity = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.kind === "context-window.updated",
    );
    expect(usageActivity).toBeDefined();
    expect(usageActivity?.payload).toMatchObject({
      usedTokens: 1075,
      totalProcessedTokens: 10_200,
      maxTokens: 128_000,
      inputTokens: 1000,
      cachedInputTokens: 500,
      outputTokens: 50,
      reasoningOutputTokens: 25,
      lastUsedTokens: 1075,
      compactsAutomatically: true,
    });
  });

  it("projects Codex camelCase token usage payloads into normalized thread activities", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "thread.token-usage.updated",
      eventId: asEventId("evt-thread-token-usage-updated-camel"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      payload: {
        usage: {
          usedTokens: 126,
          totalProcessedTokens: 11_839,
          maxTokens: 258_400,
          inputTokens: 120,
          cachedInputTokens: 0,
          outputTokens: 6,
          reasoningOutputTokens: 0,
          lastUsedTokens: 126,
          lastInputTokens: 120,
          lastCachedInputTokens: 0,
          lastOutputTokens: 6,
          lastReasoningOutputTokens: 0,
          compactsAutomatically: true,
        },
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.kind === "context-window.updated",
      ),
    );

    const usageActivity = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.kind === "context-window.updated",
    );
    expect(usageActivity?.payload).toMatchObject({
      usedTokens: 126,
      totalProcessedTokens: 11_839,
      maxTokens: 258_400,
      inputTokens: 120,
      cachedInputTokens: 0,
      outputTokens: 6,
      reasoningOutputTokens: 0,
      lastUsedTokens: 126,
      lastInputTokens: 120,
      lastOutputTokens: 6,
      compactsAutomatically: true,
    });
  });

  it("projects Claude usage snapshots with context window into normalized thread activities", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "thread.token-usage.updated",
      eventId: asEventId("evt-thread-token-usage-updated-claude-window"),
      provider: ProviderDriverKind.make("claudeAgent"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      payload: {
        usage: {
          usedTokens: 31_251,
          lastUsedTokens: 31_251,
          maxTokens: 200_000,
          toolUses: 25,
          durationMs: 43_567,
        },
      },
      raw: {
        source: "claude.sdk.message",
        method: "claude/result/success",
        payload: {},
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.kind === "context-window.updated",
      ),
    );

    const usageActivity = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.kind === "context-window.updated",
    );
    expect(usageActivity?.payload).toMatchObject({
      usedTokens: 31_251,
      lastUsedTokens: 31_251,
      maxTokens: 200_000,
      toolUses: 25,
      durationMs: 43_567,
    });
  });

  it("projects compacted thread state into context compaction activities", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "thread.state.changed",
      eventId: asEventId("evt-thread-compacted"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-1"),
      payload: {
        state: "compacted",
        detail: { source: "provider" },
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.kind === "context-compaction",
      ),
    );

    const activity = thread.activities.find(
      (candidate: ProviderRuntimeTestActivity) => candidate.kind === "context-compaction",
    );
    expect(activity?.summary).toBe("Context compacted");
    expect(activity?.tone).toBe("info");
  });

  it("projects Codex task lifecycle chunks into thread activities", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "task.started",
      eventId: asEventId("evt-task-started"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-task-1"),
      payload: {
        taskId: "turn-task-1",
        taskType: "plan",
      },
    });

    harness.emit({
      type: "task.progress",
      eventId: asEventId("evt-task-progress"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-task-1"),
      payload: {
        taskId: "turn-task-1",
        description: "Comparing the desktop rollout chunks to the app-server stream.",
        summary: "Code reviewer is validating the desktop rollout chunks.",
      },
    });

    harness.emit({
      type: "task.completed",
      eventId: asEventId("evt-task-completed"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-task-1"),
      payload: {
        taskId: "turn-task-1",
        status: "completed",
        summary: "<proposed_plan>\n# Plan title\n</proposed_plan>",
      },
    });
    harness.emit({
      type: "turn.proposed.completed",
      eventId: asEventId("evt-task-proposed-plan-completed"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-task-1"),
      payload: {
        planMarkdown: "# Plan title",
      },
    });

    const thread = await waitForThread(
      harness.readModel,
      (entry) =>
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "task.completed",
        ) &&
        entry.proposedPlans.some(
          (proposedPlan: ProviderRuntimeTestProposedPlan) =>
            proposedPlan.id === "plan:thread-1:turn:turn-task-1",
        ),
    );

    const started = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-task-started",
    );
    const progress = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) =>
        activity.id === "task-progress:thread-1:turn-task-1",
    );
    const completed = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-task-completed",
    );

    const progressPayload =
      progress?.payload && typeof progress.payload === "object"
        ? (progress.payload as Record<string, unknown>)
        : undefined;
    const completedPayload =
      completed?.payload && typeof completed.payload === "object"
        ? (completed.payload as Record<string, unknown>)
        : undefined;

    expect(started?.kind).toBe("task.started");
    expect(started?.summary).toBe("Plan task started");
    expect(progress?.kind).toBe("task.progress");
    expect(progressPayload?.detail).toBe("Code reviewer is validating the desktop rollout chunks.");
    expect(progressPayload?.summary).toBe(
      "Code reviewer is validating the desktop rollout chunks.",
    );
    expect(completed?.kind).toBe("task.completed");
    expect(completedPayload?.detail).toBe("<proposed_plan>\n# Plan title\n</proposed_plan>");
    expect(
      thread.proposedPlans.find(
        (entry: ProviderRuntimeTestProposedPlan) => entry.id === "plan:thread-1:turn:turn-task-1",
      )?.planMarkdown,
    ).toBe("# Plan title");
  });

  it("titles task activities with the task description, including on completion", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "task.started",
      eventId: asEventId("evt-named-task-started"),
      provider: ProviderDriverKind.make("claudeAgent"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-named-task"),
      payload: {
        taskId: "named-task-1",
        description: "Typecheck mobile app",
        taskType: "local_bash",
      },
    });

    harness.emit({
      type: "task.progress",
      eventId: asEventId("evt-named-task-progress"),
      provider: ProviderDriverKind.make("claudeAgent"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-named-task"),
      payload: {
        taskId: "named-task-1",
        description: "Typecheck mobile app",
        summary: "Running tsc across the mobile workspace.",
      },
    });

    harness.emit({
      type: "task.completed",
      eventId: asEventId("evt-named-task-completed"),
      provider: ProviderDriverKind.make("claudeAgent"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-named-task"),
      payload: {
        taskId: "named-task-1",
        status: "completed",
        summary: "Typecheck finished without errors.",
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.id === "evt-named-task-completed",
      ),
    );

    const progress = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) =>
        activity.id === "task-progress:thread-1:named-task-1",
    );
    const completed = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-named-task-completed",
    );

    const progressPayload =
      progress?.payload && typeof progress.payload === "object"
        ? (progress.payload as Record<string, unknown>)
        : undefined;
    const completedPayload =
      completed?.payload && typeof completed.payload === "object"
        ? (completed.payload as Record<string, unknown>)
        : undefined;

    expect(progress?.summary).toBe("Typecheck mobile app");
    expect(progressPayload?.title).toBe("Typecheck mobile app");
    expect(completed?.summary).toBe("Task completed");
    expect(completedPayload?.title).toBe("Typecheck mobile app");
    expect(completedPayload?.summary).toBe("Typecheck finished without errors.");
    expect(completedPayload?.detail).toBe("Typecheck finished without errors.");
  });

  it("titles task completion from task.started when no progress event carried the name", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "task.started",
      eventId: asEventId("evt-fast-task-started"),
      provider: ProviderDriverKind.make("claudeAgent"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-fast-task"),
      payload: {
        taskId: "fast-task-1",
        description: "wait for codex review to finish",
        taskType: "local_bash",
      },
    });

    harness.emit({
      type: "task.completed",
      eventId: asEventId("evt-fast-task-completed"),
      provider: ProviderDriverKind.make("claudeAgent"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-fast-task"),
      payload: {
        taskId: "fast-task-1",
        status: "completed",
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.id === "evt-fast-task-completed",
      ),
    );

    const completed = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-fast-task-completed",
    );
    const completedPayload =
      completed?.payload && typeof completed.payload === "object"
        ? (completed.payload as Record<string, unknown>)
        : undefined;

    expect(completedPayload?.title).toBe("wait for codex review to finish");
  });

  it("titles task completion from persisted activities after the description cache is swept", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "task.progress",
      eventId: asEventId("evt-swept-task-progress"),
      provider: ProviderDriverKind.make("claudeAgent"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-swept-task"),
      payload: {
        taskId: "swept-task-1",
        description: "Watch round-3 CI and bots",
        summary: "Polling CI checks.",
      },
    });

    await waitForThread(harness.readModel, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) =>
          activity.id === "task-progress:thread-1:swept-task-1",
      ),
    );

    // session.exited sweeps the in-memory description cache; the completion
    // that follows must recover the name from persisted activities.
    harness.emit({
      type: "session.exited",
      eventId: asEventId("evt-swept-task-session-exited"),
      provider: ProviderDriverKind.make("claudeAgent"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      payload: {},
    });

    harness.emit({
      type: "task.completed",
      eventId: asEventId("evt-swept-task-completed"),
      provider: ProviderDriverKind.make("claudeAgent"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-swept-task"),
      payload: {
        taskId: "swept-task-1",
        status: "completed",
        summary: "CI is green.",
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.id === "evt-swept-task-completed",
      ),
    );

    const completed = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-swept-task-completed",
    );
    const completedPayload =
      completed?.payload && typeof completed.payload === "object"
        ? (completed.payload as Record<string, unknown>)
        : undefined;

    expect(completedPayload?.title).toBe("Watch round-3 CI and bots");
  });

  it("projects structured user input request and resolution as thread activities", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "user-input.requested",
      eventId: asEventId("evt-user-input-requested"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-user-input"),
      requestId: ApprovalRequestId.make("req-user-input-1"),
      payload: {
        questions: [
          {
            id: "sandbox_mode",
            header: "Sandbox",
            question: "Which mode should be used?",
            options: [
              {
                label: "workspace-write",
                description: "Allow workspace writes only",
              },
            ],
          },
        ],
      },
    });

    harness.emit({
      type: "user-input.resolved",
      eventId: asEventId("evt-user-input-resolved"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-user-input"),
      requestId: ApprovalRequestId.make("req-user-input-1"),
      payload: {
        answers: {
          sandbox_mode: "workspace-write",
        },
      },
    });

    const thread = await waitForThread(
      harness.readModel,
      (entry) =>
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "user-input.requested",
        ) &&
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "user-input.resolved",
        ),
    );

    const requested = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-user-input-requested",
    );
    expect(requested?.kind).toBe("user-input.requested");

    const resolved = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-user-input-resolved",
    );
    const resolvedPayload =
      resolved?.payload && typeof resolved.payload === "object"
        ? (resolved.payload as Record<string, unknown>)
        : undefined;
    expect(resolved?.kind).toBe("user-input.resolved");
    expect(resolvedPayload?.answers).toEqual({
      sandbox_mode: "workspace-write",
    });
  });

  it("accepts planning Spec artifacts from Product Workflow planning orchestrator children", async () => {
    const harness = await createHarness();
    const createdAt = "2026-01-01T00:00:00.000Z";
    const rootThreadId = asThreadId("thread-product-root");
    const planningThreadId = asThreadId("thread-product-planning");

    await runtime!.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-product-root-create"),
        threadId: rootThreadId,
        projectId: asProjectId("project-1"),
        ownerUserId: DEFAULT_WORKSPACE_USER_ID,
        parentThreadId: null,
        workflowRole: null,
        title: "Product Workflow",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: "product-workflow",
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await runtime!.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-product-planning-create"),
        threadId: planningThreadId,
        projectId: asProjectId("project-1"),
        ownerUserId: DEFAULT_WORKSPACE_USER_ID,
        parentThreadId: rootThreadId,
        workflowRole: "planning-orchestrator",
        title: "Plan Checkout",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: "planning-workflow",
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-product-planning-spec"),
      provider: ProviderDriverKind.make("codex"),
      createdAt,
      threadId: planningThreadId,
      turnId: asTurnId("turn-product-planning-spec"),
      itemId: asItemId("item-product-planning-spec"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
        detail:
          '```json\n{ "type": "planning-spec-artifact", "title": "Checkout", "summaryMarkdown": "Build checkout." }\n```',
      },
    });

    const planningThread = await waitForThread(
      harness.readModel,
      (thread) => thread.planningWorkflow?.spec?.title === "Checkout",
      2_000,
      planningThreadId,
    );
    expect(planningThread.planningWorkflow?.spec?.summaryMarkdown).toBe("Build checkout.");
  });

  it("retries a rejected reviewer verdict, then fails the cycle when the retries run out", async () => {
    const harness = await createHarness();
    const createdAt = "2026-01-01T00:00:00.000Z";
    const planningThreadId = asThreadId("thread-planning-review-retry");

    await runtime!.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-planning-review-retry-create"),
        threadId: planningThreadId,
        projectId: asProjectId("project-1"),
        ownerUserId: DEFAULT_WORKSPACE_USER_ID,
        parentThreadId: null,
        workflowRole: "planning-orchestrator",
        title: "Plan Checkout",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: "planning-workflow",
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-review-retry-spec"),
      provider: ProviderDriverKind.make("codex"),
      createdAt,
      threadId: planningThreadId,
      turnId: asTurnId("turn-review-retry-spec"),
      itemId: asItemId("item-review-retry-spec"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
        detail:
          '```json\n{ "type": "planning-spec-artifact", "title": "Checkout", "summaryMarkdown": "Build checkout." }\n```',
      },
    });

    const withSpec = await waitForThread(
      harness.readModel,
      (thread) => thread.planningWorkflow?.spec?.id !== undefined,
      2_000,
      planningThreadId,
    );
    const specId = withSpec.planningWorkflow?.spec?.id;
    if (specId === undefined) throw new Error("Spec was not created.");

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-review-retry-tickets"),
      provider: ProviderDriverKind.make("codex"),
      createdAt,
      threadId: planningThreadId,
      turnId: asTurnId("turn-review-retry-tickets"),
      itemId: asItemId("item-review-retry-tickets"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
        detail: `\`\`\`json
{
  "type": "planning-tickets-artifact",
  "specId": "${specId}",
  "tickets": [
    {
      "key": "TICKET-1",
      "title": "Checkout slice",
      "bodyMarkdown": "Build the checkout slice.",
      "plannedFileChanges": [{ "path": "src/checkout.ts", "action": "update" }],
      "dependencyKeys": [],
      "appReviewEligible": false,
      "appReviewPlanMarkdown": null
    }
  ]
}
\`\`\``,
      },
    });

    await waitForThread(
      harness.readModel,
      (thread) => (thread.planningWorkflow?.tickets.length ?? 0) === 1,
      2_000,
      planningThreadId,
    );

    await runtime!.runPromise(
      harness.engine.dispatch({
        type: "thread.planning-ticket-review.request",
        commandId: CommandId.make("cmd-planning-review-retry-request"),
        threadId: planningThreadId,
        specId,
        createdAt,
      }),
    );

    const requested = await waitForThread(
      harness.readModel,
      (thread) => thread.planningWorkflow?.activeReview != null,
      2_000,
      planningThreadId,
    );
    const reviewerThreadId = requested.planningWorkflow?.activeReview?.reviewerThreadId;
    if (reviewerThreadId === undefined) throw new Error("Reviewer thread was not created.");

    // The shape every cycle of one real run got wrong: `action` is the plannedFileChanges field,
    // not the edit discriminator, and the parser rejects the whole verdict over it.
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-review-retry-verdict"),
      provider: ProviderDriverKind.make("codex"),
      createdAt,
      threadId: reviewerThreadId,
      turnId: asTurnId("turn-review-retry-verdict"),
      itemId: asItemId("item-review-retry-verdict"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
        detail: `\`\`\`json
{
  "type": "planning-reviewer-verdict",
  "cycleNumber": 1,
  "mode": "full",
  "passed": true,
  "failingPlanningTicketIds": [],
  "dependencyFeedback": [],
  "perTicketFeedback": [],
  "ticketEdits": [{ "action": "update", "ticketId": "planning-ticket-1", "title": "Fixed" }]
}
\`\`\``,
      },
    });
    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-review-retry-verdict-turn"),
      provider: ProviderDriverKind.make("codex"),
      createdAt,
      threadId: reviewerThreadId,
      turnId: asTurnId("turn-review-retry-verdict"),
      payload: { state: "completed" },
    });

    const reviewerThread = await waitForThread(
      harness.readModel,
      (thread) =>
        thread.messages.some(
          (message) =>
            message.role === "user" && message.text.includes("ticket edit type is invalid"),
        ),
      2_000,
      reviewerThreadId,
    );
    const retryPrompt = reviewerThread.messages.find(
      (message) => message.role === "user" && message.text.includes("ticket edit type is invalid"),
    );
    expect(retryPrompt?.text).toContain('"type": "update-dependencies"');
    expect(retryPrompt?.text).toContain("Nothing from that verdict was applied");

    const planning = await harness
      .readModel()
      .then((snapshot) => snapshot.threads.find((thread) => thread.id === planningThreadId));
    // The cycle is still open: a rejected shape must not burn one of the five.
    expect(planning?.planningWorkflow?.reviewCycles ?? []).toHaveLength(0);
    expect(planning?.planningWorkflow?.activeReview?.cycleNumber).toBe(1);

    // A reviewer that cannot produce a well-formed verdict must not hold the stage open forever.
    for (const attempt of [2, 3]) {
      harness.emit({
        type: "item.completed",
        eventId: asEventId(`evt-review-retry-verdict-${attempt}`),
        provider: ProviderDriverKind.make("codex"),
        createdAt,
        threadId: reviewerThreadId,
        turnId: asTurnId(`turn-review-retry-verdict-${attempt}`),
        itemId: asItemId(`item-review-retry-verdict-${attempt}`),
        payload: {
          itemType: "assistant_message",
          status: "completed",
          detail: `\`\`\`json
{
  "type": "planning-reviewer-verdict",
  "cycleNumber": 1,
  "mode": "full",
  "passed": true,
  "failingPlanningTicketIds": [],
  "dependencyFeedback": [],
  "perTicketFeedback": [],
  "ticketEdits": [{ "action": "update", "ticketId": "planning-ticket-1", "title": "Fixed" }]
}
\`\`\``,
        },
      });
      harness.emit({
        type: "turn.completed",
        eventId: asEventId(`evt-review-retry-verdict-turn-${attempt}`),
        provider: ProviderDriverKind.make("codex"),
        createdAt,
        threadId: reviewerThreadId,
        turnId: asTurnId(`turn-review-retry-verdict-${attempt}`),
        payload: { state: "completed" },
      });
    }

    const failed = await waitForThread(
      harness.readModel,
      (thread) => (thread.planningWorkflow?.reviewCycles.length ?? 0) > 0,
      2_000,
      planningThreadId,
    );
    expect(failed.planningWorkflow?.reviewCycles[0]?.status).toBe("runtime-failed");
  });

  it("retries a rejected planning artifact on the root thread, then flags for human attention", async () => {
    const harness = await createHarness();
    const createdAt = "2026-01-01T00:00:00.000Z";
    const planningThreadId = asThreadId("thread-planning-artifact-retry");

    await runtime!.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-planning-artifact-retry-create"),
        threadId: planningThreadId,
        projectId: asProjectId("project-1"),
        ownerUserId: DEFAULT_WORKSPACE_USER_ID,
        parentThreadId: null,
        workflowRole: "planning-orchestrator",
        title: "Plan Checkout",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: "planning-workflow",
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await runtime!.runPromise(
      harness.engine.dispatch({
        type: "thread.planning-workflow.stage.set",
        commandId: CommandId.make("cmd-planning-artifact-retry-stage"),
        threadId: planningThreadId,
        stage: "spec-authoring",
        createdAt,
      }),
    );

    // The production stall: an artifact rejected over its shape was only a server-side WARN,
    // so the stage sat open with the thread "ready". Each rejected turn buys one retry.
    for (const attempt of [1, 2, 3]) {
      harness.emit({
        type: "item.completed",
        eventId: asEventId(`evt-artifact-retry-${attempt}`),
        provider: ProviderDriverKind.make("codex"),
        createdAt,
        threadId: planningThreadId,
        turnId: asTurnId(`turn-artifact-retry-${attempt}`),
        itemId: asItemId(`item-artifact-retry-${attempt}`),
        payload: {
          itemType: "assistant_message",
          status: "completed",
          detail: '```json\n{ "type": "planning-spec-artifact", "title": "Checkout" }\n```',
        },
      });
      harness.emit({
        type: "turn.completed",
        eventId: asEventId(`evt-artifact-retry-turn-${attempt}`),
        provider: ProviderDriverKind.make("codex"),
        createdAt,
        threadId: planningThreadId,
        turnId: asTurnId(`turn-artifact-retry-${attempt}`),
        payload: { state: "completed" },
      });
      if (attempt === 1) {
        const retried = await waitForThread(
          harness.readModel,
          (thread) =>
            thread.messages.some(
              (message) =>
                message.role === "user" &&
                message.text.includes("planning-spec-artifact directive was rejected"),
            ),
          2_000,
          planningThreadId,
        );
        const retryPrompt = retried.messages.find(
          (message) =>
            message.role === "user" &&
            message.text.includes("planning-spec-artifact directive was rejected"),
        );
        expect(retryPrompt?.text).toContain("Nothing was applied");
      }
    }

    const blocked = await waitForThread(
      harness.readModel,
      (thread) =>
        thread.activities.some(
          (activity) => activity.kind === "planning-workflow.needs-human-attention",
        ),
      2_000,
      planningThreadId,
    );
    expect(
      blocked.activities.filter((activity) => activity.kind === "workflow.directive.rejected"),
    ).toHaveLength(3);
  });

  it("creates workflow sub-agent threads from provider directives", async () => {
    const harness = await createHarness();
    const createdAt = "2026-01-01T00:00:00.000Z";
    const parentThreadId = asThreadId("thread-subagent-parent");

    await runtime!.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-subagent-parent-create"),
        threadId: parentThreadId,
        projectId: asProjectId("project-1"),
        ownerUserId: DEFAULT_WORKSPACE_USER_ID,
        parentThreadId: null,
        workflowRole: "planning-orchestrator",
        title: "Planning Parent",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: "planning-workflow",
        runtimeMode: "approval-required",
        branch: "feature/planning",
        worktreePath: "/tmp/planning-worktree",
        createdAt,
      }),
    );

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-subagent-create"),
      provider: ProviderDriverKind.make("codex"),
      createdAt,
      threadId: parentThreadId,
      turnId: asTurnId("turn-subagent-create"),
      itemId: asItemId("item-subagent-create"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
        detail: `\`\`\`json
{
  "type": "workflow-subagent-create",
  "workflowPromptId": "${WORKFLOW_PROMPT_IDS.planningTicketReviewerCodex}",
  "title": "Review checkout planning tickets",
  "promptMarkdown": "Review these checkout planning tickets.",
  "expectedResult": "planning-reviewer-verdict"
}
\`\`\``,
      },
    });

    const snapshot = await waitForReadModel(harness.readModel, (readModel) =>
      readModel.threads.some(
        (thread) =>
          thread.parentThreadId === parentThreadId &&
          thread.workflowRole === "planning-reviewer" &&
          thread.messages.some((message) =>
            message.text.includes("Review these checkout planning tickets."),
          ),
      ),
    );
    const childThread = snapshot.threads.find(
      (thread) =>
        thread.parentThreadId === parentThreadId && thread.workflowRole === "planning-reviewer",
    );

    expect(childThread?.interactionMode).toBe("planning-workflow");
    expect(childThread?.title).toBe("Review checkout planning tickets");
    expect(childThread?.branch).toBe("feature/planning");
    expect(childThread?.worktreePath).toBe("/tmp/planning-worktree");
    expect(childThread?.messages[0]?.text).toContain("Expected result directive");
    expect(childThread?.messages[0]?.text).toContain(
      `<workflow-skill id="${WORKFLOW_PROMPT_IDS.planningTicketReviewerCodex}"`,
    );
    expect(childThread?.modelSelection).toEqual({
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    });
  });

  it("rejects ad hoc Browser App Review children while Fast Feature owns review sequencing", async () => {
    const harness = await createHarness();
    const createdAt = "2026-01-01T00:00:00.000Z";
    const parentThreadId = asThreadId("thread-fast-feature-review-owner");
    await runtime!.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-fast-feature-review-owner-create"),
        threadId: parentThreadId,
        projectId: asProjectId("project-1"),
        ownerUserId: DEFAULT_WORKSPACE_USER_ID,
        parentThreadId: null,
        workflowRole: null,
        title: "Fast Feature parent",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: "product-workflow",
        workflowPreset: "fast-feature",
        runtimeMode: "full-access",
        branch: "dev",
        worktreePath: null,
        createdAt,
      }),
    );

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-fast-feature-ad-hoc-review"),
      provider: ProviderDriverKind.make("codex"),
      createdAt,
      threadId: parentThreadId,
      turnId: asTurnId("turn-fast-feature-ad-hoc-review"),
      itemId: asItemId("item-fast-feature-ad-hoc-review"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
        detail: `\`\`\`json
{
  "type": "workflow-subagent-create",
  "workflowPromptId": "${WORKFLOW_PROMPT_IDS.implementationBrowserAppReviewCodex}",
  "title": "Ad hoc review",
  "promptMarkdown": "Review the app now.",
  "appReviewMode": "full"
}
\`\`\``,
      },
    });

    const snapshot = await waitForReadModel(harness.readModel, (readModel) => {
      const parent = readModel.threads.find((thread) => thread.id === parentThreadId);
      return parent?.workflowSubagentBatches?.[0]?.children[0]?.status === "rejected";
    });
    const parent = snapshot.threads.find((thread) => thread.id === parentThreadId);
    const child = parent?.workflowSubagentBatches?.[0]?.children[0];
    expect(child?.status).toBe("rejected");
    expect(child?.failureDetail).toContain("Fast Feature workflow owns its planning");
    expect(
      snapshot.threads.some(
        (thread) =>
          thread.parentThreadId === parentThreadId &&
          thread.workflowRole === "implementation-qa-reviewer",
      ),
    ).toBe(false);
  });

  it("rejects full-mode browser children from a durable App Review owner", async () => {
    const harness = await createHarness();
    const createdAt = "2026-01-01T00:00:00.000Z";
    const parentThreadId = asThreadId("thread-app-review-owner");
    await runtime!.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-app-review-owner-create"),
        threadId: parentThreadId,
        projectId: asProjectId("project-1"),
        ownerUserId: DEFAULT_WORKSPACE_USER_ID,
        parentThreadId: null,
        workflowRole: "app-review-reviewer",
        title: "Durable App Review owner",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: "implementation-workflow",
        runtimeMode: "full-access",
        branch: "feature/review",
        worktreePath: "/tmp/app-review-owner",
        createdAt,
      }),
    );

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-nested-full-review"),
      provider: ProviderDriverKind.make("codex"),
      createdAt,
      threadId: parentThreadId,
      turnId: asTurnId("turn-nested-full-review"),
      itemId: asItemId("item-nested-full-review"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
        detail: `\`\`\`json
{
  "type": "workflow-subagent-create",
  "workflowPromptId": "${WORKFLOW_PROMPT_IDS.implementationBrowserAppReviewCodex}",
  "title": "Nested durable review",
  "promptMarkdown": "Review one lane.",
  "appReviewMode": "full"
}
\`\`\``,
      },
    });

    const snapshot = await waitForReadModel(harness.readModel, (readModel) => {
      const parent = readModel.threads.find((thread) => thread.id === parentThreadId);
      return parent?.workflowSubagentBatches?.[0]?.children[0]?.status === "rejected";
    });
    const child = snapshot.threads.find((thread) => thread.id === parentThreadId)
      ?.workflowSubagentBatches?.[0]?.children[0];
    expect(child?.failureDetail).toContain("only feedback-mode browser lanes");
  });

  it("records App Review repair tickets emitted by the gap analysis planner", async () => {
    const harness = await createHarness();
    const createdAt = "2026-01-01T00:00:00.000Z";
    const plannerThreadId = asThreadId("thread-app-review-planner-tickets");
    await runtime!.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-app-review-planner-tickets-create"),
        threadId: plannerThreadId,
        projectId: asProjectId("project-1"),
        ownerUserId: DEFAULT_WORKSPACE_USER_ID,
        parentThreadId: null,
        workflowRole: "app-review-planner",
        title: "App Review gap analysis 8",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: "default",
        runtimeMode: "full-access",
        branch: "feature/review",
        worktreePath: "/tmp/app-review-planner",
        createdAt,
      }),
    );

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-planner-repair-tickets"),
      provider: ProviderDriverKind.make("codex"),
      createdAt,
      threadId: plannerThreadId,
      turnId: asTurnId("turn-planner-repair-tickets"),
      itemId: asItemId("item-planner-repair-tickets"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
        detail: `\`\`\`json
{
  "type": "app-review-repair-tickets",
  "runId": "app-review-workflow-run-1",
  "cycleNumber": 8,
  "tickets": [
    {
      "key": "TICKET-1.1",
      "parentTicketKey": "TICKET-1",
      "title": "Reflow the capture banner at narrow widths",
      "bodyMarkdown": "What to build and acceptance criteria.",
      "dependencyKeys": []
    }
  ]
}
\`\`\``,
      },
    });

    const thread = await waitForThread(
      harness.readModel,
      (entry) =>
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "app-review-repair-tickets",
        ),
      2_000,
      plannerThreadId,
    );
    const activity = thread.activities.find(
      (entry: ProviderRuntimeTestActivity) => entry.kind === "app-review-repair-tickets",
    );
    const payload =
      activity?.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : undefined;

    expect(payload?.["runId"]).toBe("app-review-workflow-run-1");
    expect(payload?.["cycleNumber"]).toBe(8);
    expect(Array.isArray(payload?.["tickets"]) ? payload["tickets"].length : 0).toBe(1);
  });

  it("records an empty App Review repair plan emitted by the gap analysis planner", async () => {
    const harness = await createHarness();
    const createdAt = "2026-01-01T00:00:00.000Z";
    const plannerThreadId = asThreadId("thread-app-review-planner-empty-tickets");
    await runtime!.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-app-review-planner-empty-tickets-create"),
        threadId: plannerThreadId,
        projectId: asProjectId("project-1"),
        ownerUserId: DEFAULT_WORKSPACE_USER_ID,
        parentThreadId: null,
        workflowRole: "app-review-planner",
        title: "App Review gap analysis 8",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: "default",
        runtimeMode: "full-access",
        branch: "feature/review",
        worktreePath: "/tmp/app-review-planner-empty-tickets",
        createdAt,
      }),
    );

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-planner-empty-repair-tickets"),
      provider: ProviderDriverKind.make("codex"),
      createdAt,
      threadId: plannerThreadId,
      turnId: asTurnId("turn-planner-empty-repair-tickets"),
      itemId: asItemId("item-planner-empty-repair-tickets"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
        detail: `\`\`\`json
{
  "type": "app-review-repair-tickets",
  "runId": "app-review-workflow-run-1",
  "cycleNumber": 8,
  "tickets": []
}
\`\`\``,
      },
    });

    const thread = await waitForThread(
      harness.readModel,
      (entry) =>
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "app-review-repair-tickets",
        ),
      2_000,
      plannerThreadId,
    );
    const activity = thread.activities.find(
      (entry: ProviderRuntimeTestActivity) => entry.kind === "app-review-repair-tickets",
    );
    const payload =
      activity?.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : undefined;

    expect(payload?.["runId"]).toBe("app-review-workflow-run-1");
    expect(payload?.["cycleNumber"]).toBe(8);
    expect(payload?.["tickets"]).toEqual([]);
  });

  it("ignores App Review repair tickets from a thread outside the review workflow", async () => {
    const harness = await createHarness();
    const createdAt = "2026-01-01T00:00:00.000Z";
    const workerThreadId = asThreadId("thread-app-review-tickets-wrong-role");
    await runtime!.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-app-review-tickets-wrong-role-create"),
        threadId: workerThreadId,
        projectId: asProjectId("project-1"),
        ownerUserId: DEFAULT_WORKSPACE_USER_ID,
        parentThreadId: null,
        workflowRole: "implementation-worker",
        title: "Implementation Worker",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: "implementation-workflow",
        runtimeMode: "full-access",
        branch: "feature/review",
        worktreePath: "/tmp/app-review-wrong-role",
        createdAt,
      }),
    );

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-wrong-role-repair-tickets"),
      provider: ProviderDriverKind.make("codex"),
      createdAt,
      threadId: workerThreadId,
      turnId: asTurnId("turn-wrong-role-repair-tickets"),
      itemId: asItemId("item-wrong-role-repair-tickets"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
        detail: `\`\`\`json
{
  "type": "app-review-repair-tickets",
  "runId": "app-review-workflow-run-1",
  "cycleNumber": 8,
  "tickets": [
    {
      "key": "TICKET-1.1",
      "parentTicketKey": "TICKET-1",
      "title": "Reflow the capture banner at narrow widths",
      "bodyMarkdown": "What to build and acceptance criteria.",
      "dependencyKeys": []
    }
  ]
}
\`\`\``,
      },
    });

    const thread = await waitForThread(
      harness.readModel,
      (entry) => entry.messages.length > 0,
      2_000,
      workerThreadId,
    );
    expect(
      thread.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.kind === "app-review-repair-tickets",
      ),
    ).toBe(false);
  });

  it("rejects multi-child workflow handoffs before any child starts", async () => {
    for (const childCount of [2, 50]) {
      const harness = await createHarness();
      const createdAt = "2026-01-01T00:00:00.000Z";
      const parentThreadId = asThreadId(`thread-${childCount}-reviewers-parent`);
      await runtime!.runPromise(
        harness.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`cmd-${childCount}-reviewers-parent-create`),
          threadId: parentThreadId,
          projectId: asProjectId("project-1"),
          ownerUserId: DEFAULT_WORKSPACE_USER_ID,
          parentThreadId: null,
          workflowRole: null,
          title: "Default parent",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: "default",
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt,
        }),
      );
      const children = Array.from({ length: childCount }, (_, index) => ({
        workflowPromptId: WORKFLOW_PROMPT_IDS.implementationBrowserAppReviewCodex,
        title: `Focused browser reviewer ${index}`,
        promptMarkdown: `Review concern ${index}.`,
      }));
      harness.emit({
        type: "item.completed",
        eventId: asEventId(`evt-${childCount}-reviewers`),
        provider: ProviderDriverKind.make("codex"),
        createdAt,
        threadId: parentThreadId,
        turnId: asTurnId(`turn-${childCount}-reviewers`),
        itemId: asItemId(`item-${childCount}-reviewers`),
        payload: {
          itemType: "assistant_message",
          status: "completed",
          detail: `\`\`\`json\n${JSON.stringify({ type: "workflow-subagents-create", children })}\n\`\`\``,
        },
      });

      const snapshot = await waitForReadModel(harness.readModel, (readModel) => {
        const parent = readModel.threads.find((thread) => thread.id === parentThreadId);
        return (
          parent?.activities.some((activity) => activity.kind === "workflow.directive.rejected") ===
            true &&
          parent.messages.some((message) =>
            message.text.includes("complete the remaining work yourself"),
          )
        );
      });
      const parent = snapshot.threads.find((thread) => thread.id === parentThreadId);
      const rejection = parent?.activities.find(
        (activity) => activity.kind === "workflow.directive.rejected",
      );
      expect(parent?.workflowSubagentBatches).toHaveLength(0);
      expect(
        snapshot.threads.filter((thread) => thread.parentThreadId === parentThreadId),
      ).toHaveLength(0);
      expect(rejection?.payload).toMatchObject({
        directiveType: "workflow-subagents-create",
        detail: expect.stringContaining(`contained ${childCount} children`),
      });
      expect(parent?.messages.at(-1)?.text).toContain("complete the remaining work yourself");
    }
  });

  it("rejects a second handoff while the first child is unfinished", async () => {
    const harness = await createHarness();
    const createdAt = "2026-01-01T00:00:00.000Z";
    const parentThreadId = asThreadId("thread-overlapping-handoffs-parent");
    await runtime!.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-overlapping-handoffs-parent-create"),
        threadId: parentThreadId,
        projectId: asProjectId("project-1"),
        ownerUserId: DEFAULT_WORKSPACE_USER_ID,
        parentThreadId: null,
        workflowRole: null,
        title: "Default parent",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: "default",
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    const directive = (title: string) => `\`\`\`json
{
  "type": "workflow-subagent-create",
  "workflowPromptId": "${WORKFLOW_PROMPT_IDS.implementationBrowserAppReviewCodex}",
  "title": "${title}",
  "promptMarkdown": "Review checkout in the browser."
}
\`\`\``;
    for (const [index, title] of ["First review", "Second review"].entries()) {
      harness.emit({
        type: "item.completed",
        eventId: asEventId(`evt-overlapping-handoff-${index}`),
        provider: ProviderDriverKind.make("codex"),
        createdAt,
        threadId: parentThreadId,
        turnId: asTurnId(`turn-overlapping-handoff-${index}`),
        itemId: asItemId(`item-overlapping-handoff-${index}`),
        payload: { itemType: "assistant_message", status: "completed", detail: directive(title) },
      });
      if (index === 0) {
        await waitForReadModel(harness.readModel, (readModel) =>
          readModel.threads.some((thread) => thread.parentThreadId === parentThreadId),
        );
      }
    }

    const snapshot = await waitForReadModel(harness.readModel, (readModel) => {
      const parent = readModel.threads.find((thread) => thread.id === parentThreadId);
      return (
        parent?.activities.some(
          (activity) =>
            activity.kind === "workflow.directive.rejected" &&
            String((activity.payload as Record<string, unknown>)?.["detail"]).includes(
              "still unfinished",
            ),
        ) === true
      );
    });
    const parent = snapshot.threads.find((thread) => thread.id === parentThreadId);
    expect(parent?.workflowSubagentBatches).toHaveLength(1);
    expect(
      snapshot.threads.filter((thread) => thread.parentThreadId === parentThreadId),
    ).toHaveLength(1);
  });

  it("ignores unrelated turn completions until the workflow child reports its result", async () => {
    const harness = await createHarness();
    const createdAt = "2026-01-01T00:00:00.000Z";
    const parentThreadId = asThreadId("thread-subagent-result-parent");
    await runtime!.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-subagent-result-parent-create"),
        threadId: parentThreadId,
        projectId: asProjectId("project-1"),
        ownerUserId: DEFAULT_WORKSPACE_USER_ID,
        parentThreadId: null,
        workflowRole: null,
        title: "Sub-agent result parent",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: "default",
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-subagent-result-create"),
      provider: ProviderDriverKind.make("codex"),
      createdAt,
      threadId: parentThreadId,
      turnId: asTurnId("turn-subagent-result-create"),
      itemId: asItemId("item-subagent-result-create"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
        detail: `\`\`\`json
{
  "type": "workflow-subagent-create",
  "workflowPromptId": "${WORKFLOW_PROMPT_IDS.implementationBrowserAppReviewCodex}",
  "title": "Review checkout",
  "promptMarkdown": "Review checkout in the browser."
}
\`\`\``,
      },
    });

    const launched = await waitForReadModel(harness.readModel, (readModel) =>
      readModel.threads.some(
        (thread) =>
          thread.parentThreadId === parentThreadId &&
          thread.workflowRole === "implementation-qa-reviewer",
      ),
    );
    const childThread = launched.threads.find(
      (thread) =>
        thread.parentThreadId === parentThreadId &&
        thread.workflowRole === "implementation-qa-reviewer",
    );
    if (childThread === undefined) throw new Error("Workflow child was not created.");
    expect(childThread.messages[0]?.text).toContain('"resultMarkdown"');

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-subagent-result-turn-started"),
      provider: ProviderDriverKind.make("codex"),
      createdAt,
      threadId: childThread.id,
      turnId: asTurnId("turn-subagent-result-active"),
    });
    await waitForThread(
      harness.readModel,
      (thread) => thread.session?.activeTurnId === "turn-subagent-result-active",
      2_000,
      childThread.id,
    );
    const beforeUnrelatedCompletion = (await harness.readModel()).threads.find(
      (thread) => thread.id === parentThreadId,
    );
    expect(beforeUnrelatedCompletion?.workflowSubagentBatches?.[0]?.children[0]?.status).toBe(
      "running",
    );

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-subagent-result-unrelated-completed"),
      provider: ProviderDriverKind.make("codex"),
      createdAt,
      threadId: childThread.id,
      turnId: asTurnId("turn-subagent-result-unrelated"),
      payload: { state: "completed" },
    });
    await harness.drain();
    let parent = (await harness.readModel()).threads.find((thread) => thread.id === parentThreadId);
    expect(parent?.workflowSubagentBatches?.[0]?.children[0]?.status).toBe("running");

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-subagent-result-item"),
      provider: ProviderDriverKind.make("codex"),
      createdAt,
      threadId: childThread.id,
      turnId: asTurnId("turn-subagent-result-active"),
      itemId: asItemId("item-subagent-result-item"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
        detail: `\`\`\`json
{
  "type": "workflow-subagent-result",
  "status": "blocked",
  "summary": "Authentication blocked the browser review.",
  "recommendations": ["Provide a seeded account."]
}
\`\`\``,
      },
    });
    await harness.drain();
    parent = (await harness.readModel()).threads.find((thread) => thread.id === parentThreadId);
    expect(parent?.workflowSubagentBatches?.[0]?.children[0]?.status).toBe("blocked");
    expect(parent?.workflowSubagentBatches?.[0]?.children[0]?.resultMarkdown).toContain(
      "Authentication blocked",
    );
  });

  it("creates durable browser app reviews from sub-agent directives on the parent model", async () => {
    const harness = await createHarness();
    const createdAt = "2026-01-01T00:00:00.000Z";
    const parentThreadId = asThreadId("thread-hardlock-parent");

    await runtime!.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-hardlock-parent-create"),
        threadId: parentThreadId,
        projectId: asProjectId("project-1"),
        ownerUserId: DEFAULT_WORKSPACE_USER_ID,
        parentThreadId: null,
        workflowRole: "implementation-orchestrator",
        title: "Implementation Orchestrator",
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-4-8",
        },
        interactionMode: "implementation-workflow",
        runtimeMode: "approval-required",
        branch: "implementation/checkout",
        worktreePath: "/tmp/implementation-worktree",
        createdAt,
      }),
    );

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-hardlock-subagent-create"),
      provider: ProviderDriverKind.make("codex"),
      createdAt,
      threadId: parentThreadId,
      turnId: asTurnId("turn-hardlock-subagent-create"),
      itemId: asItemId("item-hardlock-subagent-create"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
        detail: `\`\`\`json
{
  "type": "workflow-subagent-create",
  "workflowPromptId": "${WORKFLOW_PROMPT_IDS.implementationBrowserAppReviewCodex}",
  "title": "Review checkout in the browser",
  "promptMarkdown": "Exercise the checkout flow in the browser.",
  "appReviewMode": "full"
}
\`\`\``,
      },
    });

    const snapshot = await waitForReadModel(harness.readModel, (readModel) =>
      readModel.threads.some(
        (thread) =>
          thread.parentThreadId === parentThreadId &&
          thread.workflowRole === "implementation-qa-reviewer",
      ),
    );
    const childThread = snapshot.threads.find(
      (thread) =>
        thread.parentThreadId === parentThreadId &&
        thread.workflowRole === "implementation-qa-reviewer",
    );
    const parentThread = snapshot.threads.find((thread) => thread.id === parentThreadId);

    expect(childThread?.modelSelection).toEqual({
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-opus-4-8",
    });
    expect(parentThread?.appReviews).toHaveLength(1);
    expect(parentThread?.appReviews[0]?.reviewThreadId).toBe(childThread?.id);
    expect(parentThread?.appReviews[0]?.status).toBe("running");
    expect(childThread?.messages[0]?.text).toContain("Run Browser App Review");
    expect(childThread?.messages[0]?.text).toContain("Exercise the checkout flow in the browser.");
    expect(childThread?.messages[0]?.text).not.toContain("Expected result directive");
  });

  it("blocks a canonical App Review when its reviewer completes without a terminal update", async () => {
    const harness = await createHarness();
    const sourceThreadId = asThreadId("thread-1");
    const reviewerThreadId = asThreadId("thread-canonical-reviewer");
    const reviewId = AppReviewId.make("review-canonical");
    await runtime!.runPromise(
      harness.engine.dispatch({
        type: "thread.app-review.launch",
        commandId: CommandId.make("cmd-canonical-review-launch"),
        sourceThreadId,
        reviewThreadId: reviewerThreadId,
        reviewId,
        message: {
          messageId: asMessageId("message-canonical-review"),
          role: "user",
          text: "Review the current implementation.",
          attachments: [],
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.6-sol",
        },
        runtimeMode: "full-access",
        workflowPromptId: WORKFLOW_PROMPT_IDS.implementationBrowserAppReviewCodex,
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-canonical-review-started"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:01.000Z",
      threadId: reviewerThreadId,
      turnId: asTurnId("turn-canonical-review"),
    });
    await waitForThread(
      harness.readModel,
      (thread) => thread.session?.activeTurnId === "turn-canonical-review",
      10_000,
      reviewerThreadId,
    );
    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-canonical-review-completed"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:02.000Z",
      threadId: reviewerThreadId,
      turnId: asTurnId("turn-canonical-review"),
      payload: { state: "completed" },
    });
    const source = await waitForThread(
      harness.readModel,
      (thread) =>
        thread.appReviews.some((review) => review.id === reviewId && review.status === "failed"),
      10_000,
      sourceThreadId,
    );
    expect(source.appReviews.find((review) => review.id === reviewId)?.document.summary).toContain(
      "without terminally updating",
    );
  });

  it("adopts a terminal nested review document and evidence into the canonical review", async () => {
    const harness = await createHarness();
    const sourceThreadId = asThreadId("thread-1");
    const reviewerThreadId = asThreadId("thread-legacy-canonical-reviewer");
    const nestedReviewerThreadId = asThreadId("thread-legacy-nested-reviewer");
    const canonicalId = AppReviewId.make("review-legacy-canonical");
    const nestedId = AppReviewId.make("review-legacy-nested");
    const modelSelection = {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.6-sol",
    };
    for (const launch of [
      {
        sourceThreadId,
        reviewThreadId: reviewerThreadId,
        reviewId: canonicalId,
        tag: "canonical",
      },
      {
        sourceThreadId: reviewerThreadId,
        reviewThreadId: nestedReviewerThreadId,
        reviewId: nestedId,
        tag: "nested",
      },
    ]) {
      await runtime!.runPromise(
        harness.engine.dispatch({
          type: "thread.app-review.launch",
          commandId: CommandId.make(`cmd-legacy-${launch.tag}-launch`),
          sourceThreadId: launch.sourceThreadId,
          reviewThreadId: launch.reviewThreadId,
          reviewId: launch.reviewId,
          message: {
            messageId: asMessageId(`message-legacy-${launch.tag}`),
            role: "user",
            text: "Review the current implementation.",
            attachments: [],
          },
          modelSelection,
          runtimeMode: "full-access",
          workflowPromptId: WORKFLOW_PROMPT_IDS.implementationBrowserAppReviewCodex,
          createdAt: "2026-01-01T00:00:00.000Z",
        }),
      );
    }
    const evidence = {
      recording: {
        status: "failed" as const,
        path: null,
        mimeType: null,
        sizeBytes: null,
        startedAt: null,
        completedAt: null,
        error: "Fixtures unavailable",
      },
      screenshots: [],
    };
    await runtime!.runPromise(
      Effect.all([
        harness.engine.dispatch({
          type: "thread.app-review.evidence.update",
          commandId: CommandId.make("cmd-legacy-nested-evidence"),
          threadId: reviewerThreadId,
          reviewId: nestedId,
          evidence,
          updatedAt: "2026-01-01T00:00:01.000Z",
          createdAt: "2026-01-01T00:00:01.000Z",
        }),
        harness.engine.dispatch({
          type: "thread.app-review.update",
          commandId: CommandId.make("cmd-legacy-nested-blocked"),
          threadId: reviewerThreadId,
          reviewId: nestedId,
          status: "failed",
          document: {
            verdict: "failed",
            summary: "Connected-account and mailbox fixtures are unavailable.",
            checks: [],
            findings: [],
            questions: [],
            nextSteps: ["Seed the missing fixtures."],
          },
          updatedAt: "2026-01-01T00:00:01.000Z",
          createdAt: "2026-01-01T00:00:01.000Z",
        }),
      ]),
    );
    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-legacy-canonical-started"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:02.000Z",
      threadId: reviewerThreadId,
      turnId: asTurnId("turn-legacy-canonical"),
    });
    await waitForThread(
      harness.readModel,
      (thread) => thread.session?.activeTurnId === "turn-legacy-canonical",
      10_000,
      reviewerThreadId,
    );
    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-legacy-canonical-completed"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:03.000Z",
      threadId: reviewerThreadId,
      turnId: asTurnId("turn-legacy-canonical"),
      payload: { state: "completed" },
    });
    const source = await waitForThread(
      harness.readModel,
      (thread) =>
        thread.appReviews.some((review) => review.id === canonicalId && review.status === "failed"),
      10_000,
      sourceThreadId,
    );
    const canonical = source.appReviews.find((review) => review.id === canonicalId);
    expect(canonical?.document.summary).toContain("mailbox fixtures");
    expect(canonical?.evidence).toEqual(evidence);
  });

  it("keeps the parent selection for browser app review when codex is disabled", async () => {
    const harness = await createHarness({
      serverSettings: { providers: { codex: { enabled: false } } },
    });
    const createdAt = "2026-01-01T00:00:00.000Z";
    const parentThreadId = asThreadId("thread-hardlock-fallback-parent");
    const parentModelSelection = {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-opus-4-8",
    };

    await runtime!.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-hardlock-fallback-parent-create"),
        threadId: parentThreadId,
        projectId: asProjectId("project-1"),
        ownerUserId: DEFAULT_WORKSPACE_USER_ID,
        parentThreadId: null,
        workflowRole: "implementation-orchestrator",
        title: "Implementation Orchestrator",
        modelSelection: parentModelSelection,
        interactionMode: "implementation-workflow",
        runtimeMode: "approval-required",
        branch: "implementation/checkout",
        worktreePath: "/tmp/implementation-worktree",
        createdAt,
      }),
    );

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-hardlock-fallback-subagent-create"),
      provider: ProviderDriverKind.make("codex"),
      createdAt,
      threadId: parentThreadId,
      turnId: asTurnId("turn-hardlock-fallback-subagent-create"),
      itemId: asItemId("item-hardlock-fallback-subagent-create"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
        detail: `\`\`\`json
{
  "type": "workflow-subagent-create",
  "workflowPromptId": "${WORKFLOW_PROMPT_IDS.implementationBrowserAppReviewCodex}",
  "title": "Review checkout in the browser",
  "promptMarkdown": "Exercise the checkout flow in the browser.",
  "appReviewMode": "full"
}
\`\`\``,
      },
    });

    const snapshot = await waitForReadModel(harness.readModel, (readModel) =>
      readModel.threads.some(
        (thread) =>
          thread.parentThreadId === parentThreadId &&
          thread.workflowRole === "implementation-qa-reviewer",
      ),
    );
    const childThread = snapshot.threads.find(
      (thread) =>
        thread.parentThreadId === parentThreadId &&
        thread.workflowRole === "implementation-qa-reviewer",
    );
    const parentThread = snapshot.threads.find((thread) => thread.id === parentThreadId);
    expect(childThread?.modelSelection).toEqual(parentModelSelection);
    expect(parentThread?.appReviews).toHaveLength(1);
    expect(parentThread?.appReviews[0]?.reviewThreadId).toBe(childThread?.id);

    // Nothing was demoted: the step never asked for a provider of its own.
    expect(
      parentThread?.activities.some(
        (activity) => activity.kind === "workflow.subagent.model-fallback",
      ),
    ).toBe(false);
  });

  it("routes workflow agent messages to direct child agents by role", async () => {
    const harness = await createHarness();
    const createdAt = "2026-01-01T00:00:00.000Z";
    const parentThreadId = asThreadId("thread-message-parent");
    const childThreadId = asThreadId("thread-message-child");

    await runtime!.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-message-parent-create"),
        threadId: parentThreadId,
        projectId: asProjectId("project-1"),
        ownerUserId: DEFAULT_WORKSPACE_USER_ID,
        parentThreadId: null,
        workflowRole: "implementation-orchestrator",
        title: "Implementation Parent",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: "implementation-workflow",
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await runtime!.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-message-child-create"),
        threadId: childThreadId,
        projectId: asProjectId("project-1"),
        ownerUserId: DEFAULT_WORKSPACE_USER_ID,
        parentThreadId,
        workflowRole: "implementation-worker",
        title: "Implementation Worker",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: "implementation-workflow",
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-agent-message"),
      provider: ProviderDriverKind.make("codex"),
      createdAt,
      threadId: parentThreadId,
      turnId: asTurnId("turn-agent-message"),
      itemId: asItemId("item-agent-message"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
        detail: `\`\`\`json
{
  "type": "workflow-agent-message",
  "target": {
    "relation": "child",
    "workflowRole": "implementation-worker"
  },
  "purpose": "status",
  "messageMarkdown": "Please report current implementation status."
}
\`\`\``,
      },
    });

    const childThread = await waitForThread(
      harness.readModel,
      (thread) =>
        thread.messages.some((message) =>
          message.text.includes("Please report current implementation status."),
        ),
      2_000,
      childThreadId,
    );

    expect(childThread.messages[0]?.text).toContain(`from thread '${parentThreadId}'`);
    expect(childThread.messages[0]?.text).toContain("Purpose: status.");
  });

  it("starts the Spec stage when a planning thread reports grill completion", async () => {
    const harness = await createHarness();
    const createdAt = "2026-01-01T00:00:00.000Z";
    const planningThreadId = asThreadId("thread-planning-grill-complete");

    await runtime!.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-planning-grill-complete-create"),
        threadId: planningThreadId,
        projectId: asProjectId("project-1"),
        ownerUserId: DEFAULT_WORKSPACE_USER_ID,
        parentThreadId: null,
        workflowRole: null,
        title: "Plan Checkout",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: "planning-workflow",
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-planning-grill-complete"),
      provider: ProviderDriverKind.make("codex"),
      createdAt,
      threadId: planningThreadId,
      turnId: asTurnId("turn-planning-grill-complete"),
      itemId: asItemId("item-planning-grill-complete"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
        detail: '```json\n{ "type": "planning-grill-complete" }\n```',
      },
    });

    const planningThread = await waitForThread(
      harness.readModel,
      (thread) => thread.planningWorkflow?.stage === "spec-authoring",
      2_000,
      planningThreadId,
    );
    expect(
      planningThread.messages.some((message) =>
        message.text.includes("Create the Spec artifact for this planning workflow."),
      ),
    ).toBe(true);
  });

  it("ignores grill completion directives from non-planning threads", async () => {
    const harness = await createHarness();
    const createdAt = "2026-01-01T00:00:00.000Z";
    const threadId = asThreadId("thread-default-grill-complete");

    await runtime!.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-default-grill-complete-create"),
        threadId,
        projectId: asProjectId("project-1"),
        ownerUserId: DEFAULT_WORKSPACE_USER_ID,
        parentThreadId: null,
        workflowRole: null,
        title: "Default Thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: "default",
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-default-grill-complete"),
      provider: ProviderDriverKind.make("codex"),
      createdAt,
      threadId,
      turnId: asTurnId("turn-default-grill-complete"),
      itemId: asItemId("item-default-grill-complete"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
        detail: '```json\n{ "type": "planning-grill-complete" }\n```',
      },
    });

    await harness.drain();
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((candidate) => candidate.id === threadId);
    expect(thread?.planningWorkflow ?? null).toBe(null);
  });

  it("rejects planning Spec artifacts from Product Workflow root threads", async () => {
    const harness = await createHarness();
    const createdAt = "2026-01-01T00:00:00.000Z";
    const rootThreadId = asThreadId("thread-product-root-spec-reject");

    await runtime!.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-product-root-spec-reject-create"),
        threadId: rootThreadId,
        projectId: asProjectId("project-1"),
        ownerUserId: DEFAULT_WORKSPACE_USER_ID,
        parentThreadId: null,
        workflowRole: null,
        title: "Product Workflow",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: "product-workflow",
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-product-root-spec-reject"),
      provider: ProviderDriverKind.make("codex"),
      createdAt,
      threadId: rootThreadId,
      turnId: asTurnId("turn-product-root-spec-reject"),
      itemId: asItemId("item-product-root-spec-reject"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
        detail:
          '```json\n{ "type": "planning-spec-artifact", "title": "Checkout", "summaryMarkdown": "Build checkout." }\n```',
      },
    });

    await harness.drain();
    const readModel = await harness.readModel();
    const rootThread = readModel.threads.find((thread) => thread.id === rootThreadId);
    expect(rootThread?.planningWorkflow?.spec ?? null).toBe(null);
  });

  it("rejects product intent locks from non-root product threads", async () => {
    const harness = await createHarness();
    const createdAt = "2026-01-01T00:00:00.000Z";
    const rootThreadId = asThreadId("thread-product-root-intent");
    const planningThreadId = asThreadId("thread-product-planning-intent");

    await runtime!.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-product-root-intent-create"),
        threadId: rootThreadId,
        projectId: asProjectId("project-1"),
        ownerUserId: DEFAULT_WORKSPACE_USER_ID,
        parentThreadId: null,
        workflowRole: null,
        title: "Product Workflow",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: "product-workflow",
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await runtime!.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-product-planning-intent-create"),
        threadId: planningThreadId,
        projectId: asProjectId("project-1"),
        ownerUserId: DEFAULT_WORKSPACE_USER_ID,
        parentThreadId: rootThreadId,
        workflowRole: "planning-orchestrator",
        title: "Plan Checkout",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: "planning-workflow",
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-product-child-intent"),
      provider: ProviderDriverKind.make("codex"),
      createdAt,
      threadId: planningThreadId,
      turnId: asTurnId("turn-product-child-intent"),
      itemId: asItemId("item-product-child-intent"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
        detail:
          '```json\n{ "type": "product-intent-locked", "title": "Checkout", "summaryMarkdown": "Locked." }\n```',
      },
    });

    await harness.drain();
    const readModel = await harness.readModel();
    const planningThread = readModel.threads.find((thread) => thread.id === planningThreadId);
    expect(
      planningThread?.activities.some((activity) => activity.kind === "product-intent-locked"),
    ).toBe(false);
  });

  type ProductIntentHarness = Awaited<ReturnType<typeof createHarness>>;

  async function createProductRootThread(
    harness: ProductIntentHarness,
    rootThreadId: ThreadId,
    createdAt: string,
    workflowPreset: "fix" | "fast-feature" | "full-feature" | null = "fix",
  ) {
    await runtime!.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`cmd-create:${rootThreadId}`),
        threadId: rootThreadId,
        projectId: asProjectId("project-1"),
        ownerUserId: DEFAULT_WORKSPACE_USER_ID,
        parentThreadId: null,
        workflowRole: null,
        title: "Product Workflow",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: "product-workflow",
        ...(workflowPreset === null ? {} : { workflowPreset }),
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
  }

  function emitProductDirective(
    harness: ProductIntentHarness,
    rootThreadId: ThreadId,
    tag: string,
    createdAt: string,
    directiveJson: string,
  ) {
    harness.emit({
      type: "item.completed",
      eventId: asEventId(`evt-${tag}`),
      provider: ProviderDriverKind.make("codex"),
      createdAt,
      threadId: rootThreadId,
      turnId: asTurnId(`turn-${tag}`),
      itemId: asItemId(`item-${tag}`),
      payload: {
        itemType: "assistant_message",
        status: "completed",
        detail: `\`\`\`json\n${directiveJson}\n\`\`\``,
      },
    });
  }

  const intentGateMessages = (thread: ProviderRuntimeTestThread | undefined) =>
    (thread?.messages ?? []).filter(
      (message: ProviderRuntimeTestMessage) =>
        message.role === "user" && message.id.startsWith("message-product-intent-gate-"),
    );

  const intentLockRejections = (thread: ProviderRuntimeTestThread | undefined) =>
    (thread?.activities ?? []).filter(
      (activity: ProviderRuntimeTestActivity) =>
        activity.kind === "workflow.directive.rejected" &&
        (activity.payload as { directiveType?: string })?.directiveType === "product-intent-locked",
    );

  it("accepts product intent locks that match the explicit workflow preset", async () => {
    const harness = await createHarness();
    for (const [workflowPreset, intentKind] of [
      ["fix", "fix"],
      ["fast-feature", "feature"],
      ["full-feature", "feature"],
    ] as const) {
      const rootThreadId = asThreadId(`thread-product-lock-${workflowPreset}`);
      await createProductRootThread(
        harness,
        rootThreadId,
        "2026-01-01T00:00:00.000Z",
        workflowPreset,
      );
      emitProductDirective(
        harness,
        rootThreadId,
        `lock-${workflowPreset}`,
        "2026-01-01T00:00:01.000Z",
        `{ "type": "product-intent-locked", "intentKind": "${intentKind}", "title": "Checkout", "summaryMarkdown": "Locked." }`,
      );
      await harness.drain();

      const readModel = await harness.readModel();
      const rootThread = readModel.threads.find((thread) => thread.id === rootThreadId);
      const activity = rootThread?.activities.find(
        (entry) => entry.kind === "product-intent-locked",
      );
      expect(activity).toBeDefined();
      expect((activity?.payload as { intentKind?: string })?.intentKind).toBe(intentKind);
      expect(intentLockRejections(rootThread)).toHaveLength(0);
    }
  });

  it("rejects product intent locks without an explicit workflow preset", async () => {
    const harness = await createHarness();
    const rootThreadId = asThreadId("thread-product-lock-missing-preset");
    await createProductRootThread(harness, rootThreadId, "2026-01-01T00:00:00.000Z", null);

    emitProductDirective(
      harness,
      rootThreadId,
      "lock-missing-preset",
      "2026-01-01T00:00:01.000Z",
      '{ "type": "product-intent-locked", "intentKind": "fix", "title": "Checkout", "summaryMarkdown": "Locked." }',
    );
    await harness.drain();

    const readModel = await harness.readModel();
    const rootThread = readModel.threads.find((thread) => thread.id === rootThreadId);
    expect(intentLockRejections(rootThread)).toHaveLength(1);
    expect((intentLockRejections(rootThread)[0]?.payload as { detail?: string })?.detail).toMatch(
      /explicit Fix, Fast Feature, or Full Feature workflow preset/,
    );
  });

  it("rejects product intent locks without the preset's explicit intent kind", async () => {
    const harness = await createHarness();
    const rootThreadId = asThreadId("thread-product-lock-missing-kind");
    await createProductRootThread(harness, rootThreadId, "2026-01-01T00:00:00.000Z");

    emitProductDirective(
      harness,
      rootThreadId,
      "lock-missing-kind",
      "2026-01-01T00:00:01.000Z",
      '{ "type": "product-intent-locked", "title": "Checkout", "summaryMarkdown": "Locked." }',
    );
    await harness.drain();

    const readModel = await harness.readModel();
    const rootThread = readModel.threads.find((thread) => thread.id === rootThreadId);
    expect(rootThread?.activities.some((entry) => entry.kind === "product-intent-locked")).toBe(
      false,
    );
    const rejections = intentLockRejections(rootThread);
    expect(rejections).toHaveLength(1);
    expect((rejections[0]?.payload as { detail?: string })?.detail).toMatch(/intentKind/);
  });

  it("escalates to needs-human-attention after repeated product intent lock rejections", async () => {
    const harness = await createHarness();
    const rootThreadId = asThreadId("thread-product-lock-loop-guard");
    await createProductRootThread(harness, rootThreadId, "2026-01-01T00:00:00.000Z");

    for (let attempt = 1; attempt <= MAX_PRODUCT_INTENT_LOCK_REJECTION_BOUNCES + 1; attempt += 1) {
      emitProductDirective(
        harness,
        rootThreadId,
        `lock-loop-${attempt}`,
        `2026-01-01T00:00:0${attempt}.000Z`,
        '{ "type": "product-intent-locked", "intentKind": "feature", "title": "Checkout", "summaryMarkdown": "Locked." }',
      );
      await harness.drain();
    }

    const readModel = await harness.readModel();
    const rootThread = readModel.threads.find((thread) => thread.id === rootThreadId);
    expect(rootThread?.activities.some((entry) => entry.kind === "product-intent-locked")).toBe(
      false,
    );
    expect(intentLockRejections(rootThread)).toHaveLength(
      MAX_PRODUCT_INTENT_LOCK_REJECTION_BOUNCES + 1,
    );
    expect(intentGateMessages(rootThread)).toHaveLength(MAX_PRODUCT_INTENT_LOCK_REJECTION_BOUNCES);
    expect(
      rootThread?.activities.filter(
        (entry) => entry.kind === "product-workflow.needs-human-attention",
      ),
    ).toHaveLength(1);
  });

  it("continues processing runtime events after a single event handler failure", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-invalid-delta"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-invalid"),
      itemId: asItemId("item-invalid"),
      payload: {
        streamKind: "assistant_text",
        delta: undefined,
      },
    } as unknown as ProviderRuntimeEvent);

    harness.emit({
      type: "runtime.error",
      eventId: asEventId("evt-runtime-error-after-failure"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-after-failure"),
      payload: {
        message: "runtime still processed",
      },
    });

    const thread = await waitForThread(
      harness.readModel,
      (entry) =>
        entry.session?.status === "error" &&
        entry.session?.activeTurnId === "turn-after-failure" &&
        entry.session?.lastError === "runtime still processed",
    );
    expect(thread.session?.status).toBe("error");
    expect(thread.session?.lastError).toBe("runtime still processed");
  });

  async function seedFastFeatureRun(harness: Awaited<ReturnType<typeof createHarness>>) {
    const createdAt = "2026-01-01T00:00:00.000Z";
    const fastSourceThreadId = asThreadId("thread-fast-source");
    await runtime!.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-fast-source-create"),
        threadId: fastSourceThreadId,
        projectId: asProjectId("project-1"),
        ownerUserId: DEFAULT_WORKSPACE_USER_ID,
        parentThreadId: null,
        workflowRole: null,
        title: "Fast checkout",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: "plan",
        workflowPreset: "fast-feature",
        runtimeMode: "full-access",
        branch: "main",
        worktreePath: "/tmp/fast-feature-source",
        createdAt,
      }),
    );
    await runtime!.runPromise(
      harness.engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make("cmd-fast-intent"),
        threadId: fastSourceThreadId,
        activity: {
          id: asEventId("evt-fast-intent"),
          tone: "info",
          kind: "product-intent-locked",
          summary: "Fast checkout",
          payload: {
            intentKind: "feature",
            title: "Fast checkout",
            summaryMarkdown: "Add a fast checkout path.",
          },
          turnId: null,
          createdAt,
        },
        createdAt,
      }),
    );
    await runtime!.runPromise(
      harness.engine.dispatch({
        type: "thread.proposed-plan.upsert",
        commandId: CommandId.make("cmd-fast-plan"),
        threadId: fastSourceThreadId,
        proposedPlan: {
          id: "plan-fast",
          turnId: null,
          planMarkdown: "# Fast checkout\nImplement the focused checkout change.",
          implementedAt: null,
          implementationThreadId: null,
          createdAt,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );
    await runtime!.runPromise(
      harness.engine.dispatch({
        type: "thread.fast-feature-run.launch",
        commandId: CommandId.make("cmd-fast-launch"),
        threadId: fastSourceThreadId,
        proposedPlanId: "plan-fast",
        baseBranch: "main",
        pinnedCommit: "abc123",
        orchestratorBranch: "fast-feature/fast-checkout",
        orchestratorWorktreePath: "/tmp/fast-feature-worktree",
        validationCommands: ["vp check"],
        createdAt,
      }),
    );

    const snapshot = await harness.readModel();
    const implementer = snapshot.threads.find(
      (thread) => thread.workflowRole === "fast-feature-implementer",
    );
    const run = snapshot.implementationRuns[0];
    if (!implementer || !run) throw new Error("Fast feature run seeding failed.");
    return { implementerThreadId: implementer.id, runId: run.id };
  }

  function emitFastBuildTurnStart(
    harness: Awaited<ReturnType<typeof createHarness>>,
    implementerThreadId: ThreadId,
    turnId: string,
  ) {
    harness.emit({
      type: "turn.started",
      eventId: asEventId(`evt-${turnId}-started`),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:01.000Z",
      threadId: implementerThreadId,
      turnId: asTurnId(turnId),
    });
  }

  const fastBuildResults = (thread: ProviderRuntimeTestThread) =>
    thread.activities.filter((activity) => activity.kind === "implementation-fast-build-result");

  it("does not report a missing Build directive while the turn is still running", async () => {
    const harness = await createHarness();
    const { implementerThreadId } = await seedFastFeatureRun(harness);
    emitFastBuildTurnStart(harness, implementerThreadId, "turn-fast-narration");

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-fast-narration"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:02.000Z",
      threadId: implementerThreadId,
      turnId: asTurnId("turn-fast-narration"),
      itemId: asItemId("item-fast-narration"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
        detail: "I'll start by exploring the repository structure.",
      },
    });

    // The narration must land as an ordinary assistant message and nothing else.
    const implementer = await waitForThread(
      harness.readModel,
      (thread) =>
        thread.messages.some((message) =>
          message.text.includes("I'll start by exploring the repository structure."),
        ),
      2_000,
      implementerThreadId,
    );
    await harness.drain();
    expect(fastBuildResults(implementer)).toHaveLength(0);
    const afterDrain = (await harness.readModel()).threads.find(
      (thread) => thread.id === implementerThreadId,
    );
    expect(fastBuildResults(afterDrain!)).toHaveLength(0);
  });

  it("reports a missing Build directive once the turn completes, exactly once", async () => {
    const harness = await createHarness();
    const { implementerThreadId, runId } = await seedFastFeatureRun(harness);
    emitFastBuildTurnStart(harness, implementerThreadId, "turn-fast-missing");

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-fast-missing-item"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:02.000Z",
      threadId: implementerThreadId,
      turnId: asTurnId("turn-fast-missing"),
      itemId: asItemId("item-fast-missing"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
        detail: "Done exploring, but I forgot the directive.",
      },
    });
    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-fast-missing-turn"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:03.000Z",
      threadId: implementerThreadId,
      turnId: asTurnId("turn-fast-missing"),
      payload: { state: "completed" },
    });

    const implementer = await waitForThread(
      harness.readModel,
      (thread) => fastBuildResults(thread).length > 0,
      2_000,
      implementerThreadId,
    );
    const blocked = fastBuildResults(implementer)[0];
    expect(blocked?.tone).toBe("error");
    expect(blocked?.payload).toMatchObject({
      type: "implementation-fast-build-result",
      runId,
      status: "blocked",
    });

    // A re-delivered turn.completed is the same failure, not a second one.
    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-fast-missing-turn-redelivered"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:04.000Z",
      threadId: implementerThreadId,
      turnId: asTurnId("turn-fast-missing"),
      payload: { state: "completed" },
    });
    await harness.drain();
    const settled = (await harness.readModel()).threads.find(
      (thread) => thread.id === implementerThreadId,
    );
    expect(fastBuildResults(settled!)).toHaveLength(1);
  });

  it("leaves a failed Build turn to workflow recovery instead of reporting a missing directive", async () => {
    const harness = await createHarness();
    const { implementerThreadId } = await seedFastFeatureRun(harness);
    emitFastBuildTurnStart(harness, implementerThreadId, "turn-fast-provider-failed");

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-fast-provider-failed-item"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:02.000Z",
      threadId: implementerThreadId,
      turnId: asTurnId("turn-fast-provider-failed"),
      itemId: asItemId("item-fast-provider-failed"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
        detail: "I was still validating the repair.",
      },
    });
    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-fast-provider-failed-turn"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:03.000Z",
      threadId: implementerThreadId,
      turnId: asTurnId("turn-fast-provider-failed"),
      payload: { state: "failed", errorMessage: "Provider aborted the active command." },
    });

    await harness.drain();
    const implementer = (await harness.readModel()).threads.find(
      (thread) => thread.id === implementerThreadId,
    );
    expect(implementer?.session?.status).toBe("error");
    expect(fastBuildResults(implementer!)).toHaveLength(0);
  });

  it("replays a valid Build directive from the projected terminal message", async () => {
    const harness = await createHarness();
    const { implementerThreadId, runId } = await seedFastFeatureRun(harness);
    const turnId = asTurnId("turn-fast-terminal-replay");
    const messageId = asMessageId("message-fast-terminal-replay");
    emitFastBuildTurnStart(harness, implementerThreadId, turnId);
    await harness.drain();

    const directive = `\`\`\`json
{
  "type": "implementation-fast-build-result",
  "runId": "${runId}",
  "status": "succeeded",
  "commitSha": "terminal123",
  "validations": [],
  "notesMarkdown": "Recovered from the projected terminal message."
}
\`\`\``;
    await runtime!.runPromise(
      harness.engine.dispatch({
        type: "thread.message.assistant.delta",
        commandId: CommandId.make("cmd-fast-terminal-replay-delta"),
        threadId: implementerThreadId,
        messageId,
        turnId,
        delta: directive,
        createdAt: "2026-01-01T00:00:02.000Z",
      }),
    );
    await runtime!.runPromise(
      harness.engine.dispatch({
        type: "thread.message.assistant.complete",
        commandId: CommandId.make("cmd-fast-terminal-replay-complete"),
        threadId: implementerThreadId,
        messageId,
        turnId,
        createdAt: "2026-01-01T00:00:02.000Z",
      }),
    );

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-fast-terminal-replay-turn"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:03.000Z",
      threadId: implementerThreadId,
      turnId,
      payload: { state: "completed" },
    });

    const implementer = await waitForThread(
      harness.readModel,
      (thread) => fastBuildResults(thread).length > 0,
      2_000,
      implementerThreadId,
    );
    expect(fastBuildResults(implementer)).toHaveLength(1);
    expect(fastBuildResults(implementer)[0]?.payload).toMatchObject({
      type: "implementation-fast-build-result",
      runId,
      status: "succeeded",
      commitSha: "terminal123",
    });
  });

  it("still accepts a valid Build directive on an intermediate assistant message", async () => {
    const harness = await createHarness();
    const { implementerThreadId, runId } = await seedFastFeatureRun(harness);
    emitFastBuildTurnStart(harness, implementerThreadId, "turn-fast-succeeded");

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-fast-succeeded"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:02.000Z",
      threadId: implementerThreadId,
      turnId: asTurnId("turn-fast-succeeded"),
      itemId: asItemId("item-fast-succeeded"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
        detail: `\`\`\`json
{
  "type": "implementation-fast-build-result",
  "runId": "${runId}",
  "status": "succeeded",
  "commitSha": "def456",
  "validations": [
    { "command": "vp check", "status": "passed", "outputMarkdown": "ok", "completedAt": "2026-01-01T00:00:02.000Z" }
  ],
  "notesMarkdown": "Implemented and committed."
}
\`\`\``,
      },
    });

    const implementer = await waitForThread(
      harness.readModel,
      (thread) => fastBuildResults(thread).length > 0,
      2_000,
      implementerThreadId,
    );
    expect(fastBuildResults(implementer)[0]?.payload).toMatchObject({
      type: "implementation-fast-build-result",
      runId,
      status: "succeeded",
      commitSha: "def456",
    });
  });
});
