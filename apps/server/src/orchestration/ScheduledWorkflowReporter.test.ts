import { assert, describe, it } from "@effect/vitest";
import {
  type OrchestrationImplementationRun,
  type OrchestrationV2ServerCommand,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import {
  layer as reporterLayer,
  scheduledWorkflowMilestone,
  ScheduledWorkflowReporter,
} from "./ScheduledWorkflowReporter.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";

const rootId = ThreadId.make("thread-feedback-root");

const pullRequest = (url: string) => ({ url }) as OrchestrationImplementationRun["changeRequest"];

const run = (overrides: Partial<Record<keyof OrchestrationImplementationRun, unknown>> = {}) =>
  ({
    id: "run-1",
    status: "babysitting-change-request",
    automationHalt: null,
    changeRequest: pullRequest("https://github.com/org/app/pull/7"),
    repositories: [],
    ...overrides,
  }) as unknown as OrchestrationImplementationRun;

describe("scheduledWorkflowMilestone", () => {
  it("names every opened pull request once the babysitter takes over", () => {
    const milestone = scheduledWorkflowMilestone(
      run({
        repositories: [
          { changeRequest: pullRequest("https://github.com/org/api/pull/3") },
          { changeRequest: null },
        ],
      }),
    );
    assert.strictEqual(milestone?.key, "pull-requests");
    assert.include(milestone?.text, "- https://github.com/org/app/pull/7");
    assert.include(milestone?.text, "- https://github.com/org/api/pull/3");
    assert.include(milestone?.text, "babysits them");
  });

  it("waits until a pull request exists and is handed on", () => {
    assert.isNull(scheduledWorkflowMilestone(run({ status: "code-reviewing" })));
    assert.isNull(scheduledWorkflowMilestone(run({ status: "publishing-change-request" })));
    assert.isNull(scheduledWorkflowMilestone(run({ changeRequest: null })));
  });

  it("reports a halt with its reason, keyed by when it happened", () => {
    const milestone = scheduledWorkflowMilestone(
      run({
        status: "needs-human-attention",
        changeRequest: null,
        automationHalt: {
          stage: "final-code-review",
          category: "retry-exhausted",
          detail: "Code Review kept failing.",
          haltedAt: "2026-10-27T10:00:00.000Z",
        },
      }),
    );
    assert.strictEqual(milestone?.key, "halt:2026-10-27T10:00:00.000Z");
    assert.include(milestone?.text, "Code Review kept failing.");
  });
});

function makeSystem(firstMessage: { readonly scheduledTaskId?: string }) {
  const commands: OrchestrationV2ServerCommand[] = [];
  const layer = reporterLayer.pipe(
    Layer.provide(
      Layer.mock(OrchestratorV2)({
        dispatch: (command) =>
          Effect.sync(() => {
            commands.push(command);
            return { sequence: commands.length, storedEvents: [] };
          }),
        // Each dispatched turn shows up as a user message, as the projection would record it.
        getThreadRecords: ((id: ThreadId) =>
          Effect.succeed({
            thread: { id },
            messages: [
              { id: "task-message", role: "user", ...firstMessage },
              ...commands.flatMap((command) =>
                command.type === "message.dispatch"
                  ? [{ id: command.messageId, role: "user" }]
                  : [],
              ),
            ],
          } as never)) as never,
      }),
    ),
    Layer.provide(Layer.mock(OrchestrationEngineService)({ streamDomainEvents: Stream.empty })),
  );
  const report = (input: OrchestrationImplementationRun) =>
    Effect.gen(function* () {
      const reporter = yield* ScheduledWorkflowReporter;
      yield* reporter.report({ rootThreadId: rootId, run: input });
      yield* reporter.drain;
    });
  return { layer, report, commands };
}

describe("ScheduledWorkflowReporter", () => {
  it.effect("posts one turn into a scheduled task's root when its pull request opens", () => {
    const system = makeSystem({ scheduledTaskId: "scheduled-task:feedback" });
    return Effect.gen(function* () {
      yield* system.report(run());
      yield* system.report(run());
      assert.strictEqual(system.commands.length, 1);
      const [command] = system.commands;
      assert.strictEqual(command?.type, "message.dispatch");
      if (command?.type !== "message.dispatch") return;
      assert.strictEqual(command.threadId, rootId);
      assert.strictEqual(command.commandId, "scheduled-workflow-report:run-1:pull-requests");
      assert.include(command.text, "https://github.com/org/app/pull/7");

      // A later halt is its own milestone.
      yield* system.report(
        run({
          status: "needs-human-attention",
          automationHalt: {
            stage: "integration",
            category: "stage-failed",
            detail: "The merge failed.",
            haltedAt: "2026-10-27T11:00:00.000Z",
          },
        }),
      );
      assert.strictEqual(system.commands.length, 2);
    }).pipe(Effect.provide(system.layer));
  });

  it.effect("leaves a root a person started alone", () => {
    const system = makeSystem({});
    return Effect.gen(function* () {
      yield* system.report(run());
      assert.strictEqual(system.commands.length, 0);
    }).pipe(Effect.provide(system.layer));
  });
});
