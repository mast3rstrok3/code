import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_thread_loaded_prd_bundles (
      thread_id TEXT NOT NULL,
      prd_id TEXT NOT NULL,
      source_thread_id TEXT NOT NULL,
      loaded_at TEXT NOT NULL,
      PRIMARY KEY (thread_id, prd_id)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_loaded_prd_bundles_thread_loaded
    ON projection_thread_loaded_prd_bundles(thread_id, loaded_at)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_loaded_prd_bundles_prd
    ON projection_thread_loaded_prd_bundles(prd_id)
  `;
});
