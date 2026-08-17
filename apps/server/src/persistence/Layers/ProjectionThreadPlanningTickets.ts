import {
  OrchestrationPlanningFileChange,
  OrchestrationPlanningTicketDependency,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  DeleteProjectionThreadPlanningTicketsInput,
  ListProjectionThreadPlanningTicketsInput,
  ProjectionThreadPlanningTicket,
  ProjectionThreadPlanningTicketRepository,
  type ProjectionThreadPlanningTicketRepositoryShape,
} from "../Services/ProjectionThreadPlanningTickets.ts";

const ProjectionThreadPlanningTicketDbRow = ProjectionThreadPlanningTicket.mapFields(
  Struct.assign({
    plannedFileChanges: Schema.fromJsonString(Schema.Array(OrchestrationPlanningFileChange)),
    dependencies: Schema.fromJsonString(Schema.Array(OrchestrationPlanningTicketDependency)),
  }),
);

const makeProjectionThreadPlanningTicketRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionThreadPlanningTicketRow = SqlSchema.void({
    Request: ProjectionThreadPlanningTicket,
    execute: (row) => sql`
      INSERT INTO projection_thread_planning_tickets (
        ticket_id, ticket_key, spec_id, thread_id, ordinal, title, body_markdown,
        planned_file_changes_json, dependencies_json, app_review_eligible,
        app_review_plan_markdown, status, created_at, updated_at
      )
      VALUES (
        ${row.ticketId}, ${row.ticketKey}, ${row.specId}, ${row.threadId}, ${row.ordinal},
        ${row.title}, ${row.bodyMarkdown}, ${JSON.stringify(row.plannedFileChanges)},
        ${JSON.stringify(row.dependencies)}, ${row.appReviewEligible},
        ${row.appReviewPlanMarkdown},
        ${row.status}, ${row.createdAt}, ${row.updatedAt}
      )
      ON CONFLICT (ticket_id)
      DO UPDATE SET
        spec_id = excluded.spec_id,
        ticket_key = excluded.ticket_key,
        thread_id = excluded.thread_id,
        ordinal = excluded.ordinal,
        title = excluded.title,
        body_markdown = excluded.body_markdown,
        planned_file_changes_json = excluded.planned_file_changes_json,
        dependencies_json = excluded.dependencies_json,
        app_review_eligible = excluded.app_review_eligible,
        app_review_plan_markdown = excluded.app_review_plan_markdown,
        status = excluded.status,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `,
  });

  const listProjectionThreadPlanningTicketRows = SqlSchema.findAll({
    Request: ListProjectionThreadPlanningTicketsInput,
    Result: ProjectionThreadPlanningTicketDbRow,
    execute: ({ threadId }) => sql`
      SELECT
        ticket_id AS "ticketId",
        ticket_key AS "ticketKey",
        spec_id AS "specId",
        thread_id AS "threadId",
        ordinal,
        title,
        body_markdown AS "bodyMarkdown",
        planned_file_changes_json AS "plannedFileChanges",
        dependencies_json AS "dependencies",
        app_review_eligible AS "appReviewEligible",
        app_review_plan_markdown AS "appReviewPlanMarkdown",
        status,
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM projection_thread_planning_tickets
      WHERE thread_id = ${threadId}
      ORDER BY ordinal ASC, created_at ASC, ticket_id ASC
    `,
  });

  const deleteProjectionThreadPlanningTicketRows = SqlSchema.void({
    Request: DeleteProjectionThreadPlanningTicketsInput,
    execute: ({ threadId }) => sql`
      DELETE FROM projection_thread_planning_tickets
      WHERE thread_id = ${threadId}
    `,
  });

  return {
    upsert: (row) =>
      upsertProjectionThreadPlanningTicketRow(row).pipe(
        Effect.mapError(
          toPersistenceSqlError("ProjectionThreadPlanningTicketRepository.upsert:query"),
        ),
      ),
    listByThreadId: (input) =>
      listProjectionThreadPlanningTicketRows(input).pipe(
        Effect.mapError(
          toPersistenceSqlError("ProjectionThreadPlanningTicketRepository.listByThreadId:query"),
        ),
      ),
    deleteByThreadId: (input) =>
      deleteProjectionThreadPlanningTicketRows(input).pipe(
        Effect.mapError(
          toPersistenceSqlError("ProjectionThreadPlanningTicketRepository.deleteByThreadId:query"),
        ),
      ),
  } satisfies ProjectionThreadPlanningTicketRepositoryShape;
});

export const ProjectionThreadPlanningTicketRepositoryLive = Layer.effect(
  ProjectionThreadPlanningTicketRepository,
  makeProjectionThreadPlanningTicketRepository,
);
