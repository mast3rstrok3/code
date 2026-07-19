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
