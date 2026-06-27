import {
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  OrchestrationPlanningIssueId,
  OrchestrationPlanningPrdId,
  OrchestrationPlanningReviewCycle,
  OrchestrationPlanningReviewCycleStatus,
  OrchestrationPlanningReviewIssueFeedback,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionThreadPlanningReviewCycle = Schema.Struct({
  threadId: ThreadId,
  prdId: OrchestrationPlanningPrdId,
  cycleNumber: NonNegativeInt,
  status: OrchestrationPlanningReviewCycleStatus,
  reviewerThreadId: ThreadId,
  reviewerMessageId: MessageId,
  verdictMarkdown: Schema.String,
  failingPlanningIssueIds: Schema.Array(OrchestrationPlanningIssueId),
  dependencyFeedback: Schema.Array(Schema.String),
  perIssueFeedback: Schema.Array(OrchestrationPlanningReviewIssueFeedback),
  createdAt: IsoDateTime,
});
export type ProjectionThreadPlanningReviewCycle = typeof ProjectionThreadPlanningReviewCycle.Type;

export function projectionReviewCycleFromContract(
  threadId: ThreadId,
  prdId: OrchestrationPlanningPrdId,
  reviewCycle: OrchestrationPlanningReviewCycle,
): ProjectionThreadPlanningReviewCycle {
  return {
    threadId,
    prdId,
    cycleNumber: reviewCycle.cycleNumber,
    status: reviewCycle.status,
    reviewerThreadId: reviewCycle.reviewerThreadId,
    reviewerMessageId: reviewCycle.reviewerMessageId,
    verdictMarkdown: reviewCycle.verdictMarkdown,
    failingPlanningIssueIds: reviewCycle.failingPlanningIssueIds,
    dependencyFeedback: reviewCycle.dependencyFeedback,
    perIssueFeedback: reviewCycle.perIssueFeedback,
    createdAt: reviewCycle.createdAt,
  };
}

export function projectionReviewCycleToContract(
  reviewCycle: ProjectionThreadPlanningReviewCycle,
): OrchestrationPlanningReviewCycle {
  return {
    cycleNumber: reviewCycle.cycleNumber,
    status: reviewCycle.status,
    reviewerThreadId: reviewCycle.reviewerThreadId,
    reviewerMessageId: reviewCycle.reviewerMessageId,
    verdictMarkdown: reviewCycle.verdictMarkdown,
    failingPlanningIssueIds: reviewCycle.failingPlanningIssueIds,
    dependencyFeedback: reviewCycle.dependencyFeedback,
    perIssueFeedback: reviewCycle.perIssueFeedback,
    createdAt: reviewCycle.createdAt,
  };
}

export const ListProjectionThreadPlanningReviewCyclesInput = Schema.Struct({
  threadId: ThreadId,
});
export type ListProjectionThreadPlanningReviewCyclesInput =
  typeof ListProjectionThreadPlanningReviewCyclesInput.Type;

export const DeleteProjectionThreadPlanningReviewCyclesInput = Schema.Struct({
  threadId: ThreadId,
});
export type DeleteProjectionThreadPlanningReviewCyclesInput =
  typeof DeleteProjectionThreadPlanningReviewCyclesInput.Type;

export interface ProjectionThreadPlanningReviewCycleRepositoryShape {
  readonly upsert: (
    reviewCycle: ProjectionThreadPlanningReviewCycle,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly listByThreadId: (
    input: ListProjectionThreadPlanningReviewCyclesInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionThreadPlanningReviewCycle>, ProjectionRepositoryError>;
  readonly deleteByThreadId: (
    input: DeleteProjectionThreadPlanningReviewCyclesInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ProjectionThreadPlanningReviewCycleRepository extends Context.Service<
  ProjectionThreadPlanningReviewCycleRepository,
  ProjectionThreadPlanningReviewCycleRepositoryShape
>()(
  "t3/persistence/Services/ProjectionThreadPlanningReviewCycles/ProjectionThreadPlanningReviewCycleRepository",
) {}
