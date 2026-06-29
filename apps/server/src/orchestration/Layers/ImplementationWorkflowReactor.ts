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
  type OrchestrationPlanningIssue,
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
import {
  ImplementationWorkflowReactor,
  type ImplementationWorkflowReactorShape,
} from "../Services/ImplementationWorkflowReactor.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";

const MAX_BROWSER_REVIEW_ATTEMPTS = 5;

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
      run.issueStates.some((state) => state.workerThreadId === workerThreadId),
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

function issuesById(thread: OrchestrationThread): ReadonlyMap<string, OrchestrationPlanningIssue> {
  const map = new Map<string, OrchestrationPlanningIssue>();
  for (const issue of thread.planningWorkflow?.issues ?? []) {
    map.set(issue.id, issue);
  }
  return map;
}

function issueMarkdown(issue: OrchestrationPlanningIssue | undefined): string {
  if (issue === undefined) {
    return "Issue details were not available in the current projection.";
  }
  return [`#${issue.ordinal} ${issue.title}`, "", issue.bodyMarkdown].join("\n");
}

function markDependentsReady(
  run: OrchestrationImplementationRun,
  updatedAt: string,
): OrchestrationImplementationRun {
  const succeededIssueIds = new Set(
    run.issueStates.filter((state) => state.status === "succeeded").map((state) => state.issueId),
  );
  return {
    ...run,
    issueStates: run.issueStates.map((state) =>
      state.status === "blocked" &&
      state.dependencyIssueIds.every((issueId) => succeededIssueIds.has(issueId))
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
  readonly issue: OrchestrationPlanningIssue | undefined;
  readonly issueId: string;
  readonly workerThreadId: ThreadId;
  readonly branch: string;
  readonly worktreePath: string;
}): string {
  return [
    `Implement planning issue ${input.issueId} for implementation run ${input.run.id}.`,
    "",
    "Do not ask the user questions. Work TDD-style: write or update a focused failing test, implement the smallest behavior, run targeted validation, then report the result.",
    "",
    "Branch/worktree:",
    `- branch: ${input.branch}`,
    `- worktree: ${input.worktreePath}`,
    "",
    "Planning issue:",
    issueMarkdown(input.issue),
    "",
    "Finish with exactly one fenced JSON directive of type implementation-worker-result. Use these fixed identifiers:",
    `- issueId: ${input.issueId}`,
    `- workerThreadId: ${input.workerThreadId}`,
    `- branch: ${input.branch}`,
    `- worktreePath: ${input.worktreePath}`,
  ].join("\n");
}

function buildMergeGatePrompt(input: { readonly run: OrchestrationImplementationRun }): string {
  const workerBranches = input.run.issueStates
    .filter((state) => state.status === "succeeded" && state.branch !== null)
    .map((state) => `- ${state.issueId}: ${state.branch}`)
    .join("\n");
  return [
    `Run merge gate for implementation run ${input.run.id}.`,
    "",
    "Merge all succeeded worker branches into the current orchestrator worktree. Resolve conflicts in favor of the PRD/planning issues, then run the required validations.",
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
    "Use the dev-review MCP tools to inspect the implemented product behavior in a browser. Do not ask the user questions.",
    "",
    input.frontendUrl === null
      ? "No frontend URL was resolved. If the app cannot be opened, mark the review blocked with concrete details."
      : `Feature URL: ${input.frontendUrl}`,
    "",
    "Review against the PRD and planning issues loaded on this implementation thread. Update the dev-review record with passed, failed, or blocked status and a document.",
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
    readonly issueId: string;
    readonly ownerUserId: WorkspaceUserId;
    readonly createdAt: string;
  }) {
    const plannedWorker = input.run.launchSummary.plannedWorkers.find(
      (worker) => worker.issueId === input.issueId,
    );
    if (plannedWorker === undefined) return input.run;

    const existing = input.run.issueStates.find((state) => state.issueId === input.issueId);
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
    const issue = issuesById(sourceThread ?? input.orchestratorThread).get(input.issueId);

    yield* orchestrationEngine.dispatch({
      type: "thread.create",
      commandId: yield* serverCommandId("implementation-worker-create"),
      threadId: workerThreadId,
      projectId: input.orchestratorThread.projectId,
      ownerUserId: input.ownerUserId,
      parentThreadId: input.run.orchestratorThreadId,
      workflowRole: "implementation-worker",
      title: `Implement ${issue?.title ?? input.issueId}`,
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
          issue,
          issueId: input.issueId,
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
      issueStates: input.run.issueStates.map((state) =>
        state.issueId === input.issueId
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

      const readyIssueIds = input.run.issueStates
        .filter((issueState) => issueState.status === "ready")
        .map((issueState) => issueState.issueId);
      const startedRuns = yield* Effect.forEach(
        readyIssueIds,
        (issueId) =>
          createWorker({
            sourceThreadId: input.sourceThreadId,
            orchestratorThread,
            run: input.run,
            issueId,
            ownerUserId: orchestratorThread.ownerUserId,
            createdAt: input.createdAt,
          }),
        { concurrency: "unbounded" },
      );
      const startedStates = new Map(
        startedRuns.flatMap((run) =>
          run.issueStates
            .filter((state) => state.status === "running" && readyIssueIds.includes(state.issueId))
            .map((state) => [state.issueId, state] as const),
        ),
      );
      const nextRun =
        startedStates.size === 0
          ? input.run
          : ({
              ...input.run,
              issueStates: input.run.issueStates.map(
                (state) => startedStates.get(state.issueId) ?? state,
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
        modelSelection: orchestratorThread.modelSelection,
        runtimeMode: orchestratorThread.runtimeMode,
        workflowPromptId: WORKFLOW_PROMPT_IDS.implementationBrowserDevReviewCodex,
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
          commitMessage: `Implement ${input.run.prdId}`,
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

      yield* updateRun({
        sourceThreadId: input.sourceThreadId,
        run: {
          ...input.run,
          status: "completed",
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
          issueStates: run.issueStates.map((state) =>
            state.workerThreadId === event.payload.threadId || state.issueId === directive.issueId
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
          issueStates: run.issueStates.map((state) =>
            state.workerThreadId === event.payload.threadId || state.issueId === directive.issueId
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
      if (succeededRun.issueStates.every((state) => state.status === "succeeded")) {
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
    readonly reviewMarkdown: string;
    readonly createdAt: string;
  }) {
    const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
    const orchestratorThread = findThread(readModel, input.run.orchestratorThreadId);
    if (orchestratorThread === null) return;
    const fixerThreadId = yield* serverThreadId("implementation-fixer");
    const fixingRun: OrchestrationImplementationRun = {
      ...input.run,
      status: "fixing",
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
      title: "Fix browser dev review",
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
        text: buildFixPrompt({ run: input.run, reviewMarkdown: input.reviewMarkdown }),
        attachments: [],
      },
      workflowPromptId: WORKFLOW_PROMPT_IDS.implementationFixCodex,
      runtimeMode: orchestratorThread.runtimeMode,
      interactionMode: "implementation-workflow",
      createdAt: input.createdAt,
    });
  });

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
        reviewMarkdown: devReviewMarkdown(event.payload.document),
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
