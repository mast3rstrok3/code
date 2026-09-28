import { OrchestrationImplementationTicketState } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { expect, it } from "vite-plus/test";

import { readyTicketsWithinLimit } from "./implementationTicketConcurrency.ts";

const now = "2026-09-28T09:00:00.000Z";
const ticket = Schema.decodeUnknownSync(OrchestrationImplementationTicketState);
const readModel = { threads: [], appReviewWorkflowRuns: [] };

it("admits queued reviews only after dependencies finish and a slot opens", () => {
  const dependency = ticket({ ticketId: "dependency", status: "running", updatedAt: now });
  const review = ticket({
    ticketId: "review",
    status: "app-reviewing",
    updatedAt: now,
    dependencyTicketIds: ["dependency"],
    resumeQueuedAt: now,
  });
  const active = ticket({ ticketId: "active", status: "code-reviewing", updatedAt: now });
  const run = { skips: [], ticketStates: [dependency, review, active] };
  expect(readyTicketsWithinLimit(run, 5, readModel)).toEqual([]);
  const unblocked = {
    ...run,
    ticketStates: [{ ...dependency, status: "succeeded" as const }, review, active],
  };
  expect(readyTicketsWithinLimit(unblocked, 1, readModel)).toEqual([]);
  expect(readyTicketsWithinLimit(unblocked, 2, readModel)).toEqual(["review"]);
});

it("admits only the available number of reviews after a bulk resume", () => {
  const queued = Array.from({ length: 12 }, (_, index) =>
    ticket({
      ticketId: `review-${index}`,
      status: "app-reviewing",
      resumeQueuedAt: now,
      updatedAt: now,
    }),
  );
  const run = {
    skips: [],
    ticketStates: [...queued, ticket({ ticketId: "active", status: "running", updatedAt: now })],
  };
  expect(readyTicketsWithinLimit(run, 5, readModel)).toEqual([
    "review-0",
    "review-1",
    "review-2",
    "review-3",
  ]);
  const admitted = new Set(readyTicketsWithinLimit(run, 5, readModel));
  const persisted = {
    ...run,
    ticketStates: run.ticketStates.map((state) =>
      admitted.has(state.ticketId) ? { ...state, resumeQueuedAt: null } : state,
    ),
  };
  expect(readyTicketsWithinLimit(persisted, 5, readModel)).toEqual([]);
});
