import {
  CommandId,
  DevReviewId,
  EventId,
  MessageId,
  ThreadId,
  type DevReviewDocument,
  type OrchestrationEvent,
  type OrchestrationImplementationRun,
  type OrchestrationImplementationValidationResult,
  type OrchestrationImplementationWorkerResult,
  type OrchestrationPlanningTicket,
  type OrchestrationReadModel,
  type OrchestrationThread,
  type WorkspaceUserId,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { AppDevStackManager } from "../../appDevStack/AppDevStackManager.ts";
import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
import { WORKFLOW_PROMPT_IDS } from "../../provider/WorkflowPromptRegistry.ts";
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

const MAX_BROWSER_REVIEW_ATTEMPTS = 5;
const MAX_CODE_REVIEW_CYCLES = 5;

type ImplementationWorkflowEvent = Extract<
  OrchestrationEvent,
  {
    type:
      | "thread.implementation-run-launched"
      | "thread.activity-appended"
      | "thread.dev-review-updated"
      | "thread.implementation-change-request-retry-requested";
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
  readonly reportMarkdown: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

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
    ? (value as CodeReviewDirective)
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

function ticketMarkdown(ticket: OrchestrationPlanningTicket | undefined): string {
  if (ticket === undefined) {
    return "Ticket details were not available in the current projection.";
  }
  return [`#${ticket.ordinal} ${ticket.title}`, "", ticket.bodyMarkdown].join("\n");
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

function devReviewMarkdown(document: DevReviewDocument | undefined): string {
  if (document === undefined) {
    return "No dev-review document was attached to this update.";
  }
  const checks = document.checks
    .map((check) => `- ${check.label}: ${check.status}\n  ${check.notes}`)
    .join("\n");
  const findings = document.findings
    .map(
      (finding) =>
        `- ${finding.severity}: ${finding.title}\n  ${finding.details}\n  Repro: ${finding.reproduction}`,
    )
    .join("\n");
  return [
    `Verdict: ${document.verdict}`,
    "",
    document.summary,
    "",
    "Checks:",
    checks.length > 0 ? checks : "- None reported",
    "",
    "Findings:",
    findings.length > 0 ? findings : "- None reported",
    "",
    "Next steps:",
    document.nextSteps.length > 0
      ? document.nextSteps.map((step) => `- ${step}`).join("\n")
      : "- None",
  ].join("\n");
}

function buildWorkerPrompt(input: {
  readonly run: OrchestrationImplementationRun;
  readonly ticket: OrchestrationPlanningTicket | undefined;
  readonly ticketId: string;
  readonly workerThreadId: ThreadId;
  readonly branch: string;
  readonly worktreePath: string;
}): string {
  return [
    `Implement planning ticket ${input.ticketId} for implementation run ${input.run.id}.`,
    "",
    "Do not ask the user questions. Work TDD-style: write or update a focused failing test, implement the smallest behavior, run targeted validation, then report the result.",
    "",
    "Branch/worktree:",
    `- branch: ${input.branch}`,
    `- worktree: ${input.worktreePath}`,
    "",
    "Planning ticket:",
    ticketMarkdown(input.ticket),
    "",
    "Finish with exactly one fenced JSON directive of type implementation-worker-result. Use these fixed identifiers:",
    `- ticketId: ${input.ticketId}`,
    `- workerThreadId: ${input.workerThreadId}`,
    `- branch: ${input.branch}`,
    `- worktreePath: ${input.worktreePath}`,
  ].join("\n");
}

function buildMergeGatePrompt(input: { readonly run: OrchestrationImplementationRun }): string {
  const workerBranches = input.run.ticketStates
    .filter((state) => state.status === "succeeded" && state.branch !== null)
    .map((state) => `- ${state.ticketId}: ${state.branch}`)
    .join("\n");
  return [
    `Run merge gate for implementation run ${input.run.id}.`,
    "",
    "Merge all succeeded worker branches into the current orchestrator worktree. Resolve conflicts in favor of the Spec/planning tickets, then run the required validations.",
    "",
    "Worker branches:",
    workerBranches.length > 0 ? workerBranches : "- None",
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
}): string {
  return [
    `Perform browser dev review for implementation run ${input.run.id}.`,
    "",
    "Open the app with preview_open, record the session with dev_review_recording_start/stop, exercise the product with the preview_* tools, and capture captioned screenshots with dev_review_capture_screenshot. Do not ask the user questions.",
    "",
    input.frontendUrl === null
      ? "No frontend URL was resolved. If the app cannot be opened, mark the review blocked with concrete details."
      : `Feature URL: ${input.frontendUrl}`,
    "",
    "Review against the Spec and planning tickets loaded on this implementation thread. Update the dev-review record with passed, failed, or blocked status and a document.",
  ].join("\n");
}

function buildFixPrompt(input: {
  readonly run: OrchestrationImplementationRun;
  readonly reviewMarkdown: string;
}): string {
  return [
    `Fix browser dev-review failures for implementation run ${input.run.id}.`,
    "",
    "Do not ask the user questions. Make the smallest implementation changes needed in the orchestrator worktree, run focused validation, and report the fix result.",
    "",
    "Latest browser review:",
    input.reviewMarkdown,
    "",
    "Finish with exactly one fenced JSON directive of type implementation-fix-result for this runId.",
  ].join("\n");
}

function buildCodeReviewPrompt(input: {
  readonly run: OrchestrationImplementationRun;
  readonly specMarkdown: string | null;
}): string {
  const changeRequest = input.run.changeRequest;
  return [
    `Perform the implementation code review for implementation run ${input.run.id} (cycle ${input.run.codeReviewAttemptCount} of ${MAX_CODE_REVIEW_CYCLES}).`,
    "",
    "Do not ask the user questions. Review the change along the Standards and Spec axes as described in your workflow instructions.",
    "",
    "Review scope:",
    `- worktree: ${input.run.orchestratorWorktreePath}`,
    `- fixed point: ${input.run.baseBranch}`,
    `- diff command: git diff ${input.run.baseBranch}...HEAD`,
    changeRequest === null
      ? "- change request: not available"
      : `- change request: ${changeRequest.url} (#${changeRequest.number})`,
    "",
    "Spec source (review the Spec axis against this document; do not search the issue tracker):",
    input.specMarkdown ??
      "No Spec document was available in the projection; review the Spec axis against the planning tickets loaded on the orchestrator thread.",
    "",
    'Use status "clean" only when neither axis has findings that require code changes, "findings" when code changes are required, and "blocked" when the review cannot be performed. Put the full two-axis report in reportMarkdown.',
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
    "Finish with exactly one fenced JSON directive of type implementation-fix-result for this runId.",
  ].join("\n");
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
  }) {
    const blockedRun: OrchestrationImplementationRun = {
      ...input.run,
      status: "needs-human-attention",
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
  });

  const sourceThreadIdForRun = Effect.fn("ImplementationWorkflowReactor.sourceThreadIdForRun")(
    function* (run: OrchestrationImplementationRun) {
      const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
      return findRunSourceThreadId({ readModel, run });
    },
  );

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

    yield* gitWorkflow.createWorktree({
      cwd: input.run.orchestratorWorktreePath,
      refName: input.run.orchestratorBranch,
      newRefName: plannedWorker.branch,
      baseRefName: input.run.baseBranch,
      path: plannedWorker.worktreePath,
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
      title: `Implement ${ticket?.title ?? input.ticketId}`,
      modelSelection: input.orchestratorThread.modelSelection,
      runtimeMode: input.orchestratorThread.runtimeMode,
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
        text: buildWorkerPrompt({
          run: input.run,
          ticket,
          ticketId: input.ticketId,
          workerThreadId,
          branch: plannedWorker.branch,
          worktreePath: plannedWorker.worktreePath,
        }),
        attachments: [],
      },
      workflowPromptId: WORKFLOW_PROMPT_IDS.implementationTddCodex,
      runtimeMode: input.orchestratorThread.runtimeMode,
      interactionMode: "implementation-workflow",
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

      const readyTicketIds = input.run.ticketStates
        .filter((ticketState) => ticketState.status === "ready")
        .map((ticketState) => ticketState.ticketId);
      const startedRuns = yield* Effect.forEach(
        readyTicketIds,
        (ticketId) =>
          createWorker({
            sourceThreadId: input.sourceThreadId,
            orchestratorThread,
            run: input.run,
            ticketId,
            ownerUserId: orchestratorThread.ownerUserId,
            createdAt: input.createdAt,
          }),
        { concurrency: "unbounded" },
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
              updatedAt: input.createdAt,
            } satisfies OrchestrationImplementationRun);
      if (nextRun !== input.run) {
        yield* updateRun({
          sourceThreadId: input.sourceThreadId,
          run: nextRun,
          createdAt: input.createdAt,
        });
      }
      return nextRun;
    },
  );

  const startMergeGate = Effect.fn("ImplementationWorkflowReactor.startMergeGate")(
    function* (input: {
      readonly sourceThreadId: ThreadId;
      readonly run: OrchestrationImplementationRun;
      readonly createdAt: string;
    }) {
      const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
      const orchestratorThread = findThread(readModel, input.run.orchestratorThreadId);
      if (orchestratorThread === null) return;

      const existingValidator = readModel.threads.find(
        (thread) =>
          thread.parentThreadId === input.run.orchestratorThreadId &&
          thread.workflowRole === "implementation-validator" &&
          thread.deletedAt === null,
      );
      if (existingValidator?.latestTurn?.state === "running") return;

      const validatorThreadId = yield* serverThreadId("implementation-validator");
      const validatingRun: OrchestrationImplementationRun = {
        ...input.run,
        status: "validating",
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
        runtimeMode: orchestratorThread.runtimeMode,
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
          text: buildMergeGatePrompt({ run: input.run }),
          attachments: [],
        },
        workflowPromptId: WORKFLOW_PROMPT_IDS.implementationMergeGateCodex,
        runtimeMode: orchestratorThread.runtimeMode,
        interactionMode: "implementation-workflow",
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
      yield* updateRun({
        sourceThreadId: input.sourceThreadId,
        run: ensuringRun,
        createdAt: input.createdAt,
      });

      const stackResult = yield* appDevStackManager
        .autoCreate({
          worktreePath: input.run.orchestratorWorktreePath,
          displayName: `Implementation ${input.run.id}`,
          gitBranch: input.run.orchestratorBranch,
        })
        .pipe(Effect.result);

      if (stackResult._tag === "Failure") {
        const failedRun: OrchestrationImplementationRun = {
          ...ensuringRun,
          status: "needs-human-attention",
          appDevStack: {
            ...ensuringRun.appDevStack,
            status: "failed",
            lastErrorMarkdown: errorDetail(stackResult.failure),
            updatedAt: input.createdAt,
          },
          updatedAt: input.createdAt,
        };
        yield* updateRun({
          sourceThreadId: input.sourceThreadId,
          run: failedRun,
          createdAt: input.createdAt,
        });
        return;
      }

      const reviewId = yield* serverDevReviewId();
      const reviewThreadId = yield* serverThreadId("implementation-qa-reviewer");
      const stack = stackResult.success;
      const reviewRun: OrchestrationImplementationRun = {
        ...ensuringRun,
        appDevStack: {
          status: "ready",
          stackId: stack.stack.id,
          stackStatus: stack.stack.status,
          frontendUrl: stack.frontendUrl,
          frontendServiceName: stack.frontendServiceName,
          displayName: stack.stack.displayName,
          lastErrorMarkdown: null,
          requestedAt: ensuringRun.appDevStack.requestedAt || input.createdAt,
          updatedAt: input.createdAt,
        },
        devReviewIds: [...ensuringRun.devReviewIds, reviewId],
        qaAttemptCount: ensuringRun.qaAttemptCount + 1,
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
        message: {
          messageId: yield* serverMessageId("implementation-browser-review"),
          role: "user",
          text: buildBrowserDevReviewPrompt({ run: input.run, frontendUrl: stack.frontendUrl }),
          attachments: [],
        },
        modelSelection: resolved.modelSelection,
        runtimeMode: orchestratorThread.runtimeMode,
        workflowPromptId: WORKFLOW_PROMPT_IDS.implementationBrowserDevReviewCodex,
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

      const sourceThread = findThread(readModel, input.sourceThreadId);
      const spec =
        orchestratorThread.planningWorkflow?.spec ?? sourceThread?.planningWorkflow?.spec ?? null;
      const specMarkdown =
        spec === null ? null : [`# ${spec.title}`, "", spec.summaryMarkdown].join("\n");

      const reviewerThreadId = yield* serverThreadId("implementation-code-reviewer");
      const reviewingRun: OrchestrationImplementationRun = {
        ...input.run,
        status: "code-reviewing",
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
        runtimeMode: orchestratorThread.runtimeMode,
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
          text: buildCodeReviewPrompt({ run: reviewingRun, specMarkdown }),
          attachments: [],
        },
        workflowPromptId: WORKFLOW_PROMPT_IDS.implementationCodeReviewCodex,
        runtimeMode: orchestratorThread.runtimeMode,
        interactionMode: "implementation-workflow",
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
      const result = yield* gitWorkflow
        .createOrOpenChangeRequest({
          cwd: input.run.orchestratorWorktreePath,
          actionId: input.run.id,
          threadId: input.run.orchestratorThreadId,
          commitMessage: `Implement ${input.run.specId}`,
        })
        .pipe(Effect.result);

      if (result._tag === "Failure") {
        yield* updateRun({
          sourceThreadId: input.sourceThreadId,
          run: {
            ...input.run,
            status: "needs-human-attention",
            changeRequestFailure: changeRequestFailure({
              detail: errorDetail(result.failure),
              failedAt: input.createdAt,
            }),
            updatedAt: input.createdAt,
          },
          createdAt: input.createdAt,
        });
        return;
      }

      yield* startCodeReview({
        sourceThreadId: input.sourceThreadId,
        run: {
          ...input.run,
          changeRequest: result.success,
          changeRequestFailure: null,
          updatedAt: input.createdAt,
        },
        createdAt: input.createdAt,
      });
    },
  );

  const handleRunLaunched = Effect.fn("ImplementationWorkflowReactor.handleRunLaunched")(function* (
    event: Extract<ImplementationWorkflowEvent, { type: "thread.implementation-run-launched" }>,
  ) {
    const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
    const sourceThread = findThread(readModel, event.payload.sourceThreadId);
    const orchestratorThread = findThread(readModel, event.payload.run.orchestratorThreadId);
    if (sourceThread === null || orchestratorThread === null) return;

    const project = yield* projectionSnapshotQuery
      .getProjectShellById(sourceThread.projectId)
      .pipe(Effect.map(Option.getOrUndefined));
    if (project === undefined) return;

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

    const runningRun: OrchestrationImplementationRun = {
      ...event.payload.run,
      status: "running",
      updatedAt: event.occurredAt,
    };
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

      if (directive.status === "failed") {
        const failedRun: OrchestrationImplementationRun = {
          ...run,
          status: "needs-human-attention",
          ticketStates: run.ticketStates.map((state) =>
            state.workerThreadId === event.payload.threadId || state.ticketId === directive.ticketId
              ? {
                  ...state,
                  status: "failed" as const,
                  workerResult: directive,
                  updatedAt: directive.reportedAt,
                }
              : state,
          ),
          workerResults: [...run.workerResults, directive],
          updatedAt: directive.reportedAt,
        };
        yield* updateRun({ sourceThreadId, run: failedRun, createdAt: directive.reportedAt });
        return;
      }

      const succeededRun = markDependentsReady(
        {
          ...run,
          ticketStates: run.ticketStates.map((state) =>
            state.workerThreadId === event.payload.threadId || state.ticketId === directive.ticketId
              ? {
                  ...state,
                  status: "succeeded" as const,
                  branch: directive.branch,
                  worktreePath: directive.worktreePath,
                  workerResult: directive,
                  updatedAt: directive.reportedAt,
                }
              : state,
          ),
          workerResults: [...run.workerResults, directive],
          updatedAt: directive.reportedAt,
        },
        directive.reportedAt,
      );

      yield* updateRun({ sourceThreadId, run: succeededRun, createdAt: directive.reportedAt });
      if (succeededRun.ticketStates.every((state) => state.status === "succeeded")) {
        yield* startMergeGate({
          sourceThreadId,
          run: succeededRun,
          createdAt: directive.reportedAt,
        });
        return;
      }

      yield* startReadyWorkers({
        sourceThreadId,
        run: succeededRun,
        createdAt: directive.reportedAt,
      });
    },
  );

  const handleMergeGateResult = Effect.fn("ImplementationWorkflowReactor.handleMergeGateResult")(
    function* (
      event: Extract<ImplementationWorkflowEvent, { type: "thread.activity-appended" }>,
      directive: MergeGateDirective,
    ) {
      const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
      const run = findRunById(readModel, directive.runId);
      if (run === null) return;
      const sourceThreadId = findRunSourceThreadId({ readModel, run });
      if (sourceThreadId === null) return;
      const updatedAt = event.payload.activity.createdAt;
      const finalValidation = validationSummary(
        directive.validations,
        "merge gate",
        directive.summaryMarkdown,
        updatedAt,
      );

      if (directive.status === "failed") {
        yield* updateRun({
          sourceThreadId,
          run: {
            ...run,
            status: "needs-human-attention",
            finalValidation,
            updatedAt,
          },
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
    if (run === null) return;
    const sourceThreadId = findRunSourceThreadId({ readModel, run });
    if (sourceThreadId === null) return;
    const updatedAt = event.payload.activity.createdAt;

    if (directive.status !== "succeeded") {
      yield* blockRun({
        sourceThreadId,
        run,
        reasonMarkdown: directive.notesMarkdown,
        updatedAt,
      });
      return;
    }

    if (run.status === "code-review-fixing") {
      yield* fileChangeRequest({
        sourceThreadId,
        run: { ...run, updatedAt },
        createdAt: updatedAt,
      });
      return;
    }

    const fixedRun: OrchestrationImplementationRun = {
      ...run,
      status: "validating",
      updatedAt,
    };
    yield* updateRun({ sourceThreadId, run: fixedRun, createdAt: updatedAt });
    yield* startMergeGate({ sourceThreadId, run: fixedRun, createdAt: updatedAt });
  });

  const startFixer = Effect.fn("ImplementationWorkflowReactor.startFixer")(function* (input: {
    readonly sourceThreadId: ThreadId;
    readonly run: OrchestrationImplementationRun;
    readonly status: "fixing" | "code-review-fixing";
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
      runtimeMode: orchestratorThread.runtimeMode,
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
        text: input.promptText,
        attachments: [],
      },
      workflowPromptId: WORKFLOW_PROMPT_IDS.implementationFixCodex,
      runtimeMode: orchestratorThread.runtimeMode,
      interactionMode: "implementation-workflow",
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
      if (run === null) return;
      const sourceThreadId = findRunSourceThreadId({ readModel, run });
      if (sourceThreadId === null) return;
      const updatedAt = event.payload.activity.createdAt;

      if (directive.status === "clean") {
        yield* updateRun({
          sourceThreadId,
          run: {
            ...run,
            status: "completed",
            updatedAt,
          },
          createdAt: updatedAt,
        });
        return;
      }

      if (directive.status === "blocked") {
        yield* blockRun({
          sourceThreadId,
          run,
          reasonMarkdown: directive.reportMarkdown,
          updatedAt,
        });
        return;
      }

      if (run.codeReviewAttemptCount >= MAX_CODE_REVIEW_CYCLES) {
        yield* blockRun({
          sourceThreadId,
          run,
          reasonMarkdown: `Implementation code review reached ${run.codeReviewAttemptCount} cycles without a clean result. Latest report:\n\n${directive.reportMarkdown}`,
          updatedAt,
        });
        return;
      }

      yield* startFixer({
        sourceThreadId,
        run,
        status: "code-review-fixing",
        title: "Fix code review findings",
        promptText: buildCodeReviewFixPrompt({ run, reportMarkdown: directive.reportMarkdown }),
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
      if (run === null) return;
      const sourceThreadId = findRunSourceThreadId({ readModel, run });
      if (sourceThreadId === null) return;

      if (event.payload.status === "passed") {
        yield* fileChangeRequest({
          sourceThreadId,
          run,
          createdAt: event.payload.updatedAt,
        });
        return;
      }

      if (event.payload.status !== "failed" && event.payload.status !== "blocked") return;

      if (run.qaAttemptCount >= MAX_BROWSER_REVIEW_ATTEMPTS) {
        yield* blockRun({
          sourceThreadId,
          run,
          reasonMarkdown: `Browser dev review reached ${run.qaAttemptCount} attempts without passing.`,
          updatedAt: event.payload.updatedAt,
        });
        return;
      }

      yield* startFixer({
        sourceThreadId,
        run,
        status: "fixing",
        title: "Fix browser dev review",
        promptText: buildFixPrompt({
          run,
          reviewMarkdown: devReviewMarkdown(event.payload.document),
        }),
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

  const start: ImplementationWorkflowReactorShape["start"] = Effect.fn("start")(function* () {
    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (
          event.type !== "thread.implementation-run-launched" &&
          event.type !== "thread.activity-appended" &&
          event.type !== "thread.dev-review-updated" &&
          event.type !== "thread.implementation-change-request-retry-requested"
        ) {
          return Effect.void;
        }
        return worker.enqueue(event);
      }),
    );
  });

  return {
    start,
    drain: worker.drain,
  } satisfies ImplementationWorkflowReactorShape;
});

export const ImplementationWorkflowReactorLive = Layer.effect(ImplementationWorkflowReactor, make);
