import { IsoDateTime, OrchestrationPlanningSpecId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionThreadLoadedSpecBundle = Schema.Struct({
  threadId: ThreadId,
  specId: OrchestrationPlanningSpecId,
  sourceThreadId: ThreadId,
  loadedAt: IsoDateTime,
});
export type ProjectionThreadLoadedSpecBundle = typeof ProjectionThreadLoadedSpecBundle.Type;

export const DeleteProjectionThreadLoadedSpecBundlesInput = Schema.Struct({
  threadId: ThreadId,
});
export type DeleteProjectionThreadLoadedSpecBundlesInput =
  typeof DeleteProjectionThreadLoadedSpecBundlesInput.Type;

export interface ProjectionThreadLoadedSpecBundleRepositoryShape {
  readonly upsert: (
    bundle: ProjectionThreadLoadedSpecBundle,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly deleteByThreadId: (
    input: DeleteProjectionThreadLoadedSpecBundlesInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ProjectionThreadLoadedSpecBundleRepository extends Context.Service<
  ProjectionThreadLoadedSpecBundleRepository,
  ProjectionThreadLoadedSpecBundleRepositoryShape
>()(
  "t3/persistence/Services/ProjectionThreadLoadedSpecBundles/ProjectionThreadLoadedSpecBundleRepository",
) {}
