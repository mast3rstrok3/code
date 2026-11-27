/**
 * AppReviewTests - runs one E2E command for a thread's App Review.
 *
 * The command runs in the thread's worktree with the rrweb recorder injected
 * (see `APP_REVIEW_RECORDER_*`), and its result and per-test recordings join the
 * thread's active review. The project's `e2ePreflight` gates every run.
 */
import {
  AppReviewError,
  type AppReviewTestResult,
  type ReviewTestPlatform,
  type ThreadId,
} from "@t3tools/contracts";
import { reviewTestPlatformsForHost } from "@t3tools/shared/appReviewParts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { AppStackManager } from "../appStack/AppStackManager.ts";
import { appStackEnvironment } from "../appStackEnvironment.ts";
import * as ServerConfig from "../config.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as T3ProjectFileLoader from "../project/T3ProjectFileLoader.ts";
import * as AppReviewStore from "./AppReviewStore.ts";
import { runAppReviewPreflight } from "./appReviewPreflight.ts";
import {
  appReviewBuildArtifactsDir,
  appReviewTestRecordingsDir,
  runAppReviewTest,
} from "./appReviewTestRunner.ts";

/** Below the 65-minute MCP tool timeout T3 Code gives providers, so the call returns a result. */
const MAX_TEST_MINUTES = 60;
const DEFAULT_TEST_MINUTES = 45;

export class AppReviewTests extends Context.Service<
  AppReviewTests,
  {
    readonly run: (input: {
      readonly threadId: ThreadId;
      readonly command: string;
      readonly previewUrl?: string | undefined;
      readonly baseRef?: string | undefined;
      readonly testPlatforms?: readonly [ReviewTestPlatform, ...ReviewTestPlatform[]] | undefined;
    }) => Effect.Effect<AppReviewTestResult, AppReviewError>;
  }
>()("t3/appReview/AppReviewTests") {}

const make = Effect.gen(function* () {
  const store = yield* AppReviewStore.AppReviewStore;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const projectFiles = yield* T3ProjectFileLoader.T3ProjectFileLoader;
  const appStacks = yield* AppStackManager;
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  const services = yield* Effect.context<
    ProcessRunner.ProcessRunner | FileSystem.FileSystem | Path.Path | SecureRandom.SecureRandom
  >();
  const suiteEnvironment = appStackEnvironment(config);

  const resolveWorkspace = Effect.fn("AppReviewTests.resolveWorkspace")(function* (
    threadId: ThreadId,
  ) {
    const lookupFailed = (cause: unknown) =>
      new AppReviewError({ message: "Could not resolve this thread's workspace.", cause });
    const thread = yield* orchestrator.getThreadShell(threadId).pipe(Effect.mapError(lookupFailed));
    if (thread?.worktreePath) return thread.worktreePath;
    const project =
      thread === null
        ? Option.none()
        : yield* projects.get(thread.projectId).pipe(Effect.mapError(lookupFailed));
    if (Option.isNone(project)) {
      return yield* new AppReviewError({ message: "This thread's workspace was not found." });
    }
    return project.value.workspaceRoot;
  });

  const run: AppReviewTests["Service"]["run"] = Effect.fn("AppReviewTests.run")(function* (input) {
    yield* Effect.annotateCurrentSpan({ "app_review.thread_id": input.threadId });
    const platforms = input.testPlatforms ?? ["web"];
    const reachable = reviewTestPlatformsForHost(yield* HostProcess.Platform);
    const unreachable = platforms.filter((platform) => !reachable.includes(platform));
    if (unreachable.length > 0) {
      return yield* new AppReviewError({
        message: `This server cannot run ${unreachable.join(", ")} tests. iOS and macOS tests need a macOS server.`,
      });
    }

    const cwd = yield* resolveWorkspace(input.threadId);
    const projectFile = Option.getOrUndefined(yield* projectFiles.load(cwd));
    const lookup = yield* appStacks
      .getByWorktree({ worktreePath: cwd })
      .pipe(Effect.orElseSucceed(() => null));
    const previewUrl = input.previewUrl ?? lookup?.frontendUrl ?? null;
    // A suite may drive the worktree's stack only while it serves the target under test.
    const stackId =
      lookup?.stack != null && previewUrl !== null && lookup.frontendUrl === previewUrl
        ? lookup.stack.id
        : null;

    const review = yield* store.update(
      { threadId: input.threadId, evidence: "e2e" },
      Effect.succeed,
    );
    const artifactsDir = appReviewBuildArtifactsDir(path, config.stateDir, review.id);
    const context = {
      cwd,
      previewUrl,
      stackId,
      testPlatforms: platforms,
      artifactsDir,
      env: suiteEnvironment,
    };

    const preflight = projectFile?.e2ePreflight;
    if (preflight !== undefined) {
      const readiness = yield* runAppReviewPreflight({
        ...context,
        command: preflight.command,
      }).pipe(
        Effect.provide(services),
        Effect.orElseSucceed(() => "error" as const),
      );
      if (readiness !== "ready") {
        return yield* new AppReviewError({
          reviewId: review.id,
          message: `${
            readiness === "waiting"
              ? "The test prerequisites are not ready yet; try again in a minute."
              : "The project's e2ePreflight readiness check failed."
          } ${preflight.blockedReason}`,
        });
      }
    }

    const result = yield* runAppReviewTest({
      ...context,
      command: input.command,
      retryCommand: input.command,
      baseRef: input.baseRef ?? null,
      executionId: review.id,
      recordingsDir: appReviewTestRecordingsDir(path, config.stateDir, review.id),
      timeoutMinutes: Math.min(
        projectFile?.e2eTimeoutMinutes ?? DEFAULT_TEST_MINUTES,
        MAX_TEST_MINUTES,
      ),
    }).pipe(
      Effect.provide(services),
      Effect.mapError(
        (cause) =>
          new AppReviewError({
            reviewId: review.id,
            message: "The test command could not start.",
            cause,
          }),
      ),
    );

    yield* store.update({ threadId: input.threadId, evidence: "e2e" }, (record) =>
      Effect.succeed({
        ...record,
        evidence: { ...record.evidence, tests: [...(record.evidence.tests ?? []), result] },
      }),
    );
    return result;
  });

  return AppReviewTests.of({ run });
});

export const layer = Layer.effect(AppReviewTests, make).pipe(Layer.provide(ProcessRunner.layer));
