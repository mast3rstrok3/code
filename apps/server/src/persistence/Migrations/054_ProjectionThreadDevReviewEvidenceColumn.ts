import { EMPTY_DEV_REVIEW_EVIDENCE } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const EMPTY_EVIDENCE_JSON = JSON.stringify(EMPTY_DEV_REVIEW_EVIDENCE);
const sqlStringLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`;

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_thread_dev_reviews)
  `;
  const names = new Set(columns.map((column) => column.name));
  const emptyEvidenceLiteral = sqlStringLiteral(EMPTY_EVIDENCE_JSON);

  if (columns.length === 0) {
    yield* sql`
      CREATE TABLE IF NOT EXISTS projection_thread_dev_reviews (
        review_id TEXT PRIMARY KEY,
        source_thread_id TEXT NOT NULL,
        review_thread_id TEXT NOT NULL,
        source_turn_id TEXT,
        status TEXT NOT NULL,
        document_json TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `;
  } else if (names.has("replay_json") || !names.has("evidence_json")) {
    yield* sql`DROP TABLE IF EXISTS projection_thread_dev_reviews_next`;

    yield* sql`
      CREATE TABLE projection_thread_dev_reviews_next (
        review_id TEXT PRIMARY KEY,
        source_thread_id TEXT NOT NULL,
        review_thread_id TEXT NOT NULL,
        source_turn_id TEXT,
        status TEXT NOT NULL,
        document_json TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `;

    const evidenceExpression = names.has("evidence_json")
      ? `COALESCE(evidence_json, ${emptyEvidenceLiteral})`
      : emptyEvidenceLiteral;
    yield* sql.unsafe(`
      INSERT INTO projection_thread_dev_reviews_next (
        review_id,
        source_thread_id,
        review_thread_id,
        source_turn_id,
        status,
        document_json,
        evidence_json,
        created_at,
        updated_at
      )
      SELECT
        review_id,
        source_thread_id,
        review_thread_id,
        source_turn_id,
        status,
        document_json,
        ${evidenceExpression},
        created_at,
        updated_at
      FROM projection_thread_dev_reviews
    `);

    yield* sql`DROP TABLE projection_thread_dev_reviews`;
    yield* sql`ALTER TABLE projection_thread_dev_reviews_next RENAME TO projection_thread_dev_reviews`;
  }

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_dev_reviews_source_created
    ON projection_thread_dev_reviews(source_thread_id, created_at)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_dev_reviews_review_created
    ON projection_thread_dev_reviews(review_thread_id, created_at)
  `;
});
