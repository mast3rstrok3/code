import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // NULL means the ticket changes its workflow's own project.
  yield* sql`ALTER TABLE projection_thread_planning_tickets ADD COLUMN project_id TEXT`;
});
