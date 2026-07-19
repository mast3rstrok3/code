import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

describe("059_WorkflowPresetsAndFastFeatureRuns", () => {
  it.effect("preserves legacy runs and permits proposed-plan runs without a Spec", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 58 });
      yield* sql`
        INSERT INTO projection_implementation_runs (
          run_id, spec_id, orchestrator_thread_id, source_thread_id, status,
          base_branch, pinned_commit, orchestrator_branch, orchestrator_worktree_path,
          launch_summary_json, ticket_states_json, worker_results_json,
          terminal_lineage_ticket_ids_json, final_validation_json, dev_review_ids_json,
          qa_attempt_count, handoff_target, base_branch_merge_policy, run_json,
          created_at, updated_at
        ) VALUES (
          'legacy-run', 'planning-spec-1', 'orchestrator-1', 'source-1', 'running',
          'main', 'abc123', 'implementation/legacy', '/tmp/legacy',
          '{}', '[]', '[]', '[]', NULL, '[]', 0,
          'orchestrator-worktree', 'never-auto-merge', '{}',
          '2026-07-19T00:00:00.000Z', '2026-07-19T00:00:00.000Z'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 59 });

      const threadColumns = yield* sql<{ readonly name: string }>`
        SELECT name FROM pragma_table_info('projection_threads')
        WHERE name = 'workflow_preset'
      `;
      assert.deepStrictEqual(threadColumns, [{ name: "workflow_preset" }]);

      const legacy = yield* sql<{
        readonly specId: string | null;
        readonly artifactSource: string;
      }>`
        SELECT spec_id AS "specId", artifact_source AS "artifactSource"
        FROM projection_implementation_runs WHERE run_id = 'legacy-run'
      `;
      assert.deepStrictEqual(legacy, [
        { specId: "planning-spec-1", artifactSource: "planning-spec" },
      ]);

      yield* sql`
        INSERT INTO projection_implementation_runs (
          run_id, spec_id, artifact_source, proposed_plan_source_thread_id, proposed_plan_id,
          orchestrator_thread_id, source_thread_id, status, base_branch, pinned_commit,
          orchestrator_branch, orchestrator_worktree_path, launch_summary_json,
          ticket_states_json, worker_results_json, terminal_lineage_ticket_ids_json,
          final_validation_json, dev_review_ids_json, qa_attempt_count, handoff_target,
          base_branch_merge_policy, run_json, created_at, updated_at
        ) VALUES (
          'fast-run', NULL, 'proposed-plan', 'source-2', 'plan-2',
          'orchestrator-2', 'source-2', 'launch-pending', 'main', 'def456',
          'fast-feature/example', '/tmp/fast', '{}', '[]', '[]', '[]', NULL, '[]', 0,
          'orchestrator-worktree', 'never-auto-merge', '{}',
          '2026-07-19T00:00:01.000Z', '2026-07-19T00:00:01.000Z'
        )
      `;
      const proposed = yield* sql<{
        readonly specId: string | null;
        readonly sourceThreadId: string | null;
        readonly planId: string | null;
      }>`
        SELECT spec_id AS "specId",
               proposed_plan_source_thread_id AS "sourceThreadId",
               proposed_plan_id AS "planId"
        FROM projection_implementation_runs WHERE run_id = 'fast-run'
      `;
      assert.deepStrictEqual(proposed, [
        { specId: null, sourceThreadId: "source-2", planId: "plan-2" },
      ]);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );
});
