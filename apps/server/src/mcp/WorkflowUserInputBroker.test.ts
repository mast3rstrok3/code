import { it } from "@effect/vitest";
import { ThreadId, type UserInputQuestion } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import * as NodeAssert from "node:assert/strict";

import * as WorkflowUserInputBroker from "./WorkflowUserInputBroker.ts";

const threadId = ThreadId.make("thread-1");
const otherThreadId = ThreadId.make("thread-2");

const WAIT_FOR = 60_000;

const questions: ReadonlyArray<UserInputQuestion> = [
  {
    id: "question-1",
    header: "Scope",
    question: "How wide should the change be?",
    options: [
      { label: "Focused", description: "Only the reported path." },
      { label: "Complete", description: "Every affected path." },
    ],
    multiSelect: false,
  },
];

const withBroker = <A, E>(
  body: (
    broker: WorkflowUserInputBroker.WorkflowUserInputBroker["Service"],
  ) => Effect.Effect<A, E, Scope.Scope>,
) =>
  Effect.gen(function* () {
    const broker = yield* WorkflowUserInputBroker.WorkflowUserInputBroker;
    return yield* body(broker);
  }).pipe(Effect.provide(WorkflowUserInputBroker.layer), Effect.scoped) as Effect.Effect<A, E>;

it.effect("hands a parked request the answers submitted for it", () =>
  withBroker((broker) =>
    Effect.gen(function* () {
      const parked = yield* broker
        .awaitAnswers({ threadId, requestId: "request-1", questions, waitFor: WAIT_FOR })
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      const handled = yield* broker.respond({
        threadId,
        requestId: "request-1",
        answers: { "question-1": "Focused" },
      });
      NodeAssert.equal(handled, true);
      const outcome = yield* Fiber.join(parked);
      NodeAssert.deepEqual(outcome, {
        _tag: "answered",
        answers: { "question-1": "Focused" },
      });
    }),
  ),
);

it.effect("reports requests it does not own so the provider adapters still see them", () =>
  withBroker((broker) =>
    Effect.gen(function* () {
      const handled = yield* broker.respond({
        threadId,
        requestId: "codex-owned-request",
        answers: {},
      });
      NodeAssert.equal(handled, false);
    }),
  ),
);

it.effect("does not answer a request registered for another thread", () =>
  withBroker((broker) =>
    Effect.gen(function* () {
      const parked = yield* broker
        .awaitAnswers({ threadId, requestId: "request-1", questions, waitFor: WAIT_FOR })
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      const handled = yield* broker.respond({
        threadId: otherThreadId,
        requestId: "request-1",
        answers: { "question-1": "Focused" },
      });
      NodeAssert.equal(handled, false);
      yield* broker.release({ requestId: "request-1", reason: "test cleanup" });
      yield* Fiber.join(parked);
    }),
  ),
);

it.effect("cancels every request a thread still holds when its session ends", () =>
  withBroker((broker) =>
    Effect.gen(function* () {
      const first = yield* broker
        .awaitAnswers({ threadId, requestId: "request-1", questions, waitFor: WAIT_FOR })
        .pipe(Effect.forkChild);
      const second = yield* broker
        .awaitAnswers({ threadId, requestId: "request-2", questions, waitFor: WAIT_FOR })
        .pipe(Effect.forkChild);
      const untouched = yield* broker
        .awaitAnswers({
          threadId: otherThreadId,
          requestId: "request-3",
          questions,
          waitFor: WAIT_FOR,
        })
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;

      yield* broker.cancelThread({ threadId, reason: "the provider session ended" });
      NodeAssert.deepEqual(yield* Fiber.join(first), {
        _tag: "cancelled",
        reason: "the provider session ended",
      });
      NodeAssert.deepEqual(yield* Fiber.join(second), {
        _tag: "cancelled",
        reason: "the provider session ended",
      });

      const stillParked = yield* broker.respond({
        threadId: otherThreadId,
        requestId: "request-3",
        answers: { "question-1": "Focused" },
      });
      NodeAssert.equal(stillParked, true);
      yield* Fiber.join(untouched);
    }),
  ),
);

it.effect("releases a request when the tool call that opened it is interrupted", () =>
  withBroker((broker) =>
    Effect.gen(function* () {
      const parked = yield* broker
        .awaitAnswers({ threadId, requestId: "request-1", questions, waitFor: WAIT_FOR })
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(parked);
      const handled = yield* broker.respond({
        threadId,
        requestId: "request-1",
        answers: { "question-1": "Focused" },
      });
      NodeAssert.equal(handled, false);
    }),
  ),
);

it.effect("returns waiting when a round's window closes and keeps the question open", () =>
  withBroker((broker) =>
    Effect.gen(function* () {
      const parked = yield* broker
        .awaitAnswers({ threadId, requestId: "request-1", questions, waitFor: WAIT_FOR })
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.millis(WAIT_FOR + 1));
      NodeAssert.deepEqual(yield* Fiber.join(parked), { _tag: "waiting" });

      // The card is still registered, so the next round parks on the same id.
      NodeAssert.deepEqual(
        yield* broker.pendingQuestions({ threadId, requestId: "request-1" }),
        Option.some(questions),
      );
      const resumed = yield* broker
        .awaitAnswers({ threadId, requestId: "request-1", questions, waitFor: WAIT_FOR })
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      NodeAssert.equal(
        yield* broker.respond({
          threadId,
          requestId: "request-1",
          answers: { "question-1": "Focused" },
        }),
        true,
      );
      NodeAssert.deepEqual(yield* Fiber.join(resumed), {
        _tag: "answered",
        answers: { "question-1": "Focused" },
      });
    }),
  ),
);

it.effect("holds an answer typed while no round is parked until the next one collects it", () =>
  withBroker((broker) =>
    Effect.gen(function* () {
      const parked = yield* broker
        .awaitAnswers({ threadId, requestId: "request-1", questions, waitFor: WAIT_FOR })
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.millis(WAIT_FOR + 1));
      yield* Fiber.join(parked);

      NodeAssert.equal(
        yield* broker.respond({
          threadId,
          requestId: "request-1",
          answers: { "question-1": "Complete" },
        }),
        true,
      );
      NodeAssert.deepEqual(
        yield* broker.awaitAnswers({
          threadId,
          requestId: "request-1",
          questions,
          waitFor: WAIT_FOR,
        }),
        { _tag: "answered", answers: { "question-1": "Complete" } },
      );
      NodeAssert.deepEqual(
        yield* broker.pendingQuestions({ threadId, requestId: "request-1" }),
        Option.none(),
      );
    }),
  ),
);

it.effect("reaps a question no round came back to, and reports what it was carrying", () =>
  withBroker((broker) =>
    Effect.gen(function* () {
      const parked = yield* broker
        .awaitAnswers({ threadId, requestId: "request-1", questions, waitFor: WAIT_FOR })
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;

      // A round still parked on it is never reaped out from under the agent.
      NodeAssert.deepEqual(
        yield* broker.reapIfUnwatched({ threadId, requestId: "request-1", reason: "abandoned" }),
        Option.none(),
      );

      yield* TestClock.adjust(Duration.millis(WAIT_FOR + 1));
      yield* Fiber.join(parked);
      NodeAssert.deepEqual(
        yield* broker.reapIfUnwatched({ threadId, requestId: "request-1", reason: "abandoned" }),
        Option.some({ _tag: "cancelled", reason: "abandoned" }),
      );
      NodeAssert.deepEqual(
        yield* broker.pendingQuestions({ threadId, requestId: "request-1" }),
        Option.none(),
      );
    }),
  ),
);
