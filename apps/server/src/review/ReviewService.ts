import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import {
  DevReviewReplayError,
  VcsRepositoryDetectionError,
  VcsUnsupportedOperationError,
  type DevReviewReplayAppendEventsInput,
  type DevReviewReplayAppendEventsResult,
  type DevReviewReplayGetInput,
  type DevReviewReplayGetResult,
  type ReviewDiffPreviewError,
  type ReviewDiffPreviewInput,
  type ReviewDiffPreviewResult,
} from "@t3tools/contracts";
import * as Option from "effect/Option";

import * as ServerConfig from "../config.ts";
import { DevReviewReplayEventRepository } from "../persistence/Services/DevReviewReplayEvents.ts";
import { ProjectionThreadDevReviewRepository } from "../persistence/Services/ProjectionThreadDevReviews.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";

export class ReviewService extends Context.Service<
  ReviewService,
  {
    readonly getDiffPreview: (
      input: ReviewDiffPreviewInput,
    ) => Effect.Effect<ReviewDiffPreviewResult, ReviewDiffPreviewError>;
    readonly appendDevReviewReplayEvents: (
      input: DevReviewReplayAppendEventsInput,
    ) => Effect.Effect<DevReviewReplayAppendEventsResult, DevReviewReplayError>;
    readonly getDevReviewReplay: (
      input: DevReviewReplayGetInput,
    ) => Effect.Effect<DevReviewReplayGetResult, DevReviewReplayError>;
  }
>()("t3/review/ReviewService") {}

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const vcsRegistry = yield* VcsDriverRegistry.VcsDriverRegistry;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const devReviewRepository = yield* ProjectionThreadDevReviewRepository;
  const replayEventsRepository = yield* DevReviewReplayEventRepository;

  const canonicalizePath = (value: string) => {
    const resolvedPath = path.resolve(value);
    return fileSystem.realPath(resolvedPath).pipe(
      Effect.catchTags({
        PlatformError: (cause) =>
          cause.reason._tag === "NotFound"
            ? Effect.succeed(resolvedPath)
            : Effect.fail(
                new VcsRepositoryDetectionError({
                  operation: "ReviewService.assertWorkspaceBoundCwd.canonicalizePath",
                  cwd: resolvedPath,
                  detail: "Failed to resolve a path while validating the review workspace.",
                  cause,
                }),
              ),
      }),
    );
  };

  const isWithinRoot = (candidate: string, root: string) => {
    const relative = path.relative(root, candidate);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  };

  const assertWorkspaceBoundCwd = Effect.fn("ReviewService.assertWorkspaceBoundCwd")(function* (
    cwd: string,
  ) {
    const [candidate, workspaceRoot, worktreesRoot] = yield* Effect.all([
      canonicalizePath(cwd),
      canonicalizePath(config.cwd),
      canonicalizePath(config.worktreesDir),
    ]);

    if (isWithinRoot(candidate, workspaceRoot) || isWithinRoot(candidate, worktreesRoot)) {
      return;
    }

    return yield* new VcsRepositoryDetectionError({
      operation: "ReviewService.getDiffPreview",
      cwd,
      detail: "Review diff preview cwd must stay within the configured workspace root.",
    });
  });

  const getDiffPreview: ReviewService["Service"]["getDiffPreview"] = Effect.fn(
    "ReviewService.getDiffPreview",
  )(function* (input) {
    yield* assertWorkspaceBoundCwd(input.cwd);

    const handle = yield* vcsRegistry.detect({ cwd: input.cwd, requestedKind: "auto" });
    if (!handle) {
      return {
        cwd: input.cwd,
        generatedAt: yield* DateTime.now,
        sources: [],
      };
    }

    const getDriverDiffPreview = handle.driver.getDiffPreview;
    if (!getDriverDiffPreview) {
      if (handle.kind === "git") {
        return yield* git.getReviewDiffPreview(input);
      }
      return yield* new VcsUnsupportedOperationError({
        operation: "ReviewService.getDiffPreview",
        kind: handle.kind,
        detail: `The ${handle.kind} VCS driver does not support review diff previews.`,
      });
    }

    return yield* getDriverDiffPreview(input);
  });

  const replayError = (
    reviewId: DevReviewReplayError["reviewId"],
    message: string,
    cause?: unknown,
  ) =>
    new DevReviewReplayError({
      ...(reviewId === undefined ? {} : { reviewId }),
      message,
      ...(cause === undefined ? {} : { cause }),
    });

  const appendDevReviewReplayEvents: ReviewService["Service"]["appendDevReviewReplayEvents"] =
    Effect.fn("ReviewService.appendDevReviewReplayEvents")(function* (input) {
      const now = DateTime.formatIso(yield* DateTime.now);
      const review = yield* devReviewRepository
        .getById({ reviewId: input.reviewId })
        .pipe(
          Effect.mapError((cause) =>
            replayError(input.reviewId, "Failed to load the Dev Review record.", cause),
          ),
        );

      if (Option.isNone(review)) {
        return yield* replayError(input.reviewId, "Dev Review record not found.");
      }

      if (input.events.length > 0) {
        yield* replayEventsRepository
          .appendEvents({
            reviewId: input.reviewId,
            events: input.events,
            createdAt: now,
          })
          .pipe(
            Effect.mapError((cause) =>
              replayError(input.reviewId, "Failed to append Dev Review replay events.", cause),
            ),
          );
      }

      const eventCount = yield* replayEventsRepository
        .countByReviewId({ reviewId: input.reviewId })
        .pipe(
          Effect.mapError((cause) =>
            replayError(input.reviewId, "Failed to count Dev Review replay events.", cause),
          ),
        );

      const replay = review.value.replay;
      return {
        status:
          replay.status === "saved" || replay.status === "failed" ? replay.status : "recording",
        eventCount,
        startedAt: replay.startedAt ?? now,
        completedAt: replay.completedAt,
        durationMs: replay.durationMs,
        error: replay.error,
      };
    });

  const getDevReviewReplay: ReviewService["Service"]["getDevReviewReplay"] = Effect.fn(
    "ReviewService.getDevReviewReplay",
  )(function* (input) {
    const review = yield* devReviewRepository
      .getById({ reviewId: input.reviewId })
      .pipe(
        Effect.mapError((cause) =>
          replayError(input.reviewId, "Failed to load the Dev Review record.", cause),
        ),
      );

    if (Option.isNone(review)) {
      return yield* replayError(input.reviewId, "Dev Review record not found.");
    }

    const chunks = yield* replayEventsRepository
      .listByReviewId({ reviewId: input.reviewId })
      .pipe(
        Effect.mapError((cause) =>
          replayError(input.reviewId, "Failed to load Dev Review replay events.", cause),
        ),
      );

    return {
      reviewId: input.reviewId,
      events: chunks.flatMap((chunk) => chunk.events),
    };
  });

  return ReviewService.of({
    getDiffPreview,
    appendDevReviewReplayEvents,
    getDevReviewReplay,
  });
});

export const layer = Layer.effect(ReviewService, make);
