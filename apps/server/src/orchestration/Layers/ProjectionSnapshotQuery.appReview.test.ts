import { AppReviewId, AppReviewWorkflowRun, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { RepositoryIdentityResolver } from "../../project/RepositoryIdentityResolver.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";

const now = "2026-09-27T00:00:00.000Z";
const encodeRun = Schema.encodeSync(Schema.fromJsonString(AppReviewWorkflowRun));
const revision = {
  headSha: "abc123",
  workingTreeDiffHash: "working",
  branchDiffHash: "branch",
  fingerprint: "abc123:working:branch",
};
const run = Schema.decodeUnknownSync(AppReviewWorkflowRun)({
  id: "run-1",
  targetThreadId: "target",
  controllerThreadId: "controller",
  caller: { type: "standalone", sourceThreadId: "target" },
  briefMarkdown: "Review checkout.",
  supportingContextMarkdown: null,
  previewTargets: [],
  cycleBudget: 5,
  cyclesUsed: 2,
  status: "running",
  activePhase: "review",
  activeThreadId: "active-reviewer",
  phaseExecution: null,
  cycles: [1, 2].map((cycleNumber) => ({
    cycleNumber,
    status: "reviewing",
    reviewId: `review-${cycleNumber}`,
    e2eReviewId: `e2e-review-${cycleNumber}`,
    e2eThreadId: `tester-${cycleNumber}`,
    reviewerThreadId: `reviewer-${cycleNumber}`,
    plannerThreadId: `planner-${cycleNumber}`,
    fixerThreadId: `fixer-${cycleNumber}`,
    reviewVerdict: null,
    actionableFindingsMarkdown: null,
    planId: null,
    plannerTurnId: null,
    fixResult: null,
    workspaceRevision: revision,
    startedAt: now,
    completedAt: null,
  })),
  workspaceRevision: revision,
  finalHeadSha: null,
  outcome: null,
  failure: null,
  createdAt: now,
  updatedAt: now,
  completedAt: null,
});

it.effect("looks up review ownership without decoding unrelated snapshot data", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const query = yield* ProjectionSnapshotQuery;
    yield* sql`INSERT INTO projection_app_review_workflow_runs (
      run_id, target_thread_id, controller_thread_id, caller_type, caller_thread_id,
      status, run_json, created_at, updated_at
    ) VALUES
      ('unrelated', 'other-target', 'other-controller', 'standalone', 'other-target',
       'running', '{"cycles":[]}', ${now}, ${now}),
      (${run.id}, ${run.targetThreadId}, ${run.controllerThreadId}, 'standalone', 'target',
       ${run.status}, ${encodeRun(run)}, ${now}, ${now})`;

    for (const threadId of [
      "controller",
      "active-reviewer",
      ...[1, 2].flatMap((cycle) =>
        ["tester", "reviewer", "planner", "fixer"].map((role) => `${role}-${cycle}`),
      ),
    ]) {
      const result = yield* query.getAppReviewWorkflowRun({ threadId: ThreadId.make(threadId) });
      assert.equal(Option.getOrThrow(result).id, run.id);
    }
    for (const threadId of ["target", "unknown"]) {
      assert.isTrue(
        Option.isNone(yield* query.getAppReviewWorkflowRun({ threadId: ThreadId.make(threadId) })),
      );
    }

    for (const reviewId of ["review-1", "review-2", "e2e-review-1", "e2e-review-2"]) {
      const result = yield* query.getAppReviewWorkflowRun({ reviewId: AppReviewId.make(reviewId) });
      assert.equal(Option.getOrThrow(result).id, run.id);
    }
    assert.isTrue(
      Option.isNone(
        yield* query.getAppReviewWorkflowRun({ reviewId: AppReviewId.make("unknown") }),
      ),
    );

    yield* sql`INSERT INTO projection_projects
      (project_id, title, workspace_root, scripts_json, created_at, updated_at)
      VALUES ('project', 'Project', '/tmp/project', '[]', ${now}, ${now})`;
    yield* sql`INSERT INTO projection_threads
      (thread_id, project_id, title, parent_thread_id, model_selection_json, created_at, updated_at)
      VALUES
      ('root', 'project', 'Root', NULL, 'invalid-json', ${now}, ${now}),
      ('controller', 'project', 'Controller', 'root', 'invalid-json', ${now}, ${now}),
      ('unrelated-paused', 'project', 'Other', NULL, 'invalid-json', ${now}, ${now})`;
    yield* sql`UPDATE projection_threads SET workflow_paused_at = ${now}
      WHERE thread_id = 'unrelated-paused'`;

    for (const pausedThreadId of ["root", "controller"]) {
      yield* sql`UPDATE projection_threads SET workflow_paused_at = ${now}
        WHERE thread_id = ${pausedThreadId}`;
      for (const owner of [
        { threadId: ThreadId.make("fixer-2") },
        { reviewId: AppReviewId.make("review-2") },
      ]) {
        assert.isTrue(
          Option.isNone(yield* query.getAppReviewWorkflowRun({ ...owner, excludePaused: true })),
        );
        assert.equal(Option.getOrThrow(yield* query.getAppReviewWorkflowRun(owner)).id, run.id);
      }
      yield* sql`UPDATE projection_threads SET workflow_paused_at = NULL
        WHERE thread_id = ${pausedThreadId}`;
      assert.equal(
        Option.getOrThrow(
          yield* query.getAppReviewWorkflowRun({
            threadId: ThreadId.make("fixer-2"),
            excludePaused: true,
          }),
        ).id,
        run.id,
      );
    }

    const completed = { ...run, status: "passed" as const, activeThreadId: null, completedAt: now };
    yield* sql`UPDATE projection_app_review_workflow_runs
      SET status = 'passed', run_json = ${encodeRun(completed)} WHERE run_id = ${run.id}`;
    assert.isTrue(
      Option.isNone(
        yield* query.getAppReviewWorkflowRun({ threadId: ThreadId.make("reviewer-1") }),
      ),
    );
    const historical = yield* query.getAppReviewWorkflowRun({
      reviewId: AppReviewId.make("review-1"),
    });
    assert.equal(Option.getOrThrow(historical).status, "passed");
  }).pipe(
    Effect.provide(
      OrchestrationProjectionSnapshotQueryLive.pipe(
        Layer.provide(ThreadBackgroundLiveness.layer),
        Layer.provide(ThreadPlanProgress.layer),
        Layer.provide(
          Layer.succeed(RepositoryIdentityResolver, {
            resolve: () => Effect.die("Review ownership must not query Git"),
          }),
        ),
        Layer.provideMerge(SqlitePersistenceMemory),
      ),
    ),
  ),
);
