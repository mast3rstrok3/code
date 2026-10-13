import { assert, describe, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { resolveProjectDevelopmentBranch } from "./developmentBranch.ts";
import type { GitVcsDriver } from "./GitVcsDriver.ts";

const projectId = ProjectId.make("project-1");

function git(input: {
  readonly local: ReadonlyArray<string>;
  readonly origin: ReadonlyArray<string>;
  readonly defaultBranch: string | null;
}): GitVcsDriver["Service"] {
  return {
    listLocalBranchNames: () => Effect.succeed([...input.local]),
    remoteBranchExists: ({ refName }: { readonly refName: string }) =>
      Effect.succeed(input.origin.includes(refName)),
    resolveDefaultBranchName: () => Effect.succeed(input.defaultBranch),
  } as unknown as GitVcsDriver["Service"];
}

const resolve = (driver: GitVcsDriver["Service"], worktreeBaseBranch: string | null = null) =>
  resolveProjectDevelopmentBranch({
    git: driver,
    settings: {
      ...DEFAULT_SERVER_SETTINGS,
      projectSettingsOverrides:
        worktreeBaseBranch === null ? {} : { [projectId]: { worktreeBaseBranch } },
    },
    cwd: "/repo",
    projectId,
  });

describe("resolveProjectDevelopmentBranch", () => {
  it.effect("uses the project's branch, then dev, then origin's default", () =>
    Effect.gen(function* () {
      const repo = git({ local: ["main", "dev"], origin: ["main", "dev"], defaultBranch: "main" });
      assert.deepStrictEqual(yield* resolve(repo, "release"), {
        branch: "release",
        existsLocally: true,
      });
      assert.deepStrictEqual(yield* resolve(repo), { branch: "dev", existsLocally: true });
      assert.deepStrictEqual(
        yield* resolve(git({ local: ["main"], origin: ["main"], defaultBranch: "main" })),
        { branch: "main", existsLocally: true },
      );
      assert.strictEqual(yield* resolve(git({ local: [], origin: [], defaultBranch: null })), null);
    }),
  );

  it.effect("starts from origin when only origin has the development branch", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(
        yield* resolve(git({ local: ["main"], origin: ["main", "dev"], defaultBranch: "main" })),
        { branch: "dev", existsLocally: false },
      );
    }),
  );
});
