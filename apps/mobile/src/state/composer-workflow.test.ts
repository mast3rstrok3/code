import { describe, expect, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, ProviderDriverKind } from "@t3tools/contracts";

import {
  applyComposerModeChoice,
  composerWorkflowSendForQueue,
  draftWorkflowFromQueued,
  resolveComposerWorkflowSend,
} from "./composer-workflow";

const codex = ProviderDriverKind.make("codex");
const cursor = ProviderDriverKind.make("cursor");
const standing = { ...DEFAULT_SERVER_SETTINGS.implementation, maxParallelTickets: 2 };

describe("applyComposerModeChoice", () => {
  it("starts a preset in its own interaction mode with the standing settings underneath", () => {
    const next = applyComposerModeChoice({
      choice: { kind: "workflow", preset: "planning" },
      current: undefined,
      threadPreset: null,
      standingImplementation: standing,
    });
    expect(next.interactionMode).toBe("planning-workflow");
    expect(next.workflow.preset).toBe("planning");
    expect(next.workflow.lastPreset).toBe("planning");
    expect(next.workflow.implementationSettings?.maxParallelTickets).toBe(2);
  });

  it("leaves a thread's workflow for Plan and remembers the preset it left", () => {
    const next = applyComposerModeChoice({
      choice: { kind: "plan" },
      current: undefined,
      threadPreset: "fast-plan",
      standingImplementation: standing,
    });
    expect(next).toEqual({
      interactionMode: "plan",
      workflow: { preset: null, lastPreset: "fast-plan", implementationSettings: null },
    });
  });
});

describe("resolveComposerWorkflowSend", () => {
  it("keeps the thread's preset on follow-ups when the draft chose nothing", () => {
    const send = resolveComposerWorkflowSend({
      draftWorkflow: undefined,
      threadPreset: "fast-plan",
      provider: codex,
      standingImplementation: standing,
    });
    expect(send.workflowPreset).toBe("fast-plan");
    expect(send.workflowPromptId).toBe("planning.fast-feature.codex");
    expect(send.clearWorkflowMode).toBe(false);
  });

  it("clears the thread's workflow when the draft chose Build", () => {
    const send = resolveComposerWorkflowSend({
      draftWorkflow: { preset: null, lastPreset: "fast-plan", implementationSettings: null },
      threadPreset: "fast-plan",
      provider: codex,
      standingImplementation: standing,
    });
    expect(send).toMatchObject({
      workflowPreset: null,
      workflowPromptId: null,
      clearWorkflowMode: true,
    });
  });

  it("sends no workflow prompt for a provider without workflows", () => {
    const send = resolveComposerWorkflowSend({
      draftWorkflow: undefined,
      threadPreset: "planning",
      provider: cursor,
      standingImplementation: standing,
    });
    expect(send.workflowPromptId).toBeNull();
  });

  it("stores nothing for a plain turn on a plain thread", () => {
    const send = resolveComposerWorkflowSend({
      draftWorkflow: undefined,
      threadPreset: null,
      provider: codex,
      standingImplementation: standing,
    });
    expect(composerWorkflowSendForQueue(send)).toBeUndefined();
  });
});

describe("draftWorkflowFromQueued", () => {
  it("restores the queued choice into the draft", () => {
    const send = resolveComposerWorkflowSend({
      draftWorkflow: {
        preset: "planning",
        lastPreset: "planning",
        implementationSettings: standing,
      },
      threadPreset: null,
      provider: codex,
      standingImplementation: DEFAULT_SERVER_SETTINGS.implementation,
    });
    expect(draftWorkflowFromQueued(send)).toEqual({
      preset: "planning",
      lastPreset: "planning",
      implementationSettings: standing,
    });
  });
});
