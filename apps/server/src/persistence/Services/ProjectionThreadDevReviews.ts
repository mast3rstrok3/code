import {
  DevReviewDocument,
  DevReviewId,
  DevReviewRecord,
  DevReviewReplayMetadata,
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
  sourceTurnId: Schema.NullOr(TurnId),
  status: DevReviewStatus,
  document: DevReviewDocument,
  replay: DevReviewReplayMetadata,
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
    sourceTurnId: record.sourceTurnId,
    status: record.status,
    document: record.document,
    replay: record.replay,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export function projectionThreadDevReviewToRecord(row: ProjectionThreadDevReview): DevReviewRecord {
  return {
    id: row.reviewId,
    sourceThreadId: row.sourceThreadId,
    reviewThreadId: row.reviewThreadId,
    sourceTurnId: row.sourceTurnId,
    status: row.status,
    document: row.document,
    replay: row.replay,
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
