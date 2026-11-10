import * as McpToolAccess from "../../McpToolAccess.ts";
import {
  OrchestrationDispatchCommandError,
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
    const scope = yield* McpInvocationContext.requireThreadMcpCapability("workflow-artifacts");
    const callerThreadId = scope.thread.threadId;
    const snapshot = yield* getWorkflowArtifactsForThread({ threadId: callerThreadId });
    // Stage agents must not restart their own or a sibling's stage; the root speaks for the user.
    if (snapshot.context.rootThreadId !== callerThreadId) {
      return yield* notFound(
        callerThreadId,
        "Only the workflow's root thread can restart its stages.",
      );
    }
    if (!snapshot.implementationRuns.some((run) => run.id === input.runId)) {
      return yield* notFound(
        callerThreadId,
        `Implementation run '${input.runId}' is not in this workflow.`,
      );
    }
    const engine = yield* OrchestrationEngineService;
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    const base = {
      commandId: yield* newCommandId(),
      threadId: callerThreadId,
      runId: input.runId,
      target: input.target,
      createdAt,
    };
    return yield* engine
      .dispatch(
        input.mode === "rerun"
          ? { type: "thread.implementation-run.rerun", ...base }
          : { type: "thread.implementation-run.reset", ...base },
        { priority: "interactive" },
      )
      .pipe(
        Effect.mapError(
          (cause) =>
            new OrchestrationDispatchCommandError({
              message: `Failed to ${input.mode} the workflow stage.`,
              cause,
            }),
        ),
      );
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
});

export const WorkflowArtifactsToolkitHandlersLive = WorkflowArtifactsToolkit.toLayer(handlers);
