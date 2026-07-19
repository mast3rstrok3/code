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

  it("restores the remembered preset and defaults first use to Full feature", () => {
    expect(
      resolveWorkflowPresetForPicker({
        interactionMode: "default",
        workflowPreset: null,
        lastWorkflowPreset: "fix",
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
