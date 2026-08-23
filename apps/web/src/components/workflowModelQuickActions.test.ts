import { ProviderInstanceId, type ModelSelection } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  resolveWorkflowModelQuickActionSelection,
  workflowModelQuickActions,
} from "./workflowModelQuickActions.ts";

const selection: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.6-sol",
};

describe("workflowModelQuickActions", () => {
  it("offers concrete review roles for the Engineering Workflow", () => {
    const actions = workflowModelQuickActions("planning");
    expect(actions.map((action) => [action.id, action.label])).toEqual([
      ["e2e-browser-review", "E2E tests and browser review"],
      ["ticket-code-review", "Ticket Code Review"],
      ["final-code-review", "Final Code Review"],
    ]);
    const e2eBrowserReview = actions.find((action) => action.id === "e2e-browser-review");
    const ticketCodeReview = actions.find((action) => action.id === "ticket-code-review");
    const finalCodeReview = actions.find((action) => action.id === "final-code-review");

    expect(e2eBrowserReview?.pinKeys).toEqual([
      {
        workflowPromptId: "implementation.browser-app-review.codex",
        stepWorkflowPromptId: "implementation.browser-app-review.codex",
      },
    ]);
    expect(ticketCodeReview?.pinKeys).toEqual([
      {
        workflowPromptId: "implementation.code-review.codex",
        stepWorkflowPromptId: "implementation.tdd.codex",
      },
    ]);
    expect(finalCodeReview?.pinKeys).toEqual([
      { workflowPromptId: "implementation.code-review.codex" },
    ]);
  });

  it("only offers the E2E and browser review assignment in the App Review workflow", () => {
    expect(workflowModelQuickActions("app-review").map((action) => action.id)).toEqual([
      "e2e-browser-review",
    ]);
  });

  it("reports one shared selection and detects partial assignments", () => {
    const keys = [
      { workflowPromptId: "implementation.code-review.codex" },
      {
        workflowPromptId: "implementation.code-review.codex",
        stepWorkflowPromptId: "implementation.tdd.codex",
      },
    ];
    expect(resolveWorkflowModelQuickActionSelection(keys, () => selection)).toEqual({
      selection,
      mixed: false,
    });
    expect(
      resolveWorkflowModelQuickActionSelection(keys, (key) =>
        key.stepWorkflowPromptId === undefined ? selection : null,
      ),
    ).toEqual({ selection: null, mixed: true });
    expect(resolveWorkflowModelQuickActionSelection(keys, () => null)).toEqual({
      selection: null,
      mixed: false,
    });
  });
});
