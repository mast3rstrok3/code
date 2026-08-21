import {
  CommandId,
  DEFAULT_WORKSPACE_USER_ID,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ServerConfig } from "../../config.ts";

const CREATED_AT = "2026-01-01T00:00:00.000Z";
const CODEX_SELECTION = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5-codex",
};
const ROOT_THREAD_ID = ThreadId.make("thread-root");

const layer = it.layer(
  OrchestrationEngineLive.pipe(
    Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provide(OrchestrationProjectionPipelineLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-workflow-step-review-parts-" }),
    ),
    Layer.provideMerge(NodeServices.layer),
  ),
);

const seedWorkflowRoot = Effect.fn("seedWorkflowRoot")(function* () {
  const engine = yield* OrchestrationEngineService;
  yield* engine.dispatch({
    type: "project.create",
    commandId: CommandId.make("cmd-project"),
    projectId: ProjectId.make("project-1"),
    title: "Project",
    workspaceRoot: "/tmp/project-1",
    defaultModelSelection: CODEX_SELECTION,
    createdAt: CREATED_AT,
  });
  yield* engine.dispatch({
    type: "thread.create",
    commandId: CommandId.make("cmd-thread"),
    threadId: ROOT_THREAD_ID,
    projectId: ProjectId.make("project-1"),
    ownerUserId: DEFAULT_WORKSPACE_USER_ID,
    title: "Engineering Workflow",
    modelSelection: CODEX_SELECTION,
    runtimeMode: "full-access",
    interactionMode: "planning-workflow",
    branch: null,
    worktreePath: null,
    createdAt: CREATED_AT,
  });
});

layer("workflow step review parts projection", (it) => {
  // The reactors read the run's parts from the command read model and the
  // panel's switches read them from the shell snapshot. A projection that
  // stored the override without reading it back left the toggle looking dead
  // and the run verifying with a part the user had turned off.
  it.effect("round-trips review parts into the command read model and the shell snapshot", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      yield* seedWorkflowRoot();

      yield* engine.dispatch({
        type: "thread.workflow.step-review-parts.set",
        commandId: CommandId.make("cmd-set-parts"),
        threadId: ROOT_THREAD_ID,
        workflowPromptId: "implementation.browser-app-review.codex",
        parts: { e2e: true, browser: false },
        createdAt: CREATED_AT,
      });

      const readModel = yield* snapshotQuery.getCommandReadModel();
      assert.deepEqual(
        readModel.threads.find((thread) => thread.id === ROOT_THREAD_ID)?.workflowStepReviewParts,
        [
          {
            workflowPromptId: "implementation.browser-app-review.codex",
            e2e: true,
            browser: false,
          },
        ],
      );

      const shells = yield* snapshotQuery.getShellSnapshot();
      assert.deepEqual(
        shells.threads.find((thread) => thread.id === ROOT_THREAD_ID)?.workflowStepReviewParts,
        [
          {
            workflowPromptId: "implementation.browser-app-review.codex",
            e2e: true,
            browser: false,
          },
        ],
      );

      const shell = yield* snapshotQuery.getThreadShellById(ROOT_THREAD_ID);
      assert.deepEqual(Option.getOrUndefined(shell)?.workflowStepReviewParts, [
        {
          workflowPromptId: "implementation.browser-app-review.codex",
          e2e: true,
          browser: false,
        },
      ]);
    }),
  );

  it.effect("keeps the ticket entry separate from the step entry, and clears one at a time", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      yield* seedWorkflowRoot();

      yield* engine.dispatch({
        type: "thread.workflow.step-review-parts.set",
        commandId: CommandId.make("cmd-set-step"),
        threadId: ROOT_THREAD_ID,
        workflowPromptId: "implementation.browser-app-review.codex",
        parts: { e2e: true, browser: false },
        createdAt: CREATED_AT,
      });
      yield* engine.dispatch({
        type: "thread.workflow.step-review-parts.set",
        commandId: CommandId.make("cmd-set-ticket"),
        threadId: ROOT_THREAD_ID,
        workflowPromptId: "implementation.browser-app-review.codex",
        stepWorkflowPromptId: "implementation.tdd.codex",
        parts: { e2e: false, browser: true },
        createdAt: CREATED_AT,
      });

      const both = yield* snapshotQuery.getCommandReadModel();
      assert.deepEqual(
        both.threads.find((thread) => thread.id === ROOT_THREAD_ID)?.workflowStepReviewParts,
        [
          {
            workflowPromptId: "implementation.browser-app-review.codex",
            e2e: true,
            browser: false,
          },
          {
            workflowPromptId: "implementation.browser-app-review.codex",
            stepWorkflowPromptId: "implementation.tdd.codex",
            e2e: false,
            browser: true,
          },
        ],
      );

      yield* engine.dispatch({
        type: "thread.workflow.step-review-parts.set",
        commandId: CommandId.make("cmd-clear-ticket"),
        threadId: ROOT_THREAD_ID,
        workflowPromptId: "implementation.browser-app-review.codex",
        stepWorkflowPromptId: "implementation.tdd.codex",
        parts: null,
        createdAt: CREATED_AT,
      });

      const cleared = yield* snapshotQuery.getCommandReadModel();
      assert.deepEqual(
        cleared.threads.find((thread) => thread.id === ROOT_THREAD_ID)?.workflowStepReviewParts,
        [
          {
            workflowPromptId: "implementation.browser-app-review.codex",
            e2e: true,
            browser: false,
          },
        ],
      );
    }),
  );
});
