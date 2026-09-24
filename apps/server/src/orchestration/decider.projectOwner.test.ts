import {
  CommandId,
  DEFAULT_WORKSPACE_USER_ID,
  EventId,
  ProjectId,
  WorkspaceUserId,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const alex = WorkspaceUserId.make("alex");
const projectId = ProjectId.make("project-owner");
const now = "2026-01-01T00:00:00.000Z";

it.layer(NodeServices.layer)("decider project owner", (it) => {
  it.effect("project.create records the owner on project.created", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "project.create",
          commandId: CommandId.make("cmd-project-create-owner"),
          projectId,
          ownerUserId: alex,
          title: "Owned",
          workspaceRoot: "/tmp/owned",
          createdAt: now,
        },
        readModel: createEmptyReadModel(now),
      });

      const event = Array.isArray(result) ? result[0] : result;
      expect(event.type).toBe("project.created");
      expect((event.payload as { ownerUserId: string }).ownerUserId).toBe(alex);
    }),
  );

  it.effect("project.meta.update changes the owner and leaves it alone when absent", () =>
    Effect.gen(function* () {
      const readModel = yield* projectEvent(createEmptyReadModel(now), {
        sequence: 1,
        eventId: EventId.make("evt-project-create-owner"),
        aggregateKind: "project",
        aggregateId: projectId,
        type: "project.created",
        occurredAt: now,
        commandId: CommandId.make("cmd-project-create-owner"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-project-create-owner"),
        metadata: {},
        payload: {
          projectId,
          ownerUserId: DEFAULT_WORKSPACE_USER_ID,
          title: "Owned",
          workspaceRoot: "/tmp/owned",
          defaultModelSelection: null,
          faviconPath: null,
          projectIcon: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });
      expect(readModel.projects[0]?.ownerUserId).toBe(DEFAULT_WORKSPACE_USER_ID);

      const changed = yield* decideOrchestrationCommand({
        command: {
          type: "project.meta.update",
          commandId: CommandId.make("cmd-project-owner-change"),
          projectId,
          ownerUserId: alex,
        },
        readModel,
      });
      const changedEvent = Array.isArray(changed) ? changed[0] : changed;
      expect(changedEvent.type).toBe("project.meta-updated");
      expect((changedEvent.payload as { ownerUserId?: string }).ownerUserId).toBe(alex);
      const afterChange = yield* projectEvent(readModel, {
        ...changedEvent,
        sequence: 2,
        eventId: EventId.make("evt-project-owner-change"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-project-owner-change"),
        metadata: {},
      });
      expect(afterChange.projects[0]?.ownerUserId).toBe(alex);

      const renamed = yield* decideOrchestrationCommand({
        command: {
          type: "project.meta.update",
          commandId: CommandId.make("cmd-project-rename"),
          projectId,
          title: "Renamed",
        },
        readModel: afterChange,
      });
      const renamedEvent = Array.isArray(renamed) ? renamed[0] : renamed;
      expect("ownerUserId" in (renamedEvent.payload as object)).toBe(false);
    }),
  );
});
