import { CommandId, EventId, ProjectId, type OrchestrationEvent } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const now = "2026-01-01T00:00:00.000Z";
const projectId = ProjectId.make("project-recording-mode");

const seedProjectCreated = (sequence: number): OrchestrationEvent => ({
  sequence,
  eventId: EventId.make(`evt-project-recording-mode-${sequence}`),
  aggregateKind: "project",
  aggregateId: projectId,
  type: "project.created",
  occurredAt: now,
  commandId: CommandId.make(`cmd-project-recording-mode-${sequence}`),
  causationEventId: null,
  correlationId: CommandId.make(`cmd-project-recording-mode-${sequence}`),
  metadata: {},
  payload: {
    projectId,
    title: "Recording mode",
    workspaceRoot: "/tmp/recording-mode",
    defaultModelSelection: null,
    scripts: [],
    createdAt: now,
    updatedAt: now,
  },
});

const metaUpdate = (commandId: string, previewRecordingMode: "auto" | "dom" | "video" | null) => ({
  type: "project.meta.update" as const,
  commandId: CommandId.make(commandId),
  projectId,
  previewRecordingMode,
});

it.layer(NodeServices.layer)("decider project previewRecordingMode", (it) => {
  it.effect("propagates previewRecordingMode through meta.update into the read model", () =>
    Effect.gen(function* () {
      const readModel = yield* projectEvent(createEmptyReadModel(now), seedProjectCreated(1));
      expect(readModel.projects[0]?.previewRecordingMode ?? null).toBeNull();

      const result = yield* decideOrchestrationCommand({
        command: metaUpdate("cmd-project-recording-mode-set", "video"),
        readModel,
      });

      const event = Array.isArray(result) ? result[0] : result;
      expect(event.type).toBe("project.meta-updated");
      expect((event.payload as { previewRecordingMode?: unknown }).previewRecordingMode).toBe(
        "video",
      );

      const updated = yield* projectEvent(readModel, { ...event, sequence: 2 });
      expect(updated.projects[0]?.previewRecordingMode).toBe("video");
    }),
  );

  it.effect("omits the field when unset and clears it on explicit null", () =>
    Effect.gen(function* () {
      const readModel = yield* projectEvent(createEmptyReadModel(now), seedProjectCreated(1));

      const unrelated = yield* decideOrchestrationCommand({
        command: {
          type: "project.meta.update",
          commandId: CommandId.make("cmd-project-recording-mode-title"),
          projectId,
          title: "Renamed",
        },
        readModel,
      });
      const unrelatedEvent = Array.isArray(unrelated) ? unrelated[0] : unrelated;
      expect("previewRecordingMode" in (unrelatedEvent.payload as object)).toBe(false);

      const set = yield* decideOrchestrationCommand({
        command: metaUpdate("cmd-project-recording-mode-set", "dom"),
        readModel,
      });
      const setEvent = Array.isArray(set) ? set[0] : set;
      const afterSet = yield* projectEvent(readModel, { ...setEvent, sequence: 2 });
      expect(afterSet.projects[0]?.previewRecordingMode).toBe("dom");

      const clear = yield* decideOrchestrationCommand({
        command: metaUpdate("cmd-project-recording-mode-clear", null),
        readModel: afterSet,
      });
      const clearEvent = Array.isArray(clear) ? clear[0] : clear;
      const afterClear = yield* projectEvent(afterSet, { ...clearEvent, sequence: 3 });
      expect(afterClear.projects[0]?.previewRecordingMode).toBeNull();
    }),
  );
});
