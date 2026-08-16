import {
  CommandId,
  AppReviewId,
  EventId,
  MessageId,
  type OrchestrationProposedPlanId,
  type OrchestrationReadModel,
  type OrchestrationThread,
  type OrchestrationThreadWorkflowRole,
  type ProviderInteractionMode,
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
import {
  appendWorkflowSkillCommandSection,
  WORKFLOW_PROMPT_IDS,
} from "../../provider/WorkflowPromptRegistry.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  StaleTurnReconciler,
  type StaleTurnReconcilerShape,
} from "../Services/StaleTurnReconciler.ts";

const DEFAULT_SWEEP_INTERVAL_MS = 60 * 1000;
const DEFAULT_GRACE_MS = 60 * 1000;
const DEFAULT_CONFIRM_DELAY_MS = 15 * 1000;
const DEFAULT_MAX_RESUME_ATTEMPTS = 2;

const STALE_TURN_ERROR_MESSAGE =
  "Provider session lost while a turn was running; settled by the stale-turn reconciler.";

export const STALE_TURN_RESUME_ACTIVITY_KIND = "stale-turn-resumed";

const STALE_TURN_RESUME_MESSAGE =
  "Your previous turn was interrupted by a server restart. The provider session has been resumed with your prior context. Continue where you left off and finish by emitting your required directive.";

/**
 * Workflow roles whose orphaned turns are resumed autonomously instead of
 * failed outright. The remaining roles (implementation-orchestrator and
 * interactive/null threads) settle only.
 */
const AUTONOMOUS_RESUME_ROLES: ReadonlySet<OrchestrationThreadWorkflowRole> = new Set([
  "implementation-worker",
  "implementation-validator",
  "implementation-fixer",
  "implementation-code-reviewer",
  "implementation-qa-reviewer",
  "planning-orchestrator",
  "planning-reviewer",
  "product-fix-implementer",
  "fast-feature-implementer",
]);

export interface StaleTurnReconcilerLiveOptions {
  readonly sweepIntervalMs?: number;
  readonly graceMs?: number;
  readonly confirmDelayMs?: number;
  readonly maxResumeAttempts?: number;
}

interface SweepOptions {
  readonly graceMs: number;
  readonly confirmDelayMs: number;
}

interface StaleTurnCandidate {
  readonly kind: "running" | "resumable-error";
  readonly threadId: ThreadId;
  readonly pinnedTurnId: TurnId | null;
}

interface ResumeTarget {
  readonly workflowPromptId: string | null;
  readonly interactionMode: ProviderInteractionMode;
  readonly sourceProposedPlan?: {
    readonly threadId: ThreadId;
    readonly planId: OrchestrationProposedPlanId;
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

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

/**
 * A resumed session that later dies via a provider runtime error carries no
 * running signature (session error, no active turn) — this second signature
 * lets the sweep re-inspect it. Containment to threads the reconciler already
 * touched (>= 1 resume activity) is enforced after the confirm re-check, where
 * the thread detail is available.
 */
function hasResumableErrorSignature(
  readModel: OrchestrationReadModel,
  thread: OrchestrationThread,
): boolean {
  return (
    thread.workflowRole !== null &&
    AUTONOMOUS_RESUME_ROLES.has(thread.workflowRole) &&
    thread.session?.status === "error" &&
    thread.session.activeTurnId === null &&
    resolveResumeTarget(readModel, thread) !== null
  );
}

function pinTurnId(thread: OrchestrationThread): TurnId | null {
  return thread.session?.activeTurnId ?? thread.latestTurn?.turnId ?? null;
}

/**
 * Where a resumed turn should restart, per role. Doubles as the guard shared
 * by resume, budget-fail, and the safety net: a null target means the workflow
 * has moved past this thread (or the role is not autonomous) and the thread
 * settles without any resume artifacts.
 */
function resolveResumeTarget(
  readModel: OrchestrationReadModel,
  thread: OrchestrationThread,
): ResumeTarget | null {
  switch (thread.workflowRole) {
    case "implementation-worker": {
      const run = readModel.implementationRuns.find((candidate) =>
        candidate.ticketStates.some((state) => state.workerThreadId === thread.id),
      );
      const ticketState = run?.ticketStates.find((state) => state.workerThreadId === thread.id);
      if (run === undefined || ticketState === undefined) return null;
      if (ticketState.status !== "running") return null;
      return {
        workflowPromptId: WORKFLOW_PROMPT_IDS.implementationTddCodex,
        interactionMode: "implementation-workflow",
      };
    }
    case "implementation-validator": {
      const run = readModel.implementationRuns.find(
        (candidate) =>
          candidate.orchestratorThreadId === thread.parentThreadId &&
          candidate.status === "validating",
      );
      if (run === undefined) return null;
      return {
        workflowPromptId: WORKFLOW_PROMPT_IDS.implementationMergeGateCodex,
        interactionMode: "implementation-workflow",
      };
    }
    case "implementation-fixer": {
      const run = readModel.implementationRuns.find(
        (candidate) =>
          candidate.orchestratorThreadId === thread.parentThreadId &&
          (candidate.status === "fixing" || candidate.status === "code-review-fixing"),
      );
      if (run === undefined) return null;
      return {
        workflowPromptId:
          run.fixOrigin === "app-dev-stack" || run.fixOrigin === "app-review"
            ? WORKFLOW_PROMPT_IDS.implementationTddCodex
            : WORKFLOW_PROMPT_IDS.implementationFixCodex,
        interactionMode: "implementation-workflow",
      };
    }
    case "implementation-code-reviewer": {
      const run = readModel.implementationRuns.find(
        (candidate) =>
          candidate.orchestratorThreadId === thread.parentThreadId &&
          candidate.status === "code-reviewing",
      );
      if (run === undefined) return null;
      return {
        workflowPromptId: WORKFLOW_PROMPT_IDS.implementationCodeReviewCodex,
        interactionMode: "implementation-workflow",
      };
    }
    case "implementation-qa-reviewer": {
      const run = readModel.implementationRuns.find(
        (candidate) =>
          candidate.orchestratorThreadId === thread.parentThreadId &&
          candidate.status === "qa-reviewing" &&
          candidate.appReviewIds.length > 0,
      );
      if (run === undefined) return null;
      return {
        workflowPromptId: WORKFLOW_PROMPT_IDS.implementationBrowserAppReviewCodex,
        interactionMode: "implementation-workflow",
      };
    }
    case "planning-orchestrator": {
      const stage = thread.planningWorkflow?.stage;
      if (stage === "spec-authoring") {
        return {
          workflowPromptId: WORKFLOW_PROMPT_IDS.planningSpecCodex,
          interactionMode: "planning-workflow",
        };
      }
      if (stage === "tickets-authoring" || stage === "ticket-revision") {
        return {
          workflowPromptId: WORKFLOW_PROMPT_IDS.planningTicketsCodex,
          interactionMode: "planning-workflow",
        };
      }
      return null;
    }
    case "planning-reviewer": {
      const parent =
        thread.parentThreadId === null
          ? undefined
          : readModel.threads.find((entry) => entry.id === thread.parentThreadId);
      if (parent?.planningWorkflow?.stage !== "ticket-review") return null;
      return {
        workflowPromptId: WORKFLOW_PROMPT_IDS.planningTicketReviewerCodex,
        interactionMode: "planning-workflow",
      };
    }
    case "product-fix-implementer": {
      const parent =
        thread.parentThreadId === null
          ? undefined
          : readModel.threads.find((entry) => entry.id === thread.parentThreadId);
      if (parent === undefined) return null;
      const reference = thread.latestTurn?.sourceProposedPlan;
      const referencedPlan =
        reference === undefined
          ? undefined
          : parent.proposedPlans.find((candidate) => candidate.id === reference.planId);
      const plan =
        referencedPlan ??
        [...parent.proposedPlans]
          .filter((candidate) => candidate.implementedAt === null)
          .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
      if (plan === undefined || plan.implementedAt !== null) return null;
      return {
        workflowPromptId: null,
        interactionMode: "default",
        sourceProposedPlan: { threadId: parent.id, planId: plan.id },
      };
    }
    case "fast-feature-implementer": {
      const run = readModel.implementationRuns.find(
        (candidate) =>
          candidate.artifactSource === "proposed-plan" &&
          candidate.orchestratorThreadId === thread.id &&
          candidate.status === "running" &&
          candidate.fastBuildResult?.status !== "succeeded",
      );
      if (run?.sourceProposedPlan === null || run?.sourceProposedPlan === undefined) return null;
      return {
        workflowPromptId: null,
        interactionMode: "default",
        sourceProposedPlan: run.sourceProposedPlan,
      };
    }
    default:
      return null;
  }
}

/**
 * Activities for the pinned turn itself are excluded so crash-replay of the
 * same candidate never double-counts against the budget.
 */
function countPriorResumeAttempts(detail: OrchestrationThread, pinnedTurnId: TurnId): number {
  return detail.activities.filter(
    (activity) =>
      activity.kind === STALE_TURN_RESUME_ACTIVITY_KIND &&
      !(isRecord(activity.payload) && activity.payload["interruptedTurnId"] === pinnedTurnId),
  ).length;
}

function lastResumeActivityInterruptedTurnId(detail: OrchestrationThread): TurnId | null {
  for (let index = detail.activities.length - 1; index >= 0; index -= 1) {
    const activity = detail.activities[index];
    if (activity === undefined || activity.kind !== STALE_TURN_RESUME_ACTIVITY_KIND) continue;
    if (isRecord(activity.payload) && typeof activity.payload["interruptedTurnId"] === "string") {
      return activity.payload["interruptedTurnId"] as TurnId;
    }
  }
  return null;
}

function countResumeActivities(detail: OrchestrationThread): number {
  return detail.activities.filter((activity) => activity.kind === STALE_TURN_RESUME_ACTIVITY_KIND)
    .length;
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
    const maxResumeAttempts = Math.max(
      1,
      options?.maxResumeAttempts ?? DEFAULT_MAX_RESUME_ATTEMPTS,
    );

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
          case "fast-feature-implementer": {
            const run = readModel.implementationRuns.find(
              (candidate) =>
                candidate.artifactSource === "proposed-plan" &&
                candidate.orchestratorThreadId === thread.id &&
                candidate.status === "running",
            );
            if (run === undefined) return;
            yield* appendFailureActivity({
              threadId: thread.id,
              pinnedTurnId,
              tag: "fast-build-result",
              kind: "implementation-fast-build-result",
              summary: "Fast feature Build blocked",
              payload: {
                type: "implementation-fast-build-result",
                runId: run.id,
                status: "blocked",
                validations: [],
                notesMarkdown: STALE_TURN_ERROR_MESSAGE,
              },
              createdAt,
            });
            return;
          }
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
                validations: [],
                reportMarkdown: STALE_TURN_ERROR_MESSAGE,
              },
              createdAt,
            });
            return;
          }
          case "implementation-qa-reviewer": {
            const run = readModel.implementationRuns.find(
              (candidate) =>
                candidate.orchestratorThreadId === thread.parentThreadId &&
                candidate.status === "qa-reviewing" &&
                candidate.activeAppReviewThreadId === thread.id,
            );
            const reviewId = run?.appReviewIds.at(-1);
            if (run === undefined || reviewId === undefined) return;
            yield* orchestrationEngine.dispatch({
              type: "thread.app-review.update",
              commandId: yield* staleTurnCommandId(
                "browser-review-runtime-failure",
                thread.id,
                pinnedTurnId,
              ),
              threadId: run.orchestratorThreadId,
              reviewId: AppReviewId.make(reviewId),
              status: "failed",
              updatedAt: createdAt,
              createdAt,
            });
            return;
          }
          case "planning-reviewer": {
            const parent =
              thread.parentThreadId === null
                ? undefined
                : readModel.threads.find((candidate) => candidate.id === thread.parentThreadId);
            const activeReview = parent?.planningWorkflow?.activeReview;
            if (parent === undefined || activeReview == null) return;
            if (activeReview.reviewerThreadId !== thread.id) return;
            yield* orchestrationEngine.dispatch({
              type: "thread.planning-reviewer-verdict.apply",
              commandId: yield* staleTurnCommandId(
                "planning-review-runtime-failure",
                thread.id,
                pinnedTurnId,
              ),
              threadId: parent.id,
              reviewerThreadId: thread.id,
              reviewerMessageId: MessageId.make(
                `message-planning-review-runtime-failure-${thread.id}-${pinnedTurnId}`,
              ),
              cycleNumber: activeReview.cycleNumber,
              mode: activeReview.mode,
              targetPlanningTicketIds: [...activeReview.targetPlanningTicketIds],
              ticketEdits: [],
              runtimeFailure: true,
              verdictMarkdown: STALE_TURN_ERROR_MESSAGE,
              passed: false,
              failingPlanningTicketIds: [...activeReview.targetPlanningTicketIds],
              dependencyFeedback: [],
              perTicketFeedback: [],
              createdAt,
            });
            return;
          }
          default:
            return;
        }
      },
    );

    const settleSessionAndBinding = Effect.fn("StaleTurnReconciler.settleSessionAndBinding")(
      function* (input: {
        readonly thread: OrchestrationThread;
        readonly pinnedTurnId: TurnId | null;
        readonly updatedAt: string;
      }) {
        const { thread, pinnedTurnId, updatedAt } = input;

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
      },
    );

    /**
     * The three commands are keyed on the pinned dead turnId, in an order that
     * survives a crash between any two of them: the running signature (or the
     * resume activity for the safety net) re-derives the same pin on the next
     * sweep and receipt dedup no-ops the already-dispatched commands.
     */
    const resumeThread = Effect.fn("StaleTurnReconciler.resumeThread")(function* (input: {
      readonly thread: OrchestrationThread;
      readonly pinnedTurnId: TurnId;
      readonly target: ResumeTarget;
      readonly attempt: number;
      readonly updatedAt: string;
    }) {
      const { thread, pinnedTurnId, target, attempt, updatedAt } = input;
      const resumeMessageId = MessageId.make(
        `message-stale-turn-resume-${thread.id}-${pinnedTurnId}`,
      );

      yield* orchestrationEngine.dispatch({
        type: "thread.activity.append",
        commandId: yield* staleTurnCommandId("resumed", thread.id, pinnedTurnId),
        threadId: thread.id,
        activity: {
          id: EventId.make(yield* crypto.randomUUIDv4),
          tone: "info",
          kind: STALE_TURN_RESUME_ACTIVITY_KIND,
          summary: `Resumed after interrupted turn (attempt ${attempt}/${maxResumeAttempts})`,
          payload: {
            type: STALE_TURN_RESUME_ACTIVITY_KIND,
            attempt,
            maxAttempts: maxResumeAttempts,
            interruptedTurnId: pinnedTurnId,
            resumeMessageId,
            workflowPromptId: target.workflowPromptId,
            reason: "provider-session-lost",
            resumedAt: updatedAt,
          },
          turnId: null,
          createdAt: updatedAt,
        },
        createdAt: updatedAt,
      });

      yield* settleSessionAndBinding({ thread, pinnedTurnId, updatedAt });

      yield* orchestrationEngine.dispatch({
        type: "thread.turn.start",
        commandId: yield* staleTurnCommandId("resume", thread.id, pinnedTurnId),
        threadId: thread.id,
        message: {
          messageId: resumeMessageId,
          role: "user",
          text: appendWorkflowSkillCommandSection(
            STALE_TURN_RESUME_MESSAGE,
            target.workflowPromptId,
          ),
          attachments: [],
        },
        ...(target.workflowPromptId !== null ? { workflowPromptId: target.workflowPromptId } : {}),
        runtimeMode: thread.session?.runtimeMode ?? thread.runtimeMode,
        interactionMode: target.interactionMode,
        ...(target.sourceProposedPlan !== undefined
          ? { sourceProposedPlan: target.sourceProposedPlan }
          : {}),
        createdAt: updatedAt,
      });

      yield* Effect.logInfo("stale-turn.reconciler.resumed", {
        threadId: thread.id,
        turnId: pinnedTurnId,
        workflowRole: thread.workflowRole,
        attempt,
        maxAttempts: maxResumeAttempts,
      });
    });

    const reconcileCandidate = Effect.fn("StaleTurnReconciler.reconcileCandidate")(
      function* (input: {
        readonly readModel: OrchestrationReadModel;
        readonly thread: OrchestrationThread;
        readonly pinnedTurnId: TurnId | null;
        readonly detail?: OrchestrationThread;
        readonly updatedAt: string;
      }) {
        const { readModel, thread, pinnedTurnId, updatedAt } = input;

        // A reviewer interruption is itself a consumed review cycle. Restarting
        // the same reviewer turn could apply a stale directive after a newer
        // cycle has begun, so settle it and let the workflow create a fresh
        // reviewer instead.
        if (thread.workflowRole === "planning-reviewer" && pinnedTurnId !== null) {
          yield* propagateWorkflowFailure({
            readModel,
            thread,
            pinnedTurnId,
            createdAt: updatedAt,
          });
          yield* settleSessionAndBinding({ thread, pinnedTurnId, updatedAt });
          return;
        }

        const target = resolveResumeTarget(readModel, thread);
        if (target === null || pinnedTurnId === null) {
          yield* settleSessionAndBinding({ thread, pinnedTurnId, updatedAt });
          yield* Effect.logInfo("stale-turn.reconciler.settled", {
            threadId: thread.id,
            turnId: pinnedTurnId,
            workflowRole: thread.workflowRole,
          });
          return;
        }

        const detail =
          input.detail ??
          Option.getOrNull(yield* projectionSnapshotQuery.getThreadDetailById(thread.id));
        const priorAttempts = detail === null ? 0 : countPriorResumeAttempts(detail, pinnedTurnId);

        if (priorAttempts >= maxResumeAttempts) {
          // Propagate first: if the process dies mid-candidate, the candidate
          // is re-detected on the next boot and receipt dedup keeps the
          // synthesized directive exactly-once.
          yield* propagateWorkflowFailure({
            readModel,
            thread,
            pinnedTurnId,
            createdAt: updatedAt,
          });
          yield* settleSessionAndBinding({ thread, pinnedTurnId, updatedAt });
          yield* Effect.logInfo("stale-turn.reconciler.settled", {
            threadId: thread.id,
            turnId: pinnedTurnId,
            workflowRole: thread.workflowRole,
            resumeAttemptsExhausted: priorAttempts,
          });
          return;
        }

        yield* resumeThread({
          thread,
          pinnedTurnId,
          target,
          attempt: priorAttempts + 1,
          updatedAt,
        });
      },
    );

    const sweep = (sweepOptions: SweepOptions) =>
      Effect.gen(function* () {
        const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
        const liveSessions = yield* providerService.listSessions();
        const liveThreadIds = new Set<ThreadId>(liveSessions.map((session) => session.threadId));
        const now = yield* Clock.currentTimeMillis;

        const candidates: StaleTurnCandidate[] = [];
        for (const thread of readModel.threads) {
          if (thread.deletedAt !== null) continue;
          if (liveThreadIds.has(thread.id)) continue;

          const running = hasRunningTurnSignature(thread);
          if (!running && !hasResumableErrorSignature(readModel, thread)) continue;

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

          candidates.push(
            running
              ? { kind: "running", threadId: thread.id, pinnedTurnId: pinTurnId(thread) }
              : { kind: "resumable-error", threadId: thread.id, pinnedTurnId: null },
          );
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
          if (confirmedLiveThreadIds.has(thread.id)) continue;

          let pinnedTurnId: TurnId | null = candidate.pinnedTurnId;
          let detail: OrchestrationThread | undefined;

          if (candidate.kind === "running") {
            if (!hasRunningTurnSignature(thread)) continue;
            if (pinTurnId(thread) !== candidate.pinnedTurnId) continue;
          } else {
            if (hasRunningTurnSignature(thread)) continue;
            if (!hasResumableErrorSignature(confirmedModel, thread)) continue;
            detail = Option.getOrUndefined(
              yield* projectionSnapshotQuery
                .getThreadDetailById(thread.id)
                .pipe(Effect.orElseSucceed(() => Option.none<OrchestrationThread>())),
            );
            // Containment: only re-inspect threads the reconciler already
            // resumed at least once.
            if (detail === undefined || countResumeActivities(detail) === 0) continue;
            // The settle nulls the snapshot's latestTurn join, so a crashed
            // resume falls back to the pin recorded on the resume activity.
            pinnedTurnId =
              thread.latestTurn?.state === "error" || thread.latestTurn?.state === "interrupted"
                ? thread.latestTurn.turnId
                : lastResumeActivityInterruptedTurnId(detail);
            if (pinnedTurnId === null) continue;
          }

          const settled = yield* reconcileCandidate({
            readModel: confirmedModel,
            thread,
            pinnedTurnId,
            ...(detail !== undefined ? { detail } : {}),
            updatedAt,
          }).pipe(
            Effect.as(true),
            Effect.catchCause((cause) =>
              Effect.logWarning("stale-turn.reconciler.settle-failed", {
                threadId: candidate.threadId,
                turnId: pinnedTurnId,
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
          maxResumeAttempts,
        });
      });

    return {
      start,
    } satisfies StaleTurnReconcilerShape;
  });

export const makeStaleTurnReconcilerLive = (options?: StaleTurnReconcilerLiveOptions) =>
  Layer.effect(StaleTurnReconciler, makeStaleTurnReconciler(options));

export const StaleTurnReconcilerLive = makeStaleTurnReconcilerLive();
