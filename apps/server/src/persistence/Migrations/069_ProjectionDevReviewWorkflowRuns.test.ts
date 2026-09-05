import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("069_ProjectionDevReviewWorkflowRuns", (it) => {
  it.effect("creates the canonical run table and lookup indexes on a fresh database", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 69 });

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_dev_review_workflow_runs)
      `;
      const indexes = yield* sql<{ readonly name: string }>`
        PRAGMA index_list(projection_dev_review_workflow_runs)
      `;
      const columnNames = new Set(columns.map((column) => column.name));
      assert.ok(columnNames.has("run_id"));
      assert.ok(columnNames.has("run_json"));
      assert.ok(columnNames.has("target_thread_id"));
      assert.ok(columnNames.has("controller_thread_id"));
      assert.ok(indexes.some((index) => index.name.endsWith("_target")));
      assert.ok(indexes.some((index) => index.name.endsWith("_controller")));
      assert.ok(indexes.some((index) => index.name.endsWith("_caller")));
    }),
  );

  it.effect("upgrades a database already migrated through 68", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 68 });
      yield* runMigrations({ toMigrationInclusive: 69 });
      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = 'projection_dev_review_workflow_runs'
      `;
      assert.strictEqual(tables.length, 1);
    }),
  );
});
