import {
  IsoDateTime,
  NonNegativeInt,
  OrchestrationPlanningIssue,
  OrchestrationPlanningIssueDependency,
  OrchestrationPlanningIssueId,
  OrchestrationPlanningPrdId,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionThreadPlanningIssue = Schema.Struct({
  issueId: OrchestrationPlanningIssueId,
  prdId: OrchestrationPlanningPrdId,
  threadId: ThreadId,
  ordinal: NonNegativeInt,
  title: TrimmedNonEmptyString,
  bodyMarkdown: TrimmedNonEmptyString,
  dependencies: Schema.Array(OrchestrationPlanningIssueDependency),
  status: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ProjectionThreadPlanningIssue = typeof ProjectionThreadPlanningIssue.Type;

export function projectionIssueFromContract(
  threadId: ThreadId,
  issue: OrchestrationPlanningIssue,
): ProjectionThreadPlanningIssue {
  return {
    issueId: issue.id,
    prdId: issue.prdId,
    threadId,
    ordinal: issue.ordinal,
    title: issue.title,
    bodyMarkdown: issue.bodyMarkdown,
    dependencies: issue.dependencies,
    status: issue.status,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
  };
}

export function projectionIssueToContract(
  issue: ProjectionThreadPlanningIssue,
): OrchestrationPlanningIssue {
  return {
    id: issue.issueId,
    prdId: issue.prdId,
    ordinal: issue.ordinal,
    title: issue.title,
    bodyMarkdown: issue.bodyMarkdown,
    dependencies: issue.dependencies,
    status: issue.status,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
  };
}

export const ListProjectionThreadPlanningIssuesInput = Schema.Struct({
  threadId: ThreadId,
});
export type ListProjectionThreadPlanningIssuesInput =
  typeof ListProjectionThreadPlanningIssuesInput.Type;

export const DeleteProjectionThreadPlanningIssuesInput = Schema.Struct({
  threadId: ThreadId,
});
export type DeleteProjectionThreadPlanningIssuesInput =
  typeof DeleteProjectionThreadPlanningIssuesInput.Type;

export interface ProjectionThreadPlanningIssueRepositoryShape {
  readonly upsert: (
    issue: ProjectionThreadPlanningIssue,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly listByThreadId: (
    input: ListProjectionThreadPlanningIssuesInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionThreadPlanningIssue>, ProjectionRepositoryError>;
  readonly deleteByThreadId: (
    input: DeleteProjectionThreadPlanningIssuesInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ProjectionThreadPlanningIssueRepository extends Context.Service<
  ProjectionThreadPlanningIssueRepository,
  ProjectionThreadPlanningIssueRepositoryShape
>()(
  "t3/persistence/Services/ProjectionThreadPlanningIssues/ProjectionThreadPlanningIssueRepository",
) {}
