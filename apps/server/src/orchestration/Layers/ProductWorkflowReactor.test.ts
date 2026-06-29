import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  DEFAULT_WORKSPACE_USER_ID,
  EventId,
  MessageId,
  ProviderInstanceId,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { describe } from "vite-plus/test";

import { ServerConfig } from "../../config.ts";
import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { WORKFLOW_PROMPT_IDS } from "../../provider/WorkflowPromptRegistry.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { ProductWorkflowReactorLive } from "./ProductWorkflowReactor.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import {
  ProductWorkflowReactor,
  type ProductWorkflowReactorShape,
} from "../Services/ProductWorkflowReactor.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../Services/ProjectionSnapshotQuery.ts";

const now = "2026-01-01T00:00:00.000Z";
const projectId = ProjectId.make("project-product-reactor");
const productThreadId = ThreadId.make("thread-product-reactor");
const planningThreadId = ThreadId.make("thread-planning-reactor");

interface ProductSystem {
  readonly engine: OrchestrationEngineShape;
  readonly query: ProjectionSnapshotQueryShape;
  readonly reactor: ProductWorkflowReactorShape;
}

function commandId(value: string) {
  return CommandId.make(`cmd-${value}`);
}

function messageId(value: string) {
  return MessageId.make(`message-${value}`);
}

function eventId(value: string) {
  return EventId.make(`event-${value}`);
}

function makeTestLayer() {
  const coreLayer = Layer.mergeAll(
    OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
    ),
    OrchestrationProjectionSnapshotQueryLive,
  ).pipe(
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provide(SqlitePersistenceMemory),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "product-reactor-" })),
    Layer.provideMerge(NodeServices.layer),
  );

  return Layer.mergeAll(
    coreLayer,
    ProductWorkflowReactorLive.pipe(
      Layer.provide(coreLayer),
      Layer.provide(
        Layer.mock(GitWorkflowService)({
          resolveCommit: () => Effect.succeed({ commitSha: "abc123" }),
        }),
      ),
    ),
  );
}

function withSystem<A, E>(use: (system: ProductSystem) => Effect.Effect<A, E>) {
  return Effect.scoped(
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const query = yield* ProjectionSnapshotQuery;
      const reactor = yield* ProductWorkflowReactor;
      yield* reactor.start();
      return yield* use({ engine, query, reactor });
    }),
  ).pipe(Effect.provide(makeTestLayer()));
}

function seedProjectAndThread(
  system: ProductSystem,
  input: {
    readonly threadId?: ThreadId;
    readonly interactionMode?: "product-workflow" | "planning-workflow";
    readonly parentThreadId?: ThreadId | null;
    readonly workflowRole?: "planning-orchestrator" | null;
    readonly createProject?: boolean;
  } = {},
) {
  return Effect.gen(function* () {
    const threadId = input.threadId ?? productThreadId;
    if (input.createProject !== false) {
      yield* system.engine.dispatch({
        type: "project.create",
        commandId: commandId(`project-create-${threadId}`),
        projectId,
        title: "Product Reactor",
        workspaceRoot: "/tmp/product-reactor",
        createdAt: now,
      });
    }
    yield* system.engine.dispatch({
      type: "thread.create",
      commandId: commandId(`thread-create-${threadId}`),
      threadId,
      projectId,
      ownerUserId: DEFAULT_WORKSPACE_USER_ID,
      parentThreadId: input.parentThreadId ?? null,
      workflowRole: input.workflowRole ?? null,
      title: "Product",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
      runtimeMode: "full-access",
      interactionMode: input.interactionMode ?? "product-workflow",
      branch: null,
      worktreePath: null,
      createdAt: now,
    });
    return threadId;
  });
}

function lockProductIntent(system: ProductSystem) {
  return Effect.gen(function* () {
    yield* system.engine.dispatch({
      type: "thread.activity.append",
      commandId: commandId("intent-locked"),
      threadId: productThreadId,
      activity: {
        id: eventId("intent-locked"),
        tone: "info",
        kind: "product-intent-locked",
        summary: "Checkout",
        payload: { title: "Checkout", summaryMarkdown: "Locked." },
        turnId: null,
        createdAt: now,
      },
      createdAt: now,
    });
    yield* system.reactor.drain;
    const snapshot = yield* system.query.getSnapshot();
    const planningThread = snapshot.threads.find(
      (thread) =>
        thread.parentThreadId === productThreadId &&
        thread.workflowRole === "planning-orchestrator",
    );
    if (!planningThread) throw new Error("Planning orchestrator was not created.");
    return planningThread;
  });
}

function seedProductPrdAndIssues(system: ProductSystem, threadId: ThreadId) {
  return Effect.gen(function* () {
    yield* system.engine.dispatch({
      type: "thread.planning-prd.apply",
      commandId: commandId("prd-apply"),
      threadId,
      sourceMessageId: messageId("prd-source"),
      title: "Checkout",
      summaryMarkdown: "Build checkout.",
      createdAt: now,
    });
    const snapshotAfterPrd = yield* system.query.getSnapshot();
    const prd = snapshotAfterPrd.threads.find((thread) => thread.id === threadId)?.planningWorkflow
      ?.prd;
    if (!prd) throw new Error("PRD was not projected.");
    yield* system.engine.dispatch({
      type: "thread.planning-issues.apply",
      commandId: commandId("issues-apply"),
      threadId,
      sourceMessageId: messageId("issues-source"),
      prdId: prd.id,
      issues: [
        {
          key: "ISSUE-1",
          title: "Checkout tracer",
          bodyMarkdown: "Add a vertical checkout slice.",
          dependencyKeys: [],
        },
      ],
      createdAt: now,
    });
    yield* system.reactor.drain;
    return prd;
  });
}

describe("ProductWorkflowReactor", () => {
  it.effect("starts one child planning orchestrator after product intent locks", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        yield* seedProjectAndThread(system);
        const planningThread = yield* lockProductIntent(system);

        yield* system.engine.dispatch({
          type: "thread.activity.append",
          commandId: commandId("intent-locked-duplicate"),
          threadId: productThreadId,
          activity: {
            id: eventId("intent-locked-duplicate"),
            tone: "info",
            kind: "product-intent-locked",
            summary: "Checkout",
            payload: { title: "Checkout", summaryMarkdown: "Locked again." },
            turnId: null,
            createdAt: now,
          },
          createdAt: now,
        });
        yield* system.reactor.drain;

        const snapshot = yield* system.query.getSnapshot();
        const planningChildren = snapshot.threads.filter(
          (thread) =>
            thread.parentThreadId === productThreadId &&
            thread.workflowRole === "planning-orchestrator",
        );
        const events = yield* Stream.runCollect(system.engine.readEvents(0)).pipe(
          Effect.map((chunk) => Array.from(chunk)),
        );
        expect(planningChildren).toHaveLength(1);
        expect(planningChildren[0]?.id).toBe(planningThread.id);
        expect(planningChildren[0]?.interactionMode).toBe("planning-workflow");
        expect(planningThread.planningWorkflow?.stage).toBe("prd-authoring");
        expect(
          events.some(
            (event) =>
              event.type === "thread.turn-start-requested" &&
              event.payload.threadId === planningThread.id &&
              event.payload.workflowPromptId === WORKFLOW_PROMPT_IDS.planningPrdCodex,
          ),
        ).toBe(true);
      }),
    ),
  );

  it.effect("requests automatic issue review when product issues are created", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        yield* seedProjectAndThread(system);
        const planningThread = yield* lockProductIntent(system);
        yield* seedProductPrdAndIssues(system, planningThread.id);

        const snapshot = yield* system.query.getSnapshot();
        const child = snapshot.threads.find((entry) => entry.id === planningThread.id);
        const reviewer = snapshot.threads.find(
          (entry) => entry.workflowRole === "planning-reviewer",
        );
        const events = yield* Stream.runCollect(system.engine.readEvents(0)).pipe(
          Effect.map((chunk) => Array.from(chunk)),
        );
        expect(child?.planningWorkflow?.stage).toBe("issue-review");
        expect(reviewer?.parentThreadId).toBe(planningThread.id);
        expect(reviewer?.interactionMode).toBe("planning-workflow");
        expect(
          events.some(
            (event) =>
              event.type === "thread.turn-start-requested" &&
              event.payload.threadId === reviewer?.id &&
              event.payload.workflowPromptId === WORKFLOW_PROMPT_IDS.planningIssueReviewerCodex,
          ),
        ).toBe(true);
      }),
    ),
  );

  it.effect("revises product issues after failed review and blocks at max failed reviews", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        yield* seedProjectAndThread(system);
        const planningThread = yield* lockProductIntent(system);
        const prd = yield* seedProductPrdAndIssues(system, planningThread.id);

        for (let index = 1; index <= 5; index += 1) {
          yield* system.engine.dispatch({
            type: "thread.planning-reviewer-verdict.apply",
            commandId: commandId(`verdict-${index}`),
            threadId: planningThread.id,
            reviewerThreadId: ThreadId.make(`thread-reviewer-${index}`),
            reviewerMessageId: messageId(`reviewer-${index}`),
            verdictMarkdown: "failed: missing acceptance detail",
            passed: false,
            failingPlanningIssueIds: [prd.id],
            createdAt: `2026-01-01T00:00:0${index}.000Z`,
          });
          yield* system.reactor.drain;
        }

        const snapshot = yield* system.query.getSnapshot();
        const root = snapshot.threads.find((entry) => entry.id === productThreadId);
        const child = snapshot.threads.find((entry) => entry.id === planningThread.id);
        const events = yield* Stream.runCollect(system.engine.readEvents(0)).pipe(
          Effect.map((chunk) => Array.from(chunk)),
        );
        expect(child?.planningWorkflow?.stage).toBe("needs-human-attention");
        expect(
          root?.activities.some(
            (activity) => activity.kind === "product-workflow.needs-human-attention",
          ),
        ).toBe(true);
        expect(
          events.some(
            (event) =>
              event.type === "thread.turn-start-requested" &&
              event.payload.threadId === planningThread.id &&
              event.payload.workflowPromptId === WORKFLOW_PROMPT_IDS.planningIssuesCodex,
          ),
        ).toBe(true);
      }),
    ),
  );

  it.effect("launches implementation from the Product Grill root after passed product review", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        yield* seedProjectAndThread(system);
        const planningThread = yield* lockProductIntent(system);
        const prd = yield* seedProductPrdAndIssues(system, planningThread.id);
        yield* system.engine.dispatch({
          type: "thread.planning-reviewer-verdict.apply",
          commandId: commandId("passed-verdict"),
          threadId: planningThread.id,
          reviewerThreadId: ThreadId.make("thread-reviewer-pass"),
          reviewerMessageId: messageId("reviewer-pass"),
          verdictMarkdown: "passed",
          passed: true,
          createdAt: "2026-01-01T00:00:10.000Z",
        });
        yield* system.reactor.drain;

        const snapshot = yield* system.query.getSnapshot();
        expect(snapshot.implementationRuns.some((run) => run.prdId === prd.id)).toBe(true);
        const implementationOrchestrator = snapshot.threads.find(
          (thread) => thread.workflowRole === "implementation-orchestrator",
        );
        expect(implementationOrchestrator?.parentThreadId).toBe(productThreadId);
      }),
    ),
  );

  it.effect("ignores normal planning workflows", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        yield* seedProjectAndThread(system);
        yield* seedProjectAndThread(system, {
          threadId: planningThreadId,
          interactionMode: "planning-workflow",
          createProject: false,
        });
        yield* system.engine.dispatch({
          type: "thread.planning-prd.apply",
          commandId: commandId("normal-prd-apply"),
          threadId: planningThreadId,
          sourceMessageId: messageId("normal-prd-source"),
          title: "Normal plan",
          summaryMarkdown: "Normal planning workflow.",
          createdAt: now,
        });
        let snapshot = yield* system.query.getSnapshot();
        const normalPrd = snapshot.threads.find((thread) => thread.id === planningThreadId)
          ?.planningWorkflow?.prd;
        if (!normalPrd) throw new Error("Normal PRD missing.");
        yield* system.engine.dispatch({
          type: "thread.planning-reviewer-verdict.apply",
          commandId: commandId("normal-passed-verdict"),
          threadId: planningThreadId,
          reviewerThreadId: ThreadId.make("thread-normal-reviewer-pass"),
          reviewerMessageId: messageId("normal-reviewer-pass"),
          verdictMarkdown: "passed",
          passed: true,
          createdAt: "2026-01-01T00:00:11.000Z",
        });
        yield* system.reactor.drain;

        snapshot = yield* system.query.getSnapshot();
        expect(snapshot.implementationRuns.some((run) => run.prdId === normalPrd.id)).toBe(false);
      }),
    ),
  );
});
