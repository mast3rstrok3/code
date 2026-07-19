import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_WORKSPACE_USER_ID,
  DevReviewId,
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
const workflowId = WorkflowId.make("workflow-artifacts-1");
const ticketId = "planning-ticket-1";

const readModel = {
  snapshotSequence: 1,
  projects: [],
  implementationRuns: [],
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
      devReviews: [],
    },
    {
      id: childThreadId,
      projectId,
      ownerUserId: DEFAULT_WORKSPACE_USER_ID,
      workflowContext: { workflowId, rootThreadId, ticketScope: [ticketId] },
      planningWorkflow: null,
      devReviews: [
        {
          id: DevReviewId.make("dev-review-1"),
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
  expiresAt: Number.MAX_SAFE_INTEGER,
});

describe("workflow-artifacts toolkit handlers", () => {
  it.effect("resolves canonical artifacts and many-to-many Dev Review links from a child", () =>
    Effect.gen(function* () {
      const context = yield* handlers.workflow_context_get();
      const spec = yield* handlers.workflow_spec_get();
      const tickets = yield* handlers.workflow_tickets_list();
      const review = yield* handlers.workflow_dev_review_get({
        reviewId: DevReviewId.make("dev-review-1"),
      });

      assert.strictEqual(context.workflowId, workflowId);
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
});
