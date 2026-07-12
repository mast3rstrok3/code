import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_thread_loaded_spec_bundles (
      thread_id TEXT NOT NULL,
      spec_id TEXT NOT NULL,
      source_thread_id TEXT NOT NULL,
      loaded_at TEXT NOT NULL,
      PRIMARY KEY (thread_id, spec_id)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_loaded_spec_bundles_thread_loaded
    ON projection_thread_loaded_spec_bundles(thread_id, loaded_at)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_loaded_spec_bundles_spec
    ON projection_thread_loaded_spec_bundles(spec_id)
  `;
});
