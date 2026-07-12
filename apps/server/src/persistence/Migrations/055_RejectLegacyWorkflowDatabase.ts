import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export const LEGACY_WORKFLOW_DATABASE_RESET_MESSAGE =
  "Legacy workflow database detected. Stop T3 Code, then delete state.sqlite, state.sqlite-wal, and state.sqlite-shm from the configured state directory (~/.t3/dev/ for development or <T3CODE_HOME>/userdata/ for production/desktop) and restart. This reset deletes projects, conversations, workflow artifacts, and other database-backed state; settings, credentials, logs, and attachments outside SQLite are not deleted.";

export class LegacyWorkflowDatabaseError extends Schema.TaggedErrorClass<LegacyWorkflowDatabaseError>()(
  "LegacyWorkflowDatabaseError",
  {
    message: Schema.String,
    tables: Schema.Array(Schema.String),
  },
) {}

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql<{ readonly name: string }>`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name IN (
        'projection_thread_prds',
        'projection_thread_planning_issues',
        'projection_thread_loaded_prd_bundles'
      )
  `;

  if (tables.length > 0) {
    const names = tables.map((table) => table.name).sort();
    return yield* new LegacyWorkflowDatabaseError({
      message: `${LEGACY_WORKFLOW_DATABASE_RESET_MESSAGE} Found: ${names.join(", ")}.`,
      tables: names,
    });
  }
});
