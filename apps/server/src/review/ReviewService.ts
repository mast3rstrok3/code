import { Context, Effect, Layer } from "effect";

import {
  VcsUnsupportedOperationError,
  type ReviewDiffPreviewError,
  type ReviewDiffPreviewInput,
  type ReviewDiffPreviewResult,
} from "@t3tools/contracts";

import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";

export interface ReviewServiceShape {
  readonly getDiffPreview: (
    input: ReviewDiffPreviewInput,
  ) => Effect.Effect<ReviewDiffPreviewResult, ReviewDiffPreviewError>;
}

export class ReviewService extends Context.Service<ReviewService, ReviewServiceShape>()(
  "t3/review/ReviewService",
) {}

function emptyDiffPreview(input: ReviewDiffPreviewInput): ReviewDiffPreviewResult {
  return {
    cwd: input.cwd,
    generatedAt: new Date().toISOString(),
    sources: [],
  };
}

export const make = Effect.fn("makeReviewService")(function* () {
  const vcsRegistry = yield* VcsDriverRegistry.VcsDriverRegistry;
  const git = yield* GitVcsDriver;

  const getDiffPreview: ReviewServiceShape["getDiffPreview"] = Effect.fn(
    "ReviewService.getDiffPreview",
  )(function* (input) {
    const handle = yield* vcsRegistry.detect({ cwd: input.cwd, requestedKind: "auto" });
    if (!handle) {
      return emptyDiffPreview(input);
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

  return ReviewService.of({
    getDiffPreview,
  });
});

export const layer = Layer.effect(ReviewService, make());
