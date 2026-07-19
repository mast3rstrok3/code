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
    if (thread.workflowContext == null) {
      return yield* new WorkflowArtifactAccessError({
        threadId: input.threadId,
        message: "This thread is not associated with a workflow.",
      });
    }

    const workflowThreads = readModel.threads.filter(
      (candidate) =>
        candidate.projectId === thread.projectId &&
        candidate.workflowContext?.workflowId === thread.workflowContext?.workflowId,
    );
    const planningWorkflow = workflowThreads
      .map((candidate) => candidate.planningWorkflow)
      .find((workflow) => workflow?.spec !== null && workflow?.spec !== undefined);
    const spec = planningWorkflow?.spec ?? null;
    const implementationRuns = readModel.implementationRuns.filter(
      (run) =>
        (spec !== null && run.specId === spec.id) ||
        run.sourceProposedPlan?.threadId === thread.workflowContext?.rootThreadId,
    );
    const reviewsById = new Map(
      workflowThreads
        .flatMap((candidate) => candidate.devReviews)
        .map((review) => [review.id, review]),
    );

    return {
      projectId: thread.projectId,
      context: thread.workflowContext,
      spec,
      tickets: planningWorkflow?.tickets ?? [],
      reviewCycles: planningWorkflow?.reviewCycles ?? [],
      implementationRuns,
      devReviews: Array.from(reviewsById.values()),
    } satisfies WorkflowArtifactsSnapshot;
  },
);
