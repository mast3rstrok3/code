import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Workflow decisions replay V1 records. Keep them apart from V2 application events.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE workflow_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      aggregate_kind TEXT NOT NULL,
      stream_id TEXT NOT NULL,
      stream_version INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      command_id TEXT,
      causation_event_id TEXT,
      correlation_id TEXT,
      actor_kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      metadata_json TEXT NOT NULL
    )
  `;
  yield* sql`
    INSERT INTO workflow_events
    SELECT sequence, event_id, aggregate_kind, stream_id, stream_version, event_type,
           occurred_at, command_id, causation_event_id, correlation_id, actor_kind,
           payload_json, metadata_json
    FROM orchestration_events WHERE application_event_version = 1
  `;
  yield* sql`CREATE UNIQUE INDEX workflow_events_stream_version ON workflow_events(aggregate_kind, stream_id, stream_version)`;
  yield* sql`CREATE INDEX workflow_events_stream_sequence ON workflow_events(aggregate_kind, stream_id, sequence)`;
  yield* sql`CREATE INDEX workflow_events_command ON workflow_events(command_id)`;
  yield* sql`CREATE TABLE workflow_runtime_deliveries (id TEXT PRIMARY KEY)`;
  yield* sql`CREATE TABLE workflow_runtime_cursor (id INTEGER PRIMARY KEY CHECK (id = 1), sequence INTEGER NOT NULL)`;
  yield* sql`INSERT INTO workflow_runtime_cursor VALUES (1, 0)`;
  yield* sql`CREATE TABLE workflow_control_cursor (id INTEGER PRIMARY KEY CHECK (id = 1), sequence INTEGER NOT NULL)`;
  yield* sql`INSERT INTO workflow_control_cursor SELECT 1, COALESCE(MAX(sequence), 0) FROM workflow_events`;
  yield* sql`
    CREATE TABLE workflow_command_receipts (
      command_id TEXT PRIMARY KEY,
      aggregate_kind TEXT NOT NULL,
      aggregate_id TEXT NOT NULL,
      accepted_at TEXT NOT NULL,
      result_sequence INTEGER NOT NULL,
      status TEXT NOT NULL,
      error TEXT,
      result_json TEXT
    )
  `;
  yield* sql`
    INSERT INTO workflow_command_receipts
    SELECT command_id, aggregate_kind, aggregate_id, accepted_at, result_sequence,
           status, error, result_json
    FROM orchestration_command_receipts WHERE command_type = 'legacy'
  `;
});
