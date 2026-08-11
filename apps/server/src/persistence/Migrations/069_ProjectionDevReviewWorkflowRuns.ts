import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_dev_review_workflow_runs (
      run_id TEXT PRIMARY KEY,
      target_thread_id TEXT NOT NULL,
      controller_thread_id TEXT NOT NULL,
      caller_type TEXT NOT NULL,
      caller_thread_id TEXT NOT NULL,
      implementation_run_id TEXT,
      status TEXT NOT NULL,
      run_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_dev_review_workflow_runs_target
    ON projection_dev_review_workflow_runs(target_thread_id, created_at)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_dev_review_workflow_runs_controller
    ON projection_dev_review_workflow_runs(controller_thread_id, created_at)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_dev_review_workflow_runs_caller
    ON projection_dev_review_workflow_runs(caller_type, caller_thread_id, created_at)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_dev_review_workflow_runs_implementation
    ON projection_dev_review_workflow_runs(implementation_run_id, created_at)
  `;
});
