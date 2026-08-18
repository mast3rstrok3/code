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
const PINNED_SELECTION = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-opus-5",
};

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
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-workflow-step-models-" }),
    ),
    Layer.provideMerge(NodeServices.layer),
  ),
);

layer("workflow step model projection", (it) => {
  it.effect("round-trips a pin through the projection and back into the read model", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const snapshotQuery = yield* ProjectionSnapshotQuery;

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
        threadId: ThreadId.make("thread-root"),
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

      yield* engine.dispatch({
        type: "thread.workflow.step-model.set",
        commandId: CommandId.make("cmd-pin"),
        threadId: ThreadId.make("thread-root"),
        workflowPromptId: "implementation.code-review.codex",
        modelSelection: PINNED_SELECTION,
        createdAt: CREATED_AT,
      });

      const pinned = yield* snapshotQuery.getCommandReadModel();
      assert.deepEqual(
        pinned.threads.find((thread) => thread.id === "thread-root")?.workflowStepModels,
        [
          {
            workflowPromptId: "implementation.code-review.codex",
            modelSelection: PINNED_SELECTION,
          },
        ],
      );

      yield* engine.dispatch({
        type: "thread.workflow.step-model.set",
        commandId: CommandId.make("cmd-clear"),
        threadId: ThreadId.make("thread-root"),
        workflowPromptId: "implementation.code-review.codex",
        modelSelection: null,
        createdAt: CREATED_AT,
      });

      const cleared = yield* snapshotQuery.getCommandReadModel();
      const thread = cleared.threads.find((candidate) => candidate.id === "thread-root");
      assert.deepEqual(thread?.workflowStepModels ?? [], []);
    }),
  );
});
