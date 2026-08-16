import {
  type ProjectId,
  type ThreadId,
  OrchestrationGetSnapshotError,
  WorkflowArtifactAccessError,
  type WorkflowArtifactsSnapshot,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";

export const getWorkflowArtifactsForThread = Effect.fn("getWorkflowArtifactsForThread")(
  function* (input: { readonly threadId: ThreadId; readonly projectId?: ProjectId }) {
    const query = yield* ProjectionSnapshotQuery;
    const readModel = yield* query.getCommandReadModel().pipe(
      Effect.mapError(
        (cause) =>
          new OrchestrationGetSnapshotError({
            message: "Failed to load workflow artifacts.",
            cause,
          }),
      ),
    );
    const thread = readModel.threads.find((candidate) => candidate.id === input.threadId);
    if (thread === undefined) {
      return yield* new WorkflowArtifactAccessError({
        threadId: input.threadId,
        message: `Workflow thread '${input.threadId}' was not found.`,
      });
    }
    if (input.projectId !== undefined && thread.projectId !== input.projectId) {
      return yield* new WorkflowArtifactAccessError({
        threadId: input.threadId,
        message: "Workflow artifacts belong to a different project.",
      });
    }
    const relatedAppReviewRun = (readModel.appReviewWorkflowRuns ?? []).find(
      (run) =>
        run.targetThreadId === thread.id ||
        run.controllerThreadId === thread.id ||
        run.cycles.some(
          (cycle) => cycle.reviewerThreadId === thread.id || cycle.fixerThreadId === thread.id,
        ),
    );
    const targetThread =
      relatedAppReviewRun === undefined
        ? thread
        : (readModel.threads.find(
            (candidate) => candidate.id === relatedAppReviewRun.targetThreadId,
          ) ?? thread);
    const controllerThread =
      relatedAppReviewRun === undefined
        ? thread
        : (readModel.threads.find(
            (candidate) => candidate.id === relatedAppReviewRun.controllerThreadId,
          ) ?? thread);
    const context =
      relatedAppReviewRun === undefined
        ? thread.workflowContext
        : (targetThread.workflowContext ?? controllerThread.workflowContext);
    if (context == null) {
      return yield* new WorkflowArtifactAccessError({
        threadId: input.threadId,
        message: "This thread is not associated with a workflow.",
      });
    }

    const workflowLineage = [context.workflowId];
    const workflowIds = new Set(workflowLineage);
    let parentWorkflowId = context.parentWorkflowId;
    while (parentWorkflowId != null && !workflowIds.has(parentWorkflowId)) {
      const parentContext = readModel.threads.find(
        (candidate) =>
          candidate.projectId === thread.projectId &&
          candidate.workflowContext?.rootThreadId === context.rootThreadId &&
          candidate.workflowContext.workflowId === parentWorkflowId,
      )?.workflowContext;
      if (parentContext == null) break;
      workflowLineage.push(parentWorkflowId);
      workflowIds.add(parentWorkflowId);
      parentWorkflowId = parentContext.parentWorkflowId;
    }

    const workflowThreads = readModel.threads.filter(
      (candidate) =>
        candidate.projectId === thread.projectId &&
        candidate.workflowContext?.rootThreadId === context.rootThreadId &&
        workflowIds.has(candidate.workflowContext.workflowId),
    );
    const planningWorkflow = workflowLineage
      .flatMap((workflowId) =>
        workflowThreads
          .filter((candidate) => candidate.workflowContext?.workflowId === workflowId)
          .map((candidate) => candidate.planningWorkflow),
      )
      .find(
        (workflow) =>
          (workflow?.spec !== null && workflow?.spec !== undefined) ||
          (workflow?.wayfinderMap !== null && workflow?.wayfinderMap !== undefined),
      );
    const spec = planningWorkflow?.spec ?? null;
    const wayfinderMap = planningWorkflow?.wayfinderMap ?? null;
    const implementationRuns = readModel.implementationRuns.filter(
      (run) =>
        (spec !== null && run.specId === spec.id) ||
        run.sourceProposedPlan?.threadId === context.rootThreadId,
    );
    const appReviewWorkflowRuns = (readModel.appReviewWorkflowRuns ?? []).filter(
      (run) =>
        run.id === relatedAppReviewRun?.id ||
        workflowThreads.some(
          (candidate) =>
            candidate.id === run.targetThreadId || candidate.id === run.controllerThreadId,
        ),
    );
    const reviewsById = new Map(
      [...workflowThreads, targetThread, controllerThread]
        .flatMap((candidate) => candidate.appReviews)
        .concat(
          appReviewWorkflowRuns.flatMap((run) =>
            run.cycles.flatMap((cycle) =>
              readModel.threads.flatMap((candidate) =>
                candidate.appReviews.filter((review) => review.id === cycle.reviewId),
              ),
            ),
          ),
        )
        .map((review) => [review.id, review]),
    );

    return {
      projectId: thread.projectId,
      context,
      spec,
      wayfinderMap,
      tickets: planningWorkflow?.tickets ?? [],
      reviewCycles: planningWorkflow?.reviewCycles ?? [],
      implementationRuns,
      appReviewWorkflowRuns,
      appReviews: Array.from(reviewsById.values()),
    } satisfies WorkflowArtifactsSnapshot;
  },
);
