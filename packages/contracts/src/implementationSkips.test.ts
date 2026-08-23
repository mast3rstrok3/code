import { assert, describe, it } from "vite-plus/test";

import {
  applyImplementationSkip,
  isRunStageSkipped,
  isTicketSkipped,
  isTicketStageSkipped,
  type OrchestrationImplementationSkipTarget,
} from "./orchestration.ts";

const ticket = "planning-ticket-1" as never;
const other = "planning-ticket-2" as never;

describe("implementation skips", () => {
  it("covers every stage of a ticket skipped whole", () => {
    const skips = applyImplementationSkip([], { kind: "ticket", ticketId: ticket }, true);
    assert.isTrue(isTicketStageSkipped(skips, ticket, "implementation"));
    assert.isTrue(isTicketStageSkipped(skips, ticket, "app-review"));
    assert.isTrue(isTicketSkipped(skips, ticket));
    assert.isFalse(isTicketStageSkipped(skips, other, "app-review"));
  });

  it("keeps a stage skip to its own stage and ticket", () => {
    const skips = applyImplementationSkip(
      [],
      { kind: "ticket", ticketId: ticket, stage: "app-review" },
      true,
    );
    assert.isTrue(isTicketStageSkipped(skips, ticket, "app-review"));
    assert.isFalse(isTicketStageSkipped(skips, ticket, "code-review"));
    assert.isFalse(isTicketSkipped(skips, ticket));
  });

  it("replaces a ticket's stage skips when the whole ticket is skipped", () => {
    let skips: ReadonlyArray<OrchestrationImplementationSkipTarget> = [];
    skips = applyImplementationSkip(
      skips,
      { kind: "ticket", ticketId: ticket, stage: "app-review" },
      true,
    );
    skips = applyImplementationSkip(skips, { kind: "ticket", ticketId: ticket }, true);
    assert.lengthOf(skips, 1);
    // Lifting the ticket lifts the stage skip it swallowed, so the two cannot disagree.
    skips = applyImplementationSkip(skips, { kind: "ticket", ticketId: ticket }, false);
    assert.lengthOf(skips, 0);
  });

  it("lifts a skip without touching the others", () => {
    let skips: ReadonlyArray<OrchestrationImplementationSkipTarget> = [];
    skips = applyImplementationSkip(skips, { kind: "run", stage: "app-review" }, true);
    skips = applyImplementationSkip(skips, { kind: "ticket", ticketId: other }, true);
    assert.isTrue(isRunStageSkipped(skips, "app-review"));
    skips = applyImplementationSkip(skips, { kind: "run", stage: "app-review" }, false);
    assert.isFalse(isRunStageSkipped(skips, "app-review"));
    assert.isTrue(isTicketSkipped(skips, other));
  });

  it("does not double-record the same skip", () => {
    let skips: ReadonlyArray<OrchestrationImplementationSkipTarget> = [];
    skips = applyImplementationSkip(skips, { kind: "run", stage: "code-review" }, true);
    skips = applyImplementationSkip(skips, { kind: "run", stage: "code-review" }, true);
    assert.lengthOf(skips, 1);
  });

  it("tracks pull request creation and babysitting independently", () => {
    let skips: ReadonlyArray<OrchestrationImplementationSkipTarget> = [];
    skips = applyImplementationSkip(skips, { kind: "run", stage: "change-request" }, true);
    assert.isTrue(isRunStageSkipped(skips, "change-request"));
    assert.isFalse(isRunStageSkipped(skips, "change-request-babysit"));

    skips = applyImplementationSkip(skips, { kind: "run", stage: "change-request-babysit" }, true);
    assert.isTrue(isRunStageSkipped(skips, "change-request"));
    assert.isTrue(isRunStageSkipped(skips, "change-request-babysit"));

    skips = applyImplementationSkip(skips, { kind: "run", stage: "change-request" }, false);
    assert.isFalse(isRunStageSkipped(skips, "change-request"));
    assert.isTrue(isRunStageSkipped(skips, "change-request-babysit"));
  });
});
