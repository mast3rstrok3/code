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
  it("groups ticket and final review pins for the Engineering Workflow", () => {
    const actions = workflowModelQuickActions("planning");
    const appReview = actions.find((action) => action.id === "app-review");
    const codeReview = actions.find((action) => action.id === "code-review");

    expect(appReview?.pinKeys).toEqual([
      {
        workflowPromptId: "implementation.browser-app-review.codex",
        stepWorkflowPromptId: "implementation.tdd.codex",
      },
      { workflowPromptId: "implementation.browser-app-review.codex" },
      {
        workflowPromptId: "implementation.browser-app-review.codex",
        stepWorkflowPromptId: "implementation.browser-app-review.codex",
      },
    ]);
    expect(codeReview?.pinKeys).toEqual([
      {
        workflowPromptId: "implementation.code-review.codex",
        stepWorkflowPromptId: "implementation.tdd.codex",
      },
      { workflowPromptId: "implementation.code-review.codex" },
    ]);
  });

  it("only offers the App Review assignment in the App Review workflow", () => {
    expect(workflowModelQuickActions("app-review").map((action) => action.id)).toEqual([
      "app-review",
    ]);
  });

  it("reports one shared selection and detects partial assignments", () => {
    const keys = workflowModelQuickActions("planning")[1]!.pinKeys;
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
