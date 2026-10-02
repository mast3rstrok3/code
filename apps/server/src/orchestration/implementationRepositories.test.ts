import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { GitCommandError, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import type { GitWorkflowService } from "../git/GitWorkflowService.ts";
import {
  repositoryValidationCommand,
  resolveImplementationRepositories,
} from "./implementationRepositories.ts";

const rudi = ProjectId.make("project-rudi");
const medical = ProjectId.make("project-medical-repository");

/** A repository whose checkout is on `checkedOut` and whose branches live locally or on origin. */
function gitWorkflow(input: {
  readonly localBranches: ReadonlyArray<string>;
  readonly remoteBranches: ReadonlyArray<string>;
  readonly checkedOut: string | null;
}) {
  const unknown = (ref: string) =>
    new GitCommandError({
      operation: "resolveCommit",
      command: "git rev-parse",
      cwd: "/repos/medical-repository",
      detail: `unknown revision '${ref}'`,
    });
  return {
    remoteExists: () => Effect.succeed(true),
    fetchRemote: () => Effect.void,
    remoteBranchExists: ({ refName }: { readonly refName: string }) =>
      Effect.succeed(input.remoteBranches.includes(refName)),
    resolveRemoteTrackingCommit: ({ refName }: { readonly refName: string }) =>
      Effect.succeed({ commitSha: `origin/${refName}@sha`, remoteRefName: `origin/${refName}` }),
    resolveCommit: ({ ref }: { readonly ref: string }) => {
      const branch = ref.replace(/^refs\/heads\//u, "");
      return input.localBranches.includes(branch)
        ? Effect.succeed({ commitSha: `${branch}@sha` })
        : Effect.fail(unknown(ref));
    },
    localStatus: () => Effect.succeed({ refName: input.checkedOut }),
  } as unknown as GitWorkflowService["Service"];
}

const resolve = (git: GitWorkflowService["Service"], projectId: ProjectId = medical) =>
  Effect.gen(function* () {
    return yield* resolveImplementationRepositories({
      gitWorkflow: git,
      path: yield* Path.Path,
      projects: [
        { id: rudi, workspaceRoot: "/repos/rudi" },
        { id: medical, workspaceRoot: "/repos/medical-repository" },
      ],
      tickets: [{}, { projectId: rudi }, { projectId }, { projectId }],
      workflowProjectId: rudi,
      baseBranch: "dev",
      orchestratorBranch: "implementation/studies",
      worktreesDir: "/var/lib/code/worktrees",
    });
  });

it.layer(NodeServices.layer)("resolveImplementationRepositories", (it) => {
  it.effect("prepares each other project once, on the workflow's base pinned to origin", () =>
    Effect.gen(function* () {
      const repositories = yield* resolve(
        gitWorkflow({ localBranches: ["dev"], remoteBranches: ["dev"], checkedOut: "dev" }),
      );
      expect(repositories).toEqual([
        {
          projectId: medical,
          repositoryPath: "/repos/medical-repository",
          worktreePath: "/var/lib/code/worktrees/medical-repository/implementation-studies",
          baseBranch: "dev",
          pinnedCommit: "origin/dev@sha",
          appReviewedHeadSha: null,
          codeReviewedHeadSha: null,
          validatedHeadSha: null,
          changeRequest: null,
        },
      ]);
    }),
  );

  it.effect("starts from the checkout's branch when the repository lacks the workflow's", () =>
    Effect.gen(function* () {
      const [repository] = yield* resolve(
        gitWorkflow({ localBranches: ["main"], remoteBranches: [], checkedOut: "main" }),
      );
      expect(repository?.baseBranch).toBe("main");
      expect(repository?.pinnedCommit).toBe("main@sha");
    }),
  );

  it.effect("fails for a project that no longer exists", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        resolve(
          gitWorkflow({ localBranches: ["dev"], remoteBranches: [], checkedOut: "dev" }),
          ProjectId.make("project-gone"),
        ),
      );
      expect(error.message).toContain("project-gone");
    }),
  );
});

it("runs a repository's validation command from its worktree", () => {
  expect(repositoryValidationCommand("/work/it's here", "pnpm check")).toBe(
    "cd '/work/it'\\''s here' && pnpm check",
  );
});
