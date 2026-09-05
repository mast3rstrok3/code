import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

describe("076_ProjectionThreadWorkflowPause", () => {
  it.effect("adds a nullable pause column that existing threads read as running", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 75 });
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, parent_thread_id, title, model_selection_json,
          runtime_mode, interaction_mode, branch, worktree_path, latest_turn_id,
          created_at, updated_at, settled_override, settled_at,
          pending_approval_count, pending_user_input_count, has_actionable_proposed_plan
        ) VALUES (
          'thread-1', 'project-1', NULL, 'Settled run', '{"instanceId":"codex","model":"gpt-5.4"}',
          'full-access', 'planning-workflow', NULL, NULL, NULL,
          '2026-08-19T00:00:00.000Z', '2026-08-19T00:00:00.000Z', 'settled', '2026-08-19T00:00:00.000Z',
          0, 0, 0
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 76 });

      // A settled thread is not a paused one. Threads settle on their own when
      // their work goes quiet, so reading the old column as a pause would
      // freeze runs nobody stopped.
      const rows = yield* sql<{ readonly workflowPausedAt: string | null }>`
        SELECT workflow_paused_at AS "workflowPausedAt"
        FROM projection_threads
        WHERE thread_id = 'thread-1'
      `;
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.workflowPausedAt, null);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );
});
