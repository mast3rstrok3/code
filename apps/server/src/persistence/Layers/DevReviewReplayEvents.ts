import { NonNegativeInt } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  DevReviewReplayEventChunk,
  DevReviewReplayEventRepository,
  GetDevReviewReplayEventCountInput,
  ListDevReviewReplayEventsInput,
  type DevReviewReplayEventRepositoryShape,
} from "../Services/DevReviewReplayEvents.ts";

const DevReviewReplayEventChunkDbRow = DevReviewReplayEventChunk.mapFields(
  Struct.assign({
    events: Schema.fromJsonString(Schema.Array(Schema.Unknown)),
  }),
);

const NextChunkIndexRow = Schema.Struct({
  nextChunkIndex: NonNegativeInt,
});

const EventCountRow = Schema.Struct({
  eventCount: NonNegativeInt,
});

const makeDevReviewReplayEventRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const readNextChunkIndex = SqlSchema.findOne({
    Request: GetDevReviewReplayEventCountInput,
    Result: NextChunkIndexRow,
    execute: ({ reviewId }) => sql`
      SELECT COALESCE(MAX(chunk_index) + 1, 0) AS "nextChunkIndex"
      FROM dev_review_rrweb_event_chunks
      WHERE review_id = ${reviewId}
    `,
  });

  const insertReplayEventChunk = SqlSchema.void({
    Request: DevReviewReplayEventChunk,
    execute: (row) => sql`
      INSERT INTO dev_review_rrweb_event_chunks (
        review_id,
        chunk_index,
        events_json,
        event_count,
        created_at
      )
      VALUES (
        ${row.reviewId},
        ${row.chunkIndex},
        ${JSON.stringify(row.events)},
        ${row.eventCount},
        ${row.createdAt}
      )
    `,
  });

  const listReplayEventChunks = SqlSchema.findAll({
    Request: ListDevReviewReplayEventsInput,
    Result: DevReviewReplayEventChunkDbRow,
    execute: ({ reviewId }) => sql`
      SELECT
        review_id AS "reviewId",
        chunk_index AS "chunkIndex",
        events_json AS "events",
        event_count AS "eventCount",
        created_at AS "createdAt"
      FROM dev_review_rrweb_event_chunks
      WHERE review_id = ${reviewId}
      ORDER BY chunk_index ASC
    `,
  });

  const readReplayEventCount = SqlSchema.findOne({
    Request: GetDevReviewReplayEventCountInput,
    Result: EventCountRow,
    execute: ({ reviewId }) => sql`
      SELECT COALESCE(SUM(event_count), 0) AS "eventCount"
      FROM dev_review_rrweb_event_chunks
      WHERE review_id = ${reviewId}
    `,
  });

  const appendEvents: DevReviewReplayEventRepositoryShape["appendEvents"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const { nextChunkIndex } = yield* readNextChunkIndex(input);
          const chunk = {
            reviewId: input.reviewId,
            chunkIndex: nextChunkIndex,
            events: input.events,
            eventCount: input.events.length,
            createdAt: input.createdAt,
          };
          yield* insertReplayEventChunk(chunk);
          return chunk;
        }),
      )
      .pipe(
        Effect.mapError(toPersistenceSqlError("DevReviewReplayEventRepository.appendEvents:query")),
      );

  const listByReviewId: DevReviewReplayEventRepositoryShape["listByReviewId"] = (input) =>
    listReplayEventChunks(input).pipe(
      Effect.mapError(toPersistenceSqlError("DevReviewReplayEventRepository.listByReviewId:query")),
    );

  const countByReviewId: DevReviewReplayEventRepositoryShape["countByReviewId"] = (input) =>
    readReplayEventCount(input).pipe(
      Effect.map((row) => row.eventCount),
      Effect.mapError(
        toPersistenceSqlError("DevReviewReplayEventRepository.countByReviewId:query"),
      ),
    );

  return {
    appendEvents,
    listByReviewId,
    countByReviewId,
  } satisfies DevReviewReplayEventRepositoryShape;
});

export const DevReviewReplayEventRepositoryLive = Layer.effect(
  DevReviewReplayEventRepository,
  makeDevReviewReplayEventRepository,
);
