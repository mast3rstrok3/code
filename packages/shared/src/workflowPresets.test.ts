import { describe, expect, it } from "vite-plus/test";
import {
  expectedIntentKindForWorkflowPreset,
  inferDisplayedWorkflowPreset,
  interactionModeForWorkflowPreset,
  WORKFLOW_PRESET_DEFINITIONS,
} from "./workflowPresets.js";

describe("workflow presets", () => {
  it("exposes Fast Feature, Engineering Workflow, and Wayfinder", () => {
    expect(WORKFLOW_PRESET_DEFINITIONS.map((definition) => definition.id)).toEqual([
      "fast-feature",
      "planning",
      "wayfinder",
    ]);
  });

  it("ends with final Code Review and pull-request publication", () => {
    const engineeringWorkflow = WORKFLOW_PRESET_DEFINITIONS.find(
      (definition) => definition.id === "planning",
    );
    expect(engineeringWorkflow?.helpSteps.at(-1)?.label).toContain(
      "Final Code Review and pull request",
    );
  });

  it("uses one bounded App Review between merge gate and final review", () => {
    const engineeringWorkflow = WORKFLOW_PRESET_DEFINITIONS.find(
      (definition) => definition.id === "planning",
    );
    expect(engineeringWorkflow?.helpSteps.slice(-3).map((step) => step.label)).toEqual([
      "Implementation phase · Merge ticket branches",
      "Implementation phase · App Review",
      "Implementation phase · Final Code Review and pull request",
    ]);
    expect(engineeringWorkflow?.helpSteps.at(-2)?.note).toContain("up to ten");
  });

  it("maps presets to provider modes and intent kinds", () => {
    expect(interactionModeForWorkflowPreset("fast-feature")).toBe("plan");
    expect(interactionModeForWorkflowPreset("product-planning")).toBe("product-workflow");
    expect(interactionModeForWorkflowPreset("implementation")).toBe("implementation-workflow");
    expect(expectedIntentKindForWorkflowPreset("fix")).toBe("fix");
    expect(expectedIntentKindForWorkflowPreset("full-feature")).toBe("feature");
  });

  it("offers Planning and Implementation as phases of Engineering Workflow", () => {
    const planning = WORKFLOW_PRESET_DEFINITIONS.find((definition) => definition.id === "planning");
    expect(planning?.label).toBe("Engineering Workflow");
    expect(planning?.helpSteps[1]?.label).toContain("Grill with Docs");
    expect(planning?.helpSteps.some((step) => step.label.startsWith("Planning phase"))).toBe(true);
    expect(planning?.helpSteps.some((step) => step.label.startsWith("Implementation phase"))).toBe(
      true,
    );
    expect(planning?.helpSteps.at(-1)?.label).toContain("pull request");
  });

  it("keeps the standalone Planning grill choice interactive", () => {
    const planning = WORKFLOW_PRESET_DEFINITIONS.find((definition) => definition.id === "planning");
    expect(planning?.helpSteps[1]?.skillId).toBe("planning.grill-stage.codex");
    expect(planning?.helpSteps[1]?.note).toBe("human-guided");
  });

  it("requires Product workflows to carry an explicit preset", () => {
    expect(
      inferDisplayedWorkflowPreset({ interactionMode: "product-workflow", workflowPreset: null }),
    ).toBe(null);
    expect(inferDisplayedWorkflowPreset({ interactionMode: "plan", workflowPreset: null })).toBe(
      null,
    );
  });
});
