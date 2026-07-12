import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { runMigrations } from "../Migrations.ts";
import RejectLegacyWorkflowDatabase, {
  LEGACY_WORKFLOW_DATABASE_RESET_MESSAGE,
} from "./055_RejectLegacyWorkflowDatabase.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("055_RejectLegacyWorkflowDatabase", (it) => {
  it.effect("creates only canonical Spec and Ticket workflow tables", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();

      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name LIKE 'projection_thread_%'
      `;
      const names = new Set(tables.map((table) => table.name));
      assert.isTrue(names.has("projection_thread_specs"));
      assert.isTrue(names.has("projection_thread_planning_tickets"));
      assert.isTrue(names.has("projection_thread_loaded_spec_bundles"));
      assert.isFalse(names.has("projection_thread_prds"));
      assert.isFalse(names.has("projection_thread_planning_issues"));
      assert.isFalse(names.has("projection_thread_loaded_prd_bundles"));
    }),
  );

  it.effect("accepts a fresh database and rejects legacy workflow tables", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* RejectLegacyWorkflowDatabase;
      yield* sql`CREATE TABLE projection_thread_prds (prd_id TEXT PRIMARY KEY)`;
      yield* sql`CREATE TABLE projection_thread_planning_issues (issue_id TEXT PRIMARY KEY)`;
      yield* sql`CREATE TABLE projection_thread_loaded_prd_bundles (prd_id TEXT PRIMARY KEY)`;

      const error = yield* RejectLegacyWorkflowDatabase.pipe(Effect.flip);
      assert.include(error.message, LEGACY_WORKFLOW_DATABASE_RESET_MESSAGE);
      if (error._tag === "LegacyWorkflowDatabaseError") {
        assert.deepStrictEqual(error.tables, [
          "projection_thread_loaded_prd_bundles",
          "projection_thread_planning_issues",
          "projection_thread_prds",
        ]);
      }
    }),
  );
});
