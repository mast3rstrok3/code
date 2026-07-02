import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

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

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_dev_reviews_source_created
    ON projection_thread_dev_reviews(source_thread_id, created_at)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_dev_reviews_review_created
    ON projection_thread_dev_reviews(review_thread_id, created_at)
  `;
});
