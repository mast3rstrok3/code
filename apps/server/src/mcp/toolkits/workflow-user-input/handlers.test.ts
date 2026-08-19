import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  WORKFLOW_USER_INPUT_ABANDON_GRACE_MS,
  WORKFLOW_USER_INPUT_WAIT_WINDOW_MS,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

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
      assert.strictEqual(result.status, "answered");
      const answers = result.status === "answered" ? result.answers : [];
      assert.deepStrictEqual(answers[0], { questionId: "question_1", answers: ["Broad"] });
      assert.deepStrictEqual(answers[1], { questionId: "question_2", answers: ["Focused"] });
      assert.deepStrictEqual(answers[2], { questionId: "question_3", answers: [] });

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

  it.effect("hands back a resume id when a round runs out of time, keeping one card up", () => {
    const environment = makeEnvironment();
    return Effect.gen(function* () {
      const broker = yield* WorkflowUserInputBroker.WorkflowUserInputBroker;
      const questions = [question(1)];
      const first = yield* handlers
        .workflow_request_user_input({ questions })
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.millis(WORKFLOW_USER_INPUT_WAIT_WINDOW_MS + 1));

      const waiting = yield* Fiber.join(first);
      assert.strictEqual(waiting.status, "waiting");
      const resumeRequestId = waiting.status === "waiting" ? waiting.resumeRequestId : "";
      assert.strictEqual(resumeRequestId, requestIdOf(environment.commands));
      // The card the user is reading must not be closed or asked twice.
      assert.deepStrictEqual(
        activitiesOf(environment.commands).map((activity) => activity.kind),
        ["user-input.requested"],
      );

      const resumed = yield* handlers
        .workflow_request_user_input({ questions, resumeRequestId })
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      assert.deepStrictEqual(
        activitiesOf(environment.commands).map((activity) => activity.kind),
        ["user-input.requested"],
      );

      yield* broker.respond({
        threadId,
        requestId: resumeRequestId,
        answers: { question_1: "Broad" },
      });
      const result = yield* Fiber.join(resumed);
      assert.strictEqual(result.status, "answered");
      assert.deepStrictEqual(result.status === "answered" ? result.answers[0] : undefined, {
        questionId: "question_1",
        answers: ["Broad"],
      });
      assert.strictEqual(activitiesOf(environment.commands).at(-1)?.kind, "user-input.resolved");
    }).pipe(Effect.provide(environment.layer), Effect.scoped);
  });

  it.effect("retires a card the agent never came back to", () => {
    const environment = makeEnvironment();
    return Effect.gen(function* () {
      const pending = yield* handlers
        .workflow_request_user_input({ questions: [question(1)] })
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.millis(WORKFLOW_USER_INPUT_WAIT_WINDOW_MS + 1));
      yield* Fiber.join(pending);

      yield* TestClock.adjust(Duration.millis(WORKFLOW_USER_INPUT_ABANDON_GRACE_MS + 1));
      yield* Effect.yieldNow;
      const resolved = activitiesOf(environment.commands).at(-1);
      assert.strictEqual(resolved?.kind, "user-input.resolved");
      assert.strictEqual(resolved?.summary, "User input cancelled");
    }).pipe(Effect.provide(environment.layer), Effect.scoped);
  });

  it.effect("refuses a resume id that no longer has a question behind it", () => {
    const environment = makeEnvironment();
    return Effect.gen(function* () {
      const error = yield* handlers
        .workflow_request_user_input({
          questions: [question(1)],
          resumeRequestId: "workflow-user-input-gone",
        })
        .pipe(Effect.flip);
      assert.strictEqual(error._tag, "WorkflowUserInputError");
      assert.deepStrictEqual(activitiesOf(environment.commands), []);
    }).pipe(Effect.provide(environment.layer), Effect.scoped);
  });
});
