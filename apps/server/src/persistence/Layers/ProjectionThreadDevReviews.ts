import { DevReviewDocument, DevReviewEvidence } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  DeleteProjectionThreadDevReviewsByThreadInput,
  GetProjectionThreadDevReviewInput,
  ListProjectionThreadDevReviewsByThreadInput,
  ProjectionThreadDevReview,
  ProjectionThreadDevReviewRepository,
  type ProjectionThreadDevReviewRepositoryShape,
} from "../Services/ProjectionThreadDevReviews.ts";

const ProjectionThreadDevReviewDbRow = ProjectionThreadDevReview.mapFields(
  Struct.assign({
    document: Schema.fromJsonString(DevReviewDocument),
    evidence: Schema.fromJsonString(DevReviewEvidence),
    planningTicketIds: Schema.fromJsonString(Schema.Array(Schema.String)),
  }),
);

const makeProjectionThreadDevReviewRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionThreadDevReviewRow = SqlSchema.void({
    Request: ProjectionThreadDevReview,
    execute: (row) => sql`
      INSERT INTO projection_thread_dev_reviews (
        review_id,
        source_thread_id,
        review_thread_id,
        planning_ticket_ids_json,
        source_turn_id,
        status,
        document_json,
        evidence_json,
        created_at,
        updated_at
      )
      VALUES (
        ${row.reviewId},
        ${row.sourceThreadId},
        ${row.reviewThreadId},
        ${JSON.stringify(row.planningTicketIds ?? [])},
        ${row.sourceTurnId},
        ${row.status},
        ${JSON.stringify(row.document)},
        ${JSON.stringify(row.evidence)},
        ${row.createdAt},
        ${row.updatedAt}
      )
      ON CONFLICT (review_id)
      DO UPDATE SET
        source_thread_id = excluded.source_thread_id,
        review_thread_id = excluded.review_thread_id,
        planning_ticket_ids_json = excluded.planning_ticket_ids_json,
        source_turn_id = excluded.source_turn_id,
        status = excluded.status,
        document_json = excluded.document_json,
        evidence_json = excluded.evidence_json,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `,
  });

  const getProjectionThreadDevReviewRow = SqlSchema.findOneOption({
    Request: GetProjectionThreadDevReviewInput,
    Result: ProjectionThreadDevReviewDbRow,
    execute: ({ reviewId }) => sql`
      SELECT
        review_id AS "reviewId",
        source_thread_id AS "sourceThreadId",
        review_thread_id AS "reviewThreadId",
        planning_ticket_ids_json AS "planningTicketIds",
        source_turn_id AS "sourceTurnId",
        status,
        document_json AS "document",
        evidence_json AS "evidence",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM projection_thread_dev_reviews
      WHERE review_id = ${reviewId}
      LIMIT 1
    `,
  });

  const listProjectionThreadDevReviewRowsByThread = SqlSchema.findAll({
    Request: ListProjectionThreadDevReviewsByThreadInput,
    Result: ProjectionThreadDevReviewDbRow,
    execute: ({ threadId }) => sql`
      SELECT
        review_id AS "reviewId",
        source_thread_id AS "sourceThreadId",
        review_thread_id AS "reviewThreadId",
        planning_ticket_ids_json AS "planningTicketIds",
        source_turn_id AS "sourceTurnId",
        status,
        document_json AS "document",
        evidence_json AS "evidence",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM projection_thread_dev_reviews
      WHERE source_thread_id = ${threadId}
         OR review_thread_id = ${threadId}
      ORDER BY created_at ASC, review_id ASC
    `,
  });

  const listProjectionThreadDevReviewRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadDevReviewDbRow,
    execute: () => sql`
      SELECT
        review_id AS "reviewId",
        source_thread_id AS "sourceThreadId",
        review_thread_id AS "reviewThreadId",
        planning_ticket_ids_json AS "planningTicketIds",
        source_turn_id AS "sourceTurnId",
        status,
        document_json AS "document",
        evidence_json AS "evidence",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM projection_thread_dev_reviews
      ORDER BY created_at ASC, review_id ASC
    `,
  });

  const deleteProjectionThreadDevReviewRowsByThread = SqlSchema.void({
    Request: DeleteProjectionThreadDevReviewsByThreadInput,
    execute: ({ threadId }) => sql`
      DELETE FROM projection_thread_dev_reviews
      WHERE source_thread_id = ${threadId}
         OR review_thread_id = ${threadId}
    `,
  });

  const upsert: ProjectionThreadDevReviewRepositoryShape["upsert"] = Effect.fn(
    "ProjectionThreadDevReviewRepository.upsert",
  )(function* (row) {
    yield* upsertProjectionThreadDevReviewRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadDevReviewRepository.upsert:query")),
    );
    yield* sql`DELETE FROM projection_dev_review_tickets WHERE review_id = ${row.reviewId}`.pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadDevReviewRepository.upsert:deleteTickets"),
      ),
    );
    yield* Effect.forEach(
      row.planningTicketIds ?? [],
      (ticketId) =>
        sql`
          INSERT OR IGNORE INTO projection_dev_review_tickets(review_id, ticket_id)
          VALUES (${row.reviewId}, ${ticketId})
        `.pipe(
          Effect.mapError(
            toPersistenceSqlError("ProjectionThreadDevReviewRepository.upsert:ticket"),
          ),
        ),
      { concurrency: 1 },
    ).pipe(Effect.asVoid);
  });

  const getById: ProjectionThreadDevReviewRepositoryShape["getById"] = (input) =>
    getProjectionThreadDevReviewRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadDevReviewRepository.getById:query")),
    );

  const listByThreadId: ProjectionThreadDevReviewRepositoryShape["listByThreadId"] = (input) =>
    listProjectionThreadDevReviewRowsByThread(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadDevReviewRepository.listByThreadId:query"),
      ),
    );

  const listAll: ProjectionThreadDevReviewRepositoryShape["listAll"] = () =>
    listProjectionThreadDevReviewRows(undefined).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadDevReviewRepository.listAll:query")),
    );

  const deleteByThreadId: ProjectionThreadDevReviewRepositoryShape["deleteByThreadId"] = Effect.fn(
    "ProjectionThreadDevReviewRepository.deleteByThreadId",
  )(function* (input) {
    yield* sql`
      DELETE FROM projection_dev_review_tickets
      WHERE review_id IN (
        SELECT review_id FROM projection_thread_dev_reviews
        WHERE source_thread_id = ${input.threadId} OR review_thread_id = ${input.threadId}
      )
    `.pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadDevReviewRepository.deleteByThreadId:links"),
      ),
    );
    yield* deleteProjectionThreadDevReviewRowsByThread(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadDevReviewRepository.deleteByThreadId:query"),
      ),
    );
  });

  return {
    upsert,
    getById,
    listByThreadId,
    listAll,
    deleteByThreadId,
  } satisfies ProjectionThreadDevReviewRepositoryShape;
});

export const ProjectionThreadDevReviewRepositoryLive = Layer.effect(
  ProjectionThreadDevReviewRepository,
  makeProjectionThreadDevReviewRepository,
);
