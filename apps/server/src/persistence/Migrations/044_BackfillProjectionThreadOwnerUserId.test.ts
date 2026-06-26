import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { DEFAULT_WORKSPACE_USER_ID } from "@t3tools/contracts";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("044_BackfillProjectionThreadOwnerUserId", (it) => {
  it.effect(
    "backfills nullable owner ids when older deployment-line migrations already exist",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        yield* runMigrations({ toMigrationInclusive: 32 });

        yield* sql`
        ALTER TABLE projection_threads
        ADD COLUMN owner_user_id TEXT
      `;

        yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          owner_user_id,
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
          deleted_at
        )
        VALUES (
          'thread-null-owner',
          'project-1',
          NULL,
          'Thread null owner',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'full-access',
          'default',
          NULL,
          NULL,
          NULL,
          '2026-06-26T00:00:00.000Z',
          '2026-06-26T00:00:00.000Z',
          NULL,
          NULL,
          0,
          0,
          0,
          NULL
        )
      `;

        for (let migrationId = 33; migrationId <= 43; migrationId += 1) {
          yield* sql`
          INSERT INTO effect_sql_migrations (migration_id, name)
          VALUES (${migrationId}, ${`LegacyMigration${migrationId}`})
        `;
        }

        yield* runMigrations({ toMigrationInclusive: 44 });

        const threadRows = yield* sql<{ readonly ownerUserId: string | null }>`
        SELECT owner_user_id AS "ownerUserId"
        FROM projection_threads
        WHERE thread_id = 'thread-null-owner'
      `;
        assert.deepStrictEqual(threadRows, [{ ownerUserId: DEFAULT_WORKSPACE_USER_ID }]);

        const migrationRows = yield* sql<{ readonly migrationId: number; readonly name: string }>`
        SELECT migration_id AS "migrationId", name
        FROM effect_sql_migrations
        WHERE migration_id = 44
      `;
        assert.deepStrictEqual(migrationRows, [
          { migrationId: 44, name: "BackfillProjectionThreadOwnerUserId" },
        ]);
      }),
  );
});
