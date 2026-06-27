import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_thread_planning_review_cycles (
      thread_id TEXT NOT NULL,
      prd_id TEXT NOT NULL,
      cycle_number INTEGER NOT NULL,
      status TEXT NOT NULL,
      reviewer_thread_id TEXT NOT NULL,
      reviewer_message_id TEXT NOT NULL,
      verdict_markdown TEXT NOT NULL,
      failing_planning_issue_ids_json TEXT NOT NULL,
      dependency_feedback_json TEXT NOT NULL,
      per_issue_feedback_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (thread_id, cycle_number)
    )
  `;

  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_projection_thread_planning_review_cycles_message
    ON projection_thread_planning_review_cycles(reviewer_message_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_planning_review_cycles_prd
    ON projection_thread_planning_review_cycles(prd_id, cycle_number)
  `;
});
