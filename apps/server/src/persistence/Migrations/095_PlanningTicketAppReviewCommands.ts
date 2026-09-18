import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE projection_thread_planning_tickets
    ADD COLUMN app_review_commands_json TEXT NOT NULL DEFAULT '[]'`;
});
