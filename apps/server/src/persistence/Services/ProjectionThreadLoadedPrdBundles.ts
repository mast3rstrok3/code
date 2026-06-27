import { IsoDateTime, OrchestrationPlanningPrdId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionThreadLoadedPrdBundle = Schema.Struct({
  threadId: ThreadId,
  prdId: OrchestrationPlanningPrdId,
  sourceThreadId: ThreadId,
  loadedAt: IsoDateTime,
});
export type ProjectionThreadLoadedPrdBundle = typeof ProjectionThreadLoadedPrdBundle.Type;

export const DeleteProjectionThreadLoadedPrdBundlesInput = Schema.Struct({
  threadId: ThreadId,
});
export type DeleteProjectionThreadLoadedPrdBundlesInput =
  typeof DeleteProjectionThreadLoadedPrdBundlesInput.Type;

export interface ProjectionThreadLoadedPrdBundleRepositoryShape {
  readonly upsert: (
    bundle: ProjectionThreadLoadedPrdBundle,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly deleteByThreadId: (
    input: DeleteProjectionThreadLoadedPrdBundlesInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ProjectionThreadLoadedPrdBundleRepository extends Context.Service<
  ProjectionThreadLoadedPrdBundleRepository,
  ProjectionThreadLoadedPrdBundleRepositoryShape
>()(
  "t3/persistence/Services/ProjectionThreadLoadedPrdBundles/ProjectionThreadLoadedPrdBundleRepository",
) {}
