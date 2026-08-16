import { AppReviewWorkflowRun, AppReviewWorkflowRunId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionAppReviewWorkflowRun = Schema.Struct({
  runId: AppReviewWorkflowRunId,
  sourceThreadId: ThreadId,
  run: AppReviewWorkflowRun,
});
export type ProjectionAppReviewWorkflowRun = typeof ProjectionAppReviewWorkflowRun.Type;

export interface ProjectionAppReviewWorkflowRunRepositoryShape {
  readonly upsert: (
    row: ProjectionAppReviewWorkflowRun,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ProjectionAppReviewWorkflowRunRepository extends Context.Service<
  ProjectionAppReviewWorkflowRunRepository,
  ProjectionAppReviewWorkflowRunRepositoryShape
>()(
  "t3/persistence/Services/ProjectionAppReviewWorkflowRuns/ProjectionAppReviewWorkflowRunRepository",
) {}
