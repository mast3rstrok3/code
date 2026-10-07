import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";

it.effect("upgrades a fork database without mixing workflow and native event histories", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 101 });
    yield* sql`
      INSERT INTO orchestration_events
      (sequence, event_id, aggregate_kind, stream_id, stream_version, event_type,
       occurred_at, actor_kind, payload_json, metadata_json)
      VALUES (41, 'workflow:event', 'thread', 'thread', 1, 'thread.created',
              '2026-10-07T00:00:00.000Z', 'system', '{}', '{}')
    `;
    yield* sql`
      INSERT INTO orchestration_command_receipts
      (command_id, aggregate_kind, aggregate_id, accepted_at, result_sequence, status, result_json)
      VALUES ('workflow:command', 'thread', 'thread', '2026-10-07T00:00:00.000Z', 41, 'accepted', '{}')
    `;
    yield* runMigrations();
    const workflow = yield* sql<{ readonly sequence: number; readonly event_id: string }>`
      SELECT sequence, event_id FROM workflow_events
    `;
    assert.deepStrictEqual(workflow, [{ sequence: 41, event_id: "workflow:event" }]);
    const receipts = yield* sql<{ readonly result_sequence: number; readonly result_json: string }>`
      SELECT result_sequence, result_json FROM workflow_command_receipts
    `;
    assert.deepStrictEqual(receipts, [{ result_sequence: 41, result_json: "{}" }]);
    const history = yield* sql<{ readonly migration_id: number; readonly name: string }>`
      SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id IN (55, 102, 106)
      ORDER BY migration_id
    `;
    assert.deepStrictEqual(history, [
      { migration_id: 55, name: "RejectLegacyWorkflowDatabase" },
      { migration_id: 102, name: "OrchestrationV2" },
      { migration_id: 106, name: "WorkflowEventHistory" },
    ]);
    yield* sql`
      INSERT INTO orchestration_events
      (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
       actor_kind, payload_json, metadata_json, application_event_version)
      VALUES ('native:event', 'thread', 'thread', 2, 'thread.created',
              '2026-10-07T00:00:00.000Z', 'system', '{}', '{}', 2)
    `;
    const count = yield* sql<{
      readonly count: number;
    }>`SELECT COUNT(*) AS count FROM workflow_events`;
    assert.strictEqual(count[0]?.count, 1);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("creates both histories on a fresh database", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations();
    const rows = yield* sql<{ readonly name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'table'
        AND name IN ('workflow_events', 'orchestration_v2_projection_threads') ORDER BY name
    `;
    assert.deepStrictEqual(
      rows.map((row) => row.name),
      ["orchestration_v2_projection_threads", "workflow_events"],
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
