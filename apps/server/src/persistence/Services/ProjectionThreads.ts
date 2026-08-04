/**
 * ProjectionThreadRepository - Projection repository interface for threads.
 *
 * Owns persistence operations for projected thread records in the
 * orchestration read model.
 *
 * @module ProjectionThreadRepository
 */
import {
  CommandId,
  IsoDateTime,
  ModelSelection,
  NonNegativeInt,
  ProjectId,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
  OrchestrationPlanningWorkflowStage,
  OrchestrationPlanningActiveReviewRequest,
  OrchestrationThreadWorkflowRole,
  ThreadWorkflowContext,
  WorkflowSubagentBatchId,
  TurnId,
  WorkspaceUserId,
  WorkflowPreset,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionThread = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  ownerUserId: WorkspaceUserId,
  parentThreadId: Schema.NullOr(ThreadId),
  workflowRole: Schema.NullOr(OrchestrationThreadWorkflowRole),
  workflowContext: Schema.optionalKey(Schema.NullOr(ThreadWorkflowContext)),
  workflowSubagentBatchId: Schema.optionalKey(Schema.NullOr(WorkflowSubagentBatchId)),
  workflowSubagentChildIndex: Schema.optionalKey(Schema.NullOr(NonNegativeInt)),
  title: Schema.String,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  workflowPreset: Schema.optionalKey(Schema.NullOr(WorkflowPreset)),
  branch: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(Schema.String),
  latestTurnId: Schema.NullOr(TurnId),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime),
  settledOverride: Schema.NullOr(Schema.Literals(["settled", "active"])),
  settledAt: Schema.NullOr(IsoDateTime),
  snoozedUntil: Schema.NullOr(IsoDateTime),
  snoozedAt: Schema.NullOr(IsoDateTime),
  titleRegenerationRequestId: Schema.optional(Schema.NullOr(CommandId)),
  titleRegenerationStartedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  latestUserMessageAt: Schema.NullOr(IsoDateTime),
  pendingApprovalCount: NonNegativeInt,
  pendingUserInputCount: NonNegativeInt,
  hasActionableProposedPlan: NonNegativeInt,
  planningWorkflowStage: Schema.NullOr(OrchestrationPlanningWorkflowStage),
  planningActiveReview: Schema.optionalKey(Schema.NullOr(OrchestrationPlanningActiveReviewRequest)),
  deletedAt: Schema.NullOr(IsoDateTime),
});
export type ProjectionThread = typeof ProjectionThread.Type;

export const GetProjectionThreadInput = Schema.Struct({
  threadId: ThreadId,
});
export type GetProjectionThreadInput = typeof GetProjectionThreadInput.Type;

export const DeleteProjectionThreadInput = Schema.Struct({
  threadId: ThreadId,
});
export type DeleteProjectionThreadInput = typeof DeleteProjectionThreadInput.Type;

export const ListProjectionThreadsByProjectInput = Schema.Struct({
  projectId: ProjectId,
});
export type ListProjectionThreadsByProjectInput = typeof ListProjectionThreadsByProjectInput.Type;

/**
 * ProjectionThreadRepositoryShape - Service API for projected thread records.
 */
export interface ProjectionThreadRepositoryShape {
  /**
   * Insert or replace a projected thread row.
   *
   * Upserts by `threadId`.
   */
  readonly upsert: (thread: ProjectionThread) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * Read a projected thread row by id.
   */
  readonly getById: (
    input: GetProjectionThreadInput,
  ) => Effect.Effect<Option.Option<ProjectionThread>, ProjectionRepositoryError>;

  /**
   * List projected threads for a project.
   *
   * Returned in deterministic creation order.
   */
  readonly listByProjectId: (
    input: ListProjectionThreadsByProjectInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionThread>, ProjectionRepositoryError>;

  /**
   * Soft-delete a projected thread row by id.
   */
  readonly deleteById: (
    input: DeleteProjectionThreadInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

/**
 * ProjectionThreadRepository - Service tag for thread projection persistence.
 */
export class ProjectionThreadRepository extends Context.Service<
  ProjectionThreadRepository,
  ProjectionThreadRepositoryShape
>()("t3/persistence/Services/ProjectionThreads/ProjectionThreadRepository") {}
