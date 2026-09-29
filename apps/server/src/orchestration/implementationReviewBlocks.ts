import type {
  OrchestrationImplementationRun,
  OrchestrationImplementationTicketState,
} from "@t3tools/contracts";

export function ticketAppReviewIsBlocked(
  ticket: Pick<OrchestrationImplementationTicketState, "status" | "appReviewOutcome">,
): boolean {
  return ticket.status === "blocked" && ticket.appReviewOutcome === "failed";
}

/** Keep a failed ticket review from stopping independent tickets, including after a restart. */
export function isolateTicketReviewBlocks(
  run: OrchestrationImplementationRun,
): OrchestrationImplementationRun {
  const halt = run.automationHalt;
  const ticketReviewHalt =
    halt?.ticketId !== undefined &&
    halt.stage === "app-review" &&
    halt.category === "review-blocked" &&
    run.ticketStates.some(
      (ticket) => ticket.ticketId === halt.ticketId && ticket.appReviewOutcome === "failed",
    );
  if (
    (run.status !== "running" && run.status !== "needs-human-attention") ||
    (halt !== null && !ticketReviewHalt)
  )
    return run;
  const hasFailedReview = run.ticketStates.some(
    (ticket) => ticket.status === "app-reviewing" && ticket.appReviewOutcome === "failed",
  );
  const ticketStates = hasFailedReview
    ? run.ticketStates.map((ticket) =>
        ticket.status === "app-reviewing" && ticket.appReviewOutcome === "failed"
          ? { ...ticket, status: "blocked" as const, resumeQueuedAt: null }
          : ticket,
      )
    : run.ticketStates;
  if (!ticketStates.some(ticketAppReviewIsBlocked)) return run;
  const status = ticketStates.some((ticket) =>
    [
      "ready",
      "running",
      "app-reviewing",
      "code-reviewing",
      "awaiting-native-verification",
    ].includes(ticket.status),
  )
    ? "running"
    : "needs-human-attention";
  if (!ticketReviewHalt && !hasFailedReview && status === run.status) return run;
  return { ...run, status, ticketStates, automationHalt: null };
}
