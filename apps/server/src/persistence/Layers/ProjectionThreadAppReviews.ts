import {
  AppReviewDocument,
  AppReviewEvidence,
  AppReviewSourceProposedPlan,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  DeleteProjectionThreadAppReviewsByThreadInput,
  GetProjectionThreadAppReviewInput,
  ListProjectionThreadAppReviewsByThreadInput,
  ProjectionThreadAppReview,
  ProjectionThreadAppReviewRepository,
  type ProjectionThreadAppReviewRepositoryShape,
} from "../Services/ProjectionThreadAppReviews.ts";

const ProjectionThreadAppReviewDbRow = ProjectionThreadAppReview.mapFields(
  Struct.assign({
    document: Schema.fromJsonString(AppReviewDocument),
    evidence: Schema.fromJsonString(AppReviewEvidence),
    planningTicketIds: Schema.fromJsonString(Schema.Array(Schema.String)),
    sourceProposedPlan: Schema.NullOr(Schema.fromJsonString(AppReviewSourceProposedPlan)),
  }),
);

const makeProjectionThreadAppReviewRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionThreadAppReviewRow = SqlSchema.void({
    Request: ProjectionThreadAppReview,
    execute: (row) => sql`
      INSERT INTO projection_thread_app_reviews (
        review_id,
        source_thread_id,
        review_thread_id,
        app_review_scope,
        planning_ticket_ids_json,
        source_proposed_plan_json,
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
        ${row.appReviewScope},
        ${JSON.stringify(row.planningTicketIds ?? [])},
        ${row.sourceProposedPlan === null ? null : JSON.stringify(row.sourceProposedPlan)},
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
        app_review_scope = excluded.app_review_scope,
        planning_ticket_ids_json = excluded.planning_ticket_ids_json,
        source_proposed_plan_json = excluded.source_proposed_plan_json,
        source_turn_id = excluded.source_turn_id,
        status = excluded.status,
        document_json = excluded.document_json,
        evidence_json = excluded.evidence_json,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `,
  });

  const getProjectionThreadAppReviewRow = SqlSchema.findOneOption({
    Request: GetProjectionThreadAppReviewInput,
    Result: ProjectionThreadAppReviewDbRow,
    execute: ({ reviewId }) => sql`
      SELECT
        review_id AS "reviewId",
        source_thread_id AS "sourceThreadId",
        review_thread_id AS "reviewThreadId",
        app_review_scope AS "appReviewScope",
        planning_ticket_ids_json AS "planningTicketIds",
        source_proposed_plan_json AS "sourceProposedPlan",
        source_turn_id AS "sourceTurnId",
        status,
        document_json AS "document",
        evidence_json AS "evidence",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM projection_thread_app_reviews
      WHERE review_id = ${reviewId}
      LIMIT 1
    `,
  });

  const listProjectionThreadAppReviewRowsByThread = SqlSchema.findAll({
    Request: ListProjectionThreadAppReviewsByThreadInput,
    Result: ProjectionThreadAppReviewDbRow,
    execute: ({ threadId }) => sql`
      SELECT
        review_id AS "reviewId",
        source_thread_id AS "sourceThreadId",
        review_thread_id AS "reviewThreadId",
        app_review_scope AS "appReviewScope",
        planning_ticket_ids_json AS "planningTicketIds",
        source_proposed_plan_json AS "sourceProposedPlan",
        source_turn_id AS "sourceTurnId",
        status,
        document_json AS "document",
        evidence_json AS "evidence",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM projection_thread_app_reviews
      WHERE source_thread_id = ${threadId}
         OR review_thread_id = ${threadId}
      ORDER BY created_at ASC, review_id ASC
    `,
  });

  const listProjectionThreadAppReviewRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadAppReviewDbRow,
    execute: () => sql`
      SELECT
        review_id AS "reviewId",
        source_thread_id AS "sourceThreadId",
        review_thread_id AS "reviewThreadId",
        app_review_scope AS "appReviewScope",
        planning_ticket_ids_json AS "planningTicketIds",
        source_proposed_plan_json AS "sourceProposedPlan",
        source_turn_id AS "sourceTurnId",
        status,
        document_json AS "document",
        evidence_json AS "evidence",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM projection_thread_app_reviews
      ORDER BY created_at ASC, review_id ASC
    `,
  });

  const deleteProjectionThreadAppReviewRowsByThread = SqlSchema.void({
    Request: DeleteProjectionThreadAppReviewsByThreadInput,
    execute: ({ threadId }) => sql`
      DELETE FROM projection_thread_app_reviews
      WHERE source_thread_id = ${threadId}
         OR review_thread_id = ${threadId}
    `,
  });

  const upsert: ProjectionThreadAppReviewRepositoryShape["upsert"] = Effect.fn(
    "ProjectionThreadAppReviewRepository.upsert",
  )(function* (row) {
    yield* upsertProjectionThreadAppReviewRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadAppReviewRepository.upsert:query")),
    );
    yield* sql`DELETE FROM projection_app_review_tickets WHERE review_id = ${row.reviewId}`.pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadAppReviewRepository.upsert:deleteTickets"),
      ),
    );
    yield* Effect.forEach(
      row.planningTicketIds ?? [],
      (ticketId) =>
        sql`
          INSERT OR IGNORE INTO projection_app_review_tickets(review_id, ticket_id)
          VALUES (${row.reviewId}, ${ticketId})
        `.pipe(
          Effect.mapError(
            toPersistenceSqlError("ProjectionThreadAppReviewRepository.upsert:ticket"),
          ),
        ),
      { concurrency: 1 },
    ).pipe(Effect.asVoid);
  });

  const getById: ProjectionThreadAppReviewRepositoryShape["getById"] = (input) =>
    getProjectionThreadAppReviewRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadAppReviewRepository.getById:query")),
    );

  const listByThreadId: ProjectionThreadAppReviewRepositoryShape["listByThreadId"] = (input) =>
    listProjectionThreadAppReviewRowsByThread(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadAppReviewRepository.listByThreadId:query"),
      ),
    );

  const listAll: ProjectionThreadAppReviewRepositoryShape["listAll"] = () =>
    listProjectionThreadAppReviewRows(undefined).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadAppReviewRepository.listAll:query")),
    );

  const deleteByThreadId: ProjectionThreadAppReviewRepositoryShape["deleteByThreadId"] = Effect.fn(
    "ProjectionThreadAppReviewRepository.deleteByThreadId",
  )(function* (input) {
    yield* sql`
      DELETE FROM projection_app_review_tickets
      WHERE review_id IN (
        SELECT review_id FROM projection_thread_app_reviews
        WHERE source_thread_id = ${input.threadId} OR review_thread_id = ${input.threadId}
      )
    `.pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadAppReviewRepository.deleteByThreadId:links"),
      ),
    );
    yield* deleteProjectionThreadAppReviewRowsByThread(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadAppReviewRepository.deleteByThreadId:query"),
      ),
    );
  });

  return {
    upsert,
    getById,
    listByThreadId,
    listAll,
    deleteByThreadId,
  } satisfies ProjectionThreadAppReviewRepositoryShape;
});

export const ProjectionThreadAppReviewRepositoryLive = Layer.effect(
  ProjectionThreadAppReviewRepository,
  makeProjectionThreadAppReviewRepository,
);
