import type { ProjectId, ServerSettings } from "@t3tools/contracts";
import { DEVELOPMENT_BRANCH_NAME, resolveWorktreeBaseBranch } from "@t3tools/shared/git";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Effect from "effect/Effect";

import type { GitVcsDriver } from "./GitVcsDriver.ts";

export interface ProjectDevelopmentBranch {
  /** Branch name to start from; origin's copy when only origin has it. */
  readonly branch: string;
  /** False when only `origin/<branch>` exists, so a worktree must start from origin. */
  readonly existsLocally: boolean;
}

/**
 * The branch a new worktree of this project starts from when nobody picks one:
 * the project's `worktreeBaseBranch`, else `dev` when the repository has it
 * locally or on origin, else origin's default branch. Null when the checkout
 * names none of them. Git failures read as "not found".
 */
export const resolveProjectDevelopmentBranch = Effect.fn("resolveProjectDevelopmentBranch")(
  function* (input: {
    readonly git: GitVcsDriver["Service"];
    /** Null when the settings could not be read; the repository decides alone. */
    readonly settings: ServerSettings | null;
    readonly cwd: string;
    readonly projectId: ProjectId | null;
  }) {
    const { git } = input;
    const configured =
      input.settings === null
        ? null
        : resolveProjectSettings(input.settings, input.projectId).settings.worktreeBaseBranch;
    const localBranches = yield* git
      .listLocalBranchNames(input.cwd)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    const hasLocal = (branch: string) => localBranches.includes(branch);
    const hasOnOrigin = (branch: string) =>
      git
        .remoteBranchExists({ cwd: input.cwd, remoteName: "origin", refName: branch })
        .pipe(Effect.orElseSucceed(() => false));
    const developmentBranch =
      hasLocal(DEVELOPMENT_BRANCH_NAME) || (yield* hasOnOrigin(DEVELOPMENT_BRANCH_NAME))
        ? DEVELOPMENT_BRANCH_NAME
        : null;
    const defaultBranch =
      configured || developmentBranch
        ? null
        : yield* git
            .resolveDefaultBranchName(input.cwd, "origin")
            .pipe(Effect.orElseSucceed(() => null));
    const branch = resolveWorktreeBaseBranch({ configured, developmentBranch, defaultBranch });
    if (branch === null) return null;
    return {
      branch,
      existsLocally: hasLocal(branch) || !(yield* hasOnOrigin(branch)),
    } satisfies ProjectDevelopmentBranch;
  },
);
