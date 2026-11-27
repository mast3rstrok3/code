import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import { AppReviewId, EMPTY_APP_REVIEW_EVIDENCE, ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { layerMemory as SqlitePersistenceMemory } from "../persistence/Sqlite.ts";
import { ProjectionThreadAppReviewRepositoryLive } from "../persistence/Layers/ProjectionThreadAppReviews.ts";
import { ProjectionThreadAppReviewRepository } from "../persistence/Services/ProjectionThreadAppReviews.ts";
import * as AppReviewStore from "./AppReviewStore.ts";

const threadId = ThreadId.make("thread-1");

const layer = it.layer(
  Layer.mergeAll(AppReviewStore.layer, ProjectionThreadAppReviewRepositoryLive).pipe(
    Layer.provideMerge(Layer.fresh(SqlitePersistenceMemory)),
    Layer.provideMerge(NodeCrypto.layer),
  ),
);

layer("AppReviewStore", (it) => {
  it.effect(
    "creates a review on first evidence, widens its scope, and starts fresh after a verdict",
    () =>
      Effect.gen(function* () {
        const store = yield* AppReviewStore.AppReviewStore;
        const thread = ThreadId.make("thread-lazy");

        const missing = yield* store.update({ threadId: thread }, Effect.succeed).pipe(Effect.flip);
        assert.match(missing.message, /no App Review yet/);

        const first = yield* store.update({ threadId: thread, evidence: "e2e" }, Effect.succeed);
        assert.strictEqual(first.sourceThreadId, thread);
        assert.strictEqual(first.reviewThreadId, thread);
        assert.strictEqual(first.appReviewScope, "e2e");
        assert.strictEqual(first.status, "running");

        const widened = yield* store.update(
          { threadId: thread, evidence: "browser" },
          Effect.succeed,
        );
        assert.strictEqual(widened.id, first.id);
        assert.strictEqual(widened.appReviewScope, "both");

        yield* store.update({ threadId: thread }, (record) =>
          Effect.succeed({ ...record, status: "passed" as const }),
        );
        const next = yield* store.update({ threadId: thread, evidence: "e2e" }, Effect.succeed);
        assert.notStrictEqual(next.id, first.id);
        assert.strictEqual(next.appReviewScope, "e2e");

        const records = yield* store.listForThread(thread);
        assert.deepStrictEqual(
          records.map((record) => [record.id, record.status]),
          [
            [first.id, "passed"],
            [next.id, "running"],
          ],
        );
        assert.strictEqual(Option.getOrNull(yield* store.active(thread))?.id, next.id);
      }),
  );

  it.effect("lists reviews a workflow ran for the thread but never writes to them", () =>
    Effect.gen(function* () {
      const store = yield* AppReviewStore.AppReviewStore;
      const repository = yield* ProjectionThreadAppReviewRepository;
      const legacyId = AppReviewId.make("legacy-review");
      yield* repository.upsert({
        reviewId: legacyId,
        sourceThreadId: threadId,
        reviewThreadId: ThreadId.make("workflow-reviewer"),
        appReviewScope: null,
        sourceTurnId: null,
        status: "running",
        document: {
          verdict: "pending",
          summary: "",
          checks: [],
          findings: [],
          questions: [],
          nextSteps: [],
        },
        evidence: EMPTY_APP_REVIEW_EVIDENCE,
        createdAt: "1969-12-31T00:00:00.000Z",
        updatedAt: "1969-12-31T00:00:00.000Z",
      });

      assert.isTrue(Option.isNone(yield* store.active(threadId)));
      const started = yield* store.start({ threadId, scope: "browser", brief: "Checkout flow" });
      assert.strictEqual(started.document.brief, "Checkout flow");
      assert.deepStrictEqual(
        (yield* store.listForThread(threadId)).map((record) => record.id),
        [legacyId, started.id],
      );
    }),
  );

  it.effect("streams the thread's reviews again after each change", () =>
    Effect.gen(function* () {
      const store = yield* AppReviewStore.AppReviewStore;
      const thread = ThreadId.make("thread-stream");
      const subscribed = yield* Deferred.make<void>();
      const fiber = yield* store.subscribeThread(thread).pipe(
        Stream.tap(() => Deferred.succeed(subscribed, undefined)),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Deferred.await(subscribed);
      yield* store.start({ threadId: ThreadId.make("thread-other"), scope: "e2e" });
      const started = yield* store.start({ threadId: thread, scope: "e2e" });
      const emissions = yield* Fiber.join(fiber);
      assert.deepStrictEqual(
        emissions.map((records) => records.map((record) => record.id)),
        [[], [started.id]],
      );
    }),
  );
});
