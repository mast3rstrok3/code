import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

describe("084_AppReviewScope", () => {
  it.effect("adds the effective scope to durable App Review records", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 83 });
      yield* runMigrations({ toMigrationInclusive: 84 });

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_thread_app_reviews)
      `;
      assert.isTrue(columns.some((column) => column.name === "app_review_scope"));
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );
});
