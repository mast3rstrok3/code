import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  GitManagerError,
  GitCommandError,
  type VcsSwitchRefInput,
  type VcsSwitchRefResult,
  type VcsCreateRefInput,
  type VcsCreateRefResult,
  type VcsCreateWorktreeInput,
  type VcsCreateWorktreeResult,
  type VcsListRefsInput,
  type VcsListRefsResult,
  type GitManagerServiceError,
  type GitPreparePullRequestThreadInput,
  type GitPreparePullRequestThreadResult,
  type GitPullRequestRefInput,
  type VcsPullResult,
  type VcsRemoveWorktreeInput,
  type GitResolvePullRequestResult,
  type GitRunStackedActionInput,
  type GitRunStackedActionResult,
  type VcsStatusInput,
  type VcsStatusLocalResult,
  type VcsStatusRemoteResult,
  type VcsStatusResult,
  type ChangeRequest,
  type ThreadId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";

import * as GitManager from "./GitManager.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";

export interface GitMergeRefInput {
  readonly cwd: string;
  readonly refName: string;
}

export type GitMergeRefResult =
  | { readonly status: "already-integrated" }
  | { readonly status: "merged" }
  | { readonly status: "conflicted"; readonly conflictedFiles: ReadonlyArray<string> };

export class GitWorkflowService extends Context.Service<
  GitWorkflowService,
  {
    readonly status: (
      input: VcsStatusInput,
    ) => Effect.Effect<VcsStatusResult, GitManagerServiceError>;
    readonly localStatus: (
      input: VcsStatusInput,
    ) => Effect.Effect<VcsStatusLocalResult, GitManagerServiceError>;
    readonly remoteStatus: (
      input: VcsStatusInput,
      options?: GitVcsDriver.GitRemoteStatusOptions,
    ) => Effect.Effect<VcsStatusRemoteResult | null, GitManagerServiceError>;
    readonly invalidateLocalStatus: (cwd: string) => Effect.Effect<void, never>;
    readonly invalidateRemoteStatus: (cwd: string) => Effect.Effect<void, never>;
    readonly invalidateStatus: (cwd: string) => Effect.Effect<void, never>;
    readonly pullCurrentBranch: (cwd: string) => Effect.Effect<VcsPullResult, GitCommandError>;
    readonly runStackedAction: (
      input: GitRunStackedActionInput,
      options?: GitManager.GitRunStackedActionOptions,
    ) => Effect.Effect<GitRunStackedActionResult, GitManagerServiceError>;
    readonly resolvePullRequest: (
      input: GitPullRequestRefInput,
    ) => Effect.Effect<GitResolvePullRequestResult, GitManagerServiceError>;
    readonly preparePullRequestThread: (
      input: GitPreparePullRequestThreadInput,
    ) => Effect.Effect<GitPreparePullRequestThreadResult, GitManagerServiceError>;
    readonly listRefs: (
      input: VcsListRefsInput,
    ) => Effect.Effect<VcsListRefsResult, GitCommandError>;
    readonly createWorktree: (
      input: VcsCreateWorktreeInput,
    ) => Effect.Effect<VcsCreateWorktreeResult, GitCommandError>;
    readonly fetchRemote: (input: {
      readonly cwd: string;
      readonly remoteName: string;
    }) => Effect.Effect<void, GitCommandError>;
    readonly resolveRemoteTrackingCommit: (input: {
      readonly cwd: string;
      readonly refName: string;
      readonly fallbackRemoteName: string;
    }) => Effect.Effect<
      { readonly commitSha: string; readonly remoteRefName: string },
      GitCommandError
    >;
    readonly resolveCommit: (input: {
      readonly cwd: string;
      readonly ref: string;
    }) => Effect.Effect<{ readonly commitSha: string }, GitCommandError>;
    readonly isAncestor: (input: {
      readonly cwd: string;
      readonly ancestorRef: string;
      readonly descendantRef: string;
    }) => Effect.Effect<boolean, GitCommandError>;
    readonly listChangedFiles: (input: {
      readonly cwd: string;
      readonly baseRef: string;
      readonly headRef: string;
    }) => Effect.Effect<ReadonlyArray<string>, GitCommandError>;
    readonly mergeRef: (
      input: GitMergeRefInput,
    ) => Effect.Effect<GitMergeRefResult, GitCommandError>;
    readonly createOrOpenChangeRequest: (input: {
      readonly cwd: string;
      readonly actionId: string;
      readonly baseRefName: string;
      readonly headRefName: string;
      readonly expectedHeadSha: string;
      readonly threadId?: ThreadId;
      readonly commitMessage?: string;
    }) => Effect.Effect<ChangeRequest, GitManagerServiceError>;
    readonly removeWorktree: (
      input: VcsRemoveWorktreeInput,
    ) => Effect.Effect<void, GitCommandError>;
    readonly createRef: (
      input: VcsCreateRefInput,
    ) => Effect.Effect<VcsCreateRefResult, GitCommandError>;
    readonly switchRef: (
      input: VcsSwitchRefInput,
    ) => Effect.Effect<VcsSwitchRefResult, GitCommandError>;
    readonly renameBranch: (input: {
      readonly cwd: string;
      readonly oldBranch: string;
      readonly newBranch: string;
    }) => Effect.Effect<{ readonly branch: string }, GitManagerServiceError>;
  }
>()("t3/git/GitWorkflowService") {}

function nonRepositoryLocalStatus(): VcsStatusLocalResult {
  return {
    isRepo: false,
    hasPrimaryRemote: false,
    isDefaultRef: false,
    refName: null,
    hasWorkingTreeChanges: false,
    workingTree: {
      files: [],
      insertions: 0,
      deletions: 0,
    },
  };
}

function nonRepositoryStatus(): VcsStatusResult {
  return {
    ...nonRepositoryLocalStatus(),
    hasUpstream: false,
    aheadCount: 0,
    behindCount: 0,
    aheadOfDefaultCount: 0,
    pr: null,
  };
}

function nonRepositoryListRefs(): VcsListRefsResult {
  return {
    refs: [],
    isRepo: false,
    hasPrimaryRemote: false,
    nextCursor: null,
    totalCount: 0,
  };
}

export const make = Effect.gen(function* () {
  const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const gitManager = yield* GitManager.GitManager;

  const ensureGit = Effect.fn("GitWorkflowService.ensureGit")(function* (
    operation: string,
    cwd: string,
  ) {
    const handle = yield* registry.resolve({ cwd }).pipe(
      Effect.mapError(
        (cause) =>
          new GitManagerError({
            operation,
            cwd,
            detail: "Failed to resolve the VCS driver for this Git workflow.",
            cause,
          }),
      ),
    );
    if (handle.kind !== "git") {
      return yield* new GitManagerError({
        operation,
        cwd,
        detail: `The ${operation} workflow currently supports Git repositories only; detected ${handle.kind}. (${cwd})`,
      });
    }
  });

  const ensureGitCommand = Effect.fn("GitWorkflowService.ensureGitCommand")(function* (
    operation: string,
    cwd: string,
  ) {
    const handle = yield* registry.resolve({ cwd }).pipe(
      Effect.mapError(
        (cause) =>
          new GitCommandError({
            operation,
            command: "vcs-route",
            cwd,
            detail: "Failed to resolve the VCS driver for this Git command.",
            cause,
          }),
      ),
    );
    if (handle.kind !== "git") {
      return yield* new GitCommandError({
        operation,
        command: "vcs-route",
        cwd,
        detail: `The ${operation} command currently supports Git repositories only; detected ${handle.kind}.`,
      });
    }
  });

  const detectGitRepositoryForStatus = Effect.fn("GitWorkflowService.detectGitRepositoryForStatus")(
    function* (operation: string, cwd: string) {
      const handle = yield* registry.detect({ cwd }).pipe(
        Effect.mapError(
          (cause) =>
            new GitManagerError({
              operation,
              cwd,
              detail: "Failed to detect a VCS repository for this Git workflow.",
              cause,
            }),
        ),
      );
      if (!handle) {
        return false;
      }
      if (handle.kind !== "git") {
        return yield* new GitManagerError({
          operation,
          cwd,
          detail: `The ${operation} workflow currently supports Git repositories only; detected ${handle.kind}. (${cwd})`,
        });
      }
      return true;
    },
  );

  const detectGitRepositoryForCommand = Effect.fn(
    "GitWorkflowService.detectGitRepositoryForCommand",
  )(function* (operation: string, cwd: string) {
    const handle = yield* registry.detect({ cwd }).pipe(
      Effect.mapError(
        (cause) =>
          new GitCommandError({
            operation,
            command: "vcs-route",
            cwd,
            detail: "Failed to detect a VCS repository for this Git command.",
            cause,
          }),
      ),
    );
    if (!handle) {
      return false;
    }
    if (handle.kind !== "git") {
      return yield* new GitCommandError({
        operation,
        command: "vcs-route",
        cwd,
        detail: `The ${operation} command currently supports Git repositories only; detected ${handle.kind}.`,
      });
    }
    return true;
  });

  const routeGitManager =
    <Input extends { readonly cwd: string }, Output>(
      operation: string,
      run: (input: Input) => Effect.Effect<Output, GitManagerServiceError>,
    ) =>
    (input: Input) =>
      ensureGit(operation, input.cwd).pipe(Effect.andThen(run(input)));

  const mergeRef = Effect.fn("GitWorkflowService.mergeRef")(function* (input: GitMergeRefInput) {
    yield* ensureGitCommand("GitWorkflowService.mergeRef", input.cwd);

    const ancestor = yield* git.execute({
      operation: "GitWorkflowService.mergeRef.isAncestor",
      cwd: input.cwd,
      args: ["merge-base", "--is-ancestor", input.refName, "HEAD"],
      allowNonZeroExit: true,
      maxOutputBytes: 4_096,
    });
    if (ancestor.exitCode === 0) {
      return { status: "already-integrated" as const };
    }
    if (ancestor.exitCode !== 1) {
      return yield* new GitCommandError({
        operation: "GitWorkflowService.mergeRef",
        command: "git merge-base --is-ancestor",
        cwd: input.cwd,
        detail:
          ancestor.stderr.trim() ||
          `Failed to inspect whether '${input.refName}' is already integrated.`,
      });
    }

    const merged = yield* git.execute({
      operation: "GitWorkflowService.mergeRef.merge",
      cwd: input.cwd,
      args: ["merge", "--no-ff", "--no-edit", input.refName],
      allowNonZeroExit: true,
      maxOutputBytes: 64 * 1_024,
      appendTruncationMarker: true,
    });
    yield* gitManager.invalidateStatus(input.cwd);
    if (merged.exitCode === 0) {
      return { status: "merged" as const };
    }

    const unmerged = yield* git.execute({
      operation: "GitWorkflowService.mergeRef.listConflicts",
      cwd: input.cwd,
      args: ["diff", "--name-only", "--diff-filter=U", "-z"],
      maxOutputBytes: 64 * 1_024,
    });
    const conflictedFiles = unmerged.stdout.split("\0").filter((file) => file.length > 0);
    if (conflictedFiles.length > 0) {
      return { status: "conflicted" as const, conflictedFiles };
    }

    yield* git
      .execute({
        operation: "GitWorkflowService.mergeRef.abort",
        cwd: input.cwd,
        args: ["merge", "--abort"],
        allowNonZeroExit: true,
        maxOutputBytes: 4_096,
      })
      .pipe(Effect.ignore);
    yield* gitManager.invalidateStatus(input.cwd);
    return yield* new GitCommandError({
      operation: "GitWorkflowService.mergeRef",
      command: "git merge --no-ff --no-edit",
      cwd: input.cwd,
      detail: merged.stderr.trim() || `Failed to merge '${input.refName}'.`,
    });
  });

  return GitWorkflowService.of({
    status: (input) =>
      detectGitRepositoryForStatus("GitWorkflowService.status", input.cwd).pipe(
        Effect.flatMap((isGitRepository) =>
          isGitRepository ? gitManager.status(input) : Effect.succeed(nonRepositoryStatus()),
        ),
      ),
    localStatus: (input) =>
      detectGitRepositoryForStatus("GitWorkflowService.localStatus", input.cwd).pipe(
        Effect.flatMap((isGitRepository) =>
          isGitRepository
            ? gitManager.localStatus(input)
            : Effect.succeed(nonRepositoryLocalStatus()),
        ),
      ),
    remoteStatus: (input, options) =>
      detectGitRepositoryForStatus("GitWorkflowService.remoteStatus", input.cwd).pipe(
        Effect.flatMap((isGitRepository) =>
          isGitRepository ? gitManager.remoteStatus(input, options) : Effect.succeed(null),
        ),
      ),
    invalidateLocalStatus: gitManager.invalidateLocalStatus,
    invalidateRemoteStatus: gitManager.invalidateRemoteStatus,
    invalidateStatus: gitManager.invalidateStatus,
    pullCurrentBranch: (cwd) =>
      ensureGitCommand("GitWorkflowService.pullCurrentBranch", cwd).pipe(
        Effect.andThen(git.pullCurrentBranch(cwd)),
      ),
    runStackedAction: (input, options) =>
      ensureGit("GitWorkflowService.runStackedAction", input.cwd).pipe(
        Effect.andThen(gitManager.runStackedAction(input, options)),
      ),
    resolvePullRequest: routeGitManager(
      "GitWorkflowService.resolvePullRequest",
      gitManager.resolvePullRequest,
    ),
    preparePullRequestThread: routeGitManager(
      "GitWorkflowService.preparePullRequestThread",
      gitManager.preparePullRequestThread,
    ),
    listRefs: (input) =>
      detectGitRepositoryForCommand("GitWorkflowService.listRefs", input.cwd).pipe(
        Effect.flatMap((isGitRepository) =>
          isGitRepository ? git.listRefs(input) : Effect.succeed(nonRepositoryListRefs()),
        ),
      ),
    createWorktree: (input) =>
      ensureGitCommand("GitWorkflowService.createWorktree", input.cwd).pipe(
        Effect.andThen(git.createWorktree(input)),
      ),
    fetchRemote: (input) =>
      ensureGitCommand("GitWorkflowService.fetchRemote", input.cwd).pipe(
        Effect.andThen(git.fetchRemote(input)),
      ),
    resolveRemoteTrackingCommit: (input) =>
      ensureGitCommand("GitWorkflowService.resolveRemoteTrackingCommit", input.cwd).pipe(
        Effect.andThen(git.resolveRemoteTrackingCommit(input)),
      ),
    resolveCommit: (input) =>
      ensureGitCommand("GitWorkflowService.resolveCommit", input.cwd).pipe(
        Effect.andThen(
          git.execute({
            operation: "GitWorkflowService.resolveCommit",
            cwd: input.cwd,
            args: ["rev-parse", "--verify", `${input.ref}^{commit}`],
            maxOutputBytes: 1024,
          }),
        ),
        Effect.map((result) => ({ commitSha: result.stdout.trim() })),
      ),
    isAncestor: (input) =>
      ensureGitCommand("GitWorkflowService.isAncestor", input.cwd).pipe(
        Effect.andThen(
          git.execute({
            operation: "GitWorkflowService.isAncestor",
            cwd: input.cwd,
            args: ["merge-base", "--is-ancestor", input.ancestorRef, input.descendantRef],
            allowNonZeroExit: true,
            maxOutputBytes: 4_096,
          }),
        ),
        Effect.flatMap((result) => {
          if (result.exitCode === 0) return Effect.succeed(true);
          if (result.exitCode === 1) return Effect.succeed(false);
          return Effect.fail(
            new GitCommandError({
              operation: "GitWorkflowService.isAncestor",
              command: "git merge-base --is-ancestor",
              cwd: input.cwd,
              detail: result.stderr.trim() || "Failed to inspect commit ancestry.",
            }),
          );
        }),
      ),
    listChangedFiles: (input) =>
      ensureGitCommand("GitWorkflowService.listChangedFiles", input.cwd).pipe(
        Effect.andThen(
          git.execute({
            operation: "GitWorkflowService.listChangedFiles",
            cwd: input.cwd,
            args: ["diff", "--name-only", "-z", input.baseRef, input.headRef],
            maxOutputBytes: 256 * 1_024,
          }),
        ),
        Effect.map((result) => result.stdout.split("\0").filter((path) => path.length > 0)),
      ),
    mergeRef,
    createOrOpenChangeRequest: (input) =>
      ensureGit("GitWorkflowService.createOrOpenChangeRequest", input.cwd).pipe(
        Effect.andThen(
          Effect.gen(function* () {
            yield* gitManager.invalidateStatus(input.cwd);
            const [status, head] = yield* Effect.all([
              gitManager.localStatus({ cwd: input.cwd }),
              git.execute({
                operation: "GitWorkflowService.createOrOpenChangeRequest.resolveHead",
                cwd: input.cwd,
                args: ["rev-parse", "--verify", "HEAD^{commit}"],
                maxOutputBytes: 1_024,
              }),
            ]);
            const headSha = head.stdout.trim();
            if (status.hasWorkingTreeChanges) {
              return yield* new GitManagerError({
                operation: "GitWorkflowService.createOrOpenChangeRequest",
                cwd: input.cwd,
                detail: "Cannot publish a reviewed change request from a dirty worktree.",
              });
            }
            if (!status.isRepo || status.refName !== input.headRefName) {
              return yield* new GitManagerError({
                operation: "GitWorkflowService.createOrOpenChangeRequest",
                cwd: input.cwd,
                detail: `Expected reviewed branch '${input.headRefName}', but Git reports '${status.refName ?? "detached HEAD"}'.`,
              });
            }
            if (headSha !== input.expectedHeadSha) {
              return yield* new GitManagerError({
                operation: "GitWorkflowService.createOrOpenChangeRequest",
                cwd: input.cwd,
                detail: `Reviewed HEAD '${input.expectedHeadSha}' moved to '${headSha}' before publication.`,
              });
            }
            return yield* gitManager.runStackedAction({
              actionId: input.actionId,
              cwd: input.cwd,
              action: "commit_push_pr",
              pullRequestBaseBranch: input.baseRefName,
              ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
              ...(input.commitMessage !== undefined ? { commitMessage: input.commitMessage } : {}),
            });
          }),
        ),
        Effect.flatMap((result) =>
          gitManager.status({ cwd: input.cwd }).pipe(
            Effect.flatMap((status) => {
              const pr = status.pr;
              const fallbackPr = result.pr;
              const number = pr?.number ?? fallbackPr.number;
              const title = pr?.title ?? fallbackPr.title;
              const url = pr?.url ?? fallbackPr.url;
              const baseRefName = pr?.baseRef ?? fallbackPr.baseBranch;
              const headRefName = pr?.headRef ?? fallbackPr.headBranch;
              if (
                number === undefined ||
                title === undefined ||
                url === undefined ||
                baseRefName === undefined ||
                headRefName === undefined
              ) {
                return Effect.fail(
                  new GitManagerError({
                    operation: "GitWorkflowService.createOrOpenChangeRequest",
                    cwd: input.cwd,
                    detail: "Git action completed but no change request could be resolved.",
                  }),
                );
              }
              if (baseRefName !== input.baseRefName) {
                return Effect.fail(
                  new GitManagerError({
                    operation: "GitWorkflowService.createOrOpenChangeRequest",
                    cwd: input.cwd,
                    detail: `Published change request targets '${baseRefName}', but '${input.baseRefName}' is required.`,
                  }),
                );
              }
              if (headRefName !== input.headRefName) {
                return Effect.fail(
                  new GitManagerError({
                    operation: "GitWorkflowService.createOrOpenChangeRequest",
                    cwd: input.cwd,
                    detail: `Published change request uses head '${headRefName}', but '${input.headRefName}' is required.`,
                  }),
                );
              }
              return Effect.succeed({
                provider: status.sourceControlProvider?.kind ?? "unknown",
                number,
                title,
                url,
                baseRefName,
                headRefName,
                state: pr?.state ?? "open",
                updatedAt: Option.none(),
              } satisfies ChangeRequest);
            }),
          ),
        ),
      ),
    removeWorktree: (input) =>
      ensureGitCommand("GitWorkflowService.removeWorktree", input.cwd).pipe(
        Effect.andThen(git.removeWorktree(input)),
      ),
    createRef: (input) =>
      ensureGitCommand("GitWorkflowService.createRef", input.cwd).pipe(
        Effect.andThen(git.createRef(input)),
      ),
    switchRef: (input) =>
      ensureGitCommand("GitWorkflowService.switchRef", input.cwd).pipe(
        Effect.andThen(Effect.scoped(git.switchRef(input))),
      ),
    renameBranch: (input) =>
      ensureGit("GitWorkflowService.renameBranch", input.cwd).pipe(
        Effect.andThen(git.renameBranch(input)),
      ),
  });
});

export const layer = Layer.effect(GitWorkflowService, make);
