import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind } from "@t3tools/contracts";

import {
  isPlanningWorkflowAvailableForProvider,
  resolveComposerInteractionModeForProvider,
} from "./composerPlanningWorkflow";

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

  it("allows Planning and YOLO Workflows for Claude providers", () => {
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
        interactionMode: "yolo-workflow",
        provider,
      }),
    ).toBe("yolo-workflow");
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
