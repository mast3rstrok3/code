import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN owner_user_id TEXT NOT NULL DEFAULT 'nils'
  `;

  yield* sql`
    UPDATE projection_threads
    SET owner_user_id = 'nils'
    WHERE owner_user_id IS NULL OR owner_user_id = ''
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_threads_shell_active_by_owner
    ON projection_threads(owner_user_id, deleted_at, archived_at, project_id, created_at, thread_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_threads_shell_archived_by_owner
    ON projection_threads(owner_user_id, deleted_at, archived_at, project_id, archived_at, thread_id)
  `;
});
