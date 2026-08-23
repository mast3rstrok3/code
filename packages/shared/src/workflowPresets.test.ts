import { describe, expect, it } from "vite-plus/test";
import {
  expectedIntentKindForWorkflowPreset,
  inferDisplayedWorkflowPreset,
  interactionModeForWorkflowPreset,
  WORKFLOW_PRESET_DEFINITIONS,
  workflowPromptIdForPreset,
} from "./workflowPresets.js";

describe("workflow presets", () => {
  it("exposes Fast Feature, Engineering Workflow, Wayfinder, and App Review", () => {
    expect(WORKFLOW_PRESET_DEFINITIONS.map((definition) => definition.id)).toEqual([
      "fast-feature",
      "planning",
      "wayfinder",
      "app-review",
    ]);
  });

  it("makes App Review one looping step over its three agents", () => {
    const appReview = WORKFLOW_PRESET_DEFINITIONS.find(
      (definition) => definition.id === "app-review",
    );
    // Sending in this mode launches a run instead of starting a turn, so the
    // preset carries no entry prompt of its own.
    expect(workflowPromptIdForPreset("app-review")).toBeUndefined();
    expect(interactionModeForWorkflowPreset("app-review")).toBe("default");
    expect(appReview?.helpSteps).toHaveLength(1);
    expect(appReview?.helpSteps[0]?.subSteps?.map((subStep) => subStep.workflowPromptId)).toEqual([
      "implementation.browser-app-review.codex",
      "matt-pocock.to-tickets",
      "matt-pocock.implement",
    ]);
  });

  it("separates final Code Review, pull-request creation, and babysitting", () => {
    const engineeringWorkflow = WORKFLOW_PRESET_DEFINITIONS.find(
      (definition) => definition.id === "planning",
    );
    expect(engineeringWorkflow?.helpSteps.slice(-3).map((step) => step.label)).toEqual([
      "Implementation phase · Final Code Review",
      "Implementation phase · Create pull request",
      "Implementation phase · Babysit pull request",
    ]);
  });

  it("uses one bounded App Review between merge gate and final review", () => {
    const engineeringWorkflow = WORKFLOW_PRESET_DEFINITIONS.find(
      (definition) => definition.id === "planning",
    );
    expect(engineeringWorkflow?.helpSteps.slice(-5, -2).map((step) => step.label)).toEqual([
      "Implementation phase · Merge ticket branches",
      "Implementation phase · App Review",
      "Implementation phase · Final Code Review",
    ]);
    expect(engineeringWorkflow?.helpSteps.at(-4)?.note).toContain("ten review");
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
    expect(planning?.helpSteps.at(-2)?.label).toContain("pull request");
  });

  it("keeps the standalone Planning grill choice interactive", () => {
    const planning = WORKFLOW_PRESET_DEFINITIONS.find((definition) => definition.id === "planning");
    expect(planning?.helpSteps[1]?.skillId).toBe("planning.grill-stage.codex");
    expect(planning?.helpSteps[1]?.note).toBe("human-guided");
  });

  it("starts the Engineering Workflow on its grill prompt", () => {
    // The turn's prompt id is what provisions the structured-question tool, so
    // a missing id silently downgrades the grill to the provider's own
    // small-batch question tool.
    expect(workflowPromptIdForPreset("planning")).toBe("planning.grill-stage.codex");
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
