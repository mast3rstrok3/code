import { type ThreadId, WorkflowArtifactAccessError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { getWorkflowArtifactsForThread } from "../../../orchestration/workflowArtifacts.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { WorkflowArtifactsToolkit } from "./tools.ts";

const resolve = Effect.fn("WorkflowArtifactsToolkit.resolve")(function* () {
  const scope = yield* McpInvocationContext.requireMcpCapability("workflow-artifacts");
  return yield* getWorkflowArtifactsForThread({ threadId: scope.threadId });
});

const notFound = (threadId: ThreadId, message: string) =>
  new WorkflowArtifactAccessError({ threadId, message });

export const handlers = {
  workflow_context_get: () => resolve().pipe(Effect.map((snapshot) => snapshot.context)),
  workflow_spec_get: () => resolve().pipe(Effect.map((snapshot) => snapshot.spec)),
  workflow_tickets_list: () => resolve().pipe(Effect.map((snapshot) => snapshot.tickets)),
  workflow_ticket_get: (input) =>
    Effect.gen(function* () {
      const snapshot = yield* resolve();
      const ticket = snapshot.tickets.find((candidate) => candidate.id === input.ticketId);
      if (ticket === undefined) {
        return yield* notFound(
          snapshot.context.rootThreadId,
          `Planning Ticket '${input.ticketId}' is not in this workflow.`,
        );
      }
      return ticket;
    }),
  workflow_dev_reviews_list: () => resolve().pipe(Effect.map((snapshot) => snapshot.devReviews)),
  workflow_dev_review_get: (input) =>
    Effect.gen(function* () {
      const snapshot = yield* resolve();
      const review = snapshot.devReviews.find((candidate) => candidate.id === input.reviewId);
      if (review === undefined) {
        return yield* notFound(
          snapshot.context.rootThreadId,
          `Dev Review '${input.reviewId}' is not in this workflow.`,
        );
      }
      return review;
    }),
} satisfies Parameters<typeof WorkflowArtifactsToolkit.toLayer>[0];

export const WorkflowArtifactsToolkitHandlersLive = WorkflowArtifactsToolkit.toLayer(handlers);
