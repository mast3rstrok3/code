import {
  CommandId,
  DEFAULT_WORKSPACE_USER_ID,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const SETTLED_AT = "2025-12-30T00:00:00.000Z";

function makeThread(input: {
  readonly id: string;
  readonly parentThreadId: string | null;
  readonly settledOverride?: OrchestrationThread["settledOverride"];
  readonly archivedAt?: string | null;
}): OrchestrationThread {
  const settledOverride = input.settledOverride ?? null;
  return {
    id: ThreadId.make(input.id),
    projectId: ProjectId.make("project-1"),
    ownerUserId: DEFAULT_WORKSPACE_USER_ID,
    parentThreadId: input.parentThreadId === null ? null : ThreadId.make(input.parentThreadId),
    workflowRole: null,
    title: input.id,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: input.archivedAt ?? null,
    settledOverride,
    settledAt: settledOverride === "settled" ? SETTLED_AT : null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    planningWorkflow: null,
    appReviews: [],
    activities: [],
    checkpoints: [],
    session: null,
  };
}

function makeReadModel(threads: ReadonlyArray<OrchestrationThread>): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    implementationRuns: [],
    threads: [...threads],
    updatedAt: NOW,
  };
}

function resumeCommand(threadId: string) {
  return {
    type: "thread.workflow.resume" as const,
    commandId: CommandId.make(`cmd-resume-${threadId}`),
    threadId: ThreadId.make(threadId),
    createdAt: NOW,
  };
}

it.layer(NodeServices.layer)("workflow resume decider", (it) => {
  it.effect("un-settles the whole paused subtree so recovery can re-enter it", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: resumeCommand("root"),
        readModel: makeReadModel([
          makeThread({ id: "root", parentThreadId: null, settledOverride: "settled" }),
          makeThread({ id: "orchestrator", parentThreadId: "root", settledOverride: "settled" }),
          makeThread({ id: "worker", parentThreadId: "orchestrator", settledOverride: "settled" }),
        ]),
      });
      const events = Array.isArray(result) ? result : [result];

      expect(events.map((event) => event.type)).toEqual([
        "thread.unsettled",
        "thread.unsettled",
        "thread.unsettled",
      ]);
      const byThread = new Map(
        events.map((event) => [
          (event.payload as { readonly threadId: string }).threadId,
          (event.payload as { readonly reason: string }).reason,
        ]),
      );
      // The resumed thread is pinned active; its descendants take the neutral
      // reset so they can settle again on their own.
      expect(byThread.get("root")).toBe("user");
      expect(byThread.get("orchestrator")).toBe("activity");
      expect(byThread.get("worker")).toBe("activity");
    }),
  );

  it.effect("leaves threads that were never paused alone", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: resumeCommand("root"),
        readModel: makeReadModel([
          makeThread({ id: "root", parentThreadId: null, settledOverride: "settled" }),
          makeThread({ id: "running-child", parentThreadId: "root" }),
          makeThread({ id: "pinned-child", parentThreadId: "root", settledOverride: "active" }),
        ]),
      });
      const events = Array.isArray(result) ? result : [result];

      expect(
        events.map((event) => (event.payload as { readonly threadId: string }).threadId),
      ).toEqual(["root"]);
    }),
  );

  it.effect("skips archived descendants", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: resumeCommand("root"),
        readModel: makeReadModel([
          makeThread({ id: "root", parentThreadId: null, settledOverride: "settled" }),
          makeThread({
            id: "archived-worker",
            parentThreadId: "root",
            settledOverride: "settled",
            archivedAt: NOW,
          }),
        ]),
      });
      const events = Array.isArray(result) ? result : [result];

      expect(
        events.map((event) => (event.payload as { readonly threadId: string }).threadId),
      ).toEqual(["root"]);
    }),
  );

  it.effect("emits nothing when the workflow is already running", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: resumeCommand("root"),
        readModel: makeReadModel([
          makeThread({ id: "root", parentThreadId: null }),
          makeThread({ id: "worker", parentThreadId: "root" }),
        ]),
      });
      const events = Array.isArray(result) ? result : [result];

      expect(events).toEqual([]);
    }),
  );
});
