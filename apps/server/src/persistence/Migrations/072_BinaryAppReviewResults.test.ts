import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

describe("072_BinaryAppReviewResults", () => {
  it.effect("normalizes historical blocked and canceled workflow results to failed", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 71 });

      const runJson =
        '{"status":"blocked","outcome":"blocked","cycles":[{"status":"blocked","reviewVerdict":"blocked"}]}';
      yield* sql`
        INSERT INTO projection_app_review_workflow_runs (
          run_id, target_thread_id, controller_thread_id, caller_type, caller_thread_id,
          implementation_run_id, status, run_json, created_at, updated_at
        ) VALUES (
          'run-blocked', 'thread-target', 'thread-controller', 'standalone', 'thread-source',
          NULL, 'blocked', ${runJson}, '2026-08-16T00:00:00.000Z', '2026-08-16T00:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, actor_kind, payload_json, metadata_json
        ) VALUES (
          'event-canceled', 'thread', 'thread-controller', 1,
          'thread.app-review-workflow-cancel-requested', '2026-08-16T00:00:00.000Z', 'server',
          '{"run":{"status":"canceled","outcome":"canceled","cycles":[{"status":"blocked","reviewVerdict":"blocked"}]}}',
          '{}'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 72 });

      const runs = yield* sql<{
        readonly status: string;
        readonly outcome: string;
        readonly cycleStatus: string;
        readonly reviewVerdict: string;
      }>`
        SELECT
          json_extract(run_json, '$.status') AS status,
          json_extract(run_json, '$.outcome') AS outcome,
          json_extract(run_json, '$.cycles[#-1].status') AS "cycleStatus",
          json_extract(run_json, '$.cycles[#-1].reviewVerdict') AS "reviewVerdict"
        FROM projection_app_review_workflow_runs
        WHERE run_id = 'run-blocked'
      `;
      assert.deepStrictEqual(runs[0], {
        status: "failed",
        outcome: "failed",
        cycleStatus: "completed",
        reviewVerdict: "failed",
      });

      const events = yield* sql<{
        readonly status: string;
        readonly outcome: string;
        readonly cycleStatus: string;
        readonly reviewVerdict: string;
      }>`
        SELECT
          json_extract(payload_json, '$.run.status') AS status,
          json_extract(payload_json, '$.run.outcome') AS outcome,
          json_extract(payload_json, '$.run.cycles[#-1].status') AS "cycleStatus",
          json_extract(payload_json, '$.run.cycles[#-1].reviewVerdict') AS "reviewVerdict"
        FROM orchestration_events
        WHERE event_id = 'event-canceled'
      `;
      assert.deepStrictEqual(events[0], {
        status: "failed",
        outcome: "failed",
        cycleStatus: "completed",
        reviewVerdict: "failed",
      });
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );
});
