import { assert, describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_WORKSPACE_USER_ID,
  AppReviewId,
  AppReviewRecord,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WorkflowId,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer } from "effect/ai";

import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { getWorkflowArtifactsForThread } from "../../../orchestration/workflowArtifacts.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as WorkflowArtifactsHandlers from "./handlers.ts";
import { WorkflowArtifactsToolkit } from "./tools.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";

const projectId = ProjectId.make("project-workflow-artifacts");
const otherProjectId = ProjectId.make("project-other");
const rootThreadId = ThreadId.make("thread-workflow-root");
const childThreadId = ThreadId.make("thread-workflow-child");
const implementationThreadId = ThreadId.make("thread-implementation-orchestrator");
const appReviewControllerThreadId = ThreadId.make("thread-app-review-orchestrator");
const nestedReviewerThreadId = ThreadId.make("thread-app-review-reviewer");
const detachedThreadId = ThreadId.make("thread-detached-workflow");
const recoveredWorkerThreadId = ThreadId.make("thread-recovered-worker");
const workflowId = WorkflowId.make("workflow-artifacts-1");
const implementationWorkflowId = WorkflowId.make("implementation-run-1");
const appReviewWorkflowId = WorkflowId.make("app-review-workflow-1");
const ticketId = "planning-ticket-1";

const readModel = {
  snapshotSequence: 1,
  projects: [],
  implementationRuns: [
    {
      id: "implementation-run-1",
      specId: "spec-1",
      orchestratorThreadId: implementationThreadId,
    },
  ],
  appReviewWorkflowRuns: [
    {
      id: appReviewWorkflowId,
      targetThreadId: implementationThreadId,
      controllerThreadId: appReviewControllerThreadId,
      cycles: [
        {
          reviewerThreadId: nestedReviewerThreadId,
          fixerThreadId: null,
          reviewId: AppReviewId.make("app-review-nested"),
        },
      ],
    },
  ],
  threads: [
    {
      id: rootThreadId,
      projectId,
      ownerUserId: DEFAULT_WORKSPACE_USER_ID,
      workflowContext: { workflowId, rootThreadId, ticketScope: [ticketId] },
      planningWorkflow: {
        stage: "completed",
        createTicketsAvailable: false,
        activeReview: null,
        wayfinderMap: {
          id: "wayfinder-map-1",
          workflowId: "workflow-artifacts-1",
          title: "Canonical Wayfinder Map",
          summaryMarkdown: "Map body",
          tenantId: null,
          teamId: null,
          createdBy: null,
          sourceThreadId: rootThreadId,
          sourceMessageIds: [],
          ticketCount: 0,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        spec: {
          id: "spec-1",
          workflowId: "workflow-artifacts-1",
          title: "Canonical Spec",
          summaryMarkdown: "Canonical body",
          tenantId: null,
          teamId: null,
          createdBy: null,
          sourceThreadId: rootThreadId,
          sourceMessageIds: [],
          ticketCount: 1,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        tickets: [
          {
            id: ticketId,
            key: "TICKET-1",
            specId: "spec-1",
            ordinal: 1,
            title: "Canonical ticket",
            bodyMarkdown: "Ticket body",
            plannedFileChanges: [],
            dependencies: [],
            status: "open",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        reviewCycles: [],
      },
      appReviews: [],
    },
    {
      id: childThreadId,
      projectId,
      ownerUserId: DEFAULT_WORKSPACE_USER_ID,
      workflowContext: { workflowId, rootThreadId, ticketScope: [ticketId] },
      planningWorkflow: null,
      appReviews: [
        {
          id: AppReviewId.make("app-review-1"),
          sourceThreadId: rootThreadId,
          reviewThreadId: childThreadId,
          sourceTurnId: null,
          planningTicketIds: [ticketId],
          status: "passed",
          document: {
            verdict: "passed",
            summary: "Reviewed",
            checks: [],
            findings: [],
            questions: [],
            nextSteps: [],
          },
          evidence: {
            recording: {
              status: "not-started",
              path: null,
              mimeType: null,
              sizeBytes: null,
              startedAt: null,
              completedAt: null,
              durationMs: null,
              error: null,
            },
            screenshots: [],
          },
          createdAt: "2026-01-01T00:00:01.000Z",
          updatedAt: "2026-01-01T00:00:01.000Z",
        },
      ],
    },
    {
      id: implementationThreadId,
      projectId,
      ownerUserId: DEFAULT_WORKSPACE_USER_ID,
      workflowContext: {
        workflowId: implementationWorkflowId,
        parentWorkflowId: workflowId,
        rootThreadId,
        ticketScope: [ticketId],
      },
      planningWorkflow: null,
      appReviews: [],
    },
    {
      id: appReviewControllerThreadId,
      projectId,
      ownerUserId: DEFAULT_WORKSPACE_USER_ID,
      workflowContext: {
        workflowId: appReviewWorkflowId,
        parentWorkflowId: implementationWorkflowId,
        rootThreadId,
        ticketScope: [ticketId],
      },
      planningWorkflow: null,
      appReviews: [
        {
          id: AppReviewId.make("app-review-nested"),
          sourceThreadId: implementationThreadId,
          reviewThreadId: nestedReviewerThreadId,
          sourceTurnId: null,
          planningTicketIds: [ticketId],
          status: "running",
          document: {
            verdict: "failed",
            summary: "Reviewing",
            checks: [],
            findings: [
              {
                id: "save-draft",
                severity: "major",
                title: "Draft disappears after reload",
                details: "Cycle 2 lost the saved draft after a successful save.",
                reproduction: "Save a draft, reload, and check the campaign list.",
                evidenceIds: ["cycle-2-screenshot"],
              },
            ],
            questions: [],
            nextSteps: [],
          },
          evidence: {
            recording: {
              status: "not-started",
              path: null,
              mimeType: null,
              sizeBytes: null,
              startedAt: null,
              completedAt: null,
              durationMs: null,
              error: null,
            },
            screenshots: [],
          },
          createdAt: "2026-01-01T00:00:02.000Z",
          updatedAt: "2026-01-01T00:00:02.000Z",
        },
      ],
    },
    {
      id: nestedReviewerThreadId,
      projectId,
      ownerUserId: DEFAULT_WORKSPACE_USER_ID,
      workflowContext: {
        workflowId: appReviewWorkflowId,
        parentWorkflowId: implementationWorkflowId,
        rootThreadId,
        ticketScope: [ticketId],
      },
      planningWorkflow: null,
      appReviews: [],
    },
    {
      id: detachedThreadId,
      projectId,
      ownerUserId: DEFAULT_WORKSPACE_USER_ID,
      workflowContext: {
        workflowId: WorkflowId.make("detached-workflow"),
        parentWorkflowId: null,
        rootThreadId,
        ticketScope: [ticketId],
      },
      planningWorkflow: null,
      appReviews: [],
    },
    {
      id: recoveredWorkerThreadId,
      projectId,
      ownerUserId: DEFAULT_WORKSPACE_USER_ID,
      parentThreadId: implementationThreadId,
      workflowContext: {
        workflowId: WorkflowId.make("recovered-worker-workflow"),
        parentWorkflowId: null,
        rootThreadId,
        ticketScope: [ticketId],
      },
      planningWorkflow: null,
      appReviews: [],
    },
  ],
} as unknown as OrchestrationReadModel;

const queryLayer = Layer.mock(ProjectionSnapshotQuery)({
  getCommandReadModel: () => Effect.succeed(readModel),
});

const invocationLayer = Layer.succeed(McpInvocationContext.McpInvocationContext, {
  environmentId: EnvironmentId.make("environment-1"),

  capabilities: new Set(["workflow-artifacts"] as const),
  issuedAt: 1,
  thread: {
    threadId: childThreadId,
    providerSessionId: "provider-session-1",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  requestNamespace: "workflow-test",
});

const nestedReviewerInvocationLayer = Layer.succeed(McpInvocationContext.McpInvocationContext, {
  environmentId: EnvironmentId.make("environment-1"),

  capabilities: new Set(["workflow-artifacts"] as const),
  issuedAt: 1,
  thread: {
    threadId: nestedReviewerThreadId,
    providerSessionId: "provider-session-nested-reviewer",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  requestNamespace: "workflow-test",
});

const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "workflow-artifacts-test", version: "1.0.0" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "workflow-artifacts-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});
const mcpLayer = (threadId = nestedReviewerThreadId) =>
  McpHttpServer.toolkitRegistration(WorkflowArtifactsToolkit, WorkflowArtifactsHandlers.layer).pipe(
    Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
    Layer.provideMerge(queryLayer),
    Layer.provideMerge(
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("environment-1"),

        capabilities: new Set(["workflow-artifacts"] as const),
        issuedAt: 1,
        thread: {
          threadId,
          providerSessionId: "provider-session-mcp",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        requestNamespace: "workflow-test",
      }),
    ),
    Layer.provideMerge(Layer.succeed(McpSchema.McpServerClient, mcpClient)),
    Layer.provideMerge(Layer.mock(ThreadManagement.ThreadManagementService)({})),
    Layer.provideMerge(Layer.mock(OrchestrationEngineService)({})),
    Layer.provideMerge(
      Layer.succeed(
        SecureRandom.SecureRandom,
        SecureRandom.make((size) => new Uint8Array(size).fill(7)),
      ),
    ),
  );
const decodeReviews = Schema.decodeUnknownSync(
  Schema.Struct({ appReviews: Schema.Array(AppReviewRecord) }),
);
const decodeReviewsText = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ appReviews: Schema.Array(AppReviewRecord) })),
);
const decodeMcpObject = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown));

it.effect(
  "returns review history as an MCP object without losing findings or evidence references",
  () =>
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const result = yield* server.callTool({ name: "workflow_app_reviews_list", arguments: {} });
      expect(result.isError).toBe(false);
      const history = decodeReviews(result.structuredContent);
      expect(
        server.tools.find(({ tool }) => tool.name === "workflow_app_reviews_list")?.tool
          .outputSchema,
      ).toMatchObject({ type: "object" });
      expect(history.appReviews.map((review) => review.id)).toContain("app-review-1");
      const review = history.appReviews.find((entry) => entry.id === "app-review-nested");
      expect(review?.document.verdict).toBe("failed");
      expect(review?.document.findings).toEqual(
        readModel.threads.find((thread) => thread.id === appReviewControllerThreadId)?.appReviews[0]
          ?.document.findings,
      );
      expect(review?.document.findings[0]?.evidenceIds).toEqual(["cycle-2-screenshot"]);
      const retrieved = yield* server.callTool({
        name: "workflow_app_review_get",
        arguments: { reviewId: "app-review-nested" },
      });
      expect(retrieved.isError).toBe(false);
      expect(retrieved.structuredContent).toEqual(review);
      const text = result.content.find((entry) => entry.type === "text");
      expect(text?.type).toBe("text");
      if (text?.type === "text") expect(decodeReviewsText(text.text)).toEqual(history);
    }).pipe(Effect.provide(mcpLayer())),
);

it.effect("returns populated planning artifacts through the registered MCP tools", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    for (const [name, field, expected] of [
      ["workflow_tickets_list", "tickets", [{ id: ticketId }]],
      ["workflow_spec_get", "spec", { id: "spec-1", summaryMarkdown: "Canonical body" }],
      [
        "workflow_wayfinder_map_get",
        "wayfinderMap",
        { id: "wayfinder-map-1", summaryMarkdown: "Map body" },
      ],
    ] as const) {
      const result = yield* server.callTool({ name, arguments: {} });
      expect(result.isError).toBe(false);
      expect(decodeMcpObject(result.structuredContent)[field]).toMatchObject(expected);
    }
  }).pipe(Effect.provide(mcpLayer())),
);

it.effect("returns a readable MCP error for unauthorized review access", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const result = yield* server.callTool({
      name: "workflow_app_review_get",
      arguments: { reviewId: "app-review-nested" },
    });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      { type: "text", text: "App Review 'app-review-nested' is not in this workflow." },
    ]);
    if (result.structuredContent !== undefined) decodeMcpObject(result.structuredContent);
  }).pipe(Effect.provide(mcpLayer(detachedThreadId))),
);

it.effect("returns empty histories and absent planning artifacts as MCP objects", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    for (const [name, expected] of [
      ["workflow_app_reviews_list", { appReviews: [] }],
      ["workflow_tickets_list", { tickets: [] }],
      ["workflow_spec_get", { spec: null }],
      ["workflow_wayfinder_map_get", { wayfinderMap: null }],
    ] as const) {
      const result = yield* server.callTool({ name, arguments: {} });
      expect(result.isError).toBe(false);
      expect(result.structuredContent).toEqual(expected);
      expect(server.tools.find(({ tool }) => tool.name === name)?.tool.outputSchema).toMatchObject({
        type: "object",
      });
    }
  }).pipe(Effect.provide(mcpLayer(detachedThreadId))),
);

describe("workflow-artifacts toolkit handlers", () => {
  it.effect("resolves canonical artifacts and many-to-many App Review links from a child", () =>
    Effect.gen(function* () {
      const context = yield* WorkflowArtifactsHandlers.handlers.workflow_context_get();
      const { wayfinderMap } =
        yield* WorkflowArtifactsHandlers.handlers.workflow_wayfinder_map_get();
      const { spec } = yield* WorkflowArtifactsHandlers.handlers.workflow_spec_get();
      const { tickets } = yield* WorkflowArtifactsHandlers.handlers.workflow_tickets_list();
      const review = yield* WorkflowArtifactsHandlers.handlers.workflow_app_review_get({
        reviewId: AppReviewId.make("app-review-1"),
      });

      assert.strictEqual(context.workflowId, workflowId);
      assert.strictEqual(wayfinderMap?.title, "Canonical Wayfinder Map");
      assert.strictEqual(spec?.title, "Canonical Spec");
      assert.deepStrictEqual(
        tickets.map((ticket) => ticket.id),
        [ticketId],
      );
      assert.deepStrictEqual(review.planningTicketIds, [ticketId]);
    }).pipe(Effect.provide(Layer.mergeAll(queryLayer, invocationLayer))),
  );

  it.effect("rejects cross-workflow artifact IDs and cross-project RPC context", () =>
    Effect.gen(function* () {
      const ticketError = yield* WorkflowArtifactsHandlers.handlers
        .workflow_ticket_get({ ticketId: "planning-ticket-other" })
        .pipe(Effect.flip);
      assert.strictEqual(ticketError._tag, "WorkflowArtifactAccessError");

      const projectError = yield* getWorkflowArtifactsForThread({
        threadId: childThreadId,
        projectId: otherProjectId,
      }).pipe(Effect.flip);
      assert.strictEqual(projectError._tag, "WorkflowArtifactAccessError");
      assert.match(projectError.message, /different project/);
    }).pipe(Effect.provide(Layer.mergeAll(queryLayer, invocationLayer))),
  );

  it.effect("resolves planning artifacts through nested workflow ancestry", () =>
    Effect.gen(function* () {
      const context = yield* WorkflowArtifactsHandlers.handlers.workflow_context_get();
      const { spec } = yield* WorkflowArtifactsHandlers.handlers.workflow_spec_get();
      const { tickets } = yield* WorkflowArtifactsHandlers.handlers.workflow_tickets_list();
      const ticket = yield* WorkflowArtifactsHandlers.handlers.workflow_ticket_get({ ticketId });

      assert.strictEqual(context.workflowId, implementationWorkflowId);
      assert.strictEqual(context.parentWorkflowId, workflowId);
      assert.strictEqual(spec?.id, "spec-1");
      assert.deepStrictEqual(
        tickets.map((ticket) => ticket.id),
        [ticketId],
      );
      assert.strictEqual(ticket.id, ticketId);
    }).pipe(Effect.provide(Layer.mergeAll(queryLayer, nestedReviewerInvocationLayer))),
  );

  it.effect("recovers planning artifacts through the owning Implementation Run", () =>
    Effect.gen(function* () {
      const snapshot = yield* getWorkflowArtifactsForThread({ threadId: recoveredWorkerThreadId });

      assert.strictEqual(snapshot.spec?.id, "spec-1");
      assert.deepStrictEqual(
        snapshot.tickets.map((ticket) => ticket.id),
        [ticketId],
      );
    }).pipe(Effect.provide(queryLayer)),
  );

  it.effect("shows the workflow's App Reviews from any level of it", () =>
    Effect.gen(function* () {
      // The root sits above the nested workflow that launched the review, and
      // the reviewer sits inside it. Both are the same workflow to the user.
      for (const threadId of [rootThreadId, childThreadId, nestedReviewerThreadId]) {
        const snapshot = yield* getWorkflowArtifactsForThread({ threadId });
        assert.deepStrictEqual(
          snapshot.appReviewWorkflowRuns.map((run) => String(run.id)),
          [String(appReviewWorkflowId)],
        );
        assert.include(
          snapshot.appReviews.map((review) => String(review.id)),
          "app-review-nested",
        );
      }
    }).pipe(Effect.provide(queryLayer)),
  );

  it.effect("shows a contextless planning root every workflow started under it", () => {
    // A planning root has no workflow context of its own, and the
    // Implementation Run it starts records no parent workflow.
    const contextlessRootModel = {
      ...readModel,
      threads: readModel.threads.map((thread) =>
        thread.id === rootThreadId
          ? { ...thread, workflowContext: null }
          : thread.id === implementationThreadId && thread.workflowContext
            ? { ...thread, workflowContext: { ...thread.workflowContext, parentWorkflowId: null } }
            : thread,
      ),
    } as OrchestrationReadModel;
    return Effect.gen(function* () {
      const snapshot = yield* getWorkflowArtifactsForThread({ threadId: rootThreadId });

      assert.strictEqual(snapshot.context.rootThreadId, rootThreadId);
      assert.strictEqual(snapshot.spec?.id, "spec-1");
      assert.deepStrictEqual(
        snapshot.appReviewWorkflowRuns.map((run) => String(run.id)),
        [String(appReviewWorkflowId)],
      );
      assert.include(
        snapshot.appReviews.map((review) => String(review.id)),
        "app-review-nested",
      );
    }).pipe(
      Effect.provide(
        Layer.mock(ProjectionSnapshotQuery)({
          getCommandReadModel: () => Effect.succeed(contextlessRootModel),
        }),
      ),
    );
  });

  it.effect("does not authorize artifacts by shared root thread alone", () =>
    Effect.gen(function* () {
      const snapshot = yield* getWorkflowArtifactsForThread({ threadId: detachedThreadId });

      assert.strictEqual(snapshot.spec, null);
      assert.deepStrictEqual(snapshot.tickets, []);
      assert.deepStrictEqual(snapshot.appReviewWorkflowRuns, []);
    }).pipe(Effect.provide(queryLayer)),
  );

  it.effect("loads built-in workflow docs and rejects unknown IDs", () =>
    Effect.gen(function* () {
      const doc = yield* WorkflowArtifactsHandlers.handlers.workflow_doc_get({
        docId: "glossary-format",
      });
      assert.strictEqual(doc.path, "GLOSSARY-FORMAT.md");
      assert.match(doc.content, /# GLOSSARY\.md Format/);

      const error = yield* WorkflowArtifactsHandlers.handlers
        .workflow_doc_get({ docId: "missing" })
        .pipe(Effect.flip);
      assert.strictEqual(error._tag, "WorkflowArtifactAccessError");
      assert.match(error.message, /was not found/);
    }).pipe(Effect.provide(invocationLayer)),
  );

  describe("workflow status and stage restart", () => {
    const halt = {
      ticketId,
      stage: "code-review",
      category: "retry-exhausted",
      detail: "Ticket exhausted its Code Review launch budget.",
      haltedAt: "2026-01-02T00:00:00.000Z",
    } as const;
    const haltedModel = {
      ...readModel,
      implementationRuns: [
        {
          ...readModel.implementationRuns[0],
          status: "needs-human-attention",
          automationHalt: halt,
          retryableFailure: null,
          skips: [],
          updatedAt: "2026-01-02T00:00:00.000Z",
          ticketStates: [
            {
              ticketId,
              status: "code-reviewing",
              dependencyTicketIds: [],
              workerThreadId: childThreadId,
              updatedAt: "2026-01-01T12:00:00.000Z",
            },
          ],
        },
      ],
    } as unknown as OrchestrationReadModel;
    const callerLayer = (threadId: ThreadId) =>
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("environment-1"),
        capabilities: new Set(["workflow-artifacts"] as const),
        issuedAt: 1,
        thread: {
          threadId,
          providerSessionId: "provider-session-restart",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        requestNamespace: "workflow-test",
      });
    const restartLayer = (threadId: ThreadId, dispatched: Array<unknown>) =>
      Layer.mergeAll(
        Layer.mock(ProjectionSnapshotQuery)({
          getCommandReadModel: () => Effect.succeed(haltedModel),
        }),
        callerLayer(threadId),
        Layer.mock(OrchestrationEngineService)({
          dispatch: (command) =>
            Effect.sync(() => {
              dispatched.push(command);
              return { sequence: 1, outcome: { type: "accepted" as const } };
            }),
        }),
        Layer.succeed(
          SecureRandom.SecureRandom,
          SecureRandom.make((size) => new Uint8Array(size).fill(7)),
        ),
      );

    it.effect("shows the halt and the ticket it froze", () =>
      Effect.gen(function* () {
        const { runs } = yield* WorkflowArtifactsHandlers.handlers.workflow_status_get();
        assert.deepStrictEqual(runs[0]?.automationHalt, halt);
        assert.deepInclude(runs[0]?.tickets[0], {
          ticketId,
          key: "TICKET-1",
          status: "code-reviewing",
          codeReviewThreadId: null,
        });
      }).pipe(Effect.provide(restartLayer(rootThreadId, []))),
    );

    it.effect("restarts a stage from the root thread with the panel's command", () => {
      const dispatched: Array<unknown> = [];
      const target = { kind: "ticket", ticketId, stage: "code-review" } as const;
      return Effect.gen(function* () {
        const result = yield* WorkflowArtifactsHandlers.handlers.workflow_stage_restart({
          runId: "implementation-run-1",
          target,
          mode: "rerun",
        });
        assert.deepStrictEqual(result.outcome, { type: "accepted" });
        yield* WorkflowArtifactsHandlers.handlers.workflow_stage_restart({
          runId: "implementation-run-1",
          target,
          mode: "reset",
        });
        assert.deepStrictEqual(
          dispatched.map((command) => {
            const { type, threadId, runId, target } = command as Record<string, unknown>;
            return { type, threadId, runId, target };
          }),
          [
            {
              type: "thread.implementation-run.rerun",
              threadId: rootThreadId,
              runId: "implementation-run-1",
              target,
            },
            {
              type: "thread.implementation-run.reset",
              threadId: rootThreadId,
              runId: "implementation-run-1",
              target,
            },
          ],
        );
      }).pipe(Effect.provide(restartLayer(rootThreadId, dispatched)));
    });

    it.effect("refuses stage threads and runs outside the workflow", () => {
      const dispatched: Array<unknown> = [];
      const input = {
        runId: "implementation-run-1",
        target: { kind: "ticket", ticketId, stage: "code-review" },
        mode: "rerun",
      } as const;
      return Effect.gen(function* () {
        const fromChild = yield* WorkflowArtifactsHandlers.handlers
          .workflow_stage_restart(input)
          .pipe(Effect.provide(restartLayer(childThreadId, dispatched)), Effect.flip);
        assert.match(fromChild.message, /Only the workflow's root thread/);
        const otherRun = yield* WorkflowArtifactsHandlers.handlers
          .workflow_stage_restart({ ...input, runId: "implementation-run-other" })
          .pipe(Effect.provide(restartLayer(rootThreadId, dispatched)), Effect.flip);
        assert.match(otherRun.message, /is not in this workflow/);
        assert.deepStrictEqual(dispatched, []);
      });
    });
  });
});
