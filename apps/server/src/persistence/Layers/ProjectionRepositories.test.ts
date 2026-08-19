import {
  DEFAULT_WORKSPACE_USER_ID,
  AppReviewId,
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
import { ProjectionThreadAppReviewRepositoryLive } from "./ProjectionThreadAppReviews.ts";
import { ProjectionProjectRepository } from "../Services/ProjectionProjects.ts";
import { ProjectionThreadRepository } from "../Services/ProjectionThreads.ts";
import { ProjectionThreadAppReviewRepository } from "../Services/ProjectionThreadAppReviews.ts";

const projectionRepositoriesLayer = it.layer(
  Layer.mergeAll(
    ProjectionProjectRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    ProjectionThreadRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    ProjectionThreadAppReviewRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    SqlitePersistenceMemory,
  ),
);

projectionRepositoriesLayer("Projection repositories", (it) => {
  it.effect("round-trips a project's App Review recording override", () =>
    Effect.gen(function* () {
      const projects = yield* ProjectionProjectRepository;
      const projectId = ProjectId.make("project-recording-mode");

      const row = {
        projectId,
        title: "Recording mode project",
        workspaceRoot: "/tmp/project-recording-mode",
        defaultModelSelection: null,
        defaultThreadEnvMode: null,
        previewRecordingMode: "video" as const,
        scripts: [],
        createdAt: "2026-08-19T00:00:00.000Z",
        updatedAt: "2026-08-19T00:00:00.000Z",
        deletedAt: null,
      };
      yield* projects.upsert(row);

      const stored = yield* projects.getById({ projectId });
      assert.strictEqual(
        Option.isSome(stored) ? stored.value.previewRecordingMode : "missing",
        "video",
      );

      // Clearing the override has to land as NULL, not stick at the old value.
      yield* projects.upsert({ ...row, previewRecordingMode: null });
      const cleared = yield* projects.getById({ projectId });
      assert.strictEqual(
        Option.isSome(cleared) ? cleared.value.previewRecordingMode : "missing",
        null,
      );
    }),
  );

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
        defaultThreadEnvMode: null,
        previewRecordingMode: null,
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
        settledOverride: null,
        settledAt: null,
        snoozedUntil: null,
        snoozedAt: null,
        pinnedAt: null,
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

  it.effect("round-trips App Review evidence through the projection row", () =>
    Effect.gen(function* () {
      const appReviews = yield* ProjectionThreadAppReviewRepository;
      const reviewId = AppReviewId.make("app-review-persisted");
      const evidence = {
        recording: {
          status: "saved" as const,
          path: "app-reviews/app-review-persisted/recording.webm",
          mimeType: "video/webm",
          sizeBytes: 2048,
          startedAt: "2026-03-24T00:00:00.000Z",
          completedAt: "2026-03-24T00:00:05.000Z",
          error: null,
        },
        screenshots: [
          {
            id: "screenshot-1",
            path: "app-reviews/app-review-persisted/screenshot-1.png",
            mimeType: "image/png" as const,
            caption: "Landing page after load",
            capturedAt: "2026-03-24T00:00:02.000Z",
          },
        ],
      };

      yield* appReviews.upsert({
        reviewId,
        sourceThreadId: ThreadId.make("thread-source"),
        reviewThreadId: ThreadId.make("thread-review"),
        sourceProposedPlan: {
          threadId: ThreadId.make("thread-source"),
          planId: "plan-app-review-anchor",
        },
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
        evidence,
        createdAt: "2026-03-24T00:00:00.000Z",
        updatedAt: "2026-03-24T00:00:00.000Z",
      });

      const sourceRows = yield* appReviews.listByThreadId({
        threadId: ThreadId.make("thread-source"),
      });
      const reviewRows = yield* appReviews.listByThreadId({
        threadId: ThreadId.make("thread-review"),
      });
      assert.strictEqual(sourceRows.length, 1);
      assert.strictEqual(reviewRows.length, 1);
      assert.strictEqual(sourceRows[0]?.reviewId, reviewId);
      assert.strictEqual(reviewRows[0]?.reviewId, reviewId);
      assert.deepStrictEqual(sourceRows[0]?.evidence, evidence);
      assert.deepStrictEqual(sourceRows[0]?.sourceProposedPlan, {
        threadId: ThreadId.make("thread-source"),
        planId: "plan-app-review-anchor",
      });

      const persisted = yield* appReviews.getById({ reviewId });
      assert.deepStrictEqual(Option.getOrNull(persisted)?.evidence, evidence);
    }),
  );

  it.effect("round-trips non-null settlement values through the thread row", () =>
    Effect.gen(function* () {
      const threads = yield* ProjectionThreadRepository;

      yield* threads.upsert({
        threadId: ThreadId.make("thread-settled"),
        projectId: ProjectId.make("project-1"),
        ownerUserId: DEFAULT_WORKSPACE_USER_ID,
        parentThreadId: null,
        workflowRole: null,
        title: "Settled thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurnId: null,
        createdAt: "2026-03-24T00:00:00.000Z",
        updatedAt: "2026-03-25T00:00:00.000Z",
        archivedAt: null,
        settledOverride: "settled",
        settledAt: "2026-03-25T00:00:00.000Z",
        snoozedUntil: "2026-03-26T09:00:00.000Z",
        snoozedAt: "2026-03-25T00:00:00.000Z",
        pinnedAt: "2026-03-25T00:00:00.000Z",
        latestUserMessageAt: null,
        pendingApprovalCount: 0,
        pendingUserInputCount: 0,
        hasActionableProposedPlan: 0,
        planningWorkflowStage: null,
        deletedAt: null,
      });

      const persisted = yield* threads.getById({
        threadId: ThreadId.make("thread-settled"),
      });
      const row = Option.getOrNull(persisted);
      if (!row) {
        return yield* Effect.die("Expected settled projection_threads row to exist.");
      }
      assert.strictEqual(row.settledOverride, "settled");
      assert.strictEqual(row.settledAt, "2026-03-25T00:00:00.000Z");
      assert.strictEqual(row.snoozedUntil, "2026-03-26T09:00:00.000Z");
      assert.strictEqual(row.snoozedAt, "2026-03-25T00:00:00.000Z");
      assert.strictEqual(row.pinnedAt, "2026-03-25T00:00:00.000Z");

      // Un-settle to the keep-active pin and wake the snooze; confirm the
      // flips persist.
      yield* threads.upsert({
        ...row,
        settledOverride: "active",
        settledAt: null,
        snoozedUntil: null,
        snoozedAt: null,
        pinnedAt: null,
      });
      const repersisted = yield* threads.getById({
        threadId: ThreadId.make("thread-settled"),
      });
      const updated = Option.getOrNull(repersisted);
      assert.strictEqual(updated?.settledOverride, "active");
      assert.strictEqual(updated?.settledAt, null);
      assert.strictEqual(updated?.snoozedUntil, null);
      assert.strictEqual(updated?.snoozedAt, null);
      assert.strictEqual(updated?.pinnedAt, null);
    }),
  );
});
