import {
  DevReviewDocument,
  DevReviewEvidence,
  DevReviewId,
  DevReviewRecord,
  DevReviewStatus,
  IsoDateTime,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionThreadDevReview = Schema.Struct({
  reviewId: DevReviewId,
  sourceThreadId: ThreadId,
  reviewThreadId: ThreadId,
  planningTicketIds: Schema.optionalKey(Schema.Array(Schema.String)),
  sourceTurnId: Schema.NullOr(TurnId),
  status: DevReviewStatus,
  document: DevReviewDocument,
  evidence: DevReviewEvidence,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ProjectionThreadDevReview = typeof ProjectionThreadDevReview.Type;

export const GetProjectionThreadDevReviewInput = Schema.Struct({
  reviewId: DevReviewId,
});
export type GetProjectionThreadDevReviewInput = typeof GetProjectionThreadDevReviewInput.Type;

export const ListProjectionThreadDevReviewsByThreadInput = Schema.Struct({
  threadId: ThreadId,
});
export type ListProjectionThreadDevReviewsByThreadInput =
  typeof ListProjectionThreadDevReviewsByThreadInput.Type;

export const DeleteProjectionThreadDevReviewsByThreadInput = Schema.Struct({
  threadId: ThreadId,
});
export type DeleteProjectionThreadDevReviewsByThreadInput =
  typeof DeleteProjectionThreadDevReviewsByThreadInput.Type;

export function devReviewRecordToProjection(record: DevReviewRecord): ProjectionThreadDevReview {
  return {
    reviewId: record.id,
    sourceThreadId: record.sourceThreadId,
    reviewThreadId: record.reviewThreadId,
    planningTicketIds: record.planningTicketIds ?? [],
    sourceTurnId: record.sourceTurnId,
    status: record.status,
    document: record.document,
    evidence: record.evidence,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export function projectionThreadDevReviewToRecord(row: ProjectionThreadDevReview): DevReviewRecord {
  return {
    id: row.reviewId,
    sourceThreadId: row.sourceThreadId,
    reviewThreadId: row.reviewThreadId,
    planningTicketIds: row.planningTicketIds ?? [],
    sourceTurnId: row.sourceTurnId,
    status: row.status,
    document: row.document,
    evidence: row.evidence,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export interface ProjectionThreadDevReviewRepositoryShape {
  readonly upsert: (
    row: ProjectionThreadDevReview,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly getById: (
    input: GetProjectionThreadDevReviewInput,
  ) => Effect.Effect<Option.Option<ProjectionThreadDevReview>, ProjectionRepositoryError>;
  readonly listByThreadId: (
    input: ListProjectionThreadDevReviewsByThreadInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionThreadDevReview>, ProjectionRepositoryError>;
  readonly listAll: () => Effect.Effect<
    ReadonlyArray<ProjectionThreadDevReview>,
    ProjectionRepositoryError
  >;
  readonly deleteByThreadId: (
    input: DeleteProjectionThreadDevReviewsByThreadInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ProjectionThreadDevReviewRepository extends Context.Service<
  ProjectionThreadDevReviewRepository,
  ProjectionThreadDevReviewRepositoryShape
>()("t3/persistence/Services/ProjectionThreadDevReviews/ProjectionThreadDevReviewRepository") {}
