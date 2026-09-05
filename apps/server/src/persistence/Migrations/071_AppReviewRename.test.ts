import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

describe("071_AppReviewRename", () => {
  it.effect("renames persisted review schema and event vocabulary", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 70 });

      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, actor_kind, payload_json, metadata_json
        ) VALUES (
          'event-app-review-rename', 'thread', 'thread-app-review', 1,
          'thread.dev-review-created', '2026-08-16T00:00:00.000Z', 'server',
          '{"devReview":{"id":"review-existing"},"kind":"dev-review-workflow-run-upserted","role":"dev-review-reviewer","preset":"implementation-dev-review","commandType":"thread.dev-review.update","workflowPromptId":"implementation.browser-dev-review.codex","attemptsUsed":2}',
          '{"devReviewId":"review-existing"}'
        )
      `;
      yield* sql`
        INSERT INTO projection_dev_review_workflow_runs (
          run_id, target_thread_id, controller_thread_id, caller_type, caller_thread_id,
          implementation_run_id, status, run_json, created_at, updated_at
        ) VALUES (
          'run-existing', 'thread-target', 'thread-controller', 'standalone', 'thread-source',
          NULL, 'running', '{"attemptsUsed":2,"devReviewId":"review-existing"}',
          '2026-08-16T00:00:00.000Z', '2026-08-16T00:00:00.000Z'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 71 });

      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name IN (
          'projection_thread_app_reviews',
          'projection_app_review_tickets',
          'projection_app_review_workflow_runs'
        )
        ORDER BY name
      `;
      assert.deepStrictEqual(
        tables.map((row) => row.name),
        [
          "projection_app_review_tickets",
          "projection_app_review_workflow_runs",
          "projection_thread_app_reviews",
        ],
      );

      const implementationColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_implementation_runs)
      `;
      const subagentColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_thread_workflow_subagent_batch_children)
      `;
      assert.ok(implementationColumns.some((column) => column.name === "app_review_ids_json"));
      assert.ok(implementationColumns.every((column) => column.name !== "dev_review_ids_json"));
      assert.ok(subagentColumns.some((column) => column.name === "app_review_mode"));
      assert.ok(subagentColumns.some((column) => column.name === "app_review_id"));

      const events = yield* sql<{
        readonly eventType: string;
        readonly payloadJson: string;
        readonly metadataJson: string;
      }>`
        SELECT
          event_type AS "eventType",
          payload_json AS "payloadJson",
          metadata_json AS "metadataJson"
        FROM orchestration_events
        WHERE event_id = 'event-app-review-rename'
      `;
      assert.deepStrictEqual(events, [
        {
          eventType: "thread.app-review-created",
          payloadJson:
            '{"appReview":{"id":"review-existing"},"kind":"app-review-workflow-run-upserted","role":"app-review-reviewer","preset":"implementation-app-review","commandType":"thread.app-review.update","workflowPromptId":"implementation.browser-app-review.codex","cyclesUsed":2}',
          metadataJson: '{"appReviewId":"review-existing"}',
        },
      ]);

      const runs = yield* sql<{ readonly runJson: string }>`
        SELECT run_json AS "runJson"
        FROM projection_app_review_workflow_runs
        WHERE run_id = 'run-existing'
      `;
      assert.deepStrictEqual(runs, [
        { runJson: '{"cyclesUsed":2,"appReviewId":"review-existing"}' },
      ]);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );
});
