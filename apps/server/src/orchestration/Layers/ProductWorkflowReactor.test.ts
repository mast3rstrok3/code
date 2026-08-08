import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  DEFAULT_WORKSPACE_USER_ID,
  EventId,
  MessageId,
  PLANNING_REVIEW_MAX_CYCLES,
  ProviderInstanceId,
  ProjectId,
  ThreadId,
  type WorkflowPreset,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
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

function withSystem<A, E>(
  use: (system: ProductSystem) => Effect.Effect<A, E, Scope.Scope>,
  options?: {
    /** Leave the reactor stopped so a test can dispatch events it must recover from on start. */
    readonly startReactor?: boolean;
  },
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const query = yield* ProjectionSnapshotQuery;
      const reactor = yield* ProductWorkflowReactor;
      if (options?.startReactor !== false) yield* reactor.start();
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
    readonly workflowPreset?: WorkflowPreset | null;
    readonly branch?: string | null;
    readonly createProject?: boolean;
    readonly runtimeMode?: "full-access" | "approval-required";
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
      runtimeMode: input.runtimeMode ?? "full-access",
      interactionMode: input.interactionMode ?? "product-workflow",
      workflowPreset: input.workflowPreset ?? null,
      branch: input.branch ?? null,
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
      (thread) => thread.id === productThreadId && thread.planningWorkflow !== null,
    );
    if (!planningThread) throw new Error("Planning did not start in the product root thread.");
    return planningThread;
  });
}

function seedProductSpecAndTickets(system: ProductSystem, threadId: ThreadId, ticketCount = 1) {
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
      tickets: Array.from({ length: ticketCount }, (_, index) => ({
        key: `TICKET-${index + 1}`,
        title: `Checkout tracer ${index + 1}`,
        bodyMarkdown: `Add vertical checkout slice ${index + 1}.`,
        plannedFileChanges: [
          {
            path: index === 0 ? "src/checkout.ts" : `src/checkout-${index + 1}.ts`,
            action: "update" as const,
          },
        ],
        dependencyKeys: [],
      })),
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
  it.effect("continues planning in the product root thread after product intent locks", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        yield* seedProjectAndThread(system, { runtimeMode: "approval-required" });
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
        const rootThread = snapshot.threads.find((thread) => thread.id === productThreadId);
        const planningChildren = snapshot.threads.filter(
          (thread) =>
            thread.parentThreadId === productThreadId &&
            thread.workflowRole === "planning-orchestrator",
        );
        const events = yield* Stream.runCollect(system.engine.readEvents(0)).pipe(
          Effect.map((chunk) => Array.from(chunk)),
        );
        expect(planningThread.id).toBe(productThreadId);
        expect(planningChildren).toHaveLength(0);
        expect(rootThread?.interactionMode).toBe("planning-workflow");
        expect(rootThread?.workflowPreset).toBe("full-feature");
        expect(rootThread?.runtimeMode).toBe("full-access");
        expect(rootThread?.workflowContext?.rootThreadId).toBe(productThreadId);
        expect(rootThread?.planningWorkflow?.stage).toBe("grill");
        const engineeringGrillTurnRequests = events.filter(
          (event) =>
            event.type === "thread.turn-start-requested" &&
            event.payload.threadId === productThreadId &&
            event.payload.workflowPromptId === WORKFLOW_PROMPT_IDS.planningGrillStageCodex,
        );
        expect(engineeringGrillTurnRequests).toHaveLength(1);
        const engineeringGrillPrompt = events.find(
          (event) =>
            event.type === "thread.message-sent" && event.payload.threadId === productThreadId,
        );
        expect(engineeringGrillPrompt?.type).toBe("thread.message-sent");
        if (engineeringGrillPrompt?.type === "thread.message-sent") {
          expect(engineeringGrillPrompt.payload.text).toContain(
            "Run the Planning Workflow Engineering Grill",
          );
          expect(engineeringGrillPrompt.payload.text).toContain(
            "Do not reopen or repeat Product Grill questions",
          );
        }
      }),
    ),
  );

  it.effect("requests automatic ticket review when product tickets are created", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        yield* seedProjectAndThread(system);
        const planningThread = yield* lockProductIntent(system);
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
        expect(child?.planningWorkflow?.tickets[0]?.plannedFileChanges).toEqual([
          { path: "src/checkout.ts", action: "update" },
        ]);
        expect(
          child?.messages.some((message) =>
            message.text.includes(
              "Every ticket must include at least one exact repository-relative",
            ),
          ),
        ).toBe(true);
        expect(reviewer?.parentThreadId).toBe(planningThread.id);
        expect(reviewer?.messages.at(-1)?.text).toContain(
          "verify every ticket has a complete, plausible plannedFileChanges list",
        );
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

  it.effect("continues product implementation with warnings after exhausted review cycles", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        yield* seedProjectAndThread(system);
        const planningThread = yield* lockProductIntent(system);
        const spec = yield* seedProductSpecAndTickets(system, planningThread.id);

        for (let index = 1; index <= PLANNING_REVIEW_MAX_CYCLES; index += 1) {
          const beforeVerdict = yield* system.query.getSnapshot();
          const workflow = beforeVerdict.threads.find(
            (entry) => entry.id === planningThread.id,
          )?.planningWorkflow;
          const activeReview = workflow?.activeReview;
          const ticketId = workflow?.tickets[0]?.id;
          if (activeReview == null || ticketId === undefined) {
            throw new Error(`Review cycle ${index} was not active.`);
          }
          yield* system.engine.dispatch({
            type: "thread.planning-reviewer-verdict.apply",
            commandId: commandId(`verdict-${index}`),
            threadId: planningThread.id,
            reviewerThreadId: activeReview.reviewerThreadId,
            reviewerMessageId: messageId(`reviewer-${index}`),
            cycleNumber: activeReview.cycleNumber,
            mode: activeReview.mode,
            targetPlanningTicketIds: [...activeReview.targetPlanningTicketIds],
            verdictMarkdown: "failed: missing acceptance detail",
            passed: false,
            failingPlanningTicketIds: [ticketId],
            createdAt: `2026-01-01T00:00:${String(index).padStart(2, "0")}.000Z`,
          });
          yield* system.reactor.drain;
        }

        const snapshot = yield* system.query.getSnapshot();
        const root = snapshot.threads.find((entry) => entry.id === productThreadId);
        const child = snapshot.threads.find((entry) => entry.id === planningThread.id);
        const events = yield* Stream.runCollect(system.engine.readEvents(0)).pipe(
          Effect.map((chunk) => Array.from(chunk)),
        );
        expect(child?.planningWorkflow?.stage).toBe("completed-with-warnings");
        expect(
          root?.activities.some(
            (activity) => activity.kind === "planning-workflow.completed-with-warnings",
          ),
        ).toBe(true);
        expect(snapshot.implementationRuns.some((run) => run.specId === spec.id)).toBe(true);
        expect(events).toBeDefined();
      }),
    ),
  );

  it.effect(
    "launches implementation from the Product Workflow root after passed product review",
    () =>
      withSystem((system) =>
        Effect.gen(function* () {
          yield* seedProjectAndThread(system);
          const planningThread = yield* lockProductIntent(system);
          const spec = yield* seedProductSpecAndTickets(system, planningThread.id);
          const beforeVerdict = yield* system.query.getSnapshot();
          const activeReview = beforeVerdict.threads.find(
            (thread) => thread.id === planningThread.id,
          )?.planningWorkflow?.activeReview;
          if (activeReview == null) throw new Error("Review was not active.");
          yield* system.engine.dispatch({
            type: "thread.planning-reviewer-verdict.apply",
            commandId: commandId("passed-verdict"),
            threadId: planningThread.id,
            reviewerThreadId: activeReview.reviewerThreadId,
            reviewerMessageId: messageId("reviewer-pass"),
            cycleNumber: activeReview.cycleNumber,
            mode: activeReview.mode,
            targetPlanningTicketIds: [...activeReview.targetPlanningTicketIds],
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

  it.effect("moves from full review to targeted review and completes after the targeted pass", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        yield* seedProjectAndThread(system);
        const planningThread = yield* lockProductIntent(system);
        yield* seedProductSpecAndTickets(system, planningThread.id);

        let snapshot = yield* system.query.getSnapshot();
        let workflow = snapshot.threads.find(
          (thread) => thread.id === planningThread.id,
        )?.planningWorkflow;
        let activeReview = workflow?.activeReview;
        const ticketId = workflow?.tickets[0]?.id;
        if (activeReview == null || ticketId === undefined) throw new Error("Cycle 1 missing.");
        expect(activeReview.mode).toBe("full");

        yield* system.engine.dispatch({
          type: "thread.planning-reviewer-verdict.apply",
          commandId: commandId("review-edit-cycle-1"),
          threadId: planningThread.id,
          reviewerThreadId: activeReview.reviewerThreadId,
          reviewerMessageId: messageId("review-edit-cycle-1"),
          cycleNumber: 1,
          mode: "full",
          targetPlanningTicketIds: [...activeReview.targetPlanningTicketIds],
          ticketEdits: [
            {
              type: "update",
              ticketId,
              bodyMarkdown: "Add a vertical checkout slice with explicit acceptance criteria.",
            },
          ],
          passed: true,
          verdictMarkdown: "Edited; requires another review.",
          createdAt: "2026-01-01T00:00:01.000Z",
        });
        yield* system.reactor.drain;

        snapshot = yield* system.query.getSnapshot();
        workflow = snapshot.threads.find(
          (thread) => thread.id === planningThread.id,
        )?.planningWorkflow;
        activeReview = workflow?.activeReview;
        expect(workflow?.reviewCycles[0]?.status).toBe("revised");
        expect(workflow?.tickets[0]?.plannedFileChanges).toEqual([
          { path: "src/checkout.ts", action: "update" },
        ]);
        expect(activeReview?.cycleNumber).toBe(2);
        expect(activeReview?.mode).toBe("targeted");
        expect(activeReview?.targetPlanningTicketIds).toEqual([ticketId]);
        if (activeReview == null) throw new Error("Cycle 2 missing.");

        yield* system.engine.dispatch({
          type: "thread.planning-reviewer-verdict.apply",
          commandId: commandId("review-targeted-pass-cycle-2"),
          threadId: planningThread.id,
          reviewerThreadId: activeReview.reviewerThreadId,
          reviewerMessageId: messageId("review-targeted-pass-cycle-2"),
          cycleNumber: 2,
          mode: "targeted",
          targetPlanningTicketIds: [ticketId],
          ticketEdits: [],
          passed: true,
          verdictMarkdown: "Targeted ticket passes.",
          createdAt: "2026-01-01T00:00:02.000Z",
        });
        yield* system.reactor.drain;

        snapshot = yield* system.query.getSnapshot();
        workflow = snapshot.threads.find(
          (thread) => thread.id === planningThread.id,
        )?.planningWorkflow;
        activeReview = workflow?.activeReview;
        expect(workflow?.stage).toBe("completed");
        expect(activeReview).toBeNull();
        expect(workflow?.reviewCycles.map((cycle) => cycle.mode)).toEqual(["full", "targeted"]);
        expect(snapshot.implementationRuns).toHaveLength(1);
      }),
    ),
  );

  it.effect("narrows each later review cycle to only the tickets that still fail", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        yield* seedProjectAndThread(system);
        const planningThread = yield* lockProductIntent(system);
        yield* seedProductSpecAndTickets(system, planningThread.id, 3);

        let snapshot = yield* system.query.getSnapshot();
        let workflow = snapshot.threads.find(
          (thread) => thread.id === planningThread.id,
        )?.planningWorkflow;
        let activeReview = workflow?.activeReview;
        const ticketIds = workflow?.tickets.map((ticket) => ticket.id) ?? [];
        if (activeReview == null || ticketIds.length !== 3) throw new Error("Cycle 1 missing.");
        expect(activeReview.mode).toBe("full");
        expect(activeReview.targetPlanningTicketIds).toEqual(ticketIds);

        yield* system.engine.dispatch({
          type: "thread.planning-reviewer-verdict.apply",
          commandId: commandId("review-multiple-failures-cycle-1"),
          threadId: planningThread.id,
          reviewerThreadId: activeReview.reviewerThreadId,
          reviewerMessageId: messageId("review-multiple-failures-cycle-1"),
          cycleNumber: 1,
          mode: "full",
          targetPlanningTicketIds: [...ticketIds],
          passed: false,
          failingPlanningTicketIds: [ticketIds[0]!, ticketIds[2]!],
          verdictMarkdown: "Two tickets failed.",
          createdAt: "2026-01-01T00:00:01.000Z",
        });
        yield* system.reactor.drain;

        snapshot = yield* system.query.getSnapshot();
        workflow = snapshot.threads.find(
          (thread) => thread.id === planningThread.id,
        )?.planningWorkflow;
        activeReview = workflow?.activeReview;
        if (activeReview == null) throw new Error("Cycle 2 missing.");
        expect(activeReview.mode).toBe("targeted");
        expect(activeReview.targetPlanningTicketIds).toEqual([ticketIds[0], ticketIds[2]]);

        yield* system.engine.dispatch({
          type: "thread.planning-reviewer-verdict.apply",
          commandId: commandId("review-one-failure-cycle-2"),
          threadId: planningThread.id,
          reviewerThreadId: activeReview.reviewerThreadId,
          reviewerMessageId: messageId("review-one-failure-cycle-2"),
          cycleNumber: 2,
          mode: "targeted",
          targetPlanningTicketIds: [...activeReview.targetPlanningTicketIds],
          passed: false,
          failingPlanningTicketIds: [ticketIds[2]!],
          verdictMarkdown: "One ticket still failed.",
          createdAt: "2026-01-01T00:00:02.000Z",
        });
        yield* system.reactor.drain;

        snapshot = yield* system.query.getSnapshot();
        activeReview = snapshot.threads.find((thread) => thread.id === planningThread.id)
          ?.planningWorkflow?.activeReview;
        expect(activeReview?.cycleNumber).toBe(3);
        expect(activeReview?.mode).toBe("targeted");
        expect(activeReview?.targetPlanningTicketIds).toEqual([ticketIds[2]]);
      }),
    ),
  );

  it.effect("switches the product thread to plan mode for fix intents and skips planning", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        yield* seedProjectAndThread(system, { runtimeMode: "approval-required" });
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
        expect(root?.runtimeMode).toBe("full-access");
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

  it.effect("re-seeds a fix implementer thread that was created but never handed the plan", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        yield* seedProjectAndThread(system);
        yield* lockProductFixIntent(system);

        // What a restart between `thread.create` and `thread.turn.start` leaves behind: a titled
        // Build-mode child with nothing in it.
        const strandedId = ThreadId.make("thread-product-fix-implementer-stranded");
        yield* system.engine.dispatch({
          type: "thread.create",
          commandId: commandId("stranded-fix-implementer"),
          threadId: strandedId,
          projectId,
          ownerUserId: DEFAULT_WORKSPACE_USER_ID,
          parentThreadId: productThreadId,
          workflowRole: "product-fix-implementer",
          title: "Implement Fix checkout",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: now,
        });

        yield* upsertProposedPlan(system, { planId: "plan-stranded" });
        yield* system.reactor.drain;

        const snapshot = yield* system.query.getSnapshot();
        const implementers = snapshot.threads.filter(
          (thread) => thread.workflowRole === "product-fix-implementer",
        );
        expect(implementers).toHaveLength(1);
        expect(implementers[0]?.id).toBe(strandedId);
        expect(
          implementers[0]?.messages.filter((message) =>
            message.text.startsWith("PLEASE IMPLEMENT THIS PLAN:"),
          ),
        ).toHaveLength(1);
        expect(implementers[0]?.messages.at(-1)?.text).toContain("# Fix checkout");
      }),
    ),
  );

  it.effect("leaves an already handed over fix implementer alone", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        yield* seedProjectAndThread(system);
        yield* lockProductFixIntent(system);
        yield* upsertProposedPlan(system, { planId: "plan-1" });
        yield* system.reactor.drain;

        // Startup reconciliation runs over the same plan; the handover must not be sent twice.
        yield* system.reactor.start();
        yield* system.reactor.drain;

        const snapshot = yield* system.query.getSnapshot();
        const implementers = snapshot.threads.filter(
          (thread) => thread.workflowRole === "product-fix-implementer",
        );
        expect(implementers).toHaveLength(1);
        expect(
          implementers[0]?.messages.filter((message) =>
            message.text.startsWith("PLEASE IMPLEMENT THIS PLAN:"),
          ),
        ).toHaveLength(1);
      }),
    ),
  );

  it.effect("hands over a fix plan whose implementer thread was never created", () =>
    withSystem(
      (system) =>
        Effect.gen(function* () {
          // With the reactor stopped, `thread.proposed-plan-upserted` is never delivered — the
          // live event stream does not replay. Only startup reconciliation can close the gap.
          yield* seedProjectAndThread(system);
          yield* lockProductFixIntent(system);
          yield* upsertProposedPlan(system, { planId: "plan-missed" });

          let snapshot = yield* system.query.getSnapshot();
          expect(
            snapshot.threads.some((thread) => thread.workflowRole === "product-fix-implementer"),
          ).toBe(false);

          yield* system.reactor.start();
          yield* system.reactor.drain;

          snapshot = yield* system.query.getSnapshot();
          const implementers = snapshot.threads.filter(
            (thread) => thread.workflowRole === "product-fix-implementer",
          );
          expect(implementers).toHaveLength(1);
          expect(implementers[0]?.interactionMode).toBe("default");
          expect(implementers[0]?.parentThreadId).toBe(productThreadId);
          expect(implementers[0]?.messages.at(-1)?.text).toContain("# Fix checkout");
        }),
      { startReactor: false },
    ),
  );

  it.effect("launches one proposed-plan Fast feature run on a dedicated branch", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        yield* seedProjectAndThread(system, {
          workflowPreset: "fast-feature",
          branch: "main",
        });
        yield* system.engine.dispatch({
          type: "thread.activity.append",
          commandId: commandId("fast-intent-locked"),
          threadId: productThreadId,
          activity: {
            id: eventId("fast-intent-locked"),
            tone: "info",
            kind: "product-intent-locked",
            summary: "Fast checkout",
            payload: {
              title: "Fast checkout",
              summaryMarkdown: "Locked Fast feature.",
              intentKind: "feature",
            },
            turnId: null,
            createdAt: now,
          },
          createdAt: now,
        });
        yield* system.reactor.drain;
        yield* upsertProposedPlan(system, { planId: "plan-fast" });
        yield* system.reactor.drain;
        yield* upsertProposedPlan(system, { planId: "plan-fast", suffix: "-again" });
        yield* system.reactor.drain;

        const snapshot = yield* system.query.getSnapshot();
        const root = snapshot.threads.find((thread) => thread.id === productThreadId);
        const runs = snapshot.implementationRuns.filter(
          (run) => run.artifactSource === "proposed-plan",
        );
        expect(root?.interactionMode).toBe("plan");
        expect(root?.workflowPreset).toBe("fast-feature");
        expect(runs).toHaveLength(1);
        expect(runs[0]).toMatchObject({
          specId: null,
          pinnedCommit: "abc123",
          baseBranch: "main",
          sourceProposedPlan: { threadId: productThreadId, planId: "plan-fast" },
        });
        expect(runs[0]?.orchestratorBranch.startsWith("fast-feature/")).toBe(true);
        const implementers = snapshot.threads.filter(
          (thread) => thread.workflowRole === "fast-feature-implementer",
        );
        expect(implementers).toHaveLength(1);
        expect(implementers[0]?.parentThreadId).toBe(productThreadId);
        expect(implementers[0]?.interactionMode).toBe("default");
        expect(implementers[0]?.workflowPreset).toBe("fast-feature");
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
          type: "thread.planning-tickets.apply",
          commandId: commandId("normal-tickets-apply"),
          threadId: planningThreadId,
          sourceMessageId: messageId("normal-tickets-source"),
          specId: normalSpec.id,
          tickets: [
            {
              key: "NORMAL-1",
              title: "Normal ticket",
              bodyMarkdown: "Keep this workflow standalone.",
              plannedFileChanges: [{ path: "src/normal.ts", action: "update" }],
              dependencyKeys: [],
            },
          ],
          createdAt: now,
        });
        yield* system.reactor.drain;
        snapshot = yield* system.query.getSnapshot();
        const activeReview = snapshot.threads.find((thread) => thread.id === planningThreadId)
          ?.planningWorkflow?.activeReview;
        if (activeReview == null) throw new Error("Normal review missing.");
        yield* system.engine.dispatch({
          type: "thread.planning-reviewer-verdict.apply",
          commandId: commandId("normal-passed-verdict"),
          threadId: planningThreadId,
          reviewerThreadId: activeReview.reviewerThreadId,
          reviewerMessageId: messageId("normal-reviewer-pass"),
          cycleNumber: activeReview.cycleNumber,
          mode: activeReview.mode,
          targetPlanningTicketIds: [...activeReview.targetPlanningTicketIds],
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
