import * as McpToolAccess from "../../McpToolAccess.ts";
import {
  type CommandId,
  type OrchestrationCommand,
  OrchestrationDispatchCommandError,
  OrchestrationGetSnapshotError,
  type ThreadId,
  WorkflowArtifactAccessError,
  type WorkflowArtifactsSnapshot,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { getWorkflowArtifactsForThread } from "../../../orchestration/workflowArtifacts.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { newCommandId } from "../../threadAccess.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { WorkflowArtifactsToolkit, type WorkflowRunProgress } from "./tools.ts";
import { resolveWorkflowDoc } from "../../../provider/WorkflowPromptRegistry.ts";

const resolve = Effect.fn("WorkflowArtifactsToolkit.resolve")(function* () {
  const scope = yield* McpInvocationContext.requireThreadMcpCapability("workflow-artifacts");
  return yield* getWorkflowArtifactsForThread({ threadId: scope.thread.threadId });
});

const notFound = (threadId: ThreadId, message: string) =>
  new WorkflowArtifactAccessError({ threadId, message });

const workflowRunProgress = (
  snapshot: WorkflowArtifactsSnapshot,
): ReadonlyArray<typeof WorkflowRunProgress.Type> =>
  snapshot.implementationRuns.map((run) => ({
    runId: run.id,
    status: run.status,
    automationHalt: run.automationHalt,
    retryableFailure: run.retryableFailure,
    skips: run.skips,
    orchestratorThreadId: run.orchestratorThreadId,
    tickets: run.ticketStates.map((state) => {
      const ticket = snapshot.tickets.find((candidate) => candidate.id === state.ticketId);
      return {
        ticketId: state.ticketId,
        key: ticket?.key ?? null,
        title: ticket?.title ?? null,
        status: state.status,
        dependencyTicketIds: state.dependencyTicketIds,
        workerThreadId: state.workerThreadId,
        codeReviewThreadId: state.codeReviewThreadId ?? null,
        updatedAt: state.updatedAt,
      };
    }),
    updatedAt: run.updatedAt,
  }));

// Stage agents must not steer their own or a sibling's stage; the root speaks for the user.
const requireRoot = Effect.fn("WorkflowArtifactsToolkit.requireRoot")(function* () {
  const scope = yield* McpInvocationContext.requireThreadMcpCapability("workflow-artifacts");
  const callerThreadId = scope.thread.threadId;
  const snapshot = yield* getWorkflowArtifactsForThread({ threadId: callerThreadId });
  if (snapshot.context.rootThreadId !== callerThreadId) {
    return yield* notFound(callerThreadId, "Only the workflow's root thread can control its runs.");
  }
  return { snapshot, callerThreadId };
});

const requireRootForRun = Effect.fn("WorkflowArtifactsToolkit.requireRootForRun")(function* (
  runId: string,
) {
  const { snapshot, callerThreadId } = yield* requireRoot();
  if (!snapshot.implementationRuns.some((run) => run.id === runId)) {
    return yield* notFound(
      callerThreadId,
      `Implementation run '${runId}' is not in this workflow.`,
    );
  }
  return callerThreadId;
});

const readCommandModel = Effect.fn("WorkflowArtifactsToolkit.readCommandModel")(function* () {
  const query = yield* ProjectionSnapshotQuery;
  return yield* query
    .getCommandReadModel()
    .pipe(
      Effect.mapError(
        (cause) =>
          new OrchestrationGetSnapshotError({ message: "Failed to load the workflow.", cause }),
      ),
    );
});

const isWithinWorkflow = (
  threads: ReadonlyArray<{ readonly id: ThreadId; readonly parentThreadId: ThreadId | null }>,
  threadId: ThreadId,
  rootThreadId: ThreadId,
) => {
  const seen = new Set<ThreadId>();
  let current = threads.find((thread) => thread.id === threadId);
  while (current !== undefined && !seen.has(current.id)) {
    if (current.id === rootThreadId) return true;
    seen.add(current.id);
    const parentId = current.parentThreadId;
    current = parentId === null ? undefined : threads.find((thread) => thread.id === parentId);
  }
  return false;
};

const dispatchAsRoot = Effect.fn("WorkflowArtifactsToolkit.dispatch")(function* (
  action: string,
  command: (base: {
    readonly commandId: CommandId;
    readonly createdAt: string;
  }) => OrchestrationCommand,
) {
  const engine = yield* OrchestrationEngineService;
  const base = {
    commandId: yield* newCommandId(),
    createdAt: DateTime.formatIso(yield* DateTime.now),
  };
  return yield* engine
    .dispatch(command(base), { priority: "interactive" })
    .pipe(
      Effect.mapError(
        (cause) =>
          new OrchestrationDispatchCommandError({ message: `Failed to ${action}.`, cause }),
      ),
    );
});

export const handlers = {
  workflow_context_get: () => resolve().pipe(Effect.map((snapshot) => snapshot.context)),
  workflow_spec_get: () => resolve().pipe(Effect.map((snapshot) => ({ spec: snapshot.spec }))),
  workflow_wayfinder_map_get: () =>
    resolve().pipe(Effect.map((snapshot) => ({ wayfinderMap: snapshot.wayfinderMap }))),
  workflow_tickets_list: () =>
    resolve().pipe(Effect.map((snapshot) => ({ tickets: snapshot.tickets }))),
  workflow_ticket_get: Effect.fn("WorkflowArtifactsToolkit.ticketGet")(function* (input) {
    const snapshot = yield* resolve();
    const ticket = snapshot.tickets.find((candidate) => candidate.id === input.ticketId);
    if (ticket === undefined) {
      return yield* notFound(
        snapshot.context.rootThreadId,
        `Planning Ticket '${input.ticketId}' is not in this workflow.`,
      );
    }
    return ticket;
  }),
  workflow_app_reviews_list: () =>
    resolve().pipe(Effect.map((snapshot) => ({ appReviews: snapshot.appReviews }))),
  workflow_app_review_get: Effect.fn("WorkflowArtifactsToolkit.appReviewGet")(function* (input) {
    const snapshot = yield* resolve();
    const review = snapshot.appReviews.find((candidate) => candidate.id === input.reviewId);
    if (review === undefined) {
      return yield* notFound(
        snapshot.context.rootThreadId,
        `App Review '${input.reviewId}' is not in this workflow.`,
      );
    }
    return review;
  }),
  workflow_doc_get: Effect.fn("WorkflowArtifactsToolkit.docGet")(function* (input) {
    const scope = yield* McpInvocationContext.requireThreadMcpCapability("workflow-artifacts");
    const doc = resolveWorkflowDoc(input.docId);
    if (doc === undefined) {
      return yield* notFound(
        scope.thread.threadId,
        `Workflow document '${input.docId}' was not found.`,
      );
    }
    return doc;
  }),
  workflow_status_get: () =>
    resolve().pipe(Effect.map((snapshot) => ({ runs: workflowRunProgress(snapshot) }))),
  workflow_stage_restart: Effect.fn("WorkflowArtifactsToolkit.stageRestart")(function* (input) {
    const callerThreadId = yield* requireRootForRun(input.runId);
    return yield* dispatchAsRoot(`${input.mode} the workflow stage`, (base) => ({
      ...base,
      type:
        input.mode === "rerun"
          ? ("thread.implementation-run.rerun" as const)
          : ("thread.implementation-run.reset" as const),
      threadId: callerThreadId,
      runId: input.runId,
      target: input.target,
    }));
  }),
  workflow_stage_skip: Effect.fn("WorkflowArtifactsToolkit.stageSkip")(function* (input) {
    const callerThreadId = yield* requireRootForRun(input.runId);
    return yield* dispatchAsRoot("change the workflow stage's skip", (base) => ({
      ...base,
      type: "thread.implementation-run.skip",
      threadId: callerThreadId,
      runId: input.runId,
      target: input.target,
      skipped: input.skipped,
    }));
  }),
  workflow_pause: Effect.fn("WorkflowArtifactsToolkit.pause")(function* (input) {
    const { snapshot, callerThreadId } = yield* requireRoot();
    // Pausing a scope stops every session in it, and the caller's own turn would be one of them.
    if (input.paused && input.threadId === callerThreadId) {
      return yield* notFound(
        callerThreadId,
        "Pausing the root thread would stop this thread too. Pause a run's orchestratorThreadId instead.",
      );
    }
    const readModel = yield* readCommandModel();
    if (!isWithinWorkflow(readModel.threads, input.threadId, snapshot.context.rootThreadId)) {
      return yield* notFound(callerThreadId, `Thread '${input.threadId}' is not in this workflow.`);
    }
    return yield* dispatchAsRoot(
      input.paused ? "pause the workflow" : "resume the workflow",
      (base) => ({
        ...base,
        type: input.paused
          ? ("thread.workflow.pause" as const)
          : ("thread.workflow.resume" as const),
        threadId: input.threadId,
      }),
    );
  }),
  workflow_run_control: Effect.fn("WorkflowArtifactsToolkit.runControl")(function* (input) {
    const callerThreadId = yield* requireRootForRun(input.runId);
    return yield* input.action === "retry"
      ? dispatchAsRoot("retry the workflow run", (base) => ({
          ...base,
          type: "thread.implementation-run.retry",
          threadId: callerThreadId,
          runId: input.runId,
        }))
      : dispatchAsRoot("cancel the workflow run", (base) => ({
          ...base,
          type: "thread.implementation-run.cancel",
          threadId: callerThreadId,
          runId: input.runId,
          ...(input.reason === undefined ? {} : { reason: input.reason }),
        }));
  }),
} satisfies Parameters<typeof WorkflowArtifactsToolkit.toLayer>[0];

export const layer = McpToolAccess.toLayer(WorkflowArtifactsToolkit, {
  workflow_context_get: McpToolAccess.readsAsCaller(handlers.workflow_context_get),
  workflow_spec_get: McpToolAccess.readsAsCaller(handlers.workflow_spec_get),
  workflow_wayfinder_map_get: McpToolAccess.readsAsCaller(handlers.workflow_wayfinder_map_get),
  workflow_tickets_list: McpToolAccess.readsAsCaller(handlers.workflow_tickets_list),
  workflow_ticket_get: McpToolAccess.readsAsCaller(handlers.workflow_ticket_get),
  workflow_app_reviews_list: McpToolAccess.readsAsCaller(handlers.workflow_app_reviews_list),
  workflow_app_review_get: McpToolAccess.readsAsCaller(handlers.workflow_app_review_get),
  workflow_doc_get: McpToolAccess.readsAsCaller(handlers.workflow_doc_get),
  workflow_status_get: McpToolAccess.readsAsCaller(handlers.workflow_status_get),
  workflow_stage_restart: McpToolAccess.actsAsCaller(handlers.workflow_stage_restart),
  workflow_stage_skip: McpToolAccess.actsAsCaller(handlers.workflow_stage_skip),
  workflow_pause: McpToolAccess.actsAsCaller(handlers.workflow_pause),
  workflow_run_control: McpToolAccess.actsAsCaller(handlers.workflow_run_control),
});

export const WorkflowArtifactsToolkitHandlersLive = WorkflowArtifactsToolkit.toLayer(handlers);
