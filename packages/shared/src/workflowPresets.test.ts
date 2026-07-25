import { describe, expect, it } from "vite-plus/test";
import {
  expectedIntentKindForWorkflowPreset,
  inferDisplayedWorkflowPreset,
  interactionModeForWorkflowPreset,
  WORKFLOW_PRESET_DEFINITIONS,
} from "./workflowPresets.js";

describe("workflow presets", () => {
  it("defines every preset once in canonical display order", () => {
    expect(WORKFLOW_PRESET_DEFINITIONS.map((definition) => definition.id)).toEqual([
      "fix",
      "fast-feature",
      "full-feature",
      "implementation",
      "planning",
    ]);
  });

  it("lists code review before change-request publication wherever both appear", () => {
    const orderings = WORKFLOW_PRESET_DEFINITIONS.flatMap((definition) => {
      const labels = definition.helpSteps.map((step) => step.label.toLowerCase());
      const codeReviewIndex = labels.findIndex((label) => label.includes("code review"));
      const changeRequestIndex = labels.findIndex((label) => label.includes("change request"));
      if (codeReviewIndex === -1 || changeRequestIndex === -1) return [];
      return [{ id: definition.id, codeReviewIndex, changeRequestIndex }];
    });
    expect(orderings.length).toBeGreaterThan(0);
    for (const ordering of orderings) {
      expect(
        ordering.codeReviewIndex,
        `${ordering.id} must publish its change request after code review`,
      ).toBeLessThan(ordering.changeRequestIndex);
    }
  });

  it("maps presets to provider modes and intent kinds", () => {
    expect(interactionModeForWorkflowPreset("fast-feature")).toBe("product-workflow");
    expect(interactionModeForWorkflowPreset("implementation")).toBe("implementation-workflow");
    expect(expectedIntentKindForWorkflowPreset("fix")).toBe("fix");
    expect(expectedIntentKindForWorkflowPreset("full-feature")).toBe("feature");
  });

  it("infers legacy workflow modes for display without making them explicit presets", () => {
    expect(
      inferDisplayedWorkflowPreset({ interactionMode: "product-workflow", workflowPreset: null }),
    ).toBe("full-feature");
    expect(inferDisplayedWorkflowPreset({ interactionMode: "plan", workflowPreset: null })).toBe(
      null,
    );
  });
});
