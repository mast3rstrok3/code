import { ProjectId, ThreadId, type PreviewRecordingMode } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import type { PlatformError } from "effect/PlatformError";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerConfig from "../config.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { PreviewRecordingPolicy, layer } from "./PreviewRecordingPolicy.ts";

const threadId = ThreadId.make("reviewer-thread");
const projectId = ProjectId.make("project-1");

const harness = (input: {
  readonly serverMode: PreviewRecordingMode;
  readonly thread?: "missing" | "found";
  readonly projectMode?: PreviewRecordingMode | "missing";
}) => {
  const configLayer = Layer.effect(
    ServerConfig.ServerConfig,
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      return ServerConfig.make({ ...config, previewRecordingMode: input.serverMode });
    }),
  ).pipe(
    Layer.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "preview-policy-test-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    ),
  );

  return layer.pipe(
    Layer.provide(
      Layer.mock(ProjectionStore.ProjectionStoreV2)({
        getThread: () =>
          input.thread === "missing"
            ? Effect.fail(new ProjectionStore.ProjectionStoreThreadNotFoundError({ threadId }))
            : Effect.succeed({ id: threadId, projectId } as never),
      }),
    ),
    Layer.provide(
      Layer.mock(ProjectStore.ProjectStoreV2)({
        get: () =>
          Effect.succeed(
            input.projectMode === undefined || input.projectMode === "missing"
              ? Option.none()
              : Option.some({ projectId, previewRecordingMode: input.projectMode } as never),
          ),
      }),
    ),
    Layer.provide(configLayer),
  );
};

const modeFor = (layers: Layer.Layer<PreviewRecordingPolicy, PlatformError>) =>
  Effect.gen(function* () {
    const policy = yield* PreviewRecordingPolicy;
    return yield* policy.modeForThread(threadId);
  }).pipe(Effect.provide(layers));

describe("PreviewRecordingPolicy", () => {
  it.effect("lets a project pin the encoder the server would not have chosen", () =>
    Effect.gen(function* () {
      expect(yield* modeFor(harness({ serverMode: "auto", projectMode: "video" }))).toBe("video");
    }),
  );

  it.effect("defers to the server setting when the project keeps the default", () =>
    Effect.gen(function* () {
      expect(yield* modeFor(harness({ serverMode: "auto", projectMode: "auto" }))).toBe("auto");
      expect(yield* modeFor(harness({ serverMode: "video", projectMode: "auto" }))).toBe("video");
    }),
  );

  it.effect("falls back rather than failing a review when the lookup cannot answer", () =>
    Effect.gen(function* () {
      // A stale or unreadable projection must not cost the reviewer its recording.
      expect(yield* modeFor(harness({ serverMode: "dom", thread: "missing" }))).toBe("dom");
      expect(yield* modeFor(harness({ serverMode: "dom", projectMode: "missing" }))).toBe("dom");
    }),
  );
});
