import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  ProjectionImplementationRun,
  ProjectionImplementationRunRepository,
  type ProjectionImplementationRunRepositoryShape,
} from "../Services/ProjectionImplementationRuns.ts";

const makeProjectionImplementationRunRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionImplementationRunRow = SqlSchema.void({
    Request: ProjectionImplementationRun,
    execute: (row) => sql`
      INSERT INTO projection_implementation_runs (
        run_id, prd_id, orchestrator_thread_id, source_thread_id, status,
        base_branch, pinned_commit, orchestrator_branch, orchestrator_worktree_path,
        launch_summary_json, issue_states_json, worker_results_json,
        terminal_lineage_issue_ids_json, final_validation_json, dev_review_ids_json,
        qa_attempt_count, handoff_target, base_branch_merge_policy, run_json,
        created_at, updated_at
      )
      VALUES (
        ${row.runId}, ${row.run.prdId}, ${row.run.orchestratorThreadId},
        ${row.sourceThreadId}, ${row.run.status}, ${row.run.baseBranch}, ${row.run.pinnedCommit},
        ${row.run.orchestratorBranch}, ${row.run.orchestratorWorktreePath},
        ${JSON.stringify(row.run.launchSummary)}, ${JSON.stringify(row.run.issueStates)},
        ${JSON.stringify(row.run.workerResults)}, ${JSON.stringify(row.run.terminalLineageIssueIds)},
        ${row.run.finalValidation === null ? null : JSON.stringify(row.run.finalValidation)},
        ${JSON.stringify(row.run.devReviewIds)}, ${row.run.qaAttemptCount}, ${row.run.handoffTarget},
        ${row.run.baseBranchMergePolicy}, ${JSON.stringify(row.run)}, ${row.run.createdAt},
        ${row.run.updatedAt}
      )
      ON CONFLICT (run_id)
      DO UPDATE SET
        prd_id = excluded.prd_id,
        orchestrator_thread_id = excluded.orchestrator_thread_id,
        source_thread_id = COALESCE(projection_implementation_runs.source_thread_id, excluded.source_thread_id),
        status = excluded.status,
        base_branch = excluded.base_branch,
        pinned_commit = excluded.pinned_commit,
        orchestrator_branch = excluded.orchestrator_branch,
        orchestrator_worktree_path = excluded.orchestrator_worktree_path,
        launch_summary_json = excluded.launch_summary_json,
        issue_states_json = excluded.issue_states_json,
        worker_results_json = excluded.worker_results_json,
        terminal_lineage_issue_ids_json = excluded.terminal_lineage_issue_ids_json,
        final_validation_json = excluded.final_validation_json,
        dev_review_ids_json = excluded.dev_review_ids_json,
        qa_attempt_count = excluded.qa_attempt_count,
        handoff_target = excluded.handoff_target,
        base_branch_merge_policy = excluded.base_branch_merge_policy,
        run_json = excluded.run_json,
        updated_at = excluded.updated_at
    `,
  });

  return {
    upsert: (row) =>
      upsertProjectionImplementationRunRow(row).pipe(
        Effect.mapError(
          toPersistenceSqlError("ProjectionImplementationRunRepository.upsert:query"),
        ),
      ),
  } satisfies ProjectionImplementationRunRepositoryShape;
});

export const ProjectionImplementationRunRepositoryLive = Layer.effect(
  ProjectionImplementationRunRepository,
  makeProjectionImplementationRunRepository,
);
