import { describe, expect, it } from "vite-plus/test";

import {
  PLAN_SIDEBAR_SECTION_IDS,
  addExpandedId,
  buildImplementationDependencyLanes,
  buildPlanningTicketPresentation,
  planningTicketLabel,
  toggleExpandedId,
  type PlanSidebarSectionId,
} from "./PlanSidebar.logic";

describe("PlanSidebar disclosure state", () => {
  it("defines every top-level section without expanding one by default", () => {
    const expanded = new Set<PlanSidebarSectionId>();

    expect(PLAN_SIDEBAR_SECTION_IDS).toEqual([
      "steps",
      "proposed-plan",
      "spec",
      "tickets",
      "review-cycles",
      "implementation-runs",
    ]);
    expect(expanded.size).toBe(0);
  });

  it("toggles sections independently", () => {
    const stepsExpanded = toggleExpandedId(new Set<PlanSidebarSectionId>(), "steps");
    const specAlsoExpanded = toggleExpandedId(stepsExpanded, "spec");

    expect([...specAlsoExpanded]).toEqual(["steps", "spec"]);
    expect([...toggleExpandedId(specAlsoExpanded, "steps")]).toEqual(["spec"]);
  });

  it("adds a focused nested item without removing existing expansion state", () => {
    const current = new Set(["ticket-1"]);
    const next = addExpandedId(current, "ticket-2");

    expect([...next]).toEqual(["ticket-1", "ticket-2"]);
    expect(addExpandedId(next, "ticket-2")).toBe(next);
  });
});

describe("PlanSidebar ticket presentation", () => {
  it("numbers sorted tickets from one without incrementing persisted ordinals", () => {
    const presentation = buildPlanningTicketPresentation([
      { id: "planning-ticket-first-uuid", title: "Create the contract" },
      { id: "planning-ticket-second-uuid", title: "Render the workflow" },
    ]);

    expect(presentation.get("planning-ticket-first-uuid")).toEqual({
      number: 1,
      title: "Create the contract",
      label: "#1 Create the contract",
    });
    expect(planningTicketLabel("planning-ticket-second-uuid", presentation)).toBe(
      "#2 Render the workflow",
    );
    expect(planningTicketLabel("missing-ticket-uuid", presentation, 3)).toBe(
      "#3 Ticket details unavailable",
    );
  });

  it("groups dependency levels and preserves parallel-capable ticket order", () => {
    expect(
      buildImplementationDependencyLanes([
        { ticketId: "ticket-1", dependencyTicketIds: [] },
        { ticketId: "ticket-2", dependencyTicketIds: [] },
        { ticketId: "ticket-3", dependencyTicketIds: ["ticket-1"] },
        { ticketId: "ticket-4", dependencyTicketIds: ["ticket-1", "ticket-2"] },
      ]),
    ).toEqual({
      levels: [
        ["ticket-1", "ticket-2"],
        ["ticket-3", "ticket-4"],
      ],
      unresolvedTicketIds: [],
    });
  });

  it("isolates cyclic and missing dependencies instead of dropping tickets", () => {
    expect(
      buildImplementationDependencyLanes([
        { ticketId: "ticket-ready", dependencyTicketIds: [] },
        { ticketId: "ticket-cycle-a", dependencyTicketIds: ["ticket-cycle-b"] },
        { ticketId: "ticket-cycle-b", dependencyTicketIds: ["ticket-cycle-a"] },
        { ticketId: "ticket-missing", dependencyTicketIds: ["unknown-ticket"] },
      ]),
    ).toEqual({
      levels: [["ticket-ready"]],
      unresolvedTicketIds: ["ticket-cycle-a", "ticket-cycle-b", "ticket-missing"],
    });
  });
});
