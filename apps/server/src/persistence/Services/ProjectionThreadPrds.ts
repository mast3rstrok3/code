import {
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  OrchestrationPlanningPrdId,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionThreadPrd = Schema.Struct({
  prdId: OrchestrationPlanningPrdId,
  threadId: ThreadId,
  title: TrimmedNonEmptyString,
  summaryMarkdown: TrimmedNonEmptyString,
  tenantId: Schema.NullOr(TrimmedNonEmptyString),
  teamId: Schema.NullOr(TrimmedNonEmptyString),
  sourceThreadId: ThreadId,
  sourceMessageIds: Schema.Array(MessageId),
  createdBy: Schema.NullOr(TrimmedNonEmptyString),
  workflowId: TrimmedNonEmptyString,
  issueCount: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ProjectionThreadPrd = typeof ProjectionThreadPrd.Type;

export const ListProjectionThreadPrdsInput = Schema.Struct({
  threadId: ThreadId,
});
export type ListProjectionThreadPrdsInput = typeof ListProjectionThreadPrdsInput.Type;

export const DeleteProjectionThreadPrdsInput = Schema.Struct({
  threadId: ThreadId,
});
export type DeleteProjectionThreadPrdsInput = typeof DeleteProjectionThreadPrdsInput.Type;

export interface ProjectionThreadPrdRepositoryShape {
  readonly upsert: (prd: ProjectionThreadPrd) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly listByThreadId: (
    input: ListProjectionThreadPrdsInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionThreadPrd>, ProjectionRepositoryError>;
  readonly deleteByThreadId: (
    input: DeleteProjectionThreadPrdsInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ProjectionThreadPrdRepository extends Context.Service<
  ProjectionThreadPrdRepository,
  ProjectionThreadPrdRepositoryShape
>()("t3/persistence/Services/ProjectionThreadPrds/ProjectionThreadPrdRepository") {}
