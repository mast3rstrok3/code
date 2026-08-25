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
  TurnId,
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
import {
  isAwaitingWorkflowNudge,
  isWorkflowNudgeCandidate,
  NUDGEABLE_WORKFLOW_ROLES,
  ORPHANED_PROVIDER_SESSION_ERROR,
  STALE_TURN_RESUME_ACTIVITY_KIND,
  workflowAutomaticRetryLimit,
  workflowNudgeDelayMs,
  WORKFLOW_INTERRUPTION_ERROR_MESSAGE,
  WORKFLOW_NUDGE_ACTIVITY_KIND,
  WORKFLOW_NUDGE_EXHAUSTED_MESSAGE,
  WORKFLOW_NUDGE_INTERVAL_MS,
  WORKFLOW_NUDGE_MAX_ATTEMPTS,
} from "../workflowNudge.ts";
import { isWorkflowThreadPaused } from "../workflowPause.ts";

const DEFAULT_SWEEP_INTERVAL_MS = 60 * 1000;
const DEFAULT_GRACE_MS = 60 * 1000;
const DEFAULT_STARTING_PROVIDER_LAUNCH_GRACE_MS = 5 * 60 * 1000;
const DEFAULT_CONFIRM_DELAY_MS = 15 * 1000;
const DEFAULT_MAX_RESUME_ATTEMPTS = 2;

/** The two App Review phase skills, mirrored from the App Review reactor. */
const APP_REVIEW_TO_TICKETS_SKILL_ID = "matt-pocock.to-tickets";
const APP_REVIEW_IMPLEMENT_SKILL_ID = "matt-pocock.implement";

export { STALE_TURN_RESUME_ACTIVITY_KIND } from "../workflowNudge.ts";

const STALE_TURN_RESUME_MESSAGE =
  "Your previous turn was interrupted by a server restart. The provider session has been resumed with your prior context. Continue where you left off and finish by emitting your required directive.";

/**
 * The reconciler's second job: a turn that *failed* leaves the thread idle
 * rather than orphaned, and for the common causes — an API error, a plan usage
 * limit — the fix is to wait and ask again. See `../workflowNudge.ts`.
 */
const WORKFLOW_NUDGE_MESSAGE =
  "Your previous turn stopped on a provider failure — an API error, or a plan usage limit that has since had time to lift. Nothing else about the work changed. Pick up exactly where you left off and finish by emitting your required directive.";

/**
 * Workflow roles whose orphaned turns are resumed autonomously instead of
 * failed outright. The remaining roles (implementation-orchestrator and
 * interactive/null threads) settle only.
 */
const AUTONOMOUS_RESUME_ROLES: ReadonlySet<OrchestrationThreadWorkflowRole> =
  NUDGEABLE_WORKFLOW_ROLES;

export interface StaleTurnReconcilerLiveOptions {
  readonly sweepIntervalMs?: number;
  readonly graceMs?: number;
  readonly startingProviderLaunchGraceMs?: number;
  readonly confirmDelayMs?: number;
  readonly maxResumeAttempts?: number;
  readonly nudgeIntervalMs?: number;
  readonly maxNudgeAttempts?: number;
}

interface SweepOptions {
  readonly graceMs: number;
  readonly startingProviderLaunchGraceMs: number;
  readonly confirmDelayMs: number;
  /** Spacing between nudges for a thread that stays blocked. */
  readonly nudgeIntervalMs: number;
  /** Recover owned workflow turns that startup already marked inactive. */
  readonly recoverInactiveWorkflows: boolean;
  /**
   * Whether to nudge threads that have been blocked for longer than the
   * deferral window. Only the boot pass does: in steady state a thread nobody
   * has nudged for that long is one nobody is waiting on, and re-reading every
   * long-dead thread's detail each minute costs more than it can ever recover.
   * A server that was down for hours, though, is exactly where a run stopped by
   * a usage limit is waiting.
   */
  readonly nudgeLongBlocked: boolean;
}

interface StaleTurnCandidate {
  readonly kind: "running" | "resumable-error" | "workflow-recovery" | "nudge";
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
 * A workflow reactor can create its phase thread while startup recovery is
 * still running. The provider command has not claimed a turn yet, so the boot
 * sweep must leave this handoff alone. The periodic sweep applies a longer
 * launch grace because a busy provider can take more than one sweep interval
 * to claim its first turn.
 */
function isStartingProviderLaunch(thread: OrchestrationThread): boolean {
  return thread.session?.status === "starting" && thread.session.activeTurnId === null;
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

/**
 * An active workflow can retain ownership of a thread after shutdown has
 * cleared its provider session. The run state is the authority here. A human
 * pause is checked before the turn is resumed.
 */
function hasInactiveWorkflowSignature(
  readModel: OrchestrationReadModel,
  thread: OrchestrationThread,
): boolean {
  const session = thread.session;
  const role = thread.workflowRole;
  if (role === null || !AUTONOMOUS_RESUME_ROLES.has(role)) return false;
  const staleTurnOwnsRecovery =
    session?.lastError === ORPHANED_PROVIDER_SESSION_ERROR ||
    workflowAutomaticRetryLimit(role, 1) > 0;
  return (
    staleTurnOwnsRecovery &&
    (session === null ||
      (session.status !== "running" &&
        session.status !== "starting" &&
        session.activeTurnId === null)) &&
    resolveResumeTarget(readModel, thread) !== null
  );
}

function pinTurnId(thread: OrchestrationThread): TurnId | null {
  return thread.session?.activeTurnId ?? thread.latestTurn?.turnId ?? null;
}

function startupRecoveryTurnId(threadId: ThreadId): TurnId {
  return TurnId.make(`turn-stale-startup-recovery-${threadId}`);
}

/**
 * Where a resumed turn should restart, per role. Doubles as the guard shared by
 * resume, nudge, budget-fail, and the safety net: a null target means the
 * workflow has moved past this thread (or the role is not autonomous), so the
 * thread settles without any resume artifacts and is never nudged.
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
      // A ticket-level review runs while its implementation run is still
      // `running`, so the nested App Review run is the other place this thread
      // can be the live reviewer.
      const nestedRun = (readModel.appReviewWorkflowRuns ?? []).find(
        (candidate) => candidate.status === "running" && candidate.activeThreadId === thread.id,
      );
      if (run === undefined && nestedRun === undefined) return null;
      return {
        workflowPromptId: WORKFLOW_PROMPT_IDS.implementationBrowserAppReviewCodex,
        interactionMode: "implementation-workflow",
      };
    }
    case "implementation-change-request-babysitter": {
      const run = readModel.implementationRuns.find(
        (candidate) =>
          candidate.orchestratorThreadId === thread.parentThreadId &&
          candidate.status === "babysitting-change-request" &&
          candidate.activeChangeRequestBabysitterThreadId === thread.id,
      );
      if (run === undefined) return null;
      return {
        workflowPromptId: WORKFLOW_PROMPT_IDS.implementationCodeReviewCodex,
        interactionMode: "implementation-workflow",
      };
    }
    // The nested App Review workflow drives one thread per phase and records it
    // on the run, so the run's own `activeThreadId` is the whole test.
    case "app-review-reviewer":
    case "app-review-planner":
    case "app-review-fixer": {
      const run = (readModel.appReviewWorkflowRuns ?? []).find(
        (candidate) => candidate.status === "running" && candidate.activeThreadId === thread.id,
      );
      if (run === undefined) return null;
      const workflowPromptId =
        thread.workflowRole === "app-review-reviewer"
          ? WORKFLOW_PROMPT_IDS.implementationBrowserAppReviewCodex
          : thread.workflowRole === "app-review-planner"
            ? APP_REVIEW_TO_TICKETS_SKILL_ID
            : APP_REVIEW_IMPLEMENT_SKILL_ID;
      return { workflowPromptId, interactionMode: "default" };
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

function nudgeActivities(detail: OrchestrationThread) {
  return detail.activities.filter((activity) => activity.kind === WORKFLOW_NUDGE_ACTIVITY_KIND);
}

/** When the last nudge went out, or null when none has. */
function lastNudgeAtMs(detail: OrchestrationThread): number | null {
  const last = nudgeActivities(detail).at(-1);
  if (last === undefined) return null;
  const parsed = Date.parse(last.createdAt);
  return Number.isNaN(parsed) ? null : parsed;
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
    const startingProviderLaunchGraceMs = Math.max(
      graceMs,
      options?.startingProviderLaunchGraceMs ?? DEFAULT_STARTING_PROVIDER_LAUNCH_GRACE_MS,
    );
    const confirmDelayMs = Math.max(0, options?.confirmDelayMs ?? DEFAULT_CONFIRM_DELAY_MS);
    const maxResumeAttempts = Math.max(
      1,
      options?.maxResumeAttempts ?? DEFAULT_MAX_RESUME_ATTEMPTS,
    );
    const nudgeIntervalMs = Math.max(0, options?.nudgeIntervalMs ?? WORKFLOW_NUDGE_INTERVAL_MS);
    const maxNudgeAttempts = Math.max(1, options?.maxNudgeAttempts ?? WORKFLOW_NUDGE_MAX_ATTEMPTS);

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
                notesMarkdown: WORKFLOW_INTERRUPTION_ERROR_MESSAGE,
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
                notesMarkdown: WORKFLOW_INTERRUPTION_ERROR_MESSAGE,
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
                summaryMarkdown: WORKFLOW_INTERRUPTION_ERROR_MESSAGE,
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
                notesMarkdown: WORKFLOW_INTERRUPTION_ERROR_MESSAGE,
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
                reportMarkdown: WORKFLOW_INTERRUPTION_ERROR_MESSAGE,
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
              verdictMarkdown: WORKFLOW_INTERRUPTION_ERROR_MESSAGE,
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

    /**
     * A binding still marked running outlives the provider session it names, so
     * the next turn start would try to reuse a session that is gone. Both the
     * resume and the nudge paths clear it before starting a turn.
     */
    const stopBinding = (threadId: ThreadId) =>
      directory.getBinding(threadId).pipe(
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
            threadId,
            cause,
          }),
        ),
      );

    const settleSessionAndBinding = Effect.fn("StaleTurnReconciler.settleSessionAndBinding")(
      function* (input: {
        readonly thread: OrchestrationThread;
        readonly pinnedTurnId: TurnId | null;
        readonly updatedAt: string;
        readonly lastError?: string;
        readonly tag?: string;
        /** "error" unless the session ended for a reason that is not a fault. */
        readonly status?: "error" | "stopped";
      }) {
        const { thread, pinnedTurnId, updatedAt } = input;

        yield* orchestrationEngine.dispatch({
          type: "thread.session.set",
          commandId: yield* staleTurnCommandId(input.tag ?? "settle", thread.id, pinnedTurnId),
          threadId: thread.id,
          session: {
            threadId: thread.id,
            status: input.status ?? "error",
            providerName: thread.session?.providerName ?? null,
            ...(thread.session?.providerInstanceId !== undefined
              ? { providerInstanceId: thread.session.providerInstanceId }
              : {}),
            runtimeMode: thread.session?.runtimeMode ?? thread.runtimeMode,
            activeTurnId: null,
            lastError:
              input.status === "stopped"
                ? null
                : (input.lastError ?? WORKFLOW_INTERRUPTION_ERROR_MESSAGE),
            updatedAt,
          },
          createdAt: updatedAt,
        });

        yield* stopBinding(thread.id);
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

    /**
     * Re-prompt a blocked thread in place. Unlike a resume there is nothing to
     * settle — the failed turn already left the session idle — so the nudge is
     * one activity (the budget's durable record) and one turn.
     */
    const nudgeThread = Effect.fn("StaleTurnReconciler.nudgeThread")(function* (input: {
      readonly thread: OrchestrationThread;
      readonly blockedTurnId: TurnId;
      readonly target: ResumeTarget;
      readonly attempt: number;
      readonly maxAttempts: number;
      readonly updatedAt: string;
    }) {
      const { thread, blockedTurnId, target, attempt, maxAttempts, updatedAt } = input;
      const nudgeMessageId = MessageId.make(`message-workflow-nudge-${thread.id}-${attempt}`);
      const nudgeCommandId = (tag: string) =>
        CommandId.make(`server:workflow-nudge:${tag}:${thread.id}:${attempt}`);

      yield* orchestrationEngine.dispatch({
        type: "thread.activity.append",
        commandId: nudgeCommandId("nudged"),
        threadId: thread.id,
        activity: {
          id: EventId.make(yield* crypto.randomUUIDv4),
          tone: "info",
          kind: WORKFLOW_NUDGE_ACTIVITY_KIND,
          summary: `Nudged after a failed turn (attempt ${attempt}/${maxAttempts})`,
          payload: {
            type: WORKFLOW_NUDGE_ACTIVITY_KIND,
            attempt,
            maxAttempts,
            blockedTurnId,
            nudgeMessageId,
            workflowPromptId: target.workflowPromptId,
            reason: "turn-failed",
            blockedError: thread.session?.lastError ?? null,
            nudgedAt: updatedAt,
          },
          turnId: null,
          createdAt: updatedAt,
        },
        createdAt: updatedAt,
      });

      yield* stopBinding(thread.id);

      yield* orchestrationEngine.dispatch({
        type: "thread.turn.start",
        commandId: nudgeCommandId("turn"),
        threadId: thread.id,
        message: {
          messageId: nudgeMessageId,
          role: "user",
          text: appendWorkflowSkillCommandSection(WORKFLOW_NUDGE_MESSAGE, target.workflowPromptId),
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

      yield* Effect.logInfo("stale-turn.reconciler.nudged", {
        threadId: thread.id,
        turnId: blockedTurnId,
        workflowRole: thread.workflowRole,
        attempt,
        maxAttempts,
      });
    });

    /**
     * One blocked thread, one decision per sweep: not due yet, nudge, or give
     * up. Giving up hands the thread back to its stage owner through the same
     * failure directives an exhausted resume budget uses, and marks the session
     * so the owner stops deferring immediately.
     */
    const reconcileNudgeCandidate = Effect.fn("StaleTurnReconciler.reconcileNudgeCandidate")(
      function* (input: {
        readonly readModel: OrchestrationReadModel;
        readonly thread: OrchestrationThread;
        readonly blockedTurnId: TurnId;
        readonly detail: OrchestrationThread;
        readonly nudgeIntervalMs: number;
        readonly nowMs: number;
        readonly updatedAt: string;
      }) {
        const { readModel, thread, blockedTurnId, detail, updatedAt } = input;
        const target = resolveResumeTarget(readModel, thread);
        // The workflow has moved past this thread; its stage owner is the one
        // that decides what happens next.
        if (target === null) return false;

        const priorAttempts = nudgeActivities(detail).length;
        const nudgeAttemptLimit = workflowAutomaticRetryLimit(
          thread.workflowRole,
          maxNudgeAttempts,
        );
        if (priorAttempts >= nudgeAttemptLimit) {
          yield* propagateWorkflowFailure({
            readModel,
            thread,
            pinnedTurnId: blockedTurnId,
            createdAt: updatedAt,
          });
          yield* settleSessionAndBinding({
            thread,
            pinnedTurnId: blockedTurnId,
            updatedAt,
            lastError: WORKFLOW_NUDGE_EXHAUSTED_MESSAGE,
            tag: "nudge-exhausted",
          });
          yield* Effect.logInfo("stale-turn.reconciler.nudges-exhausted", {
            threadId: thread.id,
            turnId: blockedTurnId,
            workflowRole: thread.workflowRole,
            attempts: priorAttempts,
          });
          return true;
        }

        const lastNudge = lastNudgeAtMs(detail);
        const dueAfterMs =
          lastNudge === null
            ? Date.parse(thread.session?.updatedAt ?? "") + workflowNudgeDelayMs(0)
            : lastNudge + input.nudgeIntervalMs;
        if (!Number.isNaN(dueAfterMs) && input.nowMs < dueAfterMs) return false;

        yield* nudgeThread({
          thread,
          blockedTurnId,
          target,
          attempt: priorAttempts + 1,
          maxAttempts: nudgeAttemptLimit,
          updatedAt,
        });
        return true;
      },
    );

    const reconcileCandidate = Effect.fn("StaleTurnReconciler.reconcileCandidate")(
      function* (input: {
        readonly readModel: OrchestrationReadModel;
        readonly thread: OrchestrationThread;
        readonly pinnedTurnId: TurnId | null;
        readonly detail?: OrchestrationThread;
        readonly updatedAt: string;
      }) {
        const { readModel, thread, pinnedTurnId, updatedAt } = input;

        // A paused workflow is waiting for the user, so its lost session is not
        // work to pick back up: resuming it would dispatch a turn the decider
        // refuses, leaving the session reading "running" in every client for as
        // long as the pause holds. Write the ending the provider never got to
        // report and leave the run alone.
        if (isWorkflowThreadPaused(readModel.threads, thread.id)) {
          yield* settleSessionAndBinding({
            thread,
            pinnedTurnId,
            updatedAt,
            status: "stopped",
            tag: "paused",
          });
          yield* Effect.logInfo("stale-turn.reconciler.settled-paused", {
            threadId: thread.id,
            turnId: pinnedTurnId,
            workflowRole: thread.workflowRole,
          });
          return;
        }

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

        const resumeAttemptLimit = workflowAutomaticRetryLimit(
          thread.workflowRole,
          maxResumeAttempts,
        );
        if (priorAttempts >= resumeAttemptLimit) {
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

          const sessionLost = !liveThreadIds.has(thread.id);
          const running =
            sessionLost &&
            hasRunningTurnSignature(thread) &&
            !(sweepOptions.recoverInactiveWorkflows && isStartingProviderLaunch(thread));
          const inactiveWorkflow =
            sweepOptions.recoverInactiveWorkflows &&
            sessionLost &&
            !running &&
            hasInactiveWorkflowSignature(readModel, thread);
          const resumableError =
            sessionLost &&
            !running &&
            !inactiveWorkflow &&
            hasResumableErrorSignature(readModel, thread);

          if (running || inactiveWorkflow || resumableError) {
            const candidateGraceMs = isStartingProviderLaunch(thread)
              ? sweepOptions.startingProviderLaunchGraceMs
              : sweepOptions.graceMs;
            if (candidateGraceMs > 0) {
              const referenceIso = thread.session?.updatedAt ?? thread.updatedAt;
              const referenceMs = Date.parse(referenceIso);
              if (Number.isNaN(referenceMs)) {
                yield* Effect.logWarning("stale-turn.reconciler.invalid-session-updated-at", {
                  threadId: thread.id,
                  updatedAt: referenceIso,
                });
                continue;
              }
              if (now - referenceMs < candidateGraceMs) continue;
            }

            candidates.push(
              running
                ? { kind: "running", threadId: thread.id, pinnedTurnId: pinTurnId(thread) }
                : inactiveWorkflow
                  ? { kind: "workflow-recovery", threadId: thread.id, pinnedTurnId: null }
                  : { kind: "resumable-error", threadId: thread.id, pinnedTurnId: null },
            );
            continue;
          }

          // A terminated failed turn is a blocked thread whatever the provider
          // did with its session afterwards — Claude tears the session down
          // after an API error, others leave it idle — so this is decided
          // independently of the live session list.
          const nudgeable = sweepOptions.nudgeLongBlocked
            ? isWorkflowNudgeCandidate({ threads: readModel.threads, thread })
            : isAwaitingWorkflowNudge({ threads: readModel.threads, thread, nowMs: now });
          if (!nudgeable) continue;
          const blockedTurnId = thread.latestTurn?.turnId ?? null;
          if (blockedTurnId === null) continue;
          // Cheap spacing pre-filter, so the common case costs no detail read:
          // every nudge restarts the session clock, so a thread that just
          // failed cannot be due for its next one.
          const blockedSinceMs = Date.parse(thread.session?.updatedAt ?? "");
          const tooSoon =
            !sweepOptions.nudgeLongBlocked &&
            !Number.isNaN(blockedSinceMs) &&
            now - blockedSinceMs < workflowNudgeDelayMs(0);
          if (tooSoon) continue;
          candidates.push({ kind: "nudge", threadId: thread.id, pinnedTurnId: blockedTurnId });
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

        /**
         * Nudge a blocked thread, reusing an already-loaded detail when the
         * caller has one. Returns whether it acted.
         */
        const nudgeBlockedThread = (
          thread: OrchestrationThread,
          loadedDetail?: OrchestrationThread,
        ) =>
          Effect.gen(function* () {
            if (!isWorkflowNudgeCandidate({ threads: confirmedModel.threads, thread })) {
              return false;
            }
            const blockedTurnId = thread.latestTurn?.turnId ?? null;
            if (blockedTurnId === null) return false;
            const detail =
              loadedDetail ??
              Option.getOrUndefined(
                yield* projectionSnapshotQuery
                  .getThreadDetailById(thread.id)
                  .pipe(Effect.orElseSucceed(() => Option.none<OrchestrationThread>())),
              );
            if (detail === undefined) return false;
            return yield* reconcileNudgeCandidate({
              readModel: confirmedModel,
              thread,
              blockedTurnId,
              detail,
              nudgeIntervalMs: sweepOptions.nudgeIntervalMs,
              nowMs: yield* Clock.currentTimeMillis,
              updatedAt,
            });
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("stale-turn.reconciler.nudge-failed", {
                threadId: thread.id,
                cause,
              }).pipe(Effect.as(false)),
            ),
          );

        let settledCount = 0;
        for (const candidate of candidates) {
          const thread = confirmedModel.threads.find((entry) => entry.id === candidate.threadId);
          if (thread === undefined || thread.deletedAt !== null) continue;
          if (confirmedLiveThreadIds.has(thread.id)) continue;

          let pinnedTurnId: TurnId | null = candidate.pinnedTurnId;
          let detail: OrchestrationThread | undefined;

          if (candidate.kind === "nudge") {
            // A new turn since detection means the thread is no longer blocked
            // on the failure this candidate was raised for.
            if (thread.latestTurn?.turnId !== candidate.pinnedTurnId) continue;
            if (yield* nudgeBlockedThread(thread)) settledCount += 1;
            continue;
          }

          if (candidate.kind === "running") {
            if (!hasRunningTurnSignature(thread)) continue;
            if (sweepOptions.recoverInactiveWorkflows && isStartingProviderLaunch(thread)) {
              continue;
            }
            if (pinTurnId(thread) !== candidate.pinnedTurnId) continue;
          } else if (candidate.kind === "resumable-error") {
            if (hasRunningTurnSignature(thread)) continue;
            if (!hasResumableErrorSignature(confirmedModel, thread)) continue;
            detail = Option.getOrUndefined(
              yield* projectionSnapshotQuery
                .getThreadDetailById(thread.id)
                .pipe(Effect.orElseSucceed(() => Option.none<OrchestrationThread>())),
            );
            if (detail === undefined) continue;
            // Containment: the fast lane only re-inspects threads it already
            // resumed. Any other blocked thread belongs to the nudge path,
            // which is patient where this one converges.
            if (countResumeActivities(detail) === 0) {
              if (
                yield* nudgeBlockedThread(
                  detail.latestTurn === null
                    ? thread
                    : { ...thread, latestTurn: detail.latestTurn },
                  detail,
                )
              ) {
                settledCount += 1;
              }
              continue;
            }
            // The settle nulls the snapshot's latestTurn join, so a crashed
            // resume falls back to the pin recorded on the resume activity.
            pinnedTurnId =
              thread.latestTurn?.state === "error" || thread.latestTurn?.state === "interrupted"
                ? thread.latestTurn.turnId
                : lastResumeActivityInterruptedTurnId(detail);
            if (pinnedTurnId === null) continue;
          } else {
            if (
              hasRunningTurnSignature(thread) ||
              !hasInactiveWorkflowSignature(confirmedModel, thread)
            ) {
              continue;
            }
            detail = Option.getOrUndefined(
              yield* projectionSnapshotQuery
                .getThreadDetailById(thread.id)
                .pipe(Effect.orElseSucceed(() => Option.none<OrchestrationThread>())),
            );
            const latestTurn = detail?.latestTurn;
            if (detail === undefined) continue;
            if (latestTurn === null || latestTurn === undefined) {
              pinnedTurnId = startupRecoveryTurnId(thread.id);
            } else if (isWorkflowThreadPaused(confirmedModel.threads, thread.id)) {
              pinnedTurnId = latestTurn.turnId;
            } else if (latestTurn.state === "error") {
              if (yield* nudgeBlockedThread({ ...thread, latestTurn }, detail)) settledCount += 1;
              continue;
            } else {
              if (latestTurn.state !== "running" && latestTurn.state !== "interrupted") continue;
              pinnedTurnId = latestTurn.turnId;
            }
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
        // Finish the boot pass before startup continues. Provider-session
        // reconciliation has already marked every orphan, so this pass sees a
        // stable snapshot and either resumes the workflow or honors its human
        // pause. Running this in the background used to race that marking and
        // could leave a workflow waiting for the slower periodic sweep.
        yield* safeSweep({
          graceMs: 0,
          startingProviderLaunchGraceMs,
          confirmDelayMs: 0,
          nudgeIntervalMs: 0,
          recoverInactiveWorkflows: true,
          nudgeLongBlocked: true,
        });

        yield* Effect.forkScoped(
          safeSweep({
            graceMs,
            startingProviderLaunchGraceMs,
            confirmDelayMs,
            nudgeIntervalMs,
            recoverInactiveWorkflows: false,
            nudgeLongBlocked: false,
          }).pipe(Effect.repeat(Schedule.spaced(Duration.millis(sweepIntervalMs)))),
        );

        yield* Effect.logInfo("stale-turn.reconciler.started", {
          sweepIntervalMs,
          graceMs,
          startingProviderLaunchGraceMs,
          confirmDelayMs,
          maxResumeAttempts,
          nudgeIntervalMs,
          maxNudgeAttempts,
        });
      });

    return {
      start,
    } satisfies StaleTurnReconcilerShape;
  });

export const makeStaleTurnReconcilerLive = (options?: StaleTurnReconcilerLiveOptions) =>
  Layer.effect(StaleTurnReconciler, makeStaleTurnReconciler(options));

export const StaleTurnReconcilerLive = makeStaleTurnReconcilerLive();
