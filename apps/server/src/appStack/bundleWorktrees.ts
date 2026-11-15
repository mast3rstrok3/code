import { AppStackError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { NativeCommandRunner } from "./nativeAppStackProvisioning.ts";

/**
 * Stacks only plans where a missing bundle worktree belongs; Code owns checkouts
 * and creates it. The branch is reused locally, tracked from origin, or started
 * from `origin/<baseBranch>`.
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

/**
 * Removes a worktree `createBundleWorktree` made when the bundle it was made
 * for never started. Not forced, so nothing written there is lost, and the
 * branch stays.
 */
export const removeBundleWorktree = (
  run: NativeCommandRunner,
  input: { readonly repositoryPath: string; readonly worktreePath: string },
) =>
  Effect.tryPromise({
    try: () => run("git", ["-C", input.repositoryPath, "worktree", "remove", input.worktreePath]),
    catch: (cause) =>
      new AppStackError({
        operation: "autoCreate",
        reason: "request_failed",
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning("could not remove an unused bundle worktree", {
        worktreePath: input.worktreePath,
        cause: error.message,
      }),
    ),
    Effect.asVoid,
  );
