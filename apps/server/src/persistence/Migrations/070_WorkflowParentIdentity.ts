import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const threadColumns = yield* sql<{
    readonly name: string;
  }>`PRAGMA table_info(projection_threads)`;
  if (!threadColumns.some((column) => column.name === "workflow_parent_id")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN workflow_parent_id TEXT`;
  }

  const membershipColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_thread_workflow_membership)
  `;
  if (!membershipColumns.some((column) => column.name === "parent_workflow_id")) {
    yield* sql`
      ALTER TABLE projection_thread_workflow_membership
      ADD COLUMN parent_workflow_id TEXT
    `;
  }

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_workflow_membership_parent
    ON projection_thread_workflow_membership(project_id, parent_workflow_id, created_at)
  `;
});
