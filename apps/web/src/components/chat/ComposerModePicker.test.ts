import { describe, expect, it } from "vite-plus/test";
import { resolveComposerPrimaryMode, resolveWorkflowPresetForPicker } from "./ComposerModePicker";

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
});
