import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  DEFAULT_WORKSPACE_USER_ID,
  EventId,
  MessageId,
  PLANNING_REVIEW_DEFAULT_CYCLES,
  type ServerSettings,
  ProviderInstanceId,
  ProjectId,
  ThreadId,
  TurnId,
  type WorkflowPreset,
} from "@t3tools/contracts";
import { type DeepPartial } from "@t3tools/shared/Struct";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { describe } from "vite-plus/test";

import { ServerConfig } from "../../config.ts";
import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { T3ProjectFileLoader } from "../../project/T3ProjectFileLoader.ts";
import { WORKFLOW_PROMPT_IDS } from "../../provider/WorkflowPromptRegistry.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import {
  ProductWorkflowReactorLive,
  resolvePlanQuestionAnswers,
} from "./ProductWorkflowReactor.ts";
import { layerTest as serverSettingsLayerTest } from "../../serverSettings.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
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

describe("resolvePlanQuestionAnswers", () => {
  it("uses a valid recommendation, then the first option, then the free-form fallback", () => {
    expect(
      resolvePlanQuestionAnswers({
        questions: [
          {
            id: "approach",
            options: [{ label: "Small" }, { label: "Complete" }],
            recommendation: { optionLabel: "Complete" },
          },
          {
            id: "tests",
            options: [{ label: "Focused" }, { label: "Broad" }],
          },
          { id: "unknown", options: [] },
        ],
      }),
    ).toEqual({
      approach: "Complete",
      tests: "Focused",
      unknown: "Use your best judgment and continue.",
    });
  });

  it("ignores malformed questions and invalid recommendations", () => {
    expect(
      resolvePlanQuestionAnswers({
        questions: [
          null,
          { options: [{ label: "Missing id" }] },
          {
            id: "approach",
            options: [{ label: "Safe" }],
            recommendation: { optionLabel: "Unavailable" },
          },
        ],
      }),
    ).toEqual({ approach: "Safe" });
  });
});

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

function completeTurnCheckpoint(
  system: ProductSystem,
  input: {
    readonly turnId: string;
    readonly checkpointTurnCount?: number;
    readonly createdAt?: string;
  },
) {
  const createdAt = input.createdAt ?? now;
  return system.engine.dispatch({
    type: "thread.activity.append",
    commandId: commandId(`checkpoint-${input.turnId}`),
    threadId: productThreadId,
    activity: {
      id: eventId(`checkpoint-${input.turnId}`),
      tone: "info",
      kind: "checkpoint.captured",
      summary: "Checkpoint captured",
      payload: { turnCount: input.checkpointTurnCount ?? 1, status: "ready" },
      turnId: TurnId.make(input.turnId),
      createdAt,
    },
    createdAt,
  });
}

function settleTurn(
  system: ProductSystem,
  input: { readonly turnId: string; readonly completedAt: string },
) {
  const turnId = TurnId.make(input.turnId);
  return Effect.gen(function* () {
    yield* system.engine.dispatch({
      type: "thread.session.set",
      commandId: commandId(`session-running-${input.turnId}`),
      threadId: productThreadId,
      session: {
        threadId: productThreadId,
        status: "running",
        providerName: "codex",
        runtimeMode: "full-access",
        activeTurnId: turnId,
        lastError: null,
        updatedAt: now,
      },
      createdAt: now,
    });
    yield* system.engine.dispatch({
      type: "thread.session.set",
      commandId: commandId(`session-ready-${input.turnId}`),
      threadId: productThreadId,
      session: {
        threadId: productThreadId,
        status: "ready",
        providerName: "codex",
        runtimeMode: "full-access",
        activeTurnId: null,
        lastError: null,
        updatedAt: input.completedAt,
      },
      createdAt: input.completedAt,
    });
  });
}

function makeTestLayer(
  validationCommands?: ReadonlyArray<string>,
  serverSettings: DeepPartial<ServerSettings> = {},
) {
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
    Layer.provideMerge(ThreadBackgroundLiveness.layer),
    Layer.provideMerge(ThreadPlanProgress.layer),
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
      Layer.provide(serverSettingsLayerTest(serverSettings)),
      Layer.provide(
        Layer.mock(T3ProjectFileLoader)({
          load: () =>
            Effect.succeed(
              validationCommands === undefined
                ? Option.none()
                : Option.some({ validationCommands: [...validationCommands] }),
            ),
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
    readonly validationCommands?: ReadonlyArray<string>;
    readonly serverSettings?: DeepPartial<ServerSettings>;
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
  ).pipe(Effect.provide(makeTestLayer(options?.validationCommands, options?.serverSettings)));
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
    readonly worktreePath?: string | null;
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
      worktreePath: input.worktreePath ?? null,
      createdAt: now,
    });
    return threadId;
  });
}

function prepareWorkflowWorkspace(
  system: ProductSystem,
  input: {
    readonly baseBranch: string;
    readonly branch: string;
    readonly worktreePath: string;
  },
) {
  return system.engine.dispatch({
    type: "thread.activity.append",
    commandId: commandId("workflow-workspace-prepared"),
    threadId: productThreadId,
    activity: {
      id: eventId("workflow-workspace-prepared"),
      tone: "info",
      kind: "workflow-workspace-prepared",
      summary: "Workflow workspace prepared",
      payload: input,
      turnId: null,
      createdAt: now,
    },
    createdAt: now,
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
  it.effect("recovers a Full Feature turn that stops before Product Grill lock-in", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        yield* seedProjectAndThread(system, { workflowPreset: "full-feature" });
        yield* completeTurnCheckpoint(system, { turnId: "turn-skipped-grill" });
        yield* system.reactor.drain;

        const snapshot = yield* system.query.getSnapshot();
        const thread = snapshot.threads.find((entry) => entry.id === productThreadId);
        const events = yield* Stream.runCollect(system.engine.readEvents(0)).pipe(
          Effect.map((chunk) => Array.from(chunk)),
        );
        const recoveryTurn = events.find(
          (event) =>
            event.type === "thread.turn-start-requested" &&
            event.payload.threadId === productThreadId &&
            event.payload.workflowPromptId === WORKFLOW_PROMPT_IDS.productFullFeatureCodex,
        );
        const recoveryMessage = events.find(
          (event) =>
            event.type === "thread.message-sent" &&
            event.payload.threadId === productThreadId &&
            event.payload.text.includes("previous turn ended before completing"),
        );
        expect(recoveryTurn?.type).toBe("thread.turn-start-requested");
        expect(recoveryMessage?.type).toBe("thread.message-sent");
        if (recoveryMessage?.type === "thread.message-sent") {
          expect(recoveryMessage.payload.text).toContain(
            "Do not implement, investigate, or verify",
          );
          expect(recoveryMessage.payload.text).toContain("product-intent-locked");
        }
        expect(
          thread?.activities.filter(
            (activity) => activity.kind === "product-grill-recovery-requested",
          ),
        ).toHaveLength(1);
      }),
    ),
  );

  it.effect("does not treat a completed Fast Feature planning turn as an incomplete grill", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        yield* seedProjectAndThread(system, { workflowPreset: "fast-feature" });
        yield* completeTurnCheckpoint(system, { turnId: "turn-fast-feature-plan" });
        yield* system.reactor.drain;

        const snapshot = yield* system.query.getSnapshot();
        const thread = snapshot.threads.find((entry) => entry.id === productThreadId);
        expect(
          thread?.activities.some(
            (activity) => activity.kind === "product-grill-recovery-requested",
          ),
        ).toBe(false);
      }),
    ),
  );

  it.effect("does not recover Product Grill while structured user input is pending", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        yield* seedProjectAndThread(system, { workflowPreset: "full-feature" });
        yield* system.engine.dispatch({
          type: "thread.activity.append",
          commandId: commandId("product-question-pending"),
          threadId: productThreadId,
          activity: {
            id: eventId("product-question-pending"),
            tone: "info",
            kind: "user-input.requested",
            summary: "Product decision requested",
            payload: { requestId: "request-product-question" },
            turnId: null,
            createdAt: now,
          },
          createdAt: now,
        });
        yield* completeTurnCheckpoint(system, { turnId: "turn-awaiting-input" });
        yield* system.reactor.drain;

        const snapshot = yield* system.query.getSnapshot();
        const thread = snapshot.threads.find((entry) => entry.id === productThreadId);
        expect(
          thread?.activities.some(
            (activity) => activity.kind === "product-grill-recovery-requested",
          ),
        ).toBe(false);
      }),
    ),
  );

  it.effect("carries settled Product Grill answers into a recovery without replaying them", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        yield* seedProjectAndThread(system, { workflowPreset: "full-feature" });
        const turnId = TurnId.make("turn-answered-grill");
        yield* system.engine.dispatch({
          type: "thread.activity.append",
          commandId: commandId("product-question-answered-request"),
          threadId: productThreadId,
          activity: {
            id: eventId("product-question-answered-request"),
            tone: "info",
            kind: "user-input.requested",
            summary: "Product decision requested",
            payload: { requestId: "request-product-question" },
            turnId,
            createdAt: now,
          },
          createdAt: now,
        });
        yield* system.engine.dispatch({
          type: "thread.activity.append",
          commandId: commandId("product-question-answered-response"),
          threadId: productThreadId,
          activity: {
            id: eventId("product-question-answered-response"),
            tone: "info",
            kind: "user-input.resolved",
            summary: "Product decision submitted",
            payload: {
              requestId: "request-product-question",
              answers: {
                target_environment: "App dev stack",
                landing_identity: "Exact Home overview",
              },
            },
            turnId,
            createdAt: now,
          },
          createdAt: now,
        });
        yield* completeTurnCheckpoint(system, { turnId });
        yield* system.reactor.drain;

        const events = yield* Stream.runCollect(system.engine.readEvents(0)).pipe(
          Effect.map((chunk) => Array.from(chunk)),
        );
        const recoveryMessage = events.find(
          (event) =>
            event.type === "thread.message-sent" &&
            event.payload.threadId === productThreadId &&
            event.payload.text.includes("previous turn ended before completing"),
        );
        expect(recoveryMessage?.type).toBe("thread.message-sent");
        if (recoveryMessage?.type === "thread.message-sent") {
          expect(recoveryMessage.payload.text).toContain('"target_environment": "App dev stack"');
          expect(recoveryMessage.payload.text).toContain(
            '"landing_identity": "Exact Home overview"',
          );
          expect(recoveryMessage.payload.text).toContain("Do not repeat these questions");
          expect(recoveryMessage.payload.text).toContain(
            "Continue only from the unresolved product-decision frontier",
          );
        }
      }),
    ),
  );

  it.effect("bounds repeated Product Grill recovery and surfaces a terminal activity", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        yield* seedProjectAndThread(system, { workflowPreset: "full-feature" });
        for (const [index, turnId] of [
          "turn-skipped-one",
          "turn-skipped-two",
          "turn-skipped-three",
        ].entries()) {
          yield* completeTurnCheckpoint(system, {
            turnId,
            checkpointTurnCount: index + 1,
          });
          yield* system.reactor.drain;
        }

        const snapshot = yield* system.query.getSnapshot();
        const thread = snapshot.threads.find((entry) => entry.id === productThreadId);
        const events = yield* Stream.runCollect(system.engine.readEvents(0)).pipe(
          Effect.map((chunk) => Array.from(chunk)),
        );
        expect(
          thread?.activities.filter(
            (activity) => activity.kind === "product-grill-recovery-requested",
          ),
        ).toHaveLength(2);
        expect(
          thread?.activities.filter(
            (activity) => activity.kind === "product-grill-recovery-blocked",
          ),
        ).toHaveLength(1);
        expect(
          events.filter(
            (event) =>
              event.type === "thread.turn-start-requested" &&
              event.payload.workflowPromptId === WORKFLOW_PROMPT_IDS.productFullFeatureCodex,
          ),
        ).toHaveLength(2);
      }),
    ),
  );

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
        const automaticEngineeringGrillTurnRequests = events.filter(
          (event) =>
            event.type === "thread.turn-start-requested" &&
            event.payload.threadId === productThreadId &&
            event.payload.workflowPromptId ===
              WORKFLOW_PROMPT_IDS.planningAutomaticEngineeringGrillCodex,
        );
        expect(automaticEngineeringGrillTurnRequests).toHaveLength(1);
        const engineeringGrillPrompt = events.find(
          (event) =>
            event.type === "thread.message-sent" && event.payload.threadId === productThreadId,
        );
        expect(engineeringGrillPrompt?.type).toBe("thread.message-sent");
        if (engineeringGrillPrompt?.type === "thread.message-sent") {
          expect(engineeringGrillPrompt.payload.text).toContain(
            "Run the Planning Workflow's automatic Engineering Grill",
          );
          expect(engineeringGrillPrompt.payload.text).toContain(
            "Do not reopen or repeat Product Grill questions",
          );
          expect(engineeringGrillPrompt.payload.text).toContain(
            "Do not ask the user questions or wait for confirmation",
          );
        }
      }),
    ),
  );

  it.effect("uses product context modeling instead of Engineering Grill for Product Planning", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        yield* seedProjectAndThread(system, {
          workflowPreset: "product-planning",
          runtimeMode: "approval-required",
        });
        yield* lockProductIntent(system);

        const events = yield* Stream.runCollect(system.engine.readEvents(0)).pipe(
          Effect.map((chunk) => Array.from(chunk)),
        );
        const contextTurn = events.find(
          (event) =>
            event.type === "thread.turn-start-requested" &&
            event.payload.threadId === productThreadId &&
            event.payload.workflowPromptId === WORKFLOW_PROMPT_IDS.planningProductContextCodex,
        );
        expect(contextTurn).toBeDefined();
        const contextPrompt = events.find(
          (event) =>
            event.type === "thread.message-sent" &&
            event.payload.threadId === productThreadId &&
            event.payload.text.includes("Build durable product and domain context"),
        );
        expect(contextPrompt).toBeDefined();
        expect(
          events.some(
            (event) =>
              event.type === "thread.turn-start-requested" &&
              event.payload.workflowPromptId ===
                WORKFLOW_PROMPT_IDS.planningAutomaticEngineeringGrillCodex,
          ),
        ).toBe(false);
      }),
    ),
  );

  it.effect("starts Implementation after standalone Engineering Planning passes review", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        yield* seedProjectAndThread(system, {
          interactionMode: "planning-workflow",
          workflowPreset: "planning",
          branch: "t3code/engineering-planning",
          worktreePath: "/tmp/product-reactor.worktrees/engineering-planning",
        });
        const spec = yield* seedProductSpecAndTickets(system, productThreadId);
        const beforeVerdict = yield* system.query.getSnapshot();
        const activeReview = beforeVerdict.threads.find((thread) => thread.id === productThreadId)
          ?.planningWorkflow?.activeReview;
        if (activeReview == null) throw new Error("Review was not active.");

        yield* system.engine.dispatch({
          type: "thread.planning-reviewer-verdict.apply",
          commandId: commandId("standalone-planning-pass"),
          threadId: productThreadId,
          reviewerThreadId: activeReview.reviewerThreadId,
          reviewerMessageId: messageId("standalone-planning-reviewer"),
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
      }),
    ),
  );

  it.effect("recovers an automatic Engineering Grill turn that omits its directive", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        yield* seedProjectAndThread(system, { workflowPreset: "full-feature" });
        yield* lockProductIntent(system);
        const completedAt = "2026-01-01T00:01:00.000Z";
        const turnId = TurnId.make("turn-engineering-grill");
        yield* system.engine.dispatch({
          type: "thread.session.set",
          commandId: commandId("session-running-turn-engineering-grill"),
          threadId: productThreadId,
          session: {
            threadId: productThreadId,
            status: "running",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: turnId,
            lastError: null,
            updatedAt: now,
          },
          createdAt: now,
        });
        yield* completeTurnCheckpoint(system, {
          turnId: "turn-engineering-grill",
          checkpointTurnCount: 2,
          createdAt: "2026-01-01T00:00:30.000Z",
        });
        yield* system.engine.dispatch({
          type: "thread.session.set",
          commandId: commandId("session-ready-turn-engineering-grill"),
          threadId: productThreadId,
          session: {
            threadId: productThreadId,
            status: "ready",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: completedAt,
          },
          createdAt: completedAt,
        });
        yield* system.reactor.drain;

        const snapshot = yield* system.query.getSnapshot();
        const thread = snapshot.threads.find((entry) => entry.id === productThreadId);
        const recoveryMessages = thread?.messages.filter(
          (message) =>
            message.role === "user" &&
            message.text.includes(
              "automatic Engineering Grill turn completed without its required workflow directive",
            ),
        );
        const events = yield* Stream.runCollect(system.engine.readEvents(0)).pipe(
          Effect.map((chunk) => Array.from(chunk)),
        );
        const recoveryTurns = events.filter(
          (event) =>
            event.type === "thread.turn-start-requested" &&
            event.payload.workflowPromptId ===
              WORKFLOW_PROMPT_IDS.planningAutomaticEngineeringGrillCodex,
        );
        expect(recoveryMessages).toHaveLength(1);
        expect(recoveryMessages?.[0]?.text).toContain('"type": "planning-grill-complete"');
        expect(recoveryTurns).toHaveLength(2);
        expect(
          thread?.activities.filter(
            (activity) => activity.kind === "engineering-grill-recovery-requested",
          ),
        ).toHaveLength(1);
        expect(thread?.planningWorkflow?.stage).toBe("grill");
      }),
    ),
  );

  it.effect("does not recover from the Product Grill checkpoint after Planning starts", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        const productTurnId = TurnId.make("turn-product-grill-before-planning");
        const productTurnStartedAt = "2025-12-31T23:59:00.000Z";
        const productTurnCompletedAt = "2026-01-01T00:00:30.000Z";
        yield* seedProjectAndThread(system, { workflowPreset: "full-feature" });
        yield* system.engine.dispatch({
          type: "thread.turn.start",
          commandId: commandId("product-grill-turn-before-planning"),
          threadId: productThreadId,
          message: {
            messageId: messageId("product-grill-turn-before-planning"),
            role: "user",
            text: "Plan checkout.",
            attachments: [],
          },
          runtimeMode: "full-access",
          interactionMode: "product-workflow",
          createdAt: productTurnStartedAt,
        });
        yield* system.engine.dispatch({
          type: "thread.session.set",
          commandId: commandId("product-grill-session-running-before-planning"),
          threadId: productThreadId,
          session: {
            threadId: productThreadId,
            status: "running",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: productTurnId,
            lastError: null,
            updatedAt: productTurnStartedAt,
          },
          createdAt: productTurnStartedAt,
        });
        yield* lockProductIntent(system);
        yield* system.engine.dispatch({
          type: "thread.session.set",
          commandId: commandId("product-grill-session-ready-after-planning"),
          threadId: productThreadId,
          session: {
            threadId: productThreadId,
            status: "ready",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: productTurnCompletedAt,
          },
          createdAt: productTurnCompletedAt,
        });
        yield* completeTurnCheckpoint(system, {
          turnId: productTurnId,
          createdAt: productTurnCompletedAt,
        });
        yield* system.reactor.drain;

        const snapshot = yield* system.query.getSnapshot();
        const thread = snapshot.threads.find((entry) => entry.id === productThreadId);
        expect(
          thread?.messages.some((message) =>
            message.text.includes("completed without its required workflow directive"),
          ),
        ).toBe(false);
        expect(thread?.planningWorkflow?.stage).toBe("grill");
      }),
    ),
  );

  it.effect("recovers a stranded automatic Engineering Grill when the reactor starts", () =>
    withSystem(
      (system) =>
        Effect.gen(function* () {
          yield* seedProjectAndThread(system, { workflowPreset: "full-feature" });
          yield* system.engine.dispatch({
            type: "thread.planning-workflow.launch",
            commandId: commandId("planning-launch-before-reactor"),
            threadId: productThreadId,
            intentTitle: "Checkout",
            intentSummaryMarkdown: "Locked checkout intent.",
            createdAt: now,
          });
          yield* settleTurn(system, {
            turnId: "turn-engineering-before-reactor",
            completedAt: "2026-01-01T00:01:00.000Z",
          });

          let snapshot = yield* system.query.getSnapshot();
          let thread = snapshot.threads.find((entry) => entry.id === productThreadId);
          expect(
            thread?.messages.some((message) =>
              message.text.includes("completed without its required workflow directive"),
            ),
          ).toBe(false);

          yield* system.reactor.start();
          yield* system.reactor.drain;

          snapshot = yield* system.query.getSnapshot();
          thread = snapshot.threads.find((entry) => entry.id === productThreadId);
          expect(
            thread?.messages.filter((message) =>
              message.text.includes("completed without its required workflow directive"),
            ),
          ).toHaveLength(1);
          expect(
            thread?.activities.filter(
              (activity) => activity.kind === "engineering-grill-recovery-requested",
            ),
          ).toHaveLength(1);
        }),
      { startReactor: false },
    ),
  );

  it.effect("re-drives an orphaned startup recovery turn after provider shutdown", () =>
    withSystem(
      (system) =>
        Effect.gen(function* () {
          yield* seedProjectAndThread(system, { workflowPreset: "full-feature" });
          yield* system.engine.dispatch({
            type: "thread.planning-workflow.launch",
            commandId: commandId("planning-launch-before-orphaned-recovery"),
            threadId: productThreadId,
            intentTitle: "Checkout",
            intentSummaryMarkdown: "Locked checkout intent.",
            createdAt: now,
          });
          const completedAt = "2026-01-01T00:01:00.000Z";
          yield* settleTurn(system, {
            turnId: "turn-engineering-before-orphaned-recovery",
            completedAt,
          });
          yield* system.engine.dispatch({
            type: "thread.session.set",
            commandId: commandId("session-stopped-before-orphaned-recovery"),
            threadId: productThreadId,
            session: {
              threadId: productThreadId,
              status: "stopped",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: null,
              updatedAt: completedAt,
            },
            createdAt: completedAt,
          });
          yield* system.engine.dispatch({
            type: "thread.turn.start",
            commandId: commandId("orphaned-engineering-recovery"),
            threadId: productThreadId,
            message: {
              messageId: messageId("orphaned-engineering-recovery"),
              role: "user",
              text: "The previous automatic Engineering Grill turn completed without its required workflow directive.\n\nFinish with the directive.",
              attachments: [],
            },
            runtimeMode: "full-access",
            interactionMode: "planning-workflow",
            workflowPromptId: WORKFLOW_PROMPT_IDS.planningAutomaticEngineeringGrillCodex,
            createdAt: completedAt,
          });

          yield* system.reactor.start();
          yield* system.reactor.drain;

          const snapshot = yield* system.query.getSnapshot();
          const thread = snapshot.threads.find((entry) => entry.id === productThreadId);
          expect(
            thread?.messages.filter((message) =>
              message.text.startsWith(
                "The previous automatic Engineering Grill turn completed without its required workflow directive.",
              ),
            ),
          ).toHaveLength(2);
          expect(
            thread?.activities.filter(
              (activity) => activity.kind === "engineering-grill-recovery-requested",
            ),
          ).toHaveLength(1);
        }),
      { startReactor: false },
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

        for (let index = 1; index <= PLANNING_REVIEW_DEFAULT_CYCLES; index += 1) {
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

  it.effect("stops ticket review at the step's cycle budget instead of the built-in five", () =>
    withSystem(
      (system) =>
        Effect.gen(function* () {
          yield* seedProjectAndThread(system);
          const planningThread = yield* lockProductIntent(system);
          yield* seedProductSpecAndTickets(system, planningThread.id);

          for (let index = 1; index <= 2; index += 1) {
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
              commandId: commandId(`budgeted-verdict-${index}`),
              threadId: planningThread.id,
              reviewerThreadId: activeReview.reviewerThreadId,
              reviewerMessageId: messageId(`budgeted-reviewer-${index}`),
              cycleNumber: activeReview.cycleNumber,
              mode: activeReview.mode,
              targetPlanningTicketIds: [...activeReview.targetPlanningTicketIds],
              verdictMarkdown: "failed: missing acceptance detail",
              passed: false,
              failingPlanningTicketIds: [ticketId],
              createdAt: `2026-01-01T00:00:0${String(index)}.000Z`,
            });
            yield* system.reactor.drain;
          }

          const snapshot = yield* system.query.getSnapshot();
          const workflow = snapshot.threads.find(
            (entry) => entry.id === planningThread.id,
          )?.planningWorkflow;
          expect(workflow?.stage).toBe("completed-with-warnings");
          expect(workflow?.reviewCycles).toHaveLength(2);
        }),
      {
        serverSettings: {
          workflowStepCycles: [
            {
              workflowPromptId: WORKFLOW_PROMPT_IDS.planningTicketReviewerCodex,
              maxCycles: 2,
            },
          ],
        },
      },
    ),
  );

  it.effect("keeps reviewing past the built-in five cycles when the budget asks for more", () =>
    withSystem(
      (system) =>
        Effect.gen(function* () {
          yield* seedProjectAndThread(system);
          const planningThread = yield* lockProductIntent(system);
          yield* seedProductSpecAndTickets(system, planningThread.id);

          // Five failed cycles used to be the end of ticket review, no matter
          // what: the decider refused a sixth.
          for (let index = 1; index <= 5; index += 1) {
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
              commandId: commandId(`raised-verdict-${index}`),
              threadId: planningThread.id,
              reviewerThreadId: activeReview.reviewerThreadId,
              reviewerMessageId: messageId(`raised-reviewer-${index}`),
              cycleNumber: activeReview.cycleNumber,
              mode: activeReview.mode,
              targetPlanningTicketIds: [...activeReview.targetPlanningTicketIds],
              verdictMarkdown: "failed: missing acceptance detail",
              passed: false,
              failingPlanningTicketIds: [ticketId],
              createdAt: `2026-01-01T00:00:0${String(index)}.000Z`,
            });
            yield* system.reactor.drain;
          }

          const snapshot = yield* system.query.getSnapshot();
          const workflow = snapshot.threads.find(
            (entry) => entry.id === planningThread.id,
          )?.planningWorkflow;
          expect(workflow?.stage).toBe("ticket-review");
          expect(workflow?.activeReview?.cycleNumber).toBe(6);
        }),
      {
        serverSettings: {
          workflowStepCycles: [
            {
              workflowPromptId: WORKFLOW_PROMPT_IDS.planningTicketReviewerCodex,
              maxCycles: 7,
            },
          ],
        },
      },
    ),
  );

  it.effect(
    "launches implementation on the Product workspace after its temporary branch is renamed",
    () =>
      withSystem(
        (system) =>
          Effect.gen(function* () {
            yield* seedProjectAndThread(system, {
              workflowPreset: "full-feature",
              branch: "t3code/full-feature",
              worktreePath: "/tmp/product-reactor.worktrees/full-feature",
            });
            yield* prepareWorkflowWorkspace(system, {
              baseBranch: "main",
              branch: "t3code/1234abcd",
              worktreePath: "/tmp/product-reactor.worktrees/full-feature",
            });
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
            const implementationRun = snapshot.implementationRuns.find(
              (run) => run.specId === spec.id,
            );
            expect(implementationRun?.launchSummary.validationCommands).toEqual([
              "pnpm check:full",
            ]);
            expect(implementationRun).toMatchObject({
              baseBranch: "main",
              orchestratorBranch: "t3code/full-feature",
              orchestratorWorktreePath: "/tmp/product-reactor.worktrees/full-feature",
            });
            const implementationOrchestrator = snapshot.threads.find(
              (thread) => thread.workflowRole === "implementation-orchestrator",
            );
            expect(implementationOrchestrator?.parentThreadId).toBe(productThreadId);
          }),
        { validationCommands: ["pnpm check:full"] },
      ),
  );

  it.effect(
    "launches implementation on the Product workspace when its temporary branch was never renamed",
    () =>
      withSystem((system) =>
        Effect.gen(function* () {
          // Branch naming runs a model, and that model can be out of credits or offline. When it
          // never renames the bootstrap ref, finished tickets must still reach implementation.
          yield* seedProjectAndThread(system, {
            workflowPreset: "full-feature",
            branch: "worktree/1234abcd",
            worktreePath: "/tmp/product-reactor.worktrees/full-feature",
          });
          yield* prepareWorkflowWorkspace(system, {
            baseBranch: "main",
            branch: "worktree/1234abcd",
            worktreePath: "/tmp/product-reactor.worktrees/full-feature",
          });
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
          expect(snapshot.implementationRuns.find((run) => run.specId === spec.id)).toMatchObject({
            baseBranch: "main",
            orchestratorBranch: "worktree/1234abcd",
            orchestratorWorktreePath: "/tmp/product-reactor.worktrees/full-feature",
          });
        }),
      ),
  );

  it.effect(
    "recovers a standalone Planning thread whose implementation handoff never happened",
    () =>
      withSystem(
        (system) =>
          Effect.gen(function* () {
            // The Planning preset hands off to implementation the same way a Product workflow
            // does, so the startup sweep has to see it too. It used to skip these threads, which
            // left a finished plan with no way back into implementation short of replanning it.
            yield* seedProjectAndThread(system, {
              interactionMode: "planning-workflow",
              workflowPreset: "planning",
              branch: "planning-branch",
              worktreePath: "/tmp/product-reactor.worktrees/planning",
            });
            yield* prepareWorkflowWorkspace(system, {
              baseBranch: "main",
              branch: "planning-branch",
              worktreePath: "/tmp/product-reactor.worktrees/planning",
            });
            const spec = yield* seedProductSpecAndTickets(system, productThreadId);
            yield* system.engine.dispatch({
              type: "thread.planning-workflow.stage.set",
              commandId: commandId("planning-stage-completed-before-handoff-recovery"),
              threadId: productThreadId,
              stage: "completed",
              createdAt: now,
            });

            yield* system.reactor.start();
            yield* system.reactor.drain;

            const snapshot = yield* system.query.getSnapshot();
            expect(snapshot.implementationRuns.find((run) => run.specId === spec.id)).toMatchObject(
              {
                baseBranch: "main",
                orchestratorBranch: "planning-branch",
                orchestratorWorktreePath: "/tmp/product-reactor.worktrees/planning",
              },
            );
          }),
        { startReactor: false },
      ),
  );

  it.effect("completes ticket review when the reviewer corrects the tickets and passes them", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        yield* seedProjectAndThread(system);
        const planningThread = yield* lockProductIntent(system);
        yield* seedProductSpecAndTickets(system, planningThread.id);

        let snapshot = yield* system.query.getSnapshot();
        let workflow = snapshot.threads.find(
          (thread) => thread.id === planningThread.id,
        )?.planningWorkflow;
        const activeReview = workflow?.activeReview;
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
          verdictMarkdown: "Corrected the checkout slice; the set is complete.",
          createdAt: "2026-01-01T00:00:01.000Z",
        });
        yield* system.reactor.drain;

        snapshot = yield* system.query.getSnapshot();
        workflow = snapshot.threads.find(
          (thread) => thread.id === planningThread.id,
        )?.planningWorkflow;
        // The reviewer's own correction is the review: re-reviewing it is what used to spend every
        // remaining cycle rewriting tickets that had already passed.
        expect(workflow?.reviewCycles[0]?.status).toBe("revised");
        expect(workflow?.tickets[0]?.bodyMarkdown).toBe(
          "Add a vertical checkout slice with explicit acceptance criteria.",
        );
        expect(workflow?.tickets[0]?.plannedFileChanges).toEqual([
          { path: "src/checkout.ts", action: "update" },
        ]);
        expect(workflow?.stage).toBe("completed");
        expect(workflow?.activeReview).toBeNull();
        expect(workflow?.reviewCycles).toHaveLength(1);
        expect(snapshot.implementationRuns).toHaveLength(1);
      }),
    ),
  );

  it.effect("re-reviews only the tickets a cycle failed, with that cycle's findings", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        yield* seedProjectAndThread(system);
        const planningThread = yield* lockProductIntent(system);
        yield* seedProductSpecAndTickets(system, planningThread.id, 2);

        let snapshot = yield* system.query.getSnapshot();
        let workflow = snapshot.threads.find(
          (thread) => thread.id === planningThread.id,
        )?.planningWorkflow;
        let activeReview = workflow?.activeReview;
        const ticketIds = workflow?.tickets.map((ticket) => ticket.id) ?? [];
        if (activeReview == null || ticketIds.length !== 2) throw new Error("Cycle 1 missing.");

        yield* system.engine.dispatch({
          type: "thread.planning-reviewer-verdict.apply",
          commandId: commandId("review-edit-and-fail-cycle-1"),
          threadId: planningThread.id,
          reviewerThreadId: activeReview.reviewerThreadId,
          reviewerMessageId: messageId("review-edit-and-fail-cycle-1"),
          cycleNumber: 1,
          mode: "full",
          targetPlanningTicketIds: [...activeReview.targetPlanningTicketIds],
          ticketEdits: [
            {
              type: "update",
              ticketId: ticketIds[0]!,
              bodyMarkdown: "Corrected by the reviewer and approved.",
            },
          ],
          passed: false,
          failingPlanningTicketIds: [ticketIds[1]!],
          perTicketFeedback: [
            { ticketId: ticketIds[0]!, passed: true, feedbackMarkdown: "Corrected in place." },
            {
              ticketId: ticketIds[1]!,
              passed: false,
              feedbackMarkdown: "Splitting this slice needs another cycle.",
            },
          ],
          verdictMarkdown: "One ticket corrected, one failed.",
          createdAt: "2026-01-01T00:00:01.000Z",
        });
        yield* system.reactor.drain;

        snapshot = yield* system.query.getSnapshot();
        workflow = snapshot.threads.find(
          (thread) => thread.id === planningThread.id,
        )?.planningWorkflow;
        activeReview = workflow?.activeReview;
        expect(activeReview?.cycleNumber).toBe(2);
        expect(activeReview?.mode).toBe("targeted");
        // The edited-and-approved ticket is done; only the failed one comes back.
        expect(activeReview?.targetPlanningTicketIds).toEqual([ticketIds[1]]);

        const reviewerThread = snapshot.threads.find(
          (thread) => thread.id === activeReview?.reviewerThreadId,
        );
        const reviewerPrompt = reviewerThread?.messages[0]?.text ?? "";
        expect(reviewerPrompt).toContain("Splitting this slice needs another cycle.");
        expect(reviewerPrompt).toContain('"type": "update-dependencies"');
        expect(reviewerPrompt).not.toContain("Corrected in place.");
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

  it.effect("launches Fast Build on the renamed shared workflow branch", () =>
    withSystem(
      (system) =>
        Effect.gen(function* () {
          yield* seedProjectAndThread(system, {
            workflowPreset: "fast-feature",
            branch: "t3code/fast-feature",
            worktreePath: "/tmp/product-reactor.worktrees/fast-feature",
          });
          yield* prepareWorkflowWorkspace(system, {
            baseBranch: "main",
            branch: "t3code/1234abcd",
            worktreePath: "/tmp/product-reactor.worktrees/fast-feature",
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
          expect(runs[0]?.launchSummary.validationCommands).toEqual(["pnpm check:full"]);
          expect(runs[0]).toMatchObject({
            specId: null,
            pinnedCommit: "abc123",
            baseBranch: "main",
            sourceProposedPlan: { threadId: productThreadId, planId: "plan-fast" },
          });
          expect(runs[0]?.orchestratorBranch).toBe("t3code/fast-feature");
          expect(runs[0]?.orchestratorWorktreePath).toBe(
            "/tmp/product-reactor.worktrees/fast-feature",
          );
          const implementers = snapshot.threads.filter(
            (thread) => thread.workflowRole === "fast-feature-implementer",
          );
          expect(implementers).toHaveLength(1);
          expect(implementers[0]?.parentThreadId).toBe(productThreadId);
          expect(implementers[0]?.interactionMode).toBe("default");
          expect(implementers[0]?.workflowPreset).toBe("fast-feature");
        }),
      { validationCommands: ["pnpm check:full"] },
    ),
  );

  it.effect("holds Fast Build until the workflow branch rename is authoritative", () =>
    withSystem(
      (system) =>
        Effect.gen(function* () {
          yield* seedProjectAndThread(system, {
            workflowPreset: "fast-feature",
            branch: "t3code/1234abcd",
            worktreePath: "/tmp/product-reactor.worktrees/fast-feature",
          });
          yield* prepareWorkflowWorkspace(system, {
            baseBranch: "main",
            branch: "t3code/1234abcd",
            worktreePath: "/tmp/product-reactor.worktrees/fast-feature",
          });
          yield* upsertProposedPlan(system, { planId: "plan-fast-rename" });
          yield* system.reactor.drain;
          expect((yield* system.query.getSnapshot()).implementationRuns).toHaveLength(0);

          yield* system.engine.dispatch({
            type: "thread.meta.update",
            commandId: commandId("fast-workspace-renamed"),
            threadId: productThreadId,
            branch: "t3code/fast-feature",
          });
          yield* system.reactor.drain;

          const runs = (yield* system.query.getSnapshot()).implementationRuns;
          expect(runs).toHaveLength(1);
          expect(runs[0]?.orchestratorBranch).toBe("t3code/fast-feature");
          expect(runs[0]?.orchestratorWorktreePath).toBe(
            "/tmp/product-reactor.worktrees/fast-feature",
          );
        }),
      { validationCommands: ["pnpm check:full"] },
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

  it.effect("pins the Engineering Workflow preset when a planning stage starts", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        // Threads opened straight into the planning composer mode reach the
        // stage machine without a preset; nothing upstream pins one.
        yield* seedProjectAndThread(system, {
          interactionMode: "planning-workflow",
          workflowPreset: null,
        });
        yield* system.engine.dispatch({
          type: "thread.planning-stage.start",
          commandId: commandId("planning-stage-start-presetless"),
          threadId: productThreadId,
          stage: "grill",
          createdAt: now,
        });
        yield* system.reactor.drain;

        const snapshot = yield* system.query.getSnapshot();
        const thread = snapshot.threads.find((entry) => entry.id === productThreadId);
        expect(thread?.workflowPreset).toBe("planning");
        expect(thread?.interactionMode).toBe("planning-workflow");
      }),
    ),
  );

  it.effect("leaves an existing preset alone when a planning stage starts", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        yield* seedProjectAndThread(system, {
          interactionMode: "planning-workflow",
          workflowPreset: "wayfinder",
        });
        yield* system.engine.dispatch({
          type: "thread.planning-stage.start",
          commandId: commandId("planning-stage-start-wayfinder"),
          threadId: productThreadId,
          stage: "grill",
          createdAt: now,
        });
        yield* system.reactor.drain;

        const snapshot = yield* system.query.getSnapshot();
        expect(snapshot.threads.find((entry) => entry.id === productThreadId)?.workflowPreset).toBe(
          "wayfinder",
        );
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
        expect(
          snapshot.threads
            .find((thread) => thread.id === planningThreadId)
            ?.activities.filter(
              (activity) => activity.kind === "planning-workflow.implementation-not-started",
            ),
        ).toHaveLength(1);
      }),
    ),
  );
});
