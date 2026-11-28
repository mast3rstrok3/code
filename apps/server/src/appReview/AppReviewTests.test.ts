import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { AppStackError, ProjectId, ThreadId, type T3ProjectFile } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { AppStackManager } from "../appStack/AppStackManager.ts";
import * as ServerConfig from "../config.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { layerMemory as SqlitePersistenceMemory } from "../persistence/Sqlite.ts";
import * as T3ProjectFileLoader from "../project/T3ProjectFileLoader.ts";
import * as AppReviewStore from "./AppReviewStore.ts";
import * as AppReviewTests from "./AppReviewTests.ts";

const threadId = ThreadId.make("thread-e2e");

const makeLayer = (input: {
  readonly worktreePath: string;
  readonly projectFile?: Partial<T3ProjectFile>;
}) =>
  AppReviewTests.layer.pipe(
    Layer.provideMerge(AppReviewStore.layer),
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadShell: () =>
            Effect.succeed({
              id: threadId,
              projectId: ProjectId.make("project-1"),
              worktreePath: input.worktreePath,
            } as never),
        }),
        Layer.mock(ProjectStore.ProjectStoreV2)({}),
        Layer.mock(T3ProjectFileLoader.T3ProjectFileLoader)({
          load: () =>
            Effect.succeed(
              input.projectFile === undefined
                ? Option.none()
                : Option.some(input.projectFile as T3ProjectFile),
            ),
        }),
        Layer.mock(AppStackManager)({
          getByWorktree: () =>
            Effect.fail(new AppStackError({ operation: "getByWorktree", message: "No stack." })),
        }),
        ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "t3-app-review-tests-" }),
        Layer.fresh(SqlitePersistenceMemory),
      ),
    ),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );

const withWorktree = <A, E>(
  run: (
    worktreePath: string,
  ) => Effect.Effect<
    A,
    E,
    | AppReviewTests.AppReviewTests
    | AppReviewStore.AppReviewStore
    | FileSystem.FileSystem
    | Path.Path
  >,
  projectFile?: Partial<T3ProjectFile>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const worktreePath = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-app-review-wt-" });
    return yield* run(worktreePath).pipe(
      Effect.provide(makeLayer({ worktreePath, ...(projectFile ? { projectFile } : {}) })),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe("AppReviewTests", () => {
  it.live(
    "runs the command in the thread's worktree and attaches its recordings to the review",
    () =>
      withWorktree((worktreePath) =>
        Effect.gen(function* () {
          const tests = yield* AppReviewTests.AppReviewTests;
          const store = yield* AppReviewStore.AppReviewStore;
          const result = yield* tests.run({
            threadId,
            command:
              'test -n "$APP_REVIEW_RECORDER_SCRIPT" && pwd && echo "$APP_REVIEW_PREVIEW_URL" && printf \'{"type":4}\\n\' > "$APP_REVIEW_RECORDING_DIR/checkout.rrweb.jsonl"',
            previewUrl: "http://127.0.0.1:5173",
          });
          assert.strictEqual(result.status, "passed");
          assert.include(result.outputMarkdown, worktreePath);
          assert.include(result.outputMarkdown, "http://127.0.0.1:5173");
          assert.deepStrictEqual(
            result.recordings?.map((recording) => recording.label),
            ["checkout"],
          );

          const review = Option.getOrThrow(yield* store.active(threadId));
          assert.strictEqual(review.appReviewScope, "e2e");
          assert.deepStrictEqual(review.evidence.tests, [result]);
        }),
      ),
  );

  it.live("does not run the command while the project's readiness check waits", () =>
    withWorktree(
      (worktreePath) =>
        Effect.gen(function* () {
          const tests = yield* AppReviewTests.AppReviewTests;
          const store = yield* AppReviewStore.AppReviewStore;
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const marker = path.join(worktreePath, "ran");
          const error = yield* tests
            .run({ threadId, command: `touch ${marker}` })
            .pipe(Effect.flip);
          assert.include(error.message, "not ready");
          assert.include(error.message, "Start the API.");
          assert.isFalse(yield* fileSystem.exists(marker));
          const review = Option.getOrThrow(yield* store.active(threadId));
          assert.deepStrictEqual(review.evidence.tests ?? [], []);
        }),
      { e2ePreflight: { command: "exit 1", blockedReason: "Start the API." } },
    ),
  );

  it.live("refuses platforms this host cannot reach", () =>
    withWorktree(() =>
      Effect.gen(function* () {
        const tests = yield* AppReviewTests.AppReviewTests;
        const error = yield* tests
          .run({ threadId, command: "true", testPlatforms: ["web", "ios"] })
          .pipe(Effect.provideService(HostProcess.Platform, "linux"), Effect.flip);
        assert.include(error.message, "cannot run ios tests");
      }),
    ),
  );
});
