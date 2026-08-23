import { describe, expect, it } from "vite-plus/test";

import { implementationWorkflowDefaultSkips } from "./workflowStepSkips.ts";

describe("Engineering Workflow default skips", () => {
  it("keeps every optional step enabled by default", () => {
    expect(
      implementationWorkflowDefaultSkips({
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
});
