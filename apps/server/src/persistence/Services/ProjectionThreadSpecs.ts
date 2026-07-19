import {
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  OrchestrationPlanningSpecId,
  ThreadId,
  TrimmedNonEmptyString,
  WorkflowId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionThreadSpec = Schema.Struct({
  specId: OrchestrationPlanningSpecId,
  threadId: ThreadId,
  title: TrimmedNonEmptyString,
  summaryMarkdown: TrimmedNonEmptyString,
  tenantId: Schema.NullOr(TrimmedNonEmptyString),
  teamId: Schema.NullOr(TrimmedNonEmptyString),
  sourceThreadId: ThreadId,
  sourceMessageIds: Schema.Array(MessageId),
  createdBy: Schema.NullOr(TrimmedNonEmptyString),
  workflowId: WorkflowId,
  ticketCount: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ProjectionThreadSpec = typeof ProjectionThreadSpec.Type;

export const ListProjectionThreadSpecsInput = Schema.Struct({
  threadId: ThreadId,
});
export type ListProjectionThreadSpecsInput = typeof ListProjectionThreadSpecsInput.Type;

export const DeleteProjectionThreadSpecsInput = Schema.Struct({
  threadId: ThreadId,
});
export type DeleteProjectionThreadSpecsInput = typeof DeleteProjectionThreadSpecsInput.Type;

export interface ProjectionThreadSpecRepositoryShape {
  readonly upsert: (spec: ProjectionThreadSpec) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly listByThreadId: (
    input: ListProjectionThreadSpecsInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionThreadSpec>, ProjectionRepositoryError>;
  readonly deleteByThreadId: (
    input: DeleteProjectionThreadSpecsInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ProjectionThreadSpecRepository extends Context.Service<
  ProjectionThreadSpecRepository,
  ProjectionThreadSpecRepositoryShape
>()("t3/persistence/Services/ProjectionThreadSpecs/ProjectionThreadSpecRepository") {}
