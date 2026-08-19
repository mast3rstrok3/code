import { ProjectId, ThreadId, type PreviewRecordingMode } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import type { PlatformError } from "effect/PlatformError";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerConfig from "../config.ts";
import { PersistenceSqlError } from "../persistence/Errors.ts";
import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import { ProjectionThreadRepository } from "../persistence/Services/ProjectionThreads.ts";
import { PreviewRecordingPolicy, layer } from "./PreviewRecordingPolicy.ts";

const threadId = ThreadId.make("reviewer-thread");
const projectId = ProjectId.make("project-1");

const project = (previewRecordingMode: PreviewRecordingMode | null) => ({
  projectId,
  title: "Project",
  workspaceRoot: "/tmp/project",
  defaultModelSelection: null,
  defaultThreadEnvMode: null,
  previewRecordingMode,
  scripts: [],
  createdAt: "2026-08-19T00:00:00.000Z",
  updatedAt: "2026-08-19T00:00:00.000Z",
  deletedAt: null,
});

const harness = (input: {
  readonly serverMode: PreviewRecordingMode;
  readonly thread?: "missing" | "fails" | "found";
  readonly project?: "missing" | ReturnType<typeof project>;
}) => {
  const threadOutcome = input.thread ?? "found";
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
      Layer.mock(ProjectionThreadRepository)({
        getById: () =>
          threadOutcome === "fails"
            ? Effect.fail(new PersistenceSqlError({ operation: "getById" }))
            : Effect.succeed(
                threadOutcome === "missing"
                  ? Option.none()
                  : Option.some({ threadId, projectId } as never),
              ),
      }),
    ),
    Layer.provide(
      Layer.mock(ProjectionProjectRepository)({
        getById: () =>
          Effect.succeed(
            input.project === undefined || input.project === "missing"
              ? Option.none()
              : Option.some(input.project as never),
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
      expect(yield* modeFor(harness({ serverMode: "auto", project: project("video") }))).toBe(
        "video",
      );
    }),
  );

  it.effect("falls back to the server setting when the project states no preference", () =>
    Effect.gen(function* () {
      expect(yield* modeFor(harness({ serverMode: "auto", project: project(null) }))).toBe("auto");
      expect(yield* modeFor(harness({ serverMode: "video", project: project(null) }))).toBe(
        "video",
      );
    }),
  );

  it.effect("falls back rather than failing a review when the lookup cannot answer", () =>
    Effect.gen(function* () {
      // A stale or unreadable projection must not cost the reviewer its recording.
      expect(yield* modeFor(harness({ serverMode: "dom", thread: "missing" }))).toBe("dom");
      expect(yield* modeFor(harness({ serverMode: "dom", project: "missing" }))).toBe("dom");
      expect(yield* modeFor(harness({ serverMode: "dom", thread: "fails" }))).toBe("dom");
    }),
  );
});
