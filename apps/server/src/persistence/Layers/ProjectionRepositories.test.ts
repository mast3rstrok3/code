import {
  DEFAULT_WORKSPACE_USER_ID,
  DevReviewId,
  ProjectId,
  ThreadId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { ProjectionProjectRepositoryLive } from "./ProjectionProjects.ts";
import { ProjectionThreadRepositoryLive } from "./ProjectionThreads.ts";
import { DevReviewReplayEventRepositoryLive } from "./DevReviewReplayEvents.ts";
import { ProjectionThreadDevReviewRepositoryLive } from "./ProjectionThreadDevReviews.ts";
import { ProjectionProjectRepository } from "../Services/ProjectionProjects.ts";
import { ProjectionThreadRepository } from "../Services/ProjectionThreads.ts";
import { DevReviewReplayEventRepository } from "../Services/DevReviewReplayEvents.ts";
import { ProjectionThreadDevReviewRepository } from "../Services/ProjectionThreadDevReviews.ts";

const projectionRepositoriesLayer = it.layer(
  Layer.mergeAll(
    ProjectionProjectRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    ProjectionThreadRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    ProjectionThreadDevReviewRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    DevReviewReplayEventRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    SqlitePersistenceMemory,
  ),
);

projectionRepositoriesLayer("Projection repositories", (it) => {
  it.effect("stores SQL NULL for missing project model options", () =>
    Effect.gen(function* () {
      const projects = yield* ProjectionProjectRepository;
      const sql = yield* SqlClient.SqlClient;

      yield* projects.upsert({
        projectId: ProjectId.make("project-null-options"),
        title: "Null options project",
        workspaceRoot: "/tmp/project-null-options",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        },
        scripts: [],
        createdAt: "2026-03-24T00:00:00.000Z",
        updatedAt: "2026-03-24T00:00:00.000Z",
        deletedAt: null,
      });

      const rows = yield* sql<{
        readonly defaultModelSelection: string | null;
      }>`
        SELECT default_model_selection_json AS "defaultModelSelection"
        FROM projection_projects
        WHERE project_id = 'project-null-options'
      `;
      const row = rows[0];
      if (!row) {
        return yield* Effect.die("Expected projection_projects row to exist.");
      }

      assert.strictEqual(
        row.defaultModelSelection,
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        JSON.stringify({
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        }),
      );

      const persisted = yield* projects.getById({
        projectId: ProjectId.make("project-null-options"),
      });
      assert.deepStrictEqual(Option.getOrNull(persisted)?.defaultModelSelection, {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4",
      });
    }),
  );

  it.effect("stores JSON for thread model options", () =>
    Effect.gen(function* () {
      const threads = yield* ProjectionThreadRepository;
      const sql = yield* SqlClient.SqlClient;

      yield* threads.upsert({
        threadId: ThreadId.make("thread-null-options"),
        projectId: ProjectId.make("project-null-options"),
        ownerUserId: DEFAULT_WORKSPACE_USER_ID,
        parentThreadId: null,
        workflowRole: null,
        title: "Null options thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-4-6",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurnId: null,
        createdAt: "2026-03-24T00:00:00.000Z",
        updatedAt: "2026-03-24T00:00:00.000Z",
        archivedAt: null,
        latestUserMessageAt: null,
        pendingApprovalCount: 0,
        pendingUserInputCount: 0,
        hasActionableProposedPlan: 0,
        planningWorkflowStage: null,
        deletedAt: null,
      });

      const rows = yield* sql<{
        readonly modelSelection: string | null;
      }>`
        SELECT model_selection_json AS "modelSelection"
        FROM projection_threads
        WHERE thread_id = 'thread-null-options'
      `;
      const row = rows[0];
      if (!row) {
        return yield* Effect.die("Expected projection_threads row to exist.");
      }

      assert.strictEqual(
        row.modelSelection,
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        JSON.stringify({
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-4-6",
        }),
      );

      const persisted = yield* threads.getById({
        threadId: ThreadId.make("thread-null-options"),
      });
      assert.deepStrictEqual(Option.getOrNull(persisted)?.modelSelection, {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-4-6",
      });
    }),
  );

  it.effect("stores Dev Review metadata separately from ordered RRweb replay chunks", () =>
    Effect.gen(function* () {
      const devReviews = yield* ProjectionThreadDevReviewRepository;
      const replayEvents = yield* DevReviewReplayEventRepository;
      const reviewId = DevReviewId.make("dev-review-persisted");

      yield* devReviews.upsert({
        reviewId,
        sourceThreadId: ThreadId.make("thread-source"),
        reviewThreadId: ThreadId.make("thread-review"),
        sourceTurnId: null,
        status: "running",
        document: {
          verdict: "pending",
          summary: "",
          checks: [],
          findings: [],
          questions: [],
          nextSteps: [],
        },
        replay: {
          status: "recording",
          eventCount: 0,
          startedAt: "2026-03-24T00:00:00.000Z",
          completedAt: null,
          durationMs: null,
          error: null,
        },
        createdAt: "2026-03-24T00:00:00.000Z",
        updatedAt: "2026-03-24T00:00:00.000Z",
      });

      yield* replayEvents.appendEvents({
        reviewId,
        events: [{ type: 2, data: { href: "http://localhost:5173" } }],
        createdAt: "2026-03-24T00:00:01.000Z",
      });
      yield* replayEvents.appendEvents({
        reviewId,
        events: [
          { type: 3, data: { source: 0 } },
          { type: 4, data: {} },
        ],
        createdAt: "2026-03-24T00:00:02.000Z",
      });

      const sourceRows = yield* devReviews.listByThreadId({
        threadId: ThreadId.make("thread-source"),
      });
      const reviewRows = yield* devReviews.listByThreadId({
        threadId: ThreadId.make("thread-review"),
      });
      assert.strictEqual(sourceRows.length, 1);
      assert.strictEqual(reviewRows.length, 1);
      assert.strictEqual(sourceRows[0]?.reviewId, reviewId);
      assert.strictEqual(reviewRows[0]?.reviewId, reviewId);

      const chunks = yield* replayEvents.listByReviewId({ reviewId });
      assert.deepStrictEqual(
        chunks.map((chunk) => ({
          chunkIndex: chunk.chunkIndex,
          eventCount: chunk.eventCount,
        })),
        [
          { chunkIndex: 0, eventCount: 1 },
          { chunkIndex: 1, eventCount: 2 },
        ],
      );
      assert.strictEqual(yield* replayEvents.countByReviewId({ reviewId }), 3);
    }),
  );
});
