import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  type PreviewAutomationStreamEvent,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as PreviewAutomationBroker from "../mcp/PreviewAutomationBroker.ts";
import {
  runPreviewAutomationRequests,
  servePreviewAutomationRequests,
} from "./ServerPreviewAutomationHost.ts";

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

  it.effect("re-registers with the broker after a timed-out request evicts it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const broker = yield* PreviewAutomationBroker.make.pipe(Effect.provide(NodeServices.layer));
        const environmentId = EnvironmentId.make("environment-1");
        const scope = {
          environmentId,
          requestNamespace: "provider-session-1",
          thread: {
            threadId: ThreadId.make("thread-1"),
            providerSessionId: "provider-session-1",
            providerInstanceId: ProviderInstanceId.make("codex"),
          },
          client: undefined,
          capabilities: new Set(["preview"] as const),
          issuedAt: 1,
        };
        const clientId = "server-preview:environment-1";
        const connected = yield* Deferred.make<void>();
        const reconnected = yield* Deferred.make<void>();
        const firstReceived = yield* Deferred.make<void>();
        let connections = 0;
        let requests = 0;
        const events = (yield* broker.connect({ clientId, environmentId })).pipe(
          Stream.tap((event) => {
            if (event.type !== "connected") return Effect.void;
            connections += 1;
            return Deferred.succeed(connections === 1 ? connected : reconnected, undefined);
          }),
        );

        yield* servePreviewAutomationRequests(events, (event) => {
          requests += 1;
          // Leave the first request unanswered so the broker evicts the host.
          return requests === 1
            ? Deferred.succeed(firstReceived, undefined)
            : broker.respond({
                clientId,
                connectionId: event.connectionId,
                requestId: event.request.requestId,
                ok: true,
                result: { available: true },
              });
        }).pipe(Effect.forkScoped);

        yield* Deferred.await(connected);
        const timedOut = yield* broker
          .invoke<void>({ scope, operation: "waitFor", input: {}, timeoutMs: 1_000 })
          .pipe(Effect.flip, Effect.forkScoped);
        yield* Deferred.await(firstReceived);
        yield* TestClock.adjust(1_000);
        expect(yield* Fiber.join(timedOut)).toMatchObject({
          _tag: "PreviewAutomationTimeoutError",
        });

        yield* Deferred.await(reconnected);
        expect(
          yield* broker.invoke({ scope, operation: "status", input: {}, timeoutMs: 1_000 }),
        ).toEqual({ available: true });
      }),
    ),
  );
});
