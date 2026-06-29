import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    DROP INDEX IF EXISTS idx_projection_thread_planning_review_cycles_message
  `;

  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_projection_thread_planning_review_cycles_thread_message
    ON projection_thread_planning_review_cycles(thread_id, reviewer_message_id)
  `;
});
