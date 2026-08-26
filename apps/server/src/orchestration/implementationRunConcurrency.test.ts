import { describe, expect, it } from "vite-plus/test";

import { runUpdateWouldOverwriteNewerTicketState } from "./implementationRunConcurrency.ts";

describe("runUpdateWouldOverwriteNewerTicketState", () => {
  it("rejects a run update carrying ticket state from before a reset", () => {
    expect(
      runUpdateWouldOverwriteNewerTicketState(
        {
          ticketStates: [{ ticketId: "ticket-1", updatedAt: "2026-08-26T10:14:16.210Z" }],
        },
        {
          ticketStates: [{ ticketId: "ticket-1", updatedAt: "2026-08-26T10:12:42.690Z" }],
        },
      ),
    ).toBe(true);
  });

  it("accepts an update whose ticket states are current or newer", () => {
    expect(
      runUpdateWouldOverwriteNewerTicketState(
        {
          ticketStates: [{ ticketId: "ticket-1", updatedAt: "2026-08-26T10:12:42.690Z" }],
        },
        {
          ticketStates: [{ ticketId: "ticket-1", updatedAt: "2026-08-26T10:14:16.210Z" }],
        },
      ),
    ).toBe(false);
  });

  it("rejects an update that omits a projected ticket", () => {
    expect(
      runUpdateWouldOverwriteNewerTicketState(
        {
          ticketStates: [{ ticketId: "ticket-1", updatedAt: "2026-08-26T10:14:16.210Z" }],
        },
        { ticketStates: [] },
      ),
    ).toBe(true);
  });
});
