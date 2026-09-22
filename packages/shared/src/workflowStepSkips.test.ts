import { describe, expect, it } from "vite-plus/test";
import { OrchestrationPlanningTicketId } from "@t3tools/contracts";

import { implementationWorkflowDefaultSkips } from "./workflowStepSkips.ts";

describe("Engineering Workflow default skips", () => {
  it("keeps every optional step enabled by default", () => {
    expect(
      implementationWorkflowDefaultSkips({
        ticketAppReviewEnabled: true,
        appReviewEnabled: true,
        finalCodeReviewEnabled: true,
        pullRequestCreationEnabled: true,
        pullRequestBabysittingEnabled: true,
      }),
    ).toEqual([]);
  });

  it("maps disabled steps to distinct run skip targets", () => {
    expect(
      implementationWorkflowDefaultSkips({
        ticketAppReviewEnabled: false,
        appReviewEnabled: false,
        finalCodeReviewEnabled: false,
        pullRequestCreationEnabled: false,
        pullRequestBabysittingEnabled: false,
      }),
    ).toEqual([
      { kind: "run", stage: "app-review" },
      { kind: "run", stage: "code-review" },
      { kind: "run", stage: "change-request" },
      { kind: "run", stage: "change-request-babysit" },
    ]);
  });

  it("keeps ticket and combined App Reviews separate", () => {
    expect(
      implementationWorkflowDefaultSkips(
        {
          ticketAppReviewEnabled: false,
          appReviewEnabled: true,
          finalCodeReviewEnabled: true,
          pullRequestCreationEnabled: true,
          pullRequestBabysittingEnabled: true,
        },
        [OrchestrationPlanningTicketId.make("ticket-1")],
      ),
    ).toEqual([{ kind: "ticket", ticketId: "ticket-1", stage: "app-review" }]);
  });

  it("turns babysitting off when pull-request creation is off", () => {
    expect(
      implementationWorkflowDefaultSkips({
        ticketAppReviewEnabled: true,
        appReviewEnabled: true,
        finalCodeReviewEnabled: true,
        pullRequestCreationEnabled: false,
        pullRequestBabysittingEnabled: true,
      }),
    ).toEqual([
      { kind: "run", stage: "change-request" },
      { kind: "run", stage: "change-request-babysit" },
    ]);
  });
});
