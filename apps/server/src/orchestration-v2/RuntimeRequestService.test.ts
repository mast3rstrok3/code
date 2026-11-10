import { assert, it, vi } from "@effect/vitest";
import {
  NodeId,
  ProviderSessionId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";

import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as RuntimeRequestService from "./RuntimeRequestService.ts";
import * as WorkflowUserInputBroker from "../mcp/WorkflowUserInputBroker.ts";

it.effect.each(["expired", "resolved"] as const)(
  "responds only to resolved requests and preserves feedback (%s)",
  (status) => {
    const threadId = ThreadId.make("thread-runtime-request-expired");
    const providerSessionId = ProviderSessionId.make("provider-session-runtime-request-expired");
    const requestId = RuntimeRequestId.make("request-expired");
    const respondToRuntimeRequest = vi.fn(
      (_input: ProviderAdapter.ProviderAdapterV2RuntimeRequestResponseInput) => Effect.void,
    );
    const getSession = vi.fn(() =>
      Effect.succeedSome({
        respondToRuntimeRequest,
      } as never),
    );
    const projection = {
      runtimeRequests: [
        {
          id: requestId,
          nodeId: NodeId.make("node-runtime-request-expired"),
          providerTurnId: null,
          nativeRequestRef: null,
          kind: "command",
          status,
          responseCapability: {
            type: "live",
            providerSessionId,
          },
          createdAt: DateTime.makeUnsafe("2026-07-29T00:00:00.000Z"),
          resolvedAt: DateTime.makeUnsafe("2026-07-29T00:00:01.000Z"),
        },
      ],
    } as unknown as OrchestrationV2ThreadProjection;
    const layerTest = RuntimeRequestService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getRuntimeRequest: (_threadId, requestId) =>
              Effect.succeed(
                projection.runtimeRequests.find((request) => request.id === requestId),
              ),
          }),
          Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
            get: getSession,
          }),
          WorkflowUserInputBroker.layer,
        ),
      ),
    );

    return Effect.gen(function* () {
      const service = yield* RuntimeRequestService.RuntimeRequestServiceV2;
      const response = service.respond({
        threadId,
        providerSessionId,
        requestId,
        decision: "decline",
        feedback: "Use an explicit path.",
      });
      if (status === "resolved") {
        yield* response;
        assert.deepEqual(respondToRuntimeRequest.mock.calls, [
          [
            {
              requestId,
              decision: "decline",
              feedback: "Use an explicit path.",
            },
          ],
        ]);
        return;
      }
      const error = yield* response.pipe(Effect.flip);

      assert.equal(error.reason, "request-not-ready");
      assert.equal(
        error.message,
        `Runtime request ${requestId} on thread ${threadId} is not ready for response execution.`,
      );
      assert.isUndefined(error.cause);
      assert.equal(getSession.mock.calls.length, 0);
      assert.equal(respondToRuntimeRequest.mock.calls.length, 0);
    }).pipe(Effect.provide(layerTest));
  },
);

it.effect("hands a workflow question's answer to its parked tool call, not the provider", () => {
  const threadId = ThreadId.make("thread-workflow-question");
  const providerSessionId = ProviderSessionId.make("provider-session-workflow-question");
  const requestId = RuntimeRequestId.make("workflow-user-input-session-1");
  const getSession = vi.fn(() => Effect.succeedNone);
  const layerTest = RuntimeRequestService.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getRuntimeRequest: () =>
            Effect.succeed({
              id: requestId,
              nodeId: NodeId.make("node-workflow-question"),
              providerTurnId: null,
              nativeRequestRef: null,
              kind: "user_input",
              status: "resolved",
              responseCapability: { type: "live", providerSessionId },
              createdAt: DateTime.makeUnsafe("2026-11-10T00:00:00.000Z"),
              resolvedAt: DateTime.makeUnsafe("2026-11-10T00:00:01.000Z"),
            }),
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({ get: getSession }),
        WorkflowUserInputBroker.layer,
      ),
    ),
  );

  return Effect.gen(function* () {
    const broker = yield* WorkflowUserInputBroker.WorkflowUserInputBroker;
    const service = yield* RuntimeRequestService.RuntimeRequestServiceV2;
    const parked = yield* broker
      .awaitAnswers({ threadId, requestId, questions: [], waitFor: 60_000 })
      .pipe(Effect.forkChild({ startImmediately: true }));

    yield* service.respond({
      threadId,
      providerSessionId,
      requestId,
      answers: { voice: ["Fold into Phone"] },
    });

    assert.deepEqual(yield* Fiber.join(parked), {
      _tag: "answered",
      answers: { voice: ["Fold into Phone"] },
    });
    assert.equal(getSession.mock.calls.length, 0);
  }).pipe(Effect.provide(layerTest));
});
