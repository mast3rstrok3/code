import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_thread_prds (
      prd_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      title TEXT NOT NULL,
      summary_markdown TEXT NOT NULL,
      tenant_id TEXT,
      team_id TEXT,
      source_thread_id TEXT NOT NULL,
      source_message_ids_json TEXT NOT NULL,
      created_by TEXT,
      workflow_id TEXT NOT NULL,
      issue_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_prds_thread_created
    ON projection_thread_prds(thread_id, created_at)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_prds_workflow
    ON projection_thread_prds(workflow_id)
  `;
});
