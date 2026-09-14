import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("051_ProjectionThreadMessageContext", (it) => {
  it.effect("accepts context added by an earlier development migration", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 93 });
      yield* sql`
        ALTER TABLE projection_thread_messages
        ADD COLUMN context_json TEXT
      `;

      yield* runMigrations({ toMigrationInclusive: 94 });

      const columns = yield* sql<{ readonly name: string; readonly notnull: number }>`
        PRAGMA table_info(projection_thread_messages)
      `;
      const context = columns.find((column) => column.name === "context_json");
      const migrations = yield* sql<{ readonly migration_id: number }>`
        SELECT migration_id
        FROM effect_sql_migrations
        WHERE migration_id = 94
      `;

      assert.equal(context?.name, "context_json");
      assert.equal(context?.notnull, 0);
      assert.equal(migrations.length, 1);
    }),
  );
});

it.effect("adds message context after fork migration 93 and preserves workflow prompts", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 93 });
    yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, role, text, workflow_prompt_id, is_streaming, created_at, updated_at
        ) VALUES (
          'message', 'thread', 'user', 'Continue', 'implementation.tdd.codex', 0,
          '2026-09-14T00:00:00.000Z', '2026-09-14T00:00:00.000Z'
        )
      `;
    const executed = yield* runMigrations();
    assert.deepEqual(
      executed.map(([id]) => id),
      [94],
    );
    const rows = yield* sql`
        SELECT text, workflow_prompt_id, context_json
        FROM projection_thread_messages WHERE message_id = 'message'
      `;
    assert.deepEqual(rows, [
      {
        text: "Continue",
        workflow_prompt_id: "implementation.tdd.codex",
        context_json: null,
      },
    ]);
    assert.deepEqual(yield* runMigrations(), []);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
