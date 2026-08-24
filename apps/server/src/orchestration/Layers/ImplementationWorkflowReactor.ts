import {
  type AppDevStackAutoCreateResult,
  applyImplementationSkip,
  type AppReviewWorkflowRun,
  AppReviewWorkflowRunId,
  CommandId,
  AppReviewId,
  isRunStageSkipped,
  isTicketSkipped,
  isTicketStageSkipped,
  EventId,
  GitCommandError,
  AppReviewWorkflowCycleBudget,
  IMPLEMENTATION_RUN_MAX_QA_REPAIRS,
  IMPLEMENTATION_RUN_MAX_REVIEW_GATE_CYCLES,
  IMPLEMENTATION_STAGE_MAX_LAUNCHES,
  MessageId,
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationImplementationRerunRunStage,
  type OrchestrationImplementationRerunTicketStage,
  type OrchestrationImplementationRun,
  type OrchestrationImplementationTicketState,
  type OrchestrationImplementationValidationResult,
  type OrchestrationImplementationWorkerResult,
  type OrchestrationPlanningTicket,
  type OrchestrationReadModel,
  type OrchestrationThread,
  WORKFLOW_AUTOMATION_RUNTIME_MODE,
  type WorkspaceUserId,
} from "@t3tools/contracts";
import {
  appReviewPartsForScope,
  appReviewScopeForParts,
  describeAppReviewParts,
  intersectAppReviewParts,
  resolveLayeredAppReviewStepParts,
} from "@t3tools/shared/appReviewParts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { proposedPlanTitle } from "@t3tools/shared/orchestrationPlanning";
import { implementationWorkflowDefaultSkips } from "@t3tools/shared/workflowStepSkips";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import { HttpClient } from "effect/unstable/http";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";

import { AppDevStackManager } from "../../appDevStack/AppDevStackManager.ts";
import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
import {
  appendWorkflowSkillCommandSection,
  WORKFLOW_PROMPT_IDS,
} from "../../provider/WorkflowPromptRegistry.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  ImplementationWorkflowReactor,
  type ImplementationWorkflowReactorShape,
} from "../Services/ImplementationWorkflowReactor.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  findWorkflowStepReviewParts,
  findWorkflowStepModels,
  resolveWorkflowStepModelSelection,
  resolveWorkflowSubagentSpawnDefinition,
} from "../workflowSubagents.ts";
import {
  resolveWorkflowStepCycleBudget,
  type WorkflowStepCycleKey,
} from "@t3tools/shared/workflowStepCycles";
import { isWorkflowThreadPaused } from "../workflowPause.ts";
import { isAwaitingWorkflowNudge, WORKFLOW_INTERRUPTION_ERROR_MESSAGE } from "../workflowNudge.ts";

// Code Review owns its fixes. Final validation is terminal: a failure stops
// automation instead of publishing work that the gate did not approve.

type ImplementationWorkflowEvent = Extract<
  OrchestrationEvent,
  {
    type:
      | "thread.implementation-run-launched"
      | "thread.planning-tickets-created"
      | "thread.activity-appended"
      | "thread.app-review-updated"
      | "thread.implementation-change-request-retry-requested"
      | "thread.implementation-run-retry-requested"
      | "thread.implementation-run-rerun-requested"
      | "thread.implementation-run-reset-requested"
      | "thread.implementation-run-skip-set"
      | "thread.implementation-run-cancel-requested"
      | "thread.app-review-workflow-launched"
      | "thread.app-review-workflow-updated"
      | "thread.workflow-resumed";
  }
>;

type WorkerDirective = OrchestrationImplementationWorkerResult & {
  readonly type: "implementation-worker-result";
};

type MergeGateDirective = {
  readonly type: "implementation-merge-gate-result";
  readonly runId: string;
  readonly status: "passed" | "failed";
  readonly validations: ReadonlyArray<OrchestrationImplementationValidationResult>;
  readonly summaryMarkdown: string;
};

type FixDirective = {
  readonly type: "implementation-fix-result";
  readonly runId: string;
  readonly status: "succeeded" | "failed" | "blocked";
  readonly commitSha?: string;
  readonly validations: ReadonlyArray<OrchestrationImplementationValidationResult>;
  readonly notesMarkdown: string;
};

export function codeReviewNeedsFreshAppReview(
  run: OrchestrationImplementationRun,
  reviewedHeadSha: string,
): boolean {
  return (
    run.qaExhaustedAt === null &&
    run.appReviewExhaustedAt === null &&
    run.appReviewedHeadSha !== null &&
    run.appReviewedHeadSha !== reviewedHeadSha
  );
}

export function passedAppReviewContinuation(
  run: OrchestrationImplementationRun,
  reviewedHeadSha: string,
): "code-review" | "final-validation" {
  return run.codeReviewedHeadSha === reviewedHeadSha ? "final-validation" : "code-review";
}

type CodeReviewDirective = {
  readonly type: "implementation-code-review-result";
  readonly runId: string;
  readonly ticketId?: string;
  readonly status: "clean" | "findings" | "blocked";
  /** Set when the single review-and-fix pass landed fixes; names the commit it produced. */
  readonly commitSha?: string;
  readonly validations: ReadonlyArray<OrchestrationImplementationValidationResult>;
  readonly reportMarkdown: string;
};

type FastBuildDirective = {
  readonly type: "implementation-fast-build-result";
  readonly runId: string;
  readonly status: "succeeded" | "failed" | "blocked";
  readonly commitSha?: string;
  readonly validations: ReadonlyArray<OrchestrationImplementationValidationResult>;
  readonly notesMarkdown: string;
};

type ChangeRequestBabysitDirective = {
  readonly type: "implementation-change-request-babysit-result";
  readonly runId: string;
  readonly status: "passed" | "blocked";
  readonly headSha: string;
  readonly summaryMarkdown: string;
};

type BranchIntegration = {
  readonly baseTicketId: string | null;
  readonly baseRefName: string;
  readonly mergedTicketIds: ReadonlyArray<string>;
  readonly conflictedTicketId: string | null;
  readonly conflictedRefName: string | null;
  readonly conflictedFiles: ReadonlyArray<string>;
  readonly remainingTicketIds: ReadonlyArray<string>;
  readonly remainingRefNames: ReadonlyArray<string>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const asValidationResults = (
  value: unknown,
): ReadonlyArray<OrchestrationImplementationValidationResult> =>
  Array.isArray(value) ? (value as ReadonlyArray<OrchestrationImplementationValidationResult>) : [];

const asWorkerDirective = (value: unknown): WorkerDirective | null =>
  isRecord(value) && value["type"] === "implementation-worker-result"
    ? (value as WorkerDirective)
    : null;

const asMergeGateDirective = (value: unknown): MergeGateDirective | null =>
  isRecord(value) && value["type"] === "implementation-merge-gate-result"
    ? (value as MergeGateDirective)
    : null;

const asFixDirective = (value: unknown): FixDirective | null =>
  isRecord(value) && value["type"] === "implementation-fix-result" ? (value as FixDirective) : null;

const asCodeReviewDirective = (value: unknown): CodeReviewDirective | null =>
  isRecord(value) && value["type"] === "implementation-code-review-result"
    ? // Activities recorded before Code Review became a review-and-fix pass carry no validations.
      { ...(value as CodeReviewDirective), validations: asValidationResults(value["validations"]) }
    : null;

const asFastBuildDirective = (value: unknown): FastBuildDirective | null =>
  isRecord(value) && value["type"] === "implementation-fast-build-result"
    ? (value as FastBuildDirective)
    : null;

const asChangeRequestBabysitDirective = (value: unknown): ChangeRequestBabysitDirective | null =>
  isRecord(value) && value["type"] === "implementation-change-request-babysit-result"
    ? (value as ChangeRequestBabysitDirective)
    : null;

function findRunSourceThreadId(input: {
  readonly readModel: OrchestrationReadModel;
  readonly run: OrchestrationImplementationRun;
}): ThreadId | null {
  const orchestratorThread = input.readModel.threads.find(
    (thread) => thread.id === input.run.orchestratorThreadId,
  );
  return orchestratorThread?.parentThreadId ?? null;
}

function findThread(
  readModel: OrchestrationReadModel,
  threadId: ThreadId,
): OrchestrationThread | null {
  return readModel.threads.find((thread) => thread.id === threadId) ?? null;
}

function findRunById(
  readModel: OrchestrationReadModel,
  runId: string,
): OrchestrationImplementationRun | null {
  return readModel.implementationRuns.find((run) => run.id === runId) ?? null;
}

export function workflowIdForRun(
  readModel: {
    readonly threads: ReadonlyArray<{
      readonly id: ThreadId;
      readonly workflowContext?: { readonly workflowId: string } | null;
    }>;
  },
  run: Pick<OrchestrationImplementationRun, "orchestratorThreadId">,
): string | undefined {
  return readModel.threads.find((thread) => thread.id === run.orchestratorThreadId)?.workflowContext
    ?.workflowId;
}

function findRunByWorkerThreadId(
  readModel: OrchestrationReadModel,
  workerThreadId: ThreadId,
): OrchestrationImplementationRun | null {
  return (
    readModel.implementationRuns.find((run) =>
      run.ticketStates.some((state) => state.workerThreadId === workerThreadId),
    ) ?? null
  );
}

function findRunByAppReview(
  readModel: OrchestrationReadModel,
  reviewId: AppReviewId,
  sourceThreadId: ThreadId,
): OrchestrationImplementationRun | null {
  return (
    readModel.implementationRuns.find(
      (run) =>
        run.orchestratorThreadId === sourceThreadId &&
        run.appReviewIds.some((candidate) => candidate === reviewId),
    ) ?? null
  );
}

function ticketsById(
  thread: OrchestrationThread,
): ReadonlyMap<string, OrchestrationPlanningTicket> {
  const map = new Map<string, OrchestrationPlanningTicket>();
  for (const ticket of thread.planningWorkflow?.tickets ?? []) {
    map.set(ticket.id, ticket);
  }
  return map;
}

function markDependentsReady(
  run: OrchestrationImplementationRun,
  updatedAt: string,
): OrchestrationImplementationRun {
  const succeededTicketIds = new Set(
    run.ticketStates.filter((state) => state.status === "succeeded").map((state) => state.ticketId),
  );
  return {
    ...run,
    ticketStates: run.ticketStates.map((state) =>
      state.status === "blocked" &&
      state.dependencyTicketIds.every((ticketId) => succeededTicketIds.has(ticketId))
        ? { ...state, status: "ready" as const, updatedAt }
        : state,
    ),
    updatedAt,
  };
}

function automationStageForFailure(
  stage: NonNullable<OrchestrationImplementationRun["retryableFailure"]>["stage"] | undefined,
): NonNullable<OrchestrationImplementationRun["automationHalt"]>["stage"] {
  switch (stage) {
    case "app-review":
    case "app-dev-stack":
      return "app-review";
    case "code-review":
      return "final-code-review";
    case "integration":
    case "merge-gate":
      return "integration";
    default:
      return "implementation";
  }
}

function structuralGitFailure(detail: string): boolean {
  const normalized = detail.toLowerCase();
  return (
    normalized.includes("dirty") ||
    normalized.includes("uncommitted") ||
    normalized.includes("clean worktree") ||
    normalized.includes("clean working tree") ||
    normalized.includes("expected branch") ||
    normalized.includes("wrong branch") ||
    normalized.includes("detached head") ||
    normalized.includes("reported commit") ||
    normalized.includes("identity does not match") ||
    normalized.includes("worktree identity") ||
    normalized.includes("worktree add failed") ||
    normalized.includes("worktree must")
  );
}

function isFinalCodeReviewPass(run: OrchestrationImplementationRun): boolean {
  return (
    run.appReviewedHeadSha !== null ||
    run.qaExhaustedAt !== null ||
    run.appReviewExhaustedAt !== null ||
    run.latestAppReviewWorkflowOutcome !== null
  );
}

function automationHaltMatchesTicketRerun(input: {
  readonly halt: NonNullable<OrchestrationImplementationRun["automationHalt"]>;
  readonly ticketId: string;
  readonly stage: OrchestrationImplementationRerunTicketStage;
}): boolean {
  return input.halt.ticketId === input.ticketId && input.halt.stage === input.stage;
}

function automationHaltMatchesRunRerun(input: {
  readonly halt: NonNullable<OrchestrationImplementationRun["automationHalt"]>;
  readonly stage: OrchestrationImplementationRerunRunStage;
}): boolean {
  switch (input.stage) {
    case "integration":
    case "merge-gate":
      return input.halt.ticketId === undefined && input.halt.stage === "integration";
    case "app-review":
      return input.halt.ticketId === undefined && input.halt.stage === "app-review";
    case "code-review":
      return (
        input.halt.ticketId === undefined &&
        (input.halt.stage === "code-review" || input.halt.stage === "final-code-review")
      );
  }
}

/**
 * Whether a nested App Review still speaks for the ticket it was launched for.
 *
 * True while the ticket points at it, and in the window between launching a
 * review and the launch landing, where the ticket waits with no pointer yet.
 * False once a clear or a re-run has rewound the ticket past its App Review:
 * the review is then an orphan, and what it reports is about a ticket that has
 * moved on.
 */
export function ticketAwaitsAppReviewRun(
  state: OrchestrationImplementationTicketState,
  appReviewWorkflowRunId: string,
): boolean {
  return (
    state.appReviewWorkflowRunId === appReviewWorkflowRunId ||
    (state.appReviewWorkflowRunId == null && state.status === "app-reviewing")
  );
}

/**
 * Whether an embedded App Review is parked between cycles waiting for its
 * caller to refresh the preview.
 *
 * A successful embedded fix ends its cycle with `await-preview-refresh`: the
 * run stops itself so the next browser review exercises the repaired code
 * instead of a stale deployment, and only the caller can say when the preview
 * is fresh. A run in this state never moves again on its own.
 */
export function nestedAppReviewAwaitsPreviewRefresh(run: AppReviewWorkflowRun): boolean {
  return (
    run.caller.type === "implementation" &&
    run.status === "running" &&
    run.activePhase === null &&
    run.cycles.at(-1)?.fixResult?.status === "succeeded"
  );
}

/**
 * Rewind one ticket to the start of `stage`, and reopen everything that failed
 * only because this ticket did.
 *
 * Cascade failures carry no work of their own: they were marked failed the
 * moment a dependency went terminal. Sending them back to `blocked` lets
 * `markDependentsReady` promote them in dependency order once the re-run lands,
 * instead of leaving a graph that can never finish.
 */
function reopenTicketForRerun(input: {
  readonly run: OrchestrationImplementationRun;
  readonly ticketId: string;
  readonly stage: OrchestrationImplementationRerunTicketStage;
  readonly updatedAt: string;
}): OrchestrationImplementationRun {
  const reopenedIds = new Set([input.ticketId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const state of input.run.ticketStates) {
      if (reopenedIds.has(state.ticketId) || state.status !== "failed") continue;
      if (!state.dependencyTicketIds.some((ticketId) => reopenedIds.has(ticketId))) continue;
      reopenedIds.add(state.ticketId);
      changed = true;
    }
  }
  const ticketStates = input.run.ticketStates.map((state) => {
    if (state.ticketId !== input.ticketId) {
      return reopenedIds.has(state.ticketId)
        ? {
            ...state,
            status: "blocked" as const,
            warningMarkdown: null,
            updatedAt: input.updatedAt,
          }
        : state;
    }
    const cleared = {
      ...state,
      codeReviewThreadId: null,
      codeReviewOutcome: null,
      warningMarkdown: null,
      updatedAt: input.updatedAt,
    };
    if (input.stage === "code-review") {
      return {
        ...cleared,
        status: "code-reviewing" as const,
        codeReviewGeneration: state.codeReviewGeneration + 1,
        codeReviewLaunchCount: 0,
        codeReviewPassCount: 0,
      };
    }
    const withoutAppReview = {
      ...cleared,
      appDevStackTierDownAt: null,
      appReviewWorkflowRunId: null,
      appReviewOutcome: null,
    };
    if (input.stage === "app-review") {
      return {
        ...withoutAppReview,
        status: "app-reviewing" as const,
        appReviewGeneration: state.appReviewGeneration + 1,
        appReviewLaunchCount: 0,
      };
    }
    // The worker starts over, so its reported result stops standing for this
    // ticket. The worktree and branch survive; the ticket keeps working there.
    return {
      ...withoutAppReview,
      status: "ready" as const,
      workerThreadId: null,
      workerResult: null,
      implementationGeneration: state.implementationGeneration + 1,
      attemptCount: 0,
    };
  });
  return {
    ...input.run,
    status: "running",
    ticketStates,
    workerResults:
      input.stage === "implementation"
        ? input.run.workerResults.filter((result) => result.ticketId !== input.ticketId)
        : input.run.workerResults,
    // The combined change gets rebuilt from whatever the re-run produces, so a
    // sha from the previous integration must not reach the next merge gate.
    integrationHeadSha: null,
    retryableFailure: null,
    automationHalt:
      input.run.automationHalt !== null &&
      automationHaltMatchesTicketRerun({
        halt: input.run.automationHalt,
        ticketId: input.ticketId,
        stage: input.stage,
      })
        ? null
        : input.run.automationHalt,
    updatedAt: input.updatedAt,
  };
}

/**
 * Clear the run-wide state one stage owns so it can start again.
 *
 * Each stage refuses to start while it still points at a thread, which is what
 * keeps a sweep from spawning a second one. A re-run has to drop those pointers
 * itself; the previous threads stay in history, just no longer current.
 */
function clearRunStageForRerun(input: {
  readonly run: OrchestrationImplementationRun;
  readonly stage: OrchestrationImplementationRerunRunStage;
  readonly updatedAt: string;
}): OrchestrationImplementationRun {
  const base = {
    ...input.run,
    reviewGateExhaustedAt: null,
    reviewGateExhaustionReason: null,
    retryableFailure: null,
    automationHalt:
      input.run.automationHalt !== null &&
      automationHaltMatchesRunRerun({ halt: input.run.automationHalt, stage: input.stage })
        ? null
        : input.run.automationHalt,
    updatedAt: input.updatedAt,
  };
  switch (input.stage) {
    case "integration":
      return { ...base, status: "integrating" as const, integrationHeadSha: null };
    case "merge-gate":
      return {
        ...base,
        status: "validating" as const,
        activeValidatorThreadId: null,
        activeValidationHeadSha: null,
        activeValidationKind: null,
        validatedHeadSha: null,
        finalValidation: null,
      };
    case "app-review":
      return {
        ...base,
        status: "qa-reviewing" as const,
        activeAppReviewThreadId: null,
        activeAppReviewHeadSha: null,
        appReviewedHeadSha: null,
        appReviewExhaustedAt: null,
        latestAppReviewWorkflowOutcome: null,
      };
    case "code-review":
      return {
        ...base,
        status: "code-reviewing" as const,
        activeCodeReviewThreadId: null,
        activeCodeReviewHeadSha: null,
        codeReviewedHeadSha: null,
        finalCodeReviewGeneration: input.run.finalCodeReviewGeneration + 1,
        finalCodeReviewLaunchCount: 0,
        finalCodeReviewPassCount: 0,
      };
  }
}

export function implementationTicketStateIsTerminal(status: string): boolean {
  return status === "succeeded" || status === "failed";
}

export function implementationRunRerunIsPaused(input: {
  readonly threads: OrchestrationReadModel["threads"];
  readonly sourceThreadId: ThreadId;
  readonly orchestratorThreadId: ThreadId;
}): boolean {
  return (
    isWorkflowThreadPaused(input.threads, input.sourceThreadId) ||
    isWorkflowThreadPaused(input.threads, input.orchestratorThreadId)
  );
}

export function implementationTicketReviewWarningLines(
  run: Pick<OrchestrationImplementationRun, "ticketStates">,
): ReadonlyArray<string> {
  return run.ticketStates
    .filter((state) => state.status === "failed" || (state.warningMarkdown?.trim().length ?? 0) > 0)
    .map(
      (state) =>
        `- ⚠️ ${state.ticketId}: ${state.warningMarkdown?.trim() || "implementation did not complete"}`,
    );
}

export function failImplementationTickets(
  run: OrchestrationImplementationRun,
  failures: ReadonlyMap<string, string>,
  updatedAt: string,
): OrchestrationImplementationRun {
  const failedIds = new Set(failures.keys());
  let changed = true;
  while (changed) {
    changed = false;
    for (const state of run.ticketStates) {
      if (
        !failedIds.has(state.ticketId) &&
        state.dependencyTicketIds.some((ticketId) => failedIds.has(ticketId))
      ) {
        failedIds.add(state.ticketId);
        changed = true;
      }
    }
  }
  return {
    ...run,
    ticketStates: run.ticketStates.map((state) =>
      failedIds.has(state.ticketId)
        ? {
            ...state,
            status: "failed" as const,
            warningMarkdown:
              failures.get(state.ticketId) ??
              `Blocked by failed dependency${
                state.dependencyTicketIds.filter((ticketId) => failedIds.has(ticketId)).length === 1
                  ? ""
                  : " chain"
              }: ${state.dependencyTicketIds
                .filter((ticketId) => failedIds.has(ticketId))
                .map((ticketId) => `'${ticketId}'`)
                .join(", ")}.`,
            updatedAt,
          }
        : state,
    ),
    retryableFailure: null,
    updatedAt,
  };
}

function terminalLineageTicketIds(run: OrchestrationImplementationRun): ReadonlyArray<string> {
  const succeeded = new Set(
    run.ticketStates.filter((state) => state.status === "succeeded").map((state) => state.ticketId),
  );
  const recorded = run.terminalLineageTicketIds.filter((ticketId) => succeeded.has(ticketId));
  if (recorded.length > 0) return recorded;
  // Every recorded tip failed, so the lineage has to be re-read from what
  // survived. Only edges a surviving ticket owns count: a failed tip still
  // lists the tickets it was going to build on, and counting those edges makes
  // every survivor look superseded. That empties the set, and integration then
  // merges nothing while reporting that it integrated the terminal branches.
  const dependencyIds = new Set(
    run.ticketStates
      .filter((state) => succeeded.has(state.ticketId))
      .flatMap((state) => state.dependencyTicketIds),
  );
  return run.ticketStates
    .filter((state) => succeeded.has(state.ticketId) && !dependencyIds.has(state.ticketId))
    .map((state) => state.ticketId);
}

function completeValidationsPassedExactlyOnce(input: {
  readonly requiredCommands: ReadonlyArray<string>;
  readonly validations: ReadonlyArray<OrchestrationImplementationValidationResult>;
}): boolean {
  const requiredCounts = new Map<string, number>();
  for (const command of input.requiredCommands) {
    const normalized = command.trim();
    requiredCounts.set(normalized, (requiredCounts.get(normalized) ?? 0) + 1);
  }
  const reportedCounts = new Map<string, number>();
  for (const validation of input.validations) {
    const normalized = validation.command.trim();
    if (!requiredCounts.has(normalized)) continue;
    if (validation.status !== "passed") return false;
    reportedCounts.set(normalized, (reportedCounts.get(normalized) ?? 0) + 1);
  }
  return [...requiredCounts].every(([command, count]) => reportedCounts.get(command) === count);
}

function focusedRepairValidationsPassed(input: {
  readonly finalCommands: ReadonlyArray<string>;
  readonly validations: ReadonlyArray<OrchestrationImplementationValidationResult>;
}): boolean {
  const finalCommands = new Set(input.finalCommands.map((command) => command.trim()));
  return (
    input.validations.length > 0 &&
    input.validations.every(
      (validation) =>
        validation.status === "passed" && !finalCommands.has(validation.command.trim()),
    )
  );
}

function validationSummary(
  validations: ReadonlyArray<OrchestrationImplementationValidationResult>,
  fallbackCommand: string,
  fallbackMarkdown: string,
  completedAt: string,
): OrchestrationImplementationValidationResult {
  return (
    validations[0] ?? {
      command: fallbackCommand,
      status: "failed",
      outputMarkdown: fallbackMarkdown,
      completedAt,
    }
  );
}

function buildWorkerPrompt(input: {
  readonly run: OrchestrationImplementationRun;
  readonly ticketId: string;
  readonly workerThreadId: ThreadId;
  readonly branch: string;
  readonly worktreePath: string;
  readonly integration: BranchIntegration;
}): string {
  const integrationLines = [
    `- base ref: ${input.integration.baseRefName}`,
    `- base ticket: ${input.integration.baseTicketId ?? "orchestrator"}`,
    `- programmatically merged dependencies: ${input.integration.mergedTicketIds.join(", ") || "none"}`,
  ];
  if (input.integration.conflictedTicketId !== null) {
    integrationLines.push(
      `- conflicted dependency: ${input.integration.conflictedTicketId} (${input.integration.conflictedRefName})`,
      `- conflicted files: ${input.integration.conflictedFiles.join(", ") || "unknown"}`,
      `- remaining dependency branches: ${input.integration.remainingRefNames.join(", ") || "none"}`,
      "Resolve and commit the current dependency merge, merge any remaining dependency branches in order, then implement the planning ticket.",
    );
  }
  return [
    `Implement planning ticket ${input.ticketId} for implementation run ${input.run.id}.`,
    "",
    "Do not ask the user questions. Run one focused failing test before implementation. Work in behavioral slices, rerunning the relevant focused test after each slice, then finish with affected-file formatting, linting, typing, and focused tests only.",
    "Do not run launch-level complete validation commands or full test suites. A documented sub-minute fast check such as `pnpm check` is allowed. The final gate after Code Review owns complete validation. Do not rerun an unchanged passing command without a new code change that could affect it.",
    "",
    "Branch/worktree:",
    `- branch: ${input.branch}`,
    `- worktree: ${input.worktreePath}`,
    ...integrationLines,
    "",
    `Retrieve ticket ${input.ticketId} with workflow_ticket_get before implementing it. Use workflow_spec_get when the Spec is needed; artifact bodies are intentionally not embedded in this prompt.`,
    "Treat the ticket's plannedFileChanges as the expected file scope. Make any additional supporting changes required for correctness, and explain material deviations from the planned paths or actions in notesMarkdown.",
    "",
    "Finish with exactly one fenced JSON directive of type implementation-worker-result. Use these fixed identifiers:",
    `- ticketId: ${input.ticketId}`,
    `- workerThreadId: ${input.workerThreadId}`,
    `- branch: ${input.branch}`,
    `- worktreePath: ${input.worktreePath}`,
  ].join("\n");
}

function buildMergeGatePrompt(input: {
  readonly run: OrchestrationImplementationRun;
  readonly integration: BranchIntegration;
  readonly kind: "integration" | "final";
}): string {
  const integrationInstructions =
    input.kind === "final"
      ? [
          "Code Review has accepted the current HEAD. Do not change code or merge branches in this gate; validate that exact reviewed commit.",
        ]
      : input.integration.conflictedTicketId === null
        ? [
            "All terminal worker branches were integrated programmatically. Do not merge worker branches again; validate the current orchestrator HEAD for this gate.",
          ]
        : [
            `Programmatic integration stopped while merging ${input.integration.conflictedTicketId} (${input.integration.conflictedRefName}).`,
            `Conflicted files: ${input.integration.conflictedFiles.join(", ") || "unknown"}.`,
            "Load and apply the bundled Matt Pocock Resolving Merge Conflicts skill before touching the conflict hunks.",
            `After resolving and committing that merge, merge these remaining terminal branches in order: ${input.integration.remainingRefNames.join(", ") || "none"}.`,
            "Then validate the resulting integrated HEAD for this gate.",
          ];
  const validationInstructions =
    input.kind === "final"
      ? [
          "This is the sole complete repository gate. Code Review has finished for this HEAD. Run every configured command exactly once:",
          ...input.run.launchSummary.validationCommands.map((command) => `- ${command}`),
          "",
          "If native mobile files changed, also run:",
          "- vp run lint:mobile",
          "",
          "Never repeat a successful complete gate on an unchanged commit.",
        ]
      : [
          "This is the integration gate before App Review and Code Review. Run focused tests and fast static checks that finish in under a minute; a repository-provided fast command such as `pnpm check` is appropriate when documented as sub-minute.",
          "Do not run the configured complete validation commands at this stage:",
          ...input.run.launchSummary.validationCommands.map((command) => `- ${command}`),
          "The sole complete gate runs after Code Review.",
        ];
  return [
    `Run ${input.kind} gate for implementation run ${input.run.id}.`,
    "",
    ...integrationInstructions,
    "Use the repository's existing focused validation setup. Do not start a competing development server or replace dependency paths in the shared worktree: its workflow-owned AppDevStack was created during workspace bootstrap and is reused here. If validation cannot run with the prepared workspace, report the setup failure explicitly.",
    "",
    ...validationInstructions,
    "",
    "Do not ask the user questions. Finish with exactly one fenced JSON directive of type implementation-merge-gate-result for this runId.",
  ].join("\n");
}

function buildBrowserAppReviewPrompt(input: {
  readonly run: OrchestrationImplementationRun;
  readonly frontendUrl: string | null;
  readonly artifactMarkdown?: string;
}): string {
  const ticketWarnings = input.run.ticketStates
    .filter((state) => state.status === "failed" || (state.warningMarkdown?.trim().length ?? 0) > 0)
    .map(
      (state) =>
        `- ${state.ticketId}: ${state.warningMarkdown?.trim() || "implementation did not complete"}`,
    );
  return [
    `Perform browser app review for implementation run ${input.run.id}.`,
    "",
    "Open the app with preview_open, record the session with app_review_recording_start/stop, exercise the product with the preview_* tools, and capture captioned screenshots with app_review_capture_screenshot. Do not ask the user questions.",
    "Review cross-ticket and multi-step behavior across the complete integrated change. Recheck every ticket-level App Review that failed, exhausted, was blocked, or could not run.",
    ...(ticketWarnings.length === 0
      ? []
      : ["", "Ticket-level warnings requiring combined review focus:", ...ticketWarnings]),
    "",
    input.frontendUrl === null
      ? "No frontend URL was resolved. If the app cannot be opened, mark the review blocked with concrete details."
      : `Feature URL: ${input.frontendUrl}`,
    "The Feature URL above is the authoritative frontend for the App Dev Stack associated with this implementation worktree. Do not substitute a deployment URL from repository documentation, source-thread messages, browser history, or environment conventions. If the authoritative target is unavailable, mark the review blocked.",
    `Worktree: ${input.run.orchestratorWorktreePath}`,
    `Diff command: git diff ${input.run.pinnedCommit}...HEAD`,
    "",
    input.run.artifactSource === "proposed-plan"
      ? `Review against the locked product intent and proposed plan below, as well as the actual diff and app behavior.\n\n${input.artifactMarkdown ?? "Proposed-plan context unavailable."}`
      : "Review against the Spec and planning tickets loaded on this implementation thread.",
    "Update the app-review record with passed, failed, or blocked status and a document.",
  ].join("\n");
}

function buildFixPrompt(input: {
  readonly run: OrchestrationImplementationRun;
  readonly reviewId: AppReviewId;
  readonly artifactMarkdown?: string;
}): string {
  return [
    `Fix browser app-review failures for implementation run ${input.run.id}.`,
    "",
    `This is QA repair ${input.run.qaCycleCount} of ${IMPLEMENTATION_RUN_MAX_QA_REPAIRS}. Do not ask the user questions. Use a focused red-green TDD loop, make the smallest implementation changes needed in the orchestrator worktree, run focused validation only, commit the repair, and report the fix result.`,
    "",
    input.run.artifactSource === "proposed-plan"
      ? `Retrieve App Review ${input.reviewId} with workflow_app_review_get before applying its findings. Review against the proposed-plan context below; do not load a missing Spec or tickets.\n\n${input.artifactMarkdown ?? "Proposed-plan context unavailable."}`
      : `Retrieve App Review ${input.reviewId} with workflow_app_review_get before applying its findings. Use workflow_tickets_list and workflow_ticket_get for the linked tickets.`,
    "",
    "Do not run launch-level complete validation commands or full test suites. A documented sub-minute fast check is allowed. The final gate after Code Review owns complete validation on the new HEAD.",
    "",
    "Finish with exactly one fenced JSON directive of type implementation-fix-result for this runId.",
  ].join("\n");
}

function buildAppDevStackFixPrompt(input: {
  readonly run: OrchestrationImplementationRun;
  readonly diagnosticsMarkdown: string;
}): string {
  return [
    `Repair the AppDevStack failure for implementation run ${input.run.id}.`,
    "",
    `This is QA repair ${input.run.qaCycleCount} of ${IMPLEMENTATION_RUN_MAX_QA_REPAIRS}. Treat the supplied failure as a code problem in this worktree, even when it looks like controller, authentication, configuration, or deployment infrastructure. Do not ask the user questions.`,
    "",
    "Use a focused red-green TDD loop at the failing application or stack-contract seam. Make the smallest reliable code or configuration change that can make the AppDevStack start and its frontend serve.",
    "",
    "Programmatic AppDevStack diagnostics:",
    input.diagnosticsMarkdown,
    "",
    "Run focused validation or a documented sub-minute fast check. Do not run launch-level complete validation commands or full test suites; the final gate after Code Review owns complete validation on the new HEAD.",
    "",
    "Commit all completed changes and leave the orchestrator worktree clean. Finish with exactly one fenced JSON directive of type implementation-fix-result for this runId.",
  ].join("\n");
}

function buildCodeReviewPrompt(input: {
  readonly run: OrchestrationImplementationRun;
  readonly artifactMarkdown?: string;
  readonly reviewBaseSha?: string;
}): string {
  const changeRequest = input.run.changeRequest;
  const reviewBaseSha = input.reviewBaseSha ?? input.run.pinnedCommit;
  const isFinalReview = input.run.codeReviewAttemptCount > 1;
  return [
    `Perform the ${isFinalReview ? "final post-App-Review" : "combined pre-App-Review"} Code Review for run ${input.run.id}. This is a single pass.`,
    "",
    isFinalReview
      ? "Review the complete combined HEAD after App Review, including App Review repairs and unresolved warnings. This is the last Code Review; do not request another review cycle."
      : "Review the complete integrated ticket set along the Standards and Spec axes described in your workflow instructions.",
    "Apply required fixes yourself and commit them. Do not ask the user questions.",
    "",
    "App Review passed at this commit.",
    "",
    "Review scope:",
    `- worktree: ${input.run.orchestratorWorktreePath}`,
    `- review base: ${reviewBaseSha}`,
    `- diff command: git diff ${reviewBaseSha}...HEAD`,
    changeRequest === null
      ? "- change request: not available"
      : `- change request: ${changeRequest.url} (#${changeRequest.number})`,
    "",
    input.run.artifactSource === "proposed-plan"
      ? `Review against the locked product intent and proposed plan below; do not attempt to load a missing Spec or planning tickets.\n\n${input.artifactMarkdown ?? "Proposed-plan context unavailable."}`
      : "Retrieve the canonical Spec with workflow_spec_get and the run tickets with workflow_tickets_list/workflow_ticket_get. Artifact bodies are intentionally not embedded in this prompt.",
    "Compare the actual diff with each ticket's plannedFileChanges. Report planned changes missing from the diff, unexplained changed files, and create/update/delete action mismatches. File-plan drift is review evidence rather than an automatic failure when supporting changes are justified and the implementation is correct.",
    "",
    'Use status "clean" only when neither axis has findings that require code changes, "findings" when code changes were required, and "blocked" when the review cannot be performed. Put the full two-axis report in reportMarkdown.',
    "",
    `When status is "findings", fix the findings in ${input.run.orchestratorWorktreePath} on branch ${input.run.orchestratorBranch}, commit them, and set commitSha to the resulting HEAD. Leave the worktree clean.`,
    "",
    "When findings change HEAD, run focused or sub-minute fast validation and report it in validations. Do not run launch-level complete validation commands; the sole complete gate starts after Code Review finishes. A clean review should not rerun validation.",
    "If your changes affect capability evidence, review corpora, or their documentation, run the corresponding focused audit or contract test before handing off. The complete gate must not be used as a cheap preflight for deterministic evidence drift.",
    "",
    `Finish with exactly one fenced JSON directive of type implementation-code-review-result for runId ${input.run.id}.`,
  ].join("\n");
}

function buildCodeReviewFixPrompt(input: {
  readonly run: OrchestrationImplementationRun;
  readonly reportMarkdown: string;
}): string {
  return [
    `Fix code-review findings for implementation run ${input.run.id}.`,
    "",
    "Do not ask the user questions. Apply the code-review findings with the smallest reliable changes in the orchestrator worktree, run focused validation, and report the fix result.",
    "",
    "Latest code review report:",
    input.reportMarkdown,
    "",
    "Run focused validation or a documented sub-minute fast check. Do not run launch-level complete validation commands or full test suites; the final gate after Code Review owns complete validation on the new HEAD.",
    "",
    "Finish with exactly one fenced JSON directive of type implementation-fix-result for this runId.",
  ].join("\n");
}

function buildMergeGateFixPrompt(input: {
  readonly run: OrchestrationImplementationRun;
  readonly reportMarkdown: string;
}): string {
  const gateName = input.run.activeValidationKind === "final" ? "final validation" : "merge gate";
  return [
    `Fix ${gateName} failures for implementation run ${input.run.id}.`,
    "",
    "Do not ask the user questions. Resolve integration conflicts or validation failures in the orchestrator worktree, commit the result, and report the fix.",
    "",
    "Latest merge-gate report:",
    input.reportMarkdown,
    "",
    "Run the cheapest deterministic checks named by the failure first, including capability-evidence or review-documentation audits when applicable. Resolve the complete reported failure set in one repair instead of waiting for the next full gate to reveal the same items again.",
    "",
    "Run focused validation or a documented sub-minute fast check. Do not run launch-level complete validation commands or full test suites; the final gate after Code Review owns complete validation on the new HEAD.",
    "",
    "Finish with exactly one fenced JSON directive of type implementation-fix-result for this runId.",
  ].join("\n");
}

function findRunProposedPlan(input: {
  readonly run: OrchestrationImplementationRun;
  readonly sourceThread: OrchestrationThread;
}) {
  return input.sourceThread.proposedPlans.find(
    (candidate) => candidate.id === input.run.sourceProposedPlan?.planId,
  );
}

/**
 * The plan is the whole handover. There is no locked-intent section: threads read from the command
 * read model carry no activities, so the intent could only ever render as "unavailable" filler.
 */
function fastFeatureArtifactMarkdown(input: {
  readonly run: OrchestrationImplementationRun;
  readonly sourceThread: OrchestrationThread;
}): string {
  const plan = findRunProposedPlan(input);
  return ["## Canonical proposed plan", plan?.planMarkdown ?? "Proposed plan unavailable."].join(
    "\n",
  );
}

/**
 * Required when the change touches native mobile files. Shared by the Build contract and the gate
 * in `applyFastBuildResult` so the command the agent is told to run is the command that is checked.
 */
const NATIVE_MOBILE_VALIDATION_COMMAND = "vp run lint:mobile";

function completeValidationCommandsForFiles(
  run: OrchestrationImplementationRun,
  changedFiles: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const commands = [...run.launchSummary.validationCommands];
  const nativeMobileChanged = changedFiles.some(
    (path) => path === "apps/mobile" || path.startsWith("apps/mobile/"),
  );
  if (nativeMobileChanged && !commands.includes(NATIVE_MOBILE_VALIDATION_COMMAND)) {
    commands.push(NATIVE_MOBILE_VALIDATION_COMMAND);
  }
  return commands;
}

/**
 * `ready` has to mean "the frontend is serving", not "the controller accepted the request".
 * Recording a still-`starting` stack as ready froze that state on the run and made every later
 * App Review skip provisioning, so reviewers were sent at a URL that never came up. A reserved
 * branch has no stack of its own — a standing deployment serves it, so a URL is enough.
 */
function appDevStackReadiness(result: AppDevStackAutoCreateResult): "ready" | "ensuring" {
  if (result.frontendUrl === null) return "ensuring";
  return result.stack === null || result.stack.status === "running" ? "ready" : "ensuring";
}

function isAppDevStackInfrastructureFailure(detail: string): boolean {
  return detail.toLowerCase().includes("not visible to the app dev stack controller");
}

function fastFeatureExampleDirective(run: OrchestrationImplementationRun) {
  return {
    type: "implementation-fast-build-result",
    runId: run.id,
    status: "succeeded",
    commitSha: "HEAD commit SHA",
    validations: [
      {
        command: "<focused test or documented sub-minute fast check actually run>",
        status: "passed",
        outputMarkdown: "summary",
        completedAt: "ISO timestamp",
      },
    ],
    notesMarkdown: "Implementation notes",
  } as const;
}

function fastFeatureExecutionContract(run: OrchestrationImplementationRun): ReadonlyArray<string> {
  return [
    "## Execution identity",
    `- branch: ${run.orchestratorBranch}`,
    `- worktree: ${run.orchestratorWorktreePath}`,
    `- fixed source commit: ${run.pinnedCommit}`,
    "- App Dev Stack: created by workflow workspace bootstrap after dependency setup; Build reuses it",
    "",
    "Use the repository dependencies prepared during workflow workspace bootstrap. Do not start a competing development server or replace dependency paths mounted by the workflow-owned App Dev Stack.",
    "",
    "## Pre-review validation",
    "Run focused tests and affected-file checks. A documented sub-minute fast command such as `pnpm check` is allowed.",
    "Do not run the launch-level complete validation commands in Build; the final gate runs them after Code Review:",
    ...run.launchSummary.validationCommands.map((command) => `- ${command}`),
    "",
    "Report the exact focused or fast commands actually run in `validations`.",
    "",
    "Finish with exactly one fenced JSON directive:",
    "```json",
    JSON.stringify(fastFeatureExampleDirective(run), null, 2),
    "```",
  ];
}

/**
 * Programmatic guard that the Build prompt and the Build gate cannot drift apart. The example
 * directive the prompt tells Build to copy has to satisfy the very check `applyFastBuildResult`
 * runs. Returns the problems so a focused test can assert there are none; a prompt edit that breaks
 * the round trip fails there rather than silently rejecting a finished build in production.
 */
export function fastFeatureBuildContractProblems(
  run: OrchestrationImplementationRun,
): ReadonlyArray<string> {
  const contract = fastFeatureExecutionContract(run).join("\n");
  const problems: string[] = [];

  const fences = [...contract.matchAll(/```json\s*([\s\S]*?)```/g)];
  if (fences.length !== 1) {
    problems.push(`Contract must embed exactly one JSON directive, found ${fences.length}.`);
    return problems;
  }
  let example: unknown;
  try {
    example = JSON.parse(fences[0]?.[1] ?? "");
  } catch {
    problems.push("Embedded directive is not valid JSON.");
    return problems;
  }
  const directive = asFastBuildDirective(example);
  if (directive === null) {
    problems.push("Embedded directive is not an implementation-fast-build-result.");
    return problems;
  }
  if (directive.runId !== run.id) {
    problems.push("Embedded directive names a different run.");
  }
  if (
    !focusedRepairValidationsPassed({
      finalCommands: [...run.launchSummary.validationCommands, NATIVE_MOBILE_VALIDATION_COMMAND],
      validations: directive.validations,
    })
  ) {
    problems.push(
      "Embedded directive would be rejected by the focused pre-review validation gate.",
    );
  }
  return problems;
}

/**
 * `rejectionMarkdown` is set when Build is being re-prompted after its last result was rejected.
 * Without it a retry re-sends the original handover, and Build reproduces the same rejection.
 */
function buildFastFeaturePrompt(input: {
  readonly run: OrchestrationImplementationRun;
  readonly sourceThread: OrchestrationThread;
  readonly rejectionMarkdown?: string;
}): string {
  return [
    `Implement Fast feature run ${input.run.id}.`,
    "",
    "Do not ask the user questions. Implement the canonical plan in the exact branch and worktree below, validate it, and commit all completed changes. Treat its `## Build topology` as the execution contract. Execute every workstream in the listed order in this Build thread, preserve the stated ownership boundaries, wait for dependencies before starting downstream work, resolve overlap, run the listed focused checks, and commit. Do not start provider-native agents or T3 workflow children for Build workstreams.",
    ...(input.rejectionMarkdown === undefined
      ? []
      : [
          "",
          "## Your last result was rejected",
          input.rejectionMarkdown,
          "",
          "Work already committed on this branch stands. Fix only what is called out above — re-running validations and re-reporting is often all that is needed — then finish with the directive below.",
        ]),
    "",
    fastFeatureArtifactMarkdown(input),
    "",
    ...fastFeatureExecutionContract(input.run),
  ].join("\n");
}

/**
 * Automated-review provenance for the published change request. A run that exhausted App Review is
 * still published, so the unpassed review has to be visible on the change request itself.
 */
function reviewGateExhaustionReason(run: OrchestrationImplementationRun): string {
  const lastValidation = run.finalValidation?.outputMarkdown.trim();
  return [
    "The fixed Code Review sequence completed, but final validation did not pass on the resulting HEAD.",
    lastValidation === undefined || lastValidation.length === 0
      ? "The latest complete validation did not produce a usable summary."
      : `Latest validation: ${lastValidation.slice(0, 1_000)}`,
  ].join(" ");
}

function changeRequestReviewNote(run: OrchestrationImplementationRun): string {
  const lines = [];
  const ticketWarnings = implementationTicketReviewWarningLines(run);
  if (ticketWarnings.length > 0) lines.push("## Ticket review warnings", ...ticketWarnings, "");
  if (run.reviewGateExhaustedAt !== null) {
    lines.push(
      "## Work in progress",
      `- ⚠️ The fixed Code Review sequence completed after ${run.codeReviewAttemptCount} combined pass(es); final validation remains unresolved.`,
      `- ${run.reviewGateExhaustionReason ?? reviewGateExhaustionReason(run)}`,
      "- Complete validation has not passed on this HEAD. Keep this change request as work in progress and resolve the recorded findings before merging.",
      "",
    );
  }
  lines.push("## Automated review");
  const exhaustedAt = run.qaExhaustedAt ?? run.appReviewExhaustedAt;
  if (exhaustedAt === null) {
    lines.push(
      run.appReviewStrategy === "nested-workflow"
        ? `- QA: passed after ${run.qaAttemptCount} App Review cycle(s).`
        : `- QA: passed after ${run.qaCycleCount} repair(s) and ${run.qaAttemptCount} Browser App Review attempt(s).`,
    );
  } else {
    const gate = run.qaExhaustionReason ?? "app-review";
    lines.push(
      run.appReviewStrategy === "nested-workflow" && gate === "app-review"
        ? `- ⚠️ Nested App Review '${run.appReviewWorkflowRunIds.at(-1) ?? "unknown"}' **exhausted after ${run.qaAttemptCount} complete cycle(s)**. Latest review: ${run.lastQaFailure?.reviewId ?? "unknown"}. This change request was published best-effort with unresolved findings; manually verify the affected flow before merging.`
        : `- ⚠️ Automated QA: **did not pass; exhausted ${run.qaCycleCount}/${IMPLEMENTATION_RUN_MAX_QA_REPAIRS} fresh repairs**. Last unsatisfied gate: ${gate === "app-dev-stack" ? "AppDevStack" : "Browser App Review"}. This change request was published best-effort; manually verify the affected flow before merging.`,
    );
    if (run.lastQaFailure !== null) {
      lines.push(`- Last QA failure: ${run.lastQaFailure.detailMarkdown.slice(0, 1_000)}`);
      if (run.lastQaFailure.reviewId !== null) {
        lines.push(`- App Review: ${run.lastQaFailure.reviewId}`);
      }
    }
  }
  lines.push(
    run.latestCodeReviewReportMarkdown === null
      ? "- Code Review: no report recorded."
      : `- Code Review: completed ${run.codeReviewAttemptCount} review-and-fix pass(es); the latest report is recorded on the implementation run.`,
  );
  return lines.join("\n");
}

function changeRequestFailure(input: {
  readonly detail: string;
  readonly failedAt: string;
}): OrchestrationImplementationRun["changeRequestFailure"] {
  return {
    reason: "unknown",
    detail: input.detail.trim().length > 0 ? input.detail : "Change request publication failed.",
    failedAt: input.failedAt,
  };
}

/** App Review is already slow; a hung edge must not hold the reactor's queue. */
/**
 * How long a stage thread may sit with no session and no turn before recovery
 * treats its launch as lost.
 *
 * Long enough that a provider backed up behind dozens of agents still reports
 * first, short enough that a start dropped by a restart, which nothing else
 * re-drives, does not strand the ticket for the rest of the run.
 */
const UNREPORTED_STAGE_THREAD_GRACE_MS = 10 * 60 * 1_000;

const FRONTEND_PROBE_TIMEOUT = Duration.seconds(10);
const APP_DEV_STACK_DIAGNOSTIC_LIMIT = 24 * 1_024;

export function appDevStackBackendHealthUrl(frontendUrl: string): string {
  return new URL("/api/health", frontendUrl).href;
}

function errorDetail(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const gitWorkflow = yield* GitWorkflowService;
  const appDevStackManager = yield* AppDevStackManager;
  const serverSettingsService = yield* ServerSettingsService;
  const httpClient = yield* HttpClient.HttpClient;
  const changeRequestLocks = yield* SynchronizedRef.make(
    new Map<string, { readonly semaphore: Semaphore.Semaphore; readonly users: number }>(),
  );

  /**
   * Asks the frontend URL itself whether a reviewer could load it. Deliberately cheap and
   * fail-closed: anything other than a real answer below 400 blocks App Review on the retryable
   * `app-dev-stack` stage, so a stack still coming up gets the sweep's retries before a human is
   * involved. 4xx and 5xx both count as down — at an app root they mean Traefik has no route or no
   * healthy backend, not a page worth reviewing.
   */
  const probeFrontend = Effect.fn("ImplementationWorkflowReactor.probeFrontend")(function* (
    url: string,
  ) {
    const outcome = yield* httpClient
      .get(url)
      .pipe(Effect.timeout(FRONTEND_PROBE_TIMEOUT), Effect.result);
    if (outcome._tag === "Failure") {
      return { ok: false, detail: `could not be reached (${errorDetail(outcome.failure)})` };
    }
    return outcome.success.status < 400
      ? { ok: true, detail: `answered HTTP ${outcome.success.status}` }
      : { ok: false, detail: `returned HTTP ${outcome.success.status}` };
  });

  const appDevStackDiagnostics = Effect.fn("ImplementationWorkflowReactor.appDevStackDiagnostics")(
    function* (input: {
      readonly run: OrchestrationImplementationRun;
      readonly stackId: string | null;
      readonly detail: string;
    }) {
      const stackResult =
        input.stackId === null
          ? null
          : yield* appDevStackManager.get({ stackId: input.stackId }).pipe(Effect.result);
      const logsResult =
        input.stackId === null
          ? null
          : yield* appDevStackManager
              .getStackPodLogs({ stackId: input.stackId, tailLines: 300 })
              .pipe(Effect.result);
      const stack = stackResult?._tag === "Success" ? stackResult.success : null;
      const services =
        stack?.services?.flatMap((service) => [
          `- service ${service.name}: status=${service.status}; health=${service.health ?? "unknown"}; error=${service.error ?? "none"}`,
        ]) ?? [];
      const pods =
        logsResult?._tag === "Success"
          ? logsResult.success.pods.map(
              (pod) =>
                `- pod ${pod.name}: phase=${pod.phase}; ready=${pod.readyContainerCount}/${pod.totalContainerCount}; restarts=${pod.restartCount}`,
            )
          : [];
      const logEntries =
        logsResult?._tag === "Success"
          ? logsResult.success.entries.flatMap((entry) => [
              `### ${entry.podName}/${entry.containerName}`,
              entry.error === null ? entry.logs : `Log read failed: ${entry.error}`,
            ])
          : [];
      const diagnostics = [
        `- QA repairs consumed: ${input.run.qaCycleCount}/${IMPLEMENTATION_RUN_MAX_QA_REPAIRS}`,
        `- worktree: ${input.run.orchestratorWorktreePath}`,
        `- branch: ${input.run.orchestratorBranch}`,
        `- stack id: ${input.stackId ?? "unavailable"}`,
        `- stack status: ${stack?.status ?? input.run.appDevStack.stackStatus ?? "unavailable"}`,
        `- frontend URL: ${stack === null ? (input.run.appDevStack.frontendUrl ?? "unavailable") : (input.run.appDevStack.frontendUrl ?? "unavailable")}`,
        `- failure: ${input.detail}`,
        ...(stackResult?._tag === "Failure"
          ? [`- stack inspection failed: ${errorDetail(stackResult.failure)}`]
          : []),
        ...services,
        ...pods,
        ...(logsResult?._tag === "Failure"
          ? [`- pod log collection failed: ${errorDetail(logsResult.failure)}`]
          : []),
        ...logEntries,
      ].join("\n");
      const redacted = diagnostics
        .replace(/((?:authorization|password|secret|token)\s*[:=]\s*)(\S+)/giu, "$1[redacted]")
        .replace(/(bearer\s+)(\S+)/giu, "$1[redacted]");
      return redacted.length <= APP_DEV_STACK_DIAGNOSTIC_LIMIT
        ? redacted
        : `[earlier diagnostics truncated]\n${redacted.slice(-APP_DEV_STACK_DIAGNOSTIC_LIMIT)}`;
    },
  );

  const resolveQaHeadSha = (run: OrchestrationImplementationRun) =>
    gitWorkflow.resolveCommit({ cwd: run.orchestratorWorktreePath, ref: "HEAD" }).pipe(
      Effect.map(({ commitSha }) => commitSha),
      Effect.orElseSucceed(
        () => run.validatedHeadSha ?? run.integrationHeadSha ?? run.pinnedCommit,
      ),
    );

  const serverCommandId = (tag: string) =>
    crypto.randomUUIDv4.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));
  const serverEventId = () => crypto.randomUUIDv4.pipe(Effect.map(EventId.make));
  const serverMessageId = (tag: string) =>
    crypto.randomUUIDv4.pipe(Effect.map((uuid) => MessageId.make(`message-${tag}-${uuid}`)));
  const serverThreadId = (tag: string) =>
    crypto.randomUUIDv4.pipe(Effect.map((uuid) => ThreadId.make(`thread-${tag}-${uuid}`)));
  const serverAppReviewId = () =>
    crypto.randomUUIDv4.pipe(Effect.map((uuid) => AppReviewId.make(`app-review-${uuid}`)));

  const updateRun = Effect.fn("ImplementationWorkflowReactor.updateRun")(function* (input: {
    readonly sourceThreadId: ThreadId;
    readonly run: OrchestrationImplementationRun;
    readonly createdAt: string;
    readonly allowCanceledFinalCodeReviewRerun?: boolean;
    readonly expectedCodeReviewClaim?: {
      readonly attemptCount: OrchestrationImplementationRun["codeReviewAttemptCount"];
      readonly activeThreadId: ThreadId | null;
      readonly generation?: number;
      readonly launchCount?: number;
    };
    readonly expectedTicketStageClaims?: ReadonlyArray<{
      readonly ticketId: OrchestrationImplementationTicketState["ticketId"];
      readonly stage: "implementation" | "app-review" | "code-review";
      readonly generation: number;
      readonly launchCount: number;
      readonly activeExecutionId: string | null;
    }>;
    readonly expectedChangeRequestClaim?: {
      readonly status: "publishing-change-request" | "babysitting-change-request";
      readonly changeRequestNumber: number | null;
      readonly activeBabysitterThreadId: ThreadId | null;
    };
  }) {
    // `canceled` is terminal. In-flight stage work (a late build directive, a
    // recovery sweep already past its guard) must not resurrect a run the user
    // stopped, so drop any write that would move it out of `canceled`.
    const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
    const currentRun = findRunById(readModel, input.run.id);
    const resumesCanceledFinalCodeReview =
      input.allowCanceledFinalCodeReviewRerun === true && input.run.status === "code-reviewing";
    if (
      currentRun?.status === "canceled" &&
      input.run.status !== "canceled" &&
      !resumesCanceledFinalCodeReview
    ) {
      return;
    }
    yield* orchestrationEngine.dispatch({
      type: "thread.implementation-run.update",
      commandId: yield* serverCommandId("implementation-run-update"),
      threadId: input.sourceThreadId,
      run: input.run,
      ...(input.expectedCodeReviewClaim === undefined
        ? {}
        : { expectedCodeReviewClaim: input.expectedCodeReviewClaim }),
      ...(input.expectedTicketStageClaims === undefined
        ? {}
        : { expectedTicketStageClaims: input.expectedTicketStageClaims }),
      ...(input.expectedChangeRequestClaim === undefined
        ? {}
        : { expectedChangeRequestClaim: input.expectedChangeRequestClaim }),
      createdAt: input.createdAt,
    });
  });

  const appendActivity = Effect.fn("ImplementationWorkflowReactor.appendActivity")(
    function* (input: {
      readonly threadId: ThreadId;
      readonly tone: "info" | "error";
      readonly kind: string;
      readonly summary: string;
      readonly payload: unknown;
      readonly createdAt: string;
    }) {
      yield* orchestrationEngine.dispatch({
        type: "thread.activity.append",
        commandId: yield* serverCommandId("implementation-workflow-activity"),
        threadId: input.threadId,
        activity: {
          id: yield* serverEventId(),
          tone: input.tone,
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
   * Model for one workflow step: the user's per-step pin when the workflow
   * root carries one, otherwise the step definition's hardlock, otherwise the
   * orchestrator's own selection. A pin that can no longer be honored is
   * reported on the orchestrator thread rather than failing the spawn.
   */
  const modelForStep = Effect.fn("ImplementationWorkflowReactor.modelForStep")(function* (input: {
    readonly workflowPromptId: string;
    /** Set when the spawn runs under a step with a different prompt id. */
    readonly stepWorkflowPromptId?: string;
    readonly orchestratorThread: OrchestrationThread;
    readonly createdAt: string;
  }) {
    const settings = yield* serverSettingsService.getSettings.pipe(
      Effect.orElseSucceed(() => undefined),
    );
    const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
    const resolved = resolveWorkflowStepModelSelection({
      workflowPromptId: input.workflowPromptId,
      ...(input.stepWorkflowPromptId === undefined
        ? {}
        : { stepWorkflowPromptId: input.stepWorkflowPromptId }),
      definition: resolveWorkflowSubagentSpawnDefinition(input.workflowPromptId),
      stepModels: findWorkflowStepModels(input.orchestratorThread, readModel.threads),
      parentModelSelection: input.orchestratorThread.modelSelection,
      settings,
    });
    if (resolved.fallbackDetail !== null) {
      yield* appendActivity({
        threadId: input.orchestratorThread.id,
        tone: "info",
        kind: "implementation-workflow.step-model-fallback",
        summary: "Pinned step model not honored",
        payload: {
          workflowPromptId: input.workflowPromptId,
          detail: resolved.fallbackDetail,
        },
        createdAt: input.createdAt,
      });
    }
    return resolved.modelSelection;
  });

  /**
   * Cycle budget for one looping workflow step: the run's own budget when the
   * workflow root carries one, otherwise the standing default from Settings,
   * otherwise `fallbackCycles` — which the final App Review takes from its
   * launch plan, since a run can be launched with a smaller review than the
   * step's default.
   */
  const cyclesForStep = Effect.fn("ImplementationWorkflowReactor.cyclesForStep")(function* (input: {
    readonly key: WorkflowStepCycleKey;
    readonly orchestratorThread: OrchestrationThread;
    readonly fallbackCycles?: number;
  }) {
    const settings = yield* serverSettingsService.getSettings.pipe(
      Effect.orElseSucceed(() => undefined),
    );
    const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
    const rootThreadId =
      input.orchestratorThread.workflowContext?.rootThreadId ?? input.orchestratorThread.id;
    const root =
      readModel.threads.find((candidate) => candidate.id === rootThreadId) ??
      input.orchestratorThread;
    return resolveWorkflowStepCycleBudget({
      key: input.key,
      threadOverrides: root.workflowStepCycles,
      settingsOverrides: settings?.workflowStepCycles,
      ...(input.fallbackCycles === undefined ? {} : { fallbackCycles: input.fallbackCycles }),
    });
  });

  const requestRunRetry = Effect.fn("ImplementationWorkflowReactor.requestRunRetry")(
    function* (input: {
      readonly sourceThreadId: ThreadId;
      readonly runId: string;
      readonly createdAt: string;
    }) {
      yield* orchestrationEngine.dispatch({
        type: "thread.implementation-run.retry",
        commandId: yield* serverCommandId("implementation-auto-retry"),
        threadId: input.sourceThreadId,
        runId: input.runId,
        createdAt: input.createdAt,
      });
    },
  );

  const blockRun = Effect.fn("ImplementationWorkflowReactor.blockRun")(function* (input: {
    readonly sourceThreadId: ThreadId;
    readonly run: OrchestrationImplementationRun;
    readonly reasonMarkdown: string;
    readonly updatedAt: string;
    readonly ticketId?: OrchestrationImplementationTicketState["ticketId"];
    readonly retryableStage?:
      | "source-dirty"
      | "worktree-setup"
      | "worker-setup"
      | "worker-execution"
      | "integration"
      | "merge-gate"
      | "app-dev-stack"
      | "app-review"
      | "code-review"
      | "fixer"
      | "build"
      | "change-request"
      | "change-request-babysit";
    readonly automaticRecovery?: boolean;
    readonly automaticRecoveryWaiting?: boolean;
    /**
     * Set when only a human can clear the condition (a moved source branch, a
     * conflicting worktree). `recoverRetryableRuns` skips these, so the attempt
     * budget is not spent by the 30s sweep before the user has read the message.
     */
    readonly humanBlocked?: boolean;
    readonly haltCategory?: NonNullable<
      OrchestrationImplementationRun["automationHalt"]
    >["category"];
    readonly haltStage?: NonNullable<OrchestrationImplementationRun["automationHalt"]>["stage"];
  }) {
    const previousAttempts =
      input.retryableStage !== undefined &&
      input.run.retryableFailure?.stage === input.retryableStage &&
      input.run.retryableFailure.ticketId === input.ticketId
        ? input.run.retryableFailure.attemptCount
        : 0;
    const nextAttemptCount = previousAttempts + 1;
    const humanBlocked = input.humanBlocked ?? structuralGitFailure(input.reasonMarkdown);
    const automationStopped =
      input.retryableStage === undefined ||
      humanBlocked ||
      nextAttemptCount >= IMPLEMENTATION_STAGE_MAX_LAUNCHES;
    const blockedRun: OrchestrationImplementationRun = {
      ...input.run,
      status: "needs-human-attention",
      retryableFailure:
        input.retryableStage === undefined
          ? input.run.retryableFailure
          : {
              ...(input.ticketId === undefined ? {} : { ticketId: input.ticketId }),
              stage: input.retryableStage,
              detail: input.reasonMarkdown,
              failedAt: input.updatedAt,
              attemptCount: nextAttemptCount,
              maxAttempts: IMPLEMENTATION_STAGE_MAX_LAUNCHES,
              humanBlocked,
            },
      automationHalt: automationStopped
        ? {
            ...(input.ticketId === undefined ? {} : { ticketId: input.ticketId }),
            stage: input.haltStage ?? automationStageForFailure(input.retryableStage),
            category: humanBlocked
              ? "structural-invariant"
              : (input.haltCategory ??
                (input.retryableStage === undefined ? "review-blocked" : "retry-exhausted")),
            detail: input.reasonMarkdown,
            haltedAt: input.updatedAt,
          }
        : input.run.automationHalt,
      updatedAt: input.updatedAt,
    };
    yield* updateRun({
      sourceThreadId: input.sourceThreadId,
      run: blockedRun,
      createdAt: input.updatedAt,
    });
    yield* appendActivity({
      threadId: input.run.orchestratorThreadId,
      tone: input.automaticRecoveryWaiting === true ? "info" : "error",
      kind:
        input.automaticRecoveryWaiting === true
          ? "implementation-app-dev-stack-waiting"
          : input.automaticRecovery === true
            ? "implementation-qa-remediation-requested"
            : "implementation-workflow.needs-human-attention",
      summary:
        input.automaticRecoveryWaiting === true
          ? "Waiting for App Dev Stack"
          : input.automaticRecovery === true
            ? "Automated QA remediation requested"
            : "Implementation workflow needs human attention",
      payload: { runId: input.run.id, reasonMarkdown: input.reasonMarkdown },
      createdAt: input.updatedAt,
    });
    return blockedRun;
  });

  const sourceThreadIdForRun = Effect.fn("ImplementationWorkflowReactor.sourceThreadIdForRun")(
    function* (run: OrchestrationImplementationRun) {
      const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
      return findRunSourceThreadId({ readModel, run });
    },
  );

  const verifiedDependency = Effect.fn("ImplementationWorkflowReactor.verifiedDependency")(
    function* (input: { readonly run: OrchestrationImplementationRun; readonly ticketId: string }) {
      const state = input.run.ticketStates.find(
        (candidate) => candidate.ticketId === input.ticketId,
      );
      // A skipped ticket carries no work and so reports no commit. Its branch
      // still exists and still holds its own dependencies, so it can be built
      // on; the branch itself is what says where it ended up.
      if (isTicketSkipped(input.run.skips, input.ticketId)) {
        if (state?.status !== "succeeded" || state.branch === null) {
          return yield* new GitCommandError({
            operation: "ImplementationWorkflowReactor.verifiedDependency",
            command: "git rev-parse",
            cwd: input.run.orchestratorWorktreePath,
            detail: `Skipped dependency ticket '${input.ticketId}' has no branch yet.`,
          });
        }
        const skippedHead = yield* gitWorkflow.resolveCommit({
          cwd: input.run.orchestratorWorktreePath,
          ref: state.branch,
        });
        return {
          ticketId: input.ticketId,
          branch: state.branch,
          commitSha: skippedHead.commitSha,
        };
      }
      if (
        state?.status !== "succeeded" ||
        state.branch === null ||
        state.workerResult?.status !== "succeeded"
      ) {
        return yield* new GitCommandError({
          operation: "ImplementationWorkflowReactor.verifiedDependency",
          command: "git rev-parse",
          cwd: input.run.orchestratorWorktreePath,
          detail: `Dependency ticket '${input.ticketId}' does not have a successful committed branch.`,
        });
      }
      const [resolved, reported] = yield* Effect.all([
        gitWorkflow.resolveCommit({
          cwd: input.run.orchestratorWorktreePath,
          ref: state.branch,
        }),
        gitWorkflow.resolveCommit({
          cwd: input.run.orchestratorWorktreePath,
          ref: state.workerResult.commitSha,
        }),
      ]);
      if (resolved.commitSha !== reported.commitSha) {
        return yield* new GitCommandError({
          operation: "ImplementationWorkflowReactor.verifiedDependency",
          command: "git rev-parse",
          cwd: input.run.orchestratorWorktreePath,
          detail: `Dependency ticket '${input.ticketId}' branch '${state.branch}' moved from reported commit '${reported.commitSha}' to '${resolved.commitSha}'.`,
        });
      }
      return {
        ticketId: input.ticketId,
        branch: state.branch,
        commitSha: reported.commitSha,
      };
    },
  );

  const verifySuccessfulWorkerResult = Effect.fn(
    "ImplementationWorkflowReactor.verifySuccessfulWorkerResult",
  )(function* (input: {
    readonly run: OrchestrationImplementationRun;
    readonly threadId: ThreadId;
    readonly directive: Extract<WorkerDirective, { readonly status: "succeeded" }>;
  }) {
    const state = input.run.ticketStates.find(
      (candidate) => candidate.workerThreadId === input.threadId,
    );
    if (
      state === undefined ||
      state.ticketId !== input.directive.ticketId ||
      state.branch === null ||
      state.branch !== input.directive.branch ||
      state.worktreePath === null ||
      state.worktreePath !== input.directive.worktreePath
    ) {
      return yield* new GitCommandError({
        operation: "ImplementationWorkflowReactor.verifySuccessfulWorkerResult",
        command: "verify worker identity",
        cwd: input.run.orchestratorWorktreePath,
        detail: `Worker result identity does not match the active assignment for thread '${input.threadId}'.`,
      });
    }

    const [reported, branchHead, worktreeHead, worktreeStatus] = yield* Effect.all([
      gitWorkflow.resolveCommit({
        cwd: input.run.orchestratorWorktreePath,
        ref: input.directive.commitSha,
      }),
      gitWorkflow.resolveCommit({
        cwd: input.run.orchestratorWorktreePath,
        ref: state.branch,
      }),
      gitWorkflow.resolveCommit({ cwd: state.worktreePath, ref: "HEAD" }),
      gitWorkflow.localStatus({ cwd: state.worktreePath }),
    ]);
    if (
      reported.commitSha !== branchHead.commitSha ||
      reported.commitSha !== worktreeHead.commitSha
    ) {
      return yield* new GitCommandError({
        operation: "ImplementationWorkflowReactor.verifySuccessfulWorkerResult",
        command: "git rev-parse",
        cwd: state.worktreePath,
        detail: `Worker '${state.ticketId}' reported '${reported.commitSha}', branch HEAD is '${branchHead.commitSha}', and worktree HEAD is '${worktreeHead.commitSha}'.`,
      });
    }
    if (
      !worktreeStatus.isRepo ||
      worktreeStatus.refName !== state.branch ||
      worktreeStatus.hasWorkingTreeChanges
    ) {
      return yield* new GitCommandError({
        operation: "ImplementationWorkflowReactor.verifySuccessfulWorkerResult",
        command: "git status",
        cwd: state.worktreePath,
        detail: `Worker '${state.ticketId}' must finish on branch '${state.branch}' with a clean worktree.`,
      });
    }

    for (const dependencyTicketId of state.dependencyTicketIds) {
      const dependency = yield* verifiedDependency({
        run: input.run,
        ticketId: dependencyTicketId,
      });
      const included = yield* gitWorkflow.isAncestor({
        cwd: state.worktreePath,
        ancestorRef: dependency.commitSha,
        descendantRef: reported.commitSha,
      });
      if (!included) {
        return yield* new GitCommandError({
          operation: "ImplementationWorkflowReactor.verifySuccessfulWorkerResult",
          command: "git merge-base --is-ancestor",
          cwd: state.worktreePath,
          detail: `Worker '${state.ticketId}' does not contain dependency '${dependencyTicketId}' at '${dependency.commitSha}'.`,
        });
      }
    }

    return { ...input.directive, commitSha: reported.commitSha };
  });

  const integrateRefs = Effect.fn("ImplementationWorkflowReactor.integrateRefs")(function* (input: {
    readonly cwd: string;
    readonly baseTicketId: string | null;
    readonly baseRefName: string;
    readonly refs: ReadonlyArray<{ readonly ticketId: string; readonly refName: string }>;
  }) {
    const mergedTicketIds: string[] = [];
    for (let index = 0; index < input.refs.length; index += 1) {
      const ref = input.refs[index];
      if (ref === undefined) continue;
      const result = yield* gitWorkflow.mergeRef({ cwd: input.cwd, refName: ref.refName });
      if (result.status === "conflicted") {
        const remaining = input.refs.slice(index + 1);
        return {
          baseTicketId: input.baseTicketId,
          baseRefName: input.baseRefName,
          mergedTicketIds,
          conflictedTicketId: ref.ticketId,
          conflictedRefName: ref.refName,
          conflictedFiles: result.conflictedFiles,
          remainingTicketIds: remaining.map((candidate) => candidate.ticketId),
          remainingRefNames: remaining.map((candidate) => candidate.refName),
        } satisfies BranchIntegration;
      }
      mergedTicketIds.push(ref.ticketId);
    }
    return {
      baseTicketId: input.baseTicketId,
      baseRefName: input.baseRefName,
      mergedTicketIds,
      conflictedTicketId: null,
      conflictedRefName: null,
      conflictedFiles: [],
      remainingTicketIds: [],
      remainingRefNames: [],
    } satisfies BranchIntegration;
  });

  const createWorker = Effect.fn("ImplementationWorkflowReactor.createWorker")(function* (input: {
    readonly sourceThreadId: ThreadId;
    readonly orchestratorThread: OrchestrationThread;
    readonly run: OrchestrationImplementationRun;
    readonly ticketId: string;
    readonly ownerUserId: WorkspaceUserId;
    readonly createdAt: string;
  }) {
    const plannedWorker = input.run.launchSummary.plannedWorkers.find(
      (worker) => worker.ticketId === input.ticketId,
    );
    if (plannedWorker === undefined) return input.run;

    const existing = input.run.ticketStates.find((state) => state.ticketId === input.ticketId);
    if (existing === undefined) return input.run;
    const skipped = isTicketSkipped(input.run.skips, input.ticketId);
    if (
      (skipped && existing.status !== "ready") ||
      (!skipped && (existing.status !== "running" || existing.workerThreadId === null))
    ) {
      return input.run;
    }

    const dependencies = yield* Effect.forEach(existing.dependencyTicketIds, (ticketId) =>
      verifiedDependency({ run: input.run, ticketId }),
    );
    const baseDependency = dependencies[0];
    const baseRefName = baseDependency?.branch ?? input.run.orchestratorBranch;
    const worktreeStartRef = baseDependency?.commitSha ?? input.run.orchestratorBranch;

    const existingWorktreeHead = yield* gitWorkflow
      .resolveCommit({ cwd: plannedWorker.worktreePath, ref: "HEAD" })
      .pipe(Effect.option);
    const worktreeExisted = Option.isSome(existingWorktreeHead);
    if (worktreeExisted) {
      const [status, expectedWorktreeHead] = yield* Effect.all([
        gitWorkflow.localStatus({ cwd: plannedWorker.worktreePath }),
        gitWorkflow.resolveCommit({
          cwd: plannedWorker.worktreePath,
          ref: plannedWorker.branch,
        }),
      ]);
      if (!status.isRepo || status.refName !== plannedWorker.branch) {
        return yield* new GitCommandError({
          operation: "ImplementationWorkflowReactor.createWorker",
          command: "git status",
          cwd: plannedWorker.worktreePath,
          detail: `Existing worker worktree is not on expected branch '${plannedWorker.branch}'.`,
        });
      }
      if (status.hasWorkingTreeChanges) {
        return yield* new GitCommandError({
          operation: "ImplementationWorkflowReactor.createWorker",
          command: "git status --short --branch",
          cwd: plannedWorker.worktreePath,
          detail: `Existing worker worktree on '${plannedWorker.branch}' is dirty before implementation launch.`,
        });
      }
      if (existingWorktreeHead.value.commitSha !== expectedWorktreeHead.commitSha) {
        return yield* new GitCommandError({
          operation: "ImplementationWorkflowReactor.createWorker",
          command: "git rev-parse HEAD",
          cwd: plannedWorker.worktreePath,
          detail: `Existing worker worktree HEAD '${existingWorktreeHead.value.commitSha}' does not match expected branch HEAD '${expectedWorktreeHead.commitSha}'.`,
        });
      }
    } else {
      yield* gitWorkflow.createWorktree({
        cwd: input.run.orchestratorWorktreePath,
        refName: worktreeStartRef,
        newRefName: plannedWorker.branch,
        baseRefName: input.run.baseBranch,
        path: plannedWorker.worktreePath,
      });
    }

    const integration = yield* integrateRefs({
      cwd: plannedWorker.worktreePath,
      baseTicketId: baseDependency?.ticketId ?? null,
      baseRefName,
      // A new worktree starts at the first dependency's commit, so only the rest
      // are merged. A worktree that already exists was branched from that
      // dependency as it stood then, and a ticket only comes back here because
      // someone started it again: if that dependency has since been repaired,
      // its new commits have to be merged like any other, or the ticket goes on
      // building on a base that moved without it.
      refs: (worktreeExisted ? dependencies : dependencies.slice(1)).map((dependency) => ({
        ticketId: dependency.ticketId,
        refName: dependency.commitSha,
      })),
    });

    yield* appendActivity({
      threadId: input.run.orchestratorThreadId,
      tone: integration.conflictedTicketId === null ? "info" : "error",
      kind: "implementation-ticket-branches-integrated",
      summary:
        integration.conflictedTicketId === null
          ? `Dependencies integrated for ${input.ticketId}`
          : `Dependency merge needs resolution for ${input.ticketId}`,
      payload: { runId: input.run.id, ticketId: input.ticketId, ...integration },
      createdAt: input.createdAt,
    });

    if (skipped) {
      yield* appendActivity({
        threadId: input.run.orchestratorThreadId,
        tone: "info",
        kind: "implementation-worker-finished",
        summary: `Ticket ${input.ticketId} skipped`,
        payload: {
          runId: input.run.id,
          ticketId: input.ticketId,
          status: "skipped",
          branch: plannedWorker.branch,
        },
        createdAt: input.createdAt,
      });
      return {
        ...input.run,
        ticketStates: input.run.ticketStates.map((state) =>
          state.ticketId === input.ticketId
            ? {
                ...state,
                status: "succeeded" as const,
                workerThreadId: null,
                workerResult: null,
                branch: plannedWorker.branch,
                worktreePath: plannedWorker.worktreePath,
                appDevStackTierDownAt: input.createdAt,
                warningMarkdown:
                  "Skipped. The branch carries its dependencies and no work of its own.",
                updatedAt: input.createdAt,
              }
            : state,
        ),
        updatedAt: input.createdAt,
      } satisfies OrchestrationImplementationRun;
    }

    const workerThreadId = existing.workerThreadId;
    if (workerThreadId === null) return input.run;
    const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
    const sourceThread = findThread(readModel, input.sourceThreadId);
    const ticket = ticketsById(sourceThread ?? input.orchestratorThread).get(input.ticketId);
    const workflowContext = input.orchestratorThread.workflowContext;
    if (
      workflowContext == null ||
      workflowContext.workflowId === undefined ||
      workflowContext.rootThreadId === undefined
    ) {
      return yield* new GitCommandError({
        operation: "ImplementationWorkflowReactor.createWorker",
        command: "claim ticket workflow context",
        cwd: input.run.orchestratorWorktreePath,
        detail: `Ticket '${input.ticketId}' cannot start without workflow identity.`,
      });
    }

    yield* orchestrationEngine.dispatch({
      type: "thread.create",
      commandId: yield* serverCommandId("implementation-worker-create"),
      threadId: workerThreadId,
      projectId: input.orchestratorThread.projectId,
      ownerUserId: input.ownerUserId,
      parentThreadId: input.run.orchestratorThreadId,
      workflowRole: "implementation-worker",
      workflowContext: {
        workflowId: workflowContext.workflowId,
        rootThreadId: workflowContext.rootThreadId,
        ...(workflowContext.parentWorkflowId === undefined
          ? {}
          : { parentWorkflowId: workflowContext.parentWorkflowId }),
        ticketScope: [input.ticketId],
      },
      title: `Implement ${ticket?.title ?? input.ticketId}`,
      modelSelection: yield* modelForStep({
        workflowPromptId: WORKFLOW_PROMPT_IDS.implementationTddCodex,
        orchestratorThread: input.orchestratorThread,
        createdAt: input.createdAt,
      }),
      runtimeMode: WORKFLOW_AUTOMATION_RUNTIME_MODE,
      interactionMode: "implementation-workflow",
      branch: plannedWorker.branch,
      worktreePath: plannedWorker.worktreePath,
      createdAt: input.createdAt,
    });

    yield* orchestrationEngine.dispatch({
      type: "thread.turn.start",
      commandId: yield* serverCommandId("implementation-worker-turn"),
      threadId: workerThreadId,
      message: {
        messageId: yield* serverMessageId("implementation-worker"),
        role: "user",
        text: appendWorkflowSkillCommandSection(
          buildWorkerPrompt({
            run: input.run,
            ticketId: input.ticketId,
            workerThreadId,
            branch: plannedWorker.branch,
            worktreePath: plannedWorker.worktreePath,
            integration,
          }),
          WORKFLOW_PROMPT_IDS.implementationTddCodex,
        ),
        attachments: [],
      },
      workflowPromptId: WORKFLOW_PROMPT_IDS.implementationTddCodex,
      runtimeMode: input.orchestratorThread.runtimeMode,
      interactionMode: "implementation-workflow",
      createdAt: input.createdAt,
    });

    yield* appendActivity({
      threadId: input.run.orchestratorThreadId,
      tone: "info",
      kind: "implementation-worker-started",
      summary: `Worker started for ${input.ticketId}`,
      payload: {
        runId: input.run.id,
        ticketId: input.ticketId,
        workerThreadId,
        branch: plannedWorker.branch,
        worktreePath: plannedWorker.worktreePath,
      },
      createdAt: input.createdAt,
    });

    return {
      ...input.run,
      ticketStates: input.run.ticketStates.map((state) =>
        state.ticketId === input.ticketId
          ? {
              ...state,
              status: "running" as const,
              workerThreadId,
              branch: plannedWorker.branch,
              worktreePath: plannedWorker.worktreePath,
              updatedAt: input.createdAt,
            }
          : state,
      ),
      updatedAt: input.createdAt,
    } satisfies OrchestrationImplementationRun;
  });

  const startReadyWorkers = Effect.fn("ImplementationWorkflowReactor.startReadyWorkers")(
    function* (input: {
      readonly sourceThreadId: ThreadId;
      readonly run: OrchestrationImplementationRun;
      readonly createdAt: string;
    }) {
      const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
      const orchestratorThread = findThread(readModel, input.run.orchestratorThreadId);
      if (orchestratorThread === null) return input.run;
      if (input.run.automationHalt !== null) return input.run;

      // Passes rather than one sweep, because a skipped ticket is terminal the
      // moment it takes its branch: what waited on it becomes ready inside this
      // call and deserves to start now. Each pass strictly shrinks the set of
      // tickets that are neither started nor terminal, so this ends.
      let workingRun = input.run;
      const startResults: {
        readonly ticketId: string;
        readonly result: { readonly _tag: "Success" | "Failure"; readonly failure?: unknown };
      }[] = [];
      for (let pass = 0; pass <= input.run.ticketStates.length; pass += 1) {
        const readyTicketIds = workingRun.ticketStates
          .filter((ticketState) => ticketState.status === "ready")
          .map((ticketState) => ticketState.ticketId);
        if (readyTicketIds.length === 0) break;
        const exhaustedTicket = workingRun.ticketStates.find(
          (state) =>
            readyTicketIds.includes(state.ticketId) &&
            state.attemptCount >= IMPLEMENTATION_STAGE_MAX_LAUNCHES,
        );
        if (exhaustedTicket !== undefined) {
          return yield* blockRun({
            sourceThreadId: input.sourceThreadId,
            run: workingRun,
            ticketId: exhaustedTicket.ticketId,
            reasonMarkdown: `Ticket '${exhaustedTicket.ticketId}' exhausted its implementation launch budget.`,
            updatedAt: input.createdAt,
            haltCategory: "retry-exhausted",
            haltStage: "implementation",
          });
        }
        const allIdentities = workingRun.launchSummary.plannedWorkers;
        const identities = allIdentities.filter((worker) =>
          readyTicketIds.includes(worker.ticketId),
        );
        if (
          identities.length !== readyTicketIds.length ||
          new Set(allIdentities.map((worker) => worker.ticketId)).size !== allIdentities.length ||
          new Set(allIdentities.map((worker) => worker.branch)).size !== allIdentities.length ||
          new Set(allIdentities.map((worker) => worker.worktreePath)).size !== allIdentities.length
        ) {
          return yield* new GitCommandError({
            operation: "ImplementationWorkflowReactor.startReadyWorkers",
            command: "claim ticket worker identities",
            cwd: workingRun.orchestratorWorktreePath,
            detail: "Ready tickets must have unique ticket, branch, and worktree identities.",
          });
        }
        const workerThreadIds = new Map(
          yield* Effect.forEach(
            readyTicketIds.filter((ticketId) => !isTicketSkipped(workingRun.skips, ticketId)),
            (ticketId) =>
              serverThreadId("implementation-worker").pipe(
                Effect.map((threadId) => [ticketId, threadId] as const),
              ),
          ),
        );
        const claimedRun: OrchestrationImplementationRun = {
          ...workingRun,
          ticketStates: workingRun.ticketStates.map((state) => {
            const workerThreadId = workerThreadIds.get(state.ticketId);
            if (workerThreadId === undefined) return state;
            const identity = identities.find((worker) => worker.ticketId === state.ticketId);
            if (identity === undefined) return state;
            return {
              ...state,
              status: "running" as const,
              workerThreadId,
              branch: identity.branch,
              worktreePath: identity.worktreePath,
              attemptCount: state.attemptCount + 1,
              updatedAt: input.createdAt,
            };
          }),
          updatedAt: input.createdAt,
        };
        if (workerThreadIds.size > 0) {
          yield* updateRun({
            sourceThreadId: input.sourceThreadId,
            run: claimedRun,
            createdAt: input.createdAt,
            expectedTicketStageClaims: [...workerThreadIds.keys()].flatMap((ticketId) => {
              const state = workingRun.ticketStates.find(
                (candidate) => candidate.ticketId === ticketId,
              );
              return state === undefined
                ? []
                : [
                    {
                      ticketId: state.ticketId,
                      stage: "implementation" as const,
                      generation: state.implementationGeneration,
                      launchCount: state.attemptCount,
                      activeExecutionId: state.workerThreadId,
                    },
                  ];
            }),
          });
        }
        workingRun = claimedRun;
        const passResults = yield* Effect.forEach(
          readyTicketIds,
          (ticketId) =>
            Effect.result(
              createWorker({
                sourceThreadId: input.sourceThreadId,
                orchestratorThread,
                run: workingRun,
                ticketId,
                ownerUserId: orchestratorThread.ownerUserId,
                createdAt: input.createdAt,
              }),
            ).pipe(Effect.map((result) => ({ ticketId, result }))),
          { concurrency: "unbounded" },
        );
        startResults.push(...passResults);
        const startedRuns = passResults.flatMap(({ result }) =>
          result._tag === "Success" ? [result.success] : [],
        );
        // Whatever createWorker made of a ready ticket, not only a running one:
        // a skipped ticket comes back terminal, having taken its branch and
        // none of the work.
        const startedStates = new Map(
          startedRuns.flatMap((run) =>
            run.ticketStates
              .filter(
                (state) => state.status !== "ready" && readyTicketIds.includes(state.ticketId),
              )
              .map((state) => [state.ticketId, state] as const),
          ),
        );
        if (startedStates.size === 0) break;
        workingRun = markDependentsReady(
          {
            ...workingRun,
            ticketStates: workingRun.ticketStates.map(
              (state) => startedStates.get(state.ticketId) ?? state,
            ),
            updatedAt: input.createdAt,
          },
          input.createdAt,
        );
      }
      const nextRun = workingRun;
      if (nextRun !== input.run) {
        yield* updateRun({
          sourceThreadId: input.sourceThreadId,
          run: nextRun,
          createdAt: input.createdAt,
        });
      }

      const failedStarts = startResults.filter(({ result }) => result._tag === "Failure");
      if (failedStarts.length > 0) {
        const firstFailure = failedStarts[0];
        const failureDetail =
          firstFailure?.result._tag === "Failure"
            ? `Ticket worker setup failed: ${errorDetail(firstFailure.result.failure)}`
            : "Ticket worker setup failed for an unknown reason.";
        const failedRun: OrchestrationImplementationRun = {
          ...nextRun,
          ticketStates: nextRun.ticketStates.map((state) =>
            failedStarts.some(({ ticketId }) => ticketId === state.ticketId)
              ? {
                  ...state,
                  status: "failed" as const,
                  warningMarkdown: failureDetail,
                  updatedAt: input.createdAt,
                }
              : state,
          ),
          updatedAt: input.createdAt,
        };
        return yield* blockRun({
          sourceThreadId: input.sourceThreadId,
          run: failedRun,
          ...(firstFailure === undefined ? {} : { ticketId: firstFailure.ticketId }),
          retryableStage: "worker-setup",
          reasonMarkdown: failureDetail,
          updatedAt: input.createdAt,
          humanBlocked: structuralGitFailure(failureDetail),
        });
      }
      // Every ticket skipped leaves nothing left to run, so the run goes on to
      // integration rather than waiting for work that will never start.
      if (
        nextRun !== input.run &&
        nextRun.ticketStates.every((state) => implementationTicketStateIsTerminal(state.status))
      ) {
        yield* integrateCompletedRun({
          sourceThreadId: input.sourceThreadId,
          run: nextRun,
          createdAt: input.createdAt,
        });
      }
      return nextRun;
    },
  );

  /**
   * Applies the tier-down stamp carried by a successful ticket.
   *
   * `stop` records the scale-down request and returns without waiting for pods
   * to terminate. Keeping the stamp on the ticket lets the recovery sweep send
   * the request again after a server restart or a transient controller error.
   */
  const tierDownTicketStacks = Effect.fn("ImplementationWorkflowReactor.tierDownTicketStacks")(
    function* (input: {
      readonly run: OrchestrationImplementationRun;
      readonly createdAt: string;
    }) {
      yield* Effect.forEach(
        input.run.ticketStates,
        (state) =>
          Effect.gen(function* () {
            if (
              state.status !== "succeeded" ||
              state.appDevStackTierDownAt === null ||
              state.worktreePath === null ||
              state.worktreePath === input.run.orchestratorWorktreePath
            ) {
              return;
            }
            const lookup = yield* appDevStackManager
              .getByWorktree({ worktreePath: state.worktreePath })
              .pipe(Effect.result);
            if (lookup._tag === "Failure") {
              yield* Effect.logWarning("ticket App Dev Stack lookup failed during tier-down", {
                runId: input.run.id,
                ticketId: state.ticketId,
                cause: errorDetail(lookup.failure),
              });
              return;
            }
            const stack = lookup.success.stack;
            if (stack === null || stack.status === "stopped" || stack.status === "stopping") return;
            const stopped = yield* appDevStackManager
              .stop({ stackId: stack.id })
              .pipe(Effect.result);
            if (stopped._tag === "Failure") {
              yield* Effect.logWarning("ticket App Dev Stack tier-down failed", {
                runId: input.run.id,
                ticketId: state.ticketId,
                stackId: stack.id,
                cause: errorDetail(stopped.failure),
              });
              return;
            }
            yield* appendActivity({
              threadId: input.run.orchestratorThreadId,
              tone: "info",
              kind: "implementation-ticket-stack-tiered-down",
              summary: `Ticket ${state.ticketId} App Dev Stack tiered down`,
              payload: {
                runId: input.run.id,
                ticketId: state.ticketId,
                stackId: stack.id,
                tierDownAt: state.appDevStackTierDownAt,
              },
              createdAt: input.createdAt,
            });
          }),
        { concurrency: 4, discard: true },
      );
    },
  );

  const finishTicketReviewChain = Effect.fn(
    "ImplementationWorkflowReactor.finishTicketReviewChain",
  )(function* (input: {
    readonly sourceThreadId: ThreadId;
    readonly run: OrchestrationImplementationRun;
    readonly ticketId: string;
    readonly commitSha: string;
    readonly codeReviewOutcome: "clean" | "findings" | "blocked";
    readonly usableBranch?: boolean;
    readonly warningMarkdown: string | null;
    readonly createdAt: string;
  }) {
    const usableBranch = input.usableBranch ?? true;
    const reviewedRun: OrchestrationImplementationRun = {
      ...input.run,
      retryableFailure:
        input.run.retryableFailure?.stage === "code-review" &&
        input.run.retryableFailure.ticketId === input.ticketId
          ? null
          : input.run.retryableFailure,
      ticketStates: input.run.ticketStates.map((state) =>
        state.ticketId === input.ticketId
          ? {
              ...state,
              status: usableBranch ? ("succeeded" as const) : ("failed" as const),
              appDevStackTierDownAt: usableBranch ? input.createdAt : null,
              codeReviewOutcome: input.codeReviewOutcome,
              codeReviewThreadId: null,
              warningMarkdown: input.warningMarkdown,
              workerResult:
                usableBranch && state.workerResult?.status === "succeeded"
                  ? { ...state.workerResult, commitSha: input.commitSha }
                  : state.workerResult,
              updatedAt: input.createdAt,
            }
          : state,
      ),
      workerResults: input.run.workerResults.map((result) =>
        usableBranch && result.ticketId === input.ticketId && result.status === "succeeded"
          ? { ...result, commitSha: input.commitSha }
          : result,
      ),
      updatedAt: input.createdAt,
    };
    if (input.run.automationHalt !== null) {
      yield* updateRun({
        sourceThreadId: input.sourceThreadId,
        run: reviewedRun,
        createdAt: input.createdAt,
      });
      yield* tierDownTicketStacks({ run: reviewedRun, createdAt: input.createdAt });
      return;
    }
    const failedIds = new Set(usableBranch ? [] : [input.ticketId]);
    if (!usableBranch) {
      let changed = true;
      while (changed) {
        changed = false;
        for (const state of reviewedRun.ticketStates) {
          if (
            !failedIds.has(state.ticketId) &&
            state.dependencyTicketIds.some((ticketId) => failedIds.has(ticketId))
          ) {
            failedIds.add(state.ticketId);
            changed = true;
          }
        }
      }
    }
    const completed = usableBranch
      ? markDependentsReady(reviewedRun, input.createdAt)
      : {
          ...reviewedRun,
          ticketStates: reviewedRun.ticketStates.map((state) =>
            failedIds.has(state.ticketId)
              ? {
                  ...state,
                  status: "failed" as const,
                  warningMarkdown:
                    state.ticketId === input.ticketId
                      ? (state.warningMarkdown ?? null)
                      : `Blocked by unusable reviewed dependency '${input.ticketId}'.`,
                  updatedAt: input.createdAt,
                }
              : state,
          ),
        };
    yield* updateRun({
      sourceThreadId: input.sourceThreadId,
      run: completed,
      createdAt: input.createdAt,
    });
    yield* tierDownTicketStacks({ run: completed, createdAt: input.createdAt });
    const terminal = completed.ticketStates.every(
      (state) => state.status === "succeeded" || state.status === "failed",
    );
    if (terminal) {
      yield* integrateCompletedRun({
        sourceThreadId: input.sourceThreadId,
        run: completed,
        createdAt: input.createdAt,
      });
      return;
    }
    yield* startReadyWorkers({
      sourceThreadId: input.sourceThreadId,
      run: completed,
      createdAt: input.createdAt,
    });
  });

  const startTicketCodeReview = Effect.fn("ImplementationWorkflowReactor.startTicketCodeReview")(
    function* (input: {
      readonly sourceThreadId: ThreadId;
      readonly run: OrchestrationImplementationRun;
      readonly ticketId: string;
      readonly warningMarkdown?: string;
      readonly createdAt: string;
    }) {
      if (input.run.automationHalt !== null) return;
      const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
      const orchestratorThread = findThread(readModel, input.run.orchestratorThreadId);
      const state = input.run.ticketStates.find(
        (candidate) => candidate.ticketId === input.ticketId,
      );
      if (
        orchestratorThread === null ||
        state?.worktreePath == null ||
        state.branch == null ||
        state.workerThreadId === null ||
        state.codeReviewThreadId != null ||
        (state.status !== "app-reviewing" && state.status !== "code-reviewing")
      )
        return;
      if (
        state.codeReviewPassCount >= 1 ||
        state.codeReviewLaunchCount >= IMPLEMENTATION_STAGE_MAX_LAUNCHES
      ) {
        yield* blockRun({
          sourceThreadId: input.sourceThreadId,
          run: input.run,
          ticketId: state.ticketId,
          reasonMarkdown: `Ticket '${state.ticketId}' exhausted its Code Review budget.`,
          updatedAt: input.createdAt,
          haltCategory: "retry-exhausted",
          haltStage: "code-review",
        });
        return;
      }
      const [preflight, preflightHead] = yield* Effect.all([
        gitWorkflow.localStatus({ cwd: state.worktreePath }),
        gitWorkflow.resolveCommit({ cwd: state.worktreePath, ref: "HEAD" }),
      ]);
      const expectedHeadSha = state.workerResult?.commitSha ?? null;
      if (
        !preflight.isRepo ||
        preflight.refName !== state.branch ||
        preflight.hasWorkingTreeChanges ||
        expectedHeadSha === null ||
        preflightHead.commitSha !== expectedHeadSha
      ) {
        yield* blockRun({
          sourceThreadId: input.sourceThreadId,
          run: input.run,
          ticketId: state.ticketId,
          retryableStage: "code-review",
          reasonMarkdown: `Ticket Code Review requires clean expected HEAD '${expectedHeadSha ?? "missing"}' on '${state.branch}', but Git reports '${preflight.refName ?? "detached HEAD"}' at '${preflightHead.commitSha}'${preflight.hasWorkingTreeChanges ? " with uncommitted changes" : ""}.`,
          updatedAt: input.createdAt,
          humanBlocked: true,
        });
        return;
      }
      const workerThread = findThread(readModel, state.workerThreadId);
      const workflowContext = workerThread?.workflowContext;
      if (
        workflowContext === null ||
        workflowContext === undefined ||
        workflowContext.ticketScope.length !== 1 ||
        workflowContext.ticketScope[0] !== input.ticketId
      ) {
        return yield* new GitCommandError({
          operation: "ImplementationWorkflowReactor.startTicketCodeReview",
          command: "claim ticket workflow context",
          cwd: state.worktreePath,
          detail: `Ticket '${input.ticketId}' Code Review requires singleton ticket scope.`,
        });
      }
      // A skipped Code Review is the last stage a ticket has, so skipping it
      // ends the ticket on whatever its branch already holds.
      if (isTicketStageSkipped(input.run.skips, input.ticketId, "code-review")) {
        const head = yield* gitWorkflow.resolveCommit({ cwd: state.worktreePath, ref: "HEAD" });
        yield* finishTicketReviewChain({
          sourceThreadId: input.sourceThreadId,
          run: input.run,
          ticketId: input.ticketId,
          commitSha: head.commitSha,
          codeReviewOutcome: "clean",
          warningMarkdown: input.warningMarkdown ?? "Code Review skipped.",
          createdAt: input.createdAt,
        });
        return;
      }
      const ticket = ticketsById(
        findThread(readModel, input.sourceThreadId) ?? orchestratorThread,
      ).get(input.ticketId);
      const reviewerThreadId = yield* serverThreadId("implementation-code-reviewer");
      const reviewingRun: OrchestrationImplementationRun = {
        ...input.run,
        ticketStates: input.run.ticketStates.map((candidate) =>
          candidate.ticketId === input.ticketId
            ? {
                ...candidate,
                status: "code-reviewing" as const,
                appReviewOutcome:
                  candidate.appReviewOutcome ??
                  (input.warningMarkdown === undefined ? "skipped" : "failed"),
                codeReviewThreadId: reviewerThreadId,
                codeReviewOutcome: null,
                codeReviewLaunchCount: candidate.codeReviewLaunchCount + 1,
                warningMarkdown: input.warningMarkdown ?? candidate.warningMarkdown ?? null,
                updatedAt: input.createdAt,
              }
            : candidate,
        ),
        updatedAt: input.createdAt,
      };
      yield* updateRun({
        sourceThreadId: input.sourceThreadId,
        run: reviewingRun,
        createdAt: input.createdAt,
        expectedTicketStageClaims: [
          {
            ticketId: state.ticketId,
            stage: "code-review",
            generation: state.codeReviewGeneration,
            launchCount: state.codeReviewLaunchCount,
            activeExecutionId: state.codeReviewThreadId ?? null,
          },
        ],
      });
      yield* orchestrationEngine.dispatch({
        type: "thread.create",
        commandId: yield* serverCommandId("implementation-ticket-code-review-create"),
        threadId: reviewerThreadId,
        projectId: orchestratorThread.projectId,
        ownerUserId: orchestratorThread.ownerUserId,
        parentThreadId: state.workerThreadId ?? input.run.orchestratorThreadId,
        workflowRole: "implementation-code-reviewer",
        workflowContext,
        title: `Code review ${ticket?.title ?? input.ticketId}`,
        modelSelection: yield* modelForStep({
          workflowPromptId: WORKFLOW_PROMPT_IDS.implementationCodeReviewCodex,
          // Per-ticket reviews belong to "Execute ticket waves", so that
          // step's pin covers them unless they carry a pin of their own.
          stepWorkflowPromptId: WORKFLOW_PROMPT_IDS.implementationTddCodex,
          orchestratorThread,
          createdAt: input.createdAt,
        }),
        runtimeMode: WORKFLOW_AUTOMATION_RUNTIME_MODE,
        interactionMode: "implementation-workflow",
        branch: state.branch,
        worktreePath: state.worktreePath,
        createdAt: input.createdAt,
      });
      const baseRef =
        state.dependencyTicketIds.length === 0
          ? input.run.pinnedCommit
          : (input.run.ticketStates.find(
              (candidate) => candidate.ticketId === state.dependencyTicketIds[0],
            )?.workerResult?.commitSha ?? input.run.pinnedCommit);
      yield* orchestrationEngine.dispatch({
        type: "thread.turn.start",
        commandId: yield* serverCommandId("implementation-ticket-code-review-turn"),
        threadId: reviewerThreadId,
        message: {
          messageId: yield* serverMessageId("implementation-ticket-code-review"),
          role: "user",
          text: appendWorkflowSkillCommandSection(
            [
              `Run exactly one Code Review for ticket ${input.ticketId} in implementation run ${input.run.id}.`,
              `Worktree: ${state.worktreePath}`,
              `Branch: ${state.branch}`,
              `Review base: ${baseRef}`,
              `Retrieve the durable ticket with workflow_ticket_get. Review Standards and Spec, apply and commit clear fixes, and leave the worktree clean.`,
              input.warningMarkdown === undefined
                ? ""
                : `Earlier App Review warning:\n\n${input.warningMarkdown}`,
              `Finish with one implementation-code-review-result JSON directive containing runId ${input.run.id} and ticketId ${input.ticketId}.`,
            ].join("\n\n"),
            WORKFLOW_PROMPT_IDS.implementationCodeReviewCodex,
          ),
          attachments: [],
        },
        workflowPromptId: WORKFLOW_PROMPT_IDS.implementationCodeReviewCodex,
        runtimeMode: orchestratorThread.runtimeMode,
        interactionMode: "implementation-workflow",
        createdAt: input.createdAt,
      });
    },
  );

  const startTicketAppReview = Effect.fn("ImplementationWorkflowReactor.startTicketAppReview")(
    function* (input: {
      readonly sourceThreadId: ThreadId;
      readonly run: OrchestrationImplementationRun;
      readonly ticketId: string;
      readonly createdAt: string;
    }) {
      if (input.run.automationHalt !== null) return;
      const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
      const orchestratorThread = findThread(readModel, input.run.orchestratorThreadId);
      const sourceThread = findThread(readModel, input.sourceThreadId);
      const state = input.run.ticketStates.find(
        (candidate) => candidate.ticketId === input.ticketId,
      );
      if (
        orchestratorThread === null ||
        state?.worktreePath == null ||
        state.branch == null ||
        state.workerThreadId == null ||
        state.status !== "app-reviewing" ||
        state.appReviewWorkflowRunId != null
      )
        return;
      if (state.appReviewLaunchCount >= IMPLEMENTATION_STAGE_MAX_LAUNCHES) {
        yield* blockRun({
          sourceThreadId: input.sourceThreadId,
          run: input.run,
          ticketId: state.ticketId,
          reasonMarkdown: `Ticket '${state.ticketId}' exhausted its App Review launch budget.`,
          updatedAt: input.createdAt,
          haltCategory: "retry-exhausted",
          haltStage: "app-review",
        });
        return;
      }
      const [preflight, preflightHead] = yield* Effect.all([
        gitWorkflow.localStatus({ cwd: state.worktreePath }),
        gitWorkflow.resolveCommit({ cwd: state.worktreePath, ref: "HEAD" }),
      ]);
      const expectedHeadSha = state.workerResult?.commitSha ?? null;
      if (
        !preflight.isRepo ||
        preflight.refName !== state.branch ||
        preflight.hasWorkingTreeChanges ||
        expectedHeadSha === null ||
        preflightHead.commitSha !== expectedHeadSha
      ) {
        yield* blockRun({
          sourceThreadId: input.sourceThreadId,
          run: input.run,
          ticketId: state.ticketId,
          retryableStage: "app-review",
          reasonMarkdown: `Ticket App Review requires clean expected HEAD '${expectedHeadSha ?? "missing"}' on '${state.branch}', but Git reports '${preflight.refName ?? "detached HEAD"}' at '${preflightHead.commitSha}'${preflight.hasWorkingTreeChanges ? " with uncommitted changes" : ""}.`,
          updatedAt: input.createdAt,
          humanBlocked: true,
        });
        return;
      }
      const ticket = ticketsById(sourceThread ?? orchestratorThread).get(input.ticketId);
      if (ticket === undefined) return;
      // A skip reads the same way as a ticket the plan never made eligible: the
      // stage does not run and the ticket carries on to the next one.
      if (
        isTicketStageSkipped(input.run.skips, input.ticketId, "app-review") ||
        ticket.appReviewEligible !== true ||
        !ticket.appReviewPlanMarkdown
      ) {
        yield* startTicketCodeReview({
          sourceThreadId: input.sourceThreadId,
          run: input.run,
          ticketId: input.ticketId,
          createdAt: input.createdAt,
        });
        return;
      }
      // Settings can turn a review part off outright. When the intersection
      // with the ticket's own scope leaves nothing, the review is skipped and
      // says so, rather than launching a run with nothing to verify.
      const settings = yield* serverSettingsService.getSettings.pipe(
        Effect.orElseSucceed(() => undefined),
      );
      const allowedParts = intersectAppReviewParts(
        resolveLayeredAppReviewStepParts({
          threadOverrides: findWorkflowStepReviewParts(orchestratorThread, readModel.threads),
          settingsOverrides: settings?.workflowStepReviewParts,
          key: {
            workflowPromptId: WORKFLOW_PROMPT_IDS.implementationBrowserAppReviewCodex,
            stepWorkflowPromptId: WORKFLOW_PROMPT_IDS.implementationTddCodex,
          },
        }),
        appReviewPartsForScope(ticket.appReviewScope ?? "both"),
      );
      if (appReviewScopeForParts(allowedParts) === null) {
        yield* startTicketCodeReview({
          sourceThreadId: input.sourceThreadId,
          run: input.run,
          ticketId: input.ticketId,
          warningMarkdown: `Ticket App Review skipped: turned off in Settings → Workflows (${describeAppReviewParts(allowedParts)}).`,
          createdAt: input.createdAt,
        });
        return;
      }
      const stackResult = yield* appDevStackManager
        .autoCreate({
          worktreePath: state.worktreePath,
          displayName: `Ticket ${ticket.key ?? ticket.id}`,
          gitBranch: state.branch ?? input.run.orchestratorBranch,
          workflowId: orchestratorThread.workflowContext?.workflowId,
        })
        .pipe(Effect.result);
      const frontendUrl = stackResult._tag === "Success" ? stackResult.success.frontendUrl : null;
      if (frontendUrl === null) {
        const warning = `Ticket App Review failed because its App Dev Stack did not provide a frontend URL${stackResult._tag === "Failure" ? `: ${errorDetail(stackResult.failure)}` : "."}`;
        yield* startTicketCodeReview({
          sourceThreadId: input.sourceThreadId,
          run: input.run,
          ticketId: input.ticketId,
          warningMarkdown: warning,
          createdAt: input.createdAt,
        });
        return;
      }
      const controllerThreadId = yield* serverThreadId("app-review-orchestrator");
      const appReviewWorkflowRunId = AppReviewWorkflowRunId.make(
        `app-review-workflow-${controllerThreadId}`,
      );
      const claimedRun: OrchestrationImplementationRun = {
        ...input.run,
        ticketStates: input.run.ticketStates.map((candidate) =>
          candidate.ticketId === input.ticketId
            ? {
                ...candidate,
                appReviewWorkflowRunId,
                appReviewLaunchCount: candidate.appReviewLaunchCount + 1,
                updatedAt: input.createdAt,
              }
            : candidate,
        ),
        updatedAt: input.createdAt,
      };
      yield* updateRun({
        sourceThreadId: input.sourceThreadId,
        run: claimedRun,
        createdAt: input.createdAt,
        expectedTicketStageClaims: [
          {
            ticketId: state.ticketId,
            stage: "app-review",
            generation: state.appReviewGeneration,
            launchCount: state.appReviewLaunchCount,
            activeExecutionId: state.appReviewWorkflowRunId ?? null,
          },
        ],
      });
      yield* orchestrationEngine.dispatch({
        type: "thread.app-review-workflow.launch",
        commandId: yield* serverCommandId("implementation-ticket-app-review-launch"),
        targetThreadId: state.workerThreadId,
        controllerThreadId,
        caller: {
          type: "implementation",
          implementationRunId: input.run.id,
          orchestratorThreadId: input.run.orchestratorThreadId,
          ticketId: input.ticketId,
        },
        briefMarkdown: ticket.appReviewPlanMarkdown,
        supportingContextMarkdown: `Review only ticket ${input.ticketId}: ${ticket.title}. Treat its attached plan and acceptance criteria as authoritative.`,
        previewTargets: [frontendUrl],
        ...(ticket.appReviewScope === undefined ? {} : { appReviewScope: ticket.appReviewScope }),
        cycleBudget: AppReviewWorkflowCycleBudget.make(
          yield* cyclesForStep({
            key: {
              workflowPromptId: WORKFLOW_PROMPT_IDS.implementationBrowserAppReviewCodex,
              stepWorkflowPromptId: WORKFLOW_PROMPT_IDS.implementationTddCodex,
            },
            orchestratorThread,
          }),
        ),
        modelSelection: yield* modelForStep({
          workflowPromptId: WORKFLOW_PROMPT_IDS.implementationBrowserAppReviewCodex,
          // Per-ticket reviews belong to "Execute ticket waves", so that
          // step's pin covers them unless they carry a pin of their own.
          stepWorkflowPromptId: WORKFLOW_PROMPT_IDS.implementationTddCodex,
          orchestratorThread,
          createdAt: input.createdAt,
        }),
        createdAt: input.createdAt,
      });
    },
  );

  const startMergeGate = Effect.fn("ImplementationWorkflowReactor.startMergeGate")(
    function* (input: {
      readonly sourceThreadId: ThreadId;
      readonly run: OrchestrationImplementationRun;
      readonly integration: BranchIntegration;
      readonly kind: "integration" | "final";
      readonly preserveCodeReviewedHead?: boolean;
      readonly createdAt: string;
    }) {
      if (input.run.automationHalt !== null) return;
      const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
      const orchestratorThread = findThread(readModel, input.run.orchestratorThreadId);
      if (orchestratorThread === null) return;
      const activeValidator =
        input.run.activeValidatorThreadId === null
          ? undefined
          : readModel.threads.find(
              (thread) =>
                thread.id === input.run.activeValidatorThreadId && thread.deletedAt === null,
            );
      if (activeValidator !== undefined) return;

      const validatorThreadId =
        input.run.activeValidatorThreadId ?? (yield* serverThreadId("implementation-validator"));
      const validationHead = yield* gitWorkflow.resolveCommit({
        cwd: input.run.orchestratorWorktreePath,
        ref: "HEAD",
      });
      const validationStatus = yield* gitWorkflow.localStatus({
        cwd: input.run.orchestratorWorktreePath,
      });
      const expectedValidationHead =
        input.kind === "final" ? input.run.codeReviewedHeadSha : input.run.integrationHeadSha;
      if (
        !validationStatus.isRepo ||
        validationStatus.refName !== input.run.orchestratorBranch ||
        validationStatus.hasWorkingTreeChanges ||
        (expectedValidationHead !== null && expectedValidationHead !== validationHead.commitSha)
      ) {
        yield* blockRun({
          sourceThreadId: input.sourceThreadId,
          run: input.run,
          retryableStage: "merge-gate",
          reasonMarkdown: `${input.kind === "final" ? "Final validation" : "Merge Gate"} requires clean expected HEAD '${expectedValidationHead ?? validationHead.commitSha}' on '${input.run.orchestratorBranch}', but Git reports '${validationStatus.refName ?? "detached HEAD"}' at '${validationHead.commitSha}'${validationStatus.hasWorkingTreeChanges ? " with uncommitted changes" : ""}.`,
          updatedAt: input.createdAt,
          humanBlocked: true,
        });
        return;
      }
      const validatingRun: OrchestrationImplementationRun = {
        ...input.run,
        status: "validating",
        activeValidationHeadSha: validationHead.commitSha,
        activeValidationKind: input.kind,
        activeValidatorThreadId: validatorThreadId,
        mergeGateAttemptCount: input.run.mergeGateAttemptCount + 1,
        validatedHeadSha: null,
        ...(input.kind === "integration"
          ? {
              appReviewedHeadSha: null,
              activeAppReviewHeadSha: null,
              activeAppReviewThreadId: null,
              codeReviewedHeadSha: input.preserveCodeReviewedHead
                ? input.run.codeReviewedHeadSha
                : null,
              activeCodeReviewHeadSha: null,
              activeCodeReviewThreadId: null,
            }
          : {}),
        changeRequest: null,
        changeRequestFailure: null,
        updatedAt: input.createdAt,
      };
      yield* updateRun({
        sourceThreadId: input.sourceThreadId,
        run: validatingRun,
        createdAt: input.createdAt,
      });

      yield* orchestrationEngine.dispatch({
        type: "thread.create",
        commandId: yield* serverCommandId("implementation-validator-create"),
        threadId: validatorThreadId,
        projectId: orchestratorThread.projectId,
        ownerUserId: orchestratorThread.ownerUserId,
        parentThreadId: input.run.orchestratorThreadId,
        workflowRole: "implementation-validator",
        title:
          input.kind === "final" ? "Implementation final validation" : "Implementation merge gate",
        modelSelection: yield* modelForStep({
          workflowPromptId: WORKFLOW_PROMPT_IDS.implementationMergeGateCodex,
          orchestratorThread,
          createdAt: input.createdAt,
        }),
        runtimeMode: WORKFLOW_AUTOMATION_RUNTIME_MODE,
        interactionMode: "implementation-workflow",
        branch: input.run.orchestratorBranch,
        worktreePath: input.run.orchestratorWorktreePath,
        createdAt: input.createdAt,
      });

      yield* orchestrationEngine.dispatch({
        type: "thread.turn.start",
        commandId: yield* serverCommandId("implementation-validator-turn"),
        threadId: validatorThreadId,
        message: {
          messageId: yield* serverMessageId("implementation-validator"),
          role: "user",
          text: appendWorkflowSkillCommandSection(
            buildMergeGatePrompt({
              run: input.run,
              integration: input.integration,
              kind: input.kind,
            }),
            WORKFLOW_PROMPT_IDS.implementationMergeGateCodex,
          ),
          attachments: [],
        },
        workflowPromptId: WORKFLOW_PROMPT_IDS.implementationMergeGateCodex,
        runtimeMode: orchestratorThread.runtimeMode,
        interactionMode: "implementation-workflow",
        createdAt: input.createdAt,
      });

      yield* appendActivity({
        threadId: input.run.orchestratorThreadId,
        tone: "info",
        kind: "implementation-merge-gate-started",
        summary: input.kind === "final" ? "Final validation started" : "Merge gate started",
        payload: { runId: input.run.id, validatorThreadId, kind: input.kind },
        createdAt: input.createdAt,
      });
    },
  );

  const verifyIntegratedWorkerCommits = Effect.fn(
    "ImplementationWorkflowReactor.verifyIntegratedWorkerCommits",
  )(function* (run: OrchestrationImplementationRun) {
    const head = yield* gitWorkflow.resolveCommit({
      cwd: run.orchestratorWorktreePath,
      ref: "HEAD",
    });
    // Failed tickets are terminal warnings, not integration blockers. Only branches that survived
    // implementation and ticket Code Review are candidates for the combined change.
    for (const state of run.ticketStates.filter((candidate) => candidate.status === "succeeded")) {
      if (state.workerResult?.status !== "succeeded") continue;
      const accepted = yield* verifiedDependency({ run, ticketId: state.ticketId });
      const integrated = yield* gitWorkflow.isAncestor({
        cwd: run.orchestratorWorktreePath,
        ancestorRef: accepted.commitSha,
        descendantRef: head.commitSha,
      });
      if (!integrated) {
        return yield* new GitCommandError({
          operation: "ImplementationWorkflowReactor.verifyIntegratedWorkerCommits",
          command: "git merge-base --is-ancestor",
          cwd: run.orchestratorWorktreePath,
          detail: `Integrated HEAD '${head.commitSha}' does not contain ticket '${state.ticketId}' at '${accepted.commitSha}'.`,
        });
      }
    }
    return head.commitSha;
  });

  const integrateCompletedRun = Effect.fn("ImplementationWorkflowReactor.integrateCompletedRun")(
    function* (input: {
      readonly sourceThreadId: ThreadId;
      readonly run: OrchestrationImplementationRun;
      readonly createdAt: string;
    }) {
      if (input.run.automationHalt !== null) return;
      const integratingRun: OrchestrationImplementationRun = {
        ...input.run,
        status: "integrating",
        updatedAt: input.createdAt,
      };
      yield* updateRun({
        sourceThreadId: input.sourceThreadId,
        run: integratingRun,
        createdAt: input.createdAt,
      });

      const terminalIds = terminalLineageTicketIds(integratingRun);
      // Both git checks around the merge fail the same way and need the same
      // landing: a branch that moved under the run is not something a second
      // integration attempt can fix, and an unhandled failure here aborts the
      // reactor's event, which parks the run in `integrating` with nothing on
      // screen, no Retry, and no sweep that re-drives it.
      const blockIntegration = (detail: string) =>
        blockRun({
          sourceThreadId: input.sourceThreadId,
          run: integratingRun,
          retryableStage: "integration" as const,
          humanBlocked: true,
          reasonMarkdown: detail,
          updatedAt: input.createdAt,
        });
      const terminalBranchesResult = yield* Effect.forEach(terminalIds, (ticketId) =>
        verifiedDependency({ run: integratingRun, ticketId }),
      ).pipe(Effect.result);
      if (terminalBranchesResult._tag === "Failure") {
        yield* blockIntegration(
          `Terminal branch resolution failed: ${errorDetail(terminalBranchesResult.failure)}`,
        );
        return;
      }
      const terminalBranches = terminalBranchesResult.success;
      const integrationResult = yield* integrateRefs({
        cwd: integratingRun.orchestratorWorktreePath,
        baseTicketId: null,
        baseRefName: integratingRun.orchestratorBranch,
        refs: terminalBranches.map((terminal) => ({
          ticketId: terminal.ticketId,
          refName: terminal.commitSha,
        })),
      }).pipe(Effect.result);
      if (integrationResult._tag === "Failure") {
        const detail = `Ticket integration failed: ${errorDetail(integrationResult.failure)}`;
        const head = yield* gitWorkflow.resolveCommit({
          cwd: integratingRun.orchestratorWorktreePath,
          ref: "HEAD",
        });
        const continuedRun: OrchestrationImplementationRun = {
          ...integratingRun,
          integrationHeadSha: head.commitSha,
          reviewGateExhaustedAt: input.createdAt,
          reviewGateExhaustionReason: detail,
          retryableFailure: null,
          updatedAt: input.createdAt,
        };
        yield* updateRun({
          sourceThreadId: input.sourceThreadId,
          run: continuedRun,
          createdAt: input.createdAt,
        });
        yield* appendActivity({
          threadId: integratingRun.orchestratorThreadId,
          tone: "error",
          kind: "implementation-integration-warning",
          summary: "Ticket integration failed; reviews are continuing from the usable HEAD",
          payload: { runId: integratingRun.id, detail },
          createdAt: input.createdAt,
        });
        yield* startFixer({
          sourceThreadId: input.sourceThreadId,
          run: continuedRun,
          status: "fixing",
          origin: "merge-gate",
          title: "Fix terminal branch integration",
          promptText: buildMergeGateFixPrompt({
            run: continuedRun,
            reportMarkdown: detail,
          }),
          createdAt: input.createdAt,
        });
        return;
      }
      const integration = integrationResult.success;

      yield* appendActivity({
        threadId: integratingRun.orchestratorThreadId,
        tone: integration.conflictedTicketId === null ? "info" : "error",
        kind: "implementation-terminal-branches-integrated",
        summary:
          integration.conflictedTicketId === null
            ? "Terminal worker branches integrated"
            : "Terminal branch merge needs resolution",
        payload: { runId: integratingRun.id, terminalTicketIds: terminalIds, ...integration },
        createdAt: input.createdAt,
      });

      const verified =
        integration.conflictedTicketId === null
          ? yield* verifyIntegratedWorkerCommits(integratingRun).pipe(Effect.result)
          : null;
      if (verified !== null && verified._tag === "Failure") {
        yield* blockIntegration(
          `Integration verification failed: ${errorDetail(verified.failure)}`,
        );
        return;
      }
      const integrationHeadSha = verified === null ? null : verified.success;
      const integratedRun: OrchestrationImplementationRun = {
        ...integratingRun,
        integrationHeadSha,
        retryableFailure: null,
        updatedAt: input.createdAt,
      };
      yield* updateRun({
        sourceThreadId: input.sourceThreadId,
        run: integratedRun,
        createdAt: input.createdAt,
      });

      yield* startMergeGate({
        sourceThreadId: input.sourceThreadId,
        run: integratedRun,
        integration,
        kind: "integration",
        createdAt: input.createdAt,
      });
    },
  );

  const startBrowserReview = Effect.fn("ImplementationWorkflowReactor.startBrowserReview")(
    function* (input: {
      readonly sourceThreadId: ThreadId;
      readonly run: OrchestrationImplementationRun;
      readonly createdAt: string;
    }) {
      if (input.run.automationHalt !== null) return;
      const cycleRun = input.run;
      const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
      const orchestratorThread = findThread(readModel, cycleRun.orchestratorThreadId);
      if (orchestratorThread === null) return;
      const continueWithoutBrowserReview = Effect.fn(
        "ImplementationWorkflowReactor.continueWithoutBrowserReview",
      )(function* (run: OrchestrationImplementationRun) {
        if (run.integrationHeadSha !== null && run.codeReviewedHeadSha === run.integrationHeadSha) {
          yield* startMergeGate({
            sourceThreadId: input.sourceThreadId,
            run,
            integration: {
              baseTicketId: null,
              baseRefName: run.orchestratorBranch,
              mergedTicketIds: [],
              conflictedTicketId: null,
              conflictedRefName: null,
              conflictedFiles: [],
              remainingTicketIds: [],
              remainingRefNames: [],
            },
            kind: "final",
            createdAt: input.createdAt,
          });
          return;
        }
        yield* startCodeReview({
          sourceThreadId: input.sourceThreadId,
          run,
          createdAt: input.createdAt,
          skipAppReviewRequirement: true,
        });
      });
      // A skipped App Review still preserves the gate order. Unreviewed work goes to Code Review,
      // while a HEAD that Code Review already accepted goes to final validation.
      if (isRunStageSkipped(cycleRun.skips, "app-review")) {
        yield* continueWithoutBrowserReview(cycleRun);
        return;
      }
      const artifactSourceThread = findThread(readModel, input.sourceThreadId);
      const artifactMarkdown =
        cycleRun.artifactSource === "proposed-plan" && artifactSourceThread !== null
          ? fastFeatureArtifactMarkdown({ run: cycleRun, sourceThread: artifactSourceThread })
          : undefined;
      const activeNestedAppReview =
        cycleRun.appReviewStrategy === "nested-workflow"
          ? (readModel.appReviewWorkflowRuns ?? []).find(
              (candidate) =>
                candidate.caller.type === "implementation" &&
                candidate.caller.implementationRunId === cycleRun.id &&
                candidate.status === "running",
            )
          : undefined;
      if (activeNestedAppReview !== undefined && activeNestedAppReview.activePhase !== null) {
        return;
      }

      const ensuringRun: OrchestrationImplementationRun = {
        ...cycleRun,
        status: "qa-reviewing",
        appDevStack: {
          ...cycleRun.appDevStack,
          status: "ensuring",
          requestedAt: cycleRun.appDevStack.requestedAt || input.createdAt,
          updatedAt: input.createdAt,
        },
        updatedAt: input.createdAt,
      };

      // Planning, Full Feature, or Fast Feature owns stack creation during workspace bootstrap.
      // Implementation may re-ensure that exact registered stack after integration or repair, but
      // it must never silently manufacture a second runtime when the inherited one is missing.
      const inheritedLookup = yield* appDevStackManager
        .getByWorktree({ worktreePath: cycleRun.orchestratorWorktreePath })
        .pipe(Effect.result);
      const inheritedStackMissing =
        inheritedLookup._tag === "Success" && inheritedLookup.success.stack === null;
      const stackResult =
        inheritedLookup._tag === "Failure" || inheritedStackMissing
          ? null
          : yield* appDevStackManager
              .autoCreate({
                worktreePath: cycleRun.orchestratorWorktreePath,
                displayName:
                  cycleRun.artifactSource === "proposed-plan"
                    ? `Fast feature ${cycleRun.id}`
                    : `Implementation ${cycleRun.id}`,
                gitBranch: cycleRun.orchestratorBranch,
                workflowId: orchestratorThread.workflowContext?.workflowId,
              })
              .pipe(Effect.result);

      const stackFailureDetail =
        inheritedLookup._tag === "Failure"
          ? errorDetail(inheritedLookup.failure)
          : inheritedStackMissing
            ? `The workflow-owned App Dev Stack is missing for '${cycleRun.orchestratorWorktreePath}'. Planning, Full Feature, or Fast Feature must create it after workspace dependency setup; Implementation will not create a replacement.`
            : stackResult?._tag === "Failure"
              ? errorDetail(stackResult.failure)
              : null;
      const stack = stackResult?._tag === "Success" ? stackResult.success : null;
      if (stackFailureDetail !== null) {
        const infrastructureBlocked =
          inheritedStackMissing || isAppDevStackInfrastructureFailure(stackFailureDetail);
        const diagnostics = yield* appDevStackDiagnostics({
          run: ensuringRun,
          stackId: ensuringRun.appDevStack.stackId,
          detail: stackFailureDetail,
        });
        const headSha = yield* resolveQaHeadSha(ensuringRun);
        const blocked = yield* blockRun({
          sourceThreadId: input.sourceThreadId,
          run: {
            ...ensuringRun,
            appDevStack: {
              ...ensuringRun.appDevStack,
              status: "failed",
              lastErrorMarkdown: stackFailureDetail,
              updatedAt: input.createdAt,
            },
            lastQaFailure: {
              kind: "app-dev-stack",
              status: "provisioning-failed",
              detailMarkdown: diagnostics,
              reviewId: null,
              headSha,
              occurredAt: input.createdAt,
            },
          },
          retryableStage: "app-dev-stack",
          automaticRecovery: !infrastructureBlocked,
          humanBlocked: infrastructureBlocked,
          reasonMarkdown: diagnostics,
          updatedAt: input.createdAt,
        });
        if (!infrastructureBlocked) {
          yield* requestRunRetry({
            sourceThreadId: input.sourceThreadId,
            runId: blocked.id,
            createdAt: input.createdAt,
          });
        }
        return;
      }
      const frontendUrl = stack?.frontendUrl ?? null;

      // App Review is a browser session against `frontendUrl`. Launching one before the stack is
      // actually running only produces a reviewer that correctly reports "no available server",
      // burning an App Review cycle on an infrastructure problem it cannot fix. Blocking on the
      // retryable `app-dev-stack` stage gives the stack the sweep's retries to finish coming up,
      // then surfaces it as a stack failure instead of a review failure.
      const pendingStackStatus =
        stack !== null && stack.stack !== null && stack.stack.status !== "running"
          ? stack.stack.status
          : null;
      const failedService = stack?.stack?.services?.find(
        (service) =>
          (service.error !== null && service.error !== undefined) ||
          service.health === "unhealthy" ||
          service.status === "error" ||
          service.status === "stopped",
      );
      if (frontendUrl === null || pendingStackStatus !== null || failedService !== undefined) {
        const detail =
          failedService !== undefined
            ? `service '${failedService.name}' is unhealthy (${failedService.error ?? failedService.health ?? failedService.status})`
            : frontendUrl === null
              ? "the controller returned no frontend URL"
              : `the stack is '${pendingStackStatus}', not 'running'`;
        const stackId = stack?.stack?.id ?? ensuringRun.appDevStack.stackId;
        const transitioning =
          failedService === undefined &&
          (pendingStackStatus === "pending" || pendingStackStatus === "starting");
        const diagnostics = yield* appDevStackDiagnostics({
          run: ensuringRun,
          stackId,
          detail,
        });
        const headSha = yield* resolveQaHeadSha(ensuringRun);
        const blocked = yield* blockRun({
          sourceThreadId: input.sourceThreadId,
          run: {
            ...ensuringRun,
            appDevStack: {
              ...ensuringRun.appDevStack,
              ...(stack === null
                ? {}
                : {
                    stackId: stack.stack?.id ?? null,
                    stackStatus: stack.stack?.status ?? null,
                    frontendUrl,
                    frontendServiceName: stack.frontendServiceName,
                    displayName: stack.stack?.displayName ?? null,
                  }),
              status: "ensuring",
              updatedAt: input.createdAt,
            },
            lastQaFailure: transitioning
              ? null
              : {
                  kind: "app-dev-stack",
                  status: pendingStackStatus ?? "missing-frontend-url",
                  detailMarkdown: diagnostics,
                  reviewId: null,
                  headSha,
                  occurredAt: input.createdAt,
                },
          },
          retryableStage: "app-dev-stack",
          automaticRecovery: true,
          automaticRecoveryWaiting: transitioning,
          reasonMarkdown: diagnostics,
          updatedAt: input.createdAt,
        });
        if (!transitioning) {
          yield* requestRunRetry({
            sourceThreadId: input.sourceThreadId,
            runId: blocked.id,
            createdAt: input.createdAt,
          });
        }
        return;
      }

      // The controller's own status is a claim about the stack, not about the edge. The frontend
      // can keep serving its static shell while its backend has no ready pod, so probing only `/`
      // sends reviewers into a login flow that can only return 502. Probe both surfaces on the
      // cached path too; a failed runtime probe is routed through AppDevStack diagnostics and TDD
      // repair before another Browser App Review is launched.
      if (frontendUrl !== null) {
        const probes = [
          { label: "frontend", url: frontendUrl },
          { label: "backend health", url: appDevStackBackendHealthUrl(frontendUrl) },
        ];
        let failedProbe: {
          readonly label: string;
          readonly url: string;
          readonly detail: string;
        } | null = null;
        for (const probe of probes) {
          const serving = yield* probeFrontend(probe.url);
          if (!serving.ok) {
            failedProbe = { ...probe, detail: serving.detail };
            break;
          }
        }
        if (failedProbe !== null) {
          const detail = `${failedProbe.label} ${failedProbe.url} ${failedProbe.detail}`;
          const diagnostics = yield* appDevStackDiagnostics({
            run: ensuringRun,
            stackId: stack?.stack?.id ?? ensuringRun.appDevStack.stackId,
            detail,
          });
          const headSha = yield* resolveQaHeadSha(ensuringRun);
          const blocked = yield* blockRun({
            sourceThreadId: input.sourceThreadId,
            run: {
              ...ensuringRun,
              appDevStack: {
                ...ensuringRun.appDevStack,
                status: "ensuring",
                lastErrorMarkdown: failedProbe.detail,
                updatedAt: input.createdAt,
              },
              lastQaFailure: {
                kind: "app-dev-stack",
                status:
                  failedProbe.label === "frontend" ? "frontend-unreachable" : "backend-unreachable",
                detailMarkdown: diagnostics,
                reviewId: null,
                headSha,
                occurredAt: input.createdAt,
              },
            },
            retryableStage: "app-dev-stack",
            automaticRecovery: true,
            reasonMarkdown: diagnostics,
            updatedAt: input.createdAt,
          });
          yield* requestRunRetry({
            sourceThreadId: input.sourceThreadId,
            runId: blocked.id,
            createdAt: input.createdAt,
          });
          return;
        }
      }

      const reviewHead = yield* gitWorkflow.resolveCommit({
        cwd: cycleRun.orchestratorWorktreePath,
        ref: "HEAD",
      });
      const reviewStatus = yield* gitWorkflow.localStatus({
        cwd: input.run.orchestratorWorktreePath,
      });
      if (
        !reviewStatus.isRepo ||
        reviewStatus.refName !== input.run.orchestratorBranch ||
        reviewStatus.hasWorkingTreeChanges
      ) {
        yield* blockRun({
          sourceThreadId: input.sourceThreadId,
          run: input.run,
          retryableStage: "app-review",
          reasonMarkdown: `App Review requires a clean worktree on '${input.run.orchestratorBranch}', but Git reports '${reviewStatus.refName ?? "detached HEAD"}'${reviewStatus.hasWorkingTreeChanges ? " with uncommitted changes" : ""}.`,
          updatedAt: input.createdAt,
          humanBlocked: true,
        });
        return;
      }
      if (
        cycleRun.integrationHeadSha === null ||
        cycleRun.integrationHeadSha !== reviewHead.commitSha
      ) {
        yield* blockRun({
          sourceThreadId: input.sourceThreadId,
          run: cycleRun,
          retryableStage: "app-review",
          reasonMarkdown: `App Review requires the current integrated orchestrator HEAD '${reviewHead.commitSha}', but the recorded integrated HEAD is '${cycleRun.integrationHeadSha ?? "missing"}'.`,
          updatedAt: input.createdAt,
        });
        return;
      }

      if (cycleRun.appReviewStrategy === "nested-workflow") {
        const readyRun: OrchestrationImplementationRun = {
          ...ensuringRun,
          appDevStack:
            stack === null
              ? ensuringRun.appDevStack
              : {
                  status: appDevStackReadiness(stack),
                  stackId: stack.stack?.id ?? null,
                  stackStatus: stack.stack?.status ?? null,
                  frontendUrl,
                  frontendServiceName: stack.frontendServiceName,
                  displayName: stack.stack?.displayName ?? null,
                  lastErrorMarkdown: null,
                  requestedAt: ensuringRun.appDevStack.requestedAt || input.createdAt,
                  updatedAt: input.createdAt,
                },
          integrationHeadSha: reviewHead.commitSha,
          retryableFailure: ensuringRun.retryableFailure,
          updatedAt: input.createdAt,
        };
        if (activeNestedAppReview !== undefined) {
          yield* updateRun({
            sourceThreadId: input.sourceThreadId,
            run: readyRun,
            createdAt: input.createdAt,
          });
          yield* orchestrationEngine.dispatch({
            type: "thread.app-review-workflow.resume",
            commandId: yield* serverCommandId("implementation-app-review-preview-refresh"),
            threadId: activeNestedAppReview.controllerThreadId,
            runId: activeNestedAppReview.id,
            previewTargets: [frontendUrl],
            workspaceRevision: activeNestedAppReview.workspaceRevision,
            createdAt: input.createdAt,
          });
          return;
        }
        // The combined review is also switchable in Settings → Workflows.
        // With both parts off it skips like an explicit stage skip: the
        // integrated change goes straight to the Code Review that follows.
        const combinedSettings = yield* serverSettingsService.getSettings.pipe(
          Effect.orElseSucceed(() => undefined),
        );
        const combinedParts = resolveLayeredAppReviewStepParts({
          threadOverrides: findWorkflowStepReviewParts(orchestratorThread, readModel.threads),
          settingsOverrides: combinedSettings?.workflowStepReviewParts,
          key: { workflowPromptId: WORKFLOW_PROMPT_IDS.implementationBrowserAppReviewCodex },
        });
        if (appReviewScopeForParts(combinedParts) === null) {
          yield* continueWithoutBrowserReview(readyRun);
          return;
        }
        yield* updateRun({
          sourceThreadId: input.sourceThreadId,
          run: readyRun,
          createdAt: input.createdAt,
        });
        const controllerThreadId = yield* serverThreadId("app-review-orchestrator");
        yield* orchestrationEngine.dispatch({
          type: "thread.app-review-workflow.launch",
          commandId: yield* serverCommandId("implementation-app-review-workflow-launch"),
          targetThreadId: cycleRun.orchestratorThreadId,
          controllerThreadId,
          caller: {
            type: "implementation",
            implementationRunId: cycleRun.id,
            orchestratorThreadId: cycleRun.orchestratorThreadId,
          },
          briefMarkdown:
            artifactMarkdown ??
            `Verify Implementation run '${cycleRun.id}' against its complete Spec and Planning Tickets. Treat every acceptance criterion as required.`,
          supportingContextMarkdown: buildBrowserAppReviewPrompt({
            run: readyRun,
            frontendUrl,
            ...(artifactMarkdown === undefined ? {} : { artifactMarkdown }),
          }),
          previewTargets: [frontendUrl],
          cycleBudget: AppReviewWorkflowCycleBudget.make(
            yield* cyclesForStep({
              key: {
                workflowPromptId: WORKFLOW_PROMPT_IDS.implementationBrowserAppReviewCodex,
              },
              orchestratorThread,
              fallbackCycles: Math.min(
                IMPLEMENTATION_RUN_MAX_QA_REPAIRS,
                Math.max(1, cycleRun.launchSummary.finalAppReview.maxCycles),
              ),
            }),
          ),
          modelSelection: yield* modelForStep({
            workflowPromptId: WORKFLOW_PROMPT_IDS.implementationBrowserAppReviewCodex,
            orchestratorThread,
            createdAt: input.createdAt,
          }),
          createdAt: input.createdAt,
        });
        return;
      }

      const reviewId = yield* serverAppReviewId();
      const reviewThreadId = yield* serverThreadId("implementation-qa-reviewer");
      const reviewRun: OrchestrationImplementationRun = {
        ...ensuringRun,
        appDevStack:
          stack === null
            ? ensuringRun.appDevStack
            : {
                status: appDevStackReadiness(stack),
                stackId: stack.stack?.id ?? null,
                stackStatus: stack.stack?.status ?? null,
                frontendUrl,
                frontendServiceName: stack.frontendServiceName,
                displayName: stack.stack?.displayName ?? null,
                lastErrorMarkdown: null,
                requestedAt: ensuringRun.appDevStack.requestedAt || input.createdAt,
                updatedAt: input.createdAt,
              },
        appReviewIds: [...ensuringRun.appReviewIds, reviewId],
        activeAppReviewHeadSha: reviewHead.commitSha,
        activeAppReviewThreadId: reviewThreadId,
        qaAttemptCount: ensuringRun.qaAttemptCount + 1,
        lastQaFailure: null,
        retryableFailure: ensuringRun.retryableFailure,
        updatedAt: input.createdAt,
      };

      yield* updateRun({
        sourceThreadId: input.sourceThreadId,
        run: reviewRun,
        createdAt: input.createdAt,
      });

      const reviewModelSelection = yield* modelForStep({
        workflowPromptId: WORKFLOW_PROMPT_IDS.implementationBrowserAppReviewCodex,
        orchestratorThread,
        createdAt: input.createdAt,
      });

      yield* orchestrationEngine.dispatch({
        type: "thread.app-review.launch",
        commandId: yield* serverCommandId("implementation-browser-review-launch"),
        sourceThreadId: cycleRun.orchestratorThreadId,
        reviewThreadId,
        reviewId,
        planningTicketIds: [...cycleRun.planningTicketIds],
        message: {
          messageId: yield* serverMessageId("implementation-browser-review"),
          role: "user",
          text: appendWorkflowSkillCommandSection(
            buildBrowserAppReviewPrompt({
              run: reviewRun,
              frontendUrl,
              ...(artifactMarkdown === undefined ? {} : { artifactMarkdown }),
            }),
            WORKFLOW_PROMPT_IDS.implementationBrowserAppReviewCodex,
          ),
          attachments: [],
        },
        modelSelection: reviewModelSelection,
        runtimeMode: orchestratorThread.runtimeMode,
        workflowPromptId: WORKFLOW_PROMPT_IDS.implementationBrowserAppReviewCodex,
        createdAt: input.createdAt,
      });

      yield* appendActivity({
        threadId: cycleRun.orchestratorThreadId,
        tone: "info",
        kind: "implementation-browser-review-started",
        summary: `Browser app review started (attempt ${reviewRun.qaAttemptCount})`,
        payload: {
          runId: cycleRun.id,
          reviewId,
          reviewThreadId,
          attempt: reviewRun.qaAttemptCount,
          frontendUrl,
        },
        createdAt: input.createdAt,
      });
    },
  );

  const startCodeReview = Effect.fn("ImplementationWorkflowReactor.startCodeReview")(
    function* (input: {
      readonly sourceThreadId: ThreadId;
      readonly run: OrchestrationImplementationRun;
      readonly createdAt: string;
      readonly skipAppReviewRequirement?: boolean;
      readonly reviewBaseSha?: string;
    }) {
      if (input.run.automationHalt !== null) return;
      const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
      const orchestratorThread = findThread(readModel, input.run.orchestratorThreadId);
      if (orchestratorThread === null) return;
      const finalPass = isFinalCodeReviewPass(input.run);
      if (
        finalPass &&
        (input.run.finalCodeReviewPassCount >= IMPLEMENTATION_RUN_MAX_REVIEW_GATE_CYCLES ||
          input.run.finalCodeReviewLaunchCount >= IMPLEMENTATION_STAGE_MAX_LAUNCHES)
      ) {
        yield* blockRun({
          sourceThreadId: input.sourceThreadId,
          run: input.run,
          reasonMarkdown: "Final Code Review exhausted its single-pass launch budget.",
          updatedAt: input.createdAt,
          haltCategory: "retry-exhausted",
          haltStage: "final-code-review",
        });
        return;
      }
      // Code Review is the last thing between the integrated change and the
      // final gate, so skipping it goes straight to that gate.
      if (isRunStageSkipped(input.run.skips, "code-review")) {
        yield* startMergeGate({
          sourceThreadId: input.sourceThreadId,
          run: input.run,
          integration: {
            baseTicketId: null,
            baseRefName: input.run.orchestratorBranch,
            mergedTicketIds: [],
            conflictedTicketId: null,
            conflictedRefName: null,
            conflictedFiles: [],
            remainingTicketIds: [],
            remainingRefNames: [],
          },
          kind: "final",
          createdAt: input.createdAt,
        });
        return;
      }
      const activeReviewer =
        input.run.activeCodeReviewThreadId === null
          ? undefined
          : readModel.threads.find(
              (thread) =>
                thread.id === input.run.activeCodeReviewThreadId && thread.deletedAt === null,
            );
      if (
        activeReviewer?.session?.status === "starting" ||
        activeReviewer?.session?.status === "running"
      ) {
        return;
      }
      const reviewHead = yield* gitWorkflow.resolveCommit({
        cwd: input.run.orchestratorWorktreePath,
        ref: "HEAD",
      });
      const preflight = yield* gitWorkflow.localStatus({
        cwd: input.run.orchestratorWorktreePath,
      });
      if (
        !preflight.isRepo ||
        preflight.refName !== input.run.orchestratorBranch ||
        preflight.hasWorkingTreeChanges
      ) {
        yield* blockRun({
          sourceThreadId: input.sourceThreadId,
          run: input.run,
          retryableStage: "code-review",
          reasonMarkdown: `Code Review requires a clean worktree on '${input.run.orchestratorBranch}', but Git reports '${preflight.refName ?? "detached HEAD"}'${preflight.hasWorkingTreeChanges ? " with uncommitted changes" : ""}.`,
          updatedAt: input.createdAt,
          humanBlocked: true,
        });
        return;
      }
      if (input.run.integrationHeadSha !== reviewHead.commitSha) {
        yield* blockRun({
          sourceThreadId: input.sourceThreadId,
          run: input.run,
          retryableStage: "merge-gate",
          reasonMarkdown: `Code Review requires the integration gate on current HEAD '${reviewHead.commitSha}', but the integrated HEAD is '${input.run.integrationHeadSha ?? "missing"}'.`,
          updatedAt: input.createdAt,
        });
        return;
      }
      // Code Review normally requires a passing App Review at this exact HEAD. When App Review used
      // every attempt without passing, the run still continues — but only from a build-validated,
      // clean commit, so the reviewer never starts from unvalidated work.
      if (
        input.skipAppReviewRequirement !== true &&
        input.run.qaExhaustedAt === null &&
        input.run.appReviewExhaustedAt === null
      ) {
        if (
          input.run.appReviewedHeadSha === null ||
          input.run.appReviewedHeadSha !== reviewHead.commitSha
        ) {
          yield* blockRun({
            sourceThreadId: input.sourceThreadId,
            run: input.run,
            retryableStage: "app-review",
            reasonMarkdown: `Code Review requires a passing App Review for current HEAD '${reviewHead.commitSha}', but the app-reviewed HEAD is '${input.run.appReviewedHeadSha ?? "missing"}'.`,
            updatedAt: input.createdAt,
          });
          return;
        }
      } else if (input.skipAppReviewRequirement !== true) {
        const reviewStatus = yield* gitWorkflow.localStatus({
          cwd: input.run.orchestratorWorktreePath,
        });
        if (
          input.run.integrationHeadSha !== reviewHead.commitSha ||
          !reviewStatus.isRepo ||
          reviewStatus.refName !== input.run.orchestratorBranch ||
          reviewStatus.hasWorkingTreeChanges
        ) {
          yield* blockRun({
            sourceThreadId: input.sourceThreadId,
            run: input.run,
            retryableStage: "app-review",
            reasonMarkdown: `App Review did not pass, so Code Review requires an integrated, clean HEAD on '${input.run.orchestratorBranch}'. Current HEAD is '${reviewHead.commitSha}' and the integrated HEAD is '${input.run.integrationHeadSha ?? "missing"}'.`,
            updatedAt: input.createdAt,
            humanBlocked: true,
          });
          return;
        }
      }
      const artifactSourceThread = findThread(readModel, input.sourceThreadId);
      const artifactMarkdown =
        input.run.artifactSource === "proposed-plan" && artifactSourceThread !== null
          ? fastFeatureArtifactMarkdown({ run: input.run, sourceThread: artifactSourceThread })
          : undefined;

      const reviewerThreadId = yield* serverThreadId("implementation-code-reviewer");
      const reviewingRun: OrchestrationImplementationRun = {
        ...input.run,
        status: "code-reviewing",
        activeCodeReviewHeadSha: reviewHead.commitSha,
        activeCodeReviewThreadId: reviewerThreadId,
        codeReviewedHeadSha: null,
        codeReviewAttemptCount: input.run.codeReviewAttemptCount + 1,
        finalCodeReviewLaunchCount: finalPass
          ? input.run.finalCodeReviewLaunchCount + 1
          : input.run.finalCodeReviewLaunchCount,
        updatedAt: input.createdAt,
      };
      yield* updateRun({
        sourceThreadId: input.sourceThreadId,
        run: reviewingRun,
        createdAt: input.createdAt,
        expectedCodeReviewClaim: {
          attemptCount: input.run.codeReviewAttemptCount,
          activeThreadId: input.run.activeCodeReviewThreadId,
          ...(finalPass
            ? {
                generation: input.run.finalCodeReviewGeneration,
                launchCount: input.run.finalCodeReviewLaunchCount,
              }
            : {}),
        },
      });

      yield* orchestrationEngine.dispatch({
        type: "thread.create",
        commandId: yield* serverCommandId("implementation-code-reviewer-create"),
        threadId: reviewerThreadId,
        projectId: orchestratorThread.projectId,
        ownerUserId: orchestratorThread.ownerUserId,
        parentThreadId: input.run.orchestratorThreadId,
        workflowRole: "implementation-code-reviewer",
        title: "Implementation code review",
        modelSelection: yield* modelForStep({
          workflowPromptId: WORKFLOW_PROMPT_IDS.implementationCodeReviewCodex,
          orchestratorThread,
          createdAt: input.createdAt,
        }),
        runtimeMode: WORKFLOW_AUTOMATION_RUNTIME_MODE,
        interactionMode: "implementation-workflow",
        branch: input.run.orchestratorBranch,
        worktreePath: input.run.orchestratorWorktreePath,
        createdAt: input.createdAt,
      });

      yield* orchestrationEngine.dispatch({
        type: "thread.turn.start",
        commandId: yield* serverCommandId("implementation-code-reviewer-turn"),
        threadId: reviewerThreadId,
        message: {
          messageId: yield* serverMessageId("implementation-code-reviewer"),
          role: "user",
          text: appendWorkflowSkillCommandSection(
            buildCodeReviewPrompt({
              run: reviewingRun,
              ...(artifactMarkdown === undefined ? {} : { artifactMarkdown }),
              ...(input.reviewBaseSha === undefined ? {} : { reviewBaseSha: input.reviewBaseSha }),
            }),
            WORKFLOW_PROMPT_IDS.implementationCodeReviewCodex,
          ),
          attachments: [],
        },
        workflowPromptId: WORKFLOW_PROMPT_IDS.implementationCodeReviewCodex,
        runtimeMode: orchestratorThread.runtimeMode,
        interactionMode: "implementation-workflow",
        createdAt: input.createdAt,
      });

      yield* appendActivity({
        threadId: input.run.orchestratorThreadId,
        tone: "info",
        kind: "implementation-code-review-started",
        summary: `Code review started (cycle ${reviewingRun.codeReviewAttemptCount})`,
        payload: {
          runId: input.run.id,
          reviewerThreadId,
          cycle: reviewingRun.codeReviewAttemptCount,
        },
        createdAt: input.createdAt,
      });
    },
  );

  const continueAfterQaExhaustion = Effect.fn(
    "ImplementationWorkflowReactor.continueAfterQaExhaustion",
  )(function* (input: {
    readonly sourceThreadId: ThreadId;
    readonly run: OrchestrationImplementationRun;
    readonly createdAt: string;
  }) {
    const [head, status] = yield* Effect.all([
      gitWorkflow.resolveCommit({ cwd: input.run.orchestratorWorktreePath, ref: "HEAD" }),
      gitWorkflow.localStatus({ cwd: input.run.orchestratorWorktreePath }),
    ]);
    if (
      !status.isRepo ||
      status.refName !== input.run.orchestratorBranch ||
      status.hasWorkingTreeChanges
    ) {
      yield* blockRun({
        sourceThreadId: input.sourceThreadId,
        run: input.run,
        retryableStage: "app-review",
        reasonMarkdown: `App Review did not pass, so Code Review requires a clean integrated HEAD on '${input.run.orchestratorBranch}'. Current HEAD is '${head.commitSha}' and the integrated HEAD is '${input.run.integrationHeadSha ?? "missing"}'.`,
        updatedAt: input.createdAt,
        humanBlocked: true,
      });
      return;
    }
    if (input.run.integrationHeadSha !== head.commitSha) {
      yield* startMergeGate({
        sourceThreadId: input.sourceThreadId,
        run: {
          ...input.run,
          status: "integrating",
          activeValidationHeadSha: null,
          activeValidationKind: null,
          activeValidatorThreadId: null,
          retryableFailure: input.run.retryableFailure,
          updatedAt: input.createdAt,
        },
        integration: {
          baseTicketId: null,
          baseRefName: input.run.orchestratorBranch,
          mergedTicketIds: [],
          conflictedTicketId: null,
          conflictedRefName: null,
          conflictedFiles: [],
          remainingTicketIds: [],
          remainingRefNames: [],
        },
        kind: "integration",
        createdAt: input.createdAt,
      });
      return;
    }
    yield* startCodeReview(input);
  });

  const getChangeRequestSemaphore = (runId: string) =>
    SynchronizedRef.modifyEffect(changeRequestLocks, (current) => {
      const existing = current.get(runId);
      if (existing !== undefined) {
        const next = new Map(current);
        next.set(runId, { ...existing, users: existing.users + 1 });
        return Effect.succeed([existing.semaphore, next] as const);
      }
      return Semaphore.make(1).pipe(
        Effect.map((semaphore) => {
          const next = new Map(current);
          next.set(runId, { semaphore, users: 1 });
          return [semaphore, next] as const;
        }),
      );
    });

  const releaseChangeRequestSemaphore = (runId: string) =>
    SynchronizedRef.update(changeRequestLocks, (current) => {
      const existing = current.get(runId);
      if (existing === undefined) return current;
      const next = new Map(current);
      if (existing.users === 1) next.delete(runId);
      else next.set(runId, { ...existing, users: existing.users - 1 });
      return next;
    });

  const completeWithoutChangeRequestStage = Effect.fn(
    "ImplementationWorkflowReactor.completeWithoutChangeRequestStage",
  )(function* (input: {
    readonly sourceThreadId: ThreadId;
    readonly run: OrchestrationImplementationRun;
    readonly skippedStage: "change-request" | "change-request-babysit";
    readonly createdAt: string;
  }) {
    const completedRun: OrchestrationImplementationRun = {
      ...input.run,
      status: "completed",
      activeChangeRequestBabysitterThreadId: null,
      retryableFailure: null,
      updatedAt: input.createdAt,
    };
    yield* updateRun({
      sourceThreadId: input.sourceThreadId,
      run: completedRun,
      createdAt: input.createdAt,
    });
    yield* appendActivity({
      threadId: input.run.orchestratorThreadId,
      tone: "info",
      kind: "implementation-run-completed",
      summary:
        input.skippedStage === "change-request"
          ? "Implementation run completed without creating a pull request"
          : "Implementation run completed without babysitting the pull request",
      payload: { runId: input.run.id, skippedStage: input.skippedStage },
      createdAt: input.createdAt,
    });
    const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
    yield* teardownWorkflowStacks({ readModel, run: completedRun, createdAt: input.createdAt });
  });

  const startChangeRequestBabysitter = Effect.fn(
    "ImplementationWorkflowReactor.startChangeRequestBabysitter",
  )(function* (input: {
    readonly sourceThreadId: ThreadId;
    readonly run: OrchestrationImplementationRun;
    readonly createdAt: string;
  }) {
    if (
      input.run.changeRequest === null ||
      (input.run.status !== "publishing-change-request" &&
        input.run.status !== "babysitting-change-request")
    ) {
      return;
    }
    const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
    const orchestratorThread = findThread(readModel, input.run.orchestratorThreadId);
    if (orchestratorThread === null) return;
    if (isRunStageSkipped(input.run.skips, "change-request-babysit")) {
      yield* completeWithoutChangeRequestStage({
        sourceThreadId: input.sourceThreadId,
        run: input.run,
        skippedStage: "change-request-babysit",
        createdAt: input.createdAt,
      });
      return;
    }
    const babysitterThreadId = yield* serverThreadId("implementation-change-request-babysitter");
    const babysittingRun: OrchestrationImplementationRun = {
      ...input.run,
      status: "babysitting-change-request",
      activeChangeRequestBabysitterThreadId: babysitterThreadId,
      updatedAt: input.createdAt,
    };
    yield* updateRun({
      sourceThreadId: input.sourceThreadId,
      run: babysittingRun,
      createdAt: input.createdAt,
      expectedChangeRequestClaim: {
        status: input.run.status,
        changeRequestNumber: input.run.changeRequest.number,
        activeBabysitterThreadId: input.run.activeChangeRequestBabysitterThreadId,
      },
    });
    yield* orchestrationEngine.dispatch({
      type: "thread.create",
      commandId: yield* serverCommandId("implementation-change-request-babysitter-create"),
      threadId: babysitterThreadId,
      projectId: orchestratorThread.projectId,
      ownerUserId: orchestratorThread.ownerUserId,
      parentThreadId: input.run.orchestratorThreadId,
      workflowRole: "implementation-change-request-babysitter",
      title: `Babysit PR #${input.run.changeRequest.number}`,
      modelSelection: yield* modelForStep({
        workflowPromptId: WORKFLOW_PROMPT_IDS.implementationChangeRequestBabysitterCodex,
        orchestratorThread,
        createdAt: input.createdAt,
      }),
      runtimeMode: WORKFLOW_AUTOMATION_RUNTIME_MODE,
      interactionMode: "implementation-workflow",
      branch: input.run.orchestratorBranch,
      worktreePath: input.run.orchestratorWorktreePath,
      createdAt: input.createdAt,
    });
    yield* orchestrationEngine.dispatch({
      type: "thread.turn.start",
      commandId: yield* serverCommandId("implementation-change-request-babysitter-turn"),
      threadId: babysitterThreadId,
      message: {
        messageId: yield* serverMessageId("implementation-change-request-babysitter"),
        role: "user",
        text: appendWorkflowSkillCommandSection(
          [
            `Babysit GitHub pull request #${input.run.changeRequest.number} (${input.run.changeRequest.url}) for implementation run ${input.run.id}.`,
            "",
            "Watch the checks and review feedback on the latest pushed commit. Use gh to inspect GitHub Actions failures and unresolved actionable review threads. Verify every finding against the source. Fix real failures in this worktree, run the smallest relevant local checks, commit, and push the branch. After every push, restart monitoring against the new latest commit.",
            "",
            "Stay active until all required GitHub checks on the latest commit pass and no actionable review feedback remains. Do not merge the pull request. Do not report success for an older commit. If access, infrastructure, or a required external decision makes progress impossible, report blocked with the concrete reason.",
            "",
            "Finish with exactly one fenced JSON block:",
            "```json",
            // @effect-diagnostics-next-line preferSchemaOverJson:off - fixed directive example for the agent prompt.
            JSON.stringify(
              {
                type: "implementation-change-request-babysit-result",
                runId: input.run.id,
                status: "passed",
                headSha: "latest-pushed-HEAD-sha",
                summaryMarkdown:
                  "All required checks pass and no actionable review feedback remains.",
              },
              null,
              2,
            ),
            "```",
          ].join("\n"),
          WORKFLOW_PROMPT_IDS.implementationChangeRequestBabysitterCodex,
        ),
        attachments: [],
      },
      workflowPromptId: WORKFLOW_PROMPT_IDS.implementationChangeRequestBabysitterCodex,
      runtimeMode: WORKFLOW_AUTOMATION_RUNTIME_MODE,
      interactionMode: "implementation-workflow",
      createdAt: input.createdAt,
    });
    yield* appendActivity({
      threadId: input.run.orchestratorThreadId,
      tone: "info",
      kind: "implementation-change-request-babysit-started",
      summary: `Watching checks and reviews for PR #${input.run.changeRequest.number}`,
      payload: { runId: input.run.id, babysitterThreadId },
      createdAt: input.createdAt,
    });
  });

  const fileChangeRequestUnlocked = Effect.fn(
    "ImplementationWorkflowReactor.fileChangeRequestUnlocked",
  )(function* (input: {
    readonly sourceThreadId: ThreadId;
    readonly run: OrchestrationImplementationRun;
    readonly createdAt: string;
  }) {
    const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
    const currentRun = findRunById(readModel, input.run.id);
    if (
      currentRun === null ||
      currentRun.status === "canceled" ||
      currentRun.status === "completed" ||
      currentRun.status === "babysitting-change-request"
    ) {
      return;
    }
    if (isRunStageSkipped(currentRun.skips, "change-request")) {
      yield* completeWithoutChangeRequestStage({
        sourceThreadId: input.sourceThreadId,
        run: currentRun,
        skippedStage: "change-request",
        createdAt: input.createdAt,
      });
      return;
    }
    if (
      (input.run.status === "needs-human-attention" &&
        currentRun.status !== "needs-human-attention") ||
      (input.run.status === "publishing-change-request" &&
        currentRun.status !== "publishing-change-request" &&
        currentRun.status !== "validating" &&
        currentRun.status !== "code-reviewing" &&
        currentRun.status !== "code-review-fixing") ||
      (input.run.status !== "needs-human-attention" &&
        input.run.status !== "publishing-change-request")
    ) {
      return;
    }
    if (currentRun.status === "publishing-change-request" && currentRun.changeRequest !== null) {
      yield* startChangeRequestBabysitter({
        sourceThreadId: input.sourceThreadId,
        run: currentRun,
        createdAt: input.createdAt,
      });
      return;
    }
    const sourceThread = findThread(readModel, input.sourceThreadId);
    const sourcePlan = sourceThread?.proposedPlans.find(
      (plan) => plan.id === input.run.sourceProposedPlan?.planId,
    );
    const commitTitle =
      input.run.artifactSource === "proposed-plan"
        ? (proposedPlanTitle(sourcePlan?.planMarkdown ?? "") ?? "Fast feature")
        : `Implement ${input.run.specId}`;
    const workInProgress = input.run.reviewGateExhaustedAt !== null;
    const currentHead = workInProgress
      ? yield* gitWorkflow.resolveCommit({
          cwd: input.run.orchestratorWorktreePath,
          ref: "HEAD",
        })
      : null;
    const expectedHeadSha = currentHead?.commitSha ?? input.run.codeReviewedHeadSha;
    if (expectedHeadSha === null) {
      yield* blockRun({
        sourceThreadId: input.sourceThreadId,
        run: input.run,
        retryableStage: "code-review",
        reasonMarkdown: workInProgress
          ? "Cannot publish the work-in-progress change request because HEAD could not be resolved."
          : "Cannot publish a change request before Code Review accepts an exact HEAD.",
        updatedAt: input.createdAt,
      });
      return;
    }
    if (!workInProgress && input.run.validatedHeadSha !== expectedHeadSha) {
      yield* blockRun({
        sourceThreadId: input.sourceThreadId,
        run: input.run,
        retryableStage: "merge-gate",
        reasonMarkdown: `Cannot publish HEAD '${expectedHeadSha}' because complete passing validation belongs to '${input.run.validatedHeadSha ?? "missing"}'.`,
        updatedAt: input.createdAt,
      });
      return;
    }
    if (!workInProgress) {
      const changedFiles = yield* gitWorkflow.listChangedFiles({
        cwd: input.run.orchestratorWorktreePath,
        baseRef: input.run.pinnedCommit,
        headRef: expectedHeadSha,
      });
      if (
        !completeValidationsPassedExactlyOnce({
          requiredCommands: completeValidationCommandsForFiles(input.run, changedFiles),
          validations: input.run.finalValidationResults,
        })
      ) {
        yield* blockRun({
          sourceThreadId: input.sourceThreadId,
          run: input.run,
          retryableStage: "merge-gate",
          reasonMarkdown: `Cannot publish HEAD '${expectedHeadSha}' without exactly one passing result for every complete validation command.`,
          updatedAt: input.createdAt,
        });
        return;
      }
    }
    const reviewOutcomeNote = changeRequestReviewNote(input.run);
    const publishingRun: OrchestrationImplementationRun = {
      ...input.run,
      status: "publishing-change-request",
      updatedAt: input.createdAt,
    };
    yield* updateRun({
      sourceThreadId: input.sourceThreadId,
      run: publishingRun,
      createdAt: input.createdAt,
    });
    const claimedReadModel = yield* projectionSnapshotQuery.getCommandReadModel();
    const claimedRun = findRunById(claimedReadModel, input.run.id);
    if (
      claimedRun === null ||
      claimedRun.status !== "publishing-change-request" ||
      claimedRun.activeChangeRequestBabysitterThreadId !== null
    ) {
      return;
    }
    if (claimedRun.changeRequest !== null) {
      yield* startChangeRequestBabysitter({
        sourceThreadId: input.sourceThreadId,
        run: claimedRun,
        createdAt: input.createdAt,
      });
      return;
    }
    const result = yield* gitWorkflow
      .createOrOpenChangeRequest({
        cwd: claimedRun.orchestratorWorktreePath,
        actionId: claimedRun.id,
        baseRefName: claimedRun.baseBranch,
        headRefName: claimedRun.orchestratorBranch,
        expectedHeadSha,
        threadId: claimedRun.orchestratorThreadId,
        commitMessage: `${commitTitle}\n\n${reviewOutcomeNote}`,
        pullRequestBodyNote: reviewOutcomeNote,
      })
      .pipe(Effect.result);

    if (result._tag === "Failure") {
      yield* updateRun({
        sourceThreadId: input.sourceThreadId,
        run: {
          ...claimedRun,
          status: "needs-human-attention",
          changeRequestFailure: changeRequestFailure({
            detail: errorDetail(result.failure),
            failedAt: input.createdAt,
          }),
          retryableFailure: {
            stage: "change-request",
            detail: errorDetail(result.failure),
            failedAt: input.createdAt,
            attemptCount:
              claimedRun.retryableFailure?.stage === "change-request"
                ? claimedRun.retryableFailure.attemptCount + 1
                : 1,
            maxAttempts: 3,
            humanBlocked: false,
          },
          updatedAt: input.createdAt,
        },
        createdAt: input.createdAt,
        expectedChangeRequestClaim: {
          status: "publishing-change-request",
          changeRequestNumber: null,
          activeBabysitterThreadId: null,
        },
      });
      yield* appendActivity({
        threadId: claimedRun.orchestratorThreadId,
        tone: "error",
        kind: "implementation-change-request-filed",
        summary: "Change request publication failed",
        payload: {
          runId: claimedRun.id,
          status: "failed",
          detail: errorDetail(result.failure),
        },
        createdAt: input.createdAt,
      });
      return;
    }

    const filedRun: OrchestrationImplementationRun = {
      ...claimedRun,
      changeRequest: result.success,
      changeRequestFailure: null,
      retryableFailure: null,
      updatedAt: input.createdAt,
    };
    yield* updateRun({
      sourceThreadId: input.sourceThreadId,
      run: filedRun,
      createdAt: input.createdAt,
      expectedChangeRequestClaim: {
        status: "publishing-change-request",
        changeRequestNumber: null,
        activeBabysitterThreadId: null,
      },
    });
    yield* appendActivity({
      threadId: claimedRun.orchestratorThreadId,
      tone: workInProgress ? "error" : "info",
      kind: "implementation-change-request-filed",
      summary: `${workInProgress ? "Work-in-progress change request" : "Change request"} filed (#${result.success.number})`,
      payload: {
        runId: claimedRun.id,
        status: "filed",
        workInProgress,
        url: result.success.url,
        number: result.success.number,
      },
      createdAt: input.createdAt,
    });
    yield* startChangeRequestBabysitter({
      sourceThreadId: input.sourceThreadId,
      run: filedRun,
      createdAt: input.createdAt,
    });
  });

  const fileChangeRequest = Effect.fn("ImplementationWorkflowReactor.fileChangeRequest")(
    function* (input: {
      readonly sourceThreadId: ThreadId;
      readonly run: OrchestrationImplementationRun;
      readonly createdAt: string;
    }) {
      if (input.run.automationHalt !== null) return;
      const semaphore = yield* getChangeRequestSemaphore(input.run.id);
      return yield* semaphore
        .withPermit(fileChangeRequestUnlocked(input))
        .pipe(Effect.ensuring(releaseChangeRequestSemaphore(input.run.id)));
    },
  );

  const ensureFastFeatureRun = Effect.fn("ImplementationWorkflowReactor.ensureFastFeatureRun")(
    function* (input: {
      readonly sourceThreadId: ThreadId;
      readonly run: OrchestrationImplementationRun;
      readonly createdAt: string;
    }) {
      if (input.run.automationHalt !== null) return;
      const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
      const sourceThread = findThread(readModel, input.sourceThreadId);
      const implementerThread = findThread(readModel, input.run.orchestratorThreadId);
      if (sourceThread === null || implementerThread === null) return;
      const project = yield* projectionSnapshotQuery
        .getProjectShellById(sourceThread.projectId)
        .pipe(Effect.map(Option.getOrUndefined));
      if (!project) return;
      const sourceCwd = sourceThread.worktreePath ?? project.workspaceRoot;
      const sourceStatus = yield* gitWorkflow.localStatus({ cwd: sourceCwd });
      const reusesSourceWorkspace = sourceCwd === input.run.orchestratorWorktreePath;
      const expectedSourceBranch = reusesSourceWorkspace
        ? input.run.orchestratorBranch
        : input.run.baseBranch;
      if (!sourceStatus.isRepo || sourceStatus.refName !== expectedSourceBranch) {
        yield* blockRun({
          sourceThreadId: input.sourceThreadId,
          run: input.run,
          retryableStage: "source-dirty",
          humanBlocked: true,
          reasonMarkdown: `The source worktree must be on the captured branch '${expectedSourceBranch}', but Git reports '${sourceStatus.refName ?? "detached HEAD"}'. Switch back to the captured branch, then retry.`,
          updatedAt: input.createdAt,
        });
        return;
      }
      let setupRun =
        input.run.retryableFailure?.stage === "source-dirty"
          ? yield* gitWorkflow.resolveCommit({ cwd: sourceCwd, ref: "HEAD" }).pipe(
              Effect.map(({ commitSha }) => ({
                ...input.run,
                pinnedCommit: commitSha,
                launchSummary: { ...input.run.launchSummary, pinnedCommit: commitSha },
              })),
            )
          : input.run;

      if (sourceStatus.hasWorkingTreeChanges) {
        yield* blockRun({
          sourceThreadId: input.sourceThreadId,
          run: setupRun,
          retryableStage: "source-dirty",
          humanBlocked: true,
          reasonMarkdown: `Implementation requires a clean source worktree on '${expectedSourceBranch}'. Commit or preserve the current changes before starting this stage.`,
          updatedAt: input.createdAt,
        });
        return;
      }

      const existingWorktreeHead = yield* gitWorkflow
        .resolveCommit({ cwd: setupRun.orchestratorWorktreePath, ref: "HEAD" })
        .pipe(Effect.option);
      if (Option.isSome(existingWorktreeHead)) {
        const worktreeStatus = yield* gitWorkflow.localStatus({
          cwd: setupRun.orchestratorWorktreePath,
        });
        if (!worktreeStatus.isRepo || worktreeStatus.refName !== setupRun.orchestratorBranch) {
          yield* blockRun({
            sourceThreadId: input.sourceThreadId,
            run: setupRun,
            retryableStage: "worktree-setup",
            humanBlocked: true,
            reasonMarkdown: `The existing Fast feature worktree is not on the expected branch '${setupRun.orchestratorBranch}'. Resolve or remove the conflicting worktree, then retry.`,
            updatedAt: input.createdAt,
          });
          return;
        }
        if (worktreeStatus.hasWorkingTreeChanges) {
          yield* blockRun({
            sourceThreadId: input.sourceThreadId,
            run: setupRun,
            retryableStage: "worktree-setup",
            humanBlocked: true,
            reasonMarkdown: `The existing Fast feature worktree on '${setupRun.orchestratorBranch}' is dirty before Build launch. Preserve or commit its changes before starting this stage.`,
            updatedAt: input.createdAt,
          });
          return;
        }
      } else {
        yield* gitWorkflow.createWorktree({
          cwd: sourceCwd,
          refName: setupRun.pinnedCommit,
          newRefName: setupRun.orchestratorBranch,
          baseRefName: setupRun.baseBranch,
          path: setupRun.orchestratorWorktreePath,
        });
      }

      yield* orchestrationEngine.dispatch({
        type: "thread.meta.update",
        commandId: yield* serverCommandId("fast-feature-implementer-meta"),
        threadId: setupRun.orchestratorThreadId,
        branch: setupRun.orchestratorBranch,
        worktreePath: setupRun.orchestratorWorktreePath,
      });

      const refreshed = yield* projectionSnapshotQuery.getCommandReadModel();
      // A miss in the refreshed model must not read as "already started" — that silently drops
      // the handover and leaves an empty Build thread.
      const currentImplementer =
        findThread(refreshed, setupRun.orchestratorThreadId) ?? implementerThread;
      // Threads in the command read model carry no messages, so ask for the detail: the seeded
      // user message is the only thing that proves the handover already went out. `latestTurn`
      // will not do — it appears only once a provider session exists.
      const alreadyHandedOver = yield* projectionSnapshotQuery
        .getThreadDetailById(setupRun.orchestratorThreadId)
        .pipe(
          Effect.map(
            Option.match({
              onNone: () => false,
              onSome: (thread) => thread.messages.some((message) => message.role === "user"),
            }),
          ),
        );
      // A run blocked at Build has to go back to Build, whatever the last directive claimed. Build
      // can report `succeeded` and still be rejected — mismatched validation commands, a dirty
      // worktree, a HEAD that does not match the reported commit — and keying the re-prompt off
      // the reported status alone left those runs with no way forward: Retry started no turn and
      // silently marked the run `running`.
      const blockedAtBuild = setupRun.retryableFailure?.stage === "build";
      const shouldStart =
        currentImplementer.latestTurn?.state !== "running" &&
        (!alreadyHandedOver ||
          blockedAtBuild ||
          setupRun.fastBuildResult?.status === "failed" ||
          setupRun.fastBuildResult?.status === "blocked");
      if (shouldStart) {
        // A run that cannot resolve its plan has nothing to hand over. Block loudly rather than
        // starting Build against a prompt that reads "Proposed plan unavailable."
        if (findRunProposedPlan({ run: setupRun, sourceThread }) === undefined) {
          yield* blockRun({
            sourceThreadId: input.sourceThreadId,
            run: setupRun,
            retryableStage: "build",
            humanBlocked: true,
            reasonMarkdown:
              "The proposed plan behind this Fast feature run is no longer available on the source thread, so there is nothing to hand over to Build. Re-run planning, then relaunch.",
            updatedAt: input.createdAt,
          });
          return;
        }
        yield* orchestrationEngine.dispatch({
          type: "thread.turn.start",
          commandId: yield* serverCommandId("fast-feature-build-turn"),
          threadId: setupRun.orchestratorThreadId,
          message: {
            messageId: yield* serverMessageId("fast-feature-build"),
            role: "user",
            text: buildFastFeaturePrompt({
              run: setupRun,
              sourceThread,
              ...(blockedAtBuild && setupRun.retryableFailure !== null
                ? { rejectionMarkdown: setupRun.retryableFailure.detail }
                : {}),
            }),
            attachments: [],
          },
          titleSeed: implementerThread.title,
          runtimeMode: implementerThread.runtimeMode,
          interactionMode: "default",
          ...(setupRun.sourceProposedPlan === null
            ? {}
            : { sourceProposedPlan: setupRun.sourceProposedPlan }),
          createdAt: input.createdAt,
        });
      }

      // Leaving `launch-pending` is the record that the handover went out. The command read model
      // carries no thread messages and only exposes `latestTurn` once a provider session exists,
      // so the run status is the one durable marker the recovery sweep can trust.
      //
      // Keep `retryableFailure` while the stage re-runs. Clearing it here would
      // reset `blockRun`'s attempt counter on every resume, so a stage that
      // keeps failing would never exhaust `maxAttempts` and the 30s sweep in
      // `recoverRetryableRuns` would relaunch it forever. Success paths
      // (e.g. `handleFastBuildResult`) clear it once the stage actually passes.
      const resumedRun: OrchestrationImplementationRun = {
        ...setupRun,
        status: "running",
        updatedAt: input.createdAt,
      };
      yield* updateRun({
        sourceThreadId: input.sourceThreadId,
        run: resumedRun,
        createdAt: input.createdAt,
      });

      // Workspace bootstrap already owns App Dev Stack creation. `startBrowserReview` requires and
      // probes that inherited stack after Build reports a clean committed HEAD.
    },
  );

  const handlePromptTicketsCreated = Effect.fn(
    "ImplementationWorkflowReactor.handlePromptTicketsCreated",
  )(function* (
    event: Extract<ImplementationWorkflowEvent, { type: "thread.planning-tickets-created" }>,
  ) {
    const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
    const thread = findThread(readModel, event.payload.threadId);
    if (
      thread === null ||
      thread.interactionMode !== "implementation-workflow" ||
      thread.workflowRole !== null ||
      thread.worktreePath === null ||
      thread.branch === null
    ) {
      return;
    }
    if (readModel.implementationRuns.some((run) => run.specId === event.payload.specId)) return;
    const head = yield* gitWorkflow.resolveCommit({ cwd: thread.worktreePath, ref: "HEAD" });
    const settings = yield* serverSettingsService.getSettings.pipe(
      Effect.orElseSucceed(() => undefined),
    );
    yield* orchestrationEngine.dispatch({
      type: "thread.implementation-run.launch",
      commandId: yield* serverCommandId("implementation-prompt-tickets-launch"),
      threadId: thread.id,
      specId: event.payload.specId,
      baseBranch: thread.branch,
      pinnedCommit: head.commitSha,
      orchestratorBranch: thread.branch,
      orchestratorWorktreePath: thread.worktreePath,
      validationCommands: [],
      skips: [...implementationWorkflowDefaultSkips(settings?.implementation)],
      createdAt: event.occurredAt,
    });
  });

  const handleRunLaunched = Effect.fn("ImplementationWorkflowReactor.handleRunLaunched")(function* (
    event: Extract<ImplementationWorkflowEvent, { type: "thread.implementation-run-launched" }>,
  ) {
    if (event.payload.run.artifactSource === "proposed-plan") {
      yield* ensureFastFeatureRun({
        sourceThreadId: event.payload.sourceThreadId,
        run: event.payload.run,
        createdAt: event.occurredAt,
      }).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : blockRun({
                sourceThreadId: event.payload.sourceThreadId,
                run: event.payload.run,
                retryableStage: "worktree-setup",
                reasonMarkdown: `Fast feature worktree setup failed.\n\n\`\`\`\n${Cause.pretty(cause)}\n\`\`\``,
                updatedAt: event.occurredAt,
              }),
        ),
      );
      return;
    }
    const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
    const sourceThread = findThread(readModel, event.payload.sourceThreadId);
    const orchestratorThread = findThread(readModel, event.payload.run.orchestratorThreadId);
    if (sourceThread === null || orchestratorThread === null) return;

    const project = yield* projectionSnapshotQuery
      .getProjectShellById(sourceThread.projectId)
      .pipe(Effect.map(Option.getOrUndefined));
    if (project === undefined) return;

    const runningRun: OrchestrationImplementationRun = {
      ...event.payload.run,
      status: "running",
      updatedAt: event.occurredAt,
    };
    yield* Effect.gen(function* () {
      const existingWorktreeHead = yield* gitWorkflow
        .resolveCommit({ cwd: event.payload.run.orchestratorWorktreePath, ref: "HEAD" })
        .pipe(Effect.option);
      if (Option.isSome(existingWorktreeHead)) {
        const status = yield* gitWorkflow.localStatus({
          cwd: event.payload.run.orchestratorWorktreePath,
        });
        if (!status.isRepo || status.refName !== event.payload.run.orchestratorBranch) {
          return yield* new GitCommandError({
            operation: "ImplementationWorkflowReactor.handleRunLaunched",
            command: "git status --short --branch",
            cwd: event.payload.run.orchestratorWorktreePath,
            detail: `The Planning workspace must remain on '${event.payload.run.orchestratorBranch}', but Git reports '${status.refName ?? "detached HEAD"}'.`,
          });
        }
      } else {
        // Historical and standalone Implementation launches may not have a Planning workspace.
        // Keep their old setup path while new Planning, Full Feature, and Fast Feature runs reuse
        // the workspace prepared before their first model turn.
        yield* gitWorkflow.createWorktree({
          cwd: project.workspaceRoot,
          refName: event.payload.run.pinnedCommit,
          newRefName: event.payload.run.orchestratorBranch,
          baseRefName: event.payload.run.baseBranch,
          path: event.payload.run.orchestratorWorktreePath,
        });
      }

      yield* orchestrationEngine.dispatch({
        type: "thread.meta.update",
        commandId: yield* serverCommandId("implementation-orchestrator-meta"),
        threadId: event.payload.run.orchestratorThreadId,
        branch: event.payload.run.orchestratorBranch,
        worktreePath: event.payload.run.orchestratorWorktreePath,
      });

      yield* updateRun({
        sourceThreadId: event.payload.sourceThreadId,
        run: runningRun,
        createdAt: event.occurredAt,
      });
      yield* startReadyWorkers({
        sourceThreadId: event.payload.sourceThreadId,
        run: runningRun,
        createdAt: event.occurredAt,
      });
      const ticketTitles = ticketsById(sourceThread);
      yield* appendActivity({
        threadId: runningRun.orchestratorThreadId,
        tone: "info",
        kind: "implementation-run-launched",
        summary: `Implementation run launched with ${runningRun.ticketStates.length} ticket(s)`,
        payload: {
          runId: runningRun.id,
          ticketCount: runningRun.ticketStates.length,
          tickets: runningRun.ticketStates.map((state) => ({
            ticketId: state.ticketId,
            ...(ticketTitles.get(state.ticketId)?.title !== undefined
              ? { title: ticketTitles.get(state.ticketId)?.title }
              : {}),
          })),
        },
        createdAt: event.occurredAt,
      });
    }).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("implementation run launch failed; blocking run", {
          runId: event.payload.run.id,
          cause: Cause.pretty(cause),
        }).pipe(
          Effect.andThen(
            blockRun({
              sourceThreadId: event.payload.sourceThreadId,
              run: runningRun,
              reasonMarkdown: `Implementation run launch failed before workers could start.\n\n\`\`\`\n${Cause.pretty(cause)}\n\`\`\``,
              updatedAt: event.occurredAt,
            }),
          ),
        );
      }),
    );
  });

  const handleWorkerResult = Effect.fn("ImplementationWorkflowReactor.handleWorkerResult")(
    function* (
      event: Extract<ImplementationWorkflowEvent, { type: "thread.activity-appended" }>,
      directive: WorkerDirective,
    ) {
      const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
      const run = findRunByWorkerThreadId(readModel, event.payload.threadId);
      if (run === null) return;
      const sourceThreadId = findRunSourceThreadId({ readModel, run });
      if (sourceThreadId === null) return;
      const currentState = run.ticketStates.find(
        (state) => state.workerThreadId === event.payload.threadId,
      );
      if (
        currentState === undefined ||
        currentState.status === "succeeded" ||
        currentState.status === "failed"
      ) {
        return;
      }
      if (
        currentState.ticketId !== directive.ticketId ||
        currentState.branch !== directive.branch ||
        currentState.worktreePath !== directive.worktreePath
      ) {
        yield* blockRun({
          sourceThreadId,
          run,
          ticketId: currentState.ticketId,
          retryableStage: "worker-execution",
          reasonMarkdown: `Worker result identity does not match the active assignment for thread '${event.payload.threadId}'.`,
          updatedAt: directive.reportedAt,
          humanBlocked: true,
        });
        return;
      }

      yield* appendActivity({
        threadId: run.orchestratorThreadId,
        tone: directive.status === "failed" ? "error" : "info",
        kind: "implementation-worker-finished",
        summary: `Worker ${directive.ticketId} ${directive.status}`,
        payload: {
          runId: run.id,
          ticketId: directive.ticketId,
          status: directive.status,
        },
        createdAt: directive.reportedAt,
      });

      if (
        directive.status === "failed" &&
        directive.notesMarkdown === WORKFLOW_INTERRUPTION_ERROR_MESSAGE
      ) {
        const interruptedRun: OrchestrationImplementationRun = {
          ...run,
          ticketStates: run.ticketStates.map((state) =>
            state.workerThreadId === event.payload.threadId
              ? {
                  ...state,
                  status: "failed" as const,
                  warningMarkdown: directive.notesMarkdown,
                  updatedAt: directive.reportedAt,
                }
              : state,
          ),
          updatedAt: directive.reportedAt,
        };
        const blocked = yield* blockRun({
          sourceThreadId,
          run: interruptedRun,
          ticketId: directive.ticketId,
          retryableStage: "worker-execution",
          reasonMarkdown: directive.notesMarkdown,
          updatedAt: directive.reportedAt,
        });
        if (blocked.automationHalt === null) {
          yield* requestRunRetry({
            sourceThreadId,
            runId: run.id,
            createdAt: directive.reportedAt,
          });
        }
        return;
      }

      if (directive.status === "failed") {
        const failedRun: OrchestrationImplementationRun = {
          ...run,
          ticketStates: run.ticketStates.map((state) =>
            state.workerThreadId === event.payload.threadId
              ? {
                  ...state,
                  status: "failed" as const,
                  workerResult: directive,
                  warningMarkdown:
                    directive.notesMarkdown || `Worker '${directive.ticketId}' failed.`,
                  updatedAt: directive.reportedAt,
                }
              : state,
          ),
          workerResults: [...run.workerResults, directive],
          retryableFailure: null,
          updatedAt: directive.reportedAt,
        };
        if (run.automationHalt !== null) {
          yield* updateRun({ sourceThreadId, run: failedRun, createdAt: directive.reportedAt });
          return;
        }
        yield* blockRun({
          sourceThreadId,
          run: failedRun,
          ticketId: directive.ticketId,
          reasonMarkdown:
            directive.notesMarkdown || `Ticket '${directive.ticketId}' implementation failed.`,
          updatedAt: directive.reportedAt,
          haltCategory: "stage-failed",
          haltStage: "implementation",
        });
        return;
      }

      const acceptedDirective = yield* verifySuccessfulWorkerResult({
        run,
        threadId: event.payload.threadId,
        directive,
      }).pipe(
        Effect.catch((error) =>
          blockRun({
            sourceThreadId,
            run: {
              ...run,
              ticketStates: run.ticketStates.map((state) =>
                state.workerThreadId === event.payload.threadId
                  ? {
                      ...state,
                      status: "failed" as const,
                      workerResult: directive,
                      updatedAt: directive.reportedAt,
                    }
                  : state,
              ),
            },
            retryableStage: "worker-execution",
            ticketId: currentState.ticketId,
            reasonMarkdown: errorDetail(error),
            updatedAt: directive.reportedAt,
            humanBlocked: structuralGitFailure(errorDetail(error)),
          }).pipe(Effect.as(null)),
        ),
      );
      if (acceptedDirective === null) return;

      const succeededRun: OrchestrationImplementationRun = {
        ...run,
        ticketStates: run.ticketStates.map((state) =>
          state.workerThreadId === event.payload.threadId
            ? {
                ...state,
                status: "app-reviewing" as const,
                branch: directive.branch,
                worktreePath: directive.worktreePath,
                workerResult: acceptedDirective,
                updatedAt: directive.reportedAt,
              }
            : state,
        ),
        workerResults: [...run.workerResults, acceptedDirective],
        retryableFailure:
          run.automationHalt === null &&
          run.retryableFailure?.stage === "worker-execution" &&
          run.retryableFailure.ticketId === directive.ticketId
            ? null
            : run.retryableFailure,
        updatedAt: directive.reportedAt,
      };

      if (run.automationHalt !== null) {
        const recordedRun: OrchestrationImplementationRun = {
          ...succeededRun,
          ticketStates: succeededRun.ticketStates.map((state) =>
            state.workerThreadId === event.payload.threadId
              ? {
                  ...state,
                  status: "running" as const,
                  warningMarkdown: "Implementation result recorded after automation halted.",
                }
              : state,
          ),
        };
        yield* updateRun({
          sourceThreadId,
          run: recordedRun,
          createdAt: directive.reportedAt,
        });
        return;
      }

      if (run.appReviewStrategy === "legacy-inline") {
        const reviewedRun = markDependentsReady(
          {
            ...succeededRun,
            ticketStates: succeededRun.ticketStates.map((state) =>
              state.workerThreadId === event.payload.threadId
                ? { ...state, status: "succeeded" as const }
                : state,
            ),
          },
          directive.reportedAt,
        );
        const tierDownStampedRun: OrchestrationImplementationRun = {
          ...reviewedRun,
          ticketStates: reviewedRun.ticketStates.map((state) =>
            state.workerThreadId === event.payload.threadId
              ? { ...state, appDevStackTierDownAt: directive.reportedAt }
              : state,
          ),
        };
        yield* updateRun({
          sourceThreadId,
          run: tierDownStampedRun,
          createdAt: directive.reportedAt,
        });
        yield* tierDownTicketStacks({
          run: tierDownStampedRun,
          createdAt: directive.reportedAt,
        });
        if (
          tierDownStampedRun.ticketStates.every((state) =>
            implementationTicketStateIsTerminal(state.status),
          )
        ) {
          yield* integrateCompletedRun({
            sourceThreadId,
            run: tierDownStampedRun,
            createdAt: directive.reportedAt,
          });
        } else {
          yield* startReadyWorkers({
            sourceThreadId,
            run: tierDownStampedRun,
            createdAt: directive.reportedAt,
          });
        }
        return;
      }

      yield* updateRun({ sourceThreadId, run: succeededRun, createdAt: directive.reportedAt });
      yield* startTicketAppReview({
        sourceThreadId,
        run: succeededRun,
        ticketId: directive.ticketId,
        createdAt: directive.reportedAt,
      });
    },
  );

  const applyFastBuildResult = Effect.fn("ImplementationWorkflowReactor.applyFastBuildResult")(
    function* (input: {
      readonly threadId: ThreadId;
      readonly directive: FastBuildDirective;
      readonly updatedAt: string;
    }) {
      const { directive } = input;
      const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
      const run = findRunById(readModel, directive.runId);
      if (
        run === null ||
        run.artifactSource !== "proposed-plan" ||
        run.orchestratorThreadId !== input.threadId
      ) {
        return;
      }
      // Build owns app-review fixes too, so a run legitimately reports several successful builds.
      // Only ignore a repeat result once the branch has moved past Build into review or publication.
      // A blocked Build has not moved past Build — it is stuck at it — so a real result that lands
      // after the retry budget was spent must still be accepted, or the run is stranded for good.
      if (
        run.status !== "running" &&
        run.status !== "launch-pending" &&
        run.status !== "needs-human-attention"
      ) {
        return;
      }
      const sourceThreadId = findRunSourceThreadId({ readModel, run });
      if (sourceThreadId === null) return;
      const updatedAt = input.updatedAt;
      const buildResult = {
        runId: run.id,
        status: directive.status,
        ...(directive.commitSha === undefined
          ? { commitSha: null }
          : { commitSha: directive.commitSha }),
        validations: [...directive.validations],
        notesMarkdown: directive.notesMarkdown,
      } as OrchestrationImplementationRun["fastBuildResult"];
      if (directive.status !== "succeeded" || directive.commitSha === undefined) {
        yield* blockRun({
          sourceThreadId,
          run: { ...run, fastBuildResult: buildResult, updatedAt },
          retryableStage: "build",
          reasonMarkdown:
            directive.notesMarkdown || `Fast feature Build reported ${directive.status}.`,
          updatedAt,
        });
        return;
      }
      if (
        !focusedRepairValidationsPassed({
          finalCommands: [
            ...run.launchSummary.validationCommands,
            NATIVE_MOBILE_VALIDATION_COMMAND,
          ],
          validations: directive.validations,
        })
      ) {
        yield* blockRun({
          sourceThreadId,
          run: { ...run, fastBuildResult: buildResult, updatedAt },
          retryableStage: "build",
          reasonMarkdown:
            "Fast feature Build must report passing focused or documented sub-minute fast validation and must not run launch-level complete commands before Code Review.",
          updatedAt,
        });
        return;
      }
      const [head, reportedHead] = yield* Effect.all([
        gitWorkflow.resolveCommit({
          cwd: run.orchestratorWorktreePath,
          ref: "HEAD",
        }),
        gitWorkflow.resolveCommit({
          cwd: run.orchestratorWorktreePath,
          ref: directive.commitSha,
        }),
      ]);
      const buildWorktreeStatus = yield* gitWorkflow.localStatus({
        cwd: run.orchestratorWorktreePath,
      });
      if (
        !buildWorktreeStatus.isRepo ||
        buildWorktreeStatus.refName !== run.orchestratorBranch ||
        buildWorktreeStatus.hasWorkingTreeChanges
      ) {
        yield* blockRun({
          sourceThreadId,
          run: { ...run, fastBuildResult: buildResult, updatedAt },
          retryableStage: "build",
          reasonMarkdown: `Fast feature Build must finish with a clean worktree on branch '${run.orchestratorBranch}'. Commit all completed changes on that branch, then retry.`,
          updatedAt,
        });
        return;
      }
      if (head.commitSha !== reportedHead.commitSha) {
        yield* blockRun({
          sourceThreadId,
          run: { ...run, fastBuildResult: buildResult, updatedAt },
          retryableStage: "build",
          reasonMarkdown: `Fast feature Build reported commit '${reportedHead.commitSha}', but the worktree branch HEAD is '${head.commitSha}'.`,
          updatedAt,
        });
        return;
      }
      const succeededRun: OrchestrationImplementationRun = {
        ...run,
        status: "qa-reviewing",
        fastBuildResult: {
          runId: run.id,
          status: "succeeded",
          commitSha: reportedHead.commitSha,
          validations: [...directive.validations],
          notesMarkdown: directive.notesMarkdown,
        },
        integrationHeadSha: head.commitSha,
        validatedHeadSha: null,
        retryableFailure: null,
        updatedAt,
      };
      yield* updateRun({ sourceThreadId, run: succeededRun, createdAt: updatedAt });
      yield* startBrowserReview({ sourceThreadId, run: succeededRun, createdAt: updatedAt });
    },
  );

  const handleFastBuildResult = (
    event: Extract<ImplementationWorkflowEvent, { type: "thread.activity-appended" }>,
    directive: FastBuildDirective,
  ) =>
    applyFastBuildResult({
      threadId: event.payload.threadId,
      directive,
      updatedAt: event.payload.activity.createdAt,
    });

  const handleMergeGateResult = Effect.fn("ImplementationWorkflowReactor.handleMergeGateResult")(
    function* (
      event: Extract<ImplementationWorkflowEvent, { type: "thread.activity-appended" }>,
      directive: MergeGateDirective,
    ) {
      const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
      const run = findRunById(readModel, directive.runId);
      if (
        run === null ||
        run.status !== "validating" ||
        run.activeValidatorThreadId !== event.payload.threadId
      ) {
        return;
      }
      const sourceThreadId = findRunSourceThreadId({ readModel, run });
      if (sourceThreadId === null) return;
      const updatedAt = event.payload.activity.createdAt;
      const [head, status] = yield* Effect.all([
        gitWorkflow.resolveCommit({ cwd: run.orchestratorWorktreePath, ref: "HEAD" }),
        gitWorkflow.localStatus({ cwd: run.orchestratorWorktreePath }),
      ]);
      const integrated =
        run.artifactSource === "planning-spec"
          ? yield* verifyIntegratedWorkerCommits(run).pipe(
              Effect.map((integratedHead) => integratedHead === head.commitSha),
              Effect.orElseSucceed(() => false),
            )
          : true;
      const changedFiles = yield* gitWorkflow.listChangedFiles({
        cwd: run.orchestratorWorktreePath,
        baseRef: run.pinnedCommit,
        headRef: head.commitSha,
      });
      const requiredCommands = completeValidationCommandsForFiles(run, changedFiles);
      const gateKind = run.activeValidationKind ?? "integration";
      const finalValidation = validationSummary(
        directive.validations,
        gateKind === "final" ? "final validation" : "integration gate",
        directive.summaryMarkdown,
        updatedAt,
      );
      const validationsPassed =
        gateKind === "final"
          ? completeValidationsPassedExactlyOnce({
              requiredCommands,
              validations: directive.validations,
            })
          : focusedRepairValidationsPassed({
              finalCommands: requiredCommands,
              validations: directive.validations,
            });
      const passed =
        directive.status === "passed" &&
        run.activeValidationHeadSha === head.commitSha &&
        status.isRepo &&
        status.refName === run.orchestratorBranch &&
        !status.hasWorkingTreeChanges &&
        integrated &&
        validationsPassed;

      yield* appendActivity({
        threadId: run.orchestratorThreadId,
        tone: passed ? "info" : "error",
        kind: "implementation-merge-gate-finished",
        summary: `${gateKind === "final" ? "Final validation" : "Merge gate"} ${passed ? "passed" : "failed"}`,
        payload: { runId: run.id, status: passed ? "passed" : "failed", kind: gateKind },
        createdAt: updatedAt,
      });

      if (!passed) {
        const failedRun: OrchestrationImplementationRun = {
          ...run,
          ...(gateKind === "final"
            ? {
                finalValidation,
                finalValidationResults: [...directive.validations],
              }
            : {}),
          activeValidatorThreadId: null,
          activeValidationHeadSha: null,
          activeValidationKind: gateKind,
          updatedAt,
        };
        if (gateKind === "final") {
          const exhaustionReason = reviewGateExhaustionReason(failedRun);
          yield* appendActivity({
            threadId: run.orchestratorThreadId,
            tone: "error",
            kind: "implementation-review-gate-exhausted",
            summary: "Final validation failed after the final Code Review",
            payload: {
              runId: run.id,
              cycles: run.codeReviewAttemptCount,
              maxCycles: IMPLEMENTATION_RUN_MAX_REVIEW_GATE_CYCLES,
              reasonMarkdown: exhaustionReason,
            },
            createdAt: updatedAt,
          });
          yield* blockRun({
            sourceThreadId,
            run: {
              ...failedRun,
              activeValidationKind: null,
              reviewGateExhaustedAt: updatedAt,
              reviewGateExhaustionReason: exhaustionReason,
            },
            reasonMarkdown: exhaustionReason,
            updatedAt,
            haltCategory: "validation-failed",
            haltStage: "final-code-review",
          });
          return;
        }
        yield* startFixer({
          sourceThreadId,
          run: failedRun,
          status: "fixing",
          origin: "merge-gate",
          title: "Fix merge gate",
          promptText: buildMergeGateFixPrompt({
            run,
            reportMarkdown: directive.summaryMarkdown,
          }),
          createdAt: updatedAt,
        });
        return;
      }

      if (gateKind === "final") {
        const validatedRun: OrchestrationImplementationRun = {
          ...run,
          status: "publishing-change-request",
          finalValidation,
          finalValidationResults: [...directive.validations],
          integrationHeadSha: head.commitSha,
          validatedHeadSha: head.commitSha,
          activeValidationHeadSha: null,
          activeValidationKind: null,
          activeValidatorThreadId: null,
          retryableFailure: null,
          updatedAt,
        };
        yield* fileChangeRequest({ sourceThreadId, run: validatedRun, createdAt: updatedAt });
        return;
      }

      const validatedRun: OrchestrationImplementationRun = {
        ...run,
        status: "qa-reviewing",
        integrationHeadSha: head.commitSha,
        validatedHeadSha: null,
        activeValidationHeadSha: null,
        activeValidationKind: null,
        activeValidatorThreadId: null,
        retryableFailure: null,
        updatedAt,
      };
      if (run.qaExhaustedAt !== null || run.appReviewExhaustedAt !== null) {
        yield* startCodeReview({
          sourceThreadId,
          run: validatedRun,
          createdAt: updatedAt,
        });
        return;
      }
      yield* startBrowserReview({
        sourceThreadId,
        run: validatedRun,
        createdAt: updatedAt,
      });
    },
  );

  const handleFixResult = Effect.fn("ImplementationWorkflowReactor.handleFixResult")(function* (
    event: Extract<ImplementationWorkflowEvent, { type: "thread.activity-appended" }>,
    directive: FixDirective,
  ) {
    const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
    const run = findRunById(readModel, directive.runId);
    if (
      run === null ||
      (run.status !== "fixing" && run.status !== "code-review-fixing") ||
      run.activeFixerThreadId !== event.payload.threadId
    ) {
      return;
    }
    const sourceThreadId = findRunSourceThreadId({ readModel, run });
    if (sourceThreadId === null) return;
    const updatedAt = event.payload.activity.createdAt;

    if (directive.status !== "succeeded") {
      yield* handleFixerFailure({
        sourceThreadId,
        run,
        detailMarkdown: directive.notesMarkdown,
        createdAt: updatedAt,
      });
      return;
    }

    if (
      !focusedRepairValidationsPassed({
        finalCommands: [...run.launchSummary.validationCommands, NATIVE_MOBILE_VALIDATION_COMMAND],
        validations: directive.validations,
      })
    ) {
      yield* handleFixerFailure({
        sourceThreadId,
        run,
        detailMarkdown:
          "Fix result must include passing focused or documented sub-minute fast validation and must not run launch-level complete commands; the final gate after Code Review owns complete validation.",
        createdAt: updatedAt,
      });
      return;
    }
    const [head, status] = yield* Effect.all([
      gitWorkflow.resolveCommit({ cwd: run.orchestratorWorktreePath, ref: "HEAD" }),
      gitWorkflow.localStatus({ cwd: run.orchestratorWorktreePath }),
    ]);
    if (
      !status.isRepo ||
      status.refName !== run.orchestratorBranch ||
      status.hasWorkingTreeChanges
    ) {
      yield* handleFixerFailure({
        sourceThreadId,
        run,
        detailMarkdown: "Fixer must finish with a committed, clean orchestrator worktree.",
        createdAt: updatedAt,
      });
      return;
    }
    if (directive.commitSha !== undefined) {
      const reported = yield* gitWorkflow.resolveCommit({
        cwd: run.orchestratorWorktreePath,
        ref: directive.commitSha,
      });
      if (reported.commitSha !== head.commitSha) {
        yield* handleFixerFailure({
          sourceThreadId,
          run,
          detailMarkdown: `Fixer reported '${reported.commitSha}', but orchestrator HEAD is '${head.commitSha}'.`,
          createdAt: updatedAt,
        });
        return;
      }
    }

    if (run.activeValidationKind === "final") {
      const exhaustionReason = reviewGateExhaustionReason(run);
      const stoppedRun: OrchestrationImplementationRun = {
        ...run,
        integrationHeadSha: head.commitSha,
        activeValidationHeadSha: null,
        activeValidationKind: null,
        activeValidatorThreadId: null,
        activeFixerThreadId: null,
        fixOrigin: null,
        reviewGateExhaustedAt: updatedAt,
        reviewGateExhaustionReason: exhaustionReason,
        updatedAt,
      };
      yield* appendActivity({
        threadId: run.orchestratorThreadId,
        tone: "error",
        kind: "implementation-review-gate-exhausted",
        summary: "Final validation repair completed without another Code Review",
        payload: {
          runId: run.id,
          cycles: run.codeReviewAttemptCount,
          maxCycles: IMPLEMENTATION_RUN_MAX_REVIEW_GATE_CYCLES,
          reasonMarkdown: exhaustionReason,
        },
        createdAt: updatedAt,
      });
      yield* blockRun({
        sourceThreadId,
        run: stoppedRun,
        reasonMarkdown: exhaustionReason,
        updatedAt,
        haltCategory: "validation-failed",
        haltStage: "final-code-review",
      });
      return;
    }

    if (run.fixOrigin === "app-dev-stack" || run.fixOrigin === "app-review") {
      const repairedRun: OrchestrationImplementationRun = {
        ...run,
        status: "qa-reviewing",
        integrationHeadSha: head.commitSha,
        validatedHeadSha: null,
        activeValidationHeadSha: null,
        activeValidationKind: null,
        activeValidatorThreadId: null,
        activeFixerThreadId: null,
        fixOrigin: null,
        appReviewedHeadSha: null,
        activeAppReviewHeadSha: null,
        activeAppReviewThreadId: null,
        codeReviewedHeadSha: null,
        activeCodeReviewHeadSha: null,
        activeCodeReviewThreadId: null,
        retryableFailure: null,
        updatedAt,
      };
      yield* startBrowserReview({
        sourceThreadId,
        run: repairedRun,
        createdAt: updatedAt,
      });
      return;
    }

    const fixedRun: OrchestrationImplementationRun = {
      ...run,
      status: "integrating",
      integrationHeadSha: head.commitSha,
      activeValidationKind: null,
      activeFixerThreadId: null,
      fixOrigin: null,
      retryableFailure: null,
      updatedAt,
    };
    yield* startMergeGate({
      sourceThreadId,
      run: fixedRun,
      integration: {
        baseTicketId: null,
        baseRefName: fixedRun.orchestratorBranch,
        mergedTicketIds: [],
        conflictedTicketId: null,
        conflictedRefName: null,
        conflictedFiles: [],
        remainingTicketIds: [],
        remainingRefNames: [],
      },
      kind: "integration",
      createdAt: updatedAt,
    });
  });

  const startFixer = Effect.fn("ImplementationWorkflowReactor.startFixer")(function* (input: {
    readonly sourceThreadId: ThreadId;
    readonly run: OrchestrationImplementationRun;
    readonly status: "fixing" | "code-review-fixing";
    readonly origin: "merge-gate" | "app-dev-stack" | "app-review" | "code-review";
    readonly title: string;
    readonly promptText: string;
    readonly createdAt: string;
  }) {
    if (input.run.automationHalt !== null) return;
    const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
    const orchestratorThread = findThread(readModel, input.run.orchestratorThreadId);
    if (orchestratorThread === null) return;
    const [fixerStatus, fixerHead] = yield* Effect.all([
      gitWorkflow.localStatus({ cwd: input.run.orchestratorWorktreePath }),
      gitWorkflow.resolveCommit({ cwd: input.run.orchestratorWorktreePath, ref: "HEAD" }),
    ]);
    const expectedFixerHead =
      input.origin === "merge-gate"
        ? input.run.activeValidationHeadSha
        : input.origin === "code-review"
          ? input.run.activeCodeReviewHeadSha
          : (input.run.lastQaFailure?.headSha ?? input.run.activeAppReviewHeadSha);
    if (
      !fixerStatus.isRepo ||
      fixerStatus.refName !== input.run.orchestratorBranch ||
      fixerStatus.hasWorkingTreeChanges ||
      (expectedFixerHead !== null && expectedFixerHead !== fixerHead.commitSha)
    ) {
      yield* blockRun({
        sourceThreadId: input.sourceThreadId,
        run: input.run,
        retryableStage: "fixer",
        reasonMarkdown: `Repair requires clean expected HEAD '${expectedFixerHead ?? fixerHead.commitSha}' on '${input.run.orchestratorBranch}', but Git reports '${fixerStatus.refName ?? "detached HEAD"}' at '${fixerHead.commitSha}'${fixerStatus.hasWorkingTreeChanges ? " with uncommitted changes" : ""}.`,
        updatedAt: input.createdAt,
        humanBlocked: true,
      });
      return;
    }
    const fixerThreadId = yield* serverThreadId("implementation-fixer");
    const usesTdd = input.origin === "app-dev-stack" || input.origin === "app-review";
    const preservesReviewedBase =
      input.origin === "merge-gate" && input.run.activeValidationKind === "final";
    const fixingRun: OrchestrationImplementationRun = {
      ...input.run,
      status: input.status,
      activeFixerThreadId: fixerThreadId,
      fixOrigin: input.origin,
      appReviewedHeadSha: null,
      codeReviewedHeadSha: preservesReviewedBase ? input.run.codeReviewedHeadSha : null,
      ...(usesTdd
        ? {
            appDevStack: {
              ...input.run.appDevStack,
              status: "ensuring" as const,
              updatedAt: input.createdAt,
            },
          }
        : {}),
      updatedAt: input.createdAt,
    };
    yield* updateRun({
      sourceThreadId: input.sourceThreadId,
      run: fixingRun,
      createdAt: input.createdAt,
    });

    yield* orchestrationEngine.dispatch({
      type: "thread.create",
      commandId: yield* serverCommandId("implementation-fixer-create"),
      threadId: fixerThreadId,
      projectId: orchestratorThread.projectId,
      ownerUserId: orchestratorThread.ownerUserId,
      parentThreadId: input.run.orchestratorThreadId,
      workflowRole: "implementation-fixer",
      title: input.title,
      modelSelection: orchestratorThread.modelSelection,
      runtimeMode: WORKFLOW_AUTOMATION_RUNTIME_MODE,
      interactionMode: "implementation-workflow",
      branch: input.run.orchestratorBranch,
      worktreePath: input.run.orchestratorWorktreePath,
      createdAt: input.createdAt,
    });

    yield* orchestrationEngine.dispatch({
      type: "thread.turn.start",
      commandId: yield* serverCommandId("implementation-fixer-turn"),
      threadId: fixerThreadId,
      message: {
        messageId: yield* serverMessageId("implementation-fixer"),
        role: "user",
        text: appendWorkflowSkillCommandSection(
          input.promptText,
          usesTdd
            ? WORKFLOW_PROMPT_IDS.implementationTddCodex
            : WORKFLOW_PROMPT_IDS.implementationFixCodex,
        ),
        attachments: [],
      },
      workflowPromptId: usesTdd
        ? WORKFLOW_PROMPT_IDS.implementationTddCodex
        : WORKFLOW_PROMPT_IDS.implementationFixCodex,
      runtimeMode: orchestratorThread.runtimeMode,
      interactionMode: "implementation-workflow",
      createdAt: input.createdAt,
    });

    yield* appendActivity({
      threadId: input.run.orchestratorThreadId,
      tone: "info",
      kind: "implementation-fixer-started",
      summary: input.title,
      payload: {
        runId: input.run.id,
        fixerThreadId,
        mode: input.status,
        origin: input.origin,
      },
      createdAt: input.createdAt,
    });
  });

  const exhaustQa = Effect.fn("ImplementationWorkflowReactor.exhaustQa")(function* (input: {
    readonly sourceThreadId: ThreadId;
    readonly run: OrchestrationImplementationRun;
    readonly gate: "app-dev-stack" | "app-review";
    readonly createdAt: string;
  }) {
    const exhaustedRun: OrchestrationImplementationRun = {
      ...input.run,
      qaCycleCount: IMPLEMENTATION_RUN_MAX_QA_REPAIRS,
      qaExhaustedAt: input.run.qaExhaustedAt ?? input.createdAt,
      qaExhaustionReason: input.gate,
      appReviewExhaustedAt:
        input.gate === "app-review"
          ? (input.run.appReviewExhaustedAt ?? input.createdAt)
          : input.run.appReviewExhaustedAt,
      activeFixerThreadId: null,
      activeAppReviewHeadSha: null,
      activeAppReviewThreadId: null,
      fixOrigin: null,
      retryableFailure: null,
      updatedAt: input.createdAt,
    };
    if (input.run.qaExhaustedAt === null) {
      yield* appendActivity({
        threadId: input.run.orchestratorThreadId,
        tone: "error",
        kind: "implementation-qa-exhausted",
        summary: `Automated QA exhausted ${exhaustedRun.qaCycleCount}/${IMPLEMENTATION_RUN_MAX_QA_REPAIRS} repairs and stopped automation`,
        payload: {
          runId: input.run.id,
          gate: input.gate,
          repairs: exhaustedRun.qaCycleCount,
          reviewAttempts: input.run.qaAttemptCount,
          lastFailure: input.run.lastQaFailure,
        },
        createdAt: input.createdAt,
      });
    }
    yield* blockRun({
      sourceThreadId: input.sourceThreadId,
      run: exhaustedRun,
      reasonMarkdown:
        exhaustedRun.lastQaFailure?.detailMarkdown ??
        `${input.gate === "app-review" ? "App Review" : "App Dev Stack validation"} exhausted its repair budget.`,
      updatedAt: input.createdAt,
      haltCategory: "review-blocked",
      haltStage: "app-review",
    });
  });

  const startQaFixer = Effect.fn("ImplementationWorkflowReactor.startQaFixer")(function* (input: {
    readonly sourceThreadId: ThreadId;
    readonly run: OrchestrationImplementationRun;
    readonly origin: "app-dev-stack" | "app-review";
    readonly createdAt: string;
    readonly reviewId?: AppReviewId;
    readonly artifactMarkdown?: string;
    readonly failureMarkdown: string;
  }) {
    if (input.run.automationHalt !== null) return;
    if (input.run.qaCycleCount >= IMPLEMENTATION_RUN_MAX_QA_REPAIRS) {
      yield* exhaustQa({
        sourceThreadId: input.sourceThreadId,
        run: input.run,
        gate: input.origin,
        createdAt: input.createdAt,
      });
      return;
    }
    const repairRun: OrchestrationImplementationRun = {
      ...input.run,
      qaCycleCount: input.run.qaCycleCount + 1,
      activeFixerThreadId: null,
      retryableFailure: input.run.retryableFailure,
      updatedAt: input.createdAt,
    };
    if (input.origin === "app-review" && input.reviewId === undefined) {
      yield* blockRun({
        sourceThreadId: input.sourceThreadId,
        run: repairRun,
        reasonMarkdown: "Cannot launch a Browser App Review repair without an App Review record.",
        updatedAt: input.createdAt,
      });
      return;
    }
    yield* startFixer({
      sourceThreadId: input.sourceThreadId,
      run: repairRun,
      status: "fixing",
      origin: input.origin,
      title: `TDD repair ${repairRun.qaCycleCount}/${IMPLEMENTATION_RUN_MAX_QA_REPAIRS} · ${input.origin === "app-dev-stack" ? "AppDevStack" : "App Review"}`,
      promptText:
        input.origin === "app-dev-stack"
          ? buildAppDevStackFixPrompt({
              run: repairRun,
              diagnosticsMarkdown: input.failureMarkdown,
            })
          : buildFixPrompt({
              run: repairRun,
              reviewId: input.reviewId!,
              ...(input.artifactMarkdown === undefined
                ? {}
                : { artifactMarkdown: input.artifactMarkdown }),
            }),
      createdAt: input.createdAt,
    });
  });

  const handleFixerFailure = Effect.fn("ImplementationWorkflowReactor.handleFixerFailure")(
    function* (input: {
      readonly sourceThreadId: ThreadId;
      readonly run: OrchestrationImplementationRun;
      readonly detailMarkdown: string;
      readonly createdAt: string;
    }) {
      if (input.run.fixOrigin !== "app-dev-stack" && input.run.fixOrigin !== "app-review") {
        yield* blockRun({
          sourceThreadId: input.sourceThreadId,
          run: input.run,
          retryableStage: "fixer",
          reasonMarkdown: input.detailMarkdown,
          updatedAt: input.createdAt,
        });
        return;
      }
      const origin = input.run.fixOrigin;
      const headSha = yield* resolveQaHeadSha(input.run);
      const failedRun: OrchestrationImplementationRun = {
        ...input.run,
        lastQaFailure: {
          kind: origin,
          status: "fixer-blocked",
          detailMarkdown: input.detailMarkdown,
          reviewId:
            origin === "app-review"
              ? (input.run.lastQaFailure?.reviewId ?? input.run.appReviewIds.at(-1) ?? null)
              : null,
          headSha,
          occurredAt: input.createdAt,
        },
        activeFixerThreadId: null,
        updatedAt: input.createdAt,
      };
      const reviewId = failedRun.appReviewIds.at(-1);
      const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
      const sourceThread = findThread(readModel, input.sourceThreadId);
      const artifactMarkdown =
        failedRun.artifactSource === "proposed-plan" && sourceThread !== null
          ? fastFeatureArtifactMarkdown({ run: failedRun, sourceThread })
          : undefined;
      yield* startQaFixer({
        sourceThreadId: input.sourceThreadId,
        run: failedRun,
        origin,
        failureMarkdown: input.detailMarkdown,
        ...(reviewId === undefined ? {} : { reviewId: AppReviewId.make(reviewId) }),
        ...(artifactMarkdown === undefined ? {} : { artifactMarkdown }),
        createdAt: input.createdAt,
      });
    },
  );

  /**
   * Send App Review findings to a fresh TDD repair thread. The repair commits directly on the
   * already-integrated orchestrator branch, then the workflow re-enters App Review; there are no
   * worker branches left to merge at this point.
   */
  const restartAfterAppReviewFindings = Effect.fn(
    "ImplementationWorkflowReactor.restartAfterAppReviewFindings",
  )(function* (input: {
    readonly sourceThreadId: ThreadId;
    readonly run: OrchestrationImplementationRun;
    readonly reviewId: AppReviewId;
    readonly createdAt: string;
  }) {
    const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
    const sourceThread = findThread(readModel, input.sourceThreadId);
    const artifactMarkdown =
      input.run.artifactSource === "proposed-plan" && sourceThread !== null
        ? fastFeatureArtifactMarkdown({ run: input.run, sourceThread })
        : undefined;
    yield* startQaFixer({
      sourceThreadId: input.sourceThreadId,
      run: input.run,
      origin: "app-review",
      reviewId: input.reviewId,
      failureMarkdown:
        input.run.lastQaFailure?.detailMarkdown ?? "Browser App Review did not pass.",
      ...(artifactMarkdown === undefined ? {} : { artifactMarkdown }),
      createdAt: input.createdAt,
    });
  });

  const handleCodeReviewResult = Effect.fn("ImplementationWorkflowReactor.handleCodeReviewResult")(
    function* (
      event: Extract<ImplementationWorkflowEvent, { type: "thread.activity-appended" }>,
      directive: CodeReviewDirective,
    ) {
      const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
      const run = findRunById(readModel, directive.runId);
      if (run !== null && directive.ticketId !== undefined) {
        const sourceThreadId = findRunSourceThreadId({ readModel, run });
        const state = run.ticketStates.find(
          (candidate) =>
            candidate.ticketId === directive.ticketId &&
            candidate.codeReviewThreadId === event.payload.threadId,
        );
        if (sourceThreadId === null || state?.worktreePath == null || state.branch == null) return;
        const updatedAt = event.payload.activity.createdAt;
        if (
          directive.status === "blocked" &&
          directive.reportMarkdown === WORKFLOW_INTERRUPTION_ERROR_MESSAGE
        ) {
          const interruptedRun: OrchestrationImplementationRun = {
            ...run,
            ticketStates: run.ticketStates.map((candidate) =>
              candidate.ticketId === state.ticketId
                ? {
                    ...candidate,
                    status: "code-reviewing" as const,
                    codeReviewThreadId: null,
                    warningMarkdown: directive.reportMarkdown,
                    updatedAt,
                  }
                : candidate,
            ),
            updatedAt,
          };
          const blocked = yield* blockRun({
            sourceThreadId,
            run: interruptedRun,
            ticketId: state.ticketId,
            retryableStage: "code-review",
            reasonMarkdown: directive.reportMarkdown,
            updatedAt,
            haltStage: "code-review",
          });
          if (blocked.automationHalt === null) {
            yield* startTicketCodeReview({
              sourceThreadId,
              run: { ...blocked, status: "running" },
              ticketId: state.ticketId,
              warningMarkdown: directive.reportMarkdown,
              createdAt: updatedAt,
            });
          }
          return;
        }
        if (state.codeReviewPassCount >= 1) return;
        const [head, status] = yield* Effect.all([
          gitWorkflow.resolveCommit({ cwd: state.worktreePath, ref: "HEAD" }),
          gitWorkflow.localStatus({ cwd: state.worktreePath }),
        ]);
        const identityValid =
          status.isRepo && status.refName === state.branch && !status.hasWorkingTreeChanges;
        const reportedCommit =
          directive.commitSha === undefined
            ? null
            : yield* gitWorkflow
                .resolveCommit({ cwd: state.worktreePath, ref: directive.commitSha })
                .pipe(Effect.option);
        const findingsCommitValid =
          directive.status !== "findings" ||
          (reportedCommit !== null &&
            Option.isSome(reportedCommit) &&
            reportedCommit.value.commitSha === head.commitSha);
        const warningParts = [state.warningMarkdown ?? ""];
        if (directive.status === "blocked") warningParts.push(directive.reportMarkdown);
        if (!identityValid)
          warningParts.push(
            `Ticket Code Review left an invalid worktree state on '${state.branch}'.`,
          );
        if (!findingsCommitValid)
          warningParts.push("Ticket Code Review findings did not identify the resulting HEAD.");
        yield* appendActivity({
          threadId: run.orchestratorThreadId,
          tone:
            directive.status === "blocked" || !identityValid || !findingsCommitValid
              ? "error"
              : "info",
          kind: "implementation-ticket-code-review-finished",
          summary: `Ticket ${directive.ticketId} code review ${directive.status}`,
          payload: { runId: run.id, ticketId: directive.ticketId, status: directive.status },
          createdAt: updatedAt,
        });
        const completedReviewRun: OrchestrationImplementationRun = {
          ...run,
          ticketStates: run.ticketStates.map((candidate) =>
            candidate.ticketId === directive.ticketId
              ? {
                  ...candidate,
                  codeReviewPassCount: candidate.codeReviewPassCount + 1,
                  codeReviewOutcome: directive.status,
                  updatedAt,
                }
              : candidate,
          ),
          updatedAt,
        };
        if (directive.status === "blocked") {
          yield* blockRun({
            sourceThreadId,
            run: completedReviewRun,
            ticketId: state.ticketId,
            reasonMarkdown: directive.reportMarkdown,
            updatedAt,
            haltStage: "code-review",
          });
          return;
        }
        if (!identityValid || !findingsCommitValid) {
          yield* blockRun({
            sourceThreadId,
            run: completedReviewRun,
            ticketId: state.ticketId,
            retryableStage: "code-review",
            reasonMarkdown: warningParts.filter(Boolean).join("\n\n"),
            updatedAt,
            humanBlocked: true,
          });
          return;
        }
        yield* finishTicketReviewChain({
          sourceThreadId,
          run: completedReviewRun,
          ticketId: directive.ticketId,
          commitSha: head.commitSha,
          codeReviewOutcome: directive.status,
          usableBranch: true,
          warningMarkdown: warningParts.filter(Boolean).join("\n\n") || null,
          createdAt: updatedAt,
        });
        return;
      }
      if (
        run === null ||
        run.status !== "code-reviewing" ||
        run.activeCodeReviewThreadId !== event.payload.threadId
      ) {
        return;
      }
      const sourceThreadId = findRunSourceThreadId({ readModel, run });
      if (sourceThreadId === null) return;
      const updatedAt = event.payload.activity.createdAt;
      const finalPass = isFinalCodeReviewPass(run);
      if (
        directive.status === "blocked" &&
        directive.reportMarkdown === WORKFLOW_INTERRUPTION_ERROR_MESSAGE
      ) {
        const interruptedRun: OrchestrationImplementationRun = {
          ...run,
          activeCodeReviewHeadSha: null,
          activeCodeReviewThreadId: null,
          updatedAt,
        };
        const blocked = yield* blockRun({
          sourceThreadId,
          run: interruptedRun,
          retryableStage: "code-review",
          reasonMarkdown: directive.reportMarkdown,
          updatedAt,
          haltStage: finalPass ? "final-code-review" : "code-review",
        });
        if (blocked.automationHalt === null) {
          yield* startCodeReview({
            sourceThreadId,
            run: { ...blocked, status: "code-reviewing" },
            createdAt: updatedAt,
          });
        }
        return;
      }
      if (finalPass && run.finalCodeReviewPassCount >= IMPLEMENTATION_RUN_MAX_REVIEW_GATE_CYCLES) {
        return;
      }
      const [head, status] = yield* Effect.all([
        gitWorkflow.resolveCommit({ cwd: run.orchestratorWorktreePath, ref: "HEAD" }),
        gitWorkflow.localStatus({ cwd: run.orchestratorWorktreePath }),
      ]);

      yield* appendActivity({
        threadId: run.orchestratorThreadId,
        tone: directive.status === "blocked" ? "error" : "info",
        kind: "implementation-code-review-finished",
        summary: `Code review ${directive.status}`,
        payload: { runId: run.id, status: directive.status },
        createdAt: updatedAt,
      });

      if (directive.status === "blocked") {
        const blockedRun: OrchestrationImplementationRun = {
          ...run,
          activeCodeReviewHeadSha: null,
          activeCodeReviewThreadId: null,
          finalCodeReviewPassCount: finalPass
            ? run.finalCodeReviewPassCount + 1
            : run.finalCodeReviewPassCount,
          latestCodeReviewReportMarkdown: directive.reportMarkdown,
          reviewGateExhaustedAt: updatedAt,
          reviewGateExhaustionReason: directive.reportMarkdown,
          updatedAt,
        };
        yield* blockRun({
          sourceThreadId,
          run: blockedRun,
          reasonMarkdown: directive.reportMarkdown,
          updatedAt,
          haltStage: "final-code-review",
        });
        return;
      }

      // The reviewer lands its own fixes, so HEAD has legitimately advanced past the commit it was
      // launched against. Require the worktree to be clean on the orchestrator branch, and require the
      // reviewer to name the commit it produced so publication targets an exact, verified sha.
      if (
        !status.isRepo ||
        status.refName !== run.orchestratorBranch ||
        status.hasWorkingTreeChanges
      ) {
        yield* blockRun({
          sourceThreadId,
          run,
          retryableStage: "code-review",
          reasonMarkdown: `Code Review must finish with a committed, clean worktree on branch '${run.orchestratorBranch}', but Git reports '${status.refName ?? "detached HEAD"}'${status.hasWorkingTreeChanges ? " with uncommitted changes" : ""}.`,
          updatedAt,
          humanBlocked: true,
        });
        return;
      }

      if (directive.status === "clean") {
        if (run.activeCodeReviewHeadSha !== head.commitSha) {
          yield* blockRun({
            sourceThreadId,
            run,
            retryableStage: "code-review",
            reasonMarkdown: `Code Review reported "clean" but HEAD moved from the reviewed commit '${run.activeCodeReviewHeadSha ?? "unknown"}' to '${head.commitSha}'. Report "findings" with a commitSha when the review lands changes.`,
            updatedAt,
          });
          return;
        }
        const reviewedRun: OrchestrationImplementationRun = {
          ...run,
          retryableFailure:
            run.retryableFailure?.stage === "code-review" &&
            run.retryableFailure.ticketId === undefined
              ? null
              : run.retryableFailure,
          codeReviewedHeadSha: head.commitSha,
          activeCodeReviewHeadSha: null,
          activeCodeReviewThreadId: null,
          latestCodeReviewReportMarkdown: directive.reportMarkdown,
          validatedHeadSha: null,
          finalCodeReviewPassCount: finalPass
            ? run.finalCodeReviewPassCount + 1
            : run.finalCodeReviewPassCount,
          updatedAt,
        };
        if (
          run.appReviewedHeadSha === null &&
          run.qaExhaustedAt === null &&
          run.appReviewExhaustedAt === null &&
          !(
            run.appReviewStrategy === "nested-workflow" &&
            run.latestAppReviewWorkflowOutcome !== null
          )
        ) {
          yield* startBrowserReview({
            sourceThreadId,
            run: { ...reviewedRun, status: "qa-reviewing" },
            createdAt: updatedAt,
          });
          return;
        }
        yield* startMergeGate({
          sourceThreadId,
          run: reviewedRun,
          integration: {
            baseTicketId: null,
            baseRefName: run.orchestratorBranch,
            mergedTicketIds: [],
            conflictedTicketId: null,
            conflictedRefName: null,
            conflictedFiles: [],
            remainingTicketIds: [],
            remainingRefNames: [],
          },
          kind: "final",
          createdAt: updatedAt,
        });
        return;
      }

      if (directive.commitSha === undefined) {
        yield* blockRun({
          sourceThreadId,
          run,
          retryableStage: "code-review",
          reasonMarkdown:
            "Code Review reported findings without naming the commit that fixes them. Fix the findings, commit them, and report commitSha.",
          updatedAt,
        });
        return;
      }

      const reportedHead = yield* gitWorkflow.resolveCommit({
        cwd: run.orchestratorWorktreePath,
        ref: directive.commitSha,
      });
      if (reportedHead.commitSha !== head.commitSha) {
        yield* blockRun({
          sourceThreadId,
          run,
          retryableStage: "code-review",
          reasonMarkdown: `Code Review reported commit '${reportedHead.commitSha}', but the orchestrator branch HEAD is '${head.commitSha}'.`,
          updatedAt,
        });
        return;
      }

      if (
        !focusedRepairValidationsPassed({
          finalCommands: [
            ...run.launchSummary.validationCommands,
            NATIVE_MOBILE_VALIDATION_COMMAND,
          ],
          validations: directive.validations,
        })
      ) {
        yield* blockRun({
          sourceThreadId,
          run,
          retryableStage: "code-review",
          reasonMarkdown:
            "Code Review changed code without passing focused validation, or ran a launch-level complete command before the final gate.",
          updatedAt,
        });
        return;
      }

      const reviewedRun: OrchestrationImplementationRun = {
        ...run,
        retryableFailure:
          run.retryableFailure?.stage === "code-review" &&
          run.retryableFailure.ticketId === undefined
            ? null
            : run.retryableFailure,
        codeReviewedHeadSha: head.commitSha,
        activeCodeReviewHeadSha: null,
        activeCodeReviewThreadId: null,
        latestCodeReviewReportMarkdown: directive.reportMarkdown,
        validatedHeadSha: null,
        finalCodeReviewPassCount: finalPass
          ? run.finalCodeReviewPassCount + 1
          : run.finalCodeReviewPassCount,
        updatedAt,
      };
      const needsFreshAppReview =
        run.appReviewedHeadSha === null &&
        run.qaExhaustedAt === null &&
        run.appReviewExhaustedAt === null &&
        !(
          run.appReviewStrategy === "nested-workflow" && run.latestAppReviewWorkflowOutcome !== null
        );
      yield* startMergeGate({
        sourceThreadId,
        run: reviewedRun,
        integration: {
          baseTicketId: null,
          baseRefName: run.orchestratorBranch,
          mergedTicketIds: [],
          conflictedTicketId: null,
          conflictedRefName: null,
          conflictedFiles: [],
          remainingTicketIds: [],
          remainingRefNames: [],
        },
        // Code Review owns its fixes, but those fixes have not been exercised by the browser. Run
        // the focused integration gate and App Review on the new HEAD before complete validation.
        kind: needsFreshAppReview ? "integration" : "final",
        preserveCodeReviewedHead: needsFreshAppReview,
        createdAt: updatedAt,
      });
    },
  );

  const handleAppReviewUpdated = Effect.fn("ImplementationWorkflowReactor.handleAppReviewUpdated")(
    function* (event: Extract<ImplementationWorkflowEvent, { type: "thread.app-review-updated" }>) {
      if (event.payload.status === undefined) return;
      const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
      const run = findRunByAppReview(
        readModel,
        event.payload.reviewId,
        event.payload.sourceThreadId,
      );
      if (
        run === null ||
        run.status !== "qa-reviewing" ||
        run.appReviewIds.at(-1) !== event.payload.reviewId
      ) {
        return;
      }
      const sourceThreadId = findRunSourceThreadId({ readModel, run });
      if (sourceThreadId === null) return;
      const [head, status] = yield* Effect.all([
        gitWorkflow.resolveCommit({ cwd: run.orchestratorWorktreePath, ref: "HEAD" }),
        gitWorkflow.localStatus({ cwd: run.orchestratorWorktreePath }),
      ]);
      if (
        run.activeAppReviewHeadSha !== head.commitSha ||
        !status.isRepo ||
        status.refName !== run.orchestratorBranch ||
        status.hasWorkingTreeChanges
      ) {
        yield* blockRun({
          sourceThreadId,
          run,
          retryableStage: "app-review",
          reasonMarkdown: `App Review result is stale or the orchestrator worktree is not clean at reviewed HEAD '${run.activeAppReviewHeadSha ?? "unknown"}'.`,
          updatedAt: event.payload.updatedAt,
        });
        return;
      }

      if (event.payload.status === "passed" || event.payload.status === "failed") {
        yield* appendActivity({
          threadId: run.orchestratorThreadId,
          tone: event.payload.status === "passed" ? "info" : "error",
          kind: "implementation-browser-review-finished",
          summary: `Browser app review ${event.payload.status}`,
          payload: {
            runId: run.id,
            reviewId: event.payload.reviewId,
            status: event.payload.status,
          },
          createdAt: event.payload.updatedAt,
        });
      }

      if (event.payload.status === "passed") {
        const passedRun: OrchestrationImplementationRun = {
          ...run,
          appReviewedHeadSha: head.commitSha,
          activeAppReviewHeadSha: null,
          activeAppReviewThreadId: null,
          lastQaFailure: null,
          retryableFailure: null,
          updatedAt: event.payload.updatedAt,
        };
        if (passedAppReviewContinuation(passedRun, head.commitSha) === "final-validation") {
          yield* startMergeGate({
            sourceThreadId,
            run: passedRun,
            integration: {
              baseTicketId: null,
              baseRefName: passedRun.orchestratorBranch,
              mergedTicketIds: [],
              conflictedTicketId: null,
              conflictedRefName: null,
              conflictedFiles: [],
              remainingTicketIds: [],
              remainingRefNames: [],
            },
            kind: "final",
            createdAt: event.payload.updatedAt,
          });
        } else {
          yield* startCodeReview({
            sourceThreadId,
            run: passedRun,
            createdAt: event.payload.updatedAt,
          });
        }
        return;
      }

      if (event.payload.status !== "failed") return;

      // Record the failure before the shared QA repair launcher consumes another fresh slot or
      // continues best-effort after the repair budget is exhausted.
      const failedRun: OrchestrationImplementationRun = {
        ...run,
        lastQaFailure: {
          kind: "app-review",
          status: event.payload.status,
          detailMarkdown:
            findThread(readModel, run.orchestratorThreadId)?.appReviews.find(
              (review) => review.id === event.payload.reviewId,
            )?.document.summary ?? `Browser App Review ${event.payload.status}.`,
          reviewId: event.payload.reviewId,
          headSha: head.commitSha,
          occurredAt: event.payload.updatedAt,
        },
      };

      yield* restartAfterAppReviewFindings({
        sourceThreadId,
        run: {
          ...failedRun,
          activeAppReviewHeadSha: null,
          activeAppReviewThreadId: null,
        },
        reviewId: event.payload.reviewId,
        createdAt: event.payload.updatedAt,
      });
    },
  );

  const handleChangeRequestRetry = Effect.fn(
    "ImplementationWorkflowReactor.handleChangeRequestRetry",
  )(function* (
    event: Extract<
      ImplementationWorkflowEvent,
      { type: "thread.implementation-change-request-retry-requested" }
    >,
  ) {
    const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
    const run = findRunById(readModel, event.payload.run.id) ?? event.payload.run;
    const sourceThreadId =
      findRunSourceThreadId({ readModel, run }) ?? (yield* sourceThreadIdForRun(run));
    if (sourceThreadId === null) return;
    yield* fileChangeRequest({
      sourceThreadId,
      run: {
        ...run,
        changeRequestFailure: null,
        updatedAt: event.occurredAt,
      },
      createdAt: event.occurredAt,
    });
  });

  const resumeRetryableRun = Effect.fn("ImplementationWorkflowReactor.resumeRetryableRun")(
    function* (input: {
      readonly sourceThreadId: ThreadId;
      readonly run: OrchestrationImplementationRun;
      readonly createdAt: string;
    }) {
      const failure = input.run.retryableFailure;
      if (failure === null || failure.attemptCount > failure.maxAttempts) return;
      const readModel = yield* projectionSnapshotQuery.getCommandReadModel();

      if (failure.stage === "change-request") {
        yield* fileChangeRequest({
          sourceThreadId: input.sourceThreadId,
          run: input.run,
          createdAt: input.createdAt,
        });
        return;
      }
      if (failure.stage === "change-request-babysit") {
        yield* startChangeRequestBabysitter({
          sourceThreadId: input.sourceThreadId,
          run: {
            ...input.run,
            status: "babysitting-change-request",
            retryableFailure: input.run.retryableFailure,
          },
          createdAt: input.createdAt,
        });
        return;
      }
      if (failure.stage === "integration") {
        yield* integrateCompletedRun({
          sourceThreadId: input.sourceThreadId,
          run: input.run,
          createdAt: input.createdAt,
        });
        return;
      }
      if (failure.stage === "merge-gate") {
        yield* startMergeGate({
          sourceThreadId: input.sourceThreadId,
          run: {
            ...input.run,
            status: "integrating",
            activeValidatorThreadId: null,
            activeValidationHeadSha: null,
            activeValidationKind: null,
          },
          integration: {
            baseTicketId: null,
            baseRefName: input.run.orchestratorBranch,
            mergedTicketIds: [],
            conflictedTicketId: null,
            conflictedRefName: null,
            conflictedFiles: [],
            remainingTicketIds: [],
            remainingRefNames: [],
          },
          kind: input.run.activeValidationKind ?? "integration",
          createdAt: input.createdAt,
        });
        return;
      }
      if (failure.stage === "app-review") {
        if (input.run.appReviewStrategy === "nested-workflow") {
          yield* startBrowserReview({
            sourceThreadId: input.sourceThreadId,
            run: {
              ...input.run,
              status: "qa-reviewing",
              latestAppReviewWorkflowOutcome: null,
              appReviewUnblockAttemptCount: failure.humanBlocked
                ? 0
                : input.run.appReviewUnblockAttemptCount,
              retryableFailure: input.run.retryableFailure,
              updatedAt: input.createdAt,
            },
            createdAt: input.createdAt,
          });
          return;
        }
        if (input.run.qaExhaustedAt !== null || input.run.appReviewExhaustedAt !== null) {
          yield* continueAfterQaExhaustion({
            sourceThreadId: input.sourceThreadId,
            run: {
              ...input.run,
              retryableFailure: input.run.retryableFailure,
              updatedAt: input.createdAt,
            },
            createdAt: input.createdAt,
          });
          return;
        }
        const reviewId = input.run.appReviewIds.at(-1);
        const latestReview =
          reviewId === undefined
            ? undefined
            : findThread(readModel, input.run.orchestratorThreadId)?.appReviews.find(
                (review) => review.id === reviewId,
              );
        if (latestReview?.status === "failed") {
          yield* restartAfterAppReviewFindings({
            sourceThreadId: input.sourceThreadId,
            run: {
              ...input.run,
              activeAppReviewThreadId: null,
              activeAppReviewHeadSha: null,
            },
            reviewId: latestReview.id,
            createdAt: input.createdAt,
          });
          return;
        }
        yield* startBrowserReview({
          sourceThreadId: input.sourceThreadId,
          run: {
            ...input.run,
            activeAppReviewThreadId: null,
            activeAppReviewHeadSha: null,
          },
          createdAt: input.createdAt,
        });
        return;
      }
      if (failure.stage === "app-dev-stack") {
        if (input.run.lastQaFailure === null && failure.attemptCount < failure.maxAttempts) {
          yield* startBrowserReview({
            sourceThreadId: input.sourceThreadId,
            run: {
              ...input.run,
              activeAppReviewThreadId: null,
              activeAppReviewHeadSha: null,
            },
            createdAt: input.createdAt,
          });
          return;
        }
        const failureDetail = input.run.lastQaFailure?.detailMarkdown ?? failure.detail;
        const failureHeadSha = yield* resolveQaHeadSha(input.run);
        const failedRun: OrchestrationImplementationRun = {
          ...input.run,
          lastQaFailure: input.run.lastQaFailure ?? {
            kind: "app-dev-stack",
            status: "startup-timeout",
            detailMarkdown: failureDetail,
            reviewId: null,
            headSha: failureHeadSha,
            occurredAt: input.createdAt,
          },
        };
        yield* startQaFixer({
          sourceThreadId: input.sourceThreadId,
          run: failedRun,
          origin: "app-dev-stack",
          failureMarkdown: failureDetail,
          createdAt: input.createdAt,
        });
        return;
      }
      if (failure.stage === "code-review") {
        yield* startCodeReview({
          sourceThreadId: input.sourceThreadId,
          run: input.run,
          createdAt: input.createdAt,
        });
        return;
      }
      if (failure.stage === "fixer") {
        const origin =
          input.run.fixOrigin ??
          (input.run.status === "code-review-fixing" ? "code-review" : "app-review");
        const reviewId = input.run.appReviewIds.at(-1);
        if (origin === "app-review" && reviewId === undefined) {
          yield* blockRun({
            sourceThreadId: input.sourceThreadId,
            run: input.run,
            reasonMarkdown:
              "Cannot retry the Browser App Review fixer without an App Review record.",
            updatedAt: input.createdAt,
          });
          return;
        }
        if (origin === "app-dev-stack" || origin === "app-review") {
          yield* handleFixerFailure({
            sourceThreadId: input.sourceThreadId,
            run: { ...input.run, fixOrigin: origin },
            detailMarkdown: input.run.lastQaFailure?.detailMarkdown ?? failure.detail,
            createdAt: input.createdAt,
          });
          return;
        }
        yield* startFixer({
          sourceThreadId: input.sourceThreadId,
          run: { ...input.run, activeFixerThreadId: null },
          status: origin === "code-review" ? "code-review-fixing" : "fixing",
          origin,
          title: origin === "merge-gate" ? "Fix merge gate failures" : "Fix code review findings",
          promptText:
            origin === "merge-gate"
              ? buildMergeGateFixPrompt({
                  run: input.run,
                  reportMarkdown: failure.detail,
                })
              : buildCodeReviewFixPrompt({
                  run: input.run,
                  reportMarkdown: input.run.latestCodeReviewReportMarkdown ?? failure.detail,
                }),
          createdAt: input.createdAt,
        });
        return;
      }
      if (failure.stage === "worker-setup" || failure.stage === "worker-execution") {
        const resumedRun: OrchestrationImplementationRun = {
          ...input.run,
          status: "running",
          ticketStates: input.run.ticketStates.map((state) =>
            state.status === "failed"
              ? {
                  ...state,
                  status: "ready" as const,
                  workerThreadId: null,
                  workerResult: null,
                  updatedAt: input.createdAt,
                }
              : state,
          ),
          updatedAt: input.createdAt,
        };
        yield* updateRun({
          sourceThreadId: input.sourceThreadId,
          run: resumedRun,
          createdAt: input.createdAt,
        });
        yield* startReadyWorkers({
          sourceThreadId: input.sourceThreadId,
          run: resumedRun,
          createdAt: input.createdAt,
        });
        return;
      }
      if (input.run.artifactSource === "proposed-plan") {
        yield* ensureFastFeatureRun({
          sourceThreadId: input.sourceThreadId,
          run: input.run,
          createdAt: input.createdAt,
        });
      }
    },
  );

  const handleRunRetry = Effect.fn("ImplementationWorkflowReactor.handleRunRetry")(function* (
    event: Extract<
      ImplementationWorkflowEvent,
      { type: "thread.implementation-run-retry-requested" }
    >,
  ) {
    const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
    const run = findRunById(readModel, event.payload.run.id) ?? event.payload.run;
    const sourceThreadId = findRunSourceThreadId({ readModel, run });
    if (sourceThreadId === null || run.retryableFailure === null) return;
    yield* resumeRetryableRun({ sourceThreadId, run, createdAt: event.occurredAt }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : blockRun({
              sourceThreadId,
              run,
              retryableStage: run.retryableFailure?.stage ?? "worktree-setup",
              reasonMarkdown: `Fast feature retry failed.\n\n\`\`\`\n${Cause.pretty(cause)}\n\`\`\``,
              updatedAt: event.occurredAt,
            }),
      ),
    );
  });

  /**
   * Stop the nested App Review a ticket is about to stop waiting on.
   *
   * Rewinding a ticket past its App Review drops the pointer, but the review
   * itself is a live controller thread with a live session. Left running it
   * keeps reviewing a worktree nobody is waiting for, and keeps reporting
   * against a ticket that has moved on.
   */
  const cancelTicketAppReview = Effect.fn("ImplementationWorkflowReactor.cancelTicketAppReview")(
    function* (input: {
      readonly run: OrchestrationImplementationRun;
      readonly ticketId: string;
      readonly reason: string;
      readonly createdAt: string;
    }) {
      const nestedRunId = input.run.ticketStates.find(
        (state) => state.ticketId === input.ticketId,
      )?.appReviewWorkflowRunId;
      if (nestedRunId == null) return;
      const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
      const nestedRun = (readModel.appReviewWorkflowRuns ?? []).find(
        (candidate) => candidate.id === nestedRunId,
      );
      if (nestedRun === undefined || nestedRun.status !== "running") return;
      yield* orchestrationEngine.dispatch({
        type: "thread.app-review-workflow.cancel",
        commandId: yield* serverCommandId("implementation-ticket-app-review-cancel"),
        threadId: nestedRun.controllerThreadId,
        runId: nestedRun.id,
        reason: input.reason,
        createdAt: input.createdAt,
      });
    },
  );

  /**
   * Resume a ticket's nested App Review once its repair has landed.
   *
   * The combined post-merge review gets its preview refresh from
   * `startBrowserReview`; this is the ticket-scoped counterpart. Re-ensure the
   * ticket worktree's App Dev Stack so the next cycle reviews the repaired
   * code, then resume the parked run with the refreshed frontend URL. A stack
   * that yields no frontend cancels the review instead, which routes the
   * ticket to Code Review with a warning the same way a launch without a
   * frontend does.
   */
  const resumeTicketAppReview = Effect.fn("ImplementationWorkflowReactor.resumeTicketAppReview")(
    function* (input: {
      readonly run: OrchestrationImplementationRun;
      readonly ticketId: string;
      readonly nestedRun: AppReviewWorkflowRun;
      readonly createdAt: string;
    }) {
      const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
      const orchestratorThread = findThread(readModel, input.run.orchestratorThreadId);
      const state = input.run.ticketStates.find(
        (candidate) => candidate.ticketId === input.ticketId,
      );
      if (orchestratorThread === null || state?.worktreePath == null) return;
      const stackResult = yield* appDevStackManager
        .autoCreate({
          worktreePath: state.worktreePath,
          displayName: `Ticket ${input.ticketId}`,
          gitBranch: state.branch ?? input.run.orchestratorBranch,
          workflowId: orchestratorThread.workflowContext?.workflowId,
        })
        .pipe(Effect.result);
      const frontendUrl = stackResult._tag === "Success" ? stackResult.success.frontendUrl : null;
      if (frontendUrl === null) {
        yield* cancelTicketAppReview({
          run: input.run,
          ticketId: input.ticketId,
          reason: `Ticket App Review could not resume after its repair because the App Dev Stack did not provide a frontend URL${stackResult._tag === "Failure" ? `: ${errorDetail(stackResult.failure)}` : "."}`,
          createdAt: input.createdAt,
        });
        return;
      }
      yield* orchestrationEngine.dispatch({
        type: "thread.app-review-workflow.resume",
        commandId: yield* serverCommandId("implementation-ticket-app-review-preview-refresh"),
        threadId: input.nestedRun.controllerThreadId,
        runId: input.nestedRun.id,
        previewTargets: [frontendUrl],
        workspaceRevision: input.nestedRun.workspaceRevision,
        createdAt: input.createdAt,
      });
    },
  );

  /**
   * Start one stage of a run again, in a fresh thread.
   *
   * A ticket target rewinds that ticket to the named stage and reopens every
   * ticket the failure took down with it, so a single bad review does not
   * strand the rest of the graph. A run target re-enters a stage the whole run
   * shares. The previous threads are left intact and still linked to the
   * ticket, so the earlier attempt stays readable next to the new one.
   */
  const handleRunRerun = Effect.fn("ImplementationWorkflowReactor.handleRunRerun")(function* (
    event: Extract<
      ImplementationWorkflowEvent,
      { type: "thread.implementation-run-rerun-requested" }
    >,
  ) {
    const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
    const run = findRunById(readModel, event.payload.run.id) ?? event.payload.run;
    const sourceThreadId = findRunSourceThreadId({ readModel, run });
    if (sourceThreadId === null) return;
    const target = event.payload.target;
    const createdAt = event.occurredAt;
    const resumesCanceledFinalCodeReview =
      run.status === "canceled" && target.kind === "run" && target.stage === "code-review";

    // A pause can land after the decider accepted this request but before the
    // reactor handles it. Leave the run untouched so worker setup cannot turn
    // the pause into a failed ticket and dependency cascade.
    if (
      implementationRunRerunIsPaused({
        threads: readModel.threads,
        sourceThreadId,
        orchestratorThreadId: run.orchestratorThreadId,
      })
    ) {
      yield* appendActivity({
        threadId: run.orchestratorThreadId,
        tone: "info",
        kind: "implementation-rerun-skipped",
        summary: "Stage re-run skipped while the workflow is paused",
        payload: { runId: run.id, target },
        createdAt,
      });
      return;
    }

    if (
      run.automationHalt !== null &&
      (target.kind === "ticket"
        ? !automationHaltMatchesTicketRerun({
            halt: run.automationHalt,
            ticketId: target.ticketId,
            stage: target.stage,
          })
        : !automationHaltMatchesRunRerun({ halt: run.automationHalt, stage: target.stage }))
    ) {
      yield* appendActivity({
        threadId: run.orchestratorThreadId,
        tone: "info",
        kind: "implementation-rerun-skipped",
        summary: "Stage re-run did not match the halted stage",
        payload: { runId: run.id, target, automationHalt: run.automationHalt },
        createdAt,
      });
      return;
    }

    yield* appendActivity({
      threadId: run.orchestratorThreadId,
      tone: "info",
      kind: "implementation-rerun-requested",
      summary:
        target.kind === "ticket"
          ? `Starting ${target.stage} again for ticket ${target.ticketId}`
          : `Starting ${target.stage} again`,
      payload: { runId: run.id, target },
      createdAt,
    });

    if (target.kind === "run") {
      const rerunRun = clearRunStageForRerun({ run, stage: target.stage, updatedAt: createdAt });
      yield* updateRun({
        sourceThreadId,
        run: rerunRun,
        createdAt,
        ...(resumesCanceledFinalCodeReview ? { allowCanceledFinalCodeReviewRerun: true } : {}),
      });
      switch (target.stage) {
        case "integration":
          yield* integrateCompletedRun({ sourceThreadId, run: rerunRun, createdAt });
          return;
        case "merge-gate":
          // A merge-gate re-run validates the branch as it stands; it merges
          // nothing, so the prompt describes an integration that moved nothing.
          yield* startMergeGate({
            sourceThreadId,
            run: rerunRun,
            integration: {
              baseTicketId: null,
              baseRefName: rerunRun.orchestratorBranch,
              mergedTicketIds: [],
              conflictedTicketId: null,
              conflictedRefName: null,
              conflictedFiles: [],
              remainingTicketIds: [],
              remainingRefNames: [],
            },
            kind: "integration",
            createdAt,
          });
          return;
        case "app-review":
          yield* startBrowserReview({ sourceThreadId, run: rerunRun, createdAt });
          return;
        case "code-review":
          yield* startCodeReview({
            sourceThreadId,
            run: rerunRun,
            createdAt,
            ...(resumesCanceledFinalCodeReview ? { skipAppReviewRequirement: true } : {}),
          });
          return;
      }
    }

    if (target.stage !== "code-review") {
      yield* cancelTicketAppReview({
        run,
        ticketId: target.ticketId,
        reason: "The ticket was sent back to an earlier stage.",
        createdAt,
      });
    }
    const rerunRun = reopenTicketForRerun({
      run,
      ticketId: target.ticketId,
      stage: target.stage,
      updatedAt: createdAt,
    });
    yield* updateRun({ sourceThreadId, run: rerunRun, createdAt });
    switch (target.stage) {
      case "implementation":
        yield* startReadyWorkers({ sourceThreadId, run: rerunRun, createdAt });
        return;
      case "app-review":
        yield* startTicketAppReview({
          sourceThreadId,
          run: rerunRun,
          ticketId: target.ticketId,
          createdAt,
        });
        return;
      case "code-review":
        yield* startTicketCodeReview({
          sourceThreadId,
          run: rerunRun,
          ticketId: target.ticketId,
          createdAt,
        });
        return;
    }
  });

  /**
   * Clear a stage and leave it for the run to reach again on its own.
   *
   * The same rewind a re-run does, without starting anything: what the stage
   * produced goes, the branch and its commits stay. A cleared ticket rests at
   * `blocked`, which is where a ticket waits its turn, so the run starts it once
   * its dependencies have succeeded rather than the instant it is cleared. That
   * is what makes clearing a whole wave useful: the wave rebuilds in dependency
   * order on top of whatever the wave before it ended up producing.
   */
  const handleRunReset = Effect.fn("ImplementationWorkflowReactor.handleRunReset")(function* (
    event: Extract<
      ImplementationWorkflowEvent,
      { type: "thread.implementation-run-reset-requested" }
    >,
  ) {
    const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
    const run = findRunById(readModel, event.payload.run.id) ?? event.payload.run;
    const sourceThreadId = findRunSourceThreadId({ readModel, run });
    if (sourceThreadId === null) return;
    const target = event.payload.target;
    const createdAt = event.occurredAt;

    yield* appendActivity({
      threadId: run.orchestratorThreadId,
      tone: "info",
      kind: "implementation-rerun-requested",
      summary:
        target.kind === "ticket"
          ? `Cleared ${target.stage} for ticket ${target.ticketId}`
          : `Cleared ${target.stage}`,
      payload: { runId: run.id, target, cleared: true },
      createdAt,
    });

    if (target.kind === "run") {
      yield* updateRun({
        sourceThreadId,
        run: clearRunStageForRerun({ run, stage: target.stage, updatedAt: createdAt }),
        createdAt,
      });
      return;
    }

    if (target.stage !== "code-review") {
      yield* cancelTicketAppReview({
        run,
        ticketId: target.ticketId,
        reason: "The ticket was cleared.",
        createdAt,
      });
    }
    const rewound = reopenTicketForRerun({
      run,
      ticketId: target.ticketId,
      stage: target.stage,
      updatedAt: createdAt,
    });
    // A re-run wants the worker now; clearing wants it in turn. Every other
    // stage already rests on the status it resumes at.
    const clearedRun =
      target.stage === "implementation"
        ? {
            ...rewound,
            ticketStates: rewound.ticketStates.map((state) =>
              state.ticketId === target.ticketId && state.status === "ready"
                ? { ...state, status: "blocked" as const }
                : state,
            ),
          }
        : rewound;
    yield* updateRun({ sourceThreadId, run: clearedRun, createdAt });
  });

  /**
   * Record a skip, and let the run reach the skipped stage to act on it.
   *
   * Nothing is started or stopped here. A stage already running keeps running,
   * because a skip is a decision about the next time the run would start it;
   * stopping what is in flight is the caller's move.
   */
  const handleRunSkipSet = Effect.fn("ImplementationWorkflowReactor.handleRunSkipSet")(function* (
    event: Extract<ImplementationWorkflowEvent, { type: "thread.implementation-run-skip-set" }>,
  ) {
    const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
    const run = findRunById(readModel, event.payload.run.id) ?? event.payload.run;
    const sourceThreadId = findRunSourceThreadId({ readModel, run });
    if (sourceThreadId === null) return;
    yield* updateRun({
      sourceThreadId,
      run: {
        ...run,
        skips: applyImplementationSkip(run.skips, event.payload.target, event.payload.skipped),
        updatedAt: event.occurredAt,
      },
      createdAt: event.occurredAt,
    });
  });

  const handleRunCancel = Effect.fn("ImplementationWorkflowReactor.handleRunCancel")(function* (
    event: Extract<
      ImplementationWorkflowEvent,
      { type: "thread.implementation-run-cancel-requested" }
    >,
  ) {
    const run = event.payload.run;
    const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
    // A run with per-ticket reviews has one nested run per ticket in flight, so
    // cancel every one of them. Leaving any behind leaves a controller thread
    // running against a run that is over.
    const activeNestedAppReviews = (readModel.appReviewWorkflowRuns ?? []).filter(
      (candidate) =>
        candidate.caller.type === "implementation" &&
        candidate.caller.implementationRunId === run.id &&
        candidate.status === "running",
    );
    for (const activeNestedAppReview of activeNestedAppReviews) {
      yield* orchestrationEngine.dispatch({
        type: "thread.app-review-workflow.cancel",
        commandId: yield* serverCommandId("implementation-nested-app-review-cancel"),
        threadId: activeNestedAppReview.controllerThreadId,
        runId: activeNestedAppReview.id,
        reason: "Parent Implementation workflow was canceled.",
        createdAt: event.occurredAt,
      });
    }
    // Stop the orchestrator plus every live workflow child so no provider turn
    // outlives the run. The worktree and branch are deliberately left in place —
    // cancel stops work, it does not clean up.
    const childThreadIds = readModel.threads
      .filter(
        (thread) =>
          thread.parentThreadId === run.orchestratorThreadId &&
          thread.deletedAt === null &&
          thread.session !== null &&
          thread.session.status !== "stopped",
      )
      .map((thread) => thread.id);
    const orchestratorThread = findThread(readModel, run.orchestratorThreadId);
    const threadIds =
      orchestratorThread !== null && orchestratorThread.deletedAt === null
        ? [run.orchestratorThreadId, ...childThreadIds]
        : childThreadIds;
    for (const threadId of threadIds) {
      yield* orchestrationEngine.dispatch({
        type: "thread.session.stop",
        commandId: yield* serverCommandId("implementation-run-cancel-stop"),
        threadId,
        createdAt: event.occurredAt,
      });
    }
    yield* appendActivity({
      threadId: run.orchestratorThreadId,
      tone: "info",
      kind: "implementation-workflow.canceled",
      summary: "Implementation workflow canceled",
      payload: {
        runId: run.id,
        ...(event.payload.reason !== undefined ? { reason: event.payload.reason } : {}),
      },
      createdAt: event.occurredAt,
    });
  });

  const handleNestedAppReviewWorkflow = Effect.fn(
    "ImplementationWorkflowReactor.handleNestedAppReviewWorkflow",
  )(function* (
    event: Extract<
      ImplementationWorkflowEvent,
      { type: "thread.app-review-workflow-launched" | "thread.app-review-workflow-updated" }
    >,
  ) {
    const nestedRun = event.payload.run;
    if (nestedRun.caller.type !== "implementation") return;
    const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
    const run = findRunById(readModel, nestedRun.caller.implementationRunId);
    if (run === null || run.appReviewStrategy !== "nested-workflow") return;
    const sourceThreadId = findRunSourceThreadId({ readModel, run });
    if (sourceThreadId === null) return;
    const ticketId = nestedRun.caller.ticketId;
    if (ticketId !== undefined) {
      const ticketState = run.ticketStates.find((state) => state.ticketId === ticketId);
      if (ticketState === undefined) return;
      // An orphaned review keeps running until its cancel lands, and writing
      // what it says back would not only undo the rewind that orphaned it, it
      // would carry every other ticket along with it, from the pre-rewind
      // snapshot this update was built on.
      if (!ticketAwaitsAppReviewRun(ticketState, nestedRun.id)) return;
      const linkedTicketRun: OrchestrationImplementationRun = {
        ...run,
        ticketStates: run.ticketStates.map((state) =>
          state.ticketId === ticketId
            ? {
                ...state,
                status: "app-reviewing" as const,
                appReviewWorkflowRunId: nestedRun.id,
                updatedAt: event.occurredAt,
              }
            : state,
        ),
        updatedAt: event.occurredAt,
      };
      if (event.type === "thread.app-review-workflow-launched" || nestedRun.status === "running") {
        yield* updateRun({ sourceThreadId, run: linkedTicketRun, createdAt: event.occurredAt });
        // A successful repair parks the nested run until its caller refreshes
        // the preview. Nothing else resumes a ticket-scoped run, so do it here.
        if (nestedAppReviewAwaitsPreviewRefresh(nestedRun)) {
          yield* resumeTicketAppReview({
            run: linkedTicketRun,
            ticketId,
            nestedRun,
            createdAt: event.occurredAt,
          });
        }
        return;
      }
      const outcome = nestedRun.outcome ?? nestedRun.status;
      const warningMarkdown =
        outcome === "passed"
          ? undefined
          : (nestedRun.failure?.detailMarkdown ??
            nestedRun.cycles.at(-1)?.actionableFindingsMarkdown ??
            `Ticket App Review ended ${outcome}.`);
      const reviewedTicketRun: OrchestrationImplementationRun = {
        ...linkedTicketRun,
        ticketStates: linkedTicketRun.ticketStates.map((state) =>
          state.ticketId === ticketId
            ? {
                ...state,
                appReviewOutcome: outcome,
                warningMarkdown: warningMarkdown ?? null,
                workerResult:
                  state.workerResult?.status === "succeeded" && nestedRun.finalHeadSha !== null
                    ? { ...state.workerResult, commitSha: nestedRun.finalHeadSha }
                    : state.workerResult,
                updatedAt: event.occurredAt,
              }
            : state,
        ),
        workerResults: linkedTicketRun.workerResults.map((result) =>
          result.ticketId === ticketId &&
          result.status === "succeeded" &&
          nestedRun.finalHeadSha !== null
            ? { ...result, commitSha: nestedRun.finalHeadSha }
            : result,
        ),
        updatedAt: event.occurredAt,
      };
      if (linkedTicketRun.automationHalt !== null) {
        yield* updateRun({
          sourceThreadId,
          run: reviewedTicketRun,
          createdAt: event.occurredAt,
        });
        return;
      }
      if (outcome !== "passed") {
        yield* blockRun({
          sourceThreadId,
          run: reviewedTicketRun,
          ticketId,
          reasonMarkdown: warningMarkdown ?? `Ticket App Review ended ${outcome}.`,
          updatedAt: event.occurredAt,
          haltCategory: "review-blocked",
          haltStage: "app-review",
        });
        return;
      }
      yield* startTicketCodeReview({
        sourceThreadId,
        run: reviewedTicketRun,
        ticketId,
        ...(warningMarkdown === undefined ? {} : { warningMarkdown }),
        createdAt: event.occurredAt,
      });
      return;
    }
    const runIds = run.appReviewWorkflowRunIds.includes(nestedRun.id)
      ? run.appReviewWorkflowRunIds
      : [...run.appReviewWorkflowRunIds, nestedRun.id];
    const linkedRun: OrchestrationImplementationRun = {
      ...run,
      appReviewWorkflowRunIds: runIds,
      latestAppReviewWorkflowOutcome: nestedRun.outcome,
      updatedAt: event.occurredAt,
    };
    if (event.type === "thread.app-review-workflow-launched") {
      yield* updateRun({ sourceThreadId, run: linkedRun, createdAt: event.occurredAt });
      return;
    }
    if (
      nestedRun.status === "running" &&
      nestedRun.activePhase === null &&
      nestedRun.cycles.at(-1)?.fixResult?.status === "succeeded"
    ) {
      const repairedRun: OrchestrationImplementationRun = {
        ...linkedRun,
        integrationHeadSha: nestedRun.workspaceRevision.headSha,
        status: "qa-reviewing",
        retryableFailure: null,
        updatedAt: event.occurredAt,
      };
      yield* updateRun({ sourceThreadId, run: repairedRun, createdAt: event.occurredAt });
      yield* startBrowserReview({
        sourceThreadId,
        run: repairedRun,
        createdAt: event.occurredAt,
      });
      return;
    }
    if (nestedRun.status === "passed") {
      const reviewedHeadSha = nestedRun.finalHeadSha ?? nestedRun.workspaceRevision.headSha;
      const passedRun: OrchestrationImplementationRun = {
        ...linkedRun,
        status: "qa-reviewing",
        integrationHeadSha: reviewedHeadSha,
        appReviewedHeadSha: reviewedHeadSha,
        qaAttemptCount: nestedRun.cyclesUsed,
        appReviewUnblockAttemptCount: 0,
        retryableFailure: null,
        updatedAt: event.occurredAt,
      };
      yield* updateRun({ sourceThreadId, run: passedRun, createdAt: event.occurredAt });
      if (passedAppReviewContinuation(passedRun, reviewedHeadSha) === "final-validation") {
        yield* startMergeGate({
          sourceThreadId,
          run: passedRun,
          integration: {
            baseTicketId: null,
            baseRefName: passedRun.orchestratorBranch,
            mergedTicketIds: [],
            conflictedTicketId: null,
            conflictedRefName: null,
            conflictedFiles: [],
            remainingTicketIds: [],
            remainingRefNames: [],
          },
          kind: "final",
          createdAt: event.occurredAt,
        });
      } else {
        yield* startCodeReview({ sourceThreadId, run: passedRun, createdAt: event.occurredAt });
      }
      return;
    }
    if (nestedRun.status === "failed" || nestedRun.status === "exhausted") {
      const failedHeadSha = nestedRun.finalHeadSha ?? nestedRun.workspaceRevision.headSha;
      const failedRun: OrchestrationImplementationRun = {
        ...linkedRun,
        status: "qa-reviewing",
        integrationHeadSha: failedHeadSha,
        qaAttemptCount: nestedRun.cyclesUsed,
        appReviewUnblockAttemptCount: 0,
        ...(nestedRun.status === "exhausted"
          ? {
              qaExhaustedAt: event.occurredAt,
              qaExhaustionReason: "app-review" as const,
              appReviewExhaustedAt: event.occurredAt,
            }
          : {}),
        lastQaFailure: {
          kind: "app-review",
          status: nestedRun.status,
          detailMarkdown:
            nestedRun.failure?.detailMarkdown ??
            nestedRun.cycles.at(-1)?.actionableFindingsMarkdown ??
            "App Review failed with unresolved findings.",
          reviewId: nestedRun.cycles.at(-1)?.reviewId ?? null,
          headSha: failedHeadSha,
          occurredAt: event.occurredAt,
        },
        retryableFailure: null,
        updatedAt: event.occurredAt,
      };
      yield* blockRun({
        sourceThreadId,
        run: failedRun,
        reasonMarkdown: failedRun.lastQaFailure?.detailMarkdown ?? "App Review did not pass.",
        updatedAt: event.occurredAt,
        haltCategory: "review-blocked",
        haltStage: "app-review",
      });
      return;
    }
  });

  /**
   * Keeps the successful run's shared stack and releases every ticket stack.
   *
   * Protecting the shared stack happens before the workflow sweep, so the
   * controller cannot stop the preview users keep after success. Ticket stack
   * protection does not outlive a successful run. Teardown never fails work
   * that has already completed.
   */
  const teardownWorkflowStacks = Effect.fn("ImplementationWorkflowReactor.teardownWorkflowStacks")(
    function* (input: {
      readonly readModel: OrchestrationReadModel;
      readonly run: OrchestrationImplementationRun;
      readonly createdAt: string;
    }) {
      const workflowId = workflowIdForRun(input.readModel, input.run);
      if (workflowId === undefined) return;
      const mainLookup = yield* appDevStackManager
        .getByWorktree({ worktreePath: input.run.orchestratorWorktreePath })
        .pipe(Effect.result);
      if (mainLookup._tag === "Failure") {
        yield* appendActivity({
          threadId: input.run.orchestratorThreadId,
          tone: "error",
          kind: "implementation-run-stack-teardown-failed",
          summary: `Main App Dev Stack lookup failed: ${errorDetail(mainLookup.failure)}`,
          payload: { runId: input.run.id, workflowId },
          createdAt: input.createdAt,
        });
        return;
      }
      const mainStackId = mainLookup.success.stack?.id ?? null;
      if (mainStackId !== null) {
        const protectedMain = yield* appDevStackManager
          .setProtected({ stackId: mainStackId, protected: true })
          .pipe(Effect.result);
        if (protectedMain._tag === "Failure") {
          yield* appendActivity({
            threadId: input.run.orchestratorThreadId,
            tone: "error",
            kind: "implementation-run-stack-teardown-failed",
            summary: `Main App Dev Stack protection failed: ${errorDetail(protectedMain.failure)}`,
            payload: { runId: input.run.id, workflowId, mainStackId },
            createdAt: input.createdAt,
          });
          return;
        }
      }
      const result = yield* appDevStackManager.workflowTeardown({ workflowId }).pipe(Effect.result);
      if (result._tag === "Failure") {
        yield* appendActivity({
          threadId: input.run.orchestratorThreadId,
          tone: "info",
          kind: "implementation-run-stack-teardown-failed",
          summary: `App Dev Stack teardown failed: ${errorDetail(result.failure)}`,
          payload: { runId: input.run.id, workflowId },
          createdAt: input.createdAt,
        });
        return;
      }
      const stoppedStackIds = [...result.success.stoppedStackIds];
      const skippedProtectedStackIds = result.success.skippedProtectedStackIds.filter(
        (stackId) => stackId === mainStackId,
      );
      const failedStackIds = [...result.success.failedStackIds];
      const protectedTicketStackIds = result.success.skippedProtectedStackIds.filter(
        (stackId) => stackId !== mainStackId,
      );
      const forcedStops = yield* Effect.forEach(
        protectedTicketStackIds,
        (stackId) =>
          Effect.gen(function* () {
            const unprotected = yield* appDevStackManager
              .setProtected({ stackId, protected: false })
              .pipe(Effect.result);
            const stopped = yield* appDevStackManager.stop({ stackId }).pipe(Effect.result);
            return { stackId, unprotected, stopped };
          }),
        { concurrency: 4 },
      );
      for (const { stackId, unprotected, stopped } of forcedStops) {
        if (stopped._tag === "Success") stoppedStackIds.push(stackId);
        else failedStackIds.push(stackId);
        if (unprotected._tag === "Failure" && !failedStackIds.includes(stackId)) {
          failedStackIds.push(stackId);
        }
      }
      if (
        stoppedStackIds.length === 0 &&
        skippedProtectedStackIds.length === 0 &&
        failedStackIds.length === 0
      ) {
        return;
      }
      const parts = [`Tiered down ${stoppedStackIds.length} App Dev Stack(s) after success`];
      if (mainStackId !== null) parts.push("kept the main stack protected");
      if (failedStackIds.length > 0) parts.push(`${failedStackIds.length} failed to stop`);
      yield* appendActivity({
        threadId: input.run.orchestratorThreadId,
        tone: failedStackIds.length > 0 ? "error" : "info",
        kind: "implementation-run-stacks-torn-down",
        summary: parts.join("; "),
        payload: {
          runId: input.run.id,
          workflowId,
          mainStackId,
          stoppedStackIds,
          skippedProtectedStackIds,
          failedStackIds,
        },
        createdAt: input.createdAt,
      });
    },
  );

  const handleChangeRequestBabysitResult = Effect.fn(
    "ImplementationWorkflowReactor.handleChangeRequestBabysitResult",
  )(function* (
    event: Extract<ImplementationWorkflowEvent, { type: "thread.activity-appended" }>,
    directive: ChangeRequestBabysitDirective,
  ) {
    const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
    const run = findRunById(readModel, directive.runId);
    if (
      run === null ||
      run.status !== "babysitting-change-request" ||
      run.activeChangeRequestBabysitterThreadId !== event.payload.threadId
    ) {
      return;
    }
    const sourceThreadId = findRunSourceThreadId({ readModel, run });
    if (sourceThreadId === null) return;
    const updatedAt = event.payload.activity.createdAt;
    const head = yield* gitWorkflow.resolveCommit({
      cwd: run.orchestratorWorktreePath,
      ref: "HEAD",
    });
    const passed = directive.status === "passed" && directive.headSha === head.commitSha;
    if (!passed) {
      const detail =
        directive.status === "blocked"
          ? directive.summaryMarkdown
          : `PR babysitter reported green commit '${directive.headSha}', but current HEAD is '${head.commitSha}'.`;
      yield* updateRun({
        sourceThreadId,
        run: {
          ...run,
          status: "needs-human-attention",
          activeChangeRequestBabysitterThreadId: null,
          retryableFailure: {
            stage: "change-request-babysit",
            detail,
            failedAt: updatedAt,
            attemptCount: 1,
            maxAttempts: 3,
            humanBlocked: directive.status === "blocked",
          },
          updatedAt,
        },
        createdAt: updatedAt,
      });
      return;
    }
    const completedRun: OrchestrationImplementationRun = {
      ...run,
      status: "completed",
      activeChangeRequestBabysitterThreadId: null,
      retryableFailure: null,
      updatedAt,
    };
    yield* updateRun({ sourceThreadId, run: completedRun, createdAt: updatedAt });
    yield* appendActivity({
      threadId: run.orchestratorThreadId,
      tone: "info",
      kind: "implementation-run-completed",
      summary: "Implementation run completed after PR checks passed",
      payload: { runId: run.id, headSha: head.commitSha },
      createdAt: updatedAt,
    });
    yield* teardownWorkflowStacks({ readModel, run: completedRun, createdAt: updatedAt });
  });

  const processActivity = Effect.fn("ImplementationWorkflowReactor.processActivity")(function* (
    event: Extract<ImplementationWorkflowEvent, { type: "thread.activity-appended" }>,
  ) {
    switch (event.payload.activity.kind) {
      case "implementation-worker-result": {
        const directive = asWorkerDirective(event.payload.activity.payload);
        if (directive !== null) yield* handleWorkerResult(event, directive);
        return;
      }
      case "implementation-merge-gate-result": {
        const directive = asMergeGateDirective(event.payload.activity.payload);
        if (directive !== null) yield* handleMergeGateResult(event, directive);
        return;
      }
      case "implementation-fix-result": {
        const directive = asFixDirective(event.payload.activity.payload);
        if (directive !== null) yield* handleFixResult(event, directive);
        return;
      }
      case "implementation-code-review-result": {
        const directive = asCodeReviewDirective(event.payload.activity.payload);
        if (directive !== null) yield* handleCodeReviewResult(event, directive);
        return;
      }
      case "implementation-fast-build-result": {
        const directive = asFastBuildDirective(event.payload.activity.payload);
        if (directive !== null) yield* handleFastBuildResult(event, directive);
        return;
      }
      case "implementation-change-request-babysit-result": {
        const directive = asChangeRequestBabysitDirective(event.payload.activity.payload);
        if (directive !== null) yield* handleChangeRequestBabysitResult(event, directive);
        return;
      }
      default:
        return;
    }
  });

  /**
   * Clearing a pause is what turns a stopped run back into running work, and
   * sweeping here rather than waiting for the periodic pass is what makes
   * "Resume" start something the user can see.
   *
   * The cleared mark is the trigger, not the un-settle that rides along with
   * it: threads un-settle for reasons that have nothing to do with a pause, and
   * sweeping twice for one resume starts a duplicate stage thread that the next
   * sweep cannot recognize, because it has no session yet.
   *
   * A resume covers the whole subtree, so this reacts to the thread that owns
   * the run and no other. Resuming a single paused branch instead of the
   * workflow root is picked up by the periodic sweep.
   */
  const handleWorkflowResumed = Effect.fn("ImplementationWorkflowReactor.handleWorkflowResumed")(
    function* (event: Extract<ImplementationWorkflowEvent, { type: "thread.workflow-resumed" }>) {
      const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
      const ownsThread = readModel.implementationRuns.some(
        (run) =>
          run.status !== "canceled" &&
          run.status !== "completed" &&
          findRunSourceThreadId({ readModel, run }) === event.payload.threadId,
      );
      if (!ownsThread) return;
      yield* recoverIncompleteStages();
    },
  );

  const processEvent = Effect.fn("ImplementationWorkflowReactor.processEvent")(function* (
    event: ImplementationWorkflowEvent,
  ) {
    switch (event.type) {
      case "thread.planning-tickets-created":
        yield* handlePromptTicketsCreated(event);
        return;
      case "thread.implementation-run-launched":
        yield* handleRunLaunched(event);
        return;
      case "thread.activity-appended":
        yield* processActivity(event);
        return;
      case "thread.app-review-updated":
        yield* handleAppReviewUpdated(event);
        return;
      case "thread.implementation-change-request-retry-requested":
        yield* handleChangeRequestRetry(event);
        return;
      case "thread.implementation-run-retry-requested":
        yield* handleRunRetry(event);
        return;
      case "thread.implementation-run-rerun-requested":
        yield* handleRunRerun(event);
        return;
      case "thread.implementation-run-reset-requested":
        yield* handleRunReset(event);
        return;
      case "thread.implementation-run-skip-set":
        yield* handleRunSkipSet(event);
        return;
      case "thread.implementation-run-cancel-requested":
        yield* handleRunCancel(event);
        return;
      case "thread.app-review-workflow-launched":
      case "thread.app-review-workflow-updated":
        yield* handleNestedAppReviewWorkflow(event);
        return;
      case "thread.workflow-resumed":
        yield* handleWorkflowResumed(event);
        return;
    }
  });

  const processEventSafely = (event: ImplementationWorkflowEvent) =>
    processEvent(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("implementation workflow reactor failed to process event", {
          eventType: event.type,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processEventSafely);

  const recoverRunStage = <A, E, R>(
    runId: OrchestrationImplementationRun["id"],
    stage: string,
    effect: Effect.Effect<A, E, R>,
  ) =>
    effect.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("implementation workflow run stage recovery failed", {
          runId,
          stage,
          cause: Cause.pretty(cause),
        }),
      ),
    );

  const reconcileLegacyQaRuns = Effect.fn("ImplementationWorkflowReactor.reconcileLegacyQaRuns")(
    function* () {
      const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
      const createdAt = DateTime.formatIso(yield* DateTime.now);
      for (const persistedRun of readModel.implementationRuns) {
        if (persistedRun.status === "completed" || persistedRun.status === "canceled") continue;
        if (persistedRun.appReviewStrategy === "nested-workflow") continue;
        const sourceThreadId = findRunSourceThreadId({ readModel, run: persistedRun });
        if (sourceThreadId === null) continue;
        const qaFixers = readModel.threads.filter(
          (thread) =>
            thread.parentThreadId === persistedRun.orchestratorThreadId &&
            thread.workflowRole === "implementation-fixer" &&
            (/^TDD repair \d+\/10 · (?:AppDevStack|App Review)$/u.test(thread.title) ||
              /(?:AppDevStack|browser app review)/iu.test(thread.title)),
        );
        const normalizedRepairCount = Math.min(
          IMPLEMENTATION_RUN_MAX_QA_REPAIRS,
          qaFixers.length > 0 ? qaFixers.length : persistedRun.qaCycleCount,
        );
        const run: OrchestrationImplementationRun =
          persistedRun.qaCycleCount === normalizedRepairCount
            ? persistedRun
            : {
                ...persistedRun,
                qaCycleCount: normalizedRepairCount,
                updatedAt: createdAt,
              };
        if (run !== persistedRun) {
          yield* updateRun({ sourceThreadId, run, createdAt });
        }

        const orchestratorThread = findThread(readModel, run.orchestratorThreadId);
        const canonicalReviews = (orchestratorThread?.appReviews ?? []).filter(
          (review) => run.appReviewIds.includes(review.id) && review.status === "running",
        );
        for (const canonicalReview of canonicalReviews) {
          const reviewer = readModel.threads.find(
            (thread) => thread.id === canonicalReview.reviewThreadId,
          );
          const reviewerCompleted =
            reviewer !== undefined &&
            reviewer.session !== null &&
            reviewer.session.status !== "starting" &&
            reviewer.session.status !== "running";
          if (reviewer === undefined || !reviewerCompleted) continue;
          const nestedTerminal = [...reviewer.appReviews]
            .filter((review) => review.status === "passed" || review.status === "failed")
            .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
          if (nestedTerminal !== undefined) {
            yield* orchestrationEngine.dispatch({
              type: "thread.app-review.evidence.update",
              commandId: yield* serverCommandId("implementation-reconcile-review-evidence"),
              threadId: run.orchestratorThreadId,
              reviewId: canonicalReview.id,
              evidence: nestedTerminal.evidence,
              updatedAt: createdAt,
              createdAt,
            });
          }
          yield* orchestrationEngine.dispatch({
            type: "thread.app-review.update",
            commandId: yield* serverCommandId("implementation-reconcile-review"),
            threadId: run.orchestratorThreadId,
            reviewId: canonicalReview.id,
            status: nestedTerminal?.status ?? "failed",
            document: nestedTerminal?.document ?? {
              ...canonicalReview.document,
              verdict: "failed",
              summary:
                canonicalReview.document.summary ||
                "Browser App Review agent completed without terminally updating its canonical review.",
            },
            updatedAt: createdAt,
            createdAt,
          });
        }

        if (
          normalizedRepairCount >= IMPLEMENTATION_RUN_MAX_QA_REPAIRS &&
          run.qaExhaustedAt === null &&
          run.lastQaFailure !== null &&
          (run.status === "fixing" || run.status === "needs-human-attention")
        ) {
          yield* exhaustQa({
            sourceThreadId,
            run,
            gate: run.lastQaFailure.kind,
            createdAt,
          });
        }
      }
    },
  );

  const recoverIncompleteBrowserReviews = Effect.fn(
    "ImplementationWorkflowReactor.recoverIncompleteBrowserReviews",
  )(function* () {
    const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    const nowMs = Date.parse(createdAt);
    for (const run of readModel.implementationRuns) {
      if (run.status === "canceled" || run.automationHalt !== null) continue;
      const recoverStackFailure =
        run.artifactSource === "planning-spec" &&
        run.status === "needs-human-attention" &&
        run.appDevStack.status === "failed" &&
        run.integrationHeadSha !== null &&
        run.appReviewIds.length === 0;
      const reviewThreads = readModel.threads.filter(
        (thread) =>
          thread.parentThreadId === run.orchestratorThreadId &&
          thread.workflowRole === "implementation-qa-reviewer" &&
          thread.deletedAt === null,
      );
      const latestReviewThread = [...reviewThreads].sort((a, b) =>
        a.createdAt < b.createdAt ? 1 : -1,
      )[0];
      const recoverInterruptedReview =
        run.status === "qa-reviewing" &&
        run.appReviewIds.length > 0 &&
        (latestReviewThread?.session?.status === "error" ||
          latestReviewThread?.session?.status === "stopped") &&
        !(
          latestReviewThread !== undefined &&
          isAwaitingWorkflowNudge({ threads: readModel.threads, thread: latestReviewThread, nowMs })
        );
      if (!recoverStackFailure && !recoverInterruptedReview) continue;
      const sourceThreadId = findRunSourceThreadId({ readModel, run });
      if (sourceThreadId === null) continue;
      // Browser-review attempts are independent from fresh repair-agent slots.
      yield* startBrowserReview({ sourceThreadId, run, createdAt }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("implementation workflow stack-failure recovery failed", {
            runId: run.id,
            cause: Cause.pretty(cause),
          }),
        ),
      );
    }
  });

  const recoverIncompleteIntegrations = Effect.fn(
    "ImplementationWorkflowReactor.recoverIncompleteIntegrations",
  )(function* () {
    const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    for (const run of readModel.implementationRuns) {
      if (
        run.status === "canceled" ||
        run.automationHalt !== null ||
        run.artifactSource !== "planning-spec" ||
        (run.status !== "running" && run.status !== "integrating") ||
        !run.ticketStates.every(
          (state) => state.status === "succeeded" || state.status === "failed",
        )
      ) {
        continue;
      }
      const sourceThreadId = findRunSourceThreadId({ readModel, run });
      if (sourceThreadId === null) continue;
      yield* integrateCompletedRun({
        sourceThreadId,
        run: {
          ...run,
          activeValidatorThreadId: null,
          activeValidationHeadSha: null,
          activeValidationKind: null,
        },
        createdAt,
      }).pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
          return blockRun({
            sourceThreadId,
            run: { ...run, status: "integrating" },
            retryableStage: "integration",
            reasonMarkdown: `Final branch integration recovery failed.\n\n\`\`\`\n${Cause.pretty(cause)}\n\`\`\``,
            updatedAt: createdAt,
          });
        }),
      );
    }
  });

  const recoverIncompleteStages = Effect.fn(
    "ImplementationWorkflowReactor.recoverIncompleteStages",
  )(function* () {
    const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    const nowMs = Date.parse(createdAt);
    for (const run of readModel.implementationRuns) {
      if (run.status === "canceled" || run.automationHalt !== null) continue;
      if (run.status !== "completed") {
        yield* tierDownTicketStacks({ run, createdAt });
      }
      // A paused run is waiting for the user, not for recovery. Re-entering its
      // stage would create the stage's thread and then fail to start the turn
      // on the paused-ancestor invariant, leaving an orphan thread behind every
      // sweep for as long as the pause lasts.
      if (isWorkflowThreadPaused(readModel.threads, run.orchestratorThreadId)) continue;
      const sourceThreadId = findRunSourceThreadId({ readModel, run });
      if (sourceThreadId === null) continue;
      // Reap the ticket App Reviews no ticket is waiting on any more. A clear
      // or a re-run cancels the review it rewinds past, but one whose cancel
      // never landed has nothing left pointing at it: no stage will finish it,
      // and the App Review reactor resumes every running review on restart, so
      // it would otherwise outlive the run that started it.
      for (const nestedRun of readModel.appReviewWorkflowRuns ?? []) {
        if (nestedRun.status !== "running") continue;
        if (nestedRun.caller.type !== "implementation") continue;
        if (nestedRun.caller.implementationRunId !== run.id) continue;
        const ticketId = nestedRun.caller.ticketId;
        if (ticketId === undefined) continue;
        const state = run.ticketStates.find((candidate) => candidate.ticketId === ticketId);
        if (state !== undefined && ticketAwaitsAppReviewRun(state, nestedRun.id)) continue;
        yield* recoverRunStage(
          run.id,
          "orphaned-ticket-app-review",
          orchestrationEngine.dispatch({
            type: "thread.app-review-workflow.cancel",
            commandId: yield* serverCommandId("implementation-orphaned-app-review-cancel"),
            threadId: nestedRun.controllerThreadId,
            runId: nestedRun.id,
            reason: "Its ticket is no longer waiting on this App Review.",
            createdAt,
          }),
        );
      }
      const childThreads = readModel.threads.filter(
        (thread) => thread.parentThreadId === run.orchestratorThreadId && thread.deletedAt === null,
      );
      const awaitingNudge = (thread: OrchestrationThread | undefined) =>
        thread !== undefined &&
        isAwaitingWorkflowNudge({ threads: readModel.threads, thread, nowMs });
      /**
       * Whether a stage's thread is done with the work the stage gave it, as
       * opposed to not having reported yet.
       *
       * "No live session" used to be the whole test, and that is also what a
       * thread looks like between being created and its provider session coming
       * up. On a loaded machine that gap outlasts the sweep, so every pass
       * started another thread for the same stage and orphaned the last: one
       * ticket collected more than 1,900 code reviewers that way.
       *
       * A thread that has never reported anything, no session and no turn, is
       * a launch still queued behind a busy provider. It is left alone, but not
       * forever: a restart drops a queued start with nothing to re-drive it, so
       * after UNREPORTED_STAGE_THREAD_GRACE_MS silence counts as gone. That
       * backstop is a floor on how often the sweep can be wrong, not the test
       * itself, which is why it is generous.
       */
      const stageThreadIsFinished = (thread: OrchestrationThread | undefined) => {
        if (thread === undefined) return true;
        if (
          thread.session?.status === "starting" ||
          thread.session?.status === "running" ||
          thread.latestTurn?.state === "running" ||
          awaitingNudge(thread)
        ) {
          return false;
        }
        if (thread.session === null && thread.latestTurn === null) {
          return nowMs - Date.parse(thread.createdAt) >= UNREPORTED_STAGE_THREAD_GRACE_MS;
        }
        // A live session resting between turns reads as `ready` with no active
        // turn, which is also how a thread looks when it stopped without
        // reporting. Reviewers rest there for a minute or two mid-review, and
        // recovering on the first idle sweep put a second reviewer on the same
        // ticket branch: whichever one reported first froze the ticket's
        // recorded commit, the other kept committing, and every later step that
        // compared the branch against that commit refused. `stopped`, `error`
        // and `interrupted` say the session is actually over and are recovered
        // at once; only `ready` has to prove it by staying quiet.
        if (thread.session?.status === "ready") {
          return nowMs - Date.parse(thread.session.updatedAt) >= UNREPORTED_STAGE_THREAD_GRACE_MS;
        }
        return true;
      };
      const hasActiveChild = (input: {
        readonly threadId: ThreadId | null;
        readonly role:
          | "implementation-validator"
          | "implementation-qa-reviewer"
          | "implementation-code-reviewer"
          | "implementation-change-request-babysitter"
          | "implementation-fixer";
      }) => {
        const matches = childThreads.filter(
          (thread) =>
            thread.workflowRole === input.role &&
            (input.threadId === null || thread.id === input.threadId),
        );
        // A thread blocked on a failed turn is still this stage's thread: the
        // nudge path is re-prompting it in place, and relaunching the stage
        // underneath that would throw away its context and, while a usage limit
        // holds, spawn one dead thread per sweep.
        return matches.some((thread) => !stageThreadIsFinished(thread));
      };

      // A Fast feature Build thread is created by the decider but seeded by `ensureFastFeatureRun`,
      // so a restart or an early return between the two strands it with nothing to work on.
      // Nothing else re-drives it: `recoverRetryableRuns` only looks at runs with a
      // `retryableFailure`. `ensureFastFeatureRun` leaves `launch-pending` once the handover has
      // gone out, so a run still sitting there never reached Build.
      if (run.artifactSource === "proposed-plan" && run.status === "launch-pending") {
        const implementer = findThread(readModel, run.orchestratorThreadId);
        // Not stageThreadIsFinished: this branch is about a thread the decider
        // created and nobody ever handed work to, which is the one shape that
        // rule deliberately waits on. Here silence means the handover was lost,
        // and this sweep is the only thing that closes it.
        if (
          implementer !== null &&
          implementer.deletedAt === null &&
          implementer.session?.status !== "starting" &&
          implementer.session?.status !== "running" &&
          !awaitingNudge(implementer)
        ) {
          yield* recoverRunStage(
            run.id,
            "fast-feature-handover",
            ensureFastFeatureRun({ sourceThreadId, run, createdAt }),
          );
          continue;
        }
      }

      // Build can report success after the run was already blocked — a spurious failure, an
      // exhausted retry budget, a restart mid-dispatch. The result is durable on the thread, so
      // re-drive it here rather than leaving a finished branch with nobody to review it.
      // `createdAt > updatedAt` is what terminates this: applying the result advances the run past
      // the activity, so the next sweep no longer matches.
      if (
        run.artifactSource === "proposed-plan" &&
        run.status === "needs-human-attention" &&
        run.fastBuildResult?.status !== "succeeded"
      ) {
        const orchestratorThread = yield* projectionSnapshotQuery
          .getThreadDetailById(run.orchestratorThreadId)
          .pipe(Effect.map(Option.getOrUndefined));
        // Threads in the command read model carry no activities, so the detail is the only place
        // the reported result can be read back.
        const reported = [...(orchestratorThread?.activities ?? [])]
          .filter((activity) => activity.kind === "implementation-fast-build-result")
          .sort((left, right) => (left.createdAt < right.createdAt ? 1 : -1))[0];
        const directive = reported ? asFastBuildDirective(reported.payload) : null;
        if (
          reported !== undefined &&
          directive !== null &&
          directive.status === "succeeded" &&
          directive.runId === run.id &&
          reported.createdAt > run.updatedAt
        ) {
          yield* recoverRunStage(
            run.id,
            "fast-feature-build-result",
            applyFastBuildResult({
              threadId: run.orchestratorThreadId,
              directive,
              updatedAt: reported.createdAt,
            }),
          );
          continue;
        }
      }

      if (
        run.status === "needs-human-attention" &&
        run.retryableFailure === null &&
        run.activeFixerThreadId !== null &&
        run.fixOrigin !== null &&
        !hasActiveChild({
          threadId: run.activeFixerThreadId,
          role: "implementation-fixer",
        })
      ) {
        const reviewId = run.appReviewIds.at(-1);
        if (run.fixOrigin === "app-review" && reviewId === undefined) continue;
        if (run.fixOrigin === "app-dev-stack" || run.fixOrigin === "app-review") {
          yield* recoverRunStage(
            run.id,
            "legacy-qa-fixer",
            handleFixerFailure({
              sourceThreadId,
              run,
              detailMarkdown:
                run.lastQaFailure?.detailMarkdown ??
                "The previous QA repair was interrupted before reporting a valid result.",
              createdAt,
            }),
          );
          continue;
        }
        yield* recoverRunStage(
          run.id,
          "legacy-fixer",
          startFixer({
            sourceThreadId,
            run: { ...run, activeFixerThreadId: null },
            status: run.fixOrigin === "code-review" ? "code-review-fixing" : "fixing",
            origin: run.fixOrigin,
            title:
              run.fixOrigin === "merge-gate"
                ? "Fix merge gate failures"
                : "Fix code review findings",
            promptText:
              run.fixOrigin === "merge-gate"
                ? buildMergeGateFixPrompt({
                    run,
                    reportMarkdown: "The previous merge-gate fixer was interrupted.",
                  })
                : buildCodeReviewFixPrompt({
                    run,
                    reportMarkdown:
                      run.latestCodeReviewReportMarkdown ??
                      "The previous code-review fixer was interrupted.",
                  }),
            createdAt,
          }),
        );
        continue;
      }

      if (
        run.artifactSource === "planning-spec" &&
        run.status === "needs-human-attention" &&
        run.retryableFailure === null &&
        run.ticketStates.some((state) => state.status === "ready") &&
        run.ticketStates.every((state) => state.status === "ready" || state.status === "succeeded")
      ) {
        const completedDependenciesStillMatch = yield* Effect.forEach(
          run.ticketStates.filter((state) => state.status === "succeeded"),
          (state) => verifiedDependency({ run, ticketId: state.ticketId }),
          { concurrency: 4, discard: true },
        ).pipe(Effect.result);
        if (completedDependenciesStillMatch._tag === "Success") {
          const resumedRun: OrchestrationImplementationRun = {
            ...run,
            status: "running",
            updatedAt: createdAt,
          };
          yield* recoverRunStage(
            run.id,
            "legacy-worker-setup",
            updateRun({ sourceThreadId, run: resumedRun, createdAt }).pipe(
              Effect.andThen(startReadyWorkers({ sourceThreadId, run: resumedRun, createdAt })),
            ),
          );
          continue;
        }
      }

      if (run.artifactSource === "planning-spec" && run.status === "running") {
        // Stop step pauses one ticket's worker subtree without pausing the run,
        // so a ticket stage is only recoverable while its worker is not paused.
        const ticketStagePaused = (state: { readonly workerThreadId: ThreadId | null }) =>
          state.workerThreadId !== null &&
          isWorkflowThreadPaused(readModel.threads, state.workerThreadId);
        const appReviewRunsById = new Set(
          (readModel.appReviewWorkflowRuns ?? []).map((candidate) => candidate.id),
        );
        const pendingTicketReview = run.ticketStates.find(
          (state) =>
            state.status === "app-reviewing" &&
            (state.appReviewWorkflowRunId == null ||
              !appReviewRunsById.has(state.appReviewWorkflowRunId)) &&
            !ticketStagePaused(state),
        );
        if (pendingTicketReview !== undefined) {
          const releasedRun: OrchestrationImplementationRun = {
            ...run,
            ticketStates: run.ticketStates.map((state) =>
              state.ticketId === pendingTicketReview.ticketId
                ? { ...state, appReviewWorkflowRunId: null, updatedAt: createdAt }
                : state,
            ),
            updatedAt: createdAt,
          };
          yield* recoverRunStage(
            run.id,
            "ticket-app-review",
            updateRun({ sourceThreadId, run: releasedRun, createdAt }).pipe(
              Effect.andThen(
                startTicketAppReview({
                  sourceThreadId,
                  run: releasedRun,
                  ticketId: pendingTicketReview.ticketId,
                  createdAt,
                }),
              ),
            ),
          );
          continue;
        }
        const interruptedTicketCodeReview = run.ticketStates.find((state) => {
          if (state.status !== "code-reviewing" || ticketStagePaused(state)) return false;
          const thread =
            state.codeReviewThreadId == null
              ? undefined
              : readModel.threads.find((candidate) => candidate.id === state.codeReviewThreadId);
          return stageThreadIsFinished(thread);
        });
        if (interruptedTicketCodeReview !== undefined) {
          const releasedRun: OrchestrationImplementationRun = {
            ...run,
            ticketStates: run.ticketStates.map((state) =>
              state.ticketId === interruptedTicketCodeReview.ticketId
                ? { ...state, codeReviewThreadId: null, updatedAt: createdAt }
                : state,
            ),
            updatedAt: createdAt,
          };
          yield* recoverRunStage(
            run.id,
            "ticket-code-review",
            updateRun({ sourceThreadId, run: releasedRun, createdAt }).pipe(
              Effect.andThen(
                startTicketCodeReview({
                  sourceThreadId,
                  run: releasedRun,
                  ticketId: interruptedTicketCodeReview.ticketId,
                  ...(interruptedTicketCodeReview.warningMarkdown == null
                    ? {}
                    : { warningMarkdown: interruptedTicketCodeReview.warningMarkdown }),
                  createdAt,
                }),
              ),
            ),
          );
          continue;
        }
        const interruptedWorkerIds = new Set(
          run.ticketStates
            .filter((state) => {
              if (state.status !== "running" || state.workerThreadId === null) return false;
              const thread = readModel.threads.find(
                (candidate) => candidate.id === state.workerThreadId,
              );
              const resultAlreadyReported = thread?.activities.some(
                (activity) => activity.kind === "implementation-worker-result",
              );
              return !resultAlreadyReported && stageThreadIsFinished(thread);
            })
            .map((state) => state.ticketId),
        );
        if (interruptedWorkerIds.size > 0) {
          const resumedRun: OrchestrationImplementationRun = {
            ...run,
            ticketStates: run.ticketStates.map((state) =>
              interruptedWorkerIds.has(state.ticketId)
                ? {
                    ...state,
                    status: "ready" as const,
                    workerThreadId: null,
                    workerResult: null,
                    updatedAt: createdAt,
                  }
                : state,
            ),
            updatedAt: createdAt,
          };
          yield* recoverRunStage(
            run.id,
            "interrupted-worker",
            updateRun({ sourceThreadId, run: resumedRun, createdAt }).pipe(
              Effect.andThen(startReadyWorkers({ sourceThreadId, run: resumedRun, createdAt })),
            ),
          );
          continue;
        }
      }

      if (
        run.artifactSource === "planning-spec" &&
        run.status === "running" &&
        run.ticketStates.some((state) => state.status === "ready")
      ) {
        yield* recoverRunStage(
          run.id,
          "worker-setup",
          startReadyWorkers({ sourceThreadId, run, createdAt }),
        );
        continue;
      }
      if (
        run.status === "validating" &&
        !hasActiveChild({
          threadId: run.activeValidatorThreadId,
          role: "implementation-validator",
        })
      ) {
        yield* recoverRunStage(
          run.id,
          "merge-gate",
          startMergeGate({
            sourceThreadId,
            run: { ...run, activeValidatorThreadId: null },
            integration: {
              baseTicketId: null,
              baseRefName: run.orchestratorBranch,
              mergedTicketIds: [],
              conflictedTicketId: null,
              conflictedRefName: null,
              conflictedFiles: [],
              remainingTicketIds: [],
              remainingRefNames: [],
            },
            kind: run.activeValidationKind ?? "integration",
            createdAt,
          }),
        );
        continue;
      }
      // A reviewer sitting at `ready` is idle between turns, not dead — it is still the live App
      // Review. Reading idle as dead relaunched a fresh reviewer on every sweep and burned the
      // whole attempt budget in minutes, so only a missing, errored, or stopped reviewer is
      // relaunched here, and never past the attempt limit `recoverIncompleteBrowserReviews`
      // already respects.
      const activeReviewer =
        run.activeAppReviewThreadId === null
          ? undefined
          : childThreads.find((thread) => thread.id === run.activeAppReviewThreadId);
      const reviewerNeedsRelaunch =
        activeReviewer === undefined ||
        ((activeReviewer.session?.status === "error" ||
          activeReviewer.session?.status === "stopped") &&
          !awaitingNudge(activeReviewer));
      if (run.status === "qa-reviewing" && reviewerNeedsRelaunch) {
        yield* startBrowserReview({
          sourceThreadId,
          run: { ...run, activeAppReviewThreadId: null, activeAppReviewHeadSha: null },
          createdAt,
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("implementation workflow run stage recovery failed", {
              runId: run.id,
              stage: "app-review",
              cause: Cause.pretty(cause),
            }),
          ),
        );
        continue;
      }
      if (
        run.status === "code-reviewing" &&
        !hasActiveChild({
          threadId: run.activeCodeReviewThreadId,
          role: "implementation-code-reviewer",
        })
      ) {
        yield* recoverRunStage(
          run.id,
          "code-review",
          startCodeReview({
            sourceThreadId,
            run,
            createdAt,
          }),
        );
        continue;
      }
      if (
        (run.status === "fixing" || run.status === "code-review-fixing") &&
        !hasActiveChild({ threadId: run.activeFixerThreadId, role: "implementation-fixer" })
      ) {
        const origin = run.fixOrigin ?? (run.status === "fixing" ? "app-review" : "code-review");
        const reviewId = run.appReviewIds.at(-1);
        if (origin === "app-dev-stack" || origin === "app-review") {
          if (origin === "app-review" && reviewId === undefined) continue;
          yield* recoverRunStage(
            run.id,
            "qa-fixer",
            handleFixerFailure({
              sourceThreadId,
              run: { ...run, fixOrigin: origin },
              detailMarkdown:
                run.lastQaFailure?.detailMarkdown ??
                "The previous QA repair was interrupted before reporting a valid result.",
              createdAt,
            }),
          );
          continue;
        }
        yield* recoverRunStage(
          run.id,
          "fixer",
          startFixer({
            sourceThreadId,
            run: { ...run, activeFixerThreadId: null },
            status: run.status,
            origin,
            title: origin === "merge-gate" ? "Fix merge gate failures" : "Fix code review findings",
            promptText:
              origin === "merge-gate"
                ? buildMergeGateFixPrompt({
                    run,
                    reportMarkdown: "The previous merge-gate fixer was interrupted.",
                  })
                : buildCodeReviewFixPrompt({
                    run,
                    reportMarkdown:
                      run.latestCodeReviewReportMarkdown ??
                      "The previous code-review fixer was interrupted.",
                  }),
            createdAt,
          }),
        );
        continue;
      }
      if (run.status === "publishing-change-request") {
        yield* recoverRunStage(
          run.id,
          "change-request",
          fileChangeRequest({ sourceThreadId, run, createdAt }),
        );
        continue;
      }
      if (
        run.status === "babysitting-change-request" &&
        !hasActiveChild({
          threadId: run.activeChangeRequestBabysitterThreadId,
          role: "implementation-change-request-babysitter",
        })
      ) {
        yield* recoverRunStage(
          run.id,
          "change-request-babysitter",
          startChangeRequestBabysitter({ sourceThreadId, run, createdAt }),
        );
      }
    }
  });

  const recoverRetryableRuns = Effect.fn("ImplementationWorkflowReactor.recoverRetryableRuns")(
    function* () {
      const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
      const createdAt = DateTime.formatIso(yield* DateTime.now);
      for (const run of readModel.implementationRuns) {
        if (
          run.status !== "needs-human-attention" ||
          run.automationHalt !== null ||
          run.retryableFailure === null ||
          // Only a human can clear this one. Retrying burns the attempt budget in
          // repeated sweeps against a condition that cannot change on its own,
          // leaving nothing for the explicit Retry once the user has fixed it.
          run.retryableFailure.humanBlocked ||
          (run.retryableFailure.attemptCount >= run.retryableFailure.maxAttempts &&
            !(
              run.retryableFailure.stage === "app-dev-stack" &&
              run.lastQaFailure === null &&
              run.retryableFailure.attemptCount === run.retryableFailure.maxAttempts
            ))
        ) {
          continue;
        }
        const sourceThreadId = findRunSourceThreadId({ readModel, run });
        if (sourceThreadId === null) continue;
        yield* orchestrationEngine.dispatch({
          type: "thread.implementation-run.retry",
          commandId: yield* serverCommandId("implementation-auto-retry"),
          threadId: sourceThreadId,
          runId: run.id,
          createdAt,
        });
      }
    },
  );

  /**
   * Resume every ticket App Review parked awaiting a preview refresh.
   *
   * The event path resumes a run the moment it parks, but a run that parked
   * before a restart — or before this recovery existed — has no further
   * events coming. This sweep runs on the periodic recovery schedule rather
   * than once at startup: reactors start in sequence, so a startup dispatch
   * can emit its resume before the App Review reactor is subscribed, and the
   * event is lost. A parked run keeps looking parked until a resume lands, so
   * the next sweep simply tries again; a duplicate resume is rejected once a
   * cycle claims the run.
   */
  const resumeAwaitingTicketAppReviews = Effect.fn(
    "ImplementationWorkflowReactor.resumeAwaitingTicketAppReviews",
  )(function* () {
    const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    for (const nestedRun of readModel.appReviewWorkflowRuns ?? []) {
      if (!nestedAppReviewAwaitsPreviewRefresh(nestedRun)) continue;
      if (nestedRun.caller.type !== "implementation") continue;
      const ticketId = nestedRun.caller.ticketId;
      // Combined post-merge reviews get their refresh from startBrowserReview.
      if (ticketId === undefined) continue;
      // A paused workflow refuses the resume; retrying every sweep would only
      // churn events until the user unpauses.
      if (isWorkflowThreadPaused(readModel.threads, nestedRun.controllerThreadId)) continue;
      const run = findRunById(readModel, nestedRun.caller.implementationRunId);
      if (run === null || run.status !== "running" || run.appReviewStrategy !== "nested-workflow") {
        continue;
      }
      const state = run.ticketStates.find((candidate) => candidate.ticketId === ticketId);
      if (state === undefined || !ticketAwaitsAppReviewRun(state, nestedRun.id)) continue;
      yield* resumeTicketAppReview({ run, ticketId, nestedRun, createdAt }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("ticket App Review preview-refresh resume failed", {
            runId: nestedRun.id,
            cause: Cause.pretty(cause),
          }),
        ),
      );
    }
  });

  const start: ImplementationWorkflowReactorShape["start"] = Effect.fn("start")(function* () {
    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (
          event.type !== "thread.planning-tickets-created" &&
          event.type !== "thread.implementation-run-launched" &&
          event.type !== "thread.activity-appended" &&
          event.type !== "thread.app-review-updated" &&
          event.type !== "thread.implementation-change-request-retry-requested" &&
          event.type !== "thread.implementation-run-retry-requested" &&
          event.type !== "thread.implementation-run-rerun-requested" &&
          event.type !== "thread.implementation-run-reset-requested" &&
          event.type !== "thread.implementation-run-skip-set" &&
          event.type !== "thread.implementation-run-cancel-requested" &&
          event.type !== "thread.app-review-workflow-launched" &&
          event.type !== "thread.app-review-workflow-updated" &&
          event.type !== "thread.workflow-resumed"
        ) {
          return Effect.void;
        }
        return worker.enqueue(event);
      }),
    );
    yield* recoverIncompleteIntegrations().pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("implementation workflow integration recovery failed", {
          cause: Cause.pretty(cause),
        }),
      ),
    );
    yield* reconcileLegacyQaRuns().pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("implementation workflow QA reconciliation failed", {
          cause: Cause.pretty(cause),
        }),
      ),
    );
    yield* recoverIncompleteBrowserReviews().pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("implementation workflow startup recovery failed", {
          cause: Cause.pretty(cause),
        }),
      ),
    );
    yield* recoverIncompleteStages().pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("implementation workflow stage recovery failed", {
          cause: Cause.pretty(cause),
        }),
      ),
    );
    yield* Effect.forkScoped(
      Effect.gen(function* () {
        yield* recoverRetryableRuns().pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("implementation workflow automatic retry sweep failed", {
              cause: Cause.pretty(cause),
            }),
          ),
        );
        yield* recoverIncompleteStages().pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("implementation workflow periodic stage recovery failed", {
              cause: Cause.pretty(cause),
            }),
          ),
        );
        yield* resumeAwaitingTicketAppReviews().pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("implementation workflow ticket App Review resume sweep failed", {
              cause: Cause.pretty(cause),
            }),
          ),
        );
      }).pipe(Effect.repeat(Schedule.spaced(Duration.seconds(30)))),
    );
  });

  return {
    start,
    drain: worker.drain,
    recoverRetryableRuns: () => recoverRetryableRuns().pipe(Effect.orDie),
    recoverIncompleteStages: () => recoverIncompleteStages().pipe(Effect.orDie),
  } satisfies ImplementationWorkflowReactorShape;
});

export const ImplementationWorkflowReactorLive = Layer.effect(ImplementationWorkflowReactor, make);
