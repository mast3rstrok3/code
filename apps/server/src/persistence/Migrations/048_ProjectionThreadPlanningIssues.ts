import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_thread_planning_issues (
      issue_id TEXT PRIMARY KEY,
      prd_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      title TEXT NOT NULL,
      body_markdown TEXT NOT NULL,
      dependencies_json TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_planning_issues_thread_order
    ON projection_thread_planning_issues(thread_id, ordinal, created_at)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_planning_issues_prd_order
    ON projection_thread_planning_issues(prd_id, ordinal, created_at)
  `;
});
