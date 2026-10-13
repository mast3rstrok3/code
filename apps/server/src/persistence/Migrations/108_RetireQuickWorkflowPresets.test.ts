import { assert, describe, it } from "@effect/vitest";
import type { OrchestrationEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { createEmptyReadModel, projectEvent } from "../../orchestration/projector.ts";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const at = "2026-10-01T00:00:00.000Z";

const threadCreated = (threadId: string, workflowPreset: string) =>
  JSON.stringify({
    threadId,
    projectId: "project-1",
    ownerUserId: "user-1",
    title: threadId,
    modelSelection: { instanceId: "codex", model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "plan",
    workflowPreset,
    branch: null,
    worktreePath: null,
    createdAt: at,
    updatedAt: at,
  });

const composerModeSet = (threadId: string, workflowPreset: string) =>
  JSON.stringify({ threadId, interactionMode: "plan", workflowPreset, updatedAt: at });

interface EventRow {
  readonly sequence: number;
  readonly eventId: string;
  readonly aggregateKind: string;
  readonly streamId: string;
  readonly streamVersion: number;
  readonly eventType: string;
  readonly occurredAt: string;
  readonly commandId: string | null;
  readonly actorKind: string;
  readonly payloadJson: string;
  readonly metadataJson: string;
}

describe("108_RetireQuickWorkflowPresets", () => {
  it.effect("rewrites retired presets in projections and stored events, which replay", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 107 });

      for (const [threadId, preset] of [
        ["quick", "quick-plan"],
        ["engineering", "fast-engineering"],
        ["feature", "fast-plan"],
      ] as const) {
        yield* sql`
          INSERT INTO projection_threads (
            thread_id, project_id, parent_thread_id, title, model_selection_json,
            runtime_mode, interaction_mode, branch, worktree_path, latest_turn_id,
            created_at, updated_at, pending_approval_count, pending_user_input_count,
            has_actionable_proposed_plan, workflow_preset
          ) VALUES (
            ${threadId}, 'project-1', NULL, ${threadId}, '{"instanceId":"codex","model":"gpt-5.4"}',
            'full-access', 'plan', NULL, NULL, NULL, ${at}, ${at}, 0, 0, 0, ${preset}
          )
        `;
        yield* sql`
          INSERT INTO orchestration_v2_projection_threads (
            thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
            created_at, updated_at, payload_json
          ) VALUES (
            ${threadId}, 'project-1', ${threadId}, 'codex', 'full-access', 'plan', ${at}, ${at},
            ${JSON.stringify({ id: threadId, workflowPreset: preset })}
          )
        `;
      }
      const events = [
        ["quick", "thread.created", threadCreated("quick", "quick-plan")],
        ["quick", "thread.composer-mode-set", composerModeSet("quick", "quick-plan")],
        ["engineering", "thread.created", threadCreated("engineering", "fast-engineering")],
        ["engineering", "thread.composer-mode-set", composerModeSet("engineering", "planning")],
      ] as const;
      for (const [index, [threadId, type, payload]] of events.entries()) {
        for (const table of ["orchestration_events", "workflow_events"] as const) {
          yield* sql.unsafe(
            `INSERT INTO ${table} (
              event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
              command_id, causation_event_id, correlation_id, actor_kind, payload_json,
              metadata_json
            ) VALUES (?, 'thread', ?, ?, ?, ?, ?, NULL, NULL, 'client', ?, '{}')`,
            [`${table}-${index}`, threadId, index, type, at, `command-${index}`, payload],
          );
        }
      }

      yield* runMigrations({ toMigrationInclusive: 108 });

      const projected = yield* sql<{ readonly threadId: string; readonly preset: string }>`
        SELECT thread_id AS "threadId", workflow_preset AS preset
        FROM projection_threads ORDER BY thread_id
      `;
      assert.deepStrictEqual(projected, [
        { threadId: "engineering", preset: "planning" },
        { threadId: "feature", preset: "fast-plan" },
        { threadId: "quick", preset: "fast-plan" },
      ]);
      const native = yield* sql<{ readonly payload: string }>`
        SELECT payload_json AS payload FROM orchestration_v2_projection_threads ORDER BY thread_id
      `;
      assert.deepStrictEqual(
        native.map((row) => (JSON.parse(row.payload) as { workflowPreset: string }).workflowPreset),
        ["planning", "fast-plan", "fast-plan"],
      );
      for (const table of ["orchestration_events", "workflow_events"] as const) {
        const stored = yield* sql.unsafe<{ readonly payload: string }>(
          `SELECT payload_json AS payload FROM ${table} ORDER BY sequence`,
        );
        assert.deepStrictEqual(
          stored.map(
            (row) => (JSON.parse(row.payload) as { workflowPreset: string }).workflowPreset,
          ),
          ["fast-plan", "fast-plan", "planning", "planning"],
        );
      }

      const rows = yield* sql<EventRow>`
        SELECT sequence, event_id AS "eventId", aggregate_kind AS "aggregateKind",
               stream_id AS "streamId", stream_version AS "streamVersion",
               event_type AS "eventType", occurred_at AS "occurredAt",
               command_id AS "commandId", actor_kind AS "actorKind",
               payload_json AS "payloadJson", metadata_json AS "metadataJson"
        FROM workflow_events ORDER BY sequence
      `;
      let model = createEmptyReadModel(at);
      for (const row of rows) {
        model = yield* projectEvent(model, {
          sequence: row.sequence,
          eventId: row.eventId,
          aggregateKind: row.aggregateKind,
          aggregateId: row.streamId,
          streamVersion: row.streamVersion,
          type: row.eventType,
          occurredAt: row.occurredAt,
          commandId: row.commandId,
          causationEventId: null,
          correlationId: null,
          actorKind: row.actorKind,
          payload: JSON.parse(row.payloadJson),
          metadata: JSON.parse(row.metadataJson),
        } as unknown as OrchestrationEvent);
      }
      assert.deepStrictEqual(
        model.threads.map((thread) => ({ id: String(thread.id), preset: thread.workflowPreset })),
        [
          { id: "quick", preset: "fast-plan" },
          { id: "engineering", preset: "planning" },
        ],
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});
