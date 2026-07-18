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

function lockProductFeatureIntent(system: ProductSystem) {
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
        payload: { title: "Checkout", summaryMarkdown: "Locked.", intentKind: "feature" },
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

function seedProductSpecAndTickets(system: ProductSystem, threadId: ThreadId) {
  return Effect.gen(function* () {
    yield* system.engine.dispatch({
      type: "thread.planning-spec.apply",
      commandId: commandId("spec-apply"),
      threadId,
      sourceMessageId: messageId("spec-source"),
      title: "Checkout",
      summaryMarkdown: "Build checkout.",
      createdAt: now,
    });
    const snapshotAfterSpec = yield* system.query.getSnapshot();
    const spec = snapshotAfterSpec.threads.find((thread) => thread.id === threadId)
      ?.planningWorkflow?.spec;
    if (!spec) throw new Error("Spec was not projected.");
    yield* system.engine.dispatch({
      type: "thread.planning-tickets.apply",
      commandId: commandId("tickets-apply"),
      threadId,
      sourceMessageId: messageId("tickets-source"),
      specId: spec.id,
      tickets: [
        {
          key: "TICKET-1",
          title: "Checkout tracer",
          bodyMarkdown: "Add a vertical checkout slice.",
          dependencyKeys: [],
        },
      ],
      createdAt: now,
    });
    yield* system.reactor.drain;
    return spec;
  });
}

function lockProductFixIntent(system: ProductSystem, suffix = "") {
  return Effect.gen(function* () {
    yield* system.engine.dispatch({
      type: "thread.activity.append",
      commandId: commandId(`fix-intent-locked${suffix}`),
      threadId: productThreadId,
      activity: {
        id: eventId(`fix-intent-locked${suffix}`),
        tone: "info",
        kind: "product-intent-locked",
        summary: "Checkout bug",
        payload: { title: "Checkout bug", summaryMarkdown: "Locked fix.", intentKind: "fix" },
        turnId: null,
        createdAt: now,
      },
      createdAt: now,
    });
    yield* system.reactor.drain;
  });
}

function upsertProposedPlan(
  system: ProductSystem,
  input: {
    readonly threadId?: ThreadId;
    readonly planId: string;
    readonly implementedAt?: string | null;
    readonly suffix?: string;
  },
) {
  return system.engine.dispatch({
    type: "thread.proposed-plan.upsert",
    commandId: commandId(`fix-plan-upsert-${input.planId}${input.suffix ?? ""}`),
    threadId: input.threadId ?? productThreadId,
    proposedPlan: {
      id: input.planId,
      turnId: null,
      planMarkdown: "# Fix checkout\nRepair the checkout flow.",
      implementedAt: input.implementedAt ?? null,
      implementationThreadId: null,
      createdAt: now,
      updatedAt: now,
    },
    createdAt: now,
  });
}

describe("ProductWorkflowReactor", () => {
  it.effect("starts the planning workflow for an explicit feature intent", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        yield* seedProjectAndThread(system);
        const planningThread = yield* lockProductFeatureIntent(system);

        yield* system.engine.dispatch({
          type: "thread.activity.append",
          commandId: commandId("intent-locked-duplicate"),
          threadId: productThreadId,
          activity: {
            id: eventId("intent-locked-duplicate"),
            tone: "info",
            kind: "product-intent-locked",
            summary: "Checkout",
            payload: {
              title: "Checkout",
              summaryMarkdown: "Locked again.",
              intentKind: "feature",
            },
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
        expect(planningThread.planningWorkflow?.stage).toBe("spec-authoring");
        expect(
          events.some(
            (event) =>
              event.type === "thread.turn-start-requested" &&
              event.payload.threadId === planningThread.id &&
              event.payload.workflowPromptId === WORKFLOW_PROMPT_IDS.planningSpecCodex,
          ),
        ).toBe(true);
      }),
    ),
  );

  it.effect("requests automatic ticket review when product tickets are created", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        yield* seedProjectAndThread(system);
        const planningThread = yield* lockProductFeatureIntent(system);
        yield* seedProductSpecAndTickets(system, planningThread.id);

        const snapshot = yield* system.query.getSnapshot();
        const child = snapshot.threads.find((entry) => entry.id === planningThread.id);
        const reviewer = snapshot.threads.find(
          (entry) => entry.workflowRole === "planning-reviewer",
        );
        const events = yield* Stream.runCollect(system.engine.readEvents(0)).pipe(
          Effect.map((chunk) => Array.from(chunk)),
        );
        expect(child?.planningWorkflow?.stage).toBe("ticket-review");
        expect(reviewer?.parentThreadId).toBe(planningThread.id);
        expect(reviewer?.interactionMode).toBe("planning-workflow");
        expect(
          events.some(
            (event) =>
              event.type === "thread.turn-start-requested" &&
              event.payload.threadId === reviewer?.id &&
              event.payload.workflowPromptId === WORKFLOW_PROMPT_IDS.planningTicketReviewerCodex,
          ),
        ).toBe(true);
      }),
    ),
  );

  it.effect("revises product tickets after failed review and blocks at max failed reviews", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        yield* seedProjectAndThread(system);
        const planningThread = yield* lockProductFeatureIntent(system);
        const spec = yield* seedProductSpecAndTickets(system, planningThread.id);

        for (let index = 1; index <= 5; index += 1) {
          yield* system.engine.dispatch({
            type: "thread.planning-reviewer-verdict.apply",
            commandId: commandId(`verdict-${index}`),
            threadId: planningThread.id,
            reviewerThreadId: ThreadId.make(`thread-reviewer-${index}`),
            reviewerMessageId: messageId(`reviewer-${index}`),
            verdictMarkdown: "failed: missing acceptance detail",
            passed: false,
            failingPlanningTicketIds: [spec.id],
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
              event.payload.workflowPromptId === WORKFLOW_PROMPT_IDS.planningTicketsCodex,
          ),
        ).toBe(true);
      }),
    ),
  );

  it.effect(
    "launches implementation from the Product Workflow root after passed product review",
    () =>
      withSystem((system) =>
        Effect.gen(function* () {
          yield* seedProjectAndThread(system);
          const planningThread = yield* lockProductFeatureIntent(system);
          const spec = yield* seedProductSpecAndTickets(system, planningThread.id);
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
          expect(snapshot.implementationRuns.some((run) => run.specId === spec.id)).toBe(true);
          const implementationOrchestrator = snapshot.threads.find(
            (thread) => thread.workflowRole === "implementation-orchestrator",
          );
          expect(implementationOrchestrator?.parentThreadId).toBe(productThreadId);
        }),
      ),
  );

  it.effect("switches the product thread to plan mode for fix intents and skips planning", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        yield* seedProjectAndThread(system);
        yield* lockProductFixIntent(system);
        yield* lockProductFixIntent(system, "-duplicate");

        const snapshot = yield* system.query.getSnapshot();
        const root = snapshot.threads.find((thread) => thread.id === productThreadId);
        const planningChildren = snapshot.threads.filter(
          (thread) =>
            thread.parentThreadId === productThreadId &&
            thread.workflowRole === "planning-orchestrator",
        );
        const events = yield* Stream.runCollect(system.engine.readEvents(0)).pipe(
          Effect.map((chunk) => Array.from(chunk)),
        );
        const fixPlanTurnStarts = events.filter(
          (event) =>
            event.type === "thread.turn-start-requested" &&
            event.payload.threadId === productThreadId,
        );
        expect(root?.interactionMode).toBe("plan");
        expect(planningChildren).toHaveLength(0);
        expect(fixPlanTurnStarts).toHaveLength(1);
        const turnStart = fixPlanTurnStarts[0];
        if (turnStart?.type !== "thread.turn-start-requested") throw new Error("Missing turn.");
        expect(turnStart.payload.interactionMode).toBe("plan");
        expect(turnStart.payload.workflowPromptId).toBeUndefined();
        expect(
          root?.activities.some((activity) => activity.kind === "product-fix-plan-started"),
        ).toBe(true);
      }),
    ),
  );

  it.effect("launches a build sub-thread once the fix plan is proposed", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        yield* seedProjectAndThread(system);
        yield* lockProductFixIntent(system);

        yield* upsertProposedPlan(system, { planId: "plan-1" });
        yield* system.reactor.drain;
        yield* upsertProposedPlan(system, { planId: "plan-1", suffix: "-again" });
        yield* upsertProposedPlan(system, {
          planId: "plan-2",
          implementedAt: "2026-01-01T00:00:05.000Z",
        });
        yield* system.reactor.drain;

        const snapshot = yield* system.query.getSnapshot();
        const implementers = snapshot.threads.filter(
          (thread) => thread.workflowRole === "product-fix-implementer",
        );
        const events = yield* Stream.runCollect(system.engine.readEvents(0)).pipe(
          Effect.map((chunk) => Array.from(chunk)),
        );
        expect(implementers).toHaveLength(1);
        const implementer = implementers[0];
        expect(implementer?.parentThreadId).toBe(productThreadId);
        expect(implementer?.interactionMode).toBe("default");
        expect(implementer?.title).toBe("Implement Fix checkout");
        expect(
          events.some(
            (event) =>
              event.type === "thread.turn-start-requested" &&
              event.payload.threadId === implementer?.id &&
              event.payload.sourceProposedPlan?.threadId === productThreadId &&
              event.payload.sourceProposedPlan?.planId === "plan-1",
          ),
        ).toBe(true);
        expect(
          implementer?.messages.some((message) =>
            message.text.startsWith("PLEASE IMPLEMENT THIS PLAN:"),
          ),
        ).toBe(true);
        const root = snapshot.threads.find((thread) => thread.id === productThreadId);
        expect(
          root?.activities.some(
            (activity) => activity.kind === "product-fix-implementation-started",
          ),
        ).toBe(true);
      }),
    ),
  );

  it.effect("ignores proposed plans from ordinary plan threads", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        yield* seedProjectAndThread(system);
        const ordinaryThreadId = ThreadId.make("thread-ordinary-plan");
        yield* system.engine.dispatch({
          type: "thread.create",
          commandId: commandId("ordinary-plan-create"),
          threadId: ordinaryThreadId,
          projectId,
          ownerUserId: DEFAULT_WORKSPACE_USER_ID,
          parentThreadId: null,
          workflowRole: null,
          title: "Ordinary plan",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
          runtimeMode: "full-access",
          interactionMode: "plan",
          branch: null,
          worktreePath: null,
          createdAt: now,
        });
        yield* upsertProposedPlan(system, { threadId: ordinaryThreadId, planId: "plan-3" });
        yield* system.reactor.drain;

        const snapshot = yield* system.query.getSnapshot();
        expect(
          snapshot.threads.some((thread) => thread.workflowRole === "product-fix-implementer"),
        ).toBe(false);
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
          type: "thread.planning-spec.apply",
          commandId: commandId("normal-spec-apply"),
          threadId: planningThreadId,
          sourceMessageId: messageId("normal-spec-source"),
          title: "Normal plan",
          summaryMarkdown: "Normal planning workflow.",
          createdAt: now,
        });
        let snapshot = yield* system.query.getSnapshot();
        const normalSpec = snapshot.threads.find((thread) => thread.id === planningThreadId)
          ?.planningWorkflow?.spec;
        if (!normalSpec) throw new Error("Normal Spec missing.");
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
        expect(snapshot.implementationRuns.some((run) => run.specId === normalSpec.id)).toBe(false);
      }),
    ),
  );
});
