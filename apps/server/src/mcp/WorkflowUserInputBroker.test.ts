import { it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as NodeAssert from "node:assert/strict";

import * as WorkflowUserInputBroker from "./WorkflowUserInputBroker.ts";

const threadId = ThreadId.make("thread-1");
const otherThreadId = ThreadId.make("thread-2");

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
        .awaitAnswers({ threadId, requestId: "request-1" })
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
        .awaitAnswers({ threadId, requestId: "request-1" })
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
        .awaitAnswers({ threadId, requestId: "request-1" })
        .pipe(Effect.forkChild);
      const second = yield* broker
        .awaitAnswers({ threadId, requestId: "request-2" })
        .pipe(Effect.forkChild);
      const untouched = yield* broker
        .awaitAnswers({ threadId: otherThreadId, requestId: "request-3" })
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
        .awaitAnswers({ threadId, requestId: "request-1" })
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
