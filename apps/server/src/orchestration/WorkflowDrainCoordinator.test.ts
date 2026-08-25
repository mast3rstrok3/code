import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import { ServerConfig } from "../config.ts";
import * as ServerLifecycleEvents from "../serverLifecycleEvents.ts";
import { WorkflowDrainCoordinator, layer } from "./WorkflowDrainCoordinator.ts";

const TestLayer = layer.pipe(
  Layer.provide(ServerLifecycleEvents.layer),
  Layer.provide(
    ServerConfig.layerTest(process.cwd(), {
      prefix: "t3-workflow-drain-test-",
    }),
  ),
  Layer.provide(NodeServices.layer),
);

it.layer(TestLayer)("WorkflowDrainCoordinator", (it) => {
  it.effect("coalesces requests and wakes every waiter when forced", () =>
    Effect.gen(function* () {
      const coordinator = yield* WorkflowDrainCoordinator;
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const runs = yield* Ref.make(0);
      const drain = Ref.update(runs, (value) => value + 1).pipe(
        Effect.andThen(Deferred.succeed(started, undefined)),
        Effect.andThen(Deferred.await(release)),
      );
      const input = {
        operationId: "drain-coalesced",
        requestedAt: "2026-01-01T00:00:00.000Z",
        deadlineAt: "2026-01-01T00:01:30.000Z",
        drain,
      } as const;

      const first = yield* Effect.forkChild(coordinator.requestDrain(input));
      yield* Deferred.await(started);
      const second = yield* Effect.forkChild(coordinator.requestDrain(input));
      const forced = yield* coordinator.force;
      const [firstResult, secondResult] = yield* Effect.all([
        Fiber.join(first),
        Fiber.join(second),
      ]);

      assert.equal(yield* Ref.get(runs), 1);
      assert.equal(forced.status, "forced");
      assert.deepEqual(secondResult, firstResult);
      assert.equal(firstResult.status, "forced");
    }),
  );

  it.effect("reports ready when all drain work finishes", () =>
    Effect.gen(function* () {
      const coordinator = yield* WorkflowDrainCoordinator;
      const result = yield* coordinator.requestDrain({
        operationId: "drain-ready",
        requestedAt: "2026-01-01T00:00:00.000Z",
        deadlineAt: "2026-01-01T00:01:30.000Z",
        drain: Effect.void,
      });

      assert.equal(result.status, "ready");
      assert.isFalse(yield* coordinator.accepting);
    }),
  );
});
