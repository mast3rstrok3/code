import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** The workflow a scheduled task's fresh thread starts as; null starts a plain thread. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE scheduled_tasks ADD COLUMN workflow TEXT`;
});
