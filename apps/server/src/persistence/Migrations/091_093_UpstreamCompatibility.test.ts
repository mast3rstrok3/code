import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";

it.effect("upgrades a fork database at 90 without replacing workflow data", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 90 });
    yield* sql`
      INSERT INTO projection_threads (
        thread_id, project_id, parent_thread_id, title, model_selection_json,
        runtime_mode, interaction_mode, created_at, updated_at, workflow_step_models_json
      ) VALUES (
        'child', 'project', 'parent', 'Existing workflow', '{"instanceId":"codex","model":"gpt-5.4"}',
        'full-access', 'planning-workflow', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', '{}'
      )
    `;
    const executed = yield* runMigrations();
    assert.deepEqual(
      executed.map(([id]) => id),
      [91, 92, 93],
    );
    const rows = yield* sql`
      SELECT parent_thread_id, workflow_step_models_json, branch_pull_request_json, active_order_key
      FROM projection_threads WHERE thread_id = 'child'
    `;
    assert.deepEqual(rows, [
      {
        parent_thread_id: "parent",
        workflow_step_models_json: "{}",
        branch_pull_request_json: null,
        active_order_key: null,
      },
    ]);
    assert.deepEqual(yield* sql`SELECT * FROM projection_thread_pull_requests`, []);
    assert.deepEqual(yield* runMigrations(), []);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
