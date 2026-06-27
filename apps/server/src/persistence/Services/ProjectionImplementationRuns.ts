import {
  OrchestrationImplementationRun,
  OrchestrationImplementationRunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionImplementationRun = Schema.Struct({
  runId: OrchestrationImplementationRunId,
  sourceThreadId: ThreadId,
  run: OrchestrationImplementationRun,
});
export type ProjectionImplementationRun = typeof ProjectionImplementationRun.Type;

export interface ProjectionImplementationRunRepositoryShape {
  readonly upsert: (
    row: ProjectionImplementationRun,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ProjectionImplementationRunRepository extends Context.Service<
  ProjectionImplementationRunRepository,
  ProjectionImplementationRunRepositoryShape
>()("t3/persistence/Services/ProjectionImplementationRuns/ProjectionImplementationRunRepository") {}
