import { AppReviewDocument, AppReviewEvidence } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import { toPersistenceSqlError } from "../Errors.ts";
import {
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
  }),
);

// Workflow-era columns (planning tickets, proposed plan) keep their defaults on new rows.
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
        source_turn_id AS "sourceTurnId",
        status,
        document_json AS "document",
        evidence_json AS "evidence",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM projection_thread_app_reviews
      WHERE source_thread_id = ${threadId}
         OR review_thread_id = ${threadId}
      ORDER BY created_at ASC, rowid ASC
    `,
  });

  const upsert: ProjectionThreadAppReviewRepositoryShape["upsert"] = (row) =>
    upsertProjectionThreadAppReviewRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadAppReviewRepository.upsert:query")),
    );

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

  return { upsert, getById, listByThreadId } satisfies ProjectionThreadAppReviewRepositoryShape;
});

export const ProjectionThreadAppReviewRepositoryLive = Layer.effect(
  ProjectionThreadAppReviewRepository,
  makeProjectionThreadAppReviewRepository,
);
