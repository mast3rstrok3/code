import {
  DEFAULT_MAX_PARALLEL_APP_REVIEWS,
  isTicketSkipped,
  isWorkflowThreadPaused,
  type OrchestrationImplementationRun,
  type OrchestrationImplementationTicketState,
  type AppReviewWorkflowRun,
  type OrchestrationReadModel,
} from "@t3tools/contracts";

export function ticketIsPaused(
  ticket: OrchestrationImplementationTicketState,
  readModel: Pick<OrchestrationReadModel, "threads" | "appReviewWorkflowRuns">,
) {
  const review = readModel.appReviewWorkflowRuns?.find(
    (entry) => entry.id === ticket.appReviewWorkflowRunId,
  );
  const stageThreadId =
    ticket.status === "code-reviewing"
      ? ticket.codeReviewThreadId
      : ticket.status === "app-reviewing" || ticket.status === "awaiting-native-verification"
        ? review?.controllerThreadId
        : ticket.workerThreadId;
  return [ticket.workerThreadId, stageThreadId].some(
    (threadId) => threadId != null && isWorkflowThreadPaused(readModel.threads, threadId),
  );
}

export function appReviewWaitsForAdmission(
  run: AppReviewWorkflowRun,
  readModel: Pick<OrchestrationReadModel, "implementationRuns">,
) {
  const caller = run.caller;
  return (
    caller.type === "implementation" &&
    caller.ticketId !== undefined &&
    readModel.implementationRuns
      .find((entry) => entry.id === caller.implementationRunId)
      ?.ticketStates.find((ticket) => ticket.ticketId === caller.ticketId)?.resumeQueuedAt != null
  );
}

/** Paused and queued stages release capacity in their respective pools. */
export function readyTicketsWithinLimit(
  run: Pick<OrchestrationImplementationRun, "ticketStates" | "skips">,
  limit: number,
  readModel: Pick<OrchestrationReadModel, "threads" | "appReviewWorkflowRuns">,
  appReviewLimit = DEFAULT_MAX_PARALLEL_APP_REVIEWS,
) {
  const pausedTicketIds = new Set(
    run.ticketStates
      .filter((ticket) => ticketIsPaused(ticket, readModel))
      .map((ticket) => ticket.ticketId),
  );
  const poolFor = (ticket: OrchestrationImplementationTicketState) =>
    ticket.status === "app-reviewing" || ticket.status === "awaiting-native-verification"
      ? "appReview"
      : "ticket";
  const available = { ticket: limit, appReview: appReviewLimit };
  for (const ticket of run.ticketStates) {
    if (
      !pausedTicketIds.has(ticket.ticketId) &&
      ticket.resumeQueuedAt == null &&
      ["running", "app-reviewing", "code-reviewing", "awaiting-native-verification"].includes(
        ticket.status,
      )
    ) {
      available[poolFor(ticket)] -= 1;
    }
  }
  // Finish admitted tickets before starting more implementation work.
  return [...run.ticketStates]
    .sort(
      (left, right) => Number(right.resumeQueuedAt != null) - Number(left.resumeQueuedAt != null),
    )
    .filter((ticket) => {
      if (
        (ticket.status !== "ready" && ticket.resumeQueuedAt == null) ||
        pausedTicketIds.has(ticket.ticketId)
      )
        return false;
      if (
        ticket.dependencyTicketIds.some(
          (id) => run.ticketStates.find((entry) => entry.ticketId === id)?.status !== "succeeded",
        )
      )
        return false;
      if (isTicketSkipped(run.skips, ticket.ticketId)) return true;
      const pool = poolFor(ticket);
      if (available[pool] <= 0) return false;
      available[pool] -= 1;
      return true;
    })
    .map((ticket) => ticket.ticketId);
}
