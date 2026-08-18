import { describe, expect, it } from "vite-plus/test";
import {
  buildComposerModeTriggerDisplay,
  resolveComposerPrimaryMode,
  resolveWorkflowPresetForPicker,
  sortComposerBuildSkills,
} from "./ComposerModePicker";

describe("ComposerModePicker state", () => {
  it("shows only the three primary mode categories", () => {
    expect(resolveComposerPrimaryMode({ interactionMode: "default", workflowPreset: null })).toBe(
      "build",
    );
    expect(resolveComposerPrimaryMode({ interactionMode: "plan", workflowPreset: null })).toBe(
      "plan",
    );
    expect(
      resolveComposerPrimaryMode({ interactionMode: "plan", workflowPreset: "fast-feature" }),
    ).toBe("workflow");
  });

  it("restores selectable presets and does not revive removed legacy workflows", () => {
    expect(
      resolveWorkflowPresetForPicker({
        interactionMode: "default",
        workflowPreset: null,
        lastWorkflowPreset: "fix",
      }),
    ).toBe("full-feature");
    expect(
      resolveWorkflowPresetForPicker({
        interactionMode: "default",
        workflowPreset: null,
        lastWorkflowPreset: "fast-feature",
      }),
    ).toBe("fast-feature");
    // Existing historical threads still render their original identity.
    expect(
      resolveWorkflowPresetForPicker({
        interactionMode: "product-workflow",
        workflowPreset: "fix",
        lastWorkflowPreset: null,
      }),
    ).toBe("fix");
    expect(
      resolveWorkflowPresetForPicker({
        interactionMode: "default",
        workflowPreset: null,
        lastWorkflowPreset: null,
      }),
    ).toBe("full-feature");
  });

  it("sorts Build skills alphabetically with stable ID tie-breaking", () => {
    expect(
      sortComposerBuildSkills([
        { id: "z", title: "TDD", description: "TDD", workflowIds: [] },
        { id: "b", title: "Code Review", description: "Review", workflowIds: [] },
        { id: "a", title: "Code Review", description: "Review", workflowIds: [] },
      ]).map((skill) => skill.id),
    ).toEqual(["a", "b", "z"]);
  });
});

describe("buildComposerModeTriggerDisplay", () => {
  const base = {
    interactionMode: "default" as const,
    workflowPreset: null,
    lastWorkflowPreset: null,
    buildSkills: [{ id: "tdd", title: "TDD", description: "TDD", workflowIds: [] }],
    selectedBuildSkillId: null,
  };

  it("leaves plain Build unlabelled so it costs no room beside the traits", () => {
    const display = buildComposerModeTriggerDisplay(base);
    expect(display.shortLabel).toBeNull();
    expect(display.label).toBe("Build");
  });

  it("names the workflow, the skill and plan mode", () => {
    expect(
      buildComposerModeTriggerDisplay({
        ...base,
        interactionMode: "product-workflow",
        workflowPreset: "wayfinder",
      }),
    ).toMatchObject({ label: "Workflow · Wayfinder", shortLabel: "Wayfinder" });
    expect(buildComposerModeTriggerDisplay({ ...base, selectedBuildSkillId: "tdd" })).toMatchObject(
      { label: "Build · TDD", shortLabel: "TDD" },
    );
    expect(buildComposerModeTriggerDisplay({ ...base, interactionMode: "plan" })).toMatchObject({
      label: "Plan",
      shortLabel: "Plan",
    });
  });

  it("falls back to a generic skill name when the catalog no longer lists it", () => {
    expect(
      buildComposerModeTriggerDisplay({ ...base, selectedBuildSkillId: "removed" }).shortLabel,
    ).toBe("Skill");
  });
});
