import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const threadColumns = yield* sql<{
    readonly name: string;
  }>`PRAGMA table_info(projection_threads)`;
  const threadColumnNames = new Set(threadColumns.map((column) => column.name));
  if (!threadColumnNames.has("workflow_step_cycles_json")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN workflow_step_cycles_json TEXT`;
  }
});
