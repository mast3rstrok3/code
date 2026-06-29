import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { DEFAULT_WORKSPACE_USER_ID } from "@t3tools/contracts";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("052_RenameYoloWorkflowToProductWorkflow", (it) => {
  it.effect("backfills projected YOLO Workflow interaction modes", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 51 });

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          owner_user_id,
          parent_thread_id,
          workflow_role,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          created_at,
          updated_at,
          archived_at,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          planning_workflow_stage,
          deleted_at
        )
        VALUES (
          'thread-yolo-workflow',
          'project-1',
          ${DEFAULT_WORKSPACE_USER_ID},
          NULL,
          NULL,
          'Legacy YOLO Workflow',
          '{"instanceId":"codex","model":"gpt-5-codex"}',
          'full-access',
          'yolo-workflow',
          NULL,
          NULL,
          NULL,
          '2026-06-28T00:00:00.000Z',
          '2026-06-28T00:00:00.000Z',
          NULL,
          NULL,
          0,
          0,
          0,
          NULL,
          NULL
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 52 });

      const rows = yield* sql<{ readonly interactionMode: string }>`
        SELECT interaction_mode AS "interactionMode"
        FROM projection_threads
        WHERE thread_id = 'thread-yolo-workflow'
      `;
      assert.deepStrictEqual(rows, [{ interactionMode: "product-workflow" }]);
    }),
  );
});
