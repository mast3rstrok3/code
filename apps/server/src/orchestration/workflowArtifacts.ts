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
    const relatedDevReviewRun = (readModel.devReviewWorkflowRuns ?? []).find(
      (run) =>
        run.targetThreadId === thread.id ||
        run.controllerThreadId === thread.id ||
        run.cycles.some(
          (cycle) => cycle.reviewerThreadId === thread.id || cycle.fixerThreadId === thread.id,
        ),
    );
    const targetThread =
      relatedDevReviewRun === undefined
        ? thread
        : (readModel.threads.find(
            (candidate) => candidate.id === relatedDevReviewRun.targetThreadId,
          ) ?? thread);
    const controllerThread =
      relatedDevReviewRun === undefined
        ? thread
        : (readModel.threads.find(
            (candidate) => candidate.id === relatedDevReviewRun.controllerThreadId,
          ) ?? thread);
    const context =
      relatedDevReviewRun === undefined
        ? thread.workflowContext
        : (targetThread.workflowContext ?? controllerThread.workflowContext);
    if (context == null) {
      return yield* new WorkflowArtifactAccessError({
        threadId: input.threadId,
        message: "This thread is not associated with a workflow.",
      });
    }

    const workflowThreads = readModel.threads.filter(
      (candidate) =>
        candidate.projectId === thread.projectId &&
        candidate.workflowContext?.workflowId === context.workflowId,
    );
    const planningWorkflow = workflowThreads
      .map((candidate) => candidate.planningWorkflow)
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
    const devReviewWorkflowRuns = (readModel.devReviewWorkflowRuns ?? []).filter(
      (run) =>
        run.id === relatedDevReviewRun?.id ||
        workflowThreads.some(
          (candidate) =>
            candidate.id === run.targetThreadId || candidate.id === run.controllerThreadId,
        ),
    );
    const reviewsById = new Map(
      [...workflowThreads, targetThread, controllerThread]
        .flatMap((candidate) => candidate.devReviews)
        .concat(
          devReviewWorkflowRuns.flatMap((run) =>
            run.cycles.flatMap((cycle) =>
              readModel.threads.flatMap((candidate) =>
                candidate.devReviews.filter((review) => review.id === cycle.reviewId),
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
      devReviewWorkflowRuns,
      devReviews: Array.from(reviewsById.values()),
    } satisfies WorkflowArtifactsSnapshot;
  },
);
