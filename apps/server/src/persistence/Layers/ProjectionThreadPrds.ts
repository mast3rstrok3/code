import { MessageId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  DeleteProjectionThreadPrdsInput,
  ListProjectionThreadPrdsInput,
  ProjectionThreadPrd,
  ProjectionThreadPrdRepository,
  type ProjectionThreadPrdRepositoryShape,
} from "../Services/ProjectionThreadPrds.ts";

const ProjectionThreadPrdDbRow = ProjectionThreadPrd.mapFields(
  Struct.assign({
    sourceMessageIds: Schema.fromJsonString(Schema.Array(MessageId)),
  }),
);

const makeProjectionThreadPrdRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionThreadPrdRow = SqlSchema.void({
    Request: ProjectionThreadPrd,
    execute: (row) => sql`
      INSERT INTO projection_thread_prds (
        prd_id, thread_id, title, summary_markdown, tenant_id, team_id,
        source_thread_id, source_message_ids_json, created_by, workflow_id,
        issue_count, created_at, updated_at
      )
      VALUES (
        ${row.prdId}, ${row.threadId}, ${row.title}, ${row.summaryMarkdown},
        ${row.tenantId}, ${row.teamId}, ${row.sourceThreadId},
        ${JSON.stringify(row.sourceMessageIds)}, ${row.createdBy}, ${row.workflowId},
        ${row.issueCount}, ${row.createdAt}, ${row.updatedAt}
      )
      ON CONFLICT (prd_id)
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
        issue_count = excluded.issue_count,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `,
  });

  const listProjectionThreadPrdRows = SqlSchema.findAll({
    Request: ListProjectionThreadPrdsInput,
    Result: ProjectionThreadPrdDbRow,
    execute: ({ threadId }) => sql`
      SELECT
        prd_id AS "prdId",
        thread_id AS "threadId",
        title,
        summary_markdown AS "summaryMarkdown",
        tenant_id AS "tenantId",
        team_id AS "teamId",
        source_thread_id AS "sourceThreadId",
        source_message_ids_json AS "sourceMessageIds",
        created_by AS "createdBy",
        workflow_id AS "workflowId",
        issue_count AS "issueCount",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM projection_thread_prds
      WHERE thread_id = ${threadId}
      ORDER BY created_at ASC, prd_id ASC
    `,
  });

  const deleteProjectionThreadPrdRows = SqlSchema.void({
    Request: DeleteProjectionThreadPrdsInput,
    execute: ({ threadId }) => sql`
      DELETE FROM projection_thread_prds
      WHERE thread_id = ${threadId}
    `,
  });

  return {
    upsert: (row) =>
      upsertProjectionThreadPrdRow(row).pipe(
        Effect.mapError(toPersistenceSqlError("ProjectionThreadPrdRepository.upsert:query")),
      ),
    listByThreadId: (input) =>
      listProjectionThreadPrdRows(input).pipe(
        Effect.mapError(
          toPersistenceSqlError("ProjectionThreadPrdRepository.listByThreadId:query"),
        ),
      ),
    deleteByThreadId: (input) =>
      deleteProjectionThreadPrdRows(input).pipe(
        Effect.mapError(
          toPersistenceSqlError("ProjectionThreadPrdRepository.deleteByThreadId:query"),
        ),
      ),
  } satisfies ProjectionThreadPrdRepositoryShape;
});

export const ProjectionThreadPrdRepositoryLive = Layer.effect(
  ProjectionThreadPrdRepository,
  makeProjectionThreadPrdRepository,
);
