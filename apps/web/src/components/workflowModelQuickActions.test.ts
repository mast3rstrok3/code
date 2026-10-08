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
  it("pins each review role for ticket and final reviews of the Engineering Workflow", () => {
    const actions = workflowModelQuickActions("planning");
    expect(actions.map((action) => [action.id, action.label])).toEqual([
      ["app-review", "App Review"],
      ["code-review", "Code Review"],
    ]);
    expect(actions.find((action) => action.id === "app-review")?.pinKeys).toEqual([
      {
        workflowPromptId: "implementation.browser-app-review.codex",
        stepWorkflowPromptId: "implementation.tdd.codex",
      },
      { workflowPromptId: "implementation.browser-app-review.codex" },
    ]);
    expect(actions.find((action) => action.id === "code-review")?.pinKeys).toEqual([
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

  it("reports mixed when ticket and final App Review models differ", () => {
    const keys = workflowModelQuickActions("planning").find(
      (action) => action.id === "app-review",
    )!.pinKeys;
    const otherSelection: ModelSelection = {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-opus-5",
    };

    expect(
      resolveWorkflowModelQuickActionSelection(keys, (key) =>
        key.stepWorkflowPromptId === "implementation.tdd.codex" ? selection : otherSelection,
      ),
    ).toEqual({ selection: null, mixed: true });
  });
});
