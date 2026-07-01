import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { DevReviewId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { HttpServer } from "effect/unstable/http";

import * as ServerConfig from "../config.ts";
import { DevReviewReplayEventRepository } from "../persistence/Services/DevReviewReplayEvents.ts";
import * as DevReviewReplayCaptureModule from "./DevReviewReplayCapture.ts";
import { DevReviewReplayCapture } from "./DevReviewReplayCapture.ts";

const reviewId = DevReviewId.make("dev-review-1");

const emptyDocument = {
  verdict: "pending",
  summary: "",
  checks: [],
  findings: [],
  questions: [],
  nextSteps: [],
} as const;

const review = {
  id: reviewId,
  sourceThreadId: ThreadId.make("thread-source"),
  reviewThreadId: ThreadId.make("thread-review"),
  sourceTurnId: null,
  status: "running" as const,
  document: emptyDocument,
  replay: {
    status: "not-started" as const,
    eventCount: 0,
    startedAt: null,
    completedAt: null,
    durationMs: null,
    error: null,
  },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const fakeHttpServer = HttpServer.HttpServer.of({
  address: {
    _tag: "TcpAddress",
    hostname: "0.0.0.0",
    port: 43123,
  },
  serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
});

const TestLayer = DevReviewReplayCaptureModule.layer.pipe(
  Layer.provide(
    Layer.succeed(DevReviewReplayEventRepository, {
      appendEvents: () => Effect.die("appendEvents should not be called for zero-event stop"),
      listByReviewId: () => Effect.succeed([]),
      countByReviewId: () => Effect.succeed(0),
    }),
  ),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "dev-review-replay-capture-" })),
  Layer.provide(Layer.succeed(HttpServer.HttpServer, fakeHttpServer)),
  Layer.provide(NodeServices.layer),
);

it.effect("finalizes zero-event Agent Browser replay captures as failed metadata", () =>
  Effect.gen(function* () {
    const capture = yield* DevReviewReplayCapture;
    const fs = yield* FileSystem.FileSystem;

    const started = yield* capture.start({ review });
    assert.strictEqual(started.status, "recording");
    assert.strictEqual(started.eventCount, 0);
    assert.ok(started.agentBrowser);
    assert.strictEqual(started.agentBrowser.namespace.startsWith("t3-dev-review-"), true);
    assert.match(
      started.agentBrowser.ingestUrl,
      /^http:\/\/127\.0\.0\.1:43123\/api\/dev-review\/replay\/ingest$/,
    );

    const initScript = yield* fs.readFileString(started.agentBrowser.initScriptPath);
    assert.match(initScript, /rrwebRecord/);
    assert.match(initScript, /authorization/);
    assert.match(initScript, /maskAllInputs: true/);

    const stopped = yield* capture.stop({
      review: {
        ...review,
        replay: started,
      },
    });
    assert.strictEqual(stopped.status, "failed");
    assert.strictEqual(stopped.eventCount, 0);
    assert.match(stopped.error ?? "", /zero events/i);
    assert.ok(stopped.completedAt);
  }).pipe(Effect.provide(Layer.mergeAll(TestLayer, NodeServices.layer))),
);
