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

it.effect("preserves old tickets and round-trips executable suite selections", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 94 });
    yield* sql`INSERT INTO projection_thread_planning_tickets (
    ticket_id, ticket_key, spec_id, thread_id, ordinal, title, body_markdown,
    planned_file_changes_json, dependencies_json, status, created_at, updated_at
  ) VALUES ('ticket', 'TICKET-1', 'spec', 'thread', 1, 'Booking', 'Create a booking test',
    '[]', '[]', 'open', '2026-09-18T07:00:00.000Z', '2026-09-18T07:00:00.000Z')`;
    yield* runMigrations();
    yield* Effect.gen(function* () {
      const repository = yield* ProjectionThreadPlanningTicketRepository;
      const [legacy] = yield* repository.listByThreadId({ threadId: ThreadId.make("thread") });
      assert(legacy !== undefined);
      assert.deepStrictEqual(legacy.appReviewCommands, []);
      const commands = ["pnpm exec playwright test booking.spec.ts --project chromium"];
      yield* repository.upsert({ ...legacy, appReviewCommands: commands });
      const [updated] = yield* repository.listByThreadId({ threadId: ThreadId.make("thread") });
      assert(updated !== undefined);
      assert.deepStrictEqual(projectionTicketToContract(updated).appReviewCommands, commands);
      yield* repository.upsert({ ...updated, appReviewCommands: [] });
      const [cleared] = yield* repository.listByThreadId({ threadId: ThreadId.make("thread") });
      assert.deepStrictEqual(cleared?.appReviewCommands, []);
    }).pipe(Effect.provide(ProjectionThreadPlanningTicketRepositoryLive));
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
