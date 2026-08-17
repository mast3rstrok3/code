import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Associates rendered user messages with the workflow instructions that produced their turn. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE projection_thread_messages ADD COLUMN workflow_prompt_id TEXT`;
  yield* sql`
    UPDATE projection_thread_messages
    SET workflow_prompt_id = (
      SELECT json_extract(events.payload_json, '$.workflowPromptId')
      FROM orchestration_events AS events
      WHERE events.event_type = 'thread.turn-start-requested'
        AND json_extract(events.payload_json, '$.messageId') = projection_thread_messages.message_id
        AND json_extract(events.payload_json, '$.workflowPromptId') IS NOT NULL
      ORDER BY events.occurred_at DESC
      LIMIT 1
    )
    WHERE role = 'user'
  `;
});
