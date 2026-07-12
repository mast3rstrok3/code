import { MessageId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  DeleteProjectionThreadSpecsInput,
  ListProjectionThreadSpecsInput,
  ProjectionThreadSpec,
  ProjectionThreadSpecRepository,
  type ProjectionThreadSpecRepositoryShape,
} from "../Services/ProjectionThreadSpecs.ts";

const ProjectionThreadSpecDbRow = ProjectionThreadSpec.mapFields(
  Struct.assign({
    sourceMessageIds: Schema.fromJsonString(Schema.Array(MessageId)),
  }),
);

const makeProjectionThreadSpecRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionThreadSpecRow = SqlSchema.void({
    Request: ProjectionThreadSpec,
    execute: (row) => sql`
      INSERT INTO projection_thread_specs (
        spec_id, thread_id, title, summary_markdown, tenant_id, team_id,
        source_thread_id, source_message_ids_json, created_by, workflow_id,
        ticket_count, created_at, updated_at
      )
      VALUES (
        ${row.specId}, ${row.threadId}, ${row.title}, ${row.summaryMarkdown},
        ${row.tenantId}, ${row.teamId}, ${row.sourceThreadId},
        ${JSON.stringify(row.sourceMessageIds)}, ${row.createdBy}, ${row.workflowId},
        ${row.ticketCount}, ${row.createdAt}, ${row.updatedAt}
      )
      ON CONFLICT (spec_id)
      DO UPDATE SET
        thread_id = excluded.thread_id,
        title = excluded.title,
        summary_markdown = excluded.summary_markdown,
        tenant_id = excluded.tenant_id,
        team_id = excluded.team_id,
        source_thread_id = excluded.source_thread_id,
        source_message_ids_json = excluded.source_message_ids_json,
        created_by = excluded.created_by,
        workflow_id = excluded.workflow_id,
        ticket_count = excluded.ticket_count,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `,
  });

  const listProjectionThreadSpecRows = SqlSchema.findAll({
    Request: ListProjectionThreadSpecsInput,
    Result: ProjectionThreadSpecDbRow,
    execute: ({ threadId }) => sql`
      SELECT
        spec_id AS "specId",
        thread_id AS "threadId",
        title,
        summary_markdown AS "summaryMarkdown",
        tenant_id AS "tenantId",
        team_id AS "teamId",
        source_thread_id AS "sourceThreadId",
        source_message_ids_json AS "sourceMessageIds",
        created_by AS "createdBy",
        workflow_id AS "workflowId",
        ticket_count AS "ticketCount",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM projection_thread_specs
      WHERE thread_id = ${threadId}
      ORDER BY created_at ASC, spec_id ASC
    `,
  });

  const deleteProjectionThreadSpecRows = SqlSchema.void({
    Request: DeleteProjectionThreadSpecsInput,
    execute: ({ threadId }) => sql`
      DELETE FROM projection_thread_specs
      WHERE thread_id = ${threadId}
    `,
  });

  return {
    upsert: (row) =>
      upsertProjectionThreadSpecRow(row).pipe(
        Effect.mapError(toPersistenceSqlError("ProjectionThreadSpecRepository.upsert:query")),
      ),
    listByThreadId: (input) =>
      listProjectionThreadSpecRows(input).pipe(
        Effect.mapError(
          toPersistenceSqlError("ProjectionThreadSpecRepository.listByThreadId:query"),
        ),
      ),
    deleteByThreadId: (input) =>
      deleteProjectionThreadSpecRows(input).pipe(
        Effect.mapError(
          toPersistenceSqlError("ProjectionThreadSpecRepository.deleteByThreadId:query"),
        ),
      ),
  } satisfies ProjectionThreadSpecRepositoryShape;
});

export const ProjectionThreadSpecRepositoryLive = Layer.effect(
  ProjectionThreadSpecRepository,
  makeProjectionThreadSpecRepository,
);
