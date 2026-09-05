import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

describe("074_PlanningTicketAppReviewMetadata", () => {
  it.effect("restores the latest App Review instructions from planning events", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 73 });
      yield* sql`
        INSERT INTO projection_thread_planning_tickets (
          ticket_id, ticket_key, spec_id, thread_id, ordinal, title, body_markdown,
          planned_file_changes_json, dependencies_json, status, created_at, updated_at
        ) VALUES (
          'ticket-1', 'TICKET-1', 'spec-1', 'thread-1', 0, 'Ticket', 'Body',
          '[]', '[]', 'open', '2026-08-17T00:00:00.000Z', '2026-08-17T00:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, actor_kind, payload_json, metadata_json
        ) VALUES
          (
            'event-1', 'thread', 'thread-1', 1, 'thread.planning-tickets-created',
            '2026-08-17T00:00:00.000Z', 'system',
            '{"tickets":[{"id":"ticket-1","appReviewEligible":false,"appReviewPlanMarkdown":null}]}', '{}'
          ),
          (
            'event-2', 'thread', 'thread-1', 2, 'thread.planning-tickets-revised',
            '2026-08-17T00:01:00.000Z', 'system',
            '{"tickets":[{"id":"ticket-1","appReviewEligible":true,"appReviewPlanMarkdown":"Review the ticket UI"}]}', '{}'
          )
      `;

      yield* runMigrations({ toMigrationInclusive: 74 });

      const rows = yield* sql<{
        readonly eligible: number;
        readonly plan: string | null;
      }>`
        SELECT
          app_review_eligible AS eligible,
          app_review_plan_markdown AS plan
        FROM projection_thread_planning_tickets
        WHERE ticket_id = 'ticket-1'
      `;
      assert.deepStrictEqual(rows, [{ eligible: 1, plan: "Review the ticket UI" }]);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );
});
