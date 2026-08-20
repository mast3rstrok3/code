import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

describe("078_ProjectionThreadWorkflowStepCycles", () => {
  it.effect("adds a nullable cycle budget column that existing threads read as unset", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 77 });
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, parent_thread_id, title, model_selection_json,
          runtime_mode, interaction_mode, branch, worktree_path, latest_turn_id,
          created_at, updated_at, pending_approval_count, pending_user_input_count,
          has_actionable_proposed_plan
        ) VALUES (
          'thread-1', 'project-1', NULL, 'Existing run', '{"instanceId":"codex","model":"gpt-5.4"}',
          'full-access', 'planning-workflow', NULL, NULL, NULL,
          '2026-08-20T00:00:00.000Z', '2026-08-20T00:00:00.000Z', 0, 0, 0
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 78 });

      const rows = yield* sql<{ readonly workflowStepCycles: string | null }>`
        SELECT workflow_step_cycles_json AS "workflowStepCycles"
        FROM projection_threads
        WHERE thread_id = 'thread-1'
      `;
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.workflowStepCycles, null);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );
});
