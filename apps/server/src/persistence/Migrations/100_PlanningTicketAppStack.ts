import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // NULL means the ticket names no App Stack and runs its own app alone.
  yield* sql`ALTER TABLE projection_thread_planning_tickets ADD COLUMN app_stack_json TEXT`;
});
