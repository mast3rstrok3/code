import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_WORKSPACE_USER_ID,
  AppReviewId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WorkflowId,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { getWorkflowArtifactsForThread } from "../../../orchestration/workflowArtifacts.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { handlers } from "./handlers.ts";

const projectId = ProjectId.make("project-workflow-artifacts");
const otherProjectId = ProjectId.make("project-other");
const rootThreadId = ThreadId.make("thread-workflow-root");
const childThreadId = ThreadId.make("thread-workflow-child");
const implementationThreadId = ThreadId.make("thread-implementation-orchestrator");
const appReviewControllerThreadId = ThreadId.make("thread-app-review-orchestrator");
const nestedReviewerThreadId = ThreadId.make("thread-app-review-reviewer");
const detachedThreadId = ThreadId.make("thread-detached-workflow");
const workflowId = WorkflowId.make("workflow-artifacts-1");
const implementationWorkflowId = WorkflowId.make("implementation-run-1");
const appReviewWorkflowId = WorkflowId.make("app-review-workflow-1");
const ticketId = "planning-ticket-1";

const readModel = {
  snapshotSequence: 1,
  projects: [],
  implementationRuns: [],
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
            verdict: "pass",
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
            verdict: "blocked",
            summary: "Reviewing",
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
  ],
} as unknown as OrchestrationReadModel;

const queryLayer = Layer.mock(ProjectionSnapshotQuery)({
  getCommandReadModel: () => Effect.succeed(readModel),
});

const invocationLayer = Layer.succeed(McpInvocationContext.McpInvocationContext, {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: childThreadId,
  providerSessionId: "provider-session-1",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(["workflow-artifacts"] as const),
  issuedAt: 1,
});

const nestedReviewerInvocationLayer = Layer.succeed(McpInvocationContext.McpInvocationContext, {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: nestedReviewerThreadId,
  providerSessionId: "provider-session-nested-reviewer",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(["workflow-artifacts"] as const),
  issuedAt: 1,
});

describe("workflow-artifacts toolkit handlers", () => {
  it.effect("resolves canonical artifacts and many-to-many App Review links from a child", () =>
    Effect.gen(function* () {
      const context = yield* handlers.workflow_context_get();
      const wayfinderMap = yield* handlers.workflow_wayfinder_map_get();
      const spec = yield* handlers.workflow_spec_get();
      const tickets = yield* handlers.workflow_tickets_list();
      const review = yield* handlers.workflow_app_review_get({
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
      const ticketError = yield* handlers
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
      const context = yield* handlers.workflow_context_get();
      const spec = yield* handlers.workflow_spec_get();
      const tickets = yield* handlers.workflow_tickets_list();
      const ticket = yield* handlers.workflow_ticket_get({ ticketId });

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

  it.effect("does not authorize artifacts by shared root thread alone", () =>
    Effect.gen(function* () {
      const snapshot = yield* getWorkflowArtifactsForThread({ threadId: detachedThreadId });

      assert.strictEqual(snapshot.spec, null);
      assert.deepStrictEqual(snapshot.tickets, []);
    }).pipe(Effect.provide(queryLayer)),
  );

  it.effect("loads built-in workflow docs and rejects unknown IDs", () =>
    Effect.gen(function* () {
      const doc = yield* handlers.workflow_doc_get({ docId: "context-format" });
      assert.strictEqual(doc.path, "CONTEXT-FORMAT.md");
      assert.match(doc.content, /# CONTEXT\.md Format/);

      const error = yield* handlers.workflow_doc_get({ docId: "missing" }).pipe(Effect.flip);
      assert.strictEqual(error._tag, "WorkflowArtifactAccessError");
      assert.match(error.message, /was not found/);
    }).pipe(Effect.provide(invocationLayer)),
  );
});
