import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("085_086_ProjectionThreadCompatibility", (it) => {
  it.effect("applies skipped upstream thread migrations to databases already at 84", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 41 });
      for (let migrationId = 42; migrationId <= 84; migrationId += 1) {
        yield* sql`
          INSERT INTO effect_sql_migrations (migration_id, name)
          VALUES (${migrationId}, ${`ForkMigration${migrationId}`})
        `;
      }

      yield* runMigrations({ toMigrationInclusive: 86 });

      const threadColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      const threadColumnNames = new Set(threadColumns.map((column) => column.name));
      const migrations = yield* sql<{
        readonly migrationId: number;
        readonly name: string;
      }>`
        SELECT migration_id AS "migrationId", name
        FROM effect_sql_migrations
        WHERE migration_id IN (85, 86)
        ORDER BY migration_id
      `;

      assert.ok(threadColumnNames.has("linked_pull_request_json"));
      assert.ok(threadColumnNames.has("unsettled_at"));
      assert.deepStrictEqual(migrations, [
        { migrationId: 85, name: "ProjectionThreadLinkedPullRequestCompatibility" },
        { migrationId: 86, name: "ProjectionThreadsUnsettledAtCompatibility" },
      ]);
    }),
  );
});
