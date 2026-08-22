import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

import { makeDrainableWorker, makeKeyedDrainableWorker } from "./DrainableWorker.ts";

describe("makeDrainableWorker", () => {
  it.live("waits for work enqueued during active processing before draining", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const processed: string[] = [];
        const firstStarted = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();
        const secondStarted = yield* Deferred.make<void>();
        const releaseSecond = yield* Deferred.make<void>();

        const worker = yield* makeDrainableWorker((item: string) =>
          Effect.gen(function* () {
            if (item === "first") {
              yield* Deferred.succeed(firstStarted, undefined).pipe(Effect.orDie);
              yield* Deferred.await(releaseFirst);
            }

            if (item === "second") {
              yield* Deferred.succeed(secondStarted, undefined).pipe(Effect.orDie);
              yield* Deferred.await(releaseSecond);
            }

            processed.push(item);
          }),
        );

        yield* worker.enqueue("first");
        yield* Deferred.await(firstStarted);

        const drained = yield* Deferred.make<void>();
        yield* Effect.forkChild(
          worker.drain.pipe(
            Effect.tap(() => Deferred.succeed(drained, undefined).pipe(Effect.orDie)),
          ),
        );

        yield* worker.enqueue("second");
        yield* Deferred.succeed(releaseFirst, undefined);
        yield* Deferred.await(secondStarted);

        expect(yield* Deferred.isDone(drained)).toBe(false);

        yield* Deferred.succeed(releaseSecond, undefined);
        yield* Deferred.await(drained);

        expect(processed).toEqual(["first", "second"]);
      }),
    ),
  );
});

describe("makeKeyedDrainableWorker", () => {
  it.live("keeps one key ordered without blocking another key", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const processed: string[] = [];
        const firstStarted = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();
        const secondStarted = yield* Deferred.make<void>();
        const otherStarted = yield* Deferred.make<void>();

        const worker = yield* makeKeyedDrainableWorker({
          key: (item: { key: string; value: string }) => item.key,
          process: (item) =>
            Effect.gen(function* () {
              processed.push(`${item.key}:${item.value}`);
              if (item.value === "first") {
                yield* Deferred.succeed(firstStarted, undefined).pipe(Effect.orDie);
                yield* Deferred.await(releaseFirst);
              }
              if (item.value === "second") {
                yield* Deferred.succeed(secondStarted, undefined).pipe(Effect.orDie);
              }
              if (item.key === "other") {
                yield* Deferred.succeed(otherStarted, undefined).pipe(Effect.orDie);
              }
            }),
        });

        yield* worker.enqueue({ key: "busy", value: "first" });
        yield* Deferred.await(firstStarted);
        yield* worker.enqueue({ key: "busy", value: "second" });
        yield* worker.enqueue({ key: "other", value: "only" });

        yield* Deferred.await(otherStarted);
        expect(yield* Deferred.isDone(secondStarted)).toBe(false);

        yield* Deferred.succeed(releaseFirst, undefined);
        yield* Deferred.await(secondStarted);
        yield* worker.drain;

        expect(processed).toEqual(["busy:first", "other:only", "busy:second"]);
      }),
    ),
  );
});
