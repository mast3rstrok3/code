import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";

import { ProjectId } from "@t3tools/contracts";
import { ServerConfig } from "../config.ts";
import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as ReviewService from "./ReviewService.ts";

function makeLayer(input: {
  readonly workspaceRoot: string;
  readonly baseDir: string;
  readonly detectCalls?: Array<{ readonly cwd: string }>;
  readonly registeredWorkspaceRoots?: ReadonlyArray<{
    readonly workspaceRoot: string;
    readonly deleted?: boolean;
  }>;
}) {
  return ReviewService.layer.pipe(
    Layer.provide(
      Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
        get: () => Effect.die("unexpected VCS registry get"),
        resolve: () => Effect.die("unexpected VCS registry resolve"),
        detect: (request) =>
          Effect.sync(() => {
            input.detectCalls?.push({ cwd: request.cwd });
            return null;
          }),
      }),
    ),
    Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
    Layer.provide(
      Layer.mock(ProjectionProjectRepository)({
        listAll: () =>
          Effect.succeed(
            (input.registeredWorkspaceRoots ?? []).map((project, index) => ({
              projectId: ProjectId.make(`project-${index}`),
              title: `Project ${index}`,
              workspaceRoot: project.workspaceRoot,
              defaultModelSelection: null,
              defaultThreadEnvMode: null,
              scripts: [],
              createdAt: "2026-08-13T00:00:00.000Z",
              updatedAt: "2026-08-13T00:00:00.000Z",
              deletedAt: project.deleted ? "2026-08-13T00:00:00.000Z" : null,
            })),
          ),
      }),
    ),
    Layer.provide(ServerConfig.layerTest(input.workspaceRoot, input.baseDir)),
    Layer.provideMerge(NodeServices.layer),
  );
}

describe("ReviewService", () => {
  it.effect("rejects diff preview cwd outside the configured workspace roots", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
      const outsideRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-outside-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const detectCalls: Array<{ readonly cwd: string }> = [];

      const error = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        return yield* review.getDiffPreview({ cwd: outsideRoot }).pipe(Effect.flip);
      }).pipe(Effect.provide(makeLayer({ workspaceRoot, baseDir, detectCalls })));

      assert.strictEqual(error._tag, "VcsRepositoryDetectionError");
      assert.strictEqual(error.operation, "ReviewService.getDiffPreview");
      assert.match(
        "detail" in error ? error.detail : "",
        /must stay within a configured or registered workspace root/,
      );
      assert.deepStrictEqual(detectCalls, []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("attributes file-content workspace violations to the file-content operation", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
      const outsideRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-outside-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const detectCalls: Array<{ readonly cwd: string }> = [];

      const error = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        return yield* review
          .getDiffFileContents({
            cwd: outsideRoot,
            sourceKind: "working-tree",
            changeType: "change",
            baseRef: "HEAD",
            headRef: null,
            oldPath: "file.ts",
            newPath: "file.ts",
          })
          .pipe(Effect.flip);
      }).pipe(Effect.provide(makeLayer({ workspaceRoot, baseDir, detectCalls })));

      assert.strictEqual(error._tag, "VcsRepositoryDetectionError");
      assert.strictEqual(error.operation, "ReviewService.getDiffFileContents");
      assert.match(
        "detail" in error ? error.detail : "",
        /must stay within a configured or registered workspace root/,
      );
      assert.deepStrictEqual(detectCalls, []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("allows diff preview cwd inside the configured workspace root", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const detectCalls: Array<{ readonly cwd: string }> = [];

      const result = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        return yield* review.getDiffPreview({ cwd: workspaceRoot });
      }).pipe(Effect.provide(makeLayer({ workspaceRoot, baseDir, detectCalls })));

      assert.strictEqual(result.cwd, workspaceRoot);
      assert.deepStrictEqual(result.sources, []);
      assert.deepStrictEqual(detectCalls, [{ cwd: workspaceRoot }]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("allows diff preview cwd inside an active registered project root", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
      const registeredRoot = yield* fs.makeTempDirectoryScoped({
        prefix: "t3-review-registered-",
      });
      const registeredChild = `${registeredRoot}/packages/web`;
      yield* fs.makeDirectory(registeredChild, { recursive: true });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const detectCalls: Array<{ readonly cwd: string }> = [];

      const result = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        return yield* review.getDiffPreview({ cwd: registeredChild });
      }).pipe(
        Effect.provide(
          makeLayer({
            workspaceRoot,
            baseDir,
            detectCalls,
            registeredWorkspaceRoots: [{ workspaceRoot: registeredRoot }],
          }),
        ),
      );

      assert.strictEqual(result.cwd, registeredChild);
      assert.deepStrictEqual(detectCalls, [{ cwd: registeredChild }]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects diff preview cwd inside a deleted registered project root", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
      const deletedRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-deleted-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const detectCalls: Array<{ readonly cwd: string }> = [];

      const error = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        return yield* review.getDiffPreview({ cwd: deletedRoot }).pipe(Effect.flip);
      }).pipe(
        Effect.provide(
          makeLayer({
            workspaceRoot,
            baseDir,
            detectCalls,
            registeredWorkspaceRoots: [{ workspaceRoot: deletedRoot, deleted: true }],
          }),
        ),
      );

      assert.strictEqual(error._tag, "VcsRepositoryDetectionError");
      assert.deepStrictEqual(detectCalls, []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("preserves unexpected path-resolution failures", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const invalidCwd = `${workspaceRoot}\0invalid`;
      const detectCalls: Array<{ readonly cwd: string }> = [];

      const error = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        return yield* review.getDiffPreview({ cwd: invalidCwd }).pipe(Effect.flip);
      }).pipe(Effect.provide(makeLayer({ workspaceRoot, baseDir, detectCalls })));

      assert.strictEqual(error._tag, "VcsRepositoryDetectionError");
      if (error._tag !== "VcsRepositoryDetectionError") return;
      assert.strictEqual(error.operation, "ReviewService.assertWorkspaceBoundCwd.canonicalizePath");
      assert.strictEqual(error.cwd, invalidCwd);
      assert.match(error.detail, /Failed to resolve a path/);
      assert.instanceOf(error.cause, PlatformError.PlatformError);
      assert.deepStrictEqual(detectCalls, []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
