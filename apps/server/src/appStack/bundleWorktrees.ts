import { AppStackError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { NativeCommandRunner } from "./nativeAppStackProvisioning.ts";

/**
 * Creates the worktree a missing bundle member needs, on the bundle's branch.
 *
 * The Stacks controller never creates worktrees; its bundle plan says where a
 * missing one belongs and Code, which owns the checkouts, creates it there. The
 * branch is reused when it exists locally, tracked from origin when it was
 * pushed, and otherwise started from `origin/<baseBranch>`.
 */
export const createBundleWorktree = Effect.fn("createBundleWorktree")(function* (
  run: NativeCommandRunner,
  input: {
    readonly repositoryPath: string;
    readonly worktreePath: string;
    readonly branch: string;
    readonly baseBranch: string;
  },
) {
  const git = (args: ReadonlyArray<string>) =>
    Effect.tryPromise({
      try: () => run("git", ["-C", input.repositoryPath, ...args]),
      catch: (cause) =>
        new AppStackError({
          operation: "autoCreate",
          reason: "request_failed",
          message: `Could not create the worktree ${input.worktreePath} on branch ${input.branch}: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
          cause,
        }),
    });
  const hasRef = (ref: string) =>
    git(["show-ref", "--verify", "--quiet", ref]).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );

  yield* git(["fetch", "--quiet", "--no-tags", "origin"]);
  if (yield* hasRef(`refs/heads/${input.branch}`)) {
    yield* git(["worktree", "add", input.worktreePath, input.branch]);
  } else if (yield* hasRef(`refs/remotes/origin/${input.branch}`)) {
    yield* git([
      "worktree",
      "add",
      "--track",
      "-b",
      input.branch,
      input.worktreePath,
      `origin/${input.branch}`,
    ]);
  } else {
    yield* git([
      "worktree",
      "add",
      "--no-track",
      "-b",
      input.branch,
      input.worktreePath,
      `origin/${input.baseBranch}`,
    ]);
  }
});
