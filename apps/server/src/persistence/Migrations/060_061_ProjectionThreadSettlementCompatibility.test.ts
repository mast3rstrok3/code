import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("060_061_ProjectionThreadSettlementCompatibility", (it) => {
  it.effect("adds upstream settlement columns to fork databases already migrated through 59", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 32 });
      yield* sql`
        ALTER TABLE projection_threads
        ADD COLUMN owner_user_id TEXT NOT NULL DEFAULT 'nils'
      `;

      for (let migrationId = 33; migrationId <= 59; migrationId += 1) {
        yield* sql`
          INSERT INTO effect_sql_migrations (migration_id, name)
          VALUES (${migrationId}, ${`ForkMigration${migrationId}`})
        `;
      }

      const columnsBefore = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      assert.ok(columnsBefore.every((column) => column.name !== "settled_override"));
      assert.ok(columnsBefore.every((column) => column.name !== "snoozed_until"));

      yield* runMigrations({ toMigrationInclusive: 61 });

      const columnsAfter = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      const columnNames = new Set(columnsAfter.map((column) => column.name));
      assert.ok(columnNames.has("settled_override"));
      assert.ok(columnNames.has("settled_at"));
      assert.ok(columnNames.has("snoozed_until"));
      assert.ok(columnNames.has("snoozed_at"));

      const migrationRows = yield* sql<{ readonly migrationId: number; readonly name: string }>`
        SELECT migration_id AS "migrationId", name
        FROM effect_sql_migrations
        WHERE migration_id IN (60, 61)
        ORDER BY migration_id
      `;
      assert.deepStrictEqual(migrationRows, [
        { migrationId: 60, name: "ProjectionThreadsSettledCompatibility" },
        { migrationId: 61, name: "ProjectionThreadsSnoozedCompatibility" },
      ]);
    }),
  );
});
