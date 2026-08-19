/**
 * PreviewRecordingPolicy - decides which recorder captures a review.
 *
 * `ServerBrowserManager` knows tabs and threads, not projects. This service does
 * the one lookup that connects them, so the browser layer keeps its narrow
 * dependencies and the per-project override still reaches the recorder.
 *
 * A project's setting wins over the server's. Any lookup failure falls back to the
 * server setting rather than failing the review: picking a recorder is a
 * preference, and losing a recording over a stale projection row would be worse.
 */
import type { PreviewRecordingMode, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerConfig from "../config.ts";
import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import { ProjectionThreadRepository } from "../persistence/Services/ProjectionThreads.ts";

export interface PreviewRecordingPolicyShape {
  readonly modeForThread: (threadId: ThreadId) => Effect.Effect<PreviewRecordingMode>;
}

export class PreviewRecordingPolicy extends Context.Service<
  PreviewRecordingPolicy,
  PreviewRecordingPolicyShape
>()("t3/preview/PreviewRecordingPolicy") {}

export const makePreviewRecordingPolicy = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const threads = yield* ProjectionThreadRepository;
  const projects = yield* ProjectionProjectRepository;

  const modeForThread: PreviewRecordingPolicyShape["modeForThread"] = (threadId) =>
    Effect.gen(function* () {
      const thread = yield* threads.getById({ threadId });
      if (Option.isNone(thread)) return config.previewRecordingMode;
      const project = yield* projects.getById({ projectId: thread.value.projectId });
      if (Option.isNone(project)) return config.previewRecordingMode;
      return project.value.previewRecordingMode ?? config.previewRecordingMode;
    }).pipe(Effect.orElseSucceed(() => config.previewRecordingMode));

  return { modeForThread } satisfies PreviewRecordingPolicyShape;
});

export const layer = Layer.effect(PreviewRecordingPolicy, makePreviewRecordingPolicy);

/** Ignores projects entirely and always answers with the server setting. */
export const layerServerConfigOnly = Layer.effect(
  PreviewRecordingPolicy,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    return {
      modeForThread: () => Effect.succeed(config.previewRecordingMode),
    } satisfies PreviewRecordingPolicyShape;
  }),
);
