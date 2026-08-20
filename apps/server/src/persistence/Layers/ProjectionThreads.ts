import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  DeleteProjectionThreadInput,
  GetProjectionThreadInput,
  ListProjectionThreadsByProjectInput,
  ProjectionThread,
  ProjectionThreadRepository,
  type ProjectionThreadRepositoryShape,
} from "../Services/ProjectionThreads.ts";
import {
  DEFAULT_WORKSPACE_USER_ID,
  ModelSelection,
  ThreadWorkflowContext,
  OrchestrationPlanningActiveReviewRequest,
  WorkflowStepCycleOverride,
  WorkflowStepModelOverride,
} from "@t3tools/contracts";

const ProjectionThreadDbRow = ProjectionThread.mapFields(
  Struct.assign({
    modelSelection: Schema.fromJsonString(ModelSelection),
    workflowContext: Schema.NullOr(Schema.fromJsonString(ThreadWorkflowContext)),
    planningActiveReview: Schema.NullOr(
      Schema.fromJsonString(OrchestrationPlanningActiveReviewRequest),
    ),
    workflowStepModels: Schema.NullOr(
      Schema.fromJsonString(Schema.Array(WorkflowStepModelOverride)),
    ),
    workflowStepCycles: Schema.NullOr(
      Schema.fromJsonString(Schema.Array(WorkflowStepCycleOverride)),
    ),
  }),
);
type ProjectionThreadDbRow = typeof ProjectionThreadDbRow.Type;

const makeProjectionThreadRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionThreadRow = SqlSchema.void({
    Request: ProjectionThread,
    execute: (row) =>
      sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          owner_user_id,
          parent_thread_id,
          workflow_role,
          workflow_id,
          workflow_parent_id,
          workflow_root_thread_id,
          workflow_ticket_scope_json,
          workflow_subagent_batch_id,
          workflow_subagent_child_index,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          workflow_preset,
          branch,
          worktree_path,
          latest_turn_id,
          created_at,
          updated_at,
          archived_at,
          settled_override,
          settled_at,
          workflow_paused_at,
          snoozed_until,
          snoozed_at,
          pinned_at,
          pin_order_key,
          title_regeneration_request_id,
          title_regeneration_started_at,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          planning_workflow_stage,
          planning_active_review_json,
          workflow_step_models_json,
          workflow_step_cycles_json,
          deleted_at
        )
        VALUES (
          ${row.threadId},
          ${row.projectId},
          ${row.ownerUserId},
          ${row.parentThreadId},
          ${row.workflowRole},
          ${row.workflowContext?.workflowId ?? null},
          ${row.workflowContext?.parentWorkflowId ?? null},
          ${row.workflowContext?.rootThreadId ?? null},
          ${JSON.stringify(row.workflowContext?.ticketScope ?? [])},
          ${row.workflowSubagentBatchId ?? null},
          ${row.workflowSubagentChildIndex ?? null},
          ${row.title},
          ${JSON.stringify(row.modelSelection)},
          ${row.runtimeMode},
          ${row.interactionMode},
          ${row.workflowPreset ?? null},
          ${row.branch},
          ${row.worktreePath},
          ${row.latestTurnId},
          ${row.createdAt},
          ${row.updatedAt},
          ${row.archivedAt},
          ${row.settledOverride},
          ${row.settledAt},
          ${row.workflowPausedAt ?? null},
          ${row.snoozedUntil},
          ${row.snoozedAt},
          ${row.pinnedAt},
          ${row.pinOrderKey ?? null},
          ${row.titleRegenerationRequestId ?? null},
          ${row.titleRegenerationStartedAt ?? null},
          ${row.latestUserMessageAt},
          ${row.pendingApprovalCount},
          ${row.pendingUserInputCount},
          ${row.hasActionableProposedPlan},
          ${row.planningWorkflowStage},
          ${row.planningActiveReview == null ? null : JSON.stringify(row.planningActiveReview)},
          ${row.workflowStepModels == null ? null : JSON.stringify(row.workflowStepModels)},
          ${row.workflowStepCycles == null ? null : JSON.stringify(row.workflowStepCycles)},
          ${row.deletedAt}
        )
        ON CONFLICT (thread_id)
        DO UPDATE SET
          project_id = excluded.project_id,
          owner_user_id = excluded.owner_user_id,
          parent_thread_id = excluded.parent_thread_id,
          workflow_role = excluded.workflow_role,
          workflow_id = excluded.workflow_id,
          workflow_parent_id = excluded.workflow_parent_id,
          workflow_root_thread_id = excluded.workflow_root_thread_id,
          workflow_ticket_scope_json = excluded.workflow_ticket_scope_json,
          workflow_subagent_batch_id = excluded.workflow_subagent_batch_id,
          workflow_subagent_child_index = excluded.workflow_subagent_child_index,
          title = excluded.title,
          model_selection_json = excluded.model_selection_json,
          runtime_mode = excluded.runtime_mode,
          interaction_mode = excluded.interaction_mode,
          workflow_preset = excluded.workflow_preset,
          branch = excluded.branch,
          worktree_path = excluded.worktree_path,
          latest_turn_id = excluded.latest_turn_id,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          archived_at = excluded.archived_at,
          settled_override = excluded.settled_override,
          settled_at = excluded.settled_at,
          workflow_paused_at = excluded.workflow_paused_at,
          snoozed_until = excluded.snoozed_until,
          snoozed_at = excluded.snoozed_at,
          pinned_at = excluded.pinned_at,
          pin_order_key = excluded.pin_order_key,
          title_regeneration_request_id = excluded.title_regeneration_request_id,
          title_regeneration_started_at = excluded.title_regeneration_started_at,
          latest_user_message_at = excluded.latest_user_message_at,
          pending_approval_count = excluded.pending_approval_count,
          pending_user_input_count = excluded.pending_user_input_count,
          has_actionable_proposed_plan = excluded.has_actionable_proposed_plan,
          planning_workflow_stage = excluded.planning_workflow_stage,
          planning_active_review_json = excluded.planning_active_review_json,
          workflow_step_models_json = excluded.workflow_step_models_json,
          workflow_step_cycles_json = excluded.workflow_step_cycles_json,
          deleted_at = excluded.deleted_at
      `,
  });

  const getProjectionThreadRow = SqlSchema.findOneOption({
    Request: GetProjectionThreadInput,
    Result: ProjectionThreadDbRow,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          project_id AS "projectId",
          COALESCE(NULLIF(trim(owner_user_id), ''), ${DEFAULT_WORKSPACE_USER_ID}) AS "ownerUserId",
          parent_thread_id AS "parentThreadId",
          workflow_role AS "workflowRole",
          CASE
            WHEN workflow_id IS NULL OR workflow_root_thread_id IS NULL THEN NULL
            ELSE json_object(
              'workflowId', workflow_id,
              'parentWorkflowId', workflow_parent_id,
              'rootThreadId', workflow_root_thread_id,
              'ticketScope', json(workflow_ticket_scope_json)
            )
          END AS "workflowContext",
          workflow_subagent_batch_id AS "workflowSubagentBatchId",
          workflow_subagent_child_index AS "workflowSubagentChildIndex",
          title,
          model_selection_json AS "modelSelection",
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          workflow_preset AS "workflowPreset",
          branch,
          worktree_path AS "worktreePath",
          latest_turn_id AS "latestTurnId",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt",
          settled_override AS "settledOverride",
          settled_at AS "settledAt",
          workflow_paused_at AS "workflowPausedAt",
          snoozed_until AS "snoozedUntil",
          snoozed_at AS "snoozedAt",
          pinned_at AS "pinnedAt",
          pin_order_key AS "pinOrderKey",
          title_regeneration_request_id AS "titleRegenerationRequestId",
          title_regeneration_started_at AS "titleRegenerationStartedAt",
          latest_user_message_at AS "latestUserMessageAt",
          pending_approval_count AS "pendingApprovalCount",
          pending_user_input_count AS "pendingUserInputCount",
          has_actionable_proposed_plan AS "hasActionableProposedPlan",
          planning_workflow_stage AS "planningWorkflowStage",
          planning_active_review_json AS "planningActiveReview",
          workflow_step_models_json AS "workflowStepModels",
          workflow_step_cycles_json AS "workflowStepCycles",
          deleted_at AS "deletedAt"
        FROM projection_threads
        WHERE thread_id = ${threadId}
      `,
  });

  const listProjectionThreadRows = SqlSchema.findAll({
    Request: ListProjectionThreadsByProjectInput,
    Result: ProjectionThreadDbRow,
    execute: ({ projectId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          project_id AS "projectId",
          COALESCE(NULLIF(trim(owner_user_id), ''), ${DEFAULT_WORKSPACE_USER_ID}) AS "ownerUserId",
          parent_thread_id AS "parentThreadId",
          workflow_role AS "workflowRole",
          CASE
            WHEN workflow_id IS NULL OR workflow_root_thread_id IS NULL THEN NULL
            ELSE json_object(
              'workflowId', workflow_id,
              'parentWorkflowId', workflow_parent_id,
              'rootThreadId', workflow_root_thread_id,
              'ticketScope', json(workflow_ticket_scope_json)
            )
          END AS "workflowContext",
          workflow_subagent_batch_id AS "workflowSubagentBatchId",
          workflow_subagent_child_index AS "workflowSubagentChildIndex",
          title,
          model_selection_json AS "modelSelection",
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          workflow_preset AS "workflowPreset",
          branch,
          worktree_path AS "worktreePath",
          latest_turn_id AS "latestTurnId",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt",
          settled_override AS "settledOverride",
          settled_at AS "settledAt",
          workflow_paused_at AS "workflowPausedAt",
          snoozed_until AS "snoozedUntil",
          snoozed_at AS "snoozedAt",
          pinned_at AS "pinnedAt",
          pin_order_key AS "pinOrderKey",
          title_regeneration_request_id AS "titleRegenerationRequestId",
          title_regeneration_started_at AS "titleRegenerationStartedAt",
          latest_user_message_at AS "latestUserMessageAt",
          pending_approval_count AS "pendingApprovalCount",
          pending_user_input_count AS "pendingUserInputCount",
          has_actionable_proposed_plan AS "hasActionableProposedPlan",
          planning_workflow_stage AS "planningWorkflowStage",
          planning_active_review_json AS "planningActiveReview",
          workflow_step_models_json AS "workflowStepModels",
          workflow_step_cycles_json AS "workflowStepCycles",
          deleted_at AS "deletedAt"
        FROM projection_threads
        WHERE project_id = ${projectId}
        ORDER BY created_at ASC, thread_id ASC
      `,
  });

  const deleteProjectionThreadRow = SqlSchema.void({
    Request: DeleteProjectionThreadInput,
    execute: ({ threadId }) =>
      sql`
        DELETE FROM projection_threads
        WHERE thread_id = ${threadId}
      `,
  });

  const upsert: ProjectionThreadRepositoryShape["upsert"] = Effect.fn(
    "ProjectionThreadRepository.upsert",
  )(function* (row) {
    yield* upsertProjectionThreadRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadRepository.upsert:query")),
    );
    yield* sql`DELETE FROM projection_thread_workflow_membership WHERE thread_id = ${row.threadId}`.pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadRepository.upsert:deleteMembership")),
    );
    yield* sql`DELETE FROM projection_thread_ticket_scope WHERE thread_id = ${row.threadId}`.pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadRepository.upsert:deleteTicketScope")),
    );
    if (row.workflowContext == null) return;
    yield* sql`
      INSERT INTO projection_thread_workflow_membership (
        thread_id, project_id, workflow_id, parent_workflow_id, root_thread_id,
        created_at, updated_at
      ) VALUES (
        ${row.threadId}, ${row.projectId}, ${row.workflowContext.workflowId},
        ${row.workflowContext.parentWorkflowId ?? null}, ${row.workflowContext.rootThreadId},
        ${row.createdAt}, ${row.updatedAt}
      )
    `.pipe(Effect.mapError(toPersistenceSqlError("ProjectionThreadRepository.upsert:membership")));
    yield* Effect.forEach(
      row.workflowContext.ticketScope,
      (ticketId) =>
        sql`
          INSERT OR IGNORE INTO projection_thread_ticket_scope(thread_id, ticket_id)
          VALUES (${row.threadId}, ${ticketId})
        `.pipe(
          Effect.mapError(toPersistenceSqlError("ProjectionThreadRepository.upsert:ticketScope")),
        ),
      { concurrency: 1, discard: true },
    );
  });

  const getById: ProjectionThreadRepositoryShape["getById"] = (input) =>
    getProjectionThreadRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadRepository.getById:query")),
    );

  const listByProjectId: ProjectionThreadRepositoryShape["listByProjectId"] = (input) =>
    listProjectionThreadRows(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadRepository.listByProjectId:query")),
    );

  const deleteById: ProjectionThreadRepositoryShape["deleteById"] = Effect.fn(
    "ProjectionThreadRepository.deleteById",
  )(function* (input) {
    yield* sql`DELETE FROM projection_thread_ticket_scope WHERE thread_id = ${input.threadId}`.pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadRepository.deleteById:ticketScope")),
    );
    yield* sql`DELETE FROM projection_thread_workflow_membership WHERE thread_id = ${input.threadId}`.pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadRepository.deleteById:membership")),
    );
    yield* deleteProjectionThreadRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadRepository.deleteById:query")),
    );
  });

  return {
    upsert,
    getById,
    listByProjectId,
    deleteById,
  } satisfies ProjectionThreadRepositoryShape;
});

export const ProjectionThreadRepositoryLive = Layer.effect(
  ProjectionThreadRepository,
  makeProjectionThreadRepository,
);
