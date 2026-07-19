import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_WORKSPACE_USER_ID,
  EventId,
  ProjectId,
  ThreadId,
  type OrchestrationCommand,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const asCommandId = (value: string): CommandId => CommandId.make(value);
const asEventId = (value: string): EventId => EventId.make(value);
const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asThreadId = (value: string): ThreadId => ThreadId.make(value);

const seedReadModel = Effect.gen(function* () {
  const now = "2026-01-01T00:00:00.000Z";
  const initial = createEmptyReadModel(now);
  const withProject = yield* projectEvent(initial, {
    sequence: 1,
    eventId: asEventId("evt-project-create"),
    aggregateKind: "project",
    aggregateId: asProjectId("project-delete"),
    type: "project.created",
    occurredAt: now,
    commandId: asCommandId("cmd-project-create"),
    causationEventId: null,
    correlationId: asCommandId("cmd-project-create"),
    metadata: {},
    payload: {
      projectId: asProjectId("project-delete"),
      title: "Project Delete",
      workspaceRoot: "/tmp/project-delete",
      defaultModelSelection: null,
      scripts: [],
      createdAt: now,
      updatedAt: now,
    },
  });

  const withFirstThread = yield* projectEvent(withProject, {
    sequence: 2,
    eventId: asEventId("evt-thread-create-1"),
    aggregateKind: "thread",
    aggregateId: asThreadId("thread-delete-1"),
    type: "thread.created",
    occurredAt: now,
    commandId: asCommandId("cmd-thread-create-1"),
    causationEventId: null,
    correlationId: asCommandId("cmd-thread-create-1"),
    metadata: {},
    payload: {
      threadId: asThreadId("thread-delete-1"),
      projectId: asProjectId("project-delete"),
      ownerUserId: DEFAULT_WORKSPACE_USER_ID,
      title: "Thread Delete 1",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      branch: null,
      worktreePath: null,
      createdAt: now,
      updatedAt: now,
    },
  });

  return yield* projectEvent(withFirstThread, {
    sequence: 3,
    eventId: asEventId("evt-thread-create-2"),
    aggregateKind: "thread",
    aggregateId: asThreadId("thread-delete-2"),
    type: "thread.created",
    occurredAt: now,
    commandId: asCommandId("cmd-thread-create-2"),
    causationEventId: null,
    correlationId: asCommandId("cmd-thread-create-2"),
    metadata: {},
    payload: {
      threadId: asThreadId("thread-delete-2"),
      projectId: asProjectId("project-delete"),
      ownerUserId: DEFAULT_WORKSPACE_USER_ID,
      title: "Thread Delete 2",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      branch: null,
      worktreePath: null,
      createdAt: now,
      updatedAt: now,
    },
  });
});

const seedHierarchyReadModel = Effect.map(seedReadModel, (readModel) => {
  const template = readModel.threads[0];
  if (!template) return readModel;
  const archivedAt = "2026-01-02T00:00:00.000Z";
  const deletedAt = "2026-01-03T00:00:00.000Z";
  const root = { ...template, id: asThreadId("thread-root"), parentThreadId: null };
  const archivedChild = {
    ...template,
    id: asThreadId("thread-archived-child"),
    parentThreadId: root.id,
    archivedAt,
  };
  const activeGrandchild = {
    ...template,
    id: asThreadId("thread-active-grandchild"),
    parentThreadId: archivedChild.id,
  };
  const deletedChild = {
    ...template,
    id: asThreadId("thread-deleted-child"),
    parentThreadId: root.id,
    deletedAt,
  };
  const sibling = { ...template, id: asThreadId("thread-sibling"), parentThreadId: null };
  return {
    ...readModel,
    threads: [root, archivedChild, activeGrandchild, deletedChild, sibling],
  };
});

it.layer(NodeServices.layer)("decider deletion flows", (it) => {
  it.effect("deletes active and archived descendants child-first without touching siblings", () =>
    Effect.gen(function* () {
      const readModel = yield* seedHierarchyReadModel;
      const commandId = asCommandId("cmd-delete-cascade");
      const result = yield* decideOrchestrationCommand({
        command: { type: "thread.delete", commandId, threadId: asThreadId("thread-root") },
        readModel,
      });
      const events = Array.isArray(result) ? result : [result];

      expect(events.map((event) => event.aggregateId)).toEqual([
        asThreadId("thread-active-grandchild"),
        asThreadId("thread-archived-child"),
        asThreadId("thread-root"),
      ]);
      expect(events.every((event) => event.type === "thread.deleted")).toBe(true);
      expect(events.every((event) => event.commandId === commandId)).toBe(true);
      expect(new Set(events.map((event) => event.occurredAt)).size).toBe(1);
    }),
  );

  it.effect(
    "archives active grandchildren beneath archived descendants and skips deleted nodes",
    () =>
      Effect.gen(function* () {
        const readModel = yield* seedHierarchyReadModel;
        const result = yield* decideOrchestrationCommand({
          command: {
            type: "thread.archive",
            commandId: asCommandId("cmd-archive-cascade"),
            threadId: asThreadId("thread-root"),
          },
          readModel,
        });
        const events = Array.isArray(result) ? result : [result];

        expect(events.map((event) => event.aggregateId)).toEqual([
          asThreadId("thread-active-grandchild"),
          asThreadId("thread-root"),
        ]);
        expect(events.every((event) => event.type === "thread.archived")).toBe(true);
        expect(new Set(events.map((event) => event.occurredAt)).size).toBe(1);
      }),
  );

  it.effect(
    "unarchives independently archived descendants while skipping active and deleted nodes",
    () =>
      Effect.gen(function* () {
        const seeded = yield* seedHierarchyReadModel;
        const readModel = {
          ...seeded,
          threads: seeded.threads.map((thread) =>
            thread.id === asThreadId("thread-root")
              ? { ...thread, archivedAt: "2026-01-04T00:00:00.000Z" }
              : thread,
          ),
        };
        const result = yield* decideOrchestrationCommand({
          command: {
            type: "thread.unarchive",
            commandId: asCommandId("cmd-unarchive-cascade"),
            threadId: asThreadId("thread-root"),
          },
          readModel,
        });
        const events = Array.isArray(result) ? result : [result];

        expect(events.map((event) => event.aggregateId)).toEqual([
          asThreadId("thread-archived-child"),
          asThreadId("thread-root"),
        ]);
        expect(events.every((event) => event.type === "thread.unarchived")).toBe(true);
        expect(new Set(events.map((event) => event.occurredAt)).size).toBe(1);
      }),
  );

  it.effect("keeps leaf thread lifecycle operations to one event", () =>
    Effect.gen(function* () {
      const readModel = yield* seedHierarchyReadModel;
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.delete",
          commandId: asCommandId("cmd-delete-leaf"),
          threadId: asThreadId("thread-sibling"),
        },
        readModel,
      });
      expect(Array.isArray(result) ? result : [result]).toHaveLength(1);
    }),
  );

  it.effect("rejects deleting a non-empty project without force", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          command: {
            type: "project.delete",
            commandId: asCommandId("cmd-project-delete-no-force"),
            projectId: asProjectId("project-delete"),
          },
          readModel,
        }),
      );
      expect(error.message).toContain("cannot be deleted without force=true");
    }),
  );

  it.effect("force-deletes each active thread once in hierarchy post-order", () =>
    Effect.gen(function* () {
      const seeded = yield* seedReadModel;
      const parent = seeded.threads[0];
      const child = seeded.threads[1];
      if (!parent || !child) return;
      const readModel = {
        ...seeded,
        threads: [parent, { ...child, parentThreadId: parent.id }],
      };
      const projectDeleteCommand: Extract<OrchestrationCommand, { type: "project.delete" }> = {
        type: "project.delete",
        commandId: asCommandId("cmd-project-delete-force"),
        projectId: asProjectId("project-delete"),
        force: true,
      };

      const forcedResult = yield* decideOrchestrationCommand({
        command: projectDeleteCommand,
        readModel,
      });
      const forcedEvents = Array.isArray(forcedResult) ? forcedResult : [forcedResult];

      expect(forcedEvents.map((event) => event.type)).toEqual([
        "thread.deleted",
        "thread.deleted",
        "project.deleted",
      ]);
      expect(
        forcedEvents.map((event) =>
          event.type === "thread.deleted" ? event.payload.threadId : event.payload.projectId,
        ),
      ).toEqual([child.id, parent.id, asProjectId("project-delete")]);
      expect(new Set(forcedEvents.map((event) => event.aggregateId)).size).toBe(3);
      expect(new Set(forcedEvents.map((event) => event.occurredAt).values()).size).toBe(1);
    }),
  );
});
