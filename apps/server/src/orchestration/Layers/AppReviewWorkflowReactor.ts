import {
  type AppDevStackStatus,
  APP_REVIEW_PREVIEW_URL_ENV,
  type AppReviewScope,
  CommandId,
  AppReviewId,
  EMPTY_APP_REVIEW_EVIDENCE,
  hasCompleteAppReviewEvidence,
  hasScreenshotBackedAppReviewFailure,
  type AppReviewRecord,
  type AppReviewWorkflowCycle,
  type AppReviewWorkflowPhase,
  type AppReviewWorkflowFailure,
  type AppReviewWorkflowFailureReason,
  type AppReviewWorkflowFixResult,
  type AppReviewWorkflowRepairTicket,
  type AppReviewWorkflowRun,
  type AppReviewWorkflowWorkspaceRevision,
  MessageId,
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationImplementationRun,
  type OrchestrationReadModel,
  type OrchestrationThread,
  WORKFLOW_AUTOMATION_RUNTIME_MODE,
} from "@t3tools/contracts";
import {
  ALL_APP_REVIEW_PARTS,
  appReviewPartsForScope,
  appReviewScopeForParts,
  describeAppReviewParts,
  intersectAppReviewParts,
  resolveLayeredAppReviewStepParts,
  type AppReviewParts,
} from "@t3tools/shared/appReviewParts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { extractPreviewUrls } from "@t3tools/shared/preview";
import { resolveAppReviewE2eCommands } from "@t3tools/shared/t3ProjectFile";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Stream from "effect/Stream";

import { AppDevStackManager } from "../../appDevStack/AppDevStackManager.ts";
import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
import { T3ProjectFileLoader } from "../../project/T3ProjectFileLoader.ts";
import { ServerActivation } from "../../serverActivation.ts";
import {
  appendWorkflowSkillCommandSection,
  WORKFLOW_PROMPT_IDS,
} from "../../provider/WorkflowPromptRegistry.ts";
import { ReviewService } from "../../review/ReviewService.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  AppReviewWorkflowReactor,
  type AppReviewWorkflowReactorShape,
} from "../Services/AppReviewWorkflowReactor.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  isAwaitingStaleTurnResume,
  isAwaitingWorkflowNudge,
  type WorkflowNudgeThread,
} from "../workflowNudge.ts";
import { isWorkflowThreadPaused } from "../workflowPause.ts";
import {
  findWorkflowStepModels,
  findWorkflowStepReviewParts,
  resolveWorkflowStepModelSelection,
  resolveWorkflowSubagentSpawnDefinition,
} from "../workflowSubagents.ts";

type AppReviewWorkflowEvent = Extract<
  OrchestrationEvent,
  {
    type:
      | "thread.app-review-workflow-launched"
      | "thread.app-review-workflow-resume-requested"
      | "thread.app-review-workflow-rerun-requested"
      | "thread.app-review-workflow-cancel-requested"
      | "thread.app-review-updated"
      | "thread.proposed-plan-upserted"
      | "thread.turn-diff-completed"
      | "thread.activity-appended"
      | "thread.session-set";
  }
>;

const terminalStatuses = new Set(["passed", "failed", "exhausted"]);
const APP_REVIEW_WORKFLOW_ACTIVITY_KINDS = new Set<string>([
  "approval.requested",
  "user-input.requested",
  "app-review-repair-tickets",
  "app-review-fix-result",
]);
const APP_REVIEW_IMPLEMENT_SKILL_ID = "matt-pocock.implement";
const APP_REVIEW_TO_TICKETS_SKILL_ID = "matt-pocock.to-tickets";
export const APP_REVIEW_FIXER_IMPLEMENTATION_ONLY_INSTRUCTION =
  "This is an implementation-only phase. Do not call preview_* or app_review_* tools, collect browser evidence, or update the review verdict. The workflow starts a fresh reviewer after it receives your app-review-fix-result directive, so unavailable review tools must not block this repair.";

export function isAppReviewWorkflowActivityKind(kind: string): boolean {
  return APP_REVIEW_WORKFLOW_ACTIVITY_KINDS.has(kind);
}

export function isAppReviewWorkflowSessionStatus(status: string): boolean {
  return status === "starting" || status === "running" || status === "error";
}

export function appReviewPhaseModelStepWorkflowPromptId(
  run: Pick<AppReviewWorkflowRun, "caller">,
): string {
  return run.caller.type === "implementation" && run.caller.ticketId !== undefined
    ? WORKFLOW_PROMPT_IDS.implementationTddCodex
    : WORKFLOW_PROMPT_IDS.implementationBrowserAppReviewCodex;
}

interface AppDevStackPreviewLookup {
  readonly stack: {
    readonly id: string;
    readonly displayName: string | null;
    readonly status: AppDevStackStatus;
    readonly services: ReadonlyArray<{
      readonly name: string;
      readonly status: string;
      readonly health?: string | null;
      readonly error?: string | null;
    }> | null;
  } | null;
  readonly frontendUrl: string | null;
}

export type StandalonePreviewTargetResolution =
  | { readonly _tag: "Resolved"; readonly previewTargets: ReadonlyArray<string> }
  | { readonly _tag: "Blocked"; readonly detailMarkdown: string };

export function selectStandalonePreviewTargets(input: {
  readonly lookup: AppDevStackPreviewLookup | null;
  readonly lookupError: string | null;
  readonly fallbackTargets: ReadonlyArray<string>;
  /**
   * Targets the user named at launch. They review exactly what they asked for,
   * so a matching App Dev Stack does not get to substitute its own frontend.
   */
  readonly pinnedTargets?: ReadonlyArray<string>;
}): StandalonePreviewTargetResolution {
  const pinnedTargets = Array.from(
    new Set((input.pinnedTargets ?? []).map((target) => target.trim()).filter(Boolean)),
  );
  if (pinnedTargets.length > 0) return { _tag: "Resolved", previewTargets: pinnedTargets };
  const fallbackTargets = Array.from(
    new Set(input.fallbackTargets.map((target) => target.trim()).filter(Boolean)),
  );
  const stackMatched = input.lookup?.stack !== null || input.lookup?.frontendUrl !== null;
  if (input.lookup !== null && stackMatched) {
    const stack = input.lookup.stack;
    if (stack !== null && stack.status !== "running") {
      return {
        _tag: "Blocked",
        detailMarkdown: `The App Dev Stack '${stack.displayName ?? stack.id}' for this worktree is '${stack.status}', not 'running'.`,
      };
    }
    const failedService = stack?.services?.find(
      (service) =>
        (service.error !== null && service.error !== undefined) ||
        service.health === "unhealthy" ||
        service.status === "error" ||
        service.status === "stopped",
    );
    if (failedService !== undefined) {
      return {
        _tag: "Blocked",
        detailMarkdown: `The App Dev Stack service '${failedService.name}' is unhealthy (${failedService.error ?? failedService.health ?? failedService.status}).`,
      };
    }
    if (input.lookup.frontendUrl === null) {
      return {
        _tag: "Blocked",
        detailMarkdown: "The App Dev Stack for this worktree has no frontend URL.",
      };
    }
    return { _tag: "Resolved", previewTargets: [input.lookup.frontendUrl] };
  }
  if (fallbackTargets.length > 0) {
    return { _tag: "Resolved", previewTargets: fallbackTargets };
  }
  return {
    _tag: "Blocked",
    detailMarkdown:
      input.lookupError === null
        ? "No App Dev Stack or fallback preview URL was found for this worktree. Start the App Dev Stack, then retry App Review."
        : `The App Dev Stack for this worktree could not be resolved, and no fallback preview URL is available. ${input.lookupError}`,
  };
}

export function nextAppReviewWorkflowAction(
  run: AppReviewWorkflowRun,
): "none" | "review" | "exhaust" | "reconcile-review" | "reconcile-plan" | "reconcile-fix" {
  if (run.status !== "running") return "none";
  switch (run.activePhase) {
    case null:
      if (
        run.caller.type === "implementation" &&
        run.cycles.at(-1)?.fixResult?.status === "succeeded"
      ) {
        return "none";
      }
      // Between cycles with nothing left to spend, the run is over. Saying so
      // here rather than only where the last cycle ended is what lets a restart
      // finish a run whose final cycle landed and whose close did not.
      return run.cyclesUsed < run.cycleBudget ? "review" : "exhaust";
    case "review":
      return "reconcile-review";
    case "planning":
      return "reconcile-plan";
    case "fixing":
      return "reconcile-fix";
  }
}

export function selectReviewRunToStart(
  runId: AppReviewWorkflowRun["id"],
  runs: ReadonlyArray<AppReviewWorkflowRun>,
): AppReviewWorkflowRun | null {
  const run = runs.find((candidate) => candidate.id === runId);
  if (
    run === undefined ||
    run.status !== "running" ||
    run.activePhase !== null ||
    run.cyclesUsed >= run.cycleBudget
  ) {
    return null;
  }
  return run;
}

/**
 * Find the planning ticket an embedded App Review is repairing.
 *
 * Tickets live on the thread that authored them — the planning root of the
 * run — while an embedded review only holds the reviewer, the worker worktree
 * it reviewed, and the workflow root id. Searching those threads alone finds
 * nothing, so the whole run fails with "parent ticket unavailable" for every
 * ticket. Prefer the run's workflow root, then fall back to any thread that
 * owns the ticket: ticket ids are unique, so a wider search cannot mismatch.
 */
export function findAppReviewParentTicket(
  threads: ReadonlyArray<{
    readonly id: string;
    readonly planningWorkflow?:
      | { readonly tickets: ReadonlyArray<{ readonly id: string; readonly key?: string }> }
      | null
      | undefined;
  }>,
  ticketId: string,
  rootThreadId: string | undefined,
): { readonly id: string; readonly key?: string } | undefined {
  const ordered =
    rootThreadId === undefined
      ? threads
      : [
          ...threads.filter((thread) => thread.id === rootThreadId),
          ...threads.filter((thread) => thread.id !== rootThreadId),
        ];
  for (const thread of ordered) {
    const ticket = thread.planningWorkflow?.tickets.find((candidate) => candidate.id === ticketId);
    if (ticket !== undefined) return ticket;
  }
  return undefined;
}

/**
 * Whether the thread driving a phase has stopped for good.
 *
 * A session that is starting or running answers this on its own, whatever the
 * latest turn says. A checkpoint that fails while the provider is still coming
 * up rewrites the latest turn to `error` before the agent has run a token, and
 * reading that as a dead thread ends runs whose reviewer was only queued.
 */
export function threadTurnFailed(thread: {
  readonly latestTurn: { readonly state: string } | null;
  readonly session: { readonly status: string } | null;
}): boolean {
  if (thread.session?.status === "starting" || thread.session?.status === "running") return false;
  return (
    thread.latestTurn?.state === "error" ||
    thread.latestTurn?.state === "interrupted" ||
    thread.session?.status === "error" ||
    thread.session?.status === "stopped"
  );
}

/** A one-turn phase finished cleanly and cannot emit another result on this thread. */
export function phaseTurnCompleted(thread: {
  readonly latestTurn: { readonly state: string } | null;
  readonly session: { readonly status: string } | null;
}): boolean {
  if (thread.session?.status === "starting" || thread.session?.status === "running") return false;
  return thread.latestTurn?.state === "completed";
}

/**
 * What a phase thread's state means for the run: still working, waiting on
 * automatic recovery, or failed for good. The `nudging` state covers both the
 * stale-turn resume handoff and provider-failure nudges.
 *
 * Waiting matters because a single API error or plan usage limit used to end
 * the whole App Review run and spend its repair cycle. The wait stays bounded.
 * A thread fails here once the recovery window expires or no retry path owns it.
 */
export function appReviewPhaseThreadState(input: {
  readonly threads: ReadonlyArray<WorkflowNudgeThread>;
  readonly thread: WorkflowNudgeThread;
  readonly nowMs: number;
}): "working" | "nudging" | "failed" {
  if (!threadTurnFailed(input.thread)) return "working";
  return isAwaitingStaleTurnResume(input) || isAwaitingWorkflowNudge(input) ? "nudging" : "failed";
}

export function terminalReviewAction(review: AppReviewRecord): "passed" | "planning" {
  if (review.status === "passed" && review.document.verdict === "passed") return "passed";
  return "planning";
}

export function successfulFixAction(
  run: AppReviewWorkflowRun,
): "exhausted" | "review" | "await-preview-refresh" {
  if (run.cyclesUsed >= run.cycleBudget) return "exhausted";
  return run.caller.type === "standalone" ? "review" : "await-preview-refresh";
}

export const APP_REVIEW_PHASE_MAX_LAUNCHES = 2;
export const APP_REVIEW_RECOVERY_SWEEP_INTERVAL_MS = 30_000;

export function appReviewPhaseLaunchCount(
  cycle: AppReviewWorkflowCycle,
  phase: AppReviewWorkflowPhase,
): number {
  switch (phase) {
    case "review":
      return cycle.reviewLaunchCount ?? 1;
    case "planning":
      return cycle.planningLaunchCount ?? (cycle.plannerThreadId == null ? 0 : 1);
    case "fixing":
      return cycle.fixingLaunchCount ?? (cycle.fixerThreadId === null ? 0 : 1);
  }
}

export function appReviewPhaseFailureAction(
  cycle: AppReviewWorkflowCycle,
  phase: AppReviewWorkflowPhase,
): "retry-phase" | "fail-run" {
  return appReviewPhaseLaunchCount(cycle, phase) < APP_REVIEW_PHASE_MAX_LAUNCHES
    ? "retry-phase"
    : "fail-run";
}

export interface FailedAppReviewPhaseRecovery {
  readonly phase: AppReviewWorkflowPhase;
  readonly threadId: ThreadId;
  readonly mode: "claim" | "resume-claim" | "observe-claim";
}

/**
 * Claims one continuation for a failed phase that still owns its parent stage.
 *
 * Older runtimes made a nested run terminal after two provider turns. The
 * parent then retained that exact run and entered human attention. Recover only
 * that current pair, once, so historical reviews that no parent awaits remain
 * terminal.
 */
export function recoverableFailedAppReviewPhase(input: {
  readonly run: AppReviewWorkflowRun;
  readonly implementationRuns: ReadonlyArray<OrchestrationImplementationRun>;
}): FailedAppReviewPhaseRecovery | null {
  const { run } = input;
  if (run.status !== "failed" || run.caller.type !== "implementation") return null;
  const caller = run.caller;
  const cycle = run.cycles.at(-1);
  const failure = run.failure ?? cycle?.failure ?? null;
  const phase = failure?.phase ?? null;
  const recoveryContinuationCount = cycle?.recoveryContinuationCount ?? 0;
  const phaseLaunchCount =
    cycle === undefined || phase === null ? null : appReviewPhaseLaunchCount(cycle, phase);
  if (
    cycle === undefined ||
    cycle.status !== "failed" ||
    phase === null ||
    recoveryContinuationCount > 1 ||
    phaseLaunchCount === null ||
    phaseLaunchCount < APP_REVIEW_PHASE_MAX_LAUNCHES ||
    !failure?.detailMarkdown.includes(
      `${phase} exhausted its ${String(APP_REVIEW_PHASE_MAX_LAUNCHES)} phase launches.`,
    )
  ) {
    return null;
  }
  const parent = input.implementationRuns.find(
    (candidate) => candidate.id === caller.implementationRunId,
  );
  const halt = parent?.automationHalt ?? null;
  if (parent === undefined) return null;
  const parentIsHaltedForReview =
    parent.status === "needs-human-attention" &&
    halt?.stage === "app-review" &&
    halt.category === "review-blocked";
  const ticketId = caller.ticketId;
  if (ticketId === undefined) {
    if (
      parent.appReviewWorkflowRunIds.at(-1) !== run.id ||
      (parentIsHaltedForReview
        ? halt.ticketId !== undefined
        : recoveryContinuationCount === 0 || parent.status !== "qa-reviewing" || halt !== null)
    )
      return null;
  } else {
    const ticket = parent.ticketStates.find((candidate) => candidate.ticketId === ticketId);
    if (
      ticket?.status !== "app-reviewing" ||
      ticket.appReviewWorkflowRunId !== run.id ||
      (parentIsHaltedForReview
        ? halt.ticketId !== ticketId
        : recoveryContinuationCount === 0 || parent.status !== "running" || halt !== null)
    ) {
      return null;
    }
  }
  const threadId =
    phase === "review"
      ? cycle.reviewerThreadId
      : phase === "planning"
        ? (cycle.plannerThreadId ?? null)
        : cycle.fixerThreadId;
  if (threadId === null) return null;
  return {
    phase,
    threadId,
    mode:
      recoveryContinuationCount === 0
        ? "claim"
        : phaseLaunchCount === APP_REVIEW_PHASE_MAX_LAUNCHES
          ? "resume-claim"
          : "observe-claim",
  };
}

export function reopenFailedAppReviewPhase(input: {
  readonly run: AppReviewWorkflowRun;
  readonly phase: AppReviewWorkflowPhase;
  readonly workspaceRevision: AppReviewWorkflowWorkspaceRevision;
  readonly occurredAt: string;
  readonly incrementRecoveryCount?: boolean;
  readonly incrementReviewLaunchCount?: boolean;
}): AppReviewWorkflowRun | null {
  const cycle = input.run.cycles.at(-1);
  if (cycle === undefined) return null;
  return {
    ...input.run,
    status: "running",
    outcome: null,
    failure: null,
    finalHeadSha: null,
    activePhase: input.phase,
    activeThreadId:
      input.phase === "review"
        ? cycle.reviewerThreadId
        : input.phase === "planning"
          ? (cycle.plannerThreadId ?? null)
          : cycle.fixerThreadId,
    workspaceRevision: input.workspaceRevision,
    cycles: input.run.cycles.map((entry) =>
      entry.cycleNumber === cycle.cycleNumber
        ? {
            ...entry,
            status:
              input.phase === "review"
                ? ("reviewing" as const)
                : input.phase === "planning"
                  ? ("planning" as const)
                  : ("fixing" as const),
            reviewLaunchCount:
              input.phase === "review" && input.incrementReviewLaunchCount !== false
                ? appReviewPhaseLaunchCount(entry, "review") + 1
                : appReviewPhaseLaunchCount(entry, "review"),
            recoveryContinuationCount:
              (entry.recoveryContinuationCount ?? 0) +
              (input.incrementRecoveryCount === false ? 0 : 1),
            failure: null,
            workspaceRevision: input.workspaceRevision,
            completedAt: null,
          }
        : entry,
    ),
    updatedAt: input.occurredAt,
    completedAt: null,
  };
}

/** A claimed continuation is queued but its new turn has not replaced the old terminal turn yet. */
export function appReviewRecoveryTurnPending(
  run: AppReviewWorkflowRun,
  cycle: AppReviewWorkflowCycle,
  thread: {
    readonly latestTurn: { readonly requestedAt: string; readonly state: string } | null;
    readonly session: { readonly status: string } | null;
  },
): boolean {
  if ((cycle.recoveryContinuationCount ?? 0) === 0 || run.activePhase === null) return false;
  if (thread.session?.status === "starting" || thread.session?.status === "running") return false;
  if (thread.latestTurn === null || thread.latestTurn.requestedAt < run.updatedAt) return true;
  return (
    thread.latestTurn.state === "running" &&
    thread.session?.status !== "starting" &&
    thread.session?.status !== "running"
  );
}

export function retryReviewPhaseInCycle(input: {
  readonly cycle: AppReviewWorkflowCycle;
  readonly failure: AppReviewWorkflowFailure;
  readonly workspaceRevision: AppReviewWorkflowWorkspaceRevision;
}): AppReviewWorkflowCycle {
  return {
    ...input.cycle,
    status: "reviewing",
    reviewLaunchCount: appReviewPhaseLaunchCount(input.cycle, "review") + 1,
    planningLaunchCount: 0,
    fixingLaunchCount: 0,
    reviewVerdict: null,
    actionableFindingsMarkdown: null,
    planId: null,
    plannerThreadId: null,
    plannerTurnId: null,
    fixerThreadId: null,
    repairTickets: [],
    ticketingTurnId: null,
    fixResult: null,
    failure: input.failure,
    workspaceRevision: input.workspaceRevision,
    completedAt: null,
  };
}

/** Whether a provider turn belongs to a phase the run has already left. */
export function isSupersededAppReviewPhaseThread(
  run: Pick<AppReviewWorkflowRun, "activeThreadId" | "cycles">,
  threadId: ThreadId,
): boolean {
  if (run.activeThreadId === threadId) return false;
  return run.cycles.some(
    (cycle) =>
      cycle.reviewerThreadId === threadId ||
      cycle.plannerThreadId === threadId ||
      cycle.fixerThreadId === threadId ||
      (cycle.supersededThreadIds ?? []).includes(threadId),
  );
}

/** A check an earlier cycle passed, offered to the next reviewer to carry forward. */
export type CarryableAppReviewCheck = {
  readonly id: string;
  readonly label: string;
  /** The cycle that actually drove the browser, not the one that last carried it. */
  readonly cycleNumber: number;
};

/**
 * What earlier cycles of a run established, in the form the next cycle needs.
 *
 * Prior actionable findings never become carryable. A repair verified against
 * the cycle before it is not verified against the repair that followed, so
 * those checks are exercised again every cycle. Everything else the browser has
 * already passed is offered to the next reviewer, which is where the savings
 * are: re-driving an untouched flow is the most expensive thing a cycle can do.
 * A check a later cycle stopped passing drops back out of the offer.
 */
export function priorCycleChecks(input: {
  readonly run: AppReviewWorkflowRun;
  readonly currentCycleNumber: number;
  readonly priorReviews: ReadonlyArray<AppReviewRecord>;
}): {
  readonly findingIds: ReadonlyArray<string>;
  readonly carryable: ReadonlyArray<CarryableAppReviewCheck>;
  readonly passedCheckIdsByCycle: ReadonlyMap<number, ReadonlySet<string>>;
} {
  const priorCycles = input.run.cycles
    .filter((cycle) => cycle.cycleNumber < input.currentCycleNumber)
    .toSorted((left, right) => left.cycleNumber - right.cycleNumber);
  const reviewById = new Map(input.priorReviews.map((review) => [review.id, review]));
  const findingIds = priorCycles
    .flatMap((cycle) => reviewById.get(cycle.reviewId)?.document.findings ?? [])
    .filter((finding) => finding.severity !== "note")
    .map((finding) => finding.id);
  const findingIdSet = new Set(findingIds);
  const carryable = new Map<string, CarryableAppReviewCheck>();
  const passedCheckIdsByCycle = new Map<number, ReadonlySet<string>>();
  for (const cycle of priorCycles) {
    const checks = reviewById.get(cycle.reviewId)?.document.checks ?? [];
    passedCheckIdsByCycle.set(
      cycle.cycleNumber,
      new Set(checks.filter((check) => check.status === "passed").map((check) => check.id)),
    );
    for (const check of checks) {
      if (check.status !== "passed") {
        carryable.delete(check.id);
        continue;
      }
      if (findingIdSet.has(check.id)) continue;
      carryable.set(check.id, {
        id: check.id,
        label: check.label,
        cycleNumber: check.carriedFromCycle ?? cycle.cycleNumber,
      });
    }
  }
  return { findingIds, carryable: [...carryable.values()], passedCheckIdsByCycle };
}

/**
 * A reviewer-authored verdict is not enough to close the workflow. Passing reviews must contain a
 * complete, internally consistent check matrix and must explicitly verify every actionable finding
 * from earlier cycles. This prevents a narrow happy-path rerun from silently closing a broader
 * failed review.
 */
/**
 * Stable check ids for a project's e2e commands: the first command is `e2e-1`
 * in every cycle, so repair verification and the pass gate can find it by id.
 */
export function e2eCheckIdsForCommands(commands: ReadonlyArray<string>): ReadonlyArray<string> {
  return commands.map((_, index) => `e2e-${index + 1}`);
}

/**
 * The parts this run actually verifies with, or null when Settings leave it
 * nothing to run.
 *
 * Three layers intersect: what Settings allow for the step, what the run
 * requested (the ticket's scope), and what the project makes available. A
 * missing e2e suite degrades an e2e request to browser when Settings allow the
 * browser at all — an intent should not strand a review — but a part Settings
 * turned off stays off, which is what makes the toggle a prohibition rather
 * than a preference.
 */
export function resolveEffectiveAppReviewScope(input: {
  readonly run: Pick<AppReviewWorkflowRun, "appReviewScope">;
  readonly settingsParts: AppReviewParts;
  readonly e2eCommandCount: number;
}): AppReviewScope | null {
  const allowed = intersectAppReviewParts(
    input.settingsParts,
    appReviewPartsForScope(input.run.appReviewScope ?? "both"),
  );
  if (appReviewScopeForParts(allowed) === null) return null;
  const available = { e2e: allowed.e2e && input.e2eCommandCount > 0, browser: allowed.browser };
  return appReviewScopeForParts(available) ?? (input.settingsParts.browser ? "browser" : null);
}

/** {@link resolveEffectiveAppReviewScope} with nothing turned off in Settings. */
export function effectiveAppReviewScope(
  run: Pick<AppReviewWorkflowRun, "appReviewScope">,
  e2eCommandCount: number,
): AppReviewScope {
  return (
    resolveEffectiveAppReviewScope({
      run,
      settingsParts: ALL_APP_REVIEW_PARTS,
      e2eCommandCount,
    }) ?? "browser"
  );
}

export function terminalReviewPassFailure(input: {
  readonly run: AppReviewWorkflowRun;
  readonly review: AppReviewRecord;
  readonly priorReviews: ReadonlyArray<AppReviewRecord>;
  /** Required e2e check ids when the project configures `e2eCommands`. */
  readonly e2eCheckIds?: ReadonlyArray<string>;
}): string | null {
  if (input.review.status !== "passed" || input.review.document.verdict !== "passed") return null;
  const checks = input.review.document.checks;
  if (checks.length === 0) {
    return "Browser App Review reported a pass without a check matrix.";
  }
  const incompleteChecks = checks.filter((check) => check.status !== "passed");
  if (incompleteChecks.length > 0) {
    return `Browser App Review reported a pass with incomplete checks: ${incompleteChecks
      .map((check) => `${check.id}=${check.status}`)
      .join(", ")}.`;
  }
  const checksById = new Map(checks.map((check) => [check.id, check]));
  const missingE2eChecks = (input.e2eCheckIds ?? []).filter((id) => !checksById.has(id));
  if (missingE2eChecks.length > 0) {
    return `Browser App Review reported a pass without the required end-to-end checks: ${missingE2eChecks.join(", ")}.`;
  }
  const carriedE2eChecks = (input.e2eCheckIds ?? []).filter(
    (id) => checksById.get(id)?.carriedFromCycle !== undefined,
  );
  if (carriedE2eChecks.length > 0) {
    return `Browser App Review carried end-to-end checks forward instead of rerunning them: ${carriedE2eChecks.join(", ")}.`;
  }
  const actionableFindings = input.review.document.findings.filter(
    (finding) => finding.severity !== "note",
  );
  if (actionableFindings.length > 0) {
    return `Browser App Review reported a pass with unresolved findings: ${actionableFindings
      .map((finding) => finding.id)
      .join(", ")}.`;
  }

  const currentCycle = input.run.cycles.at(-1)?.cycleNumber ?? 0;
  const prior = priorCycleChecks({
    run: input.run,
    currentCycleNumber: currentCycle,
    priorReviews: input.priorReviews,
  });
  const carriedFindingChecks = checks.filter(
    (check) => check.carriedFromCycle !== undefined && prior.findingIds.includes(check.id),
  );
  if (carriedFindingChecks.length > 0) {
    return `Browser App Review carried prior findings forward instead of verifying them: ${carriedFindingChecks
      .map((check) => check.id)
      .join(", ")}.`;
  }
  const unsupportedCarries = checks.filter(
    (check) =>
      check.carriedFromCycle !== undefined &&
      !(prior.passedCheckIdsByCycle.get(check.carriedFromCycle)?.has(check.id) ?? false),
  );
  if (unsupportedCarries.length > 0) {
    return `Browser App Review carried checks forward from cycles that never passed them: ${unsupportedCarries
      .map((check) => `${check.id}@${String(check.carriedFromCycle)}`)
      .join(", ")}.`;
  }
  const passedCheckIds = new Set(checks.map((check) => check.id));
  const missingFindingChecks = prior.findingIds.filter(
    (findingId) => !passedCheckIds.has(findingId),
  );
  if (missingFindingChecks.length > 0) {
    return `Browser App Review did not explicitly verify prior findings: ${missingFindingChecks.join(", ")}.`;
  }
  return null;
}

/**
 * What the reviewer is told to do this cycle.
 *
 * A repair cycle is scoped rather than replayed: the prior findings are
 * exercised again in the browser, and what already passed is carried forward by
 * id unless the repair could plausibly have reached it. The reviewer still owns
 * that judgement, because only it can see what the repair touched.
 */
export function buildReviewPrompt(input: {
  readonly run: AppReviewWorkflowRun;
  readonly cycle: AppReviewWorkflowCycle;
  readonly priorFindingIds: ReadonlyArray<string>;
  readonly carryableChecks: ReadonlyArray<CarryableAppReviewCheck>;
  /** The project's `e2eCommands` from t3.json; empty or absent skips the e2e step. */
  readonly e2eCommands?: ReadonlyArray<string>;
  /** The run's effective scope; absent derives from whether e2e commands exist. */
  readonly reviewScope?: AppReviewScope;
}): string {
  const { run, cycle } = input;
  const scope: AppReviewScope =
    input.reviewScope ?? ((input.e2eCommands?.length ?? 0) > 0 ? "both" : "browser");
  const e2eCommands = scope === "browser" ? [] : (input.e2eCommands ?? []);
  // E2e checks are rerun every cycle, so a prior cycle's pass is never offered
  // back as carryable.
  const e2eCheckIds = new Set(e2eCheckIdsForCommands(e2eCommands));
  const carryableChecks = input.carryableChecks.filter((check) => !e2eCheckIds.has(check.id));
  return appendWorkflowSkillCommandSection(
    [
      run.reviewOnly === true
        ? "Run a single Browser App Review. This run reviews once and does not repair."
        : `Run Browser App Review cycle ${cycle.cycleNumber} of ${run.cycleBudget}.`,
      "",
      "The original brief is the acceptance boundary for every cycle:",
      run.briefMarkdown,
      ...(run.supportingContextMarkdown === null
        ? []
        : ["", "Supporting source context:", run.supportingContextMarkdown]),
      "",
      "Preview targets (try in order):",
      ...run.previewTargets.map((target) => `- ${target}`),
      "These preview targets are authoritative for this App Review cycle. Do not substitute deployment URLs from repository documentation, supporting source context, browser history, or environment conventions. If every listed target is unavailable, report the review failed with concrete details.",
      "",
      `Review parts for this run — ${describeAppReviewParts(appReviewPartsForScope(scope))}. A part marked no is off for this review and must not be run.`,
      ...(e2eCommands.length === 0
        ? []
        : [
            "",
            `Part one of this review is the end-to-end test run. Run each command from the selected worktree, in order, with the environment variable ${APP_REVIEW_PREVIEW_URL_ENV} set to the first preview target above, and record each command as a check with the exact id shown:`,
            ...e2eCommands.map((command, index) => `- e2e-${index + 1}: ${command}`),
            "A passing command is a passed check whose notes summarize the suite result. A failing command is a failed check whose notes name the failing tests. Only failures inside the original acceptance brief, caused by the work under review, or blocking verification of that brief are actionable findings. Record unrelated or pre-existing failures in the check notes or as note-severity findings; do not turn them into repair work for this run. Run these commands fresh every cycle and never carry an e2e check forward.",
            scope === "e2e"
              ? "This review is end-to-end only: the test run is the verification. Skip the browser entirely — do not open the preview or start a recording, and no screenshots are required. Base the verdict on the check matrix."
              : "Part two is the browser review, scoped to what the tests did not prove: acceptance criteria without e2e coverage, visual and interaction quality, and every failure the run surfaced. Do not re-drive a flow a passing e2e test already exercises end-to-end. Evidence requirements are unchanged: still record the session and capture screenshots of the states you verify.",
          ]),
      "",
      scope === "e2e"
        ? "Use the linked durable App Review record and report every actionable finding."
        : "Use the linked durable App Review record. Record the complete flow, capture captioned screenshots, and report every actionable finding. A missing or unavailable preview is a failed review.",
      ...(run.reviewOnly === true
        ? [
            "This run reviews only. Nothing you find will be repaired, so the findings you record are the whole deliverable: state every one concretely enough that someone else can reproduce and fix it. Do not edit files.",
          ]
        : []),
      "A passed verdict requires a non-empty check matrix in which every check is passed. Do not mark required or deferred acceptance work not-applicable; use failed or blocked with concrete detail.",
      ...(input.priorFindingIds.length === 0
        ? []
        : [
            "",
            scope === "e2e"
              ? "This is a repair verification cycle. Verify each prior actionable finding again through the test run and add one passed check with the exact same id before reporting passed:"
              : "This is a repair verification cycle. Exercise each prior actionable finding in the browser again and add one passed check with the exact same id before reporting passed:",
            ...input.priorFindingIds.map((findingId) => `- ${findingId}`),
          ]),
      ...(carryableChecks.length === 0
        ? []
        : [
            "",
            "These checks already passed earlier in this run. Read what the repair changed, and exercise one again only when the repair could plausibly have broken it. Otherwise carry it forward: repeat it in the matrix with the same id, status passed, and `carriedFromCycle` set to the cycle shown here, and spend no browser steps on it. Carried checks count toward the matrix, so a pass still needs every one of them present.",
            ...carryableChecks.map(
              (check) => `- ${check.id} (cycle ${check.cycleNumber}): ${check.label}`,
            ),
          ]),
    ].join("\n"),
    WORKFLOW_PROMPT_IDS.implementationBrowserAppReviewCodex,
  );
}

export function buildAppReviewFixPrompt(input: {
  readonly run: AppReviewWorkflowRun;
  readonly cycle: AppReviewWorkflowCycle;
  readonly e2eCommands: ReadonlyArray<string>;
}): string {
  const continuesInterruptedFix = (input.cycle.fixingLaunchCount ?? 0) > 1;
  return appendWorkflowSkillCommandSection(
    [
      `Implement the App Review repair tickets for run '${input.run.id}', cycle ${input.cycle.cycleNumber}.`,
      ...(continuesInterruptedFix
        ? [
            "",
            "Continuation state:",
            "- A previous fixer worked in this same worktree and stopped before it returned a valid result.",
            "- Inspect Git status, the current diff, and recent commits before editing. Treat those changes as partial work on the repair tickets below.",
            "- Keep useful work, repair or remove incomplete work, and finish every ticket in this durable phase thread.",
          ]
        : []),
      "",
      "Use TDD: write the test each ticket names, watch it fail, then repair. Address every actionable finding together, preserve unrelated work, and run focused validation. Do not ask the user questions.",
      APP_REVIEW_FIXER_IMPLEMENTATION_ONLY_INSTRUCTION,
      ...(input.e2eCommands.length === 0
        ? []
        : [
            `Before reporting succeeded, run the project's end-to-end test commands${
              input.run.previewTargets[0] === undefined
                ? ""
                : ` with ${APP_REVIEW_PREVIEW_URL_ENV}=${input.run.previewTargets[0]}`
            } and report each as a validation entry:`,
            ...input.e2eCommands.map((command) => `- ${command}`),
          ]),
      input.run.caller.type === "implementation"
        ? "Commit the complete repair, leave the orchestrator worktree clean, and report a commit SHA matching HEAD."
        : "Edit the selected worktree in place. A commit and initially clean worktree are not required; preserve unrelated WIP and rely on T3 checkpoints for recovery.",
      "",
      "Original acceptance brief:",
      input.run.briefMarkdown,
      "",
      "Actionable findings:",
      input.cycle.actionableFindingsMarkdown ?? "Missing findings",
      "",
      "Durable repair tickets:",
      ...(input.cycle.repairTickets ?? []).map(
        (ticket) =>
          `## ${ticket.key} · ${ticket.title}\n\n${ticket.bodyMarkdown}\n\nBlocked by: ${ticket.dependencyKeys.join(", ") || "None"}`,
      ),
      "",
      "Finish with exactly one fenced JSON block:",
      "```json",
      JSON.stringify(
        {
          type: "app-review-fix-result",
          runId: input.run.id,
          planId: input.cycle.planId,
          status: "succeeded",
          commitSha: input.run.caller.type === "implementation" ? "required-HEAD-sha" : undefined,
          validations: [
            {
              command: "vp test run focused-test",
              status: "passed",
              outputMarkdown: "Important output or empty string.",
              completedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
          notesMarkdown: "What changed and what remains.",
        },
        null,
        2,
      ),
      "```",
    ].join("\n"),
    APP_REVIEW_IMPLEMENT_SKILL_ID,
  );
}

export function terminalReviewEvidenceFailure(
  action: ReturnType<typeof terminalReviewAction>,
  review: AppReviewRecord,
): string | null {
  if (hasCompleteAppReviewEvidence(review.evidence)) return null;
  if (
    action === "planning" &&
    hasScreenshotBackedAppReviewFailure(review.document, review.evidence)
  ) {
    return null;
  }
  return action === "passed"
    ? "Browser App Review completed without the required durable recording and screenshot evidence."
    : "Browser App Review reported product findings without a saved recording or screenshot-backed failed checks.";
}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const gitWorkflow = yield* GitWorkflowService;
  const appDevStackManager = yield* AppDevStackManager;
  const reviewService = yield* ReviewService;
  const serverSettingsService = yield* ServerSettingsService;
  const projectFileLoader = yield* T3ProjectFileLoader;

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const serverCommandId = (tag: string) =>
    crypto.randomUUIDv4.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));
  const serverMessageId = (tag: string) =>
    crypto.randomUUIDv4.pipe(Effect.map((uuid) => MessageId.make(`message-${tag}-${uuid}`)));
  const serverThreadId = (tag: string) =>
    crypto.randomUUIDv4.pipe(Effect.map((uuid) => ThreadId.make(`thread-${tag}-${uuid}`)));
  const serverReviewId = () =>
    crypto.randomUUIDv4.pipe(Effect.map((uuid) => AppReviewId.make(`app-review-${uuid}`)));

  const resolveThread = (threadId: ThreadId) =>
    projectionSnapshotQuery.getThreadDetailById(threadId).pipe(Effect.map(Option.getOrUndefined));

  const resolveTarget = Effect.fn("AppReviewWorkflowReactor.resolveTarget")(function* (
    threadId: ThreadId,
  ) {
    const [thread, readModel] = yield* Effect.all([
      resolveThread(threadId),
      projectionSnapshotQuery.getCommandReadModel(),
    ]);
    if (thread === undefined) return null;
    const project = readModel.projects.find((candidate) => candidate.id === thread.projectId);
    const cwd = thread.worktreePath ?? project?.workspaceRoot ?? null;
    return cwd === null ? null : { thread, cwd };
  });

  /** The target worktree's `e2eCommands` from t3.json; best-effort, absent means none. */
  const e2eCommandsForCwd = Effect.fn("AppReviewWorkflowReactor.e2eCommandsForCwd")(function* (
    cwd: string | null,
  ) {
    if (cwd === null) return [] as ReadonlyArray<string>;
    return resolveAppReviewE2eCommands(Option.getOrUndefined(yield* projectFileLoader.load(cwd)));
  });

  /**
   * The scope this run's next cycle actually reviews with, or null when
   * Settings leave it nothing to run. Ticket-scoped runs resolve the ticket
   * sub-step entry (falling back to the step entry); everything else resolves
   * the step entry directly.
   */
  const reviewScopeForRun = Effect.fn("AppReviewWorkflowReactor.reviewScopeForRun")(function* (
    run: AppReviewWorkflowRun,
    e2eCommandCount: number,
  ) {
    const settings = yield* serverSettingsService.getSettings.pipe(
      Effect.orElseSucceed(() => undefined),
    );
    const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
    const controller = readModel.threads.find(
      (candidate) => candidate.id === run.controllerThreadId,
    );
    const settingsParts = resolveLayeredAppReviewStepParts({
      threadOverrides:
        controller === undefined
          ? undefined
          : findWorkflowStepReviewParts(controller, readModel.threads),
      settingsOverrides: settings?.workflowStepReviewParts,
      key:
        run.caller.type === "implementation" && run.caller.ticketId !== undefined
          ? {
              workflowPromptId: WORKFLOW_PROMPT_IDS.implementationBrowserAppReviewCodex,
              stepWorkflowPromptId: WORKFLOW_PROMPT_IDS.implementationTddCodex,
            }
          : { workflowPromptId: WORKFLOW_PROMPT_IDS.implementationBrowserAppReviewCodex },
    });
    return resolveEffectiveAppReviewScope({ run, settingsParts, e2eCommandCount });
  });

  const updateRun = Effect.fn("AppReviewWorkflowReactor.updateRun")(function* (
    run: AppReviewWorkflowRun,
  ) {
    yield* orchestrationEngine.dispatch({
      type: "thread.app-review-workflow.update",
      commandId: yield* serverCommandId("app-review-workflow-update"),
      threadId: run.controllerThreadId,
      run,
      createdAt: run.updatedAt,
    });
  });

  const interruptActivePhaseTurn = Effect.fn("AppReviewWorkflowReactor.interruptActivePhaseTurn")(
    function* (run: AppReviewWorkflowRun, occurredAt: string) {
      if (run.activeThreadId === null) return;
      yield* orchestrationEngine.dispatch({
        type: "thread.turn.interrupt",
        commandId: yield* serverCommandId("app-review-workflow-phase-interrupt"),
        threadId: run.activeThreadId,
        createdAt: occurredAt,
      });
    },
  );

  const computeWorkspaceRevision = Effect.fn("AppReviewWorkflowReactor.computeWorkspaceRevision")(
    function* (cwd: string) {
      const [head, preview] = yield* Effect.all([
        gitWorkflow.resolveCommit({ cwd, ref: "HEAD" }),
        reviewService.getDiffPreview({ cwd }),
      ]);
      const workingTreeDiffHash =
        preview.sources.find((source) => source.kind === "working-tree")?.diffHash ?? "missing";
      const branchDiffHash =
        preview.sources.find((source) => source.kind === "branch-range")?.diffHash ?? "missing";
      return {
        headSha: head.commitSha,
        workingTreeDiffHash,
        branchDiffHash,
        fingerprint: `${head.commitSha}:${workingTreeDiffHash}:${branchDiffHash}`,
      } satisfies AppReviewWorkflowWorkspaceRevision;
    },
  );

  const failRun = Effect.fn("AppReviewWorkflowReactor.failRun")(function* (input: {
    readonly run: AppReviewWorkflowRun;
    readonly reason: AppReviewWorkflowFailureReason;
    readonly detailMarkdown: string;
    readonly occurredAt: string;
  }) {
    if (terminalStatuses.has(input.run.status)) return;
    const cycleNumber = input.run.cycles.at(-1)?.cycleNumber ?? null;
    yield* updateRun({
      ...input.run,
      status: "failed",
      outcome: "failed",
      activePhase: null,
      activeThreadId: null,
      finalHeadSha:
        input.run.workspaceRevision.headSha === "pending"
          ? null
          : input.run.workspaceRevision.headSha,
      failure: {
        reason: input.reason,
        phase: input.run.activePhase,
        cycleNumber,
        detailMarkdown: input.detailMarkdown,
        failedAt: input.occurredAt,
      },
      cycles: input.run.cycles.map((cycle) =>
        cycle.cycleNumber === cycleNumber
          ? {
              ...cycle,
              status: "failed",
              reviewVerdict: cycle.reviewVerdict === "passed" ? "passed" : "failed",
              failure: {
                reason: input.reason,
                phase: input.run.activePhase,
                cycleNumber,
                detailMarkdown: input.detailMarkdown,
                failedAt: input.occurredAt,
              },
              completedAt: input.occurredAt,
            }
          : cycle,
      ),
      updatedAt: input.occurredAt,
      completedAt: input.occurredAt,
    });
  });

  const assertStableRevision = Effect.fn("AppReviewWorkflowReactor.assertStableRevision")(
    function* (run: AppReviewWorkflowRun, cwd: string, occurredAt: string) {
      const current = yield* computeWorkspaceRevision(cwd);
      if (run.workspaceRevision.fingerprint === "pending") {
        const next = { ...run, workspaceRevision: current, updatedAt: occurredAt };
        yield* updateRun(next);
        return next;
      }
      if (current.fingerprint !== run.workspaceRevision.fingerprint) {
        yield* failRun({
          run,
          reason: "workspace-stale",
          detailMarkdown:
            "The worktree changed outside the active App Review phase. Start a fresh run against the new workspace revision.",
          occurredAt,
        });
        return null;
      }
      return run;
    },
  );

  const resolveStandalonePreviewTargetsForRun = Effect.fn(
    "AppReviewWorkflowReactor.resolveStandalonePreviewTargetsForRun",
  )(function* (run: AppReviewWorkflowRun, cwd: string, occurredAt: string) {
    if (run.caller.type !== "standalone") return run;
    // A pinned run already knows its target, so it never pays for the stack
    // lookup — and an unhealthy stack it was never pointed at cannot block it.
    const lookupResult =
      run.previewTargetsPinned === true
        ? null
        : yield* appDevStackManager.getByWorktree({ worktreePath: cwd }).pipe(Effect.result);
    const resolution = selectStandalonePreviewTargets({
      lookup: lookupResult?._tag === "Success" ? lookupResult.success : null,
      lookupError:
        lookupResult?._tag === "Failure"
          ? lookupResult.failure instanceof Error
            ? lookupResult.failure.message
            : String(lookupResult.failure)
          : null,
      fallbackTargets: [...extractPreviewUrls(run.briefMarkdown), ...run.previewTargets],
      ...(run.previewTargetsPinned === true ? { pinnedTargets: run.previewTargets } : {}),
    });
    if (resolution._tag === "Blocked") {
      yield* failRun({
        run,
        reason: "preview-unavailable",
        detailMarkdown: resolution.detailMarkdown,
        occurredAt,
      });
      return null;
    }
    if (
      resolution.previewTargets.length === run.previewTargets.length &&
      resolution.previewTargets.every((target, index) => target === run.previewTargets[index])
    ) {
      return run;
    }
    const updatedRun = {
      ...run,
      previewTargets: [...resolution.previewTargets],
      updatedAt: occurredAt,
    } satisfies AppReviewWorkflowRun;
    yield* updateRun(updatedRun);
    return updatedRun;
  });

  /**
   * The model for one agent of a cycle.
   *
   * Ticket and combined App Reviews carry separate phase pins. Ticket phases
   * inherit their controller's model when unset. Combined phases inherit the
   * App Review step pin and then the workflow model.
   */
  const modelForPrompt = Effect.fn("AppReviewWorkflowReactor.modelForPrompt")(function* (
    workflowPromptId: string,
    parent: OrchestrationThread,
    run: AppReviewWorkflowRun,
  ) {
    const settings = yield* serverSettingsService.getSettings.pipe(
      Effect.orElseSucceed(() => undefined),
    );
    // The controller carries the run's root thread id, so a pin the user set on
    // the parent workflow reaches review threads spawned several levels down.
    const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
    const stepWorkflowPromptId = appReviewPhaseModelStepWorkflowPromptId(run);
    return resolveWorkflowStepModelSelection({
      workflowPromptId,
      stepWorkflowPromptId,
      inheritStepPin: stepWorkflowPromptId !== WORKFLOW_PROMPT_IDS.implementationTddCodex,
      definition: resolveWorkflowSubagentSpawnDefinition(workflowPromptId),
      stepModels: findWorkflowStepModels(parent, readModel.threads),
      parentModelSelection: parent.modelSelection,
      settings,
    }).modelSelection;
  });

  const ensureReviewLaunch = Effect.fn("AppReviewWorkflowReactor.ensureReviewLaunch")(function* (
    run: AppReviewWorkflowRun,
    cycle: AppReviewWorkflowCycle,
  ) {
    const reviewer = yield* resolveThread(cycle.reviewerThreadId);
    const controller = yield* resolveThread(run.controllerThreadId);
    if (controller === undefined) {
      yield* failRun({
        run,
        reason: "unknown",
        detailMarkdown: "The App Review controller thread is unavailable.",
        occurredAt: run.updatedAt,
      });
      return;
    }
    const prior = priorCycleChecks({
      run,
      currentCycleNumber: cycle.cycleNumber,
      priorReviews: controller.appReviews,
    });
    const target = yield* resolveTarget(run.targetThreadId);
    const e2eCommands = yield* e2eCommandsForCwd(target?.cwd ?? null);
    const reviewScope = yield* reviewScopeForRun(run, e2eCommands.length);
    if (reviewScope === null) {
      yield* failRun({
        run,
        reason: "automation-unavailable",
        detailMarkdown:
          "App Review is turned off for this step in Settings → Workflows (E2E tests: no · Browser review: no), so no cycle can verify anything.",
        occurredAt: run.updatedAt,
      });
      return;
    }
    const message = {
      messageId: yield* serverMessageId("app-review-workflow-review"),
      role: "user" as const,
      text: buildReviewPrompt({
        run,
        cycle,
        priorFindingIds: prior.findingIds,
        carryableChecks: prior.carryable,
        e2eCommands,
        reviewScope,
      }),
      attachments: [],
    };
    if (reviewer === undefined) {
      yield* orchestrationEngine.dispatch({
        type: "thread.app-review.launch",
        commandId: yield* serverCommandId("app-review-workflow-review-launch"),
        sourceThreadId: run.controllerThreadId,
        reviewThreadId: cycle.reviewerThreadId,
        reviewId: cycle.reviewId,
        planningTicketIds: [...(controller.workflowContext?.ticketScope ?? [])],
        message,
        modelSelection: yield* modelForPrompt(
          WORKFLOW_PROMPT_IDS.implementationBrowserAppReviewCodex,
          controller,
          run,
        ),
        runtimeMode: WORKFLOW_AUTOMATION_RUNTIME_MODE,
        workflowPromptId: WORKFLOW_PROMPT_IDS.implementationBrowserAppReviewCodex,
        createdAt: run.updatedAt,
      });
      return;
    }
    if (reviewer.deletedAt !== null) {
      yield* failRun({
        run,
        reason: "unknown",
        detailMarkdown: `The durable App Review thread '${reviewer.id}' was deleted.`,
        occurredAt: run.updatedAt,
      });
      return;
    }
    yield* orchestrationEngine.dispatch({
      type: "thread.app-review.update",
      commandId: yield* serverCommandId("app-review-workflow-review-reset"),
      threadId: run.controllerThreadId,
      reviewId: cycle.reviewId,
      status: "running",
      document: {
        verdict: "pending",
        summary: "",
        checks: [],
        findings: [],
        questions: [],
        nextSteps: [],
      },
      updatedAt: run.updatedAt,
      createdAt: run.updatedAt,
    });
    yield* orchestrationEngine.dispatch({
      type: "thread.app-review.evidence.update",
      commandId: yield* serverCommandId("app-review-workflow-review-evidence-reset"),
      threadId: run.controllerThreadId,
      reviewId: cycle.reviewId,
      evidence: EMPTY_APP_REVIEW_EVIDENCE,
      updatedAt: run.updatedAt,
      createdAt: run.updatedAt,
    });
    yield* orchestrationEngine.dispatch({
      type: "thread.turn.start",
      commandId: yield* serverCommandId("app-review-workflow-review-retry"),
      threadId: reviewer.id,
      message,
      workflowPromptId: WORKFLOW_PROMPT_IDS.implementationBrowserAppReviewCodex,
      runtimeMode: WORKFLOW_AUTOMATION_RUNTIME_MODE,
      interactionMode: reviewer.interactionMode,
      createdAt: run.updatedAt,
    });
  });

  const startReview = Effect.fn("AppReviewWorkflowReactor.startReview")(function* (
    inputRun: AppReviewWorkflowRun,
    occurredAt: string,
  ) {
    // Resume/launch requests can be duplicated while projections and sibling reactors settle. Use
    // the latest persisted run, not the event's stale payload, so only one reviewer can claim the
    // next cycle.
    const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
    const currentRun = selectReviewRunToStart(inputRun.id, readModel.appReviewWorkflowRuns ?? []);
    if (currentRun === null) return;
    // A paused run is waiting for the user. The decider refuses a launch under
    // a paused scope, so going on would spend a cycle on a command that cannot
    // land. That is how a stopped workflow kept opening browser reviewers.
    if (isWorkflowThreadPaused(readModel.threads, currentRun.controllerThreadId)) return;
    const target = yield* resolveTarget(currentRun.targetThreadId);
    if (target === null) {
      yield* failRun({
        run: currentRun,
        reason: "unknown",
        detailMarkdown: "The target worktree is unavailable.",
        occurredAt,
      });
      return;
    }
    const cwd = target.cwd;
    const stableRun = yield* assertStableRevision(currentRun, cwd, occurredAt);
    if (stableRun === null) return;
    const run = yield* resolveStandalonePreviewTargetsForRun(stableRun, cwd, occurredAt);
    if (run === null) return;
    if (run.caller.type === "implementation") {
      const status = yield* gitWorkflow.localStatus({ cwd });
      if (
        !status.isRepo ||
        status.hasWorkingTreeChanges ||
        (target.thread.branch !== null && status.refName !== target.thread.branch)
      ) {
        yield* failRun({
          run,
          reason: "embedded-worktree-dirty",
          detailMarkdown: `Embedded App Review requires clean expected branch '${target.thread.branch ?? "unknown"}', but Git reports '${status.refName ?? "detached HEAD"}'${status.hasWorkingTreeChanges ? " with uncommitted changes" : ""}.`,
          occurredAt,
        });
        return;
      }
    }
    const cycleNumber = run.cyclesUsed + 1;
    const cycle: AppReviewWorkflowCycle = {
      cycleNumber,
      status: "reviewing",
      reviewId: yield* serverReviewId(),
      reviewerThreadId: yield* serverThreadId("app-review-reviewer"),
      reviewLaunchCount: 1,
      planningLaunchCount: 0,
      fixingLaunchCount: 0,
      supersededThreadIds: [],
      reviewVerdict: null,
      actionableFindingsMarkdown: null,
      planId: null,
      plannerTurnId: null,
      fixerThreadId: null,
      fixResult: null,
      workspaceRevision: run.workspaceRevision,
      startedAt: occurredAt,
      completedAt: null,
    };
    const reviewingRun: AppReviewWorkflowRun = {
      ...run,
      cyclesUsed: cycleNumber,
      cycles: [...run.cycles, cycle],
      activePhase: "review",
      activeThreadId: cycle.reviewerThreadId,
      updatedAt: occurredAt,
    };
    yield* updateRun(reviewingRun);
    yield* ensureReviewLaunch(reviewingRun, cycle);
  });

  const reviewRecordForCycle = (
    controller: OrchestrationThread,
    cycle: AppReviewWorkflowCycle,
  ): AppReviewRecord | null =>
    controller.appReviews.find((review) => review.id === cycle.reviewId) ?? null;

  const hasSettledCheckpoint = (thread: OrchestrationThread): boolean => {
    const turn = thread.latestTurn;
    return (
      turn !== null &&
      turn.state !== "running" &&
      thread.checkpoints.some((checkpoint) => checkpoint.turnId === turn.turnId)
    );
  };

  /**
   * What the run should make of the thread driving its current phase. Reads the
   * read model only when the answer can be "nudging".
   */
  const phaseThreadState = Effect.fn("AppReviewWorkflowReactor.phaseThreadState")(function* (
    thread: OrchestrationThread,
  ) {
    if (!threadTurnFailed(thread)) return "working" as const;
    const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
    return appReviewPhaseThreadState({
      threads: readModel.threads,
      thread,
      nowMs: Date.parse(yield* nowIso),
    });
  });

  const findingsMarkdown = (review: AppReviewRecord) =>
    review.document.findings
      .map(
        (finding, index) =>
          `${index + 1}. [${finding.severity}] ${finding.title}\n\n${finding.details}\n\nReproduction: ${finding.reproduction}`,
      )
      .join("\n\n");

  const finishPassed = Effect.fn("AppReviewWorkflowReactor.finishPassed")(function* (
    run: AppReviewWorkflowRun,
    review: AppReviewRecord,
    occurredAt: string,
  ) {
    const cycle = run.cycles.at(-1);
    if (cycle === undefined) return;
    yield* updateRun({
      ...run,
      status: "passed",
      outcome: "passed",
      activePhase: null,
      activeThreadId: null,
      finalHeadSha: run.workspaceRevision.headSha,
      failure: null,
      cycles: run.cycles.map((entry) =>
        entry.cycleNumber === cycle.cycleNumber
          ? {
              ...entry,
              status: "completed",
              reviewVerdict: "passed",
              failure: null,
              completedAt: occurredAt,
            }
          : entry,
      ),
      updatedAt: occurredAt,
      completedAt: occurredAt,
    });
  });

  /**
   * Stop after the last cycle, without calling the run a failure.
   *
   * A budget can run out two ways: every cycle repaired something and the
   * review still had more to say, or the cycles kept breaking. Only the second
   * has a reason to show, so the run surfaces the last cycle's failure and
   * leaves `failure` null when there was none.
   */
  const finishExhausted = Effect.fn("AppReviewWorkflowReactor.finishExhausted")(function* (
    run: AppReviewWorkflowRun,
    occurredAt: string,
  ) {
    yield* updateRun({
      ...run,
      status: "exhausted",
      outcome: "exhausted",
      activePhase: null,
      activeThreadId: null,
      finalHeadSha: run.workspaceRevision.headSha,
      failure: run.cycles.at(-1)?.failure ?? null,
      updatedAt: occurredAt,
      completedAt: occurredAt,
    });
  });

  /**
   * Retry a failed phase without spending the product-review cycle.
   *
   * One cycle owns one combined E2E/browser review, one gap-analysis plan when
   * that review finds defects, and one repair. Provider and runtime failures
   * relaunch only the phase that failed. A bounded phase budget stops a broken
   * provider from turning the ten-cycle product budget into a retry loop.
   */
  const failCycle = Effect.fn("AppReviewWorkflowReactor.failCycle")(function* (input: {
    readonly run: AppReviewWorkflowRun;
    readonly reason: AppReviewWorkflowFailureReason;
    readonly detailMarkdown: string;
    readonly occurredAt: string;
  }) {
    const run = input.run;
    if (terminalStatuses.has(run.status)) return;
    const cycle = run.cycles.at(-1);
    const phase = run.activePhase;
    if (cycle === undefined || phase === null) {
      yield* failRun(input);
      return;
    }
    yield* interruptActivePhaseTurn(run, input.occurredAt);
    const target = yield* resolveTarget(run.targetThreadId);
    const workspaceRevision =
      target === null ? run.workspaceRevision : yield* computeWorkspaceRevision(target.cwd);
    const failure: AppReviewWorkflowFailure = {
      reason: input.reason,
      phase,
      cycleNumber: cycle.cycleNumber,
      detailMarkdown: input.detailMarkdown,
      failedAt: input.occurredAt,
    };
    const supersededThreadIds = [...(cycle.supersededThreadIds ?? [])];
    const retryBase: AppReviewWorkflowRun = {
      ...run,
      workspaceRevision,
      cycles: run.cycles.map((entry) =>
        entry.cycleNumber === cycle.cycleNumber
          ? { ...entry, failure, supersededThreadIds }
          : entry,
      ),
      updatedAt: input.occurredAt,
    };
    if (appReviewPhaseFailureAction(cycle, phase) === "fail-run") {
      yield* failRun({
        run: retryBase,
        reason: input.reason,
        detailMarkdown: `${phase} exhausted its ${String(APP_REVIEW_PHASE_MAX_LAUNCHES)} phase launches.\n\n${input.detailMarkdown}`,
        occurredAt: input.occurredAt,
      });
      return;
    }

    switch (phase) {
      case "review": {
        const retryCycle = retryReviewPhaseInCycle({
          cycle,
          failure,
          workspaceRevision,
        });
        const reviewingRun: AppReviewWorkflowRun = {
          ...retryBase,
          activePhase: "review",
          activeThreadId: cycle.reviewerThreadId,
          cycles: retryBase.cycles.map((entry) =>
            entry.cycleNumber === cycle.cycleNumber ? retryCycle : entry,
          ),
        };
        yield* updateRun(reviewingRun);
        yield* ensureReviewLaunch(reviewingRun, retryCycle);
        return;
      }
      case "planning": {
        const controller = yield* resolveThread(run.controllerThreadId);
        const review = controller === undefined ? null : reviewRecordForCycle(controller, cycle);
        if (review === null || cycle.actionableFindingsMarkdown === null) {
          yield* failRun({
            run: retryBase,
            reason: "plan-missing",
            detailMarkdown: "Gap analysis cannot retry because its review findings are missing.",
            occurredAt: input.occurredAt,
          });
          return;
        }
        yield* startPlanning({
          run: retryBase,
          review,
          actionableFindingsMarkdown: cycle.actionableFindingsMarkdown,
          occurredAt: input.occurredAt,
        });
        return;
      }
      case "fixing": {
        const repairTickets = cycle.repairTickets ?? [];
        if (repairTickets.length === 0) {
          yield* failRun({
            run: retryBase,
            reason: "plan-missing",
            detailMarkdown: "Repair cannot retry because gap analysis produced no tickets.",
            occurredAt: input.occurredAt,
          });
          return;
        }
        yield* startFixer({
          run: retryBase,
          repairTickets,
          plannerTurnId: cycle.plannerTurnId,
          occurredAt: input.occurredAt,
        });
        return;
      }
    }
  });

  const startPlanning = Effect.fn("AppReviewWorkflowReactor.startPlanning")(function* (input: {
    readonly run: AppReviewWorkflowRun;
    readonly review: AppReviewRecord;
    readonly actionableFindingsMarkdown: string;
    readonly occurredAt: string;
  }) {
    const reviewer = yield* resolveThread(input.review.reviewThreadId);
    const target = yield* resolveTarget(input.run.targetThreadId);
    const cycle = input.run.cycles.at(-1);
    if (reviewer === undefined || cycle === undefined || target === null) {
      yield* failRun({
        run: input.run,
        reason: "unknown",
        detailMarkdown: "The App Review thread or target worktree disappeared.",
        occurredAt: input.occurredAt,
      });
      return;
    }
    const cwd = target.cwd;
    const stableRun = yield* assertStableRevision(input.run, cwd, input.occurredAt);
    if (stableRun === null) return;
    // Gap analysis runs in a thread of its own so it can be given its own
    // model. The reviewer's evidence does not travel with it, so the prompt
    // below carries the brief and the complete actionable findings.
    const plannerThreadId = cycle.plannerThreadId ?? (yield* serverThreadId("app-review-planner"));
    const plannerThread = yield* resolveThread(plannerThreadId);
    if (plannerThread?.deletedAt !== null && plannerThread !== undefined) {
      yield* failRun({
        run: stableRun,
        reason: "unknown",
        detailMarkdown: `The durable App Review gap-analysis thread '${plannerThreadId}' was deleted.`,
        occurredAt: input.occurredAt,
      });
      return;
    }
    const planningRun: AppReviewWorkflowRun = {
      ...stableRun,
      activePhase: "planning",
      activeThreadId: plannerThreadId,
      cycles: stableRun.cycles.map((entry) =>
        entry.cycleNumber === cycle.cycleNumber
          ? {
              ...entry,
              status: "planning",
              reviewVerdict: "failed",
              actionableFindingsMarkdown: input.actionableFindingsMarkdown,
              plannerThreadId,
              planningLaunchCount: (entry.planningLaunchCount ?? 0) + 1,
              repairTickets: [],
              ticketingTurnId: null,
              failure: null,
            }
          : entry,
      ),
      updatedAt: input.occurredAt,
    };
    yield* updateRun(planningRun);
    const reviewedTicketId =
      input.run.caller.type === "implementation" ? input.run.caller.ticketId : undefined;
    const parentTicket =
      reviewedTicketId === undefined
        ? undefined
        : findAppReviewParentTicket(
            (yield* projectionSnapshotQuery.getCommandReadModel()).threads,
            reviewedTicketId,
            reviewer.workflowContext?.rootThreadId ?? target.thread.workflowContext?.rootThreadId,
          );
    if (reviewedTicketId !== undefined && parentTicket?.key === undefined) {
      yield* failRun({
        run: planningRun,
        reason: "plan-missing",
        detailMarkdown: `Cannot create child repair tickets because parent ticket '${reviewedTicketId}' is unavailable.`,
        occurredAt: input.occurredAt,
      });
      return;
    }
    const parentTicketKey = parentTicket?.key ?? "INTEGRATION-1";
    const existingRepairTicketCount = input.run.cycles.reduce(
      (count, entry) =>
        count +
        (entry.repairTickets ?? []).filter((ticket) => ticket.parentTicketKey === parentTicketKey)
          .length,
      0,
    );
    const firstChildKey = `${parentTicketKey}.${existingRepairTicketCount + 1}`;
    if (plannerThread === undefined) {
      yield* orchestrationEngine.dispatch({
        type: "thread.create",
        commandId: yield* serverCommandId("app-review-workflow-planner-create"),
        threadId: plannerThreadId,
        projectId: reviewer.projectId,
        ownerUserId: reviewer.ownerUserId,
        parentThreadId: reviewer.id,
        workflowRole: "app-review-planner",
        workflowContext: reviewer.workflowContext ?? null,
        title: `App Review gap analysis · Cycle ${cycle.cycleNumber} of ${stableRun.cycleBudget}`,
        modelSelection: yield* modelForPrompt(APP_REVIEW_TO_TICKETS_SKILL_ID, reviewer, input.run),
        runtimeMode: WORKFLOW_AUTOMATION_RUNTIME_MODE,
        interactionMode: "default",
        workflowPreset: "app-review",
        branch: reviewer.branch,
        worktreePath: reviewer.worktreePath,
        createdAt: input.occurredAt,
      });
    }
    yield* orchestrationEngine.dispatch({
      type: "thread.turn.start",
      commandId: yield* serverCommandId("app-review-workflow-ticket-turn"),
      threadId: plannerThreadId,
      message: {
        messageId: yield* serverMessageId("app-review-workflow-tickets"),
        role: "user",
        text: appendWorkflowSkillCommandSection(
          [
            `Run gap analysis and create repair tickets for App Review cycle ${cycle.cycleNumber}.`,
            "",
            "The review that produced these findings ran in a separate thread; the brief and the complete actionable findings below are the whole input. Do not edit files, browse the app, or ask questions. Apply the To Tickets vertical-slice discipline to every actionable finding.",
            "Work test-first: every ticket must name the automated test that reproduces its gap — an extension of the project's end-to-end suite when the gap is a user-visible flow, otherwise a focused test — and its acceptance criteria must require that the test fails before the repair and passes after it.",
            "This App Review adapter owns persistence. Do not emit planning-tickets-artifact, create external issues, or modify the parent planning-ticket set; emit only app-review-repair-tickets below.",
            `Use '${parentTicketKey}' as the parent key. Number child tickets consecutively from '${firstChildKey}' (for example '${parentTicketKey}.1', '${parentTicketKey}.2').`,
            input.run.caller.type === "implementation" && input.run.caller.ticketId !== undefined
              ? "These are children of the ticket currently under review."
              : "These are integration repair tickets for the combined post-merge review; do not attach them to an original planning ticket.",
            "",
            "Original acceptance brief:",
            planningRun.briefMarkdown,
            "",
            "Complete actionable findings:",
            input.actionableFindingsMarkdown,
            "",
            "Finish with exactly one fenced JSON block:",
            "```json",
            // @effect-diagnostics-next-line preferSchemaOverJson:off - embeds a fixed example in the agent prompt.
            JSON.stringify(
              {
                type: "app-review-repair-tickets",
                runId: planningRun.id,
                cycleNumber: cycle.cycleNumber,
                tickets: [
                  {
                    key: firstChildKey,
                    parentTicketKey,
                    title: "Repair the observed product gap",
                    bodyMarkdown: "What to build and acceptance criteria.",
                    dependencyKeys: [],
                  },
                ],
              },
              null,
              2,
            ),
            "```",
          ].join("\n"),
          APP_REVIEW_TO_TICKETS_SKILL_ID,
        ),
        attachments: [],
      },
      runtimeMode: WORKFLOW_AUTOMATION_RUNTIME_MODE,
      interactionMode: "default",
      workflowPromptId: APP_REVIEW_TO_TICKETS_SKILL_ID,
      createdAt: input.occurredAt,
    });
  });

  const reconcileReview = Effect.fn("AppReviewWorkflowReactor.reconcileReview")(function* (
    run: AppReviewWorkflowRun,
    occurredAt: string,
  ) {
    const cycle = run.cycles.at(-1);
    if (run.activePhase !== "review" || cycle === undefined) return;
    const [controller, reviewer] = yield* Effect.all([
      resolveThread(run.controllerThreadId),
      resolveThread(cycle.reviewerThreadId),
    ]);
    if (reviewer === undefined) {
      yield* ensureReviewLaunch(run, cycle);
      return;
    }
    const review = controller === undefined ? null : reviewRecordForCycle(controller, cycle);
    if (review === null || !["passed", "failed"].includes(review.status)) {
      if (appReviewRecoveryTurnPending(run, cycle, reviewer)) return;
      const failed = threadTurnFailed(reviewer);
      const completedWithoutReview = phaseTurnCompleted(reviewer) && hasSettledCheckpoint(reviewer);
      if (!failed && !completedWithoutReview) return;
      if (failed && (yield* phaseThreadState(reviewer)) === "nudging") return;
      yield* failCycle({
        run,
        reason: "review-blocked",
        detailMarkdown:
          reviewer.session?.lastError ??
          "Browser App Review stopped without producing a terminal durable review.",
        occurredAt,
      });
      return;
    }
    if (!hasSettledCheckpoint(reviewer)) return;
    const target = yield* resolveTarget(run.targetThreadId);
    if (target === null) return;
    const stableRun = yield* assertStableRevision(run, target.cwd, occurredAt);
    if (stableRun === null) return;
    const action = terminalReviewAction(review);
    const e2eCommands = yield* e2eCommandsForCwd(target.cwd);
    // Null here means Settings turned the parts off after the cycle launched;
    // judge the finished review leniently rather than retroactively.
    const reviewScope = yield* reviewScopeForRun(stableRun, e2eCommands.length);
    const passFailure = terminalReviewPassFailure({
      run: stableRun,
      review,
      priorReviews: controller?.appReviews ?? [],
      e2eCheckIds:
        reviewScope === "e2e" || reviewScope === "both" ? e2eCheckIdsForCommands(e2eCommands) : [],
    });
    if (passFailure !== null) {
      yield* startPlanning({
        run: stableRun,
        review,
        actionableFindingsMarkdown: passFailure,
        occurredAt,
      });
      return;
    }
    // An e2e-only review has no browser part, so recordings and screenshots
    // are not part of its contract.
    const evidenceFailure =
      reviewScope === "e2e" || reviewScope === null
        ? null
        : terminalReviewEvidenceFailure(action, review);
    if (evidenceFailure !== null) {
      yield* startPlanning({
        run: stableRun,
        review,
        actionableFindingsMarkdown: evidenceFailure,
        occurredAt,
      });
      return;
    }
    if (action === "passed") {
      yield* finishPassed(stableRun, review, occurredAt);
      return;
    }
    const actionableFindingsMarkdown =
      findingsMarkdown(review) ||
      review.document.summary ||
      "The App Review failed without details.";
    yield* startPlanning({
      run: stableRun,
      review,
      actionableFindingsMarkdown,
      occurredAt,
    });
  });

  const ensureFixerLaunch = Effect.fn("AppReviewWorkflowReactor.ensureFixerLaunch")(function* (
    run: AppReviewWorkflowRun,
    cycle: AppReviewWorkflowCycle,
  ) {
    if (cycle.fixerThreadId === null) return;
    const existing = yield* resolveThread(cycle.fixerThreadId);
    if (existing?.deletedAt !== null && existing !== undefined) {
      yield* failRun({
        run,
        reason: "unknown",
        detailMarkdown: `The durable App Review repair thread '${cycle.fixerThreadId}' was deleted.`,
        occurredAt: run.updatedAt,
      });
      return;
    }
    const reviewer = yield* resolveThread(cycle.reviewerThreadId);
    const target = yield* resolveThread(run.targetThreadId);
    if (reviewer === undefined || target === undefined) return;
    const declaredE2eCommands = yield* e2eCommandsForCwd(
      (yield* resolveTarget(run.targetThreadId))?.cwd ?? null,
    );
    // A review that never gates on the e2e suite does not ask its fixer to
    // run it either.
    const fixerScope = yield* reviewScopeForRun(run, declaredE2eCommands.length);
    const e2eCommands = fixerScope === "e2e" || fixerScope === "both" ? declaredE2eCommands : [];
    if (existing === undefined) {
      yield* orchestrationEngine.dispatch({
        type: "thread.create",
        commandId: yield* serverCommandId("app-review-workflow-fixer-create"),
        threadId: cycle.fixerThreadId,
        projectId: target.projectId,
        ownerUserId: target.ownerUserId,
        parentThreadId: reviewer.id,
        workflowRole: "app-review-fixer",
        workflowContext: reviewer.workflowContext ?? null,
        title: `App Review implementation · Cycle ${cycle.cycleNumber} of ${run.cycleBudget}`,
        modelSelection: yield* modelForPrompt(APP_REVIEW_IMPLEMENT_SKILL_ID, reviewer, run),
        runtimeMode: WORKFLOW_AUTOMATION_RUNTIME_MODE,
        interactionMode: "default",
        workflowPreset: "app-review",
        branch: target.branch,
        worktreePath: target.worktreePath,
        createdAt: run.updatedAt,
      });
    }
    yield* orchestrationEngine.dispatch({
      type: "thread.turn.start",
      commandId: yield* serverCommandId("app-review-workflow-fixer-turn"),
      threadId: cycle.fixerThreadId,
      message: {
        messageId: yield* serverMessageId("app-review-workflow-fixer"),
        role: "user",
        text: buildAppReviewFixPrompt({ run, cycle, e2eCommands }),
        attachments: [],
      },
      runtimeMode: WORKFLOW_AUTOMATION_RUNTIME_MODE,
      interactionMode: "default",
      workflowPromptId: APP_REVIEW_IMPLEMENT_SKILL_ID,
      createdAt: run.updatedAt,
    });
  });

  const startFixer = Effect.fn("AppReviewWorkflowReactor.startFixer")(function* (input: {
    readonly run: AppReviewWorkflowRun;
    readonly repairTickets: ReadonlyArray<AppReviewWorkflowRepairTicket>;
    readonly plannerTurnId: AppReviewWorkflowCycle["plannerTurnId"];
    readonly occurredAt: string;
  }) {
    const target = yield* resolveTarget(input.run.targetThreadId);
    const cycle = input.run.cycles.at(-1);
    if (target === null || cycle === undefined) {
      return;
    }
    const stableRun = yield* assertStableRevision(input.run, target.cwd, input.occurredAt);
    if (stableRun === null) return;
    yield* orchestrationEngine.dispatch({
      type: "thread.interaction-mode.set",
      commandId: yield* serverCommandId("app-review-workflow-default-mode"),
      threadId: cycle.reviewerThreadId,
      interactionMode: "default",
      createdAt: input.occurredAt,
    });
    const fixerThreadId = cycle.fixerThreadId ?? (yield* serverThreadId("app-review-fixer"));
    const repairTicketBatchId = `app-review-repair-tickets:${input.run.id}:${cycle.cycleNumber}`;
    const fixingCycle: AppReviewWorkflowCycle = {
      ...cycle,
      status: "fixing",
      planId: repairTicketBatchId,
      plannerTurnId: input.plannerTurnId,
      ticketingTurnId: input.plannerTurnId,
      repairTickets: input.repairTickets,
      fixerThreadId,
      fixingLaunchCount: (cycle.fixingLaunchCount ?? 0) + 1,
      failure: null,
    };
    const fixingRun: AppReviewWorkflowRun = {
      ...stableRun,
      activePhase: "fixing",
      activeThreadId: fixerThreadId,
      cycles: stableRun.cycles.map((entry) =>
        entry.cycleNumber === cycle.cycleNumber ? fixingCycle : entry,
      ),
      updatedAt: input.occurredAt,
    };
    yield* updateRun(fixingRun);
    yield* ensureFixerLaunch(fixingRun, fixingCycle);
  });

  /**
   * End a review-only run once its repair tickets are written.
   *
   * The cycle did everything it was launched to do, so it completes rather
   * than failing; the run itself ends `exhausted` because the findings it
   * recorded are still unresolved and no cycle remains to verify a repair.
   * That is the same terminal a one-cycle run reaches today after its fix.
   */
  const finishReviewedWithoutFixing = Effect.fn(
    "AppReviewWorkflowReactor.finishReviewedWithoutFixing",
  )(function* (input: {
    readonly run: AppReviewWorkflowRun;
    readonly repairTickets: ReadonlyArray<AppReviewWorkflowRepairTicket>;
    readonly plannerTurnId: AppReviewWorkflowCycle["plannerTurnId"];
    readonly occurredAt: string;
  }) {
    const cycle = input.run.cycles.at(-1);
    if (cycle === undefined) return;
    const reviewedRun: AppReviewWorkflowRun = {
      ...input.run,
      activePhase: null,
      activeThreadId: null,
      cycles: input.run.cycles.map((entry) =>
        entry.cycleNumber === cycle.cycleNumber
          ? {
              ...entry,
              status: "completed",
              planId: `app-review-repair-tickets:${input.run.id}:${cycle.cycleNumber}`,
              plannerTurnId: input.plannerTurnId,
              ticketingTurnId: input.plannerTurnId,
              repairTickets: input.repairTickets,
              completedAt: input.occurredAt,
            }
          : entry,
      ),
      updatedAt: input.occurredAt,
    };
    yield* updateRun(reviewedRun);
    yield* finishExhausted(reviewedRun, input.occurredAt);
  });

  const reconcilePlanning = Effect.fn("AppReviewWorkflowReactor.reconcilePlanning")(function* (
    run: AppReviewWorkflowRun,
    occurredAt: string,
  ) {
    if (run.activePhase !== "planning") return;
    const cycle = run.cycles.at(-1);
    if (cycle === undefined) return;
    // Cycles recorded before gap analysis moved into its own thread ran it on
    // the reviewer, and their plans still have to reconcile.
    const planner = yield* resolveThread(cycle.plannerThreadId ?? cycle.reviewerThreadId);
    if (planner === undefined) return;
    if (appReviewRecoveryTurnPending(run, cycle, planner) && !hasSettledCheckpoint(planner)) return;
    if (threadTurnFailed(planner) && !hasSettledCheckpoint(planner)) {
      if ((yield* phaseThreadState(planner)) === "nudging") return;
      yield* failCycle({
        run,
        reason: "plan-missing",
        detailMarkdown:
          planner.session?.lastError ??
          "The non-interactive planning turn stopped without a settled plan checkpoint.",
        occurredAt,
      });
      return;
    }
    if (!hasSettledCheckpoint(planner)) return;
    const turn = planner.latestTurn;
    if (turn === null) return;
    if (turn.state === "error" || turn.state === "interrupted") {
      yield* failCycle({
        run,
        reason: "plan-missing",
        detailMarkdown: "The non-interactive planning turn did not complete successfully.",
        occurredAt,
      });
      return;
    }
    const ticketActivity = planner.activities
      .toReversed()
      .find(
        (activity) =>
          activity.kind === "app-review-repair-tickets" &&
          Predicate.isObject(activity.payload) &&
          activity.payload["type"] === "app-review-repair-tickets" &&
          activity.payload["runId"] === run.id &&
          activity.payload["cycleNumber"] === cycle.cycleNumber,
      );
    const rawTickets =
      ticketActivity !== undefined && Predicate.isObject(ticketActivity.payload)
        ? ticketActivity.payload["tickets"]
        : undefined;
    if (!Array.isArray(rawTickets) || rawTickets.length === 0) {
      yield* failCycle({
        run,
        reason: "plan-missing",
        detailMarkdown: "The App Review thread completed gap analysis without repair tickets.",
        occurredAt,
      });
      return;
    }
    const repairTickets = rawTickets.filter(
      (ticket): ticket is AppReviewWorkflowRepairTicket =>
        Predicate.isObject(ticket) &&
        Predicate.isString(ticket["key"]) &&
        (ticket["parentTicketKey"] === null || Predicate.isString(ticket["parentTicketKey"])) &&
        Predicate.isString(ticket["title"]) &&
        Predicate.isString(ticket["bodyMarkdown"]) &&
        Array.isArray(ticket["dependencyKeys"]) &&
        ticket["dependencyKeys"].every(Predicate.isString),
    );
    const keys = new Set(repairTickets.map((ticket) => ticket.key));
    const parentKeys = new Set(repairTickets.map((ticket) => ticket.parentTicketKey));
    const parentTicketKey = repairTickets[0]?.parentTicketKey;
    const priorSiblingCount = run.cycles.reduce(
      (count, entry) =>
        count +
        (entry.cycleNumber === cycle.cycleNumber
          ? 0
          : (entry.repairTickets ?? []).filter(
              (ticket) => ticket.parentTicketKey === parentTicketKey,
            ).length),
      0,
    );
    const suffixes = repairTickets
      .map((ticket) =>
        parentTicketKey === null
          ? Number.NaN
          : Number(ticket.key.slice(`${parentTicketKey}.`.length)),
      )
      .toSorted((left, right) => left - right);
    const keysAreSequential =
      parentTicketKey !== null &&
      repairTickets.every((ticket) => ticket.key.startsWith(`${parentTicketKey}.`)) &&
      suffixes.every((suffix, index) => suffix === priorSiblingCount + index + 1);
    if (
      repairTickets.length !== rawTickets.length ||
      keys.size !== repairTickets.length ||
      parentKeys.size !== 1 ||
      !keysAreSequential
    ) {
      yield* failCycle({
        run,
        reason: "plan-malformed",
        detailMarkdown:
          "The App Review thread must persist unique, consecutively numbered child repair tickets under one parent key.",
        occurredAt,
      });
      return;
    }
    if (run.reviewOnly === true) {
      yield* finishReviewedWithoutFixing({
        run,
        repairTickets,
        plannerTurnId: turn.turnId,
        occurredAt,
      });
      return;
    }
    yield* startFixer({ run, repairTickets, plannerTurnId: turn.turnId, occurredAt });
  });

  const parseFixResult = (
    thread: OrchestrationThread,
    run: AppReviewWorkflowRun,
    cycle: AppReviewWorkflowCycle,
  ): AppReviewWorkflowFixResult | null => {
    for (const activity of thread.activities.toReversed()) {
      if (activity.kind !== "app-review-fix-result" || !Predicate.isObject(activity.payload)) {
        continue;
      }
      const payload = activity.payload as Record<string, unknown>;
      if (
        payload["type"] !== "app-review-fix-result" ||
        payload["runId"] !== run.id ||
        payload["planId"] !== cycle.planId
      ) {
        continue;
      }
      const status = payload["status"];
      if (status !== "succeeded" && status !== "failed" && status !== "blocked") return null;
      const validations = Array.isArray(payload["validations"])
        ? (payload["validations"] as AppReviewWorkflowFixResult["validations"])
        : [];
      return {
        runId: run.id,
        planId: cycle.planId ?? "missing",
        status,
        ...(Predicate.isString(payload["commitSha"]) ? { commitSha: payload["commitSha"] } : {}),
        validations,
        notesMarkdown: Predicate.isString(payload["notesMarkdown"]) ? payload["notesMarkdown"] : "",
      };
    }
    return null;
  };

  const reconcileFixer = Effect.fn("AppReviewWorkflowReactor.reconcileFixer")(function* (
    run: AppReviewWorkflowRun,
    occurredAt: string,
  ) {
    const cycle = run.cycles.at(-1);
    if (run.activePhase !== "fixing" || cycle?.fixerThreadId === null || cycle === undefined)
      return;
    const fixer = yield* resolveThread(cycle.fixerThreadId);
    if (fixer === undefined) {
      if ((cycle.repairTickets?.length ?? 0) > 0) yield* ensureFixerLaunch(run, cycle);
      return;
    }
    const result = parseFixResult(fixer, run, cycle);
    if (result === null) {
      if (appReviewRecoveryTurnPending(run, cycle, fixer)) return;
      const failed = threadTurnFailed(fixer);
      const completedWithoutResult = phaseTurnCompleted(fixer) && hasSettledCheckpoint(fixer);
      if (!failed && !completedWithoutResult) return;
      if (failed && (yield* phaseThreadState(fixer)) === "nudging") return;
      yield* failCycle({
        run,
        reason: "fixer-failed",
        detailMarkdown:
          fixer.session?.lastError ??
          "The App Review implementation thread stopped without the required result directive.",
        occurredAt,
      });
      return;
    }
    if (!hasSettledCheckpoint(fixer)) return;
    if (result.status !== "succeeded") {
      yield* failCycle({
        run,
        reason: "fixer-failed",
        detailMarkdown: result.notesMarkdown || `The App Review implementation ${result.status}.`,
        occurredAt,
      });
      return;
    }
    if (
      result.validations.length === 0 ||
      result.validations.some((validation) => validation.status !== "passed")
    ) {
      yield* failCycle({
        run,
        reason: "fixer-failed",
        detailMarkdown:
          "The App Review implementation thread did not report successful focused validation.",
        occurredAt,
      });
      return;
    }
    const target = yield* resolveTarget(run.targetThreadId);
    if (target === null) return;
    const revision = yield* computeWorkspaceRevision(target.cwd);
    if (run.caller.type === "implementation") {
      const status = yield* gitWorkflow.status({ cwd: target.cwd });
      if (!status.isRepo || status.hasWorkingTreeChanges) {
        yield* failRun({
          run,
          reason: "embedded-worktree-dirty",
          detailMarkdown: "The embedded fixer did not leave a clean orchestrator worktree.",
          occurredAt,
        });
        return;
      }
      if (
        result.commitSha === null ||
        result.commitSha === undefined ||
        result.commitSha !== revision.headSha
      ) {
        yield* failRun({
          run,
          reason: "embedded-head-mismatch",
          detailMarkdown: "The embedded fixer commit does not match the orchestrator HEAD.",
          occurredAt,
        });
        return;
      }
    }
    const completedRun: AppReviewWorkflowRun = {
      ...run,
      activePhase: null,
      activeThreadId: null,
      workspaceRevision: revision,
      cycles: run.cycles.map((entry) =>
        entry.cycleNumber === cycle.cycleNumber
          ? {
              ...entry,
              status: "completed",
              fixResult: result,
              failure: null,
              completedAt: occurredAt,
            }
          : entry,
      ),
      updatedAt: occurredAt,
    };
    yield* updateRun(completedRun);
    switch (successfulFixAction(completedRun)) {
      case "exhausted":
        yield* finishExhausted(completedRun, occurredAt);
        return;
      case "review":
        yield* startReview(completedRun, occurredAt);
        return;
      case "await-preview-refresh":
        return;
    }
  });

  const reconcileRun = Effect.fn("AppReviewWorkflowReactor.reconcileRun")(function* (
    run: AppReviewWorkflowRun,
    occurredAt: string,
  ) {
    switch (nextAppReviewWorkflowAction(run)) {
      case "none":
        return;
      case "review":
        yield* startReview(run, occurredAt);
        return;
      case "exhaust":
        yield* finishExhausted(run, occurredAt);
        return;
      case "reconcile-review":
        yield* reconcileReview(run, occurredAt);
        return;
      case "reconcile-plan":
        yield* reconcilePlanning(run, occurredAt);
        return;
      case "reconcile-fix":
        yield* reconcileFixer(run, occurredAt);
        return;
    }
  });

  /**
   * Start one phase of the run again, in a fresh thread.
   *
   * Redoing the browser review runs a new cycle: the cycle that disappointed
   * you keeps its findings and its verdict, so nothing is destroyed to make
   * room for the retry. Redoing gap analysis or the repair works on the current
   * cycle and drops what the phases after it produced, since a repair no longer
   * stands once the analysis that planned it is being redone.
   *
   * The worktree is re-baselined first. Every phase entry point refuses to run
   * against a workspace that moved since the phase last recorded one, and the
   * repair you are redoing has usually already committed. Asking for the redo
   * is what accepts the worktree as it stands now.
   */
  const rerunPhase = Effect.fn("AppReviewWorkflowReactor.rerunPhase")(function* (
    inputRun: AppReviewWorkflowRun,
    phase: AppReviewWorkflowPhase,
    occurredAt: string,
  ) {
    const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
    const run =
      (readModel.appReviewWorkflowRuns ?? []).find((candidate) => candidate.id === inputRun.id) ??
      inputRun;
    const cycle = run.cycles.at(-1);
    if (cycle === undefined) return;
    const target = yield* resolveTarget(run.targetThreadId);
    if (target === null) return;
    const workspaceRevision = yield* computeWorkspaceRevision(target.cwd);
    yield* interruptActivePhaseTurn(run, occurredAt);
    // A finished run reopens: the phase that ran is exactly what the user is
    // saying was wrong, so its verdict cannot stand.
    const reopened = {
      ...run,
      status: "running" as const,
      outcome: null,
      failure: null,
      finalHeadSha: null,
      activePhase: null,
      activeThreadId: null,
      completedAt: null,
      workspaceRevision,
      updatedAt: occurredAt,
    };

    if (phase === "review") {
      yield* updateRun(reopened);
      yield* startReview(reopened, occurredAt);
      return;
    }

    if (phase === "planning") {
      const controller = yield* resolveThread(run.controllerThreadId);
      const review = controller === undefined ? null : reviewRecordForCycle(controller, cycle);
      if (review === null || cycle.actionableFindingsMarkdown === null) return;
      const planningRun: AppReviewWorkflowRun = {
        ...reopened,
        cycles: run.cycles.map((entry) =>
          entry.cycleNumber === cycle.cycleNumber
            ? {
                ...entry,
                status: "planning" as const,
                planId: null,
                ticketingTurnId: null,
                repairTickets: [],
                fixerThreadId: null,
                fixResult: null,
                workspaceRevision,
                completedAt: null,
              }
            : entry,
        ),
      };
      yield* updateRun(planningRun);
      yield* startPlanning({
        run: planningRun,
        review,
        actionableFindingsMarkdown: cycle.actionableFindingsMarkdown,
        occurredAt,
      });
      return;
    }

    const repairTickets = cycle.repairTickets ?? [];
    if (repairTickets.length === 0 || run.reviewOnly === true) return;
    const fixingRun: AppReviewWorkflowRun = {
      ...reopened,
      cycles: run.cycles.map((entry) =>
        entry.cycleNumber === cycle.cycleNumber
          ? {
              ...entry,
              status: "fixing" as const,
              fixerThreadId: null,
              fixResult: null,
              workspaceRevision,
              completedAt: null,
            }
          : entry,
      ),
    };
    yield* updateRun(fixingRun);
    yield* startFixer({
      run: fixingRun,
      repairTickets,
      plannerTurnId: cycle.plannerTurnId,
      occurredAt,
    });
  });

  const runForEvent = Effect.fn("AppReviewWorkflowReactor.runForEvent")(function* (
    event: AppReviewWorkflowEvent,
  ) {
    if (
      event.type === "thread.app-review-workflow-launched" ||
      event.type === "thread.app-review-workflow-resume-requested" ||
      event.type === "thread.app-review-workflow-rerun-requested"
    ) {
      return event.payload.run;
    }
    if (event.type === "thread.app-review-workflow-cancel-requested") return null;
    const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
    const runs = readModel.appReviewWorkflowRuns ?? [];
    if (event.type === "thread.app-review-updated") {
      return (
        runs.find((run) => run.cycles.some((cycle) => cycle.reviewId === event.payload.reviewId)) ??
        null
      );
    }
    const threadId = event.payload.threadId;
    return (
      runs.find(
        (run) =>
          run.status === "running" &&
          (run.controllerThreadId === threadId ||
            run.activeThreadId === threadId ||
            run.cycles.some(
              (cycle) =>
                cycle.reviewerThreadId === threadId ||
                cycle.plannerThreadId === threadId ||
                cycle.fixerThreadId === threadId,
            )),
      ) ?? null
    );
  });

  const processEvent = Effect.fn("AppReviewWorkflowReactor.processEvent")(function* (
    event: AppReviewWorkflowEvent,
  ) {
    if (event.type === "thread.app-review-workflow-cancel-requested") {
      const cycle = event.payload.run.cycles.at(-1);
      const activeThreadId =
        cycle?.status === "reviewing"
          ? cycle.reviewerThreadId
          : cycle?.status === "fixing"
            ? cycle.fixerThreadId
            : cycle?.status === "planning"
              ? event.payload.run.controllerThreadId
              : null;
      if (activeThreadId !== null && activeThreadId !== undefined) {
        yield* orchestrationEngine.dispatch({
          type: "thread.turn.interrupt",
          commandId: yield* serverCommandId("app-review-workflow-cancel-interrupt"),
          threadId: activeThreadId,
          createdAt: event.occurredAt,
        });
      }
      return;
    }
    if (event.type === "thread.app-review-workflow-resume-requested") {
      yield* startReview(event.payload.run, event.occurredAt);
      return;
    }
    if (event.type === "thread.app-review-workflow-rerun-requested") {
      yield* rerunPhase(event.payload.run, event.payload.phase, event.occurredAt);
      return;
    }
    if (
      event.type === "thread.session-set" &&
      (event.payload.session.status === "starting" || event.payload.session.status === "running")
    ) {
      const run = yield* runForEvent(event);
      if (run !== null && isSupersededAppReviewPhaseThread(run, event.payload.threadId)) {
        yield* orchestrationEngine.dispatch({
          type: "thread.turn.interrupt",
          commandId: yield* serverCommandId("app-review-workflow-superseded-interrupt"),
          threadId: event.payload.threadId,
          createdAt: event.occurredAt,
        });
        return;
      }
    }
    if (event.type === "thread.activity-appended") {
      const run = yield* runForEvent(event);
      if (run === null) return;
      if (
        event.payload.activity.kind === "approval.requested" ||
        event.payload.activity.kind === "user-input.requested"
      ) {
        yield* failRun({
          run,
          reason:
            event.payload.activity.kind === "approval.requested"
              ? "unexpected-approval"
              : "unexpected-user-input",
          detailMarkdown: `Unattended App Review received an unexpected ${event.payload.activity.kind === "approval.requested" ? "approval" : "user-input"} request.`,
          occurredAt: event.occurredAt,
        });
        return;
      }
    }
    if (event.type === "thread.session-set" && event.payload.session.status === "error") {
      const run = yield* runForEvent(event);
      if (run !== null && run.activeThreadId === event.payload.threadId) {
        const active = yield* resolveThread(event.payload.threadId);
        if (active !== undefined && (yield* phaseThreadState(active)) === "nudging") return;
        // A named phase owns bounded continuation turns in its durable thread.
        // A session error with no active phase has no safe retry target.
        const phaseReason =
          run.activePhase === "fixing"
            ? ("fixer-failed" as const)
            : run.activePhase === "review"
              ? ("review-blocked" as const)
              : run.activePhase === "planning"
                ? ("plan-missing" as const)
                : null;
        const detailMarkdown =
          event.payload.session.lastError ??
          `The ${run.activePhase ?? "workflow"} provider session failed.`;
        yield* phaseReason === null
          ? failRun({ run, reason: "unknown", detailMarkdown, occurredAt: event.occurredAt })
          : failCycle({ run, reason: phaseReason, detailMarkdown, occurredAt: event.occurredAt });
        return;
      }
    }
    const run = yield* runForEvent(event);
    if (run !== null) yield* reconcileRun(run, event.occurredAt);
  });

  const processEventSafely = (event: AppReviewWorkflowEvent) =>
    processEvent(event).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.gen(function* () {
              const run = yield* runForEvent(event).pipe(Effect.orElseSucceed(() => null));
              if (run !== null && run.status === "running") {
                yield* failRun({
                  run,
                  reason: "automation-unavailable",
                  detailMarkdown: `App Review automation failed while processing ${event.type}.\n\n${Cause.pretty(cause)}`,
                  occurredAt: event.occurredAt,
                }).pipe(Effect.catch(() => Effect.void));
                return;
              }
              yield* Effect.logWarning("App Review workflow reactor failed to process event", {
                eventType: event.type,
                cause: Cause.pretty(cause),
              });
            }),
      ),
    );

  const phaseHasReplayableResult = (
    run: AppReviewWorkflowRun,
    cycle: AppReviewWorkflowCycle,
    phase: AppReviewWorkflowPhase,
    thread: OrchestrationThread,
    controller: OrchestrationThread | undefined,
  ) => {
    if (!hasSettledCheckpoint(thread)) return false;
    if (phase === "review") {
      const review = controller === undefined ? null : reviewRecordForCycle(controller, cycle);
      return review !== null && (review.status === "passed" || review.status === "failed");
    }
    if (phase === "planning") {
      return thread.activities.some(
        (activity) =>
          activity.kind === "app-review-repair-tickets" &&
          Predicate.isObject(activity.payload) &&
          activity.payload["type"] === "app-review-repair-tickets" &&
          activity.payload["runId"] === run.id &&
          activity.payload["cycleNumber"] === cycle.cycleNumber &&
          Array.isArray(activity.payload["tickets"]) &&
          activity.payload["tickets"].length > 0,
      );
    }
    return parseFixResult(thread, run, cycle) !== null;
  };

  const recoverFailedImplementationPhase = Effect.fn(
    "AppReviewWorkflowReactor.recoverFailedImplementationPhase",
  )(function* (input: {
    readonly run: AppReviewWorkflowRun;
    readonly readModel: OrchestrationReadModel;
    readonly occurredAt: string;
  }) {
    const claim = recoverableFailedAppReviewPhase({
      run: input.run,
      implementationRuns: input.readModel.implementationRuns,
    });
    if (claim === null) return false;
    if (isWorkflowThreadPaused(input.readModel.threads, input.run.controllerThreadId)) return false;
    const [phaseThread, controller, target] = yield* Effect.all([
      resolveThread(claim.threadId),
      resolveThread(input.run.controllerThreadId),
      resolveTarget(input.run.targetThreadId),
    ]);
    if (phaseThread === undefined || phaseThread.deletedAt !== null || target === null)
      return false;
    const cycle = input.run.cycles.at(-1);
    if (cycle === undefined) return false;
    const replayableResult = phaseHasReplayableResult(
      input.run,
      cycle,
      claim.phase,
      phaseThread,
      controller,
    );
    const phaseTurnIsLive =
      phaseThread.latestTurn?.state === "running" ||
      phaseThread.session?.status === "starting" ||
      phaseThread.session?.status === "running" ||
      (phaseThread.session?.activeTurnId ?? null) !== null;
    const observeExistingClaim =
      claim.mode === "observe-claim" || (claim.mode === "resume-claim" && phaseTurnIsLive);
    if (observeExistingClaim) {
      if (!phaseTurnIsLive && !replayableResult) return false;
    } else if (phaseTurnIsLive) {
      return false;
    }
    const planningReview =
      claim.phase === "planning" && controller !== undefined
        ? reviewRecordForCycle(controller, cycle)
        : null;
    if (
      claim.phase === "planning" &&
      (planningReview === null || cycle.actionableFindingsMarkdown === null)
    ) {
      return false;
    }
    const repairTickets = cycle.repairTickets ?? [];
    if (claim.phase === "fixing" && repairTickets.length === 0) return false;
    const workspaceRevision = yield* computeWorkspaceRevision(target.cwd);
    const reopened = reopenFailedAppReviewPhase({
      run: input.run,
      phase: claim.phase,
      workspaceRevision,
      occurredAt: input.occurredAt,
      incrementRecoveryCount: claim.mode === "claim",
      incrementReviewLaunchCount: !observeExistingClaim,
    });
    if (reopened === null) return false;
    yield* updateRun(reopened);
    const reopenedCycle = reopened.cycles.at(-1);
    if (reopenedCycle === undefined) return false;
    if (replayableResult || observeExistingClaim) {
      yield* reconcileRun(reopened, input.occurredAt);
    } else if (claim.phase === "review") {
      yield* ensureReviewLaunch(reopened, reopenedCycle);
    } else if (claim.phase === "planning") {
      if (planningReview === null || cycle.actionableFindingsMarkdown === null) return false;
      yield* startPlanning({
        run: reopened,
        review: planningReview,
        actionableFindingsMarkdown: cycle.actionableFindingsMarkdown,
        occurredAt: input.occurredAt,
      });
    } else {
      yield* startFixer({
        run: reopened,
        repairTickets,
        plannerTurnId: cycle.plannerTurnId,
        occurredAt: input.occurredAt,
      });
    }
    yield* Effect.logInfo("App Review continued a failed historical phase in its existing thread", {
      runId: input.run.id,
      phase: claim.phase,
      threadId: claim.threadId,
      recoveryMode: observeExistingClaim ? "observe-claim" : claim.mode,
    });
    return true;
  });

  const reconcileRuns = Effect.fn("AppReviewWorkflowReactor.reconcileRuns")(function* () {
    const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
    const occurredAt = yield* nowIso;
    for (const run of readModel.appReviewWorkflowRuns ?? []) {
      if (run.status === "failed") {
        if (yield* recoverFailedImplementationPhase({ run, readModel, occurredAt })) continue;
      }
      if (run.status !== "running") continue;
      if (isWorkflowThreadPaused(readModel.threads, run.controllerThreadId)) continue;
      yield* reconcileRun(run, occurredAt).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : failRun({
                run,
                reason: "automation-unavailable",
                detailMarkdown: `App Review automation was unavailable during restart recovery.\n\n${Cause.pretty(cause)}`,
                occurredAt,
              }).pipe(Effect.catch(() => Effect.void)),
        ),
      );
    }
  });

  type WorkItem =
    | { readonly kind: "event"; readonly event: AppReviewWorkflowEvent }
    | { readonly kind: "reconcile" };

  const worker = yield* makeDrainableWorker((item: WorkItem) =>
    item.kind === "event"
      ? processEventSafely(item.event)
      : reconcileRuns().pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("App Review workflow recovery sweep failed", {
              cause: Cause.pretty(cause),
            }),
          ),
        ),
  );

  const reconcile: AppReviewWorkflowReactorShape["reconcile"] = () =>
    worker.enqueue({ kind: "reconcile" }).pipe(Effect.andThen(worker.flush));

  const start: AppReviewWorkflowReactorShape["start"] = Effect.fn("start")(function* () {
    const domainEvents =
      orchestrationEngine.subscribeDomainEvents === undefined
        ? orchestrationEngine.streamDomainEvents
        : Stream.fromSubscription(yield* orchestrationEngine.subscribeDomainEvents);
    yield* Effect.forkScoped(
      Stream.runForEach(domainEvents, (event) => {
        if (
          event.type === "thread.activity-appended" &&
          !isAppReviewWorkflowActivityKind(event.payload.activity.kind)
        ) {
          return Effect.void;
        }
        if (
          event.type === "thread.session-set" &&
          !isAppReviewWorkflowSessionStatus(event.payload.session.status)
        ) {
          return Effect.void;
        }
        if (
          event.type !== "thread.app-review-workflow-launched" &&
          event.type !== "thread.app-review-workflow-resume-requested" &&
          event.type !== "thread.app-review-workflow-rerun-requested" &&
          event.type !== "thread.app-review-workflow-cancel-requested" &&
          event.type !== "thread.app-review-updated" &&
          event.type !== "thread.proposed-plan-upserted" &&
          event.type !== "thread.turn-diff-completed" &&
          event.type !== "thread.activity-appended" &&
          event.type !== "thread.session-set"
        ) {
          return Effect.void;
        }
        return worker.enqueue({ kind: "event", event });
      }),
    );
    if ((yield* ServerActivation) === undefined) yield* reconcile();
    yield* Effect.forkScoped(
      Effect.sleep(Duration.millis(APP_REVIEW_RECOVERY_SWEEP_INTERVAL_MS)).pipe(
        Effect.andThen(reconcile()),
        Effect.forever,
      ),
    );
  });

  return {
    start,
    drain: worker.drain,
    flush: worker.flush,
    reconcile,
  } satisfies AppReviewWorkflowReactorShape;
});

export const AppReviewWorkflowReactorLive = Layer.effect(AppReviewWorkflowReactor, make);
