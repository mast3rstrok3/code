import { OrchestrationPlanningIssueDependency } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  DeleteProjectionThreadPlanningIssuesInput,
  ListProjectionThreadPlanningIssuesInput,
  ProjectionThreadPlanningIssue,
  ProjectionThreadPlanningIssueRepository,
  type ProjectionThreadPlanningIssueRepositoryShape,
} from "../Services/ProjectionThreadPlanningIssues.ts";

const ProjectionThreadPlanningIssueDbRow = ProjectionThreadPlanningIssue.mapFields(
  Struct.assign({
    dependencies: Schema.fromJsonString(Schema.Array(OrchestrationPlanningIssueDependency)),
  }),
);

const makeProjectionThreadPlanningIssueRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionThreadPlanningIssueRow = SqlSchema.void({
    Request: ProjectionThreadPlanningIssue,
    execute: (row) => sql`
      INSERT INTO projection_thread_planning_issues (
        issue_id, prd_id, thread_id, ordinal, title, body_markdown,
        dependencies_json, status, created_at, updated_at
      )
      VALUES (
        ${row.issueId}, ${row.prdId}, ${row.threadId}, ${row.ordinal},
        ${row.title}, ${row.bodyMarkdown}, ${JSON.stringify(row.dependencies)},
        ${row.status}, ${row.createdAt}, ${row.updatedAt}
      )
      ON CONFLICT (issue_id)
      DO UPDATE SET
        prd_id = excluded.prd_id,
        thread_id = excluded.thread_id,
        ordinal = excluded.ordinal,
        title = excluded.title,
        body_markdown = excluded.body_markdown,
        dependencies_json = excluded.dependencies_json,
        status = excluded.status,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `,
  });

  const listProjectionThreadPlanningIssueRows = SqlSchema.findAll({
    Request: ListProjectionThreadPlanningIssuesInput,
    Result: ProjectionThreadPlanningIssueDbRow,
    execute: ({ threadId }) => sql`
      SELECT
        issue_id AS "issueId",
        prd_id AS "prdId",
        thread_id AS "threadId",
        ordinal,
        title,
        body_markdown AS "bodyMarkdown",
        dependencies_json AS "dependencies",
        status,
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM projection_thread_planning_issues
      WHERE thread_id = ${threadId}
      ORDER BY ordinal ASC, created_at ASC, issue_id ASC
    `,
  });

  const deleteProjectionThreadPlanningIssueRows = SqlSchema.void({
    Request: DeleteProjectionThreadPlanningIssuesInput,
    execute: ({ threadId }) => sql`
      DELETE FROM projection_thread_planning_issues
      WHERE thread_id = ${threadId}
    `,
  });

  return {
    upsert: (row) =>
      upsertProjectionThreadPlanningIssueRow(row).pipe(
        Effect.mapError(
          toPersistenceSqlError("ProjectionThreadPlanningIssueRepository.upsert:query"),
        ),
      ),
    listByThreadId: (input) =>
      listProjectionThreadPlanningIssueRows(input).pipe(
        Effect.mapError(
          toPersistenceSqlError("ProjectionThreadPlanningIssueRepository.listByThreadId:query"),
        ),
      ),
    deleteByThreadId: (input) =>
      deleteProjectionThreadPlanningIssueRows(input).pipe(
        Effect.mapError(
          toPersistenceSqlError("ProjectionThreadPlanningIssueRepository.deleteByThreadId:query"),
        ),
      ),
  } satisfies ProjectionThreadPlanningIssueRepositoryShape;
});

export const ProjectionThreadPlanningIssueRepositoryLive = Layer.effect(
  ProjectionThreadPlanningIssueRepository,
  makeProjectionThreadPlanningIssueRepository,
);
