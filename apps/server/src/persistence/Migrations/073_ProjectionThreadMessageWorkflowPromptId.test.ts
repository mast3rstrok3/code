import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

describe("073_ProjectionThreadMessageWorkflowPromptId", () => {
  it.effect("backfills the workflow prompt associated with a historical user message", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 72 });
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, turn_id, role, text, attachments_json,
          is_streaming, created_at, updated_at
        ) VALUES (
          'message-1', 'thread-1', NULL, 'user', 'Plan this', NULL,
          0, '2026-08-17T00:00:00.000Z', '2026-08-17T00:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, actor_kind, payload_json, metadata_json
        ) VALUES (
          'event-1', 'thread', 'thread-1', 1, 'thread.turn-start-requested',
          '2026-08-17T00:00:01.000Z', 'user',
          '{"messageId":"message-1","workflowPromptId":"planning.spec.codex"}', '{}'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 73 });

      const rows = yield* sql<{ readonly workflowPromptId: string }>`
        SELECT workflow_prompt_id AS "workflowPromptId"
        FROM projection_thread_messages
        WHERE message_id = 'message-1'
      `;
      assert.equal(rows[0]?.workflowPromptId, "planning.spec.codex");
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );
});
