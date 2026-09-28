import {
  isTicketSkipped,
  isWorkflowThreadPaused,
  type OrchestrationImplementationRun,
  type OrchestrationReadModel,
} from "@t3tools/contracts";

/** A ticket holds its slot through implementation and review, except while paused. */
export function readyTicketsWithinLimit(
  run: Pick<OrchestrationImplementationRun, "ticketStates" | "skips">,
  limit: number,
  readModel: Pick<OrchestrationReadModel, "threads" | "appReviewWorkflowRuns">,
) {
  const pausedTicketIds = new Set(
    run.ticketStates
      .filter((ticket) => {
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
      })
      .map((ticket) => ticket.ticketId),
  );
  let available = Math.max(
    0,
    limit -
      run.ticketStates.filter(
        (ticket) =>
          !pausedTicketIds.has(ticket.ticketId) &&
          ["running", "app-reviewing", "code-reviewing", "awaiting-native-verification"].includes(
            ticket.status,
          ),
      ).length,
  );
  return run.ticketStates
    .filter((ticket) => {
      if (ticket.status !== "ready" || pausedTicketIds.has(ticket.ticketId)) return false;
      if (isTicketSkipped(run.skips, ticket.ticketId)) return true;
      if (available === 0) return false;
      available -= 1;
      return true;
    })
    .map((ticket) => ticket.ticketId);
}
