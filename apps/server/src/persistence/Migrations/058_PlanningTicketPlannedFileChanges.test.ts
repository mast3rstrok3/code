import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

describe("058_PlanningTicketPlannedFileChanges", () => {
  it.effect("adds a non-null planned-file column and backfills legacy tickets", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 57 });
      yield* sql`
        INSERT INTO projection_thread_planning_tickets (
          ticket_id, ticket_key, spec_id, thread_id, ordinal, title, body_markdown,
          dependencies_json, status, created_at, updated_at
        ) VALUES (
          'planning-ticket-legacy', 'TICKET-1', 'planning-spec-1', 'thread-1', 1,
          'Legacy ticket', 'Legacy body', '[]', 'open',
          '2026-07-19T00:00:00.000Z', '2026-07-19T00:00:00.000Z'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 58 });

      const columns = yield* sql<{
        readonly name: string;
        readonly notnull: number;
        readonly defaultValue: string | null;
      }>`
        SELECT name, "notnull", dflt_value AS "defaultValue"
        FROM pragma_table_info('projection_thread_planning_tickets')
        WHERE name = 'planned_file_changes_json'
      `;
      assert.deepStrictEqual(columns, [
        { name: "planned_file_changes_json", notnull: 1, defaultValue: "'[]'" },
      ]);

      const rows = yield* sql<{ readonly plannedFileChanges: string }>`
        SELECT planned_file_changes_json AS "plannedFileChanges"
        FROM projection_thread_planning_tickets
        WHERE ticket_id = 'planning-ticket-legacy'
      `;
      assert.deepStrictEqual(rows, [{ plannedFileChanges: "[]" }]);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );

  it.effect("is safe when the column already exists", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 58 });
      const columns = yield* sql<{ readonly count: number }>`
        SELECT count(*) AS count
        FROM pragma_table_info('projection_thread_planning_tickets')
        WHERE name = 'planned_file_changes_json'
      `;
      assert.deepStrictEqual(columns, [{ count: 1 }]);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );
});
