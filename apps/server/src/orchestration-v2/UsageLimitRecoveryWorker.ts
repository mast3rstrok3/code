import {
  CommandId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2Command,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadShell,
  type ServerSettings as ServerSettingsValue,
  type ThreadId,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Scheduler from "../scheduling/Scheduler.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

const describeModel = (selection: ModelSelection) => `${selection.model} (${selection.instanceId})`;

/**
 * A workflow agent thread that hit a usage limit on a model other than the one its workflow
 * started on continues on that starting model instead of waiting for the limit to reset.
 * `usage_limit` is the only failure class that means "this account cannot run now": the
 * adapters file rate limits, spent quota and exhausted credits under it. A thread already on
 * the starting model has nothing to fall back to, so it parks until the reset as before.
 */
export function workflowStartingModelFallback(input: {
  readonly thread: Pick<
    OrchestrationV2ThreadShell,
    | "id"
    | "status"
    | "lastErrorClass"
    | "latestRunId"
    | "modelSelection"
    | "workflowRole"
    | "workflowContext"
    | "lineage"
    | "archivedAt"
    | "deletedAt"
    | "settledOverride"
    | "pendingRuntimeRequest"
  >;
  readonly root: Pick<
    OrchestrationV2ThreadShell,
    "id" | "modelSelection" | "workflowPreset" | "deletedAt"
  > | null;
  readonly settings: ServerSettingsValue;
}): OrchestrationV2Command | null {
  const { thread, root } = input;
  if (
    thread.status !== "failed" ||
    thread.lastErrorClass !== "usage_limit" ||
    !thread.latestRunId ||
    (thread.workflowRole ?? null) === null ||
    thread.archivedAt !== null ||
    thread.deletedAt !== null ||
    thread.settledOverride === "settled" ||
    thread.pendingRuntimeRequest !== null ||
    root === null ||
    root.id === thread.id ||
    root.deletedAt !== null ||
    (root.workflowPreset ?? null) === null
  )
    return null;
  const failed = thread.modelSelection;
  const starting = root.modelSelection;
  // The limit is the account's (instance) or the model's; the same pair would hit it again.
  if (failed.instanceId === starting.instanceId && failed.model === starting.model) return null;
  if (!ServerSettings.isProviderInstanceEnabled(input.settings, starting.instanceId)) return null;
  const identity = `${thread.id}:${thread.latestRunId}`;
  return {
    type: "message.dispatch",
    commandId: CommandId.make(`limit-fallback:${identity}`),
    messageId: MessageId.make(`limit-fallback:${identity}`),
    threadId: thread.id,
    manualContinuationOfRunId: thread.latestRunId,
    modelSelection: starting,
    text: `${describeModel(failed)} hit its usage limit, so this step continues on ${describeModel(starting)}, the model this workflow started on. Continue where you left off.`,
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "system",
    creationSource: "server",
  };
}

/** Nested runs carry their root in the workflow context; agent threads otherwise sit under it. */
const workflowRootId = (thread: OrchestrationV2ThreadShell): ThreadId =>
  thread.workflowContext?.rootThreadId ?? thread.lineage.rootThreadId;

export const makeWorkflowModelFallback = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const settings = yield* ServerSettings.ServerSettingsService;
  const evaluate = Effect.fn("UsageLimitRecoveryWorker.workflowModelFallback")(function* (
    threadId: ThreadId,
  ) {
    const thread = yield* orchestrator.getThreadShell(threadId);
    if (thread === null || (thread.workflowRole ?? null) === null) return;
    const rootId = workflowRootId(thread);
    const root = rootId === thread.id ? null : yield* orchestrator.getThreadShell(rootId);
    const command = workflowStartingModelFallback({
      thread,
      root,
      settings: yield* settings.getSettings,
    });
    if (command !== null) yield* threads.dispatch(command);
  });
  const worker = yield* makeDrainableWorker((threadId: ThreadId) =>
    evaluate(threadId).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("orchestration-v2.limit-fallback.dispatch-failed", {
              threadId,
              cause,
            }),
      ),
    ),
  );
  return {
    /** Re-reads one thread and moves it to its workflow's starting model when it should. */
    evaluate: worker.enqueue,
    drain: worker.drain,
    onEvent: (event: OrchestrationV2DomainEvent) =>
      event.type === "run.updated" && event.payload.status === "failed"
        ? worker.enqueue(event.threadId)
        : Effect.void,
    /** Threads that failed while the server was down; their failure event is gone. */
    reconcile: orchestrator.getShellSnapshot({ unsettledOnly: true }).pipe(
      Effect.flatMap((snapshot) =>
        Effect.forEach(
          snapshot.threads.filter(
            (thread) =>
              thread.lastErrorClass === "usage_limit" && (thread.workflowRole ?? null) !== null,
          ),
          (thread) => worker.enqueue(thread.id),
          { discard: true },
        ),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("orchestration-v2.limit-fallback.reconcile-failed", { cause }),
      ),
    ),
  };
});

export function limitRecoveryCommand(
  thread: ProjectionStore.ProjectionLimitRecoveryCandidate,
  autoResume: boolean,
  nowMs: number,
  snooze = false,
): OrchestrationV2Command | null {
  if (
    thread.status !== "failed" ||
    thread.lastErrorClass !== "usage_limit" ||
    !thread.latestRunId ||
    !thread.usageLimitResetAt ||
    thread.archivedAt !== null ||
    thread.settledOverride === "settled" ||
    thread.pendingRuntimeRequest !== null
  )
    return null;
  const resetMs = Date.parse(thread.usageLimitResetAt);
  // An already-expired window reported with a fresh failure cannot start a retry loop.
  if (
    !Number.isFinite(resetMs) ||
    resetMs <= DateTime.toEpochMillis(thread.latestRunCompletedAt ?? thread.updatedAt)
  )
    return null;
  const identity = `${thread.id}:${thread.latestRunId}:${resetMs}`;
  const recovery = thread.limitRecovery;
  if (recovery?.runId !== thread.latestRunId || recovery.resetAt !== thread.usageLimitResetAt) {
    if (!autoResume && (!snooze || resetMs <= nowMs)) return null;
    return {
      type: "thread.metadata.update",
      commandId: CommandId.make(`limit-arm:${identity}`),
      threadId: thread.id,
      limitRecovery: {
        runId: thread.latestRunId,
        resetAt: thread.usageLimitResetAt,
        autoResume,
        snooze: snooze && resetMs > nowMs,
      },
    };
  }
  if (
    !recovery.autoResume ||
    resetMs > nowMs ||
    (thread.snoozedUntil != null && DateTime.toEpochMillis(thread.snoozedUntil) > nowMs)
  )
    return null;
  const deliveryIdentity = `${identity}:${recovery.requestId ?? "legacy"}`;
  return {
    type: "message.dispatch",
    commandId: CommandId.make(`limit-resume:${deliveryIdentity}`),
    messageId: MessageId.make(`limit-resume:${deliveryIdentity}`),
    threadId: thread.id,
    usageLimitContinuationOfRunId: thread.latestRunId,
    ...(recovery.requestId === undefined
      ? {}
      : { usageLimitRecoveryRequestId: recovery.requestId }),
    text: "Continue where you left off.",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "server",
  };
}

const makeSweep = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const settings = yield* ServerSettings.ServerSettingsService;
  return Effect.fn("UsageLimitRecoveryWorker.sweep")(function* () {
    const preferences = yield* settings.getSettings;
    const now = yield* DateTime.now;
    const candidates = yield* projections.getLimitRecoveryCandidates({
      now,
      autoResume: preferences.autoResumeLimitedThreads,
      snooze: preferences.snoozeLimitedThreads,
    });
    const nowMs = DateTime.toEpochMillis(now);
    for (const thread of candidates) {
      const command = limitRecoveryCommand(
        thread,
        preferences.autoResumeLimitedThreads,
        nowMs,
        preferences.snoozeLimitedThreads,
      );
      if (command === null) continue;
      yield* Effect.gen(function* () {
        if (command.type === "thread.metadata.update" && command.limitRecovery != null) {
          yield* orchestrator.autoArmLimitRecovery({
            commandId: command.commandId,
            threadId: command.threadId,
            limitRecovery: command.limitRecovery,
          });
        } else {
          yield* threads.dispatch(command);
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("orchestration-v2.limit-recovery.dispatch-failed", {
            threadId: thread.id,
            cause,
          }),
        ),
      );
    }
  });
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sweep = yield* makeSweep;
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("usage-limit-recovery", sweep());
    const fallback = yield* makeWorkflowModelFallback;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* forkParked(
      fallback.reconcile.pipe(
        Effect.andThen(Stream.runForEach(orchestrator.streamDomainEvents, fallback.onEvent)),
        Effect.catchCause((cause) =>
          Effect.logWarning("orchestration-v2.limit-fallback.stream-failed", { cause }),
        ),
      ),
    );
  }),
);
