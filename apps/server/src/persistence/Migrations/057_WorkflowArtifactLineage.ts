import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const threadColumns = yield* sql<{
    readonly name: string;
  }>`PRAGMA table_info(projection_threads)`;
  const threadColumnNames = new Set(threadColumns.map((column) => column.name));
  if (!threadColumnNames.has("workflow_id")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN workflow_id TEXT`;
  }
  if (!threadColumnNames.has("workflow_root_thread_id")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN workflow_root_thread_id TEXT`;
  }
  if (!threadColumnNames.has("workflow_ticket_scope_json")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN workflow_ticket_scope_json TEXT NOT NULL DEFAULT '[]'`;
  }
  if (!threadColumnNames.has("planning_active_review_json")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN planning_active_review_json TEXT`;
  }

  const ticketColumns = yield* sql<{
    readonly name: string;
  }>`PRAGMA table_info(projection_thread_planning_tickets)`;
  if (!ticketColumns.some((column) => column.name === "ticket_key")) {
    yield* sql`ALTER TABLE projection_thread_planning_tickets ADD COLUMN ticket_key TEXT`;
  }
  yield* sql`
    UPDATE projection_thread_planning_tickets
    SET ticket_key = 'LEGACY-' || upper(replace(ticket_id, 'planning-ticket-', ''))
    WHERE ticket_key IS NULL OR trim(ticket_key) = ''
  `;

  const cycleColumns = yield* sql<{
    readonly name: string;
  }>`PRAGMA table_info(projection_thread_planning_review_cycles)`;
  const cycleColumnNames = new Set(cycleColumns.map((column) => column.name));
  if (!cycleColumnNames.has("review_mode")) {
    yield* sql`ALTER TABLE projection_thread_planning_review_cycles ADD COLUMN review_mode TEXT NOT NULL DEFAULT 'full'`;
  }
  if (!cycleColumnNames.has("target_planning_ticket_ids_json")) {
    yield* sql`ALTER TABLE projection_thread_planning_review_cycles ADD COLUMN target_planning_ticket_ids_json TEXT NOT NULL DEFAULT '[]'`;
  }
  if (!cycleColumnNames.has("edited_planning_ticket_ids_json")) {
    yield* sql`ALTER TABLE projection_thread_planning_review_cycles ADD COLUMN edited_planning_ticket_ids_json TEXT NOT NULL DEFAULT '[]'`;
  }

  const reviewColumns = yield* sql<{
    readonly name: string;
  }>`PRAGMA table_info(projection_thread_dev_reviews)`;
  if (!reviewColumns.some((column) => column.name === "planning_ticket_ids_json")) {
    yield* sql`ALTER TABLE projection_thread_dev_reviews ADD COLUMN planning_ticket_ids_json TEXT NOT NULL DEFAULT '[]'`;
  }

  // Loaded bundles are links, not ownership transfers. Repair rows written by
  // the pre-lineage projector before building normalized membership tables.
  yield* sql`
    UPDATE projection_thread_specs
    SET thread_id = source_thread_id
    WHERE thread_id <> source_thread_id
  `;
  yield* sql`
    UPDATE projection_thread_planning_tickets
    SET thread_id = (
      SELECT source_thread_id
      FROM projection_thread_specs
      WHERE projection_thread_specs.spec_id = projection_thread_planning_tickets.spec_id
    )
    WHERE EXISTS (
      SELECT 1 FROM projection_thread_specs
      WHERE projection_thread_specs.spec_id = projection_thread_planning_tickets.spec_id
    )
  `;
  // Loaded Spec bundles were historically projected by copying their review
  // cycles into the loading thread. Normalizing those copies back to the Spec
  // owner can make multiple rows collide on either of the table's identities:
  // (thread_id, reviewer_message_id) or (thread_id, cycle_number). Keep the
  // source-owned row when one exists, otherwise keep a deterministic copy.
  yield* sql`
    DELETE FROM projection_thread_planning_review_cycles
    WHERE rowid IN (
      SELECT rowid
      FROM (
        SELECT
          cycles.rowid,
          row_number() OVER (
            PARTITION BY
              COALESCE(specs.source_thread_id, cycles.thread_id),
              cycles.reviewer_message_id
            ORDER BY
              CASE WHEN cycles.thread_id = specs.source_thread_id THEN 0 ELSE 1 END,
              cycles.created_at,
              cycles.thread_id,
              cycles.cycle_number
          ) AS duplicate_rank
        FROM projection_thread_planning_review_cycles AS cycles
        LEFT JOIN projection_thread_specs AS specs ON specs.spec_id = cycles.spec_id
      ) AS ranked_cycles
      WHERE duplicate_rank > 1
    )
  `;
  yield* sql`
    DELETE FROM projection_thread_planning_review_cycles
    WHERE rowid IN (
      SELECT rowid
      FROM (
        SELECT
          cycles.rowid,
          row_number() OVER (
            PARTITION BY
              COALESCE(specs.source_thread_id, cycles.thread_id),
              cycles.cycle_number
            ORDER BY
              CASE WHEN cycles.thread_id = specs.source_thread_id THEN 0 ELSE 1 END,
              cycles.created_at,
              cycles.thread_id,
              cycles.reviewer_message_id
          ) AS duplicate_rank
        FROM projection_thread_planning_review_cycles AS cycles
        LEFT JOIN projection_thread_specs AS specs ON specs.spec_id = cycles.spec_id
      ) AS ranked_cycles
      WHERE duplicate_rank > 1
    )
  `;
  yield* sql`
    UPDATE projection_thread_planning_review_cycles
    SET thread_id = (
      SELECT source_thread_id
      FROM projection_thread_specs
      WHERE projection_thread_specs.spec_id = projection_thread_planning_review_cycles.spec_id
    )
    WHERE EXISTS (
      SELECT 1 FROM projection_thread_specs
      WHERE projection_thread_specs.spec_id = projection_thread_planning_review_cycles.spec_id
    )
  `;

  yield* sql`
    UPDATE projection_threads
    SET workflow_id = (
          SELECT workflow_id FROM projection_thread_specs
          WHERE source_thread_id = projection_threads.thread_id
          ORDER BY created_at DESC LIMIT 1
        ),
        workflow_root_thread_id = thread_id
    WHERE workflow_id IS NULL
      AND EXISTS (
        SELECT 1 FROM projection_thread_specs
        WHERE source_thread_id = projection_threads.thread_id
      )
  `;
  yield* sql`
    UPDATE projection_threads
    SET workflow_id = 'workflow-' || thread_id,
        workflow_root_thread_id = thread_id
    WHERE workflow_id IS NULL
      AND interaction_mode IN ('product-workflow', 'planning-workflow', 'implementation-workflow')
      AND parent_thread_id IS NULL
  `;
  yield* sql`
    WITH RECURSIVE lineage(thread_id, workflow_id, root_thread_id) AS (
      SELECT thread_id, workflow_id, workflow_root_thread_id
      FROM projection_threads
      WHERE workflow_id IS NOT NULL
      UNION ALL
      SELECT child.thread_id, lineage.workflow_id, lineage.root_thread_id
      FROM projection_threads AS child
      JOIN lineage ON child.parent_thread_id = lineage.thread_id
      WHERE child.workflow_id IS NULL
    )
    UPDATE projection_threads
    SET workflow_id = (
          SELECT workflow_id FROM lineage WHERE lineage.thread_id = projection_threads.thread_id LIMIT 1
        ),
        workflow_root_thread_id = (
          SELECT root_thread_id FROM lineage WHERE lineage.thread_id = projection_threads.thread_id LIMIT 1
        )
    WHERE workflow_id IS NULL
      AND EXISTS (SELECT 1 FROM lineage WHERE lineage.thread_id = projection_threads.thread_id)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_thread_workflow_membership (
      thread_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      workflow_id TEXT NOT NULL,
      root_thread_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_workflow_membership_workflow
    ON projection_thread_workflow_membership(project_id, workflow_id, created_at)
  `;
  yield* sql`
    INSERT OR REPLACE INTO projection_thread_workflow_membership (
      thread_id, project_id, workflow_id, root_thread_id, created_at, updated_at
    )
    SELECT thread_id, project_id, workflow_id, workflow_root_thread_id, created_at, updated_at
    FROM projection_threads
    WHERE workflow_id IS NOT NULL AND workflow_root_thread_id IS NOT NULL
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_thread_ticket_scope (
      thread_id TEXT NOT NULL,
      ticket_id TEXT NOT NULL,
      PRIMARY KEY (thread_id, ticket_id)
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_ticket_scope_ticket
    ON projection_thread_ticket_scope(ticket_id, thread_id)
  `;
  yield* sql`
    INSERT OR IGNORE INTO projection_thread_ticket_scope(thread_id, ticket_id)
    SELECT runs.orchestrator_thread_id, json_extract(ticket.value, '$.ticketId')
    FROM projection_implementation_runs AS runs, json_each(runs.ticket_states_json) AS ticket
    WHERE json_valid(runs.ticket_states_json)
      AND json_extract(ticket.value, '$.ticketId') IS NOT NULL
  `;
  yield* sql`
    INSERT OR IGNORE INTO projection_thread_ticket_scope(thread_id, ticket_id)
    SELECT json_extract(ticket.value, '$.workerThreadId'), json_extract(ticket.value, '$.ticketId')
    FROM projection_implementation_runs AS runs, json_each(runs.ticket_states_json) AS ticket
    WHERE json_valid(runs.ticket_states_json)
      AND json_extract(ticket.value, '$.workerThreadId') IS NOT NULL
      AND json_extract(ticket.value, '$.ticketId') IS NOT NULL
  `;
  yield* sql`
    WITH RECURSIVE descendants(thread_id, orchestrator_thread_id) AS (
      SELECT child.thread_id, runs.orchestrator_thread_id
      FROM projection_implementation_runs AS runs
      JOIN projection_threads AS child ON child.parent_thread_id = runs.orchestrator_thread_id
      WHERE child.workflow_role <> 'implementation-worker'
      UNION ALL
      SELECT child.thread_id, descendants.orchestrator_thread_id
      FROM projection_threads AS child
      JOIN descendants ON child.parent_thread_id = descendants.thread_id
    )
    INSERT OR IGNORE INTO projection_thread_ticket_scope(thread_id, ticket_id)
    SELECT descendants.thread_id, json_extract(ticket.value, '$.ticketId')
    FROM descendants
    JOIN projection_implementation_runs AS runs
      ON runs.orchestrator_thread_id = descendants.orchestrator_thread_id,
      json_each(runs.ticket_states_json) AS ticket
    WHERE json_valid(runs.ticket_states_json)
      AND json_extract(ticket.value, '$.ticketId') IS NOT NULL
  `;
  yield* sql`
    INSERT OR IGNORE INTO projection_thread_ticket_scope(thread_id, ticket_id)
    SELECT threads.thread_id, scope.value
    FROM projection_threads AS threads, json_each(threads.workflow_ticket_scope_json) AS scope
    WHERE json_valid(threads.workflow_ticket_scope_json)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_dev_review_tickets (
      review_id TEXT NOT NULL,
      ticket_id TEXT NOT NULL,
      PRIMARY KEY (review_id, ticket_id)
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_dev_review_tickets_ticket
    ON projection_dev_review_tickets(ticket_id, review_id)
  `;
  yield* sql`
    INSERT OR IGNORE INTO projection_dev_review_tickets(review_id, ticket_id)
    SELECT review_ids.value, ticket_ids.value
    FROM projection_implementation_runs AS runs,
         json_each(runs.dev_review_ids_json) AS review_ids,
         json_each(runs.launch_summary_json, '$.planningTicketIds') AS ticket_ids
    WHERE json_valid(runs.dev_review_ids_json) AND json_valid(runs.launch_summary_json)
  `;
  yield* sql`
    UPDATE projection_thread_dev_reviews
    SET planning_ticket_ids_json = COALESCE((
      SELECT json_group_array(ticket_id)
      FROM projection_dev_review_tickets
      WHERE review_id = projection_thread_dev_reviews.review_id
    ), '[]')
  `;
});
