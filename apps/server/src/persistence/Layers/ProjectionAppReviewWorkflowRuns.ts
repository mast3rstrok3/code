import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  ProjectionAppReviewWorkflowRun,
  ProjectionAppReviewWorkflowRunRepository,
  type ProjectionAppReviewWorkflowRunRepositoryShape,
} from "../Services/ProjectionAppReviewWorkflowRuns.ts";

const makeProjectionAppReviewWorkflowRunRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertRow = SqlSchema.void({
    Request: ProjectionAppReviewWorkflowRun,
    execute: (row) => {
      const callerThreadId =
        row.run.caller.type === "standalone"
          ? row.run.caller.sourceThreadId
          : row.run.caller.orchestratorThreadId;
      const implementationRunId =
        row.run.caller.type === "implementation" ? row.run.caller.implementationRunId : null;
      return sql`
        INSERT INTO projection_app_review_workflow_runs (
          run_id, target_thread_id, controller_thread_id, caller_type,
          caller_thread_id, implementation_run_id, status, run_json, created_at, updated_at
        ) VALUES (
          ${row.runId}, ${row.run.targetThreadId}, ${row.run.controllerThreadId},
          ${row.run.caller.type}, ${callerThreadId}, ${implementationRunId}, ${row.run.status},
          ${JSON.stringify(row.run)}, ${row.run.createdAt}, ${row.run.updatedAt}
        )
        ON CONFLICT (run_id) DO UPDATE SET
          target_thread_id = excluded.target_thread_id,
          controller_thread_id = excluded.controller_thread_id,
          caller_type = excluded.caller_type,
          caller_thread_id = excluded.caller_thread_id,
          implementation_run_id = excluded.implementation_run_id,
          status = excluded.status,
          run_json = excluded.run_json,
          updated_at = excluded.updated_at
      `;
    },
  });

  return {
    upsert: (row) =>
      upsertRow(row).pipe(
        Effect.mapError(
          toPersistenceSqlError("ProjectionAppReviewWorkflowRunRepository.upsert:query"),
        ),
      ),
  } satisfies ProjectionAppReviewWorkflowRunRepositoryShape;
});

export const ProjectionAppReviewWorkflowRunRepositoryLive = Layer.effect(
  ProjectionAppReviewWorkflowRunRepository,
  makeProjectionAppReviewWorkflowRunRepository,
);
