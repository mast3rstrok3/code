import {
  OrchestrationPlanningIssueId,
  OrchestrationPlanningReviewIssueFeedback,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  DeleteProjectionThreadPlanningReviewCyclesInput,
  ListProjectionThreadPlanningReviewCyclesInput,
  ProjectionThreadPlanningReviewCycle,
  ProjectionThreadPlanningReviewCycleRepository,
  type ProjectionThreadPlanningReviewCycleRepositoryShape,
} from "../Services/ProjectionThreadPlanningReviewCycles.ts";

const ProjectionThreadPlanningReviewCycleDbRow = ProjectionThreadPlanningReviewCycle.mapFields(
  Struct.assign({
    failingPlanningIssueIds: Schema.fromJsonString(Schema.Array(OrchestrationPlanningIssueId)),
    dependencyFeedback: Schema.fromJsonString(Schema.Array(Schema.String)),
    perIssueFeedback: Schema.fromJsonString(Schema.Array(OrchestrationPlanningReviewIssueFeedback)),
  }),
);

const makeProjectionThreadPlanningReviewCycleRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionThreadPlanningReviewCycleRow = SqlSchema.void({
    Request: ProjectionThreadPlanningReviewCycle,
    execute: (row) => sql`
      INSERT INTO projection_thread_planning_review_cycles (
        thread_id, prd_id, cycle_number, status, reviewer_thread_id,
        reviewer_message_id, verdict_markdown, failing_planning_issue_ids_json,
        dependency_feedback_json, per_issue_feedback_json, created_at
      )
      VALUES (
        ${row.threadId}, ${row.prdId}, ${row.cycleNumber}, ${row.status},
        ${row.reviewerThreadId}, ${row.reviewerMessageId}, ${row.verdictMarkdown},
        ${JSON.stringify(row.failingPlanningIssueIds)}, ${JSON.stringify(row.dependencyFeedback)},
        ${JSON.stringify(row.perIssueFeedback)}, ${row.createdAt}
      )
      ON CONFLICT (thread_id, cycle_number)
      DO UPDATE SET
        prd_id = excluded.prd_id,
        status = excluded.status,
        reviewer_thread_id = excluded.reviewer_thread_id,
        reviewer_message_id = excluded.reviewer_message_id,
        verdict_markdown = excluded.verdict_markdown,
        failing_planning_issue_ids_json = excluded.failing_planning_issue_ids_json,
        dependency_feedback_json = excluded.dependency_feedback_json,
        per_issue_feedback_json = excluded.per_issue_feedback_json,
        created_at = excluded.created_at
    `,
  });

  const listProjectionThreadPlanningReviewCycleRows = SqlSchema.findAll({
    Request: ListProjectionThreadPlanningReviewCyclesInput,
    Result: ProjectionThreadPlanningReviewCycleDbRow,
    execute: ({ threadId }) => sql`
      SELECT
        thread_id AS "threadId",
        prd_id AS "prdId",
        cycle_number AS "cycleNumber",
        status,
        reviewer_thread_id AS "reviewerThreadId",
        reviewer_message_id AS "reviewerMessageId",
        verdict_markdown AS "verdictMarkdown",
        failing_planning_issue_ids_json AS "failingPlanningIssueIds",
        dependency_feedback_json AS "dependencyFeedback",
        per_issue_feedback_json AS "perIssueFeedback",
        created_at AS "createdAt"
      FROM projection_thread_planning_review_cycles
      WHERE thread_id = ${threadId}
      ORDER BY cycle_number ASC, created_at ASC
    `,
  });

  const deleteProjectionThreadPlanningReviewCycleRows = SqlSchema.void({
    Request: DeleteProjectionThreadPlanningReviewCyclesInput,
    execute: ({ threadId }) => sql`
      DELETE FROM projection_thread_planning_review_cycles
      WHERE thread_id = ${threadId}
    `,
  });

  return {
    upsert: (row) =>
      upsertProjectionThreadPlanningReviewCycleRow(row).pipe(
        Effect.mapError(
          toPersistenceSqlError("ProjectionThreadPlanningReviewCycleRepository.upsert:query"),
        ),
      ),
    listByThreadId: (input) =>
      listProjectionThreadPlanningReviewCycleRows(input).pipe(
        Effect.mapError(
          toPersistenceSqlError(
            "ProjectionThreadPlanningReviewCycleRepository.listByThreadId:query",
          ),
        ),
      ),
    deleteByThreadId: (input) =>
      deleteProjectionThreadPlanningReviewCycleRows(input).pipe(
        Effect.mapError(
          toPersistenceSqlError(
            "ProjectionThreadPlanningReviewCycleRepository.deleteByThreadId:query",
          ),
        ),
      ),
  } satisfies ProjectionThreadPlanningReviewCycleRepositoryShape;
});

export const ProjectionThreadPlanningReviewCycleRepositoryLive = Layer.effect(
  ProjectionThreadPlanningReviewCycleRepository,
  makeProjectionThreadPlanningReviewCycleRepository,
);
