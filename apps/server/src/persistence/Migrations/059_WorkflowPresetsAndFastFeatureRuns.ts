import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE projection_threads ADD COLUMN workflow_preset TEXT`;

  yield* sql`
    CREATE TABLE projection_implementation_runs_next (
      run_id TEXT PRIMARY KEY,
      spec_id TEXT,
      artifact_source TEXT NOT NULL DEFAULT 'planning-spec',
      proposed_plan_source_thread_id TEXT,
      proposed_plan_id TEXT,
      orchestrator_thread_id TEXT NOT NULL,
      source_thread_id TEXT NOT NULL,
      status TEXT NOT NULL,
      base_branch TEXT NOT NULL,
      pinned_commit TEXT NOT NULL,
      orchestrator_branch TEXT NOT NULL,
      orchestrator_worktree_path TEXT NOT NULL,
      launch_summary_json TEXT NOT NULL,
      ticket_states_json TEXT NOT NULL,
      worker_results_json TEXT NOT NULL,
      terminal_lineage_ticket_ids_json TEXT NOT NULL,
      final_validation_json TEXT,
      dev_review_ids_json TEXT NOT NULL,
      qa_attempt_count INTEGER NOT NULL,
      handoff_target TEXT NOT NULL,
      base_branch_merge_policy TEXT NOT NULL,
      run_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (
        (artifact_source = 'planning-spec' AND spec_id IS NOT NULL
          AND proposed_plan_source_thread_id IS NULL AND proposed_plan_id IS NULL)
        OR
        (artifact_source = 'proposed-plan' AND spec_id IS NULL
          AND proposed_plan_source_thread_id IS NOT NULL AND proposed_plan_id IS NOT NULL)
      )
    )
  `;

  yield* sql`
    INSERT INTO projection_implementation_runs_next (
      run_id, spec_id, artifact_source, proposed_plan_source_thread_id, proposed_plan_id,
      orchestrator_thread_id, source_thread_id, status, base_branch, pinned_commit,
      orchestrator_branch, orchestrator_worktree_path, launch_summary_json,
      ticket_states_json, worker_results_json, terminal_lineage_ticket_ids_json,
      final_validation_json, dev_review_ids_json, qa_attempt_count, handoff_target,
      base_branch_merge_policy, run_json, created_at, updated_at
    )
    SELECT
      run_id, spec_id, 'planning-spec', NULL, NULL, orchestrator_thread_id, source_thread_id,
      status, base_branch, pinned_commit, orchestrator_branch, orchestrator_worktree_path,
      launch_summary_json, ticket_states_json, worker_results_json,
      terminal_lineage_ticket_ids_json, final_validation_json, dev_review_ids_json,
      qa_attempt_count, handoff_target, base_branch_merge_policy, run_json, created_at, updated_at
    FROM projection_implementation_runs
  `;

  yield* sql`DROP TABLE projection_implementation_runs`;
  yield* sql`ALTER TABLE projection_implementation_runs_next RENAME TO projection_implementation_runs`;

  yield* sql`
    CREATE INDEX idx_projection_implementation_runs_spec
    ON projection_implementation_runs(spec_id, created_at)
  `;
  yield* sql`
    CREATE INDEX idx_projection_implementation_runs_orchestrator_thread
    ON projection_implementation_runs(orchestrator_thread_id)
  `;
  yield* sql`
    CREATE INDEX idx_projection_implementation_runs_source_thread
    ON projection_implementation_runs(source_thread_id)
  `;
  yield* sql`
    CREATE INDEX idx_projection_implementation_runs_proposed_plan_source
    ON projection_implementation_runs(proposed_plan_source_thread_id, proposed_plan_id, created_at)
  `;
});
