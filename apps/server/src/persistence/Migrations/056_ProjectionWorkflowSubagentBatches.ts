import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const threadColumns = yield* sql<{
    readonly name: string;
  }>`PRAGMA table_info(projection_threads)`;
  const threadColumnNames = new Set(threadColumns.map((column) => column.name));
  if (!threadColumnNames.has("workflow_subagent_batch_id")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN workflow_subagent_batch_id TEXT`;
  }
  if (!threadColumnNames.has("workflow_subagent_child_index")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN workflow_subagent_child_index INTEGER`;
  }

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_thread_workflow_subagent_batches (
      batch_id TEXT PRIMARY KEY NOT NULL,
      parent_thread_id TEXT NOT NULL,
      source_assistant_message_id TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      completed_at TEXT
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_thread_workflow_subagent_batch_children (
      batch_id TEXT NOT NULL,
      child_index INTEGER NOT NULL,
      workflow_prompt_id TEXT NOT NULL,
      title TEXT NOT NULL,
      expected_result TEXT NOT NULL,
      dev_review_mode TEXT,
      child_thread_id TEXT,
      dev_review_id TEXT,
      status TEXT NOT NULL,
      result_markdown TEXT,
      failure_detail TEXT,
      created_at TEXT NOT NULL,
      completed_at TEXT,
      PRIMARY KEY (batch_id, child_index)
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_workflow_subagent_batches_parent
    ON projection_thread_workflow_subagent_batches(parent_thread_id, created_at, batch_id)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_workflow_subagent_children_batch
    ON projection_thread_workflow_subagent_batch_children(batch_id, child_index)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_workflow_subagent_children_thread
    ON projection_thread_workflow_subagent_batch_children(child_thread_id)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_workflow_subagent_children_review
    ON projection_thread_workflow_subagent_batch_children(dev_review_id)
  `;
});
