import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

describe("057_WorkflowArtifactLineage", () => {
  it.effect("deduplicates loaded planning review cycles before restoring source ownership", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 56 });

      yield* sql`
        INSERT INTO projection_thread_specs (
          spec_id, thread_id, title, summary_markdown, tenant_id, team_id,
          source_thread_id, source_message_ids_json, created_by, workflow_id,
          ticket_count, created_at, updated_at
        ) VALUES (
          'spec-1', 'thread-implementation', 'Spec', '', NULL, NULL,
          'thread-planning', '[]', NULL, 'workflow-1', 0,
          '2026-07-18T17:00:00.000Z', '2026-07-18T17:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO projection_thread_planning_review_cycles (
          thread_id, spec_id, cycle_number, status, reviewer_thread_id,
          reviewer_message_id, verdict_markdown, failing_planning_ticket_ids_json,
          dependency_feedback_json, per_ticket_feedback_json, created_at
        ) VALUES
          (
            'thread-planning', 'spec-1', 1, 'passed', 'thread-reviewer',
            'assistant:review-1', 'Passed', '[]', '[]', '[]',
            '2026-07-18T17:30:00.000Z'
          ),
          (
            'thread-implementation', 'spec-1', 1, 'passed', 'thread-reviewer',
            'assistant:review-1', 'Passed', '[]', '[]', '[]',
            '2026-07-18T17:30:00.000Z'
          )
      `;

      yield* runMigrations({ toMigrationInclusive: 57 });

      const rows = yield* sql<{
        readonly threadId: string;
        readonly cycleNumber: number;
        readonly reviewerMessageId: string;
      }>`
        SELECT
          thread_id AS "threadId",
          cycle_number AS "cycleNumber",
          reviewer_message_id AS "reviewerMessageId"
        FROM projection_thread_planning_review_cycles
      `;
      assert.deepStrictEqual(rows, [
        {
          threadId: "thread-planning",
          cycleNumber: 1,
          reviewerMessageId: "assistant:review-1",
        },
      ]);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );
});
