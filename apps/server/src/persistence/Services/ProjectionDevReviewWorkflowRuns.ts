import { DevReviewWorkflowRun, DevReviewWorkflowRunId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionDevReviewWorkflowRun = Schema.Struct({
  runId: DevReviewWorkflowRunId,
  sourceThreadId: ThreadId,
  run: DevReviewWorkflowRun,
});
export type ProjectionDevReviewWorkflowRun = typeof ProjectionDevReviewWorkflowRun.Type;

export interface ProjectionDevReviewWorkflowRunRepositoryShape {
  readonly upsert: (
    row: ProjectionDevReviewWorkflowRun,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ProjectionDevReviewWorkflowRunRepository extends Context.Service<
  ProjectionDevReviewWorkflowRunRepository,
  ProjectionDevReviewWorkflowRunRepositoryShape
>()(
  "t3/persistence/Services/ProjectionDevReviewWorkflowRuns/ProjectionDevReviewWorkflowRunRepository",
) {}
