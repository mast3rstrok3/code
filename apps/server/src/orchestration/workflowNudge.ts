/**
 * A workflow thread whose turn *failed* is blocked, not dead.
 *
 * Provider outages, transport hiccups and plan usage limits (Claude's rolling
 * five-hour window is the common one) end a turn with an error and take the
 * provider session down with it. The stage that owns that thread cannot tell
 * "the agent gave up" from "the account is rate limited for the next four
 * hours", and treating the second as the first is expensive: the owning reactor
 * relaunches the stage in a fresh thread on its next 30s sweep, that thread
 * dies on the same limit, and the run either burns its attempt budget or fills
 * with dead threads until a human notices.
 *
 * So a blocked thread is nudged instead: the same thread, keeping its context,
 * gets a short "your turn stopped, continue" prompt once shortly after the
 * failure, then on a slow cadence for as long as it stays blocked. The reactors
 * that own the stage defer to the nudge while it is pending, so nothing is
 * relaunched or failed underneath it.
 *
 * The reconciler that performs the nudges is
 * `Layers/StaleTurnReconciler.ts`; this module holds the vocabulary both sides
 * share, so a stage owner can never wait for a nudge that will not come.
 */
import type { OrchestrationThreadWorkflowRole, ProviderFailureRecovery } from "@t3tools/contracts";
import * as Predicate from "effect/Predicate";

import { isWorkflowThreadPaused, type WorkflowPauseThread } from "./workflowPause.ts";

export const WORKFLOW_NUDGE_ACTIVITY_KIND = "workflow-nudged";

/**
 * Written to `session.lastError` when the nudge budget runs out. It is the
 * hand-back signal: a stage owner that reads it stops deferring and applies its
 * normal failure handling on the spot, instead of waiting out the deferral
 * window.
 */
export const WORKFLOW_NUDGE_EXHAUSTED_MESSAGE =
  "Workflow nudges exhausted; the thread stayed blocked after repeated retries.";

export const WORKFLOW_INTERRUPTION_ERROR_MESSAGE =
  "Provider session lost while a turn was running; settled by the stale-turn reconciler.";

export const ORPHANED_PROVIDER_SESSION_ERROR =
  "Provider session did not survive a server restart. Send a new message to continue.";

export const STALE_TURN_RESUME_ACTIVITY_KIND = "stale-turn-resumed";

/** First retry after a failed turn. Most provider failures are transient. */
export const WORKFLOW_NUDGE_FIRST_DELAY_MS = 60 * 1000;

/**
 * Spacing between later nudges. Long enough that waiting out a five-hour usage
 * limit costs ~30 retries, short enough that a run resumes within ten minutes
 * of the limit lifting.
 */
export const WORKFLOW_NUDGE_INTERVAL_MS = 10 * 60 * 1000;

/**
 * Retry ceiling per thread: roughly eight hours at the ten-minute cadence.
 * Comfortably outlasts a five-hour usage window, and still converges on a human
 * within a working day when the thread is broken rather than blocked (revoked
 * credentials, a provider that fails every start).
 */
export const WORKFLOW_NUDGE_MAX_ATTEMPTS = 48;
export const WORKFLOW_RECOVERY_WINDOW_MS = 8 * 60 * 60 * 1000;
export const WORKFLOW_RECOVERY_UNKNOWN_MAX_ATTEMPTS = 2;
export const WORKFLOW_RECOVERY_INITIAL_JITTER_MAX_MS = 15 * 1000;
export const WORKFLOW_RECOVERY_LATER_JITTER_MAX_MS = 60 * 1000;

const STAGE_RETRY_OWNED_WORKFLOW_ROLES: ReadonlySet<OrchestrationThreadWorkflowRole> = new Set([
  "implementation-worker",
  "implementation-validator",
  "implementation-fixer",
  "implementation-code-reviewer",
  "implementation-qa-reviewer",
  "implementation-change-request-babysitter",
]);

const SINGLE_RESUME_WORKFLOW_ROLES: ReadonlySet<OrchestrationThreadWorkflowRole> = new Set([
  "app-review-reviewer",
  "app-review-planner",
  "app-review-fixer",
]);

/** Keep interrupted-session resumes inside their existing stage budgets. */
export function workflowAutomaticRetryLimit(
  role: OrchestrationThreadWorkflowRole | null,
  configuredLimit: number,
): number {
  if (role !== null && STAGE_RETRY_OWNED_WORKFLOW_ROLES.has(role)) return 0;
  if (role !== null && SINGLE_RESUME_WORKFLOW_ROLES.has(role)) {
    return Math.min(1, configuredLimit);
  }
  return configuredLimit;
}

export function workflowRecoveryAttemptLimit(
  recovery: ProviderFailureRecovery,
  configuredLimit: number,
): number {
  if (recovery.disposition === "terminal") return 0;
  if (recovery.disposition === "unknown") {
    return Math.min(WORKFLOW_RECOVERY_UNKNOWN_MAX_ATTEMPTS, configuredLimit);
  }
  return configuredLimit;
}

function stableThreadHash(threadId: string): number {
  let hash = 2166136261;
  for (let index = 0; index < threadId.length; index += 1) {
    hash ^= threadId.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function workflowRecoveryJitterMs(threadId: string, later: boolean): number {
  const ceiling = later
    ? WORKFLOW_RECOVERY_LATER_JITTER_MAX_MS
    : WORKFLOW_RECOVERY_INITIAL_JITTER_MAX_MS;
  return stableThreadHash(`${threadId}:${later ? "later" : "initial"}`) % (ceiling + 1);
}

/**
 * How long a stage owner defers to a pending nudge without seeing progress.
 * Every nudge restarts the blocked thread's session clock, so a live nudge
 * cadence keeps the window open indefinitely; if nudging stops without a
 * hand-back (no reconciler in this composition, a dispatch that never landed),
 * the owner reverts to its own recovery after the window instead of hanging.
 */
export const WORKFLOW_NUDGE_DEFERRAL_WINDOW_MS = 2 * WORKFLOW_NUDGE_INTERVAL_MS;

/**
 * Roles a workflow drives on its own. A nudge starts a server-driven turn, so
 * it is only ever aimed at threads no human is expected to be typing in — the
 * interactive orchestrator roles settle and surface as they always have.
 */
export const NUDGEABLE_WORKFLOW_ROLES: ReadonlySet<OrchestrationThreadWorkflowRole> = new Set([
  "implementation-worker",
  "implementation-validator",
  "implementation-fixer",
  "implementation-code-reviewer",
  "implementation-qa-reviewer",
  "implementation-change-request-babysitter",
  "planning-orchestrator",
  "planning-reviewer",
  "product-fix-implementer",
  "fast-feature-implementer",
  "app-review-reviewer",
  "app-review-planner",
  "app-review-fixer",
]);

export interface WorkflowNudgeThread extends WorkflowPauseThread {
  readonly workflowRole: OrchestrationThreadWorkflowRole | null;
  readonly deletedAt: string | null;
  readonly session: {
    readonly status: string;
    readonly activeTurnId: string | null;
    readonly lastError: string | null;
    readonly updatedAt: string;
  } | null;
  readonly latestTurn: { readonly turnId?: string; readonly state: string } | null;
  readonly activities?: ReadonlyArray<{
    readonly kind: string;
    readonly payload: unknown;
    readonly createdAt: string;
  }>;
}

/**
 * True while the reconciler owns an orphaned turn or is handing it to its replacement.
 *
 * Startup marks orphaned sessions errored before the reconciler can claim them.
 * The reconciler then records the resume before it settles the old session and
 * starts the replacement turn. Stage owners can observe either gap. The resume
 * activity ties the second gap to the interrupted turn so a later human stop
 * does not inherit this deferral.
 */
export function isAwaitingStaleTurnResume(input: {
  readonly thread: WorkflowNudgeThread;
  readonly nowMs: number;
}): boolean {
  const { thread } = input;
  if (thread.session?.status !== "error" || thread.latestTurn?.turnId === undefined) {
    return false;
  }
  if (
    thread.session.lastError === ORPHANED_PROVIDER_SESSION_ERROR &&
    thread.latestTurn.state === "running"
  ) {
    const orphanedAtMs = Date.parse(thread.session.updatedAt);
    return (
      !Number.isNaN(orphanedAtMs) && input.nowMs - orphanedAtMs < WORKFLOW_NUDGE_DEFERRAL_WINDOW_MS
    );
  }
  if (thread.session.lastError !== WORKFLOW_INTERRUPTION_ERROR_MESSAGE) return false;
  let resume: NonNullable<WorkflowNudgeThread["activities"]>[number] | undefined;
  const activities = thread.activities ?? [];
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (activity?.kind !== STALE_TURN_RESUME_ACTIVITY_KIND) continue;
    resume = activity;
    break;
  }
  if (
    resume === undefined ||
    !Predicate.isObject(resume.payload) ||
    resume.payload["interruptedTurnId"] !== thread.latestTurn.turnId
  ) {
    return false;
  }
  const resumedAtMs = Date.parse(resume.createdAt);
  if (Number.isNaN(resumedAtMs)) return false;
  return input.nowMs - resumedAtMs < WORKFLOW_NUDGE_DEFERRAL_WINDOW_MS;
}

/**
 * The thread ran a turn, the turn failed, and nothing is running now.
 *
 * Failure is read off the turn rather than the session: a provider that tears
 * its session down after an error leaves `stopped`, one that keeps it leaves
 * `error`, and neither says whether a turn was lost. An interrupted turn is
 * excluded — that is a human pressing Stop.
 *
 * A session that has given up counts even while it still names the turn it
 * gave up on. Providers report the failure first and clear the active turn in a
 * second event, and a stage owner that reconciles inside that window would read
 * a failed thread the nudge path had not claimed, and end the run on it.
 */
export function isBlockedAfterFailedTurn(thread: WorkflowNudgeThread): boolean {
  const session = thread.session;
  if (thread.deletedAt !== null || thread.latestTurn?.state !== "error" || session === null) {
    return false;
  }
  if (session.status === "running" || session.status === "starting") return false;
  const sessionGaveUp = session.status === "error" || session.status === "stopped";
  return sessionGaveUp || session.activeTurnId === null;
}

/** True once the nudge path has given up on this thread. */
export function hasExhaustedWorkflowNudges(thread: WorkflowNudgeThread): boolean {
  return thread.session?.lastError === WORKFLOW_NUDGE_EXHAUSTED_MESSAGE;
}

/**
 * How long to wait before the next nudge, given how many have already gone out.
 */
export function workflowNudgeDelayMs(priorAttempts: number): number {
  return priorAttempts === 0 ? WORKFLOW_NUDGE_FIRST_DELAY_MS : WORKFLOW_NUDGE_INTERVAL_MS;
}

/**
 * A thread the nudge path will pick up: blocked, autonomous, not paused, not
 * given up on. Whether the workflow still wants its result is decided by the
 * reconciler, which is the side that knows the run.
 */
export function isWorkflowNudgeCandidate(input: {
  readonly threads: ReadonlyArray<WorkflowNudgeThread>;
  readonly thread: WorkflowNudgeThread;
}): boolean {
  const { thread, threads } = input;
  if (thread.workflowRole === null || !NUDGEABLE_WORKFLOW_ROLES.has(thread.workflowRole)) {
    return false;
  }
  if (!isBlockedAfterFailedTurn(thread) || hasExhaustedWorkflowNudges(thread)) return false;
  // A paused subtree is waiting for the user, and the decider refuses
  // server-driven turns beneath one: nobody will nudge it.
  return !isWorkflowThreadPaused(threads, thread.id);
}

/**
 * True when the stage that owns this thread should wait rather than relaunch or
 * fail it. Deliberately independent of the run's own bookkeeping: the owner
 * asks only "is this thread blocked and still being nudged?".
 */
export function isAwaitingWorkflowNudge(input: {
  readonly threads: ReadonlyArray<WorkflowNudgeThread>;
  readonly thread: WorkflowNudgeThread;
  readonly nowMs: number;
}): boolean {
  if (!isWorkflowNudgeCandidate(input)) return false;
  const blockedSinceMs = Date.parse(input.thread.session?.updatedAt ?? "");
  if (Number.isNaN(blockedSinceMs)) return false;
  return input.nowMs - blockedSinceMs < WORKFLOW_NUDGE_DEFERRAL_WINDOW_MS;
}
