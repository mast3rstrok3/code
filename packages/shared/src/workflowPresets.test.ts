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
      "fast-feature",
      "full-feature",
      "wayfinder",
      "implementation",
      "planning",
    ]);
  });

  it("defines Fast Feature as four topology-driven stages", () => {
    const definition = WORKFLOW_PRESET_DEFINITIONS.find(
      (candidate) => candidate.id === "fast-feature",
    );
    expect(definition?.helpSteps.map((step) => step.label)).toEqual([
      "Planning",
      "Building",
      "App Review",
      "Code Review",
    ]);
    expect(definition?.workflowPromptId).toBe("planning.fast-feature.codex");
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
    expect(interactionModeForWorkflowPreset("fast-feature")).toBe("plan");
    expect(interactionModeForWorkflowPreset("product-planning")).toBe("product-workflow");
    expect(interactionModeForWorkflowPreset("implementation")).toBe("implementation-workflow");
    expect(expectedIntentKindForWorkflowPreset("fix")).toBe("fix");
    expect(expectedIntentKindForWorkflowPreset("full-feature")).toBe("feature");
  });

  it("offers one Planning entry with an initial grill choice", () => {
    const planning = WORKFLOW_PRESET_DEFINITIONS.find((definition) => definition.id === "planning");
    expect(planning?.label).toBe("Planning");
    expect(planning?.helpSteps[1]?.label).toBe("Choose Product or Engineering Grill");
    expect(planning?.helpSteps.at(-1)?.label).toBe("Start Implementation");
  });

  it("runs Product Grill before Engineering Grill for Full Feature", () => {
    const fullFeature = WORKFLOW_PRESET_DEFINITIONS.find(
      (definition) => definition.id === "full-feature",
    );
    expect(fullFeature?.helpSteps.slice(1, 3).map((step) => step.skillId)).toEqual([
      "product.full-feature.codex",
      "planning.engineering-grill-automatic.codex",
    ]);
    expect(fullFeature?.helpSteps.slice(1, 3).map((step) => step.note)).toEqual([
      "human-guided",
      "automatic",
    ]);
    expect(fullFeature?.helpSteps.slice(2).every((step) => step.note?.includes("automatic"))).toBe(
      true,
    );
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
