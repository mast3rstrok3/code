import {
  CommandId,
  EventId,
  type OrchestrationReadModel,
  type OrchestrationThread,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";

import { ProviderSessionDirectory } from "../../provider/Services/ProviderSessionDirectory.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  StaleTurnReconciler,
  type StaleTurnReconcilerShape,
} from "../Services/StaleTurnReconciler.ts";

const DEFAULT_SWEEP_INTERVAL_MS = 60 * 1000;
const DEFAULT_GRACE_MS = 60 * 1000;
const DEFAULT_CONFIRM_DELAY_MS = 15 * 1000;

const STALE_TURN_ERROR_MESSAGE =
  "Provider session lost while a turn was running; settled by the stale-turn reconciler.";

export interface StaleTurnReconcilerLiveOptions {
  readonly sweepIntervalMs?: number;
  readonly graceMs?: number;
  readonly confirmDelayMs?: number;
}

interface SweepOptions {
  readonly graceMs: number;
  readonly confirmDelayMs: number;
}

interface StaleTurnCandidate {
  readonly threadId: ThreadId;
  readonly pinnedTurnId: TurnId | null;
}

/**
 * A thread looks orphaned when its projected session or latest turn still
 * claims a turn is in flight. Whether it actually is orphaned is decided by
 * cross-checking against the live provider session list.
 */
function hasRunningTurnSignature(thread: OrchestrationThread): boolean {
  const session = thread.session;
  const sessionActive =
    session !== null &&
    (session.status === "running" ||
      session.status === "starting" ||
      session.activeTurnId !== null);
  return sessionActive || thread.latestTurn?.state === "running";
}

function pinTurnId(thread: OrchestrationThread): TurnId | null {
  return thread.session?.activeTurnId ?? thread.latestTurn?.turnId ?? null;
}

const makeStaleTurnReconciler = (options?: StaleTurnReconcilerLiveOptions) =>
  Effect.gen(function* () {
    const orchestrationEngine = yield* OrchestrationEngineService;
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const providerService = yield* ProviderService;
    const directory = yield* ProviderSessionDirectory;
    const crypto = yield* Crypto.Crypto;

    const sweepIntervalMs = Math.max(1, options?.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS);
    const graceMs = Math.max(0, options?.graceMs ?? DEFAULT_GRACE_MS);
    const confirmDelayMs = Math.max(0, options?.confirmDelayMs ?? DEFAULT_CONFIRM_DELAY_MS);

    const staleTurnCommandId = (tag: string, threadId: ThreadId, pinnedTurnId: TurnId | null) =>
      pinnedTurnId !== null
        ? Effect.succeed(CommandId.make(`server:stale-turn:${tag}:${threadId}:${pinnedTurnId}`))
        : crypto.randomUUIDv4.pipe(
            Effect.map((uuid) => CommandId.make(`server:stale-turn:${tag}:${threadId}:${uuid}`)),
          );

    const appendFailureActivity = Effect.fn("StaleTurnReconciler.appendFailureActivity")(
      function* (input: {
        readonly threadId: ThreadId;
        readonly pinnedTurnId: TurnId;
        readonly tag: string;
        readonly kind: string;
        readonly summary: string;
        readonly payload: unknown;
        readonly createdAt: string;
      }) {
        yield* orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId: yield* staleTurnCommandId(input.tag, input.threadId, input.pinnedTurnId),
          threadId: input.threadId,
          activity: {
            id: EventId.make(yield* crypto.randomUUIDv4),
            tone: "error",
            kind: input.kind,
            summary: input.summary,
            payload: input.payload,
            turnId: null,
            createdAt: input.createdAt,
          },
          createdAt: input.createdAt,
        });
      },
    );

    /**
     * Synthesize the failure directive the ImplementationWorkflowReactor
     * listens for, so a dead workflow-role turn flips its run to
     * `needs-human-attention` instead of hanging forever. Roles without a
     * failure directive (planning/product/batch children) settle only.
     */
    const propagateWorkflowFailure = Effect.fn("StaleTurnReconciler.propagateWorkflowFailure")(
      function* (input: {
        readonly readModel: OrchestrationReadModel;
        readonly thread: OrchestrationThread;
        readonly pinnedTurnId: TurnId | null;
        readonly createdAt: string;
      }) {
        const { readModel, thread, pinnedTurnId, createdAt } = input;
        if (pinnedTurnId === null) return;

        switch (thread.workflowRole) {
          case "implementation-worker": {
            const run = readModel.implementationRuns.find((candidate) =>
              candidate.ticketStates.some((state) => state.workerThreadId === thread.id),
            );
            const ticketState = run?.ticketStates.find(
              (state) => state.workerThreadId === thread.id,
            );
            if (run === undefined || ticketState === undefined) return;
            if (ticketState.status !== "running") return;
            yield* appendFailureActivity({
              threadId: thread.id,
              pinnedTurnId,
              tag: "worker-result",
              kind: "implementation-worker-result",
              summary: `Worker ${ticketState.ticketId} failed`,
              payload: {
                type: "implementation-worker-result",
                status: "failed",
                ticketId: ticketState.ticketId,
                workerThreadId: thread.id,
                branch: ticketState.branch ?? "unknown",
                worktreePath: ticketState.worktreePath ?? "unknown",
                validations: [],
                notesMarkdown: STALE_TURN_ERROR_MESSAGE,
                reportedAt: createdAt,
                commitSha: null,
              },
              createdAt,
            });
            return;
          }
          case "implementation-validator": {
            const run = readModel.implementationRuns.find(
              (candidate) =>
                candidate.orchestratorThreadId === thread.parentThreadId &&
                candidate.status === "validating",
            );
            if (run === undefined) return;
            yield* appendFailureActivity({
              threadId: thread.id,
              pinnedTurnId,
              tag: "merge-gate-result",
              kind: "implementation-merge-gate-result",
              summary: "Merge gate failed",
              payload: {
                type: "implementation-merge-gate-result",
                runId: run.id,
                status: "failed",
                validations: [],
                summaryMarkdown: STALE_TURN_ERROR_MESSAGE,
              },
              createdAt,
            });
            return;
          }
          case "implementation-fixer": {
            const run = readModel.implementationRuns.find(
              (candidate) =>
                candidate.orchestratorThreadId === thread.parentThreadId &&
                (candidate.status === "fixing" || candidate.status === "code-review-fixing"),
            );
            if (run === undefined) return;
            yield* appendFailureActivity({
              threadId: thread.id,
              pinnedTurnId,
              tag: "fix-result",
              kind: "implementation-fix-result",
              summary: "Implementation fix failed",
              payload: {
                type: "implementation-fix-result",
                runId: run.id,
                status: "failed",
                validations: [],
                notesMarkdown: STALE_TURN_ERROR_MESSAGE,
              },
              createdAt,
            });
            return;
          }
          case "implementation-code-reviewer": {
            const run = readModel.implementationRuns.find(
              (candidate) =>
                candidate.orchestratorThreadId === thread.parentThreadId &&
                candidate.status === "code-reviewing",
            );
            if (run === undefined) return;
            yield* appendFailureActivity({
              threadId: thread.id,
              pinnedTurnId,
              tag: "code-review-result",
              kind: "implementation-code-review-result",
              summary: "Implementation code review blocked",
              payload: {
                type: "implementation-code-review-result",
                runId: run.id,
                status: "blocked",
                reportMarkdown: STALE_TURN_ERROR_MESSAGE,
              },
              createdAt,
            });
            return;
          }
          default:
            return;
        }
      },
    );

    const settleThread = Effect.fn("StaleTurnReconciler.settleThread")(function* (input: {
      readonly readModel: OrchestrationReadModel;
      readonly thread: OrchestrationThread;
      readonly pinnedTurnId: TurnId | null;
      readonly updatedAt: string;
    }) {
      const { thread, pinnedTurnId, updatedAt } = input;

      // Propagate first: if the process dies mid-candidate, the still-running
      // turn is re-detected on the next boot and receipt dedup keeps the
      // synthesized directive exactly-once.
      yield* propagateWorkflowFailure({
        readModel: input.readModel,
        thread,
        pinnedTurnId,
        createdAt: updatedAt,
      });

      yield* orchestrationEngine.dispatch({
        type: "thread.session.set",
        commandId: yield* staleTurnCommandId("settle", thread.id, pinnedTurnId),
        threadId: thread.id,
        session: {
          threadId: thread.id,
          status: "error",
          providerName: thread.session?.providerName ?? null,
          ...(thread.session?.providerInstanceId !== undefined
            ? { providerInstanceId: thread.session.providerInstanceId }
            : {}),
          runtimeMode: thread.session?.runtimeMode ?? thread.runtimeMode,
          activeTurnId: null,
          lastError: STALE_TURN_ERROR_MESSAGE,
          updatedAt,
        },
        createdAt: updatedAt,
      });

      yield* directory.getBinding(thread.id).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.void,
            onSome: (binding) =>
              binding.status === "stopped"
                ? Effect.void
                : directory.upsert({ ...binding, status: "stopped" }),
          }),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("stale-turn.reconciler.binding-hygiene-failed", {
            threadId: thread.id,
            cause,
          }),
        ),
      );

      yield* Effect.logInfo("stale-turn.reconciler.settled", {
        threadId: thread.id,
        turnId: pinnedTurnId,
        workflowRole: thread.workflowRole,
      });
    });

    const sweep = (sweepOptions: SweepOptions) =>
      Effect.gen(function* () {
        const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
        const liveSessions = yield* providerService.listSessions();
        const liveThreadIds = new Set<ThreadId>(liveSessions.map((session) => session.threadId));
        const now = yield* Clock.currentTimeMillis;

        const candidates: StaleTurnCandidate[] = [];
        for (const thread of readModel.threads) {
          if (thread.deletedAt !== null) continue;
          if (!hasRunningTurnSignature(thread)) continue;
          if (liveThreadIds.has(thread.id)) continue;

          if (sweepOptions.graceMs > 0) {
            const referenceIso = thread.session?.updatedAt ?? thread.updatedAt;
            const referenceMs = Date.parse(referenceIso);
            if (Number.isNaN(referenceMs)) {
              yield* Effect.logWarning("stale-turn.reconciler.invalid-session-updated-at", {
                threadId: thread.id,
                updatedAt: referenceIso,
              });
              continue;
            }
            if (now - referenceMs < sweepOptions.graceMs) continue;
          }

          candidates.push({ threadId: thread.id, pinnedTurnId: pinTurnId(thread) });
        }

        if (candidates.length === 0) {
          return;
        }

        if (sweepOptions.confirmDelayMs > 0) {
          yield* Effect.sleep(Duration.millis(sweepOptions.confirmDelayMs));
        }

        // Re-fetch after the confirm delay: a candidate whose turn completed
        // (or changed) in the window is dropped instead of clobbered.
        const confirmedModel = yield* projectionSnapshotQuery.getCommandReadModel();
        const confirmedLiveSessions = yield* providerService.listSessions();
        const confirmedLiveThreadIds = new Set<ThreadId>(
          confirmedLiveSessions.map((session) => session.threadId),
        );
        const updatedAt = DateTime.formatIso(yield* DateTime.now);

        let settledCount = 0;
        for (const candidate of candidates) {
          const thread = confirmedModel.threads.find((entry) => entry.id === candidate.threadId);
          if (thread === undefined || thread.deletedAt !== null) continue;
          if (!hasRunningTurnSignature(thread)) continue;
          if (confirmedLiveThreadIds.has(thread.id)) continue;
          if (pinTurnId(thread) !== candidate.pinnedTurnId) continue;

          const settled = yield* settleThread({
            readModel: confirmedModel,
            thread,
            pinnedTurnId: candidate.pinnedTurnId,
            updatedAt,
          }).pipe(
            Effect.as(true),
            Effect.catchCause((cause) =>
              Effect.logWarning("stale-turn.reconciler.settle-failed", {
                threadId: candidate.threadId,
                turnId: candidate.pinnedTurnId,
                cause,
              }).pipe(Effect.as(false)),
            ),
          );
          if (settled) {
            settledCount += 1;
          }
        }

        if (settledCount > 0) {
          yield* Effect.logInfo("stale-turn.reconciler.sweep-complete", {
            settledCount,
            candidateCount: candidates.length,
          });
        }
      });

    const safeSweep = (sweepOptions: SweepOptions) =>
      sweep(sweepOptions).pipe(
        Effect.catch((error: unknown) =>
          Effect.logWarning("stale-turn.reconciler.sweep-failed", {
            error,
          }),
        ),
        Effect.catchDefect((defect: unknown) =>
          Effect.logWarning("stale-turn.reconciler.sweep-defect", {
            defect,
          }),
        ),
      );

    const start: StaleTurnReconcilerShape["start"] = () =>
      Effect.gen(function* () {
        yield* Effect.forkScoped(
          Effect.gen(function* () {
            // Boot pass: nothing is rehydrated at startup, so every running
            // session in the read model is an orphan — no grace, no confirm.
            yield* safeSweep({ graceMs: 0, confirmDelayMs: 0 });
            yield* safeSweep({ graceMs, confirmDelayMs }).pipe(
              Effect.repeat(Schedule.spaced(Duration.millis(sweepIntervalMs))),
            );
          }),
        );

        yield* Effect.logInfo("stale-turn.reconciler.started", {
          sweepIntervalMs,
          graceMs,
          confirmDelayMs,
        });
      });

    return {
      start,
    } satisfies StaleTurnReconcilerShape;
  });

export const makeStaleTurnReconcilerLive = (options?: StaleTurnReconcilerLiveOptions) =>
  Layer.effect(StaleTurnReconciler, makeStaleTurnReconciler(options));

export const StaleTurnReconcilerLive = makeStaleTurnReconcilerLive();
