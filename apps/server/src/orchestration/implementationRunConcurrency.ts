type TicketStateRevision = {
  readonly ticketId: string;
  readonly updatedAt: string;
};

/**
 * Full-run updates may be computed before a newer ticket reset is projected.
 * Reject the old write instead of restoring an earlier ticket state.
 */
export function runUpdateWouldOverwriteNewerTicketState(
  current: { readonly ticketStates: ReadonlyArray<TicketStateRevision> },
  incoming: { readonly ticketStates: ReadonlyArray<TicketStateRevision> },
): boolean {
  const incomingByTicketId = new Map(
    incoming.ticketStates.map((state) => [state.ticketId, state] as const),
  );

  return current.ticketStates.some((state) => {
    const candidate = incomingByTicketId.get(state.ticketId);
    return candidate === undefined || state.updatedAt > candidate.updatedAt;
  });
}
