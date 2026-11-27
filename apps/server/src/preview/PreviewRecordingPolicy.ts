/**
 * Which recorder captures a thread's review. A project that pins `dom` or `video` wins;
 * `auto`, the project default, defers to the server setting, as does any failed lookup,
 * since picking a recorder is a preference and must not fail the review.
 */
import type { PreviewRecordingMode, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerConfig from "../config.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";

export interface PreviewRecordingPolicyShape {
  readonly modeForThread: (threadId: ThreadId) => Effect.Effect<PreviewRecordingMode>;
}

export class PreviewRecordingPolicy extends Context.Service<
  PreviewRecordingPolicy,
  PreviewRecordingPolicyShape
>()("t3/preview/PreviewRecordingPolicy") {}

const makePreviewRecordingPolicy = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const threads = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;

  const modeForThread: PreviewRecordingPolicyShape["modeForThread"] = Effect.fn(
    "PreviewRecordingPolicy.modeForThread",
  )(
    function* (threadId) {
      const thread = yield* threads.getThread(threadId);
      const project = yield* projects.get(thread.projectId);
      const mode = Option.getOrUndefined(project)?.previewRecordingMode ?? "auto";
      return mode === "auto" ? config.previewRecordingMode : mode;
    },
    Effect.orElseSucceed(() => config.previewRecordingMode),
  );

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
