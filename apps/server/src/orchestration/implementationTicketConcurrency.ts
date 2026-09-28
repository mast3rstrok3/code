import {
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

/** A ticket holds its slot through implementation and review, except while paused or queued. */
export function readyTicketsWithinLimit(
  run: Pick<OrchestrationImplementationRun, "ticketStates" | "skips">,
  limit: number,
  readModel: Pick<OrchestrationReadModel, "threads" | "appReviewWorkflowRuns">,
) {
  const pausedTicketIds = new Set(
    run.ticketStates
      .filter((ticket) => ticketIsPaused(ticket, readModel))
      .map((ticket) => ticket.ticketId),
  );
  let available = Math.max(
    0,
    limit -
      run.ticketStates.filter(
        (ticket) =>
          !pausedTicketIds.has(ticket.ticketId) &&
          ticket.resumeQueuedAt == null &&
          ["running", "app-reviewing", "code-reviewing", "awaiting-native-verification"].includes(
            ticket.status,
          ),
      ).length,
  );
  return run.ticketStates
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
      if (available === 0) return false;
      available -= 1;
      return true;
    })
    .map((ticket) => ticket.ticketId);
}
