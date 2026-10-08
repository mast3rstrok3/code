import { EventStoreV2 } from "../orchestration-v2/EventStore.ts";
import { WorkflowUserInputBroker } from "../mcp/WorkflowUserInputBroker.ts";
import { ProviderInstanceRegistry } from "../provider/ProviderInstanceRegistry.ts";
import type {
  OrchestrationMessage,
  OrchestrationCommand,
  DispatchResult,
} from "@t3tools/contracts";
import {
  CommandId,
  DEFAULT_WORKSPACE_USER_ID,
  EventId,
  ProviderDriverKind,
  RuntimeItemId,
  RuntimeRequestId,
  TurnId,
  type OrchestrationEvent,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2ThreadProjection,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ThreadId,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Schema from "effect/Schema";
import type { OrchestrationDispatchError } from "./Errors.ts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import { ProjectService } from "../project/ProjectService.ts";
import { ProviderRuntimeIngestionService } from "./Services/ProviderRuntimeIngestion.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import { WorkflowProviderEvents } from "./WorkflowProviderEvents.ts";
import {
  appendWorkflowSkillCommandSection,
  appendWorkflowStepInstructions,
} from "../provider/WorkflowPromptRegistry.ts";
import { ServerSettingsService } from "../serverSettings.ts";

const OBSERVATION_PREFIX = "workflow:observe:";
const commandIdFor = (event: OrchestrationEvent, suffix = "") =>
  CommandId.make(`workflow:execute:${event.eventId}${suffix}`);

/** Native receipts deduplicate retries, including replay after a server restart. */
export function workflowControlCommands(
  event: OrchestrationEvent,
  projection: OrchestrationV2ThreadProjection | null,
  messageText?: string,
  message?: OrchestrationMessage,
): ReadonlyArray<OrchestrationV2ServerCommand> {
  if (event.commandId?.startsWith(OBSERVATION_PREFIX)) return [];
  const commandId = commandIdFor(event);
  switch (event.type) {
    case "thread.created": {
      if (projection !== null) return [];
      const p = event.payload;
      return [
        {
          type: "thread.create",
          commandId,
          threadId: p.threadId,
          projectId: p.projectId,
          title: p.title,
          modelSelection: p.modelSelection,
          runtimeMode: p.runtimeMode,
          interactionMode: p.interactionMode,
          branch: p.branch,
          worktreePath: p.worktreePath,
          ownerUserId: p.ownerUserId,
          parentThreadId: p.parentThreadId ?? null,
          workflowRole: p.workflowRole ?? null,
          workflowContext: p.workflowContext ?? null,
          workflowPreset: p.workflowPreset ?? null,
          createdBy: "system",
          creationSource: "server",
        },
      ];
    }
    case "thread.meta-updated": {
      const { title, branch, worktreePath, ownerUserId, modelSelection } = event.payload;
      return [
        {
          type: "thread.metadata.update",
          commandId,
          threadId: event.payload.threadId,
          ...(title === undefined ? {} : { title }),
          ...(branch === undefined ? {} : { branch }),
          ...(worktreePath === undefined ? {} : { worktreePath }),
          ...(ownerUserId === undefined ? {} : { ownerUserId }),
        },
        ...(modelSelection === undefined
          ? []
          : [
              {
                type: "thread.model-selection.set" as const,
                commandId: commandIdFor(event, ":model"),
                threadId: event.payload.threadId,
                modelSelection,
              },
            ]),
      ];
    }
    case "thread.composer-mode-set":
      return [
        {
          type: "thread.interaction-mode.set",
          commandId,
          threadId: event.payload.threadId,
          interactionMode: event.payload.interactionMode,
        },
        {
          type: "thread.metadata.update",
          commandId: commandIdFor(event, ":preset"),
          threadId: event.payload.threadId,
          workflowPreset: event.payload.workflowPreset,
        },
      ];
    case "thread.planning-stage-started":
      return event.payload.workflowContext === undefined
        ? []
        : [
            {
              type: "thread.metadata.update",
              commandId,
              threadId: event.payload.threadId,
              workflowContext: event.payload.workflowContext,
            },
          ];
    case "thread.runtime-mode-set":
      return [
        {
          type: "thread.runtime-mode.set",
          commandId,
          threadId: event.payload.threadId,
          runtimeMode: event.payload.runtimeMode,
        },
      ];
    case "thread.interaction-mode-set":
      return [
        {
          type: "thread.interaction-mode.set",
          commandId,
          threadId: event.payload.threadId,
          interactionMode: event.payload.interactionMode,
        },
      ];
    case "thread.turn-start-requested": {
      if (projection === null || messageText === undefined) return [];
      const p = event.payload;
      return [
        {
          type: "thread.runtime-mode.set",
          commandId: commandIdFor(event, ":runtime"),
          threadId: p.threadId,
          runtimeMode: p.runtimeMode,
        },
        {
          type: "thread.interaction-mode.set",
          commandId: commandIdFor(event, ":interaction"),
          threadId: p.threadId,
          interactionMode: p.interactionMode,
        },
        {
          type: "message.dispatch",
          commandId,
          threadId: p.threadId,
          messageId: p.messageId,
          text: messageText,
          attachments: message?.attachments ?? [],
          ...(message?.context === undefined ? {} : { context: message.context }),
          createdBy: "system",
          creationSource: "server",
          ...(p.modelSelection === undefined ? {} : { modelSelection: p.modelSelection }),
          ...(p.freshProviderSession === undefined
            ? {}
            : { freshProviderSession: p.freshProviderSession }),
          dispatchMode: { type: "start_immediately" },
        },
      ];
    }
    case "thread.turn-interrupt-requested": {
      const run = projection?.runs.find((run) =>
        event.payload.turnId === undefined
          ? ["preparing", "starting", "running", "waiting"].includes(run.status)
          : run.id === String(event.payload.turnId),
      );
      return run === undefined
        ? []
        : [{ type: "run.interrupt", commandId, threadId: event.payload.threadId, runId: run.id }];
    }
    case "thread.session-stop-requested":
      return [{ type: "thread.stop", commandId, threadId: event.payload.threadId }];
    case "thread.approval-response-requested":
      return [
        {
          type: "runtime-request.respond",
          commandId,
          threadId: event.payload.threadId,
          requestId: RuntimeRequestId.make(event.payload.requestId),
          decision: event.payload.decision,
        },
      ];
    case "thread.user-input-response-requested":
      return [
        {
          type: "runtime-request.respond",
          commandId,
          threadId: event.payload.threadId,
          requestId: RuntimeRequestId.make(event.payload.requestId),
          answers: event.payload.answers,
          ...(event.payload.attachmentsByQuestionId === undefined
            ? {}
            : {
                attachmentsByQuestionId: event.payload.attachmentsByQuestionId,
              }),
        },
      ];
    case "thread.deleted":
      return [{ type: "thread.delete", commandId, threadId: event.payload.threadId }];
    case "thread.archived":
      return [{ type: "thread.archive", commandId, threadId: event.payload.threadId }];
    case "thread.unarchived":
      return [{ type: "thread.unarchive", commandId, threadId: event.payload.threadId }];
    case "thread.settled":
      return [{ type: "thread.settle", commandId, threadId: event.payload.threadId }];
    case "thread.unsettled":
      return [
        { type: "thread.unsettle", commandId, threadId: event.payload.threadId, reason: "user" },
      ];
    default:
      return [];
  }
}

/** Feed completed native messages before terminal runs so directive validation sees their text. */
export function workflowRuntimeEvents(
  stored: OrchestrationV2StoredEvent,
): ReadonlyArray<ProviderRuntimeEvent> {
  const event = stored.event;
  const base = {
    eventId: event.id,
    threadId: event.threadId,
    provider: event.driver ?? ProviderDriverKind.make("codex"),
    ...(event.providerInstanceId === undefined
      ? {}
      : { providerInstanceId: event.providerInstanceId }),
    createdAt: DateTime.formatIso(event.occurredAt),
    ...(event.runId == null ? {} : { turnId: TurnId.make(event.runId) }),
  };
  if (
    event.type === "message.updated" &&
    event.payload.role === "assistant" &&
    !event.payload.streaming
  ) {
    const message = event.payload;
    if (message.runId === null) return [];
    return [
      {
        ...base,
        eventId: EventId.make(`workflow:message:${message.id}:text`),
        turnId: TurnId.make(message.runId),
        itemId: RuntimeItemId.make(message.id),
        type: "content.delta",
        payload: { streamKind: "assistant_text", delta: message.text },
      },
      {
        ...base,
        eventId: EventId.make(`workflow:message:${message.id}:complete`),
        turnId: TurnId.make(message.runId),
        itemId: RuntimeItemId.make(message.id),
        type: "item.completed",
        payload: { itemType: "assistant_message", status: "completed" },
      },
    ];
  }
  if (event.type === "run.updated") {
    const run = event.payload;
    const turnId = TurnId.make(run.id);
    if (run.status === "running") return [{ ...base, turnId, type: "turn.started", payload: {} }];
    if (["completed", "failed", "interrupted", "cancelled"].includes(run.status)) {
      return [
        {
          ...base,
          turnId,
          type: "turn.completed",
          payload: {
            state:
              run.status === "completed"
                ? "completed"
                : run.status === "failed"
                  ? "failed"
                  : "interrupted",
            ...(run.status === "failed" ? { errorMessage: "The provider run failed." } : {}),
          },
        },
      ];
    }
  }
  return [];
}

export class WorkflowThreadImportError extends Schema.TaggedError<WorkflowThreadImportError>()(
  "WorkflowThreadImportError",
  {
    threadId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return "Failed to prepare the thread for workflow commands.";
  }
}

export class WorkflowRuntimeBridge extends Context.Service<
  WorkflowRuntimeBridge,
  {
    readonly dispatchCommand: (
      command: OrchestrationCommand,
    ) => Effect.Effect<DispatchResult, WorkflowThreadImportError | OrchestrationDispatchError>;
    readonly start: Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/orchestration/WorkflowRuntimeBridge") {}

export const layerProviderEvents = Layer.effect(
  WorkflowProviderEvents,
  Effect.sync(() => {
    const sessions = new Map<ThreadId, ProviderSession>();
    return {
      setSession: (session: ProviderSession) => {
        sessions.set(session.threadId, session);
      },
      streamEvents: Stream.empty,
      listSessions: () => Effect.succeed([...sessions.values()]),
    };
  }),
);

export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery;
  const native = yield* OrchestratorV2;
  const nativeEvents = yield* EventStoreV2;
  const projects = yield* ProjectService;
  const ingestion = yield* ProviderRuntimeIngestionService;
  const settings = yield* ServerSettingsService;
  const sql = yield* SqlClient.SqlClient;
  const providerEvents = yield* WorkflowProviderEvents;
  const userInput = yield* WorkflowUserInputBroker;
  const instances = yield* ProviderInstanceRegistry;
  const workflowRecord = (threadId: ThreadId) => sql<{
    readonly deleted_at: string | null;
    readonly archived_at: string | null;
    readonly worktree_path: string | null;
    readonly branch: string | null;
  }>`
    SELECT deleted_at, archived_at, worktree_path, branch FROM projection_threads WHERE thread_id = ${threadId} LIMIT 1
  `;
  // Subscribe during layer construction, before startup recovery can emit workflow commands.
  const commands = yield* engine.subscribeDomainEvents;
  const sendToNative = Effect.fn("WorkflowRuntimeBridge.sendToNative")(function* (
    event: OrchestrationEvent,
  ) {
    if (event.aggregateKind !== "thread" || event.commandId?.startsWith(OBSERVATION_PREFIX)) return;
    const threadId = event.aggregateId as ThreadId;
    const projection = yield* native.getThreadProjection(threadId).pipe(Effect.option);
    if (
      event.type === "thread.user-input-response-requested" &&
      (yield* userInput.respond(event.payload))
    )
      return;
    if (event.type === "thread.session-stop-requested" || event.type === "thread.deleted")
      yield* userInput.cancelThread({ threadId, reason: "The workflow thread stopped." });
    let messageText: string | undefined;
    let message: OrchestrationMessage | undefined;
    if (event.type === "thread.turn-start-requested") {
      const record = yield* snapshots.getTurnStartMessage(event.payload);
      if (Option.isSome(record)) {
        message = record.value.message;
        const saved = yield* settings.getSettings;
        messageText = appendWorkflowStepInstructions(
          appendWorkflowSkillCommandSection(
            record.value.message.text,
            event.payload.workflowPromptId,
          ),
          event.payload.workflowPromptId,
          saved.workflowStepInstructions,
        );
      }
    }
    for (const command of workflowControlCommands(
      event,
      Option.getOrNull(projection),
      messageText,
      message,
    )) {
      yield* native.dispatch(command);
    }
  });
  const executeAndRecord = (event: OrchestrationEvent) =>
    sendToNative(event).pipe(
      Effect.andThen(
        sql`UPDATE workflow_control_cursor SET sequence = ${event.sequence} WHERE id = 1`,
      ),
      Effect.asVoid,
    );
  const retryPersisted = <A, E, R>(operation: Effect.Effect<A, E, R>) =>
    operation.pipe(
      Effect.tapError((cause) =>
        Effect.logError("Workflow bridge will retry a persisted event", { cause }),
      ),
      Effect.retry(Schedule.spaced("1 second")),
    );
  const commandWorker = yield* makeDrainableWorker((event: OrchestrationEvent) =>
    retryPersisted(executeAndRecord(event)),
  );

  const importLock = yield* Semaphore.make(1);
  const importNativeThread = Effect.fn("WorkflowRuntimeBridge.importNativeThread")(function* (
    thread: OrchestrationV2ThreadProjection["thread"],
    commandId: CommandId,
  ) {
    const records = yield* workflowRecord(thread.id);
    if (records.length === 0) {
      const projectOption = yield* projects.getById(thread.projectId, { includeDeleted: true });
      if (Option.isNone(projectOption))
        return yield* Effect.die(new Error("Workflow project was not found"));
      const project = projectOption.value;
      const readModel = yield* snapshots.getCommandReadModel();
      if (!readModel.projects.some((old) => old.id === project.id)) {
        yield* engine.dispatch({
          type: "project.create",
          commandId: CommandId.make(`${commandId}:project`),
          projectId: project.id,
          title: project.title,
          workspaceRoot: project.workspaceRoot,
          ownerUserId: project.ownerUserId ?? DEFAULT_WORKSPACE_USER_ID,
          createdAt: project.createdAt,
        });
      }
      yield* engine.dispatch({
        type: "thread.create",
        commandId,
        threadId: thread.id,
        projectId: thread.projectId,
        title: thread.title,
        modelSelection: thread.modelSelection,
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
        branch: thread.branch,
        worktreePath: thread.worktreePath,
        ownerUserId: thread.ownerUserId ?? DEFAULT_WORKSPACE_USER_ID,
        parentThreadId: thread.lineage.parentThreadId,
        workflowRole: thread.workflowRole ?? null,
        workflowContext: thread.workflowContext ?? null,
        workflowPreset: thread.workflowPreset ?? null,
        createdAt: DateTime.formatIso(thread.createdAt),
        historyImport: true,
      });
    }
  }, importLock.withPermit);

  // Observations copy state the native runtime already committed. A refusal from the
  // workflow engine is permanent (its receipt replays it), so retrying would loop
  // forever and hold server startup; log it and move on instead.
  const mirrorNative = (command: OrchestrationCommand) => {
    const skip = (error: OrchestrationDispatchError) =>
      Effect.logWarning("Workflow bridge skipped a refused native observation", {
        commandId: command.commandId,
        error,
      });
    return engine.dispatch(command).pipe(
      Effect.asVoid,
      Effect.catchTags({
        OrchestrationCommandInvariantError: skip,
        OrchestrationThreadSettleBlockedError: skip,
        OrchestrationCommandPreviouslyRejectedError: skip,
      }),
    );
  };

  const observeNative = Effect.fn("WorkflowRuntimeBridge.observeNative")(function* (
    stored: OrchestrationV2StoredEvent,
  ) {
    const event = stored.event;
    const commandId = CommandId.make(`${OBSERVATION_PREFIX}${event.id}`);
    if (event.type === "thread.created") {
      const thread = event.payload;
      yield* importNativeThread(thread, commandId);
    }
    // Native lifecycle changes must reach the workflow metadata and App Stack reactors.
    if (
      [
        "thread.settled",
        "thread.unsettled",
        "thread.archived",
        "thread.unarchived",
        "thread.deleted",
      ].includes(event.type)
    ) {
      const [oldThread] = yield* workflowRecord(event.threadId);
      if (
        oldThread &&
        oldThread.deleted_at === null &&
        (event.type === "thread.deleted" ||
          (event.type === "thread.unarchived"
            ? oldThread.archived_at !== null
            : oldThread.archived_at === null))
      ) {
        const type =
          event.type === "thread.settled"
            ? "thread.settle"
            : event.type === "thread.unsettled"
              ? "thread.unsettle"
              : event.type === "thread.archived"
                ? "thread.archive"
                : event.type === "thread.unarchived"
                  ? "thread.unarchive"
                  : "thread.delete";
        if (type === "thread.unsettle")
          yield* mirrorNative({ type, commandId, threadId: event.threadId, reason: "user" });
        else yield* mirrorNative({ type, commandId, threadId: event.threadId });
      }
    }
    if (event.type === "thread.metadata-updated" && event.payload.deletedAt === null) {
      const thread = event.payload;
      yield* mirrorNative({
        type: "thread.meta.update",
        commandId,
        threadId: thread.id,
        title: thread.title,
        branch: thread.branch,
        worktreePath: thread.worktreePath,
        modelSelection: thread.modelSelection,
        ...(thread.ownerUserId === undefined ? {} : { ownerUserId: thread.ownerUserId }),
      });
    }
    const deliveryKey =
      event.type === "message.updated" && !event.payload.streaming
        ? `message:${event.payload.id}`
        : event.type === "run.updated"
          ? `run:${event.payload.id}:${event.payload.status}`
          : null;
    const delivered =
      deliveryKey === null
        ? []
        : yield* sql`SELECT id FROM workflow_runtime_deliveries WHERE id = ${deliveryKey}`;
    const [workflowThread] = deliveryKey === null ? [] : yield* workflowRecord(event.threadId);
    const inactive =
      workflowThread !== undefined &&
      (workflowThread.deleted_at !== null || workflowThread.archived_at !== null);
    const runtimeEvents = delivered.length === 0 && !inactive ? workflowRuntimeEvents(stored) : [];
    if (inactive && deliveryKey !== null)
      yield* sql`INSERT OR IGNORE INTO workflow_runtime_deliveries (id) VALUES (${deliveryKey})`;
    if (runtimeEvents.length > 0) {
      const projection = yield* native.getThreadProjection(event.threadId);
      const activeTurnId = runtimeEvents[0]?.turnId;
      const run = projection.runs.find((run) => String(run.id) === String(activeTurnId));
      const instance = yield* instances.getInstance(projection.thread.providerInstanceId);
      const provider = event.driver ?? instance?.driverKind ?? ProviderDriverKind.make("codex");
      providerEvents.setSession({
        threadId: event.threadId,
        provider,
        providerInstanceId: projection.thread.providerInstanceId,
        status: run?.status === "running" ? "running" : "ready",
        runtimeMode: projection.thread.runtimeMode,
        ...(activeTurnId === undefined ? {} : { activeTurnId }),
        createdAt: DateTime.formatIso(projection.thread.createdAt),
        updatedAt: DateTime.formatIso(event.occurredAt),
      });
      if (ingestion.ingest === undefined)
        return yield* Effect.die(new Error("Workflow runtime ingestion is not configured"));
      for (const runtime of runtimeEvents) yield* ingestion.ingest({ ...runtime, provider });
      if (deliveryKey !== null)
        yield* sql`INSERT OR IGNORE INTO workflow_runtime_deliveries (id) VALUES (${deliveryKey})`;
    }
    yield* sql`UPDATE workflow_runtime_cursor SET sequence = ${stored.sequence} WHERE id = 1`;
  });
  const nativeWorker = yield* makeDrainableWorker((stored: OrchestrationV2StoredEvent) =>
    retryPersisted(observeNative(stored)),
  );
  const start = Effect.gen(function* () {
    yield* ingestion.start();
    const [controlCursor] = yield* sql<{
      readonly sequence: number;
    }>`SELECT sequence FROM workflow_control_cursor WHERE id = 1`;
    let latestControl = controlCursor?.sequence ?? 0;
    yield* engine.readEvents(latestControl, Number.MAX_SAFE_INTEGER).pipe(
      Stream.runForEach((event) =>
        retryPersisted(executeAndRecord(event)).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              latestControl = event.sequence;
            }),
          ),
        ),
      ),
    );
    yield* commands.pipe(
      Stream.filter((event) => event.sequence > latestControl),
      Stream.runForEach(commandWorker.enqueue),
      Effect.forkScoped,
    );
    const [cursor] = yield* sql<{
      readonly sequence: number;
    }>`SELECT sequence FROM workflow_runtime_cursor WHERE id = 1`;
    const nativeHead = yield* nativeEvents.latestSequence();
    yield* nativeEvents
      .read({ afterSequence: cursor?.sequence ?? 0, throughSequence: nativeHead })
      .pipe(Stream.runForEach((event) => retryPersisted(observeNative(event))));
    yield* native
      .streamStoredEventsFrom({ afterSequence: nativeHead })
      .pipe(Stream.runForEach(nativeWorker.enqueue), Effect.forkScoped);
  });
  const dispatchCommand = Effect.fn("WorkflowRuntimeBridge.dispatchCommand")(function* (
    command: OrchestrationCommand,
  ) {
    const threadId =
      "threadId" in command
        ? command.threadId
        : "targetThreadId" in command
          ? command.targetThreadId
          : null;
    if (threadId !== null && command.type !== "thread.create") {
      // A native launch can reach this RPC before the event subscription imports it.
      yield* Effect.gen(function* () {
        const [record] = yield* workflowRecord(threadId);
        if (record !== undefined && command.type !== "thread.turn.start") return;
        const projection = yield* native.getThreadProjection(threadId);
        yield* importNativeThread(
          projection.thread,
          CommandId.make(`${OBSERVATION_PREFIX}import:${threadId}`),
        );
        if (
          record !== undefined &&
          (record.worktree_path !== projection.thread.worktreePath ||
            record.branch !== projection.thread.branch)
        ) {
          yield* engine.dispatch({
            type: "thread.meta.update",
            commandId: CommandId.make(`${OBSERVATION_PREFIX}workspace:${command.commandId}`),
            threadId,
            worktreePath: projection.thread.worktreePath,
            branch: projection.thread.branch,
          });
        }
      }).pipe(Effect.mapError((cause) => new WorkflowThreadImportError({ threadId, cause })));
    }
    return yield* engine.dispatch(command, { priority: "interactive" });
  });
  return {
    dispatchCommand,
    start: start.pipe(Effect.orDie),
    drain: commandWorker.drain.pipe(
      Effect.andThen(nativeWorker.drain),
      Effect.andThen(ingestion.drain),
      Effect.andThen(commandWorker.drain),
    ),
  };
});

export const layer = Layer.effect(WorkflowRuntimeBridge, make);
