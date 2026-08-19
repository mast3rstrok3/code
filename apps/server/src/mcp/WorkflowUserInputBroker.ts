import { type ProviderUserInputAnswers, type ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SynchronizedRef from "effect/SynchronizedRef";

/**
 * Why the answers came back: the user answered, or the request died with the
 * turn or session that opened it.
 */
export type WorkflowUserInputOutcome =
  | { readonly _tag: "answered"; readonly answers: ProviderUserInputAnswers }
  | { readonly _tag: "cancelled"; readonly reason: string };

interface PendingWorkflowUserInput {
  readonly threadId: ThreadId;
  readonly deferred: Deferred.Deferred<WorkflowUserInputOutcome>;
}

/**
 * Parks an MCP `workflow_request_user_input` call until the user answers it.
 *
 * The Codex adapter owns its structured questions natively, so its pending
 * requests never reach this broker. Providers that ask through the T3 MCP
 * server (Claude, Grok, OpenCode) have no such channel: their tool call blocks
 * here while the question rides the ordinary `user-input.requested` activity to
 * the clients, and `ProviderService.respondToUserInput` routes the answer back
 * before it looks for a provider-owned request.
 */
export class WorkflowUserInputBroker extends Context.Service<
  WorkflowUserInputBroker,
  {
    /** Register a request and wait for its outcome. */
    readonly awaitAnswers: (input: {
      readonly threadId: ThreadId;
      readonly requestId: string;
    }) => Effect.Effect<WorkflowUserInputOutcome>;
    /** Resolve a pending request. `false` means this broker does not own it. */
    readonly respond: (input: {
      readonly threadId: ThreadId;
      readonly requestId: string;
      readonly answers: ProviderUserInputAnswers;
    }) => Effect.Effect<boolean>;
    /** Drop a request without answering it (interrupt, abandoned tool call). */
    readonly release: (input: {
      readonly requestId: string;
      readonly reason: string;
    }) => Effect.Effect<void>;
    /** Drop every request a thread still holds (session stop, thread deleted). */
    readonly cancelThread: (input: {
      readonly threadId: ThreadId;
      readonly reason: string;
    }) => Effect.Effect<void>;
  }
>()("t3/mcp/WorkflowUserInputBroker") {}

const make = Effect.gen(function* () {
  const state = yield* SynchronizedRef.make(new Map<string, PendingWorkflowUserInput>());

  const settle = (
    requestId: string,
    outcome: WorkflowUserInputOutcome,
    threadId?: ThreadId,
  ): Effect.Effect<boolean> =>
    SynchronizedRef.modify(state, (current) => {
      const pending = current.get(requestId);
      if (!pending || (threadId !== undefined && pending.threadId !== threadId)) {
        return [undefined, current] as const;
      }
      const next = new Map(current);
      next.delete(requestId);
      return [pending, next] as const;
    }).pipe(
      Effect.flatMap((pending) =>
        pending === undefined
          ? Effect.succeed(false)
          : Deferred.succeed(pending.deferred, outcome).pipe(Effect.as(true)),
      ),
    );

  const awaitAnswers: WorkflowUserInputBroker["Service"]["awaitAnswers"] = Effect.fn(
    "WorkflowUserInputBroker.awaitAnswers",
  )(function* (input) {
    const deferred = yield* Deferred.make<WorkflowUserInputOutcome>();
    yield* SynchronizedRef.update(state, (current) => {
      const next = new Map(current);
      next.set(input.requestId, { threadId: input.threadId, deferred });
      return next;
    });
    return yield* Deferred.await(deferred).pipe(
      Effect.onInterrupt(() =>
        settle(input.requestId, { _tag: "cancelled", reason: "interrupted" }).pipe(Effect.asVoid),
      ),
    );
  });

  const respond: WorkflowUserInputBroker["Service"]["respond"] = (input) =>
    settle(input.requestId, { _tag: "answered", answers: input.answers }, input.threadId);

  const release: WorkflowUserInputBroker["Service"]["release"] = (input) =>
    settle(input.requestId, { _tag: "cancelled", reason: input.reason }).pipe(Effect.asVoid);

  const cancelThread: WorkflowUserInputBroker["Service"]["cancelThread"] = (input) =>
    SynchronizedRef.modify(state, (current) => {
      const cancelled: Array<PendingWorkflowUserInput> = [];
      const next = new Map(current);
      for (const [requestId, pending] of current) {
        if (pending.threadId !== input.threadId) continue;
        cancelled.push(pending);
        next.delete(requestId);
      }
      return [cancelled, next] as const;
    }).pipe(
      Effect.flatMap((cancelled) =>
        Effect.forEach(
          cancelled,
          (pending) =>
            Deferred.succeed(pending.deferred, {
              _tag: "cancelled" as const,
              reason: input.reason,
            }),
          { concurrency: "unbounded", discard: true },
        ),
      ),
    );

  return WorkflowUserInputBroker.of({ awaitAnswers, respond, release, cancelThread });
}).pipe(Effect.withSpan("WorkflowUserInputBroker.make"));

export const layer = Layer.effect(WorkflowUserInputBroker, make);
