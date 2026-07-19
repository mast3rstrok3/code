export const PLAN_SIDEBAR_SECTION_IDS = [
  "steps",
  "proposed-plan",
  "spec",
  "tickets",
  "review-cycles",
  "implementation-runs",
] as const;

export type PlanSidebarSectionId = (typeof PLAN_SIDEBAR_SECTION_IDS)[number];

export function toggleExpandedId<T>(current: ReadonlySet<T>, id: T): ReadonlySet<T> {
  const next = new Set(current);
  if (next.has(id)) {
    next.delete(id);
  } else {
    next.add(id);
  }
  return next;
}

export function addExpandedId<T>(current: ReadonlySet<T>, id: T): ReadonlySet<T> {
  if (current.has(id)) return current;
  return new Set([...current, id]);
}

export interface PlanningTicketPresentationInput {
  readonly id: string;
  readonly title: string;
}

export interface PlanningTicketPresentation {
  readonly number: number;
  readonly title: string;
  readonly label: string;
}

export function buildPlanningTicketPresentation(
  tickets: ReadonlyArray<PlanningTicketPresentationInput>,
): ReadonlyMap<string, PlanningTicketPresentation> {
  return new Map(
    tickets.map((ticket, index) => {
      const number = index + 1;
      return [
        ticket.id,
        { number, title: ticket.title, label: `#${number} ${ticket.title}` },
      ] as const;
    }),
  );
}

export function planningTicketLabel(
  ticketId: string,
  presentationById: ReadonlyMap<string, PlanningTicketPresentation>,
  fallbackNumber?: number,
): string {
  const presentation = presentationById.get(ticketId);
  if (presentation !== undefined) return presentation.label;
  return fallbackNumber === undefined
    ? "Ticket details unavailable"
    : `#${fallbackNumber} Ticket details unavailable`;
}

export interface ImplementationTicketDependencyInput {
  readonly ticketId: string;
  readonly dependencyTicketIds: ReadonlyArray<string>;
}

export interface ImplementationDependencyLaneLayout {
  readonly levels: ReadonlyArray<ReadonlyArray<string>>;
  readonly unresolvedTicketIds: ReadonlyArray<string>;
}

export function buildImplementationDependencyLanes(
  ticketStates: ReadonlyArray<ImplementationTicketDependencyInput>,
): ImplementationDependencyLaneLayout {
  const knownTicketIds = new Set(ticketStates.map((state) => state.ticketId));
  const pending = new Map(ticketStates.map((state) => [state.ticketId, state] as const));
  const resolvedTicketIds = new Set<string>();
  const levels: Array<ReadonlyArray<string>> = [];

  while (pending.size > 0) {
    const readyTicketIds = ticketStates
      .filter((state) => pending.has(state.ticketId))
      .filter(
        (state) =>
          state.dependencyTicketIds.every((ticketId) => knownTicketIds.has(ticketId)) &&
          state.dependencyTicketIds.every((ticketId) => resolvedTicketIds.has(ticketId)),
      )
      .map((state) => state.ticketId);

    if (readyTicketIds.length === 0) {
      return {
        levels,
        unresolvedTicketIds: ticketStates
          .filter((state) => pending.has(state.ticketId))
          .map((state) => state.ticketId),
      };
    }

    levels.push(readyTicketIds);
    for (const ticketId of readyTicketIds) {
      pending.delete(ticketId);
      resolvedTicketIds.add(ticketId);
    }
  }

  return { levels, unresolvedTicketIds: [] };
}
