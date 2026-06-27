import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_implementation_runs (
      run_id TEXT PRIMARY KEY,
      prd_id TEXT NOT NULL,
      orchestrator_thread_id TEXT NOT NULL,
      source_thread_id TEXT NOT NULL,
      status TEXT NOT NULL,
      base_branch TEXT NOT NULL,
      pinned_commit TEXT NOT NULL,
      orchestrator_branch TEXT NOT NULL,
      orchestrator_worktree_path TEXT NOT NULL,
      launch_summary_json TEXT NOT NULL,
      issue_states_json TEXT NOT NULL,
      worker_results_json TEXT NOT NULL,
      terminal_lineage_issue_ids_json TEXT NOT NULL,
      final_validation_json TEXT,
      dev_review_ids_json TEXT NOT NULL,
      qa_attempt_count INTEGER NOT NULL,
      handoff_target TEXT NOT NULL,
      base_branch_merge_policy TEXT NOT NULL,
      run_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_implementation_runs_prd
    ON projection_implementation_runs(prd_id, created_at)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_implementation_runs_orchestrator_thread
    ON projection_implementation_runs(orchestrator_thread_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_implementation_runs_source_thread
    ON projection_implementation_runs(source_thread_id)
  `;
});
