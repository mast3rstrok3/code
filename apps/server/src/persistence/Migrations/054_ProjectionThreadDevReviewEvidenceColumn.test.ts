import { assert, describe, it } from "@effect/vitest";
import {
  AppReviewEvidence,
  AppReviewId,
  EMPTY_APP_REVIEW_EVIDENCE,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ProjectionThreadAppReviewRepositoryLive } from "../Layers/ProjectionThreadAppReviews.ts";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { ProjectionThreadAppReviewRepository } from "../Services/ProjectionThreadAppReviews.ts";

const decodeAppReviewEvidenceJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(AppReviewEvidence),
);

const makeLayer = () => {
  const sqliteLayer = NodeSqliteClient.layerMemory();
  return Layer.mergeAll(
    sqliteLayer,
    ProjectionThreadAppReviewRepositoryLive.pipe(Layer.provideMerge(sqliteLayer)),
  );
};

describe("054 App Review evidence compatibility", () => {
  it.effect("adds evidence_json to legacy review projection tables", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const appReviews = yield* ProjectionThreadAppReviewRepository;

      yield* runMigrations({ toMigrationInclusive: 44 });

      yield* sql`
        CREATE TABLE projection_thread_dev_reviews (
          review_id TEXT PRIMARY KEY,
          source_thread_id TEXT NOT NULL,
          review_thread_id TEXT NOT NULL,
          source_turn_id TEXT,
          status TEXT NOT NULL,
          document_json TEXT NOT NULL,
          replay_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_thread_dev_reviews (
          review_id,
          source_thread_id,
          review_thread_id,
          source_turn_id,
          status,
          document_json,
          replay_json,
          created_at,
          updated_at
        )
        VALUES (
          'dev-review-legacy',
          'thread-source',
          'thread-review',
          NULL,
          'running',
          '{"verdict":"pending","summary":"","checks":[],"findings":[],"questions":[],"nextSteps":[]}',
          '{"status":"not-started","eventCount":0,"startedAt":null,"completedAt":null,"durationMs":null,"error":null}',
          '2026-07-02T00:00:00.000Z',
          '2026-07-02T00:00:00.000Z'
        )
      `;

      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (45, 'ProjectionThreadDevReviews')
      `;

      yield* runMigrations({ toMigrationInclusive: 54 });

      const columns = yield* sql<{ readonly name: string; readonly notnull: number }>`
        PRAGMA table_info(projection_thread_dev_reviews)
      `;
      assert.deepStrictEqual(
        columns
          .filter((column) => column.name === "evidence_json")
          .map((column) => ({ name: column.name, notnull: column.notnull })),
        [{ name: "evidence_json", notnull: 1 }],
      );
      assert.ok(columns.every((column) => column.name !== "replay_json"));

      const rawRows = yield* sql<{ readonly evidenceJson: string }>`
        SELECT evidence_json AS "evidenceJson"
        FROM projection_thread_dev_reviews
        WHERE review_id = 'dev-review-legacy'
      `;
      const decodedEvidence = yield* decodeAppReviewEvidenceJson(
        rawRows[0]?.evidenceJson ?? "null",
      );
      assert.deepStrictEqual(decodedEvidence, EMPTY_APP_REVIEW_EVIDENCE);

      // The current repository also reads workflow lineage added after this
      // migration; advance before exercising the repository contract.
      yield* runMigrations({ toMigrationInclusive: 84 });
      const persisted = yield* appReviews.getById({
        reviewId: AppReviewId.make("dev-review-legacy"),
      });
      assert.deepStrictEqual(Option.getOrNull(persisted)?.evidence, EMPTY_APP_REVIEW_EVIDENCE);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("is a no-op for fresh databases already created with evidence_json", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 54 });

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_thread_dev_reviews)
      `;
      assert.ok(columns.some((column) => column.name === "evidence_json"));

      yield* runMigrations({ toMigrationInclusive: 84 });
      const appReviews = yield* ProjectionThreadAppReviewRepository;
      yield* appReviews.upsert({
        reviewId: AppReviewId.make("app-review-fresh"),
        sourceThreadId: ThreadId.make("thread-source-fresh"),
        reviewThreadId: ThreadId.make("thread-review-fresh"),
        appReviewScope: null,
        sourceProposedPlan: null,
        sourceTurnId: null,
        status: "running",
        document: {
          verdict: "pending",
          summary: "",
          checks: [],
          findings: [],
          questions: [],
          nextSteps: [],
        },
        evidence: EMPTY_APP_REVIEW_EVIDENCE,
        createdAt: "2026-07-02T00:00:00.000Z",
        updatedAt: "2026-07-02T00:00:00.000Z",
      });

      const persisted = yield* appReviews.getById({
        reviewId: AppReviewId.make("app-review-fresh"),
      });
      assert.deepStrictEqual(Option.getOrNull(persisted)?.evidence, EMPTY_APP_REVIEW_EVIDENCE);
    }).pipe(Effect.provide(makeLayer())),
  );
});
