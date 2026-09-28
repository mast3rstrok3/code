import { isTicketSkipped, type OrchestrationImplementationRun } from "@t3tools/contracts";

/** A ticket holds its slot until implementation and its reviews finish. */
export function readyTicketsWithinLimit(
  run: Pick<OrchestrationImplementationRun, "ticketStates" | "skips">,
  limit: number,
) {
  let available = Math.max(
    0,
    limit -
      run.ticketStates.filter((ticket) =>
        ["running", "app-reviewing", "code-reviewing", "awaiting-native-verification"].includes(
          ticket.status,
        ),
      ).length,
  );
  return run.ticketStates
    .filter((ticket) => {
      if (ticket.status !== "ready") return false;
      if (isTicketSkipped(run.skips, ticket.ticketId)) return true;
      if (available === 0) return false;
      available -= 1;
      return true;
    })
    .map((ticket) => ticket.ticketId);
}
