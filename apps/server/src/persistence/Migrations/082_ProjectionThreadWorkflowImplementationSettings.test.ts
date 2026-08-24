import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

describe("082_ProjectionThreadWorkflowImplementationSettings", () => {
  it.effect("adds nullable run settings without changing existing threads", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 81 });
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, parent_thread_id, title, model_selection_json,
          runtime_mode, interaction_mode, branch, worktree_path, latest_turn_id,
          created_at, updated_at, pending_approval_count, pending_user_input_count,
          has_actionable_proposed_plan
        ) VALUES (
          'thread-1', 'project-1', NULL, 'Existing run', '{"instanceId":"codex","model":"gpt-5.4"}',
          'full-access', 'planning-workflow', NULL, NULL, NULL,
          '2026-08-24T00:00:00.000Z', '2026-08-24T00:00:00.000Z', 0, 0, 0
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 82 });

      const rows = yield* sql<{ readonly settings: string | null }>`
        SELECT workflow_implementation_settings_json AS settings
        FROM projection_threads
        WHERE thread_id = 'thread-1'
      `;
      assert.deepStrictEqual(rows, [{ settings: null }]);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );
});
