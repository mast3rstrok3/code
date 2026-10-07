import { createEmptyReadModel } from "./projector.ts";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../persistence/Migrations.ts";
import {
  CommandId,
  MessageId,
  ProjectId,
  DEFAULT_SERVER_SETTINGS,
  type OrchestrationCommand,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import { ProviderRuntimeIngestionService } from "./Services/ProviderRuntimeIngestion.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import { EventStoreV2 } from "../orchestration-v2/EventStore.ts";
import { ProjectService } from "../project/ProjectService.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { ProviderInstanceRegistry } from "../provider/ProviderInstanceRegistry.ts";
import { WorkflowUserInputBroker } from "../mcp/WorkflowUserInputBroker.ts";
import { make, layerProviderEvents } from "./WorkflowRuntimeBridge.ts";
import * as DateTime from "effect/DateTime";
import { OrchestrationEvent, OrchestrationV2StoredEvent } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { emptyProjection } from "../orchestration-v2/ProjectionStore.ts";
import { workflowControlCommands, workflowRuntimeEvents } from "./WorkflowRuntimeBridge.ts";

const at = "2026-10-07T00:00:00.000Z";
const decodeLegacy = Schema.decodeUnknownSync(OrchestrationEvent);
const nativeAt = DateTime.makeUnsafe(at);
const decodeNative = Schema.decodeUnknownSync(OrchestrationV2StoredEvent);
const legacyBase = {
  sequence: 1,
  eventId: "event",
  aggregateKind: "thread",
  aggregateId: "thread",
  streamVersion: 1,
  occurredAt: at,
  commandId: "command",
  causationEventId: null,
  correlationId: null,
  actorKind: "server",
  metadata: {},
};
const nativeThread = decodeNative({
  sequence: 1,
  commandId: null,
  event: {
    id: "native:create",
    threadId: "thread",
    occurredAt: nativeAt,
    type: "thread.created",
    payload: {
      id: "thread",
      projectId: "project",
      title: "Workflow",
      providerInstanceId: "codex",
      modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "feature",
      worktreePath: "/workspace/feature",
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: "thread" },
      forkedFrom: null,
      createdAt: nativeAt,
      updatedAt: nativeAt,
      archivedAt: null,
      deletedAt: null,
      lastVisitedAt: null,
      createdBy: "system",
      creationSource: "server",
    },
  },
});
if (nativeThread.event.type !== "thread.created") throw new Error("Invalid native thread fixture");
const projection = emptyProjection(nativeThread.event);

describe("workflow commands on the native runtime", () => {
  it("creates the workflow child with its owner, parent and role", () => {
    const event = decodeLegacy({
      ...legacyBase,
      type: "thread.created",
      payload: {
        threadId: "child",
        projectId: "project",
        title: "Implement ticket",
        ownerUserId: "nils",
        parentThreadId: "thread",
        workflowRole: "implementation-worker",
        workflowContext: {
          workflowId: "workflow",
          rootThreadId: "thread",
          ticketScope: ["TICKET-1"],
        },
        modelSelection: { instanceId: "claude", model: "sonnet" },
        runtimeMode: "full-access",
        interactionMode: "implementation-workflow",
        branch: "feature",
        worktreePath: "/workspace/feature",
        createdAt: at,
        updatedAt: at,
      },
    });
    expect(workflowControlCommands(event, null)).toMatchObject([
      {
        type: "thread.create",
        parentThreadId: "thread",
        ownerUserId: "nils",
        workflowRole: "implementation-worker",
        modelSelection: { instanceId: "claude" },
      },
    ]);
    expect(workflowControlCommands(event, projection)).toEqual([]);
  });

  it("uses stable native command IDs and sends one provider message per workflow request", () => {
    const event = decodeLegacy({
      ...legacyBase,
      type: "thread.turn-start-requested",
      payload: {
        threadId: "thread",
        messageId: "user:ticket",
        runtimeMode: "full-access",
        interactionMode: "implementation-workflow",
        createdAt: at,
      },
    });
    const commands = workflowControlCommands(event, projection, "Implement TICKET-1");
    expect(commands.filter((command) => command.type === "message.dispatch")).toMatchObject([
      {
        commandId: "workflow:execute:event",
        messageId: "user:ticket",
        text: "Implement TICKET-1",
        dispatchMode: { type: "start_immediately" },
      },
    ]);
    expect(workflowControlCommands(event, projection, "Implement TICKET-1")).toEqual(commands);
  });

  it("does not echo observed native commands back into the runtime", () => {
    const event = decodeLegacy({
      ...legacyBase,
      commandId: "workflow:observe:native-event",
      type: "thread.session-stop-requested",
      payload: { threadId: "thread", createdAt: at },
    });
    expect(workflowControlCommands(event, projection)).toEqual([]);
  });
});

it("passes complete assistant text to directive ingestion before its completion", () => {
  const stored = decodeNative({
    sequence: 2,
    commandId: null,
    event: {
      id: "native:answer",
      threadId: "thread",
      runId: "run",
      driver: "claude",
      providerInstanceId: "claude-work",
      occurredAt: nativeAt,
      type: "message.updated",
      payload: {
        id: "answer",
        threadId: "thread",
        runId: "run",
        nodeId: null,
        role: "assistant",
        text: '{"type":"implementation-worker-result","status":"completed"}',
        attachments: [],
        streaming: false,
        createdAt: nativeAt,
        updatedAt: nativeAt,
        createdBy: "agent",
        creationSource: "provider",
      },
    },
  });
  expect(workflowRuntimeEvents(stored)).toMatchObject([
    {
      eventId: "workflow:message:answer:text",
      type: "content.delta",
      turnId: "run",
      provider: "claude",
      providerInstanceId: "claude-work",
      payload: { delta: stored.event.type === "message.updated" ? stored.event.payload.text : "" },
    },
    { eventId: "workflow:message:answer:complete", type: "item.completed", turnId: "run" },
  ]);
  if (stored.event.type === "message.updated") {
    expect(
      workflowRuntimeEvents({
        ...stored,
        event: {
          ...stored.event,
          payload: {
            ...stored.event.payload,
            streaming: true,
          },
        },
      }),
    ).toEqual([]);
  }
});

effectIt.effect("replays native completions once even when a crash loses the cursor update", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const received: ProviderRuntimeEvent[] = [];
      const assistant = decodeNative({
        sequence: 1,
        commandId: null,
        event: {
          id: "native:message",
          threadId: "thread",
          runId: "run",
          driver: "claude",
          providerInstanceId: "claude-work",
          occurredAt: nativeAt,
          type: "message.updated",
          payload: {
            id: "answer",
            threadId: "thread",
            runId: "run",
            nodeId: null,
            role: "assistant",
            text: "Completed ticket",
            attachments: [],
            streaming: false,
            createdAt: nativeAt,
            updatedAt: nativeAt,
            createdBy: "agent",
            creationSource: "provider",
          },
        },
      });
      const dependencies = Layer.mergeAll(
        Layer.mock(OrchestrationEngineService)({
          subscribeDomainEvents: Effect.succeed(Stream.never),
          readEvents: () => Stream.empty,
        }),
        Layer.mock(ProjectionSnapshotQuery)({
          getThreadShellById: () => Effect.succeed(Option.none()),
        }),
        Layer.mock(OrchestratorV2)({
          getThreadProjection: () => Effect.succeed(projection),
          streamStoredEventsFrom: () => Stream.never,
        }),
        Layer.mock(EventStoreV2)({
          latestSequence: () => Effect.succeed(1),
          read: () => Stream.make(assistant),
        }),
        Layer.mock(ProjectService)({}),
        Layer.mock(ServerSettingsService)({ getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS) }),
        Layer.mock(ProviderInstanceRegistry)({ getInstance: () => Effect.succeed(undefined) }),
        Layer.mock(WorkflowUserInputBroker)({
          respond: () => Effect.succeed(false),
          cancelThread: () => Effect.void,
        }),
        Layer.mock(ProviderRuntimeIngestionService)({
          start: () => Effect.void,
          drain: Effect.void,
          ingest: (event) =>
            Effect.sync(() => {
              received.push(event);
            }),
        }),
        layerProviderEvents,
      );
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations();
        const first = yield* make;
        yield* first.start;
        yield* first.drain;
        expect(received.map((event) => event.type)).toEqual(["content.delta", "item.completed"]);
        yield* sql`UPDATE workflow_runtime_cursor SET sequence = 0 WHERE id = 1`;
        const restarted = yield* make;
        yield* restarted.start;
        yield* restarted.drain;
        expect(received).toHaveLength(2);
        expect(yield* sql`SELECT sequence FROM workflow_runtime_cursor WHERE id = 1`).toEqual([
          { sequence: 1 },
        ]);
      }).pipe(Effect.provide(dependencies));
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  ),
);

effectIt.effect("reopens archived workflow metadata without recreating its thread", () =>
  Effect.scoped(
    Effect.gen(function* () {
      if (nativeThread.event.type !== "thread.created") throw new Error("Invalid fixture");
      const archived = decodeNative({
        ...nativeThread,
        event: {
          ...nativeThread.event,
          payload: { ...nativeThread.event.payload, archivedAt: nativeAt },
        },
      });
      const reopened = decodeNative({
        sequence: 2,
        commandId: null,
        event: { ...nativeThread.event, id: "native:reopen", type: "thread.unarchived" },
      });
      const commands: string[] = [];
      const dependencies = Layer.mergeAll(
        Layer.mock(OrchestrationEngineService)({
          subscribeDomainEvents: Effect.succeed(Stream.never),
          readEvents: () => Stream.empty,
          dispatch: (command) =>
            Effect.sync(() => {
              commands.push(command.type);
              return { sequence: 1 };
            }),
        }),
        Layer.mock(ProjectionSnapshotQuery)({
          getThreadShellById: () => Effect.succeed(Option.none()),
        }),
        Layer.mock(OrchestratorV2)({ streamStoredEventsFrom: () => Stream.never }),
        Layer.mock(EventStoreV2)({
          latestSequence: () => Effect.succeed(2),
          read: () => Stream.make(archived, reopened),
        }),
        Layer.mock(ProjectService)({}),
        Layer.mock(ServerSettingsService)({}),
        Layer.mock(ProviderInstanceRegistry)({}),
        Layer.mock(WorkflowUserInputBroker)({}),
        Layer.mock(ProviderRuntimeIngestionService)({
          start: () => Effect.void,
          drain: Effect.void,
        }),
        layerProviderEvents,
      );
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations();
        yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode, created_at, updated_at, archived_at)
        VALUES ('thread', 'project', 'Archived workflow', '{"instanceId":"codex","model":"gpt-6.1-sol"}', 'full-access', 'default', ${at}, ${at}, ${at})`;
        const bridge = yield* make;
        yield* bridge.start;
        yield* bridge.drain;
        expect(commands).toEqual(["thread.unarchive"]);
      }).pipe(Effect.provide(dependencies));
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  ),
);

// The first workflow RPC must work even before the native subscription imports the launch.
effectIt.effect("imports a newly launched native thread before applying its workflow mode", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const commands: OrchestrationCommand[] = [];
      const sql = yield* SqlClient.SqlClient;
      const dependencies = Layer.mergeAll(
        Layer.mock(OrchestrationEngineService)({
          subscribeDomainEvents: Effect.succeed(Stream.never),
          dispatch: (command) =>
            Effect.gen(function* () {
              commands.push(command);
              if (command.type === "thread.create") {
                yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode, created_at, updated_at)
              VALUES ('thread', 'project', 'Workflow', '{"instanceId":"codex","model":"gpt-6.1-sol"}', 'full-access', 'default', ${at}, ${at})`;
              }
              return { sequence: 1 };
            }).pipe(Effect.orDie),
        }),
        Layer.mock(ProjectionSnapshotQuery)({
          getCommandReadModel: () => Effect.succeed(createEmptyReadModel(at)),
        }),
        Layer.mock(OrchestratorV2)({ getThreadProjection: () => Effect.succeed(projection) }),
        Layer.mock(EventStoreV2)({}),
        Layer.mock(ProjectService)({
          getById: () =>
            Effect.succeed(
              Option.some({
                id: ProjectId.make("project"),
                title: "Project",
                workspaceRoot: "/workspace",
                repositoryIdentity: null,
                faviconPath: null,
                defaultModelSelection: null,
                scripts: [],
                createdAt: at,
                updatedAt: at,
                deletedAt: null,
              }),
            ),
        }),
        Layer.mock(ServerSettingsService)({}),
        Layer.mock(ProviderInstanceRegistry)({}),
        Layer.mock(WorkflowUserInputBroker)({}),
        Layer.mock(ProviderRuntimeIngestionService)({}),
        layerProviderEvents,
      );
      yield* Effect.gen(function* () {
        yield* runMigrations();
        const bridge = yield* make;
        const command = {
          type: "thread.composer-mode.set" as const,
          commandId: CommandId.make("mode"),
          threadId: projection.thread.id,
          interactionMode: "product-workflow" as const,
          workflowPreset: "fast-feature" as const,
          createdAt: at,
        };
        yield* Effect.all(
          [
            bridge.dispatchCommand(command),
            bridge.dispatchCommand({ ...command, commandId: CommandId.make("concurrent-mode") }),
          ],
          { concurrency: "unbounded" },
        );
        expect(commands.map((command) => command.type)).toEqual([
          "project.create",
          "thread.create",
          "thread.composer-mode.set",
          "thread.composer-mode.set",
        ]);
        expect(commands[1]).toMatchObject({
          worktreePath: "/workspace/feature",
          historyImport: true,
        });
        yield* bridge.dispatchCommand({ ...command, commandId: CommandId.make("mode-again") });
        expect(commands.filter((command) => command.type === "thread.create")).toHaveLength(1);
        yield* bridge.dispatchCommand({
          type: "thread.turn.start",
          commandId: CommandId.make("prepared-workflow-turn"),
          threadId: projection.thread.id,
          interactionMode: "product-workflow",
          runtimeMode: "full-access",
          createdAt: at,
          message: {
            messageId: MessageId.make("brief"),
            role: "user",
            text: "Implement the feature",
            attachments: [],
          },
        });
        expect(commands.slice(-2)).toMatchObject([
          {
            type: "thread.meta.update",
            worktreePath: "/workspace/feature",
            commandId: "workflow:observe:workspace:prepared-workflow-turn",
          },
          { type: "thread.turn.start" },
        ]);
      }).pipe(Effect.provide(dependencies));
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  ),
);
