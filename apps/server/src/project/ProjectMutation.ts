import { type ProjectMutation } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { type ProjectService } from "./ProjectService.ts";

type ProjectMutations = Pick<ProjectService["Service"], "create" | "delete" | "update">;

// Create and update payloads are exactly their service inputs plus `type`, so
// forwarding the rest keeps new fields (such as the owner) from being dropped here.
export const projectMutationOperation = Effect.fn("projectMutationOperation")(function* (
  projects: ProjectMutations,
  mutation: ProjectMutation,
) {
  switch (mutation.type) {
    case "project.create": {
      const { type: _type, ...input } = mutation;
      return yield* projects.create(input);
    }
    case "project.update": {
      const { type: _type, ...input } = mutation;
      return yield* projects.update(input);
    }
    case "project.delete":
      return yield* projects.delete({
        commandId: mutation.commandId,
        projectId: mutation.projectId,
        ...(mutation.force === undefined ? {} : { force: mutation.force }),
      });
  }
});
