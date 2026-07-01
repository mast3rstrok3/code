import { assert, it } from "@effect/vitest";
import {
  DevReviewId,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { DevReviewReplayCapture } from "../../../review/DevReviewReplayCapture.ts";
import { handlers } from "./handlers.ts";

const reviewId = DevReviewId.make("dev-review-1");
const threadId = ThreadId.make("thread-review");

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
  reviewThreadId: threadId,
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

it.effect("starts replay capture with only the dev-review MCP capability", () => {
  const dispatched: OrchestrationCommand[] = [];
  let startCallCount = 0;

  const layer = Layer.mergeAll(
    Layer.succeed(McpInvocationContext.McpInvocationContext, {
      environmentId: EnvironmentId.make("environment-1"),
      threadId,
      providerSessionId: "provider-session-1",
      providerInstanceId: ProviderInstanceId.make("codex"),
      capabilities: new Set(["dev-review"] as const),
      issuedAt: 1,
      expiresAt: Number.MAX_SAFE_INTEGER,
    }),
    Layer.mock(ProjectionSnapshotQuery)({
      getThreadDetailById: () =>
        Effect.succeed(
          Option.some({
            id: threadId,
            devReviews: [review],
          } as never),
        ),
    }),
    Layer.succeed(
      DevReviewReplayCapture,
      DevReviewReplayCapture.of({
        start: () => {
          startCallCount += 1;
          return Effect.succeed({
            status: "recording" as const,
            eventCount: 0,
            startedAt: "2026-01-01T00:00:00.000Z",
            completedAt: null,
            durationMs: null,
            error: null,
            agentBrowser: {
              namespace: "namespace-1",
              session: "session-1",
              evidenceDir: "/tmp/evidence",
              initScriptPath: "/tmp/evidence/rrweb-init.js",
              ingestUrl: "http://127.0.0.1:3773/api/dev-review/replay/ingest",
            },
          });
        },
        stop: () => Effect.die("stop not used"),
        ingest: () => Effect.die("ingest not used"),
      }),
    ),
    Layer.succeed(
      OrchestrationEngineService,
      OrchestrationEngineService.of({
        readEvents: () => Stream.empty,
        dispatch: (command) => {
          dispatched.push(command);
          return Effect.succeed({ sequence: dispatched.length });
        },
        streamDomainEvents: Stream.empty,
      }),
    ),
  );

  return Effect.gen(function* () {
    const replay = yield* handlers.dev_review_replay_start({ reviewId });
    assert.strictEqual(replay.status, "recording");
    assert.strictEqual(replay.agentBrowser?.initScriptPath, "/tmp/evidence/rrweb-init.js");
    assert.strictEqual(startCallCount, 1);
    assert.strictEqual(dispatched.length, 1);
    assert.strictEqual(dispatched[0]?.type, "thread.dev-review.replay-metadata.update");
  }).pipe(Effect.provide(layer));
});
