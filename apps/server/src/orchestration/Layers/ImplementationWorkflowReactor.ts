import {
  CommandId,
  DevReviewId,
  EventId,
  GitCommandError,
  IMPLEMENTATION_RUN_MAX_QA_ATTEMPTS,
  MessageId,
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationImplementationRun,
  type OrchestrationImplementationValidationResult,
  type OrchestrationImplementationWorkerResult,
  type OrchestrationPlanningTicket,
  type OrchestrationReadModel,
  type OrchestrationThread,
  WORKFLOW_AUTOMATION_RUNTIME_MODE,
  type WorkspaceUserId,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { proposedPlanTitle } from "@t3tools/shared/orchestrationPlanning";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

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
  resolveWorkflowSubagentModelSelection,
  resolveWorkflowSubagentSpawnDefinition,
} from "../workflowSubagents.ts";

// Code Review is a single review-and-fix pass: the reviewer lands its own fixes and the change
// request is published from that commit, so there is no re-review cycle and no cycle budget. The
// `code-review-fixing` status and `fixOrigin: "code-review"` remain only so runs persisted by the
// previous re-review loop still decode and recover.

type ImplementationWorkflowEvent = Extract<
  OrchestrationEvent,
  {
    type:
      | "thread.implementation-run-launched"
      | "thread.activity-appended"
      | "thread.dev-review-updated"
      | "thread.implementation-change-request-retry-requested"
      | "thread.implementation-run-retry-requested"
      | "thread.implementation-run-cancel-requested";
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

type CodeReviewDirective = {
  readonly type: "implementation-code-review-result";
  readonly runId: string;
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

function findRunByDevReview(
  readModel: OrchestrationReadModel,
  reviewId: DevReviewId,
  sourceThreadId: ThreadId,
): OrchestrationImplementationRun | null {
  return (
    readModel.implementationRuns.find(
      (run) =>
        run.orchestratorThreadId === sourceThreadId &&
        run.devReviewIds.some((candidate) => candidate === reviewId),
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

function terminalLineageTicketIds(run: OrchestrationImplementationRun): ReadonlyArray<string> {
  if (run.terminalLineageTicketIds.length > 0) {
    return run.terminalLineageTicketIds;
  }
  const dependencyIds = new Set(run.ticketStates.flatMap((state) => state.dependencyTicketIds));
  return run.ticketStates
    .filter((state) => !dependencyIds.has(state.ticketId))
    .map((state) => state.ticketId);
}

function requiredValidationsPassed(input: {
  readonly requiredCommands: ReadonlyArray<string>;
  readonly validations: ReadonlyArray<OrchestrationImplementationValidationResult>;
}): boolean {
  return input.requiredCommands.every((requiredCommand) =>
    input.validations.some(
      (validation) =>
        validation.command.trim() === requiredCommand.trim() && validation.status === "passed",
    ),
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
    "Do not ask the user questions. Work TDD-style: write or update a focused failing test, implement the smallest behavior, run targeted validation, then report the result.",
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
}): string {
  const integrationInstructions =
    input.integration.conflictedTicketId === null
      ? [
          "All terminal worker branches were integrated programmatically. Do not merge worker branches again; run the required validations against the current orchestrator worktree.",
        ]
      : [
          `Programmatic integration stopped while merging ${input.integration.conflictedTicketId} (${input.integration.conflictedRefName}).`,
          `Conflicted files: ${input.integration.conflictedFiles.join(", ") || "unknown"}.`,
          `After resolving and committing that merge, merge these remaining terminal branches in order: ${input.integration.remainingRefNames.join(", ") || "none"}.`,
          "Then run the required validations.",
        ];
  return [
    `Run merge gate for implementation run ${input.run.id}.`,
    "",
    ...integrationInstructions,
    "If this fresh worktree has no installed dependencies, install them with the repository's declared package manager and lockfile before running validation. Missing worktree-local dependencies are setup work, not a validation failure.",
    "",
    "Required validation commands:",
    ...input.run.launchSummary.validationCommands.map((command) => `- ${command}`),
    "",
    "If native mobile files changed, also run:",
    "- vp run lint:mobile",
    "",
    "Do not ask the user questions. Finish with exactly one fenced JSON directive of type implementation-merge-gate-result for this runId.",
  ].join("\n");
}

function buildBrowserDevReviewPrompt(input: {
  readonly run: OrchestrationImplementationRun;
  readonly frontendUrl: string | null;
  readonly artifactMarkdown?: string;
}): string {
  return [
    `Perform browser dev review for implementation run ${input.run.id}.`,
    "",
    "Open the app with preview_open, record the session with dev_review_recording_start/stop, exercise the product with the preview_* tools, and capture captioned screenshots with dev_review_capture_screenshot. Do not ask the user questions.",
    "",
    input.frontendUrl === null
      ? "No frontend URL was resolved. If the app cannot be opened, mark the review blocked with concrete details."
      : `Feature URL: ${input.frontendUrl}`,
    `Worktree: ${input.run.orchestratorWorktreePath}`,
    `Diff command: git diff ${input.run.pinnedCommit}...HEAD`,
    "",
    input.run.artifactSource === "proposed-plan"
      ? `Review against the locked product intent and proposed plan below, as well as the actual diff and app behavior.\n\n${input.artifactMarkdown ?? "Proposed-plan context unavailable."}`
      : "Review against the Spec and planning tickets loaded on this implementation thread.",
    "Update the dev-review record with passed, failed, or blocked status and a document.",
  ].join("\n");
}

function buildFixPrompt(input: {
  readonly run: OrchestrationImplementationRun;
  readonly reviewId: DevReviewId;
}): string {
  return [
    `Fix browser dev-review failures for implementation run ${input.run.id}.`,
    "",
    "Do not ask the user questions. Make the smallest implementation changes needed in the orchestrator worktree, run focused validation, and report the fix result.",
    "",
    input.run.artifactSource === "proposed-plan"
      ? `Retrieve Dev Review ${input.reviewId} with workflow_dev_review_get before applying its findings. Review against the proposed-plan context already provided to this Fast feature run; do not load a missing Spec or tickets.`
      : `Retrieve Dev Review ${input.reviewId} with workflow_dev_review_get before applying its findings. Use workflow_tickets_list and workflow_ticket_get for the linked tickets.`,
    "",
    "Before reporting success, run every required validation command:",
    ...input.run.launchSummary.validationCommands.map((command) => `- ${command}`),
    `If git diff ${input.run.pinnedCommit}...HEAD includes apps/mobile, also run vp run lint:mobile, even when the current fix did not touch those files.`,
    "",
    "Finish with exactly one fenced JSON directive of type implementation-fix-result for this runId.",
  ].join("\n");
}

function buildCodeReviewPrompt(input: {
  readonly run: OrchestrationImplementationRun;
  readonly artifactMarkdown?: string;
}): string {
  const changeRequest = input.run.changeRequest;
  const fixedPoint = input.run.pinnedCommit;
  return [
    `Perform the implementation code review for implementation run ${input.run.id}. This is the only review pass: nothing re-reviews your work afterwards, and the change request is published from the commit you leave at HEAD.`,
    "",
    "Do not ask the user questions. Review the change along the Standards and Spec axes as described in your workflow instructions, then apply the fixes yourself and commit them.",
    "",
    input.run.devReviewExhaustedAt === null
      ? "Dev Review passed at this commit."
      : "Dev Review did not pass within its attempt budget for this run. Treat unresolved user-visible defects as review findings and fix what you reasonably can.",
    "",
    "Review scope:",
    `- worktree: ${input.run.orchestratorWorktreePath}`,
    `- fixed point: ${fixedPoint}`,
    `- diff command: git diff ${fixedPoint}...HEAD`,
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
    "Before reporting findings you fixed, run every required validation command and report each result in validations:",
    ...input.run.launchSummary.validationCommands.map((command) => `- ${command}`),
    `If git diff ${fixedPoint}...HEAD includes apps/mobile, also run vp run lint:mobile, even when your fixes did not touch those files.`,
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
    "Before reporting success, run every required validation command:",
    ...input.run.launchSummary.validationCommands.map((command) => `- ${command}`),
    `If git diff ${input.run.pinnedCommit}...HEAD includes apps/mobile, also run vp run lint:mobile, even when the current fix did not touch those files.`,
    "",
    "Finish with exactly one fenced JSON directive of type implementation-fix-result for this runId.",
  ].join("\n");
}

function buildMergeGateFixPrompt(input: {
  readonly run: OrchestrationImplementationRun;
  readonly reportMarkdown: string;
}): string {
  return [
    `Fix merge-gate failures for implementation run ${input.run.id}.`,
    "",
    "Do not ask the user questions. Resolve integration conflicts or validation failures in the orchestrator worktree, commit the result, and report the fix.",
    "",
    "Latest merge-gate report:",
    input.reportMarkdown,
    "",
    "Before reporting success, run every required validation command:",
    ...input.run.launchSummary.validationCommands.map((command) => `- ${command}`),
    `If git diff ${input.run.pinnedCommit}...HEAD includes apps/mobile, also run vp run lint:mobile, even when the current fix did not touch those files.`,
    "",
    "Finish with exactly one fenced JSON directive of type implementation-fix-result for this runId.",
  ].join("\n");
}

function productIntentMarkdown(thread: OrchestrationThread): string {
  const activity = thread.activities.findLast(
    (candidate) => candidate.kind === "product-intent-locked",
  );
  if (!activity || !isRecord(activity.payload)) return "Locked product intent unavailable.";
  const summary = activity.payload["summaryMarkdown"];
  return typeof summary === "string" && summary.trim().length > 0 ? summary : activity.summary;
}

function fastFeatureArtifactMarkdown(input: {
  readonly run: OrchestrationImplementationRun;
  readonly sourceThread: OrchestrationThread;
}): string {
  const plan = input.sourceThread.proposedPlans.find(
    (candidate) => candidate.id === input.run.sourceProposedPlan?.planId,
  );
  return [
    "## Locked product intent",
    productIntentMarkdown(input.sourceThread),
    "",
    "## Canonical proposed plan",
    plan?.planMarkdown ?? "Proposed plan unavailable.",
  ].join("\n");
}

function fastFeatureExecutionContract(run: OrchestrationImplementationRun): ReadonlyArray<string> {
  return [
    "## Execution identity",
    `- branch: ${run.orchestratorBranch}`,
    `- worktree: ${run.orchestratorWorktreePath}`,
    `- fixed source commit: ${run.pinnedCommit}`,
    "",
    "## Required validation",
    ...run.launchSummary.validationCommands.map((command) => `- ${command}`),
    "- vp run lint:mobile when native mobile files changed",
    "",
    "Finish with exactly one fenced JSON directive:",
    "```json",
    JSON.stringify(
      {
        type: "implementation-fast-build-result",
        runId: run.id,
        status: "succeeded",
        commitSha: "HEAD commit SHA",
        validations: [
          {
            command: "vp check",
            status: "passed",
            outputMarkdown: "summary",
            completedAt: "ISO timestamp",
          },
        ],
        notesMarkdown: "Implementation notes",
      },
      null,
      2,
    ),
    "```",
  ];
}

function buildFastFeaturePrompt(input: {
  readonly run: OrchestrationImplementationRun;
  readonly sourceThread: OrchestrationThread;
}): string {
  return [
    `Implement Fast feature run ${input.run.id}.`,
    "",
    "Do not ask the user questions. Implement the canonical plan in the exact branch and worktree below, validate it, and commit all completed changes.",
    "",
    fastFeatureArtifactMarkdown(input),
    "",
    ...fastFeatureExecutionContract(input.run),
  ].join("\n");
}

/**
 * Dev Review findings are sent back into the Build thread rather than a separate fixer thread, so
 * Build owns every commit on the orchestrator branch. The turn ends in the same
 * implementation-fast-build-result directive as the initial build, which re-enters Dev Review.
 */
function buildFastFeatureDevReviewFixPrompt(input: {
  readonly run: OrchestrationImplementationRun;
  readonly sourceThread: OrchestrationThread;
  readonly reviewId: DevReviewId;
  readonly attempt: number;
}): string {
  return [
    `Dev Review found problems with Fast feature run ${input.run.id}. Fix them in this same Build thread (Dev Review attempt ${input.attempt} of ${IMPLEMENTATION_RUN_MAX_QA_ATTEMPTS}).`,
    "",
    `Do not ask the user questions. Retrieve Dev Review ${input.reviewId} with workflow_dev_review_get, apply its findings with the smallest reliable changes, validate, and commit them on the branch below. Dev Review re-runs automatically against your new commit.`,
    "",
    "Review against the proposed-plan context already provided to this Fast feature run; do not load a missing Spec or tickets.",
    "",
    fastFeatureArtifactMarkdown(input),
    "",
    ...fastFeatureExecutionContract(input.run),
  ].join("\n");
}

/**
 * Automated-review provenance for the published change request. A run that exhausted Dev Review is
 * still published, so the unpassed review has to be visible on the change request itself.
 */
function changeRequestReviewNote(run: OrchestrationImplementationRun): string {
  const lines = ["## Automated review"];
  if (run.devReviewExhaustedAt === null) {
    lines.push(`- Dev Review: passed after ${run.qaAttemptCount} attempt(s).`);
  } else {
    lines.push(
      `- ⚠️ Dev Review: **did not pass** after ${run.qaAttemptCount} attempt(s) (limit ${IMPLEMENTATION_RUN_MAX_QA_ATTEMPTS}). This change request was published with the browser dev review still failing — verify the affected flow manually before merging.`,
    );
  }
  lines.push(
    run.latestCodeReviewReportMarkdown === null
      ? "- Code Review: no report recorded."
      : "- Code Review: completed in a single review-and-fix pass; findings were fixed in this branch.",
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

  const serverCommandId = (tag: string) =>
    crypto.randomUUIDv4.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));
  const serverEventId = () => crypto.randomUUIDv4.pipe(Effect.map(EventId.make));
  const serverMessageId = (tag: string) =>
    crypto.randomUUIDv4.pipe(Effect.map((uuid) => MessageId.make(`message-${tag}-${uuid}`)));
  const serverThreadId = (tag: string) =>
    crypto.randomUUIDv4.pipe(Effect.map((uuid) => ThreadId.make(`thread-${tag}-${uuid}`)));
  const serverDevReviewId = () =>
    crypto.randomUUIDv4.pipe(Effect.map((uuid) => DevReviewId.make(`dev-review-${uuid}`)));

  const updateRun = Effect.fn("ImplementationWorkflowReactor.updateRun")(function* (input: {
    readonly sourceThreadId: ThreadId;
    readonly run: OrchestrationImplementationRun;
    readonly createdAt: string;
  }) {
    // `canceled` is terminal. In-flight stage work (a late build directive, a
    // recovery sweep already past its guard) must not resurrect a run the user
    // stopped, so drop any write that would move it out of `canceled`.
    const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
    if (findRunById(readModel, input.run.id)?.status === "canceled") return;
    yield* orchestrationEngine.dispatch({
      type: "thread.implementation-run.update",
      commandId: yield* serverCommandId("implementation-run-update"),
      threadId: input.sourceThreadId,
      run: input.run,
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

  const blockRun = Effect.fn("ImplementationWorkflowReactor.blockRun")(function* (input: {
    readonly sourceThreadId: ThreadId;
    readonly run: OrchestrationImplementationRun;
    readonly reasonMarkdown: string;
    readonly updatedAt: string;
    readonly retryableStage?:
      | "source-dirty"
      | "worktree-setup"
      | "worker-setup"
      | "worker-execution"
      | "integration"
      | "merge-gate"
      | "app-dev-stack"
      | "dev-review"
      | "code-review"
      | "fixer"
      | "build"
      | "change-request";
    /**
     * Set when only a human can clear the condition (a moved source branch, a
     * conflicting worktree). `recoverRetryableRuns` skips these, so the attempt
     * budget is not spent by the 30s sweep before the user has read the message.
     */
    readonly humanBlocked?: boolean;
  }) {
    const previousAttempts =
      input.retryableStage !== undefined &&
      input.run.retryableFailure?.stage === input.retryableStage
        ? input.run.retryableFailure.attemptCount
        : 0;
    const blockedRun: OrchestrationImplementationRun = {
      ...input.run,
      status: "needs-human-attention",
      retryableFailure:
        input.retryableStage === undefined
          ? input.run.retryableFailure
          : {
              stage: input.retryableStage,
              detail: input.reasonMarkdown,
              failedAt: input.updatedAt,
              attemptCount: previousAttempts + 1,
              maxAttempts: 3,
              humanBlocked: input.humanBlocked ?? false,
            },
      updatedAt: input.updatedAt,
    };
    yield* updateRun({
      sourceThreadId: input.sourceThreadId,
      run: blockedRun,
      createdAt: input.updatedAt,
    });
    yield* appendActivity({
      threadId: input.run.orchestratorThreadId,
      tone: "error",
      kind: "implementation-workflow.needs-human-attention",
      summary: "Implementation workflow needs human attention",
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
    if (existing === undefined || existing.status !== "ready") return input.run;

    const dependencies = yield* Effect.forEach(existing.dependencyTicketIds, (ticketId) =>
      verifiedDependency({ run: input.run, ticketId }),
    );
    const baseDependency = dependencies[0];
    const baseRefName = baseDependency?.branch ?? input.run.orchestratorBranch;
    const worktreeStartRef = baseDependency?.commitSha ?? input.run.orchestratorBranch;

    const existingWorktreeHead = yield* gitWorkflow
      .resolveCommit({ cwd: plannedWorker.worktreePath, ref: "HEAD" })
      .pipe(Effect.option);
    if (Option.isSome(existingWorktreeHead)) {
      const status = yield* gitWorkflow.localStatus({ cwd: plannedWorker.worktreePath });
      if (!status.isRepo || status.refName !== plannedWorker.branch) {
        return yield* new GitCommandError({
          operation: "ImplementationWorkflowReactor.createWorker",
          command: "git status",
          cwd: plannedWorker.worktreePath,
          detail: `Existing worker worktree is not on expected branch '${plannedWorker.branch}'.`,
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
      refs: dependencies.slice(1).map((dependency) => ({
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

    const workerThreadId = yield* serverThreadId("implementation-worker");
    const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
    const sourceThread = findThread(readModel, input.sourceThreadId);
    const ticket = ticketsById(sourceThread ?? input.orchestratorThread).get(input.ticketId);

    yield* orchestrationEngine.dispatch({
      type: "thread.create",
      commandId: yield* serverCommandId("implementation-worker-create"),
      threadId: workerThreadId,
      projectId: input.orchestratorThread.projectId,
      ownerUserId: input.ownerUserId,
      parentThreadId: input.run.orchestratorThreadId,
      workflowRole: "implementation-worker",
      ...(input.orchestratorThread.workflowContext == null
        ? {}
        : {
            workflowContext: {
              ...input.orchestratorThread.workflowContext,
              ticketScope: [input.ticketId],
            },
          }),
      title: `Implement ${ticket?.title ?? input.ticketId}`,
      modelSelection: input.orchestratorThread.modelSelection,
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
              attemptCount: state.attemptCount + 1,
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

      const readyTicketIds = input.run.ticketStates
        .filter((ticketState) => ticketState.status === "ready")
        .map((ticketState) => ticketState.ticketId);
      const startResults = yield* Effect.forEach(
        readyTicketIds,
        (ticketId) =>
          Effect.result(
            createWorker({
              sourceThreadId: input.sourceThreadId,
              orchestratorThread,
              run: input.run,
              ticketId,
              ownerUserId: orchestratorThread.ownerUserId,
              createdAt: input.createdAt,
            }),
          ).pipe(Effect.map((result) => ({ ticketId, result }))),
        { concurrency: 4 },
      );
      const startedRuns = startResults.flatMap(({ result }) =>
        result._tag === "Success" ? [result.success] : [],
      );
      const startedStates = new Map(
        startedRuns.flatMap((run) =>
          run.ticketStates
            .filter(
              (state) => state.status === "running" && readyTicketIds.includes(state.ticketId),
            )
            .map((state) => [state.ticketId, state] as const),
        ),
      );
      const nextRun =
        startedStates.size === 0
          ? input.run
          : ({
              ...input.run,
              ticketStates: input.run.ticketStates.map(
                (state) => startedStates.get(state.ticketId) ?? state,
              ),
              retryableFailure: null,
              updatedAt: input.createdAt,
            } satisfies OrchestrationImplementationRun);
      if (nextRun !== input.run) {
        yield* updateRun({
          sourceThreadId: input.sourceThreadId,
          run: nextRun,
          createdAt: input.createdAt,
        });
      }
      const failedStarts = startResults.filter(({ result }) => result._tag === "Failure");
      if (failedStarts.length > 0) {
        return yield* blockRun({
          sourceThreadId: input.sourceThreadId,
          run: nextRun,
          retryableStage: "worker-setup",
          reasonMarkdown: [
            "Ticket worker setup failed.",
            "",
            ...failedStarts.map(({ ticketId, result }) =>
              result._tag === "Failure"
                ? `- ${ticketId}: ${errorDetail(result.failure)}`
                : `- ${ticketId}: unknown setup failure`,
            ),
          ].join("\n"),
          updatedAt: input.createdAt,
        });
      }
      return nextRun;
    },
  );

  const startMergeGate = Effect.fn("ImplementationWorkflowReactor.startMergeGate")(
    function* (input: {
      readonly sourceThreadId: ThreadId;
      readonly run: OrchestrationImplementationRun;
      readonly integration: BranchIntegration;
      readonly createdAt: string;
    }) {
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
      const validatingRun: OrchestrationImplementationRun = {
        ...input.run,
        status: "validating",
        activeValidationHeadSha: validationHead.commitSha,
        activeValidatorThreadId: validatorThreadId,
        mergeGateAttemptCount: input.run.mergeGateAttemptCount + 1,
        validatedHeadSha: null,
        devReviewedHeadSha: null,
        activeDevReviewHeadSha: null,
        activeDevReviewThreadId: null,
        codeReviewedHeadSha: null,
        activeCodeReviewHeadSha: null,
        activeCodeReviewThreadId: null,
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
        title: "Implementation merge gate",
        modelSelection: orchestratorThread.modelSelection,
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
            buildMergeGatePrompt({ run: input.run, integration: input.integration }),
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
        summary: "Merge gate started",
        payload: { runId: input.run.id, validatorThreadId },
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
    for (const state of run.ticketStates) {
      if (state.status !== "succeeded" || state.workerResult?.status !== "succeeded") {
        return yield* new GitCommandError({
          operation: "ImplementationWorkflowReactor.verifyIntegratedWorkerCommits",
          command: "git merge-base --is-ancestor",
          cwd: run.orchestratorWorktreePath,
          detail: `Ticket '${state.ticketId}' has no accepted worker commit.`,
        });
      }
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
      const terminalBranches = yield* Effect.forEach(terminalIds, (ticketId) =>
        verifiedDependency({ run: integratingRun, ticketId }),
      );
      const integration = yield* integrateRefs({
        cwd: integratingRun.orchestratorWorktreePath,
        baseTicketId: null,
        baseRefName: integratingRun.orchestratorBranch,
        refs: terminalBranches.map((terminal) => ({
          ticketId: terminal.ticketId,
          refName: terminal.commitSha,
        })),
      });

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

      const integrationHeadSha =
        integration.conflictedTicketId === null
          ? yield* verifyIntegratedWorkerCommits(integratingRun)
          : null;
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
      const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
      const orchestratorThread = findThread(readModel, input.run.orchestratorThreadId);
      if (orchestratorThread === null) return;
      const artifactSourceThread = findThread(readModel, input.sourceThreadId);
      const artifactMarkdown =
        input.run.artifactSource === "proposed-plan" && artifactSourceThread !== null
          ? fastFeatureArtifactMarkdown({ run: input.run, sourceThread: artifactSourceThread })
          : undefined;

      const ensuringRun: OrchestrationImplementationRun = {
        ...input.run,
        status: "qa-reviewing",
        appDevStack: {
          ...input.run.appDevStack,
          status: "ensuring",
          requestedAt: input.run.appDevStack.requestedAt || input.createdAt,
          updatedAt: input.createdAt,
        },
        updatedAt: input.createdAt,
      };

      const hasResolvedFrontend =
        input.run.appDevStack.status === "ready" && input.run.appDevStack.frontendUrl !== null;
      const stackResult = hasResolvedFrontend
        ? null
        : yield* appDevStackManager
            .autoCreate({
              worktreePath: input.run.orchestratorWorktreePath,
              displayName:
                input.run.artifactSource === "proposed-plan"
                  ? `Fast feature ${input.run.id}`
                  : `Implementation ${input.run.id}`,
              gitBranch: input.run.orchestratorBranch,
            })
            .pipe(Effect.result);

      const stackFailureDetail =
        stackResult?._tag === "Failure" ? errorDetail(stackResult.failure) : null;
      const stack = stackResult?._tag === "Success" ? stackResult.success : null;
      if (stackFailureDetail !== null) {
        yield* blockRun({
          sourceThreadId: input.sourceThreadId,
          run: {
            ...ensuringRun,
            appDevStack: {
              ...ensuringRun.appDevStack,
              status: "failed",
              lastErrorMarkdown: stackFailureDetail,
              updatedAt: input.createdAt,
            },
          },
          retryableStage: "app-dev-stack",
          reasonMarkdown: `App dev stack failed before browser Dev Review: ${stackFailureDetail}`,
          updatedAt: input.createdAt,
        });
        return;
      }
      const frontendUrl = hasResolvedFrontend
        ? input.run.appDevStack.frontendUrl
        : (stack?.frontendUrl ?? null);
      const reviewHead = yield* gitWorkflow.resolveCommit({
        cwd: input.run.orchestratorWorktreePath,
        ref: "HEAD",
      });
      if (
        input.run.validatedHeadSha === null ||
        input.run.validatedHeadSha !== reviewHead.commitSha
      ) {
        yield* blockRun({
          sourceThreadId: input.sourceThreadId,
          run: input.run,
          retryableStage: "dev-review",
          reasonMarkdown: `Dev Review requires a merge-gate pass for current HEAD '${reviewHead.commitSha}', but the validated HEAD is '${input.run.validatedHeadSha ?? "missing"}'.`,
          updatedAt: input.createdAt,
        });
        return;
      }

      const reviewId = yield* serverDevReviewId();
      const reviewThreadId = yield* serverThreadId("implementation-qa-reviewer");
      const reviewRun: OrchestrationImplementationRun = {
        ...ensuringRun,
        appDevStack: hasResolvedFrontend
          ? input.run.appDevStack
          : stack === null
            ? ensuringRun.appDevStack
            : {
                status: "ready",
                stackId: stack.stack.id,
                stackStatus: stack.stack.status,
                frontendUrl,
                frontendServiceName: stack.frontendServiceName,
                displayName: stack.stack.displayName,
                lastErrorMarkdown: null,
                requestedAt: ensuringRun.appDevStack.requestedAt || input.createdAt,
                updatedAt: input.createdAt,
              },
        devReviewIds: [...ensuringRun.devReviewIds, reviewId],
        activeDevReviewHeadSha: reviewHead.commitSha,
        activeDevReviewThreadId: reviewThreadId,
        qaAttemptCount: ensuringRun.qaAttemptCount + 1,
        retryableFailure: null,
        updatedAt: input.createdAt,
      };

      yield* updateRun({
        sourceThreadId: input.sourceThreadId,
        run: reviewRun,
        createdAt: input.createdAt,
      });

      const settings = yield* serverSettingsService.getSettings.pipe(
        Effect.orElseSucceed(() => undefined),
      );
      const spawnDefinition = resolveWorkflowSubagentSpawnDefinition(
        WORKFLOW_PROMPT_IDS.implementationBrowserDevReviewCodex,
      );
      const resolved = resolveWorkflowSubagentModelSelection({
        definition: spawnDefinition,
        parentModelSelection: orchestratorThread.modelSelection,
        settings,
      });
      if (resolved.fallbackDetail !== null) {
        yield* appendActivity({
          threadId: input.run.orchestratorThreadId,
          tone: "info",
          kind: "implementation-workflow.model-hardlock-fallback",
          summary: "Browser dev review model hardlock not honored",
          payload: {
            runId: input.run.id,
            detail: resolved.fallbackDetail,
            requestedDriver: spawnDefinition?.modelOverride?.driver ?? null,
            requestedModel: spawnDefinition?.modelOverride?.model ?? null,
          },
          createdAt: input.createdAt,
        });
      }

      yield* orchestrationEngine.dispatch({
        type: "thread.dev-review.launch",
        commandId: yield* serverCommandId("implementation-browser-review-launch"),
        sourceThreadId: input.run.orchestratorThreadId,
        reviewThreadId,
        reviewId,
        planningTicketIds: [...input.run.planningTicketIds],
        message: {
          messageId: yield* serverMessageId("implementation-browser-review"),
          role: "user",
          text: appendWorkflowSkillCommandSection(
            buildBrowserDevReviewPrompt({
              run: input.run,
              frontendUrl,
              ...(artifactMarkdown === undefined ? {} : { artifactMarkdown }),
            }),
            WORKFLOW_PROMPT_IDS.implementationBrowserDevReviewCodex,
          ),
          attachments: [],
        },
        modelSelection: resolved.modelSelection,
        runtimeMode: orchestratorThread.runtimeMode,
        workflowPromptId: WORKFLOW_PROMPT_IDS.implementationBrowserDevReviewCodex,
        createdAt: input.createdAt,
      });

      yield* appendActivity({
        threadId: input.run.orchestratorThreadId,
        tone: "info",
        kind: "implementation-browser-review-started",
        summary: `Browser dev review started (attempt ${reviewRun.qaAttemptCount})`,
        payload: {
          runId: input.run.id,
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
    }) {
      const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
      const orchestratorThread = findThread(readModel, input.run.orchestratorThreadId);
      if (orchestratorThread === null) return;
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
      // Code Review normally requires a passing Dev Review at this exact HEAD. When Dev Review used
      // every attempt without passing, the run still continues — but only from a build-validated,
      // clean commit, so the reviewer never starts from unvalidated work.
      if (input.run.devReviewExhaustedAt === null) {
        if (
          input.run.devReviewedHeadSha === null ||
          input.run.devReviewedHeadSha !== reviewHead.commitSha
        ) {
          yield* blockRun({
            sourceThreadId: input.sourceThreadId,
            run: input.run,
            retryableStage: "dev-review",
            reasonMarkdown: `Code Review requires a passing Dev Review for current HEAD '${reviewHead.commitSha}', but the dev-reviewed HEAD is '${input.run.devReviewedHeadSha ?? "missing"}'.`,
            updatedAt: input.createdAt,
          });
          return;
        }
      } else {
        const reviewStatus = yield* gitWorkflow.localStatus({
          cwd: input.run.orchestratorWorktreePath,
        });
        if (
          input.run.validatedHeadSha !== reviewHead.commitSha ||
          !reviewStatus.isRepo ||
          reviewStatus.refName !== input.run.orchestratorBranch ||
          reviewStatus.hasWorkingTreeChanges
        ) {
          yield* blockRun({
            sourceThreadId: input.sourceThreadId,
            run: input.run,
            retryableStage: "dev-review",
            reasonMarkdown: `Dev Review did not pass, so Code Review requires a validated, clean HEAD on '${input.run.orchestratorBranch}'. Current HEAD is '${reviewHead.commitSha}' and the validated HEAD is '${input.run.validatedHeadSha ?? "missing"}'.`,
            updatedAt: input.createdAt,
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
        updatedAt: input.createdAt,
      };
      yield* updateRun({
        sourceThreadId: input.sourceThreadId,
        run: reviewingRun,
        createdAt: input.createdAt,
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
        modelSelection: orchestratorThread.modelSelection,
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

  const fileChangeRequest = Effect.fn("ImplementationWorkflowReactor.fileChangeRequest")(
    function* (input: {
      readonly sourceThreadId: ThreadId;
      readonly run: OrchestrationImplementationRun;
      readonly createdAt: string;
    }) {
      const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
      const sourceThread = findThread(readModel, input.sourceThreadId);
      const sourcePlan = sourceThread?.proposedPlans.find(
        (plan) => plan.id === input.run.sourceProposedPlan?.planId,
      );
      const commitTitle =
        input.run.artifactSource === "proposed-plan"
          ? (proposedPlanTitle(sourcePlan?.planMarkdown ?? "") ?? "Fast feature")
          : `Implement ${input.run.specId}`;
      const expectedHeadSha = input.run.codeReviewedHeadSha;
      if (expectedHeadSha === null) {
        yield* blockRun({
          sourceThreadId: input.sourceThreadId,
          run: input.run,
          retryableStage: "code-review",
          reasonMarkdown:
            "Cannot publish a change request before Code Review accepts an exact HEAD.",
          updatedAt: input.createdAt,
        });
        return;
      }
      // Code Review commits its own fixes, so its accepted HEAD is the newest commit and the
      // merge-gate and Dev Review evidence necessarily point at earlier commits. Dev Review may also
      // never have passed. Require only that the run was validated at some point and that Code Review
      // accepted the exact commit being published; createOrOpenChangeRequest re-verifies that commit
      // against HEAD and refuses a dirty worktree.
      if (input.run.validatedHeadSha === null) {
        yield* blockRun({
          sourceThreadId: input.sourceThreadId,
          run: input.run,
          retryableStage: "merge-gate",
          reasonMarkdown: `Cannot publish HEAD '${expectedHeadSha}' because the run has no passing validation on record.`,
          updatedAt: input.createdAt,
        });
        return;
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
      const result = yield* gitWorkflow
        .createOrOpenChangeRequest({
          cwd: publishingRun.orchestratorWorktreePath,
          actionId: publishingRun.id,
          baseRefName: publishingRun.baseBranch,
          headRefName: publishingRun.orchestratorBranch,
          expectedHeadSha,
          threadId: publishingRun.orchestratorThreadId,
          commitMessage: `${commitTitle}\n\n${reviewOutcomeNote}`,
          pullRequestBodyNote: reviewOutcomeNote,
        })
        .pipe(Effect.result);

      if (result._tag === "Failure") {
        yield* updateRun({
          sourceThreadId: input.sourceThreadId,
          run: {
            ...publishingRun,
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
                publishingRun.retryableFailure?.stage === "change-request"
                  ? publishingRun.retryableFailure.attemptCount + 1
                  : 1,
              maxAttempts: 3,
              humanBlocked: false,
            },
            updatedAt: input.createdAt,
          },
          createdAt: input.createdAt,
        });
        yield* appendActivity({
          threadId: publishingRun.orchestratorThreadId,
          tone: "error",
          kind: "implementation-change-request-filed",
          summary: "Change request publication failed",
          payload: {
            runId: publishingRun.id,
            status: "failed",
            detail: errorDetail(result.failure),
          },
          createdAt: input.createdAt,
        });
        return;
      }

      yield* appendActivity({
        threadId: publishingRun.orchestratorThreadId,
        tone: "info",
        kind: "implementation-change-request-filed",
        summary: `Change request filed (#${result.success.number})`,
        payload: {
          runId: publishingRun.id,
          status: "filed",
          url: result.success.url,
          number: result.success.number,
        },
        createdAt: input.createdAt,
      });

      const completedRun: OrchestrationImplementationRun = {
        ...publishingRun,
        status: "completed",
        changeRequest: result.success,
        changeRequestFailure: null,
        retryableFailure: null,
        updatedAt: input.createdAt,
      };
      yield* updateRun({
        sourceThreadId: input.sourceThreadId,
        run: completedRun,
        createdAt: input.createdAt,
      });
      yield* appendActivity({
        threadId: publishingRun.orchestratorThreadId,
        tone: "info",
        kind: "implementation-run-completed",
        summary: "Implementation run completed",
        payload: { runId: publishingRun.id },
        createdAt: input.createdAt,
      });
    },
  );

  const ensureFastFeatureRun = Effect.fn("ImplementationWorkflowReactor.ensureFastFeatureRun")(
    function* (input: {
      readonly sourceThreadId: ThreadId;
      readonly run: OrchestrationImplementationRun;
      readonly createdAt: string;
    }) {
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
      if (!sourceStatus.isRepo || sourceStatus.refName !== input.run.baseBranch) {
        yield* blockRun({
          sourceThreadId: input.sourceThreadId,
          run: input.run,
          retryableStage: "source-dirty",
          humanBlocked: true,
          reasonMarkdown: `The source worktree must be on the captured branch '${input.run.baseBranch}', but Git reports '${sourceStatus.refName ?? "detached HEAD"}'. Switch back to the captured branch, then retry.`,
          updatedAt: input.createdAt,
        });
        return;
      }
      const setupRun =
        input.run.retryableFailure?.stage === "source-dirty"
          ? yield* gitWorkflow.resolveCommit({ cwd: sourceCwd, ref: "HEAD" }).pipe(
              Effect.map(({ commitSha }) => ({
                ...input.run,
                pinnedCommit: commitSha,
                launchSummary: { ...input.run.launchSummary, pinnedCommit: commitSha },
              })),
            )
          : input.run;

      // A dirty source worktree does not block the run: the Fast feature worktree is
      // created from the pinned commit, so uncommitted work is simply not part of it.
      // Say so on the source thread — that is where the user is reading — rather than
      // refusing to start, which made the workflow unusable on any working checkout.
      if (sourceStatus.hasWorkingTreeChanges) {
        yield* appendActivity({
          threadId: input.sourceThreadId,
          tone: "info",
          kind: "fast-feature.source-dirty-ignored",
          summary: "Uncommitted source changes are not included in this run",
          payload: {
            runId: setupRun.id,
            pinnedCommit: setupRun.pinnedCommit,
            reasonMarkdown: `The source worktree has modified, staged, or untracked files. This Fast feature run was created from commit \`${setupRun.pinnedCommit}\` and does **not** include them. Commit them and relaunch if they should be part of the run.`,
          },
          createdAt: input.createdAt,
        });
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

      // Keep `retryableFailure` while the stage re-runs. Clearing it here would
      // reset `blockRun`'s attempt counter on every resume, so a stage that
      // keeps failing would never exhaust `maxAttempts` and the 30s sweep in
      // `recoverRetryableRuns` would relaunch it forever. Success paths
      // (e.g. `handleFastBuildResult`) clear it once the stage actually passes.
      let resumedRun: OrchestrationImplementationRun = {
        ...setupRun,
        status: "running",
        updatedAt: input.createdAt,
      };
      if (setupRun.appDevStack.status !== "ready") {
        const stackResult = yield* appDevStackManager
          .autoCreate({
            worktreePath: setupRun.orchestratorWorktreePath,
            displayName: `Fast feature ${setupRun.id}`,
            gitBranch: setupRun.orchestratorBranch,
          })
          .pipe(Effect.result);
        resumedRun = {
          ...resumedRun,
          appDevStack:
            stackResult._tag === "Success"
              ? {
                  status: "ready",
                  stackId: stackResult.success.stack.id,
                  stackStatus: stackResult.success.stack.status,
                  frontendUrl: stackResult.success.frontendUrl,
                  frontendServiceName: stackResult.success.frontendServiceName,
                  displayName: stackResult.success.stack.displayName,
                  lastErrorMarkdown: null,
                  requestedAt: setupRun.appDevStack.requestedAt || input.createdAt,
                  updatedAt: input.createdAt,
                }
              : {
                  ...setupRun.appDevStack,
                  status: "failed",
                  lastErrorMarkdown: errorDetail(stackResult.failure),
                  requestedAt: setupRun.appDevStack.requestedAt || input.createdAt,
                  updatedAt: input.createdAt,
                },
        };
      }
      yield* updateRun({
        sourceThreadId: input.sourceThreadId,
        run: resumedRun,
        createdAt: input.createdAt,
      });

      const refreshed = yield* projectionSnapshotQuery.getCommandReadModel();
      const currentImplementer = findThread(refreshed, setupRun.orchestratorThreadId);
      if (currentImplementer?.latestTurn?.state === "running") return;
      const shouldStart =
        currentImplementer?.latestTurn === null ||
        resumedRun.fastBuildResult?.status === "failed" ||
        resumedRun.fastBuildResult?.status === "blocked";
      if (!shouldStart) return;
      yield* orchestrationEngine.dispatch({
        type: "thread.turn.start",
        commandId: yield* serverCommandId("fast-feature-build-turn"),
        threadId: setupRun.orchestratorThreadId,
        message: {
          messageId: yield* serverMessageId("fast-feature-build"),
          role: "user",
          text: buildFastFeaturePrompt({ run: resumedRun, sourceThread }),
          attachments: [],
        },
        titleSeed: implementerThread.title,
        runtimeMode: implementerThread.runtimeMode,
        interactionMode: "default",
        ...(resumedRun.sourceProposedPlan === null
          ? {}
          : { sourceProposedPlan: resumedRun.sourceProposedPlan }),
        createdAt: input.createdAt,
      });
    },
  );

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
      yield* gitWorkflow.createWorktree({
        cwd: project.workspaceRoot,
        refName: event.payload.run.pinnedCommit,
        newRefName: event.payload.run.orchestratorBranch,
        baseRefName: event.payload.run.baseBranch,
        path: event.payload.run.orchestratorWorktreePath,
      });

      yield* orchestrationEngine.dispatch({
        type: "thread.meta.update",
        commandId: yield* serverCommandId("implementation-orchestrator-meta"),
        threadId: event.payload.run.orchestratorThreadId,
        branch: event.payload.run.orchestratorBranch,
        worktreePath: event.payload.run.orchestratorWorktreePath,
      });

      // Provision the app dev stack alongside the worktree so it is warm before
      // Dev Review; a failure here is retried by `startBrowserReview`'s ensure.
      let launchedRun: OrchestrationImplementationRun = runningRun;
      if (runningRun.appDevStack.status !== "ready") {
        const stackResult = yield* appDevStackManager
          .autoCreate({
            worktreePath: runningRun.orchestratorWorktreePath,
            displayName: `Implementation ${runningRun.id}`,
            gitBranch: runningRun.orchestratorBranch,
          })
          .pipe(Effect.result);
        launchedRun = {
          ...runningRun,
          appDevStack:
            stackResult._tag === "Success"
              ? {
                  status: "ready",
                  stackId: stackResult.success.stack.id,
                  stackStatus: stackResult.success.stack.status,
                  frontendUrl: stackResult.success.frontendUrl,
                  frontendServiceName: stackResult.success.frontendServiceName,
                  displayName: stackResult.success.stack.displayName,
                  lastErrorMarkdown: null,
                  requestedAt: runningRun.appDevStack.requestedAt || event.occurredAt,
                  updatedAt: event.occurredAt,
                }
              : {
                  ...runningRun.appDevStack,
                  status: "failed",
                  lastErrorMarkdown: errorDetail(stackResult.failure),
                  requestedAt: runningRun.appDevStack.requestedAt || event.occurredAt,
                  updatedAt: event.occurredAt,
                },
        };
      }

      yield* updateRun({
        sourceThreadId: event.payload.sourceThreadId,
        run: launchedRun,
        createdAt: event.occurredAt,
      });
      yield* startReadyWorkers({
        sourceThreadId: event.payload.sourceThreadId,
        run: launchedRun,
        createdAt: event.occurredAt,
      });
      const ticketTitles = ticketsById(sourceThread);
      yield* appendActivity({
        threadId: launchedRun.orchestratorThreadId,
        tone: "info",
        kind: "implementation-run-launched",
        summary: `Implementation run launched with ${launchedRun.ticketStates.length} ticket(s)`,
        payload: {
          runId: launchedRun.id,
          ticketCount: launchedRun.ticketStates.length,
          tickets: launchedRun.ticketStates.map((state) => ({
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
          retryableStage: "worker-execution",
          reasonMarkdown: `Worker result identity does not match the active assignment for thread '${event.payload.threadId}'.`,
          updatedAt: directive.reportedAt,
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

      if (directive.status === "failed") {
        const failedRun: OrchestrationImplementationRun = {
          ...run,
          status: "needs-human-attention",
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
          workerResults: [...run.workerResults, directive],
          retryableFailure: {
            stage: "worker-execution",
            detail: directive.notesMarkdown || `Worker '${directive.ticketId}' failed.`,
            failedAt: directive.reportedAt,
            attemptCount: (run.retryableFailure?.attemptCount ?? 0) + 1,
            maxAttempts: 3,
            humanBlocked: false,
          },
          updatedAt: directive.reportedAt,
        };
        yield* updateRun({ sourceThreadId, run: failedRun, createdAt: directive.reportedAt });
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
            reasonMarkdown: errorDetail(error),
            updatedAt: directive.reportedAt,
          }).pipe(Effect.as(null)),
        ),
      );
      if (acceptedDirective === null) return;

      const succeededRun = markDependentsReady(
        {
          ...run,
          ticketStates: run.ticketStates.map((state) =>
            state.workerThreadId === event.payload.threadId
              ? {
                  ...state,
                  status: "succeeded" as const,
                  branch: directive.branch,
                  worktreePath: directive.worktreePath,
                  workerResult: acceptedDirective,
                  updatedAt: directive.reportedAt,
                }
              : state,
          ),
          workerResults: [...run.workerResults, acceptedDirective],
          retryableFailure: null,
          updatedAt: directive.reportedAt,
        },
        directive.reportedAt,
      );

      yield* updateRun({ sourceThreadId, run: succeededRun, createdAt: directive.reportedAt });
      if (succeededRun.ticketStates.every((state) => state.status === "succeeded")) {
        yield* integrateCompletedRun({
          sourceThreadId,
          run: succeededRun,
          createdAt: directive.reportedAt,
        }).pipe(
          Effect.catchCause((cause) => {
            if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
            return blockRun({
              sourceThreadId,
              run: { ...succeededRun, status: "integrating" },
              retryableStage: "integration",
              reasonMarkdown: `Final branch integration failed.\n\n\`\`\`\n${Cause.pretty(cause)}\n\`\`\``,
              updatedAt: directive.reportedAt,
            });
          }),
        );
        return;
      }

      yield* startReadyWorkers({
        sourceThreadId,
        run: succeededRun,
        createdAt: directive.reportedAt,
      });
    },
  );

  const handleFastBuildResult = Effect.fn("ImplementationWorkflowReactor.handleFastBuildResult")(
    function* (
      event: Extract<ImplementationWorkflowEvent, { type: "thread.activity-appended" }>,
      directive: FastBuildDirective,
    ) {
      const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
      const run = findRunById(readModel, directive.runId);
      if (
        run === null ||
        run.artifactSource !== "proposed-plan" ||
        run.orchestratorThreadId !== event.payload.threadId
      ) {
        return;
      }
      // Build owns dev-review fixes too, so a run legitimately reports several successful builds.
      // Only ignore a repeat result once the branch has moved past Build into review or publication.
      if (run.status !== "running" && run.status !== "launch-pending") return;
      const sourceThreadId = findRunSourceThreadId({ readModel, run });
      if (sourceThreadId === null) return;
      const updatedAt = event.payload.activity.createdAt;
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
        !requiredValidationsPassed({
          requiredCommands: run.launchSummary.validationCommands,
          validations: directive.validations,
        })
      ) {
        yield* blockRun({
          sourceThreadId,
          run: { ...run, fastBuildResult: buildResult, updatedAt },
          retryableStage: "build",
          reasonMarkdown: `Fast feature Build did not report passing results for every required validation command: ${run.launchSummary.validationCommands.join(", ")}.`,
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
      const changedFiles = yield* gitWorkflow.listChangedFiles({
        cwd: run.orchestratorWorktreePath,
        baseRef: run.pinnedCommit,
        headRef: head.commitSha,
      });
      const changedNativeMobileFiles = changedFiles.some(
        (path) => path === "apps/mobile" || path.startsWith("apps/mobile/"),
      );
      if (
        changedNativeMobileFiles &&
        !requiredValidationsPassed({
          requiredCommands: ["vp run lint:mobile"],
          validations: directive.validations,
        })
      ) {
        yield* blockRun({
          sourceThreadId,
          run: { ...run, fastBuildResult: buildResult, updatedAt },
          retryableStage: "build",
          reasonMarkdown:
            "Fast feature Build changed native mobile files without reporting a passing `vp run lint:mobile` validation.",
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
        finalValidation: validationSummary(
          directive.validations,
          "fast feature build",
          directive.notesMarkdown,
          updatedAt,
        ),
        finalValidationResults: [...directive.validations],
        integrationHeadSha: head.commitSha,
        validatedHeadSha: head.commitSha,
        retryableFailure: null,
        updatedAt,
      };
      yield* updateRun({ sourceThreadId, run: succeededRun, createdAt: updatedAt });
      yield* startBrowserReview({ sourceThreadId, run: succeededRun, createdAt: updatedAt });
    },
  );

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
      const finalValidation = validationSummary(
        directive.validations,
        "merge gate",
        directive.summaryMarkdown,
        updatedAt,
      );
      const passed =
        directive.status === "passed" &&
        run.activeValidationHeadSha === head.commitSha &&
        status.isRepo &&
        status.refName === run.orchestratorBranch &&
        !status.hasWorkingTreeChanges &&
        integrated &&
        requiredValidationsPassed({
          requiredCommands: run.launchSummary.validationCommands,
          validations: directive.validations,
        });

      yield* appendActivity({
        threadId: run.orchestratorThreadId,
        tone: passed ? "info" : "error",
        kind: "implementation-merge-gate-finished",
        summary: `Merge gate ${passed ? "passed" : "failed"}`,
        payload: { runId: run.id, status: passed ? "passed" : "failed" },
        createdAt: updatedAt,
      });

      if (!passed) {
        yield* startFixer({
          sourceThreadId,
          run: {
            ...run,
            finalValidation,
            finalValidationResults: [...directive.validations],
            activeValidatorThreadId: null,
            activeValidationHeadSha: null,
            updatedAt,
          },
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

      yield* startBrowserReview({
        sourceThreadId,
        run: {
          ...run,
          status: "qa-reviewing",
          finalValidation,
          finalValidationResults: [...directive.validations],
          integrationHeadSha: head.commitSha,
          validatedHeadSha: head.commitSha,
          activeValidationHeadSha: null,
          activeValidatorThreadId: null,
          retryableFailure: null,
          updatedAt,
        },
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
      yield* blockRun({
        sourceThreadId,
        run,
        retryableStage: "fixer",
        reasonMarkdown: directive.notesMarkdown,
        updatedAt,
      });
      return;
    }

    if (
      !requiredValidationsPassed({
        requiredCommands: run.launchSummary.validationCommands,
        validations: directive.validations,
      })
    ) {
      yield* blockRun({
        sourceThreadId,
        run,
        retryableStage: "fixer",
        reasonMarkdown: `Fix result did not include passing results for every required validation command. Required commands: ${run.launchSummary.validationCommands.join(", ")}.`,
        updatedAt,
      });
      return;
    }

    const changedFiles = yield* gitWorkflow.listChangedFiles({
      cwd: run.orchestratorWorktreePath,
      baseRef: run.pinnedCommit,
      headRef: "HEAD",
    });
    if (
      changedFiles.some((path) => path === "apps/mobile" || path.startsWith("apps/mobile/")) &&
      !requiredValidationsPassed({
        requiredCommands: ["vp run lint:mobile"],
        validations: directive.validations,
      })
    ) {
      yield* blockRun({
        sourceThreadId,
        run,
        retryableStage: "fixer",
        reasonMarkdown:
          "Fix result changed native mobile files without a passing `vp run lint:mobile` validation.",
        updatedAt,
      });
      return;
    }

    const latestValidation = validationSummary(
      directive.validations,
      "fix validation",
      directive.notesMarkdown,
      updatedAt,
    );
    const [head, status] = yield* Effect.all([
      gitWorkflow.resolveCommit({ cwd: run.orchestratorWorktreePath, ref: "HEAD" }),
      gitWorkflow.localStatus({ cwd: run.orchestratorWorktreePath }),
    ]);
    if (
      !status.isRepo ||
      status.refName !== run.orchestratorBranch ||
      status.hasWorkingTreeChanges
    ) {
      yield* blockRun({
        sourceThreadId,
        run,
        retryableStage: "fixer",
        reasonMarkdown: "Fixer must finish with a committed, clean orchestrator worktree.",
        updatedAt,
      });
      return;
    }
    if (directive.commitSha !== undefined) {
      const reported = yield* gitWorkflow.resolveCommit({
        cwd: run.orchestratorWorktreePath,
        ref: directive.commitSha,
      });
      if (reported.commitSha !== head.commitSha) {
        yield* blockRun({
          sourceThreadId,
          run,
          retryableStage: "fixer",
          reasonMarkdown: `Fixer reported '${reported.commitSha}', but orchestrator HEAD is '${head.commitSha}'.`,
          updatedAt,
        });
        return;
      }
    }

    const fixedRun: OrchestrationImplementationRun = {
      ...run,
      status: "integrating",
      finalValidation: latestValidation,
      finalValidationResults: [...directive.validations],
      integrationHeadSha: head.commitSha,
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
      createdAt: updatedAt,
    });
  });

  const startFixer = Effect.fn("ImplementationWorkflowReactor.startFixer")(function* (input: {
    readonly sourceThreadId: ThreadId;
    readonly run: OrchestrationImplementationRun;
    readonly status: "fixing" | "code-review-fixing";
    readonly origin: "merge-gate" | "dev-review" | "code-review";
    readonly title: string;
    readonly promptText: string;
    readonly createdAt: string;
  }) {
    const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
    const orchestratorThread = findThread(readModel, input.run.orchestratorThreadId);
    if (orchestratorThread === null) return;
    const fixerThreadId = yield* serverThreadId("implementation-fixer");
    const fixingRun: OrchestrationImplementationRun = {
      ...input.run,
      status: input.status,
      activeFixerThreadId: fixerThreadId,
      fixOrigin: input.origin,
      validatedHeadSha: null,
      devReviewedHeadSha: null,
      codeReviewedHeadSha: null,
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
          WORKFLOW_PROMPT_IDS.implementationFixCodex,
        ),
        attachments: [],
      },
      workflowPromptId: WORKFLOW_PROMPT_IDS.implementationFixCodex,
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

  /**
   * Send Dev Review findings back to whoever owns commits on the orchestrator branch. Fast feature
   * runs build in the orchestrator thread itself, so the findings become a new Build turn there and
   * the resulting implementation-fast-build-result re-enters Dev Review. Spec-driven runs have no
   * single Build thread, so they keep the dedicated fixer plus merge-gate route.
   */
  const restartAfterDevReviewFindings = Effect.fn(
    "ImplementationWorkflowReactor.restartAfterDevReviewFindings",
  )(function* (input: {
    readonly sourceThreadId: ThreadId;
    readonly run: OrchestrationImplementationRun;
    readonly reviewId: DevReviewId;
    readonly createdAt: string;
  }) {
    if (input.run.artifactSource !== "proposed-plan") {
      yield* startFixer({
        sourceThreadId: input.sourceThreadId,
        run: input.run,
        status: "fixing",
        origin: "dev-review",
        title: "Fix browser dev review",
        promptText: buildFixPrompt({ run: input.run, reviewId: input.reviewId }),
        createdAt: input.createdAt,
      });
      return;
    }

    const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
    const buildThread = findThread(readModel, input.run.orchestratorThreadId);
    const sourceThread = findThread(readModel, input.sourceThreadId);
    if (buildThread === null || sourceThread === null) return;
    if (buildThread.latestTurn?.state === "running") return;

    const rebuildingRun: OrchestrationImplementationRun = {
      ...input.run,
      status: "running",
      activeDevReviewHeadSha: null,
      activeDevReviewThreadId: null,
      validatedHeadSha: null,
      devReviewedHeadSha: null,
      codeReviewedHeadSha: null,
      retryableFailure: null,
      updatedAt: input.createdAt,
    };
    yield* updateRun({
      sourceThreadId: input.sourceThreadId,
      run: rebuildingRun,
      createdAt: input.createdAt,
    });

    yield* orchestrationEngine.dispatch({
      type: "thread.turn.start",
      commandId: yield* serverCommandId("fast-feature-dev-review-fix-turn"),
      threadId: rebuildingRun.orchestratorThreadId,
      message: {
        messageId: yield* serverMessageId("fast-feature-dev-review-fix"),
        role: "user",
        text: buildFastFeatureDevReviewFixPrompt({
          run: rebuildingRun,
          sourceThread,
          reviewId: input.reviewId,
          attempt: rebuildingRun.qaAttemptCount,
        }),
        attachments: [],
      },
      titleSeed: buildThread.title,
      runtimeMode: buildThread.runtimeMode,
      interactionMode: "default",
      ...(rebuildingRun.sourceProposedPlan === null
        ? {}
        : { sourceProposedPlan: rebuildingRun.sourceProposedPlan }),
      createdAt: input.createdAt,
    });

    yield* appendActivity({
      threadId: rebuildingRun.orchestratorThreadId,
      tone: "info",
      kind: "implementation-build-dev-review-fix-started",
      summary: `Build resumed to fix dev review findings (attempt ${rebuildingRun.qaAttemptCount})`,
      payload: {
        runId: rebuildingRun.id,
        reviewId: input.reviewId,
        attempt: rebuildingRun.qaAttemptCount,
      },
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
        yield* blockRun({
          sourceThreadId,
          run,
          retryableStage: "code-review",
          reasonMarkdown: directive.reportMarkdown,
          updatedAt,
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
        yield* fileChangeRequest({
          sourceThreadId,
          run: {
            ...run,
            codeReviewedHeadSha: head.commitSha,
            activeCodeReviewHeadSha: null,
            activeCodeReviewThreadId: null,
            latestCodeReviewReportMarkdown: directive.reportMarkdown,
            updatedAt,
          },
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
        !requiredValidationsPassed({
          requiredCommands: run.launchSummary.validationCommands,
          validations: directive.validations,
        })
      ) {
        yield* blockRun({
          sourceThreadId,
          run,
          retryableStage: "code-review",
          reasonMarkdown: `Code Review changed code without passing results for every required validation command: ${run.launchSummary.validationCommands.join(", ")}.`,
          updatedAt,
        });
        return;
      }

      const changedFiles = yield* gitWorkflow.listChangedFiles({
        cwd: run.orchestratorWorktreePath,
        baseRef: run.pinnedCommit,
        headRef: head.commitSha,
      });
      if (
        changedFiles.some((path) => path === "apps/mobile" || path.startsWith("apps/mobile/")) &&
        !requiredValidationsPassed({
          requiredCommands: ["vp run lint:mobile"],
          validations: directive.validations,
        })
      ) {
        yield* blockRun({
          sourceThreadId,
          run,
          retryableStage: "code-review",
          reasonMarkdown:
            "Code Review changed native mobile files without a passing `vp run lint:mobile` validation.",
          updatedAt,
        });
        return;
      }

      yield* fileChangeRequest({
        sourceThreadId,
        run: {
          ...run,
          codeReviewedHeadSha: head.commitSha,
          activeCodeReviewHeadSha: null,
          activeCodeReviewThreadId: null,
          latestCodeReviewReportMarkdown: directive.reportMarkdown,
          finalValidationResults: [...directive.validations],
          updatedAt,
        },
        createdAt: updatedAt,
      });
    },
  );

  const handleDevReviewUpdated = Effect.fn("ImplementationWorkflowReactor.handleDevReviewUpdated")(
    function* (event: Extract<ImplementationWorkflowEvent, { type: "thread.dev-review-updated" }>) {
      if (event.payload.status === undefined) return;
      const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
      const run = findRunByDevReview(
        readModel,
        event.payload.reviewId,
        event.payload.sourceThreadId,
      );
      if (
        run === null ||
        run.status !== "qa-reviewing" ||
        run.devReviewIds.at(-1) !== event.payload.reviewId
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
        run.activeDevReviewHeadSha !== head.commitSha ||
        !status.isRepo ||
        status.refName !== run.orchestratorBranch ||
        status.hasWorkingTreeChanges
      ) {
        yield* blockRun({
          sourceThreadId,
          run,
          retryableStage: "dev-review",
          reasonMarkdown: `Dev Review result is stale or the orchestrator worktree is not clean at reviewed HEAD '${run.activeDevReviewHeadSha ?? "unknown"}'.`,
          updatedAt: event.payload.updatedAt,
        });
        return;
      }

      if (
        event.payload.status === "passed" ||
        event.payload.status === "failed" ||
        event.payload.status === "blocked"
      ) {
        yield* appendActivity({
          threadId: run.orchestratorThreadId,
          tone: event.payload.status === "passed" ? "info" : "error",
          kind: "implementation-browser-review-finished",
          summary: `Browser dev review ${event.payload.status}`,
          payload: {
            runId: run.id,
            reviewId: event.payload.reviewId,
            status: event.payload.status,
          },
          createdAt: event.payload.updatedAt,
        });
      }

      if (event.payload.status === "passed") {
        yield* startCodeReview({
          sourceThreadId,
          run: {
            ...run,
            devReviewedHeadSha: head.commitSha,
            activeDevReviewHeadSha: null,
            activeDevReviewThreadId: null,
            retryableFailure: null,
            updatedAt: event.payload.updatedAt,
          },
          createdAt: event.payload.updatedAt,
        });
        return;
      }

      if (event.payload.status !== "failed" && event.payload.status !== "blocked") return;

      // Exhausting every Dev Review attempt no longer stops the run: the unpassed review is recorded
      // and carried into Code Review, change-request publication, and the change-request body.
      if (run.qaAttemptCount >= IMPLEMENTATION_RUN_MAX_QA_ATTEMPTS) {
        const exhaustedRun: OrchestrationImplementationRun = {
          ...run,
          devReviewExhaustedAt: run.devReviewExhaustedAt ?? event.payload.updatedAt,
          devReviewedHeadSha: null,
          activeDevReviewHeadSha: null,
          activeDevReviewThreadId: null,
          retryableFailure: null,
          updatedAt: event.payload.updatedAt,
        };
        yield* appendActivity({
          threadId: run.orchestratorThreadId,
          tone: "error",
          kind: "implementation-browser-review-exhausted",
          summary: `Browser dev review did not pass after ${run.qaAttemptCount} attempts; continuing to code review`,
          payload: {
            runId: run.id,
            reviewId: event.payload.reviewId,
            attempts: run.qaAttemptCount,
            lastStatus: event.payload.status,
          },
          createdAt: event.payload.updatedAt,
        });
        yield* startCodeReview({
          sourceThreadId,
          run: exhaustedRun,
          createdAt: event.payload.updatedAt,
        });
        return;
      }

      if (event.payload.status === "blocked") {
        yield* startBrowserReview({
          sourceThreadId,
          run: {
            ...run,
            activeDevReviewHeadSha: null,
            activeDevReviewThreadId: null,
            updatedAt: event.payload.updatedAt,
          },
          createdAt: event.payload.updatedAt,
        });
        return;
      }

      yield* restartAfterDevReviewFindings({
        sourceThreadId,
        run: {
          ...run,
          activeDevReviewHeadSha: null,
          activeDevReviewThreadId: null,
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
          createdAt: input.createdAt,
        });
        return;
      }
      if (failure.stage === "dev-review") {
        const reviewId = input.run.devReviewIds.at(-1);
        const latestReview =
          reviewId === undefined
            ? undefined
            : findThread(readModel, input.run.orchestratorThreadId)?.devReviews.find(
                (review) => review.id === reviewId,
              );
        if (latestReview?.status === "failed") {
          yield* restartAfterDevReviewFindings({
            sourceThreadId: input.sourceThreadId,
            run: {
              ...input.run,
              activeDevReviewThreadId: null,
              activeDevReviewHeadSha: null,
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
            activeDevReviewThreadId: null,
            activeDevReviewHeadSha: null,
          },
          createdAt: input.createdAt,
        });
        return;
      }
      if (failure.stage === "app-dev-stack") {
        yield* startBrowserReview({
          sourceThreadId: input.sourceThreadId,
          run: {
            ...input.run,
            activeDevReviewThreadId: null,
            activeDevReviewHeadSha: null,
          },
          createdAt: input.createdAt,
        });
        return;
      }
      if (failure.stage === "code-review") {
        yield* startCodeReview({
          sourceThreadId: input.sourceThreadId,
          run: {
            ...input.run,
            activeCodeReviewThreadId: null,
            activeCodeReviewHeadSha: null,
          },
          createdAt: input.createdAt,
        });
        return;
      }
      if (failure.stage === "fixer") {
        const origin =
          input.run.fixOrigin ??
          (input.run.status === "code-review-fixing" ? "code-review" : "dev-review");
        const reviewId = input.run.devReviewIds.at(-1);
        if (origin === "dev-review" && reviewId === undefined) {
          yield* blockRun({
            sourceThreadId: input.sourceThreadId,
            run: input.run,
            reasonMarkdown:
              "Cannot retry the Browser Dev Review fixer without a Dev Review record.",
            updatedAt: input.createdAt,
          });
          return;
        }
        yield* startFixer({
          sourceThreadId: input.sourceThreadId,
          run: { ...input.run, activeFixerThreadId: null },
          status: origin === "code-review" ? "code-review-fixing" : "fixing",
          origin,
          title:
            origin === "merge-gate"
              ? "Fix merge gate failures"
              : origin === "dev-review"
                ? "Fix browser dev review"
                : "Fix code review findings",
          promptText:
            origin === "merge-gate"
              ? buildMergeGateFixPrompt({
                  run: input.run,
                  reportMarkdown: failure.detail,
                })
              : origin === "dev-review"
                ? buildFixPrompt({
                    run: input.run,
                    reviewId: DevReviewId.make(reviewId as string),
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

  const handleRunCancel = Effect.fn("ImplementationWorkflowReactor.handleRunCancel")(function* (
    event: Extract<
      ImplementationWorkflowEvent,
      { type: "thread.implementation-run-cancel-requested" }
    >,
  ) {
    const run = event.payload.run;
    const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
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
      default:
        return;
    }
  });

  const processEvent = Effect.fn("ImplementationWorkflowReactor.processEvent")(function* (
    event: ImplementationWorkflowEvent,
  ) {
    switch (event.type) {
      case "thread.implementation-run-launched":
        yield* handleRunLaunched(event);
        return;
      case "thread.activity-appended":
        yield* processActivity(event);
        return;
      case "thread.dev-review-updated":
        yield* handleDevReviewUpdated(event);
        return;
      case "thread.implementation-change-request-retry-requested":
        yield* handleChangeRequestRetry(event);
        return;
      case "thread.implementation-run-retry-requested":
        yield* handleRunRetry(event);
        return;
      case "thread.implementation-run-cancel-requested":
        yield* handleRunCancel(event);
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

  const recoverIncompleteBrowserReviews = Effect.fn(
    "ImplementationWorkflowReactor.recoverIncompleteBrowserReviews",
  )(function* () {
    const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    for (const run of readModel.implementationRuns) {
      if (run.status === "canceled") continue;
      const recoverStackFailure =
        run.artifactSource === "planning-spec" &&
        run.status === "needs-human-attention" &&
        run.appDevStack.status === "failed" &&
        run.finalValidation?.status === "passed" &&
        run.devReviewIds.length === 0;
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
        run.devReviewIds.length > 0 &&
        run.qaAttemptCount < IMPLEMENTATION_RUN_MAX_QA_ATTEMPTS &&
        (latestReviewThread?.session?.status === "error" ||
          latestReviewThread?.session?.status === "stopped");
      if (!recoverStackFailure && !recoverInterruptedReview) continue;
      const sourceThreadId = findRunSourceThreadId({ readModel, run });
      if (sourceThreadId === null) continue;
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
        run.artifactSource !== "planning-spec" ||
        (run.status !== "running" && run.status !== "integrating" && run.status !== "validating") ||
        !run.ticketStates.every((state) => state.status === "succeeded")
      ) {
        continue;
      }
      const hasValidator = readModel.threads.some(
        (thread) =>
          thread.parentThreadId === run.orchestratorThreadId &&
          thread.workflowRole === "implementation-validator" &&
          thread.deletedAt === null,
      );
      if (hasValidator) continue;
      const sourceThreadId = findRunSourceThreadId({ readModel, run });
      if (sourceThreadId === null) continue;
      yield* integrateCompletedRun({ sourceThreadId, run, createdAt }).pipe(
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
    for (const run of readModel.implementationRuns) {
      if (run.status === "canceled") continue;
      const sourceThreadId = findRunSourceThreadId({ readModel, run });
      if (sourceThreadId === null) continue;
      const childThreads = readModel.threads.filter(
        (thread) => thread.parentThreadId === run.orchestratorThreadId && thread.deletedAt === null,
      );
      const hasActiveChild = (input: {
        readonly threadId: ThreadId | null;
        readonly role:
          | "implementation-validator"
          | "implementation-qa-reviewer"
          | "implementation-code-reviewer"
          | "implementation-fixer";
      }) => {
        const matches = childThreads.filter(
          (thread) =>
            thread.workflowRole === input.role &&
            (input.threadId === null || thread.id === input.threadId),
        );
        return matches.some(
          (thread) => thread.session?.status === "starting" || thread.session?.status === "running",
        );
      };

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
        const reviewId = run.devReviewIds.at(-1);
        if (run.fixOrigin === "dev-review" && reviewId === undefined) continue;
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
                : run.fixOrigin === "dev-review"
                  ? "Fix browser dev review"
                  : "Fix code review findings",
            promptText:
              run.fixOrigin === "merge-gate"
                ? buildMergeGateFixPrompt({
                    run,
                    reportMarkdown: "The previous merge-gate fixer was interrupted.",
                  })
                : run.fixOrigin === "dev-review"
                  ? buildFixPrompt({ run, reviewId: DevReviewId.make(reviewId as string) })
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
              return (
                !resultAlreadyReported &&
                thread?.session?.status !== "starting" &&
                thread?.session?.status !== "running"
              );
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
            createdAt,
          }),
        );
        continue;
      }
      if (
        run.status === "qa-reviewing" &&
        !hasActiveChild({
          threadId: run.activeDevReviewThreadId,
          role: "implementation-qa-reviewer",
        })
      ) {
        yield* startBrowserReview({
          sourceThreadId,
          run: { ...run, activeDevReviewThreadId: null, activeDevReviewHeadSha: null },
          createdAt,
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("implementation workflow run stage recovery failed", {
              runId: run.id,
              stage: "dev-review",
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
            run: { ...run, activeCodeReviewThreadId: null, activeCodeReviewHeadSha: null },
            createdAt,
          }),
        );
        continue;
      }
      if (
        (run.status === "fixing" || run.status === "code-review-fixing") &&
        !hasActiveChild({ threadId: run.activeFixerThreadId, role: "implementation-fixer" })
      ) {
        const origin = run.fixOrigin ?? (run.status === "fixing" ? "dev-review" : "code-review");
        const reviewId = run.devReviewIds.at(-1);
        yield* recoverRunStage(
          run.id,
          "fixer",
          startFixer({
            sourceThreadId,
            run: { ...run, activeFixerThreadId: null },
            status: run.status,
            origin,
            title:
              origin === "merge-gate"
                ? "Fix merge gate failures"
                : origin === "dev-review"
                  ? "Fix browser dev review"
                  : "Fix code review findings",
            promptText:
              origin === "merge-gate"
                ? buildMergeGateFixPrompt({
                    run,
                    reportMarkdown: "The previous merge-gate fixer was interrupted.",
                  })
                : origin === "dev-review" && reviewId !== undefined
                  ? buildFixPrompt({ run, reviewId: DevReviewId.make(reviewId) })
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
          run.retryableFailure === null ||
          // Only a human can clear this one. Retrying burns the attempt budget in
          // three sweeps (90s) against a condition that cannot change on its own,
          // leaving nothing for the explicit Retry once the user has fixed it.
          run.retryableFailure.humanBlocked ||
          run.retryableFailure.attemptCount >= run.retryableFailure.maxAttempts
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

  const start: ImplementationWorkflowReactorShape["start"] = Effect.fn("start")(function* () {
    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (
          event.type !== "thread.implementation-run-launched" &&
          event.type !== "thread.activity-appended" &&
          event.type !== "thread.dev-review-updated" &&
          event.type !== "thread.implementation-change-request-retry-requested" &&
          event.type !== "thread.implementation-run-retry-requested" &&
          event.type !== "thread.implementation-run-cancel-requested"
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
      }).pipe(Effect.repeat(Schedule.spaced(Duration.seconds(30)))),
    );
  });

  return {
    start,
    drain: worker.drain,
    recoverRetryableRuns: () => recoverRetryableRuns().pipe(Effect.orDie),
  } satisfies ImplementationWorkflowReactorShape;
});

export const ImplementationWorkflowReactorLive = Layer.effect(ImplementationWorkflowReactor, make);
