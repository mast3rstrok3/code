import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Quick Feature (`quick-plan`) merged into Feature (`fast-plan`) and Quick
 * Engineering (`fast-engineering`) into Engineering (`planning`). Rewrites the
 * stored IDs so projections, replayed events and native thread payloads only
 * carry presets the app still offers. The contract keeps decoding the retired
 * IDs for older servers and clients.
 */
const JSON_COLUMNS = [
  ["orchestration_events", "payload_json"],
  ["workflow_events", "payload_json"],
  ["orchestration_v2_events", "payload_json"],
  ["orchestration_v2_projection_threads", "payload_json"],
] as const;

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    UPDATE projection_threads
    SET workflow_preset = CASE workflow_preset
      WHEN 'quick-plan' THEN 'fast-plan'
      ELSE 'planning'
    END
    WHERE workflow_preset IN ('quick-plan', 'fast-engineering')
  `;

  for (const [table, column] of JSON_COLUMNS) {
    yield* sql.unsafe(`
      UPDATE ${table}
      SET ${column} = replace(
        replace(${column}, '"workflowPreset":"quick-plan"', '"workflowPreset":"fast-plan"'),
        '"workflowPreset":"fast-engineering"',
        '"workflowPreset":"planning"'
      )
      WHERE ${column} LIKE '%"workflowPreset":"quick-plan"%'
         OR ${column} LIKE '%"workflowPreset":"fast-engineering"%'
    `);
  }
});
