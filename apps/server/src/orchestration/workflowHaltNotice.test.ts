import { describe, expect, it } from "@effect/vitest";
import type { OrchestrationImplementationRun } from "@t3tools/contracts";

import { workflowHaltNotice } from "./workflowHaltNotice.ts";

const halt = {
  ticketId: "planning-ticket-3",
  stage: "code-review",
  category: "retry-exhausted",
  detail: "Ticket exhausted its Code Review launch budget.",
  haltedAt: "2026-11-10T21:36:52.939Z",
} as const;
const run = (automationHalt: unknown) =>
  ({ id: "implementation-run-1", automationHalt }) as unknown as OrchestrationImplementationRun;
const ticket = { id: "planning-ticket-3", key: "TICKET-3", title: "Speech practice" } as never;

describe("workflowHaltNotice", () => {
  it("names a new halt, its ticket and the restart tool", () => {
    const text = workflowHaltNotice({ previous: run(null), next: run(halt), ticket });
    expect(text).toContain('ticket TICKET-3 "Speech practice"');
    expect(text).toContain("retry-exhausted");
    expect(text).toContain("workflow_stage_restart");
  });

  it("stays quiet when the halt is unchanged or cleared", () => {
    const reworded = { ...halt, detail: "Regrouped with a sibling ticket." };
    expect(workflowHaltNotice({ previous: run(halt), next: run(reworded), ticket })).toBeNull();
    expect(workflowHaltNotice({ previous: run(halt), next: run(null), ticket })).toBeNull();
  });

  it("notifies again when the same stage halts a second time", () => {
    const again = { ...halt, haltedAt: "2026-11-10T23:00:00.000Z" };
    expect(workflowHaltNotice({ previous: run(halt), next: run(again), ticket })).not.toBeNull();
  });
});
