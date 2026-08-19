import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as WorkflowUserInputBroker from "../../WorkflowUserInputBroker.ts";
import { handlers } from "./handlers.ts";

const threadId = ThreadId.make("thread-grill");
const turnId = TurnId.make("turn-1");

const question = (index: number) => ({
  id: `question_${index}`,
  header: `Header ${index}`,
  question: `Which shape should decision ${index} take?`,
  options: [
    { label: "Focused", description: "Keeps the change small." },
    { label: "Broad", description: "Covers more surfaces at once." },
  ],
  recommendation: {
    optionLabel: "Focused",
    rationale: "It creates a faster feedback loop.",
  },
});

const snapshotLayer = Layer.mock(ProjectionSnapshotQuery)({
  getThreadDetailById: () => Effect.succeed(Option.some({ id: threadId, latestTurn: { turnId } })),
} as unknown as Partial<ProjectionSnapshotQuery["Service"]>);

const activitiesOf = (commands: ReadonlyArray<OrchestrationCommand>) =>
  commands.flatMap((command) =>
    command.type === "thread.activity.append" ? [command.activity] : [],
  );

const requestIdOf = (commands: ReadonlyArray<OrchestrationCommand>) => {
  const payload = activitiesOf(commands)[0]?.payload as { readonly requestId: string } | undefined;
  return payload?.requestId ?? "";
};

/**
 * One grill thread's worth of environment: a recorded command log standing in
 * for the orchestration engine, plus the broker the parked tool call waits on.
 */
const makeEnvironment = (
  capabilities: ReadonlyArray<McpInvocationContext.McpCapability> = ["user-input"],
) => {
  const commands: Array<OrchestrationCommand> = [];
  const engineLayer = Layer.mock(OrchestrationEngineService)({
    dispatch: (command: OrchestrationCommand) =>
      Effect.sync(() => {
        commands.push(command);
        return { sequence: commands.length };
      }),
  });
  const invocationLayer = Layer.succeed(McpInvocationContext.McpInvocationContext, {
    environmentId: EnvironmentId.make("environment-1"),
    threadId,
    providerSessionId: "provider-session-1",
    providerInstanceId: ProviderInstanceId.make("claudeAgent"),
    capabilities: new Set(capabilities),
    issuedAt: 1,
  });
  return {
    commands,
    layer: Layer.mergeAll(
      WorkflowUserInputBroker.layer,
      snapshotLayer,
      invocationLayer,
      engineLayer,
    ),
  };
};

describe("workflow-user-input toolkit handlers", () => {
  it.effect("asks the whole frontier as one card and returns the user's answers", () => {
    const environment = makeEnvironment();
    return Effect.gen(function* () {
      const broker = yield* WorkflowUserInputBroker.WorkflowUserInputBroker;
      const questions = Array.from({ length: 10 }, (_, index) => question(index + 1));
      const pending = yield* handlers
        .workflow_request_user_input({ questions })
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;

      const requested = activitiesOf(environment.commands);
      assert.strictEqual(requested.length, 1);
      assert.strictEqual(requested[0]?.kind, "user-input.requested");
      assert.strictEqual(requested[0]?.turnId, turnId);
      const asked =
        (
          requested[0]?.payload as
            | {
                readonly questions: ReadonlyArray<{
                  readonly recommendation: { readonly optionLabel: string };
                }>;
              }
            | undefined
        )?.questions ?? [];
      assert.strictEqual(asked.length, 10);
      assert.strictEqual(asked[0]?.recommendation.optionLabel, "Focused");

      const handled = yield* broker.respond({
        threadId,
        requestId: requestIdOf(environment.commands),
        answers: { question_1: "Broad", question_2: ["Focused"] },
      });
      assert.strictEqual(handled, true);

      const result = yield* Fiber.join(pending);
      assert.deepStrictEqual(result.answers[0], { questionId: "question_1", answers: ["Broad"] });
      assert.deepStrictEqual(result.answers[1], { questionId: "question_2", answers: ["Focused"] });
      assert.deepStrictEqual(result.answers[2], { questionId: "question_3", answers: [] });

      assert.strictEqual(activitiesOf(environment.commands).at(-1)?.kind, "user-input.resolved");
    }).pipe(Effect.provide(environment.layer), Effect.scoped);
  });

  it.effect("clears the card and fails the call when the request is cancelled", () => {
    const environment = makeEnvironment();
    return Effect.gen(function* () {
      const broker = yield* WorkflowUserInputBroker.WorkflowUserInputBroker;
      const pending = yield* handlers
        .workflow_request_user_input({ questions: [question(1)] })
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;

      yield* broker.release({
        requestId: requestIdOf(environment.commands),
        reason: "the provider session ended",
      });

      const error = yield* Fiber.join(pending).pipe(Effect.flip);
      assert.strictEqual(error._tag, "WorkflowUserInputError");
      assert.strictEqual(activitiesOf(environment.commands).at(-1)?.kind, "user-input.resolved");
    }).pipe(Effect.provide(environment.layer), Effect.scoped);
  });

  it.effect("refuses to ask when the MCP credential does not grant user input", () => {
    const environment = makeEnvironment(["workflow-artifacts"]);
    return Effect.gen(function* () {
      const error = yield* handlers
        .workflow_request_user_input({ questions: [question(1)] })
        .pipe(Effect.flip);
      assert.strictEqual(error._tag, "PreviewAutomationUnavailableError");
      assert.deepStrictEqual(activitiesOf(environment.commands), []);
    }).pipe(Effect.provide(environment.layer), Effect.scoped);
  });
});
