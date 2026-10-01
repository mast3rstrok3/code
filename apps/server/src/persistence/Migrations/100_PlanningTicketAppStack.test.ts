import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";
import { ProjectionThreadPlanningTicketRepositoryLive } from "../Layers/ProjectionThreadPlanningTickets.ts";
import {
  ProjectionThreadPlanningTicketRepository,
  projectionTicketToContract,
} from "../Services/ProjectionThreadPlanningTickets.ts";

it.effect("keeps old tickets without an App Stack and round-trips a planned one", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 99 });
    yield* sql`INSERT INTO projection_thread_planning_tickets (
    ticket_id, ticket_key, spec_id, thread_id, ordinal, title, body_markdown,
    planned_file_changes_json, dependencies_json, status, created_at, updated_at
  ) VALUES ('ticket', 'TICKET-1', 'spec', 'thread', 1, 'Studies', 'Search bundled studies',
    '[]', '[]', 'open', '2026-10-01T07:00:00.000Z', '2026-10-01T07:00:00.000Z')`;
    yield* runMigrations();
    yield* Effect.gen(function* () {
      const repository = yield* ProjectionThreadPlanningTicketRepository;
      const [legacy] = yield* repository.listByThreadId({ threadId: ThreadId.make("thread") });
      assert(legacy !== undefined);
      assert.strictEqual(projectionTicketToContract(legacy).appStack, undefined);
      const appStack = {
        bundle: ["medical-repository"],
        omitServices: { rudi: ["codex-runner"] },
      };
      yield* repository.upsert({ ...legacy, appStack });
      const [updated] = yield* repository.listByThreadId({ threadId: ThreadId.make("thread") });
      assert(updated !== undefined);
      assert.deepStrictEqual(projectionTicketToContract(updated).appStack, appStack);
      yield* repository.upsert({ ...updated, appStack: null });
      const [cleared] = yield* repository.listByThreadId({ threadId: ThreadId.make("thread") });
      assert(cleared !== undefined);
      assert.strictEqual(projectionTicketToContract(cleared).appStack, undefined);
    }).pipe(Effect.provide(ProjectionThreadPlanningTicketRepositoryLive));
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
