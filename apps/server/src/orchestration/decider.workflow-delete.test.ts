import {
  CommandId,
  ThreadId,
  type OrchestrationImplementationRun,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const rootId = ThreadId.make("workflow-root");
const orchestratorId = ThreadId.make("workflow-orchestrator");
const workerId = ThreadId.make("workflow-worker");

function thread(
  id: ThreadId,
  parentThreadId: ThreadId | null,
): Pick<OrchestrationThread, "id" | "parentThreadId" | "deletedAt"> {
  return { id, parentThreadId, deletedAt: null };
}

it.effect("cancels an active implementation run before deleting its workflow tree", () =>
  Effect.gen(function* () {
    const run = {
      id: "implementation-run-delete",
      orchestratorThreadId: orchestratorId,
      status: "fixing",
      retryableFailure: { stage: "app-dev-stack", reasonMarkdown: "repairing" },
      updatedAt: "2026-01-01T00:00:00.000Z",
    } as unknown as OrchestrationImplementationRun;
    const readModel = {
      threads: [
        thread(rootId, null),
        thread(orchestratorId, rootId),
        thread(workerId, orchestratorId),
      ],
      implementationRuns: [run],
    } as unknown as OrchestrationReadModel;

    const result = yield* decideOrchestrationCommand({
      command: {
        type: "thread.delete",
        commandId: CommandId.make("cmd-delete-active-workflow"),
        threadId: rootId,
      },
      readModel,
    });
    const events = Array.isArray(result) ? result : [result];

    expect(events.map((event) => event.type)).toEqual([
      "thread.implementation-run-cancel-requested",
      "thread.deleted",
      "thread.deleted",
      "thread.deleted",
    ]);
    const canceled = events[0];
    expect(canceled).toMatchObject({
      aggregateId: rootId,
      type: "thread.implementation-run-cancel-requested",
      payload: {
        sourceThreadId: rootId,
        run: {
          id: run.id,
          status: "canceled",
          retryableFailure: null,
        },
        reason: "Workflow thread deleted.",
      },
    });
  }).pipe(Effect.provide(NodeServices.layer)),
);
