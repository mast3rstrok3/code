import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("070_WorkflowParentIdentity", (it) => {
  it.effect("persists parent workflow identity on threads and memberships", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 70 });

      const threadColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      const membershipColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_thread_workflow_membership)
      `;
      const indexes = yield* sql<{ readonly name: string }>`
        PRAGMA index_list(projection_thread_workflow_membership)
      `;

      assert.ok(threadColumns.some((column) => column.name === "workflow_parent_id"));
      assert.ok(membershipColumns.some((column) => column.name === "parent_workflow_id"));
      assert.ok(indexes.some((index) => index.name.endsWith("_parent")));
    }),
  );
});
