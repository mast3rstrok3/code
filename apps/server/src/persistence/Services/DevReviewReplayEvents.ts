import { DevReviewId, IsoDateTime, NonNegativeInt } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const DevReviewReplayEventChunk = Schema.Struct({
  reviewId: DevReviewId,
  chunkIndex: NonNegativeInt,
  events: Schema.Array(Schema.Unknown),
  eventCount: NonNegativeInt,
  createdAt: IsoDateTime,
});
export type DevReviewReplayEventChunk = typeof DevReviewReplayEventChunk.Type;

export const AppendDevReviewReplayEventsInput = Schema.Struct({
  reviewId: DevReviewId,
  events: Schema.Array(Schema.Unknown),
  createdAt: IsoDateTime,
});
export type AppendDevReviewReplayEventsInput = typeof AppendDevReviewReplayEventsInput.Type;

export const ListDevReviewReplayEventsInput = Schema.Struct({
  reviewId: DevReviewId,
});
export type ListDevReviewReplayEventsInput = typeof ListDevReviewReplayEventsInput.Type;

export const GetDevReviewReplayEventCountInput = Schema.Struct({
  reviewId: DevReviewId,
});
export type GetDevReviewReplayEventCountInput = typeof GetDevReviewReplayEventCountInput.Type;

export interface DevReviewReplayEventRepositoryShape {
  readonly appendEvents: (
    input: AppendDevReviewReplayEventsInput,
  ) => Effect.Effect<DevReviewReplayEventChunk, ProjectionRepositoryError>;
  readonly listByReviewId: (
    input: ListDevReviewReplayEventsInput,
  ) => Effect.Effect<ReadonlyArray<DevReviewReplayEventChunk>, ProjectionRepositoryError>;
  readonly countByReviewId: (
    input: GetDevReviewReplayEventCountInput,
  ) => Effect.Effect<number, ProjectionRepositoryError>;
}

export class DevReviewReplayEventRepository extends Context.Service<
  DevReviewReplayEventRepository,
  DevReviewReplayEventRepositoryShape
>()("t3/persistence/Services/DevReviewReplayEvents/DevReviewReplayEventRepository") {}
