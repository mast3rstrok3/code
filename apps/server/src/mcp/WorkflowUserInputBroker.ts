import {
  type ProviderUserInputAnswers,
  type ThreadId,
  type UserInputQuestion,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SynchronizedRef from "effect/SynchronizedRef";

/**
 * Why the answers came back: the user answered, the request died with the turn
 * or session that opened it, or this round's wait window closed with the
 * question still on screen.
 */
export type WorkflowUserInputOutcome =
  | { readonly _tag: "answered"; readonly answers: ProviderUserInputAnswers }
  | { readonly _tag: "cancelled"; readonly reason: string }
  | { readonly _tag: "waiting" };

/** An outcome a round can be retired with, so `waiting` is excluded. */
export type WorkflowUserInputSettledOutcome = Exclude<
  WorkflowUserInputOutcome,
  { readonly _tag: "waiting" }
>;

interface PendingWorkflowUserInput {
  readonly threadId: ThreadId;
  readonly questions: ReadonlyArray<UserInputQuestion>;
  readonly deferred: Deferred.Deferred<WorkflowUserInputOutcome>;
  /** How many tool calls are parked on this question right now. */
  readonly watchers: number;
  /** Set once the user answers, and cleared when an asker collects it. */
  readonly settled: WorkflowUserInputSettledOutcome | undefined;
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
 *
 * Those providers also cut a silent MCP call off after a few minutes, which is
 * shorter than a person takes to read a grill round. A wait therefore returns
 * `waiting` before the ceiling instead of dying on it: the question stays
 * registered, the card stays on screen with whatever the user has already
 * typed, and the agent parks on the same id again. An answer that lands while
 * no tool call is parked is held until the next asker collects it.
 */
export class WorkflowUserInputBroker extends Context.Service<
  WorkflowUserInputBroker,
  {
    /**
     * Register a request if it is new and wait up to `waitFor` milliseconds for
     * its outcome. `waiting` means the question is still open.
     */
    readonly awaitAnswers: (input: {
      readonly threadId: ThreadId;
      readonly requestId: string;
      readonly questions: ReadonlyArray<UserInputQuestion>;
      readonly waitFor: number;
    }) => Effect.Effect<WorkflowUserInputOutcome>;
    /** The questions a request was registered with, if it is still open. */
    readonly pendingQuestions: (input: {
      readonly threadId: ThreadId;
      readonly requestId: string;
    }) => Effect.Effect<Option.Option<ReadonlyArray<UserInputQuestion>>>;
    /** Resolve a pending request. `false` means this broker does not own it. */
    readonly respond: (input: {
      readonly threadId: ThreadId;
      readonly requestId: string;
      readonly answers: ProviderUserInputAnswers;
    }) => Effect.Effect<boolean>;
    /**
     * Retire a request no tool call came back to. The outcome it carried is
     * returned so the caller can close out the card the user is still looking
     * at; `None` means someone is still parked on it, or it is already gone.
     */
    readonly reapIfUnwatched: (input: {
      readonly threadId: ThreadId;
      readonly requestId: string;
      readonly reason: string;
    }) => Effect.Effect<Option.Option<WorkflowUserInputSettledOutcome>>;
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

  const withEntry = <A>(
    requestId: string,
    threadId: ThreadId | undefined,
    f: (
      entry: PendingWorkflowUserInput,
      current: Map<string, PendingWorkflowUserInput>,
    ) => readonly [A, Map<string, PendingWorkflowUserInput>],
    fallback: A,
  ): Effect.Effect<A> =>
    SynchronizedRef.modify(state, (current) => {
      const entry = current.get(requestId);
      if (!entry || (threadId !== undefined && entry.threadId !== threadId)) {
        return [fallback, current] as const;
      }
      return f(entry, current);
    });

  const replace = (
    current: Map<string, PendingWorkflowUserInput>,
    requestId: string,
    entry: PendingWorkflowUserInput,
  ) => {
    const next = new Map(current);
    next.set(requestId, entry);
    return next;
  };

  const remove = (current: Map<string, PendingWorkflowUserInput>, requestId: string) => {
    const next = new Map(current);
    next.delete(requestId);
    return next;
  };

  /**
   * Hand an outcome to whoever is parked on the request. An answered round
   * stays registered until an asker collects it, so an answer typed between two
   * parked calls is not lost in the gap.
   */
  const settle = (
    requestId: string,
    outcome: WorkflowUserInputSettledOutcome,
    threadId?: ThreadId,
  ): Effect.Effect<boolean> =>
    withEntry(
      requestId,
      threadId,
      (entry, current) =>
        [
          entry.deferred,
          outcome._tag === "answered"
            ? replace(current, requestId, { ...entry, settled: outcome })
            : remove(current, requestId),
        ] as const,
      undefined as Deferred.Deferred<WorkflowUserInputOutcome> | undefined,
    ).pipe(
      Effect.flatMap((deferred) =>
        deferred === undefined
          ? Effect.succeed(false)
          : Deferred.succeed(deferred, outcome).pipe(Effect.as(true)),
      ),
    );

  const awaitAnswers: WorkflowUserInputBroker["Service"]["awaitAnswers"] = Effect.fn(
    "WorkflowUserInputBroker.awaitAnswers",
  )(function* (input) {
    const created = yield* Deferred.make<WorkflowUserInputOutcome>();
    // Reusing the deferred a previous round left behind is what makes a resume
    // pick up an answer that arrived while nobody was parked.
    const deferred = yield* SynchronizedRef.modify(state, (current) => {
      const entry = current.get(input.requestId);
      if (entry && entry.threadId === input.threadId) {
        return [
          entry.deferred,
          replace(current, input.requestId, { ...entry, watchers: entry.watchers + 1 }),
        ] as const;
      }
      return [
        created,
        replace(current, input.requestId, {
          threadId: input.threadId,
          questions: input.questions,
          deferred: created,
          watchers: 1,
          settled: undefined,
        }),
      ] as const;
    });

    const unwatch = withEntry(
      input.requestId,
      input.threadId,
      (entry, current) =>
        [
          undefined,
          replace(current, input.requestId, {
            ...entry,
            watchers: Math.max(0, entry.watchers - 1),
          }),
        ] as const,
      undefined,
    ).pipe(Effect.asVoid);

    const outcome = yield* Deferred.await(deferred).pipe(
      Effect.timeoutOption(input.waitFor),
      Effect.onInterrupt(() =>
        settle(input.requestId, { _tag: "cancelled", reason: "interrupted" }).pipe(Effect.asVoid),
      ),
    );
    yield* unwatch;
    if (Option.isNone(outcome)) {
      return { _tag: "waiting" as const };
    }
    // Collected: the asker owns the outcome from here, so the round retires.
    yield* SynchronizedRef.update(state, (current) => remove(current, input.requestId));
    return outcome.value;
  });

  const pendingQuestions: WorkflowUserInputBroker["Service"]["pendingQuestions"] = (input) =>
    SynchronizedRef.get(state).pipe(
      Effect.map((current) => {
        const entry = current.get(input.requestId);
        return entry && entry.threadId === input.threadId
          ? Option.some(entry.questions)
          : Option.none();
      }),
    );

  const respond: WorkflowUserInputBroker["Service"]["respond"] = (input) =>
    settle(input.requestId, { _tag: "answered", answers: input.answers }, input.threadId);

  const reapIfUnwatched: WorkflowUserInputBroker["Service"]["reapIfUnwatched"] = (input) =>
    withEntry(
      input.requestId,
      input.threadId,
      (entry, current) =>
        entry.watchers > 0
          ? ([Option.none(), current] as const)
          : ([
              Option.some(
                entry.settled ?? { _tag: "cancelled" as const, reason: input.reason },
              ) as Option.Option<WorkflowUserInputSettledOutcome>,
              remove(current, input.requestId),
            ] as const),
      Option.none() as Option.Option<WorkflowUserInputSettledOutcome>,
    );

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

  return WorkflowUserInputBroker.of({
    awaitAnswers,
    pendingQuestions,
    respond,
    reapIfUnwatched,
    release,
    cancelThread,
  });
}).pipe(Effect.withSpan("WorkflowUserInputBroker.make"));

export const layer = Layer.effect(WorkflowUserInputBroker, make);
