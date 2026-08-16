import {
  AppReviewDocument,
  AppReviewEvidence,
  AppReviewId,
  AppReviewRecord,
  AppReviewSourceProposedPlan,
  AppReviewStatus,
  IsoDateTime,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionThreadAppReview = Schema.Struct({
  reviewId: AppReviewId,
  sourceThreadId: ThreadId,
  reviewThreadId: ThreadId,
  planningTicketIds: Schema.optionalKey(Schema.Array(Schema.String)),
  sourceProposedPlan: Schema.NullOr(AppReviewSourceProposedPlan),
  sourceTurnId: Schema.NullOr(TurnId),
  status: AppReviewStatus,
  document: AppReviewDocument,
  evidence: AppReviewEvidence,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ProjectionThreadAppReview = typeof ProjectionThreadAppReview.Type;

export const GetProjectionThreadAppReviewInput = Schema.Struct({
  reviewId: AppReviewId,
});
export type GetProjectionThreadAppReviewInput = typeof GetProjectionThreadAppReviewInput.Type;

export const ListProjectionThreadAppReviewsByThreadInput = Schema.Struct({
  threadId: ThreadId,
});
export type ListProjectionThreadAppReviewsByThreadInput =
  typeof ListProjectionThreadAppReviewsByThreadInput.Type;

export const DeleteProjectionThreadAppReviewsByThreadInput = Schema.Struct({
  threadId: ThreadId,
});
export type DeleteProjectionThreadAppReviewsByThreadInput =
  typeof DeleteProjectionThreadAppReviewsByThreadInput.Type;

export function appReviewRecordToProjection(record: AppReviewRecord): ProjectionThreadAppReview {
  return {
    reviewId: record.id,
    sourceThreadId: record.sourceThreadId,
    reviewThreadId: record.reviewThreadId,
    planningTicketIds: record.planningTicketIds ?? [],
    sourceProposedPlan: record.sourceProposedPlan ?? null,
    sourceTurnId: record.sourceTurnId,
    status: record.status,
    document: record.document,
    evidence: record.evidence,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export function projectionThreadAppReviewToRecord(row: ProjectionThreadAppReview): AppReviewRecord {
  return {
    id: row.reviewId,
    sourceThreadId: row.sourceThreadId,
    reviewThreadId: row.reviewThreadId,
    planningTicketIds: row.planningTicketIds ?? [],
    ...(row.sourceProposedPlan === null ? {} : { sourceProposedPlan: row.sourceProposedPlan }),
    sourceTurnId: row.sourceTurnId,
    status: row.status,
    document: row.document,
    evidence: row.evidence,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export interface ProjectionThreadAppReviewRepositoryShape {
  readonly upsert: (
    row: ProjectionThreadAppReview,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly getById: (
    input: GetProjectionThreadAppReviewInput,
  ) => Effect.Effect<Option.Option<ProjectionThreadAppReview>, ProjectionRepositoryError>;
  readonly listByThreadId: (
    input: ListProjectionThreadAppReviewsByThreadInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionThreadAppReview>, ProjectionRepositoryError>;
  readonly listAll: () => Effect.Effect<
    ReadonlyArray<ProjectionThreadAppReview>,
    ProjectionRepositoryError
  >;
  readonly deleteByThreadId: (
    input: DeleteProjectionThreadAppReviewsByThreadInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ProjectionThreadAppReviewRepository extends Context.Service<
  ProjectionThreadAppReviewRepository,
  ProjectionThreadAppReviewRepositoryShape
>()("t3/persistence/Services/ProjectionThreadAppReviews/ProjectionThreadAppReviewRepository") {}
