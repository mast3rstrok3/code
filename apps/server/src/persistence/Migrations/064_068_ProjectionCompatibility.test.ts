import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("064_068_ProjectionCompatibility", (it) => {
  it.effect("applies skipped upstream projection migrations to databases already at 63", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 35 });
      for (let migrationId = 36; migrationId <= 63; migrationId += 1) {
        yield* sql`
          INSERT INTO effect_sql_migrations (migration_id, name)
          VALUES (${migrationId}, ${`ForkMigration${migrationId}`})
        `;
      }

      yield* runMigrations({ toMigrationInclusive: 68 });

      const threadColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      const projectColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_projects)
      `;
      const turnIndexes = yield* sql<{ readonly name: string }>`
        PRAGMA index_list(projection_turns)
      `;
      const threadColumnNames = new Set(threadColumns.map((column) => column.name));
      const projectColumnNames = new Set(projectColumns.map((column) => column.name));

      assert.ok(threadColumnNames.has("pinned_at"));
      assert.ok(threadColumnNames.has("pin_order_key"));
      assert.ok(projectColumnNames.has("default_thread_env_mode"));
      assert.ok(projectColumnNames.has("favicon_path"));
      assert.ok(turnIndexes.some((index) => index.name === "idx_projection_turns_thread_keyset"));
    }),
  );
});
