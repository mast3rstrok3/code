import { assert, it } from "@effect/vitest";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";
import { ProjectionThreadPlanningTicketRepositoryLive } from "../Layers/ProjectionThreadPlanningTickets.ts";
import {
  ProjectionThreadPlanningTicketRepository,
  projectionTicketToContract,
} from "../Services/ProjectionThreadPlanningTickets.ts";

it.effect("keeps old tickets in their workflow's project and round-trips another one", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 100 });
    yield* sql`INSERT INTO projection_thread_planning_tickets (
    ticket_id, ticket_key, spec_id, thread_id, ordinal, title, body_markdown,
    planned_file_changes_json, dependencies_json, status, created_at, updated_at
  ) VALUES ('ticket', 'TICKET-1', 'spec', 'thread', 1, 'Studies', 'Serve studies to Rudi',
    '[]', '[]', 'open', '2026-10-02T07:00:00.000Z', '2026-10-02T07:00:00.000Z')`;
    yield* runMigrations();
    yield* Effect.gen(function* () {
      const repository = yield* ProjectionThreadPlanningTicketRepository;
      const [legacy] = yield* repository.listByThreadId({ threadId: ThreadId.make("thread") });
      assert(legacy !== undefined);
      assert.strictEqual(projectionTicketToContract(legacy).projectId, undefined);
      const projectId = ProjectId.make("project-medical-repository");
      yield* repository.upsert({ ...legacy, projectId });
      const [moved] = yield* repository.listByThreadId({ threadId: ThreadId.make("thread") });
      assert(moved !== undefined);
      assert.strictEqual(projectionTicketToContract(moved).projectId, projectId);
      yield* repository.upsert({ ...moved, projectId: null });
      const [returned] = yield* repository.listByThreadId({ threadId: ThreadId.make("thread") });
      assert(returned !== undefined);
      assert.strictEqual(projectionTicketToContract(returned).projectId, undefined);
    }).pipe(Effect.provide(ProjectionThreadPlanningTicketRepositoryLive));
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
