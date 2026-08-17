import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_thread_planning_tickets)
  `;

  if (!columns.some((column) => column.name === "app_review_eligible")) {
    yield* sql`
      ALTER TABLE projection_thread_planning_tickets
      ADD COLUMN app_review_eligible INTEGER NOT NULL DEFAULT 0
    `;
  }
  if (!columns.some((column) => column.name === "app_review_plan_markdown")) {
    yield* sql`
      ALTER TABLE projection_thread_planning_tickets
      ADD COLUMN app_review_plan_markdown TEXT
    `;
  }

  yield* sql`
    WITH ticket_metadata AS (
      SELECT
        json_extract(ticket.value, '$.id') AS ticket_id,
        json_extract(ticket.value, '$.appReviewEligible') AS app_review_eligible,
        json_extract(ticket.value, '$.appReviewPlanMarkdown') AS app_review_plan_markdown,
        row_number() OVER (
          PARTITION BY json_extract(ticket.value, '$.id')
          ORDER BY events.sequence DESC
        ) AS recency
      FROM orchestration_events AS events
      JOIN json_each(json_extract(events.payload_json, '$.tickets')) AS ticket
      WHERE events.event_type IN (
        'thread.planning-tickets-created',
        'thread.planning-tickets-revised'
      )
    )
    UPDATE projection_thread_planning_tickets
    SET
      app_review_eligible = coalesce((
        SELECT metadata.app_review_eligible
        FROM ticket_metadata AS metadata
        WHERE metadata.ticket_id = projection_thread_planning_tickets.ticket_id
          AND metadata.recency = 1
      ), 0),
      app_review_plan_markdown = (
        SELECT metadata.app_review_plan_markdown
        FROM ticket_metadata AS metadata
        WHERE metadata.ticket_id = projection_thread_planning_tickets.ticket_id
          AND metadata.recency = 1
      )
    WHERE EXISTS (
      SELECT 1
      FROM ticket_metadata AS metadata
      WHERE metadata.ticket_id = projection_thread_planning_tickets.ticket_id
        AND metadata.recency = 1
    )
  `;
});
