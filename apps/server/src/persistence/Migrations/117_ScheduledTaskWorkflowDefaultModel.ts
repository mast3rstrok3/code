import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Whether a workflow task's runs start on the workflow's default model; existing tasks keep theirs. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE scheduled_tasks ADD COLUMN use_workflow_default_model INTEGER NOT NULL DEFAULT 0`;
});
