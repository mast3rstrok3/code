import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  describeComposerMode,
  isPlanningWorkflowAvailableForProvider,
  resolveComposerInteractionModeForProvider,
  resolveComposerPrimaryMode,
  resolveWorkflowPresetForPicker,
  sortComposerBuildSkills,
} from "./workflowComposerMode.ts";

describe("composer planning workflow provider gate", () => {
  it("allows Planning Workflow for Codex providers", () => {
    const provider = ProviderDriverKind.make("codex");

    expect(isPlanningWorkflowAvailableForProvider(provider)).toBe(true);
    expect(
      resolveComposerInteractionModeForProvider({
        interactionMode: "planning-workflow",
        provider,
      }),
    ).toBe("planning-workflow");
  });

  it("allows Implementation Workflow for Codex providers", () => {
    const provider = ProviderDriverKind.make("codex");

    expect(
      resolveComposerInteractionModeForProvider({
        interactionMode: "implementation-workflow",
        provider,
      }),
    ).toBe("implementation-workflow");
  });

  it("allows Planning Workflow and Product Workflow for Claude providers", () => {
    const provider = ProviderDriverKind.make("claudeAgent");

    expect(isPlanningWorkflowAvailableForProvider(provider)).toBe(true);
    expect(
      resolveComposerInteractionModeForProvider({
        interactionMode: "planning-workflow",
        provider,
      }),
    ).toBe("planning-workflow");
    expect(
      resolveComposerInteractionModeForProvider({
        interactionMode: "product-workflow",
        provider,
      }),
    ).toBe("product-workflow");
  });

  it("allows workflow modes for OpenCode providers", () => {
    const provider = ProviderDriverKind.make("opencode");

    expect(isPlanningWorkflowAvailableForProvider(provider)).toBe(true);
    for (const interactionMode of [
      "planning-workflow",
      "product-workflow",
      "implementation-workflow",
    ] as const) {
      expect(resolveComposerInteractionModeForProvider({ interactionMode, provider })).toBe(
        interactionMode,
      );
    }
  });

  it("downgrades Planning Workflow to Build for unsupported providers", () => {
    const provider = ProviderDriverKind.make("cursor");

    expect(isPlanningWorkflowAvailableForProvider(provider)).toBe(false);
    expect(
      resolveComposerInteractionModeForProvider({
        interactionMode: "planning-workflow",
        provider,
      }),
    ).toBe("default");
  });

  it("downgrades Implementation Workflow to Build for unsupported providers", () => {
    const provider = ProviderDriverKind.make("cursor");

    expect(
      resolveComposerInteractionModeForProvider({
        interactionMode: "implementation-workflow",
        provider,
      }),
    ).toBe("default");
  });

  it("leaves existing Build and Plan modes unchanged", () => {
    const provider = ProviderDriverKind.make("cursor");

    expect(
      resolveComposerInteractionModeForProvider({ interactionMode: "default", provider }),
    ).toBe("default");
    expect(resolveComposerInteractionModeForProvider({ interactionMode: "plan", provider })).toBe(
      "plan",
    );
  });
});

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
    ).toBe("fast-plan");
    expect(
      resolveWorkflowPresetForPicker({
        interactionMode: "default",
        workflowPreset: null,
        lastWorkflowPreset: "fast-feature",
      }),
    ).toBe("fast-plan");
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
    ).toBe("fast-plan");
  });

  it("sorts Build skills alphabetically with stable ID tie-breaking", () => {
    expect(
      sortComposerBuildSkills([
        { id: "z", title: "TDD", description: "TDD", promptText: "TDD", workflowIds: [] },
        {
          id: "b",
          title: "Code Review",
          description: "Review",
          promptText: "Review",
          workflowIds: [],
        },
        {
          id: "a",
          title: "Code Review",
          description: "Review",
          promptText: "Review",
          workflowIds: [],
        },
      ]).map((skill) => skill.id),
    ).toEqual(["a", "b", "z"]);
  });
});

describe("describeComposerMode", () => {
  const base = {
    interactionMode: "default" as const,
    workflowPreset: null,
    lastWorkflowPreset: null,
    buildSkills: [
      { id: "tdd", title: "TDD", description: "TDD", promptText: "TDD", workflowIds: [] },
    ],
    selectedBuildSkillId: null,
  };

  it("leaves plain Build unlabelled so it costs no room beside the traits", () => {
    const display = describeComposerMode(base);
    expect(display.shortLabel).toBeNull();
    expect(display.label).toBe("Build");
  });

  it("names the workflow, the skill and plan mode", () => {
    expect(
      describeComposerMode({
        ...base,
        interactionMode: "product-workflow",
        workflowPreset: "wayfinder",
      }),
    ).toMatchObject({ label: "Workflow · Wayfinder", shortLabel: "Wayfinder" });
    expect(describeComposerMode({ ...base, selectedBuildSkillId: "tdd" })).toMatchObject({
      label: "Build · TDD",
      shortLabel: "TDD",
    });
    expect(describeComposerMode({ ...base, interactionMode: "plan" })).toMatchObject({
      label: "Plan",
      shortLabel: "Plan",
    });
  });

  it("falls back to a generic skill name when the catalog no longer lists it", () => {
    expect(describeComposerMode({ ...base, selectedBuildSkillId: "removed" }).shortLabel).toBe(
      "Skill",
    );
  });
});
