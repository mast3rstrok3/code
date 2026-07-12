import {
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  OrchestrationPlanningTicketId,
  OrchestrationPlanningSpecId,
  OrchestrationPlanningReviewCycle,
  OrchestrationPlanningReviewCycleStatus,
  OrchestrationPlanningReviewTicketFeedback,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionThreadPlanningReviewCycle = Schema.Struct({
  threadId: ThreadId,
  specId: OrchestrationPlanningSpecId,
  cycleNumber: NonNegativeInt,
  status: OrchestrationPlanningReviewCycleStatus,
  reviewerThreadId: ThreadId,
  reviewerMessageId: MessageId,
  verdictMarkdown: Schema.String,
  failingPlanningTicketIds: Schema.Array(OrchestrationPlanningTicketId),
  dependencyFeedback: Schema.Array(Schema.String),
  perTicketFeedback: Schema.Array(OrchestrationPlanningReviewTicketFeedback),
  createdAt: IsoDateTime,
});
export type ProjectionThreadPlanningReviewCycle = typeof ProjectionThreadPlanningReviewCycle.Type;

export function projectionReviewCycleFromContract(
  threadId: ThreadId,
  specId: OrchestrationPlanningSpecId,
  reviewCycle: OrchestrationPlanningReviewCycle,
): ProjectionThreadPlanningReviewCycle {
  return {
    threadId,
    specId,
    cycleNumber: reviewCycle.cycleNumber,
    status: reviewCycle.status,
    reviewerThreadId: reviewCycle.reviewerThreadId,
    reviewerMessageId: reviewCycle.reviewerMessageId,
    verdictMarkdown: reviewCycle.verdictMarkdown,
    failingPlanningTicketIds: reviewCycle.failingPlanningTicketIds,
    dependencyFeedback: reviewCycle.dependencyFeedback,
    perTicketFeedback: reviewCycle.perTicketFeedback,
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
    failingPlanningTicketIds: reviewCycle.failingPlanningTicketIds,
    dependencyFeedback: reviewCycle.dependencyFeedback,
    perTicketFeedback: reviewCycle.perTicketFeedback,
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
