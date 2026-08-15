import { describe, it } from "@effect/vitest";
import { type PreviewAutomationStreamEvent, ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";

import { runPreviewAutomationRequests } from "./ServerPreviewAutomationHost.ts";

const requestEvent = (requestId: string): PreviewAutomationStreamEvent => ({
  type: "request",
  connectionId: "connection-1",
  request: {
    requestId,
    threadId: ThreadId.make(`thread-${requestId}`),
    operation: "status",
    input: {},
    timeoutMs: 15_000,
  },
});

describe("ServerPreviewAutomationHost", () => {
  it.effect("does not let one slow workflow block another workflow's browser request", () =>
    Effect.gen(function* () {
      const firstStarted = yield* Deferred.make<void>();
      const releaseFirst = yield* Deferred.make<void>();
      const secondCompleted = yield* Deferred.make<void>();
      const events = Stream.fromIterable([
        requestEvent("slow-request"),
        requestEvent("independent-request"),
      ]);

      const processing = yield* runPreviewAutomationRequests(events, (event) =>
        event.request.requestId === "slow-request"
          ? Deferred.succeed(firstStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseFirst)),
            )
          : Deferred.succeed(secondCompleted, undefined),
      ).pipe(Effect.forkScoped);

      yield* Deferred.await(firstStarted);
      yield* Deferred.await(secondCompleted).pipe(Effect.timeout("1 second"));
      yield* Deferred.succeed(releaseFirst, undefined);
      yield* Fiber.join(processing);
    }),
  );
});
