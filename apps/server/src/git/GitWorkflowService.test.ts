import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";

import { GitCommandError, VcsRepositoryDetectionError } from "@t3tools/contracts";

import { ServerConfig } from "../config.ts";
import * as GitManager from "./GitManager.ts";
import * as GitWorkflowService from "./GitWorkflowService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";

const GitDriverLayer = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "git-workflow-service-test-" })),
  Layer.provideMerge(NodeServices.layer),
);

const GitWorkflowMergeLayer = GitWorkflowService.layer.pipe(
  Layer.provide(GitDriverLayer),
  Layer.provide(
    Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
      resolve: ({ cwd }) =>
        Effect.succeed({
          kind: "git" as const,
          repository: { kind: "git", rootPath: cwd } as never,
          driver: {} as never,
        }),
    }),
  ),
  Layer.provide(
    Layer.mock(GitManager.GitManager)({
      invalidateStatus: () => Effect.void,
    }),
  ),
);

const MergeTestLayer = Layer.mergeAll(GitWorkflowMergeLayer, GitDriverLayer, NodeServices.layer);

const makeTmpDir = (): Effect.Effect<string, never, FileSystem.FileSystem | Scope.Scope> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.makeTempDirectoryScoped({ prefix: "git-workflow-merge-" });
  }).pipe(Effect.orDie);

const runGit = Effect.fn("GitWorkflowService.test.runGit")(function* (
  cwd: string,
  args: ReadonlyArray<string>,
) {
  const git = yield* GitVcsDriver.GitVcsDriver;
  const result = yield* git.execute({
    operation: "GitWorkflowService.test.runGit",
    cwd,
    args,
    maxOutputBytes: 64 * 1_024,
  });
  return result.stdout.trim();
});

const writeFile = Effect.fn("GitWorkflowService.test.writeFile")(function* (
  cwd: string,
  relativePath: string,
  contents: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.writeFileString(path.join(cwd, relativePath), contents);
});

const initRepo = Effect.fn("GitWorkflowService.test.initRepo")(function* (cwd: string) {
  yield* runGit(cwd, ["init", "-b", "main"]);
  yield* runGit(cwd, ["config", "user.email", "test@example.com"]);
  yield* runGit(cwd, ["config", "user.name", "Test"]);
  yield* writeFile(cwd, "shared.txt", "base\n");
  yield* runGit(cwd, ["add", "."]);
  yield* runGit(cwd, ["commit", "-m", "base"]);
});

function makeLayer(input: {
  readonly detect: VcsDriverRegistry.VcsDriverRegistry["Service"]["detect"];
}) {
  return GitWorkflowService.layer.pipe(
    Layer.provide(
      Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
        detect: input.detect,
      }),
    ),
    Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
    Layer.provide(Layer.mock(GitManager.GitManager)({})),
  );
}

describe("GitWorkflowService", () => {
  it.effect("returns an empty local status when no VCS repository is detected", () =>
    Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const status = yield* workflow.localStatus({ cwd: "/not-a-repo" });

      assert.deepStrictEqual(status, {
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
      });
    }).pipe(
      Effect.provide(
        makeLayer({
          detect: () => Effect.succeed(null),
        }),
      ),
    ),
  );

  it.effect("returns an empty full status when no VCS repository is detected", () =>
    Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const status = yield* workflow.status({ cwd: "/not-a-repo" });

      assert.deepStrictEqual(status, {
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
        hasUpstream: false,
        aheadCount: 0,
        behindCount: 0,
        aheadOfDefaultCount: 0,
        pr: null,
      });
    }).pipe(
      Effect.provide(
        makeLayer({
          detect: () => Effect.succeed(null),
        }),
      ),
    ),
  );

  it.effect("does not call GitManager status methods when no VCS repository is detected", () => {
    const localStatus = vi.fn();
    const remoteStatus = vi.fn();
    const status = vi.fn();

    const testLayer = GitWorkflowService.layer.pipe(
      Layer.provide(
        Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
          detect: () => Effect.succeed(null),
        }),
      ),
      Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
      Layer.provide(
        Layer.mock(GitManager.GitManager)({
          localStatus,
          remoteStatus,
          status,
        }),
      ),
    );

    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      yield* workflow.localStatus({ cwd: "/not-a-repo" });
      yield* workflow.remoteStatus({ cwd: "/not-a-repo" });
      yield* workflow.status({ cwd: "/not-a-repo" });

      assert.equal(localStatus.mock.calls.length, 0);
      assert.equal(remoteStatus.mock.calls.length, 0);
      assert.equal(status.mock.calls.length, 0);
    }).pipe(Effect.provide(testLayer));
  });

  it.effect("returns an empty ref list when no VCS repository is detected", () =>
    Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const refs = yield* workflow.listRefs({ cwd: "/not-a-repo" });

      assert.deepStrictEqual(refs, {
        refs: [],
        isRepo: false,
        hasPrimaryRemote: false,
        nextCursor: null,
        totalCount: 0,
      });
    }).pipe(
      Effect.provide(
        makeLayer({
          detect: () => Effect.succeed(null),
        }),
      ),
    ),
  );

  it.effect("structures workflow detection failures without exposing upstream details", () => {
    const cause = new VcsRepositoryDetectionError({
      operation: "VcsDriverRegistry.detect",
      cwd: "/repo",
      detail: "upstream detail must stay in the cause chain",
    });

    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const error = yield* workflow.status({ cwd: "/repo" }).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "GitManagerError",
        operation: "GitWorkflowService.status",
        cwd: "/repo",
        detail: "Failed to detect a VCS repository for this Git workflow.",
      });
      expect(error.message).not.toContain(cause.detail);
    }).pipe(
      Effect.provide(
        makeLayer({
          detect: () => Effect.fail(cause),
        }),
      ),
    );
  });

  it.effect("structures command detection failures without exposing upstream details", () => {
    const cause = new VcsRepositoryDetectionError({
      operation: "VcsDriverRegistry.detect",
      cwd: "/repo",
      detail: "upstream command detail must stay in the cause chain",
    });

    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const error = yield* workflow.listRefs({ cwd: "/repo" }).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "GitCommandError",
        operation: "GitWorkflowService.listRefs",
        command: "vcs-route",
        cwd: "/repo",
        detail: "Failed to detect a VCS repository for this Git command.",
      });
      expect(error.message).not.toContain(cause.detail);
    }).pipe(
      Effect.provide(
        makeLayer({
          detect: () => Effect.fail(cause),
        }),
      ),
    );
  });
});

it.layer(MergeTestLayer)("GitWorkflowService mergeRef", (it) => {
  it.effect("canonicalizes short and full commit refs to the same SHA", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      yield* initRepo(cwd);
      const fullSha = yield* runGit(cwd, ["rev-parse", "HEAD"]);
      const shortSha = yield* runGit(cwd, ["rev-parse", "--short=8", "HEAD"]);
      const workflow = yield* GitWorkflowService.GitWorkflowService;

      expect((yield* workflow.resolveCommit({ cwd, ref: shortSha })).commitSha).toBe(fullSha);
      expect((yield* workflow.resolveCommit({ cwd, ref: fullSha })).commitSha).toBe(fullSha);
    }),
  );

  it.effect("checks commit ancestry without comparing ref spellings", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      yield* initRepo(cwd);
      const baseSha = yield* runGit(cwd, ["rev-parse", "HEAD"]);
      yield* writeFile(cwd, "feature.txt", "feature\n");
      yield* runGit(cwd, ["add", "."]);
      yield* runGit(cwd, ["commit", "-m", "feature"]);
      const headSha = yield* runGit(cwd, ["rev-parse", "HEAD"]);
      const workflow = yield* GitWorkflowService.GitWorkflowService;

      expect(
        yield* workflow.isAncestor({ cwd, ancestorRef: baseSha, descendantRef: headSha }),
      ).toBe(true);
      expect(
        yield* workflow.isAncestor({ cwd, ancestorRef: headSha, descendantRef: baseSha }),
      ).toBe(false);
    }),
  );

  it.effect("lists files changed between two fixed commits", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      yield* initRepo(cwd);
      const baseRef = yield* runGit(cwd, ["rev-parse", "HEAD"]);
      yield* writeFile(cwd, "mobile.ts", "feature\n");
      yield* writeFile(cwd, "server.ts", "server\n");
      yield* runGit(cwd, ["add", "."]);
      yield* runGit(cwd, ["commit", "-m", "feature"]);

      const workflow = yield* GitWorkflowService.GitWorkflowService;
      assert.deepStrictEqual(yield* workflow.listChangedFiles({ cwd, baseRef, headRef: "HEAD" }), [
        "mobile.ts",
        "server.ts",
      ]);
    }),
  );

  it.effect("merges a branch and treats a repeated merge as already integrated", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      yield* initRepo(cwd);
      yield* runGit(cwd, ["checkout", "-b", "feature"]);
      yield* writeFile(cwd, "feature.txt", "feature\n");
      yield* runGit(cwd, ["add", "."]);
      yield* runGit(cwd, ["commit", "-m", "feature"]);
      yield* runGit(cwd, ["checkout", "main"]);

      const workflow = yield* GitWorkflowService.GitWorkflowService;
      assert.deepStrictEqual(yield* workflow.mergeRef({ cwd, refName: "feature" }), {
        status: "merged",
      });
      assert.deepStrictEqual(yield* workflow.mergeRef({ cwd, refName: "feature" }), {
        status: "already-integrated",
      });
      assert.equal(yield* runGit(cwd, ["show", "HEAD:feature.txt"]), "feature");
    }),
  );

  it.effect("returns conflicted files and leaves the merge for an agent to resolve", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      yield* initRepo(cwd);
      yield* runGit(cwd, ["checkout", "-b", "feature"]);
      yield* writeFile(cwd, "shared.txt", "feature\n");
      yield* runGit(cwd, ["add", "."]);
      yield* runGit(cwd, ["commit", "-m", "feature"]);
      yield* runGit(cwd, ["checkout", "main"]);
      yield* writeFile(cwd, "shared.txt", "main\n");
      yield* runGit(cwd, ["add", "."]);
      yield* runGit(cwd, ["commit", "-m", "main"]);

      const workflow = yield* GitWorkflowService.GitWorkflowService;
      assert.deepStrictEqual(yield* workflow.mergeRef({ cwd, refName: "feature" }), {
        status: "conflicted",
        conflictedFiles: ["shared.txt"],
      });
      assert.equal(
        yield* runGit(cwd, ["rev-parse", "--verify", "MERGE_HEAD"]),
        yield* runGit(cwd, ["rev-parse", "feature"]),
      );
    }),
  );

  it.effect("fails invalid refs without leaving merge state", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      yield* initRepo(cwd);
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const error = yield* workflow.mergeRef({ cwd, refName: "missing-branch" }).pipe(Effect.flip);

      expect(error).toBeInstanceOf(GitCommandError);
      expect(error.detail).toContain("missing-branch");
      const mergeHead = yield* (yield* GitVcsDriver.GitVcsDriver).execute({
        operation: "GitWorkflowService.test.noMergeHead",
        cwd,
        args: ["rev-parse", "--verify", "MERGE_HEAD"],
        allowNonZeroExit: true,
      });
      assert.notEqual(mergeHead.exitCode, 0);
    }),
  );
});
