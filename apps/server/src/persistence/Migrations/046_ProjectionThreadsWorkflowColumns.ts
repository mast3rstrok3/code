import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_threads)`;
  const names = new Set(columns.map((column) => column.name));

  if (!names.has("parent_thread_id")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN parent_thread_id TEXT`;
  }
  if (!names.has("workflow_role")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN workflow_role TEXT`;
  }
  if (!names.has("planning_workflow_stage")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN planning_workflow_stage TEXT`;
  }

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_threads_parent_workflow
    ON projection_threads(parent_thread_id, workflow_role, created_at)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_threads_planning_workflow_stage
    ON projection_threads(planning_workflow_stage, updated_at)
  `;
});
