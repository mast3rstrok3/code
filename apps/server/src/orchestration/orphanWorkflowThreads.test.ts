import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { selectOrphanWorkflowThreads } from "./orphanWorkflowThreads.ts";

it.effect("selects only empty workflow shells with no unfinished owner", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE projection_threads(thread_id TEXT PRIMARY KEY, workflow_role TEXT, deleted_at TEXT, parent_thread_id TEXT, created_at TEXT)`;
    yield* sql`CREATE TABLE projection_thread_sessions(thread_id TEXT)`;
    yield* sql`CREATE TABLE projection_thread_messages(thread_id TEXT)`;
    yield* sql`CREATE TABLE projection_thread_activities(thread_id TEXT)`;
    yield* sql`CREATE TABLE projection_turns(thread_id TEXT)`;
    yield* sql`CREATE TABLE projection_implementation_runs(status TEXT, orchestrator_thread_id TEXT, source_thread_id TEXT, ticket_states_json TEXT, run_json TEXT)`;
    yield* sql`CREATE TABLE projection_app_review_workflow_runs(status TEXT, target_thread_id TEXT, controller_thread_id TEXT, caller_thread_id TEXT, run_json TEXT)`;

    for (const id of [
      "empty",
      "session",
      "message",
      "activity",
      "turn",
      "parent",
      "unfinished",
      "app-review",
      "completed-owner",
    ]) {
      yield* sql`INSERT INTO projection_threads VALUES (${id}, 'implementation-code-reviewer', NULL, NULL, '2026-08-25T00:00:00.000Z')`;
    }
    yield* sql`INSERT INTO projection_threads VALUES ('child', NULL, NULL, 'parent', '2026-08-25T00:00:00.000Z')`;
    yield* sql`INSERT INTO projection_thread_sessions VALUES ('session')`;
    yield* sql`INSERT INTO projection_thread_messages VALUES ('message')`;
    yield* sql`INSERT INTO projection_thread_activities VALUES ('activity')`;
    yield* sql`INSERT INTO projection_turns VALUES ('turn')`;
    yield* sql`INSERT INTO projection_implementation_runs VALUES ('running', 'unfinished', 'root', '[]', '{}')`;
    yield* sql`INSERT INTO projection_implementation_runs VALUES ('completed', 'completed-owner', 'root', '[]', '{}')`;
    yield* sql`INSERT INTO projection_app_review_workflow_runs VALUES ('running', 'target', 'app-review', 'caller', '{}')`;

    const selected = yield* selectOrphanWorkflowThreads();
    assert.deepEqual(selected.map((row) => row.threadId).sort(), ["completed-owner", "empty"]);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
