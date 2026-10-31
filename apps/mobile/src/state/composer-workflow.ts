import type {
  ImplementationWorkflowSettings,
  ProviderDriverKind,
  ProviderInteractionMode,
  WorkflowPreset,
} from "@t3tools/contracts";
import {
  isPlanningWorkflowAvailableForProvider,
  resolveComposerPrimaryMode,
} from "@t3tools/client-runtime/workflow-composer-mode";
import {
  implementationDefaultsForWorkflowPreset,
  WORKFLOW_PRESET_DEFINITION_BY_ID,
} from "@t3tools/shared/workflowPresets";

/**
 * The workflow the next turn starts. Absent means the thread's own preset
 * applies; a null `preset` means the user chose Build or Plan instead.
 */
export interface ComposerDraftWorkflow {
  readonly preset: WorkflowPreset | null;
  readonly lastPreset: WorkflowPreset | null;
  readonly implementationSettings: ImplementationWorkflowSettings | null;
}

/** What the composer's mode control changes when the user picks an entry. */
export type ComposerModeChoice =
  | { readonly kind: "build" }
  | { readonly kind: "plan" }
  | { readonly kind: "workflow"; readonly preset: WorkflowPreset };

/** The fields a turn needs to start, keep, or leave a workflow; the web composer sends the same. */
export interface ComposerWorkflowSend {
  readonly workflowPreset: WorkflowPreset | null;
  readonly workflowPromptId: string | null;
  readonly workflowImplementationSettings: ImplementationWorkflowSettings;
  readonly clearWorkflowMode: boolean;
}

/** The preset the next turn runs: the draft's choice, else the thread's own. */
export function resolveComposerWorkflowPreset(input: {
  readonly draftWorkflow: ComposerDraftWorkflow | undefined;
  readonly threadPreset: WorkflowPreset | null | undefined;
}): WorkflowPreset | null {
  return input.draftWorkflow === undefined
    ? (input.threadPreset ?? null)
    : input.draftWorkflow.preset;
}

/** The draft workflow after choosing Build or Plan, remembering the preset it left. */
export function leaveComposerWorkflow(input: {
  readonly current: ComposerDraftWorkflow | undefined;
  readonly threadPreset: WorkflowPreset | null | undefined;
}): ComposerDraftWorkflow {
  return {
    preset: null,
    lastPreset:
      input.current?.lastPreset ??
      resolveComposerWorkflowPreset({
        draftWorkflow: input.current,
        threadPreset: input.threadPreset,
      }),
    implementationSettings: null,
  };
}

/** The draft settings a mode choice writes. */
export function applyComposerModeChoice(input: {
  readonly choice: ComposerModeChoice;
  readonly current: ComposerDraftWorkflow | undefined;
  readonly threadPreset: WorkflowPreset | null | undefined;
  readonly standingImplementation: ImplementationWorkflowSettings;
}): {
  readonly interactionMode: ProviderInteractionMode;
  readonly workflow: ComposerDraftWorkflow;
} {
  if (input.choice.kind !== "workflow") {
    return {
      interactionMode: input.choice.kind === "plan" ? "plan" : "default",
      workflow: leaveComposerWorkflow(input),
    };
  }
  const preset = input.choice.preset;
  return {
    interactionMode: WORKFLOW_PRESET_DEFINITION_BY_ID[preset].interactionMode,
    workflow: {
      preset,
      lastPreset: preset,
      // Matches the web catalog's "Use preset": standing settings, then the preset's own.
      implementationSettings: {
        ...input.standingImplementation,
        ...implementationDefaultsForWorkflowPreset(preset),
      },
    },
  };
}

export function resolveComposerWorkflowSend(input: {
  readonly draftWorkflow: ComposerDraftWorkflow | undefined;
  readonly threadPreset: WorkflowPreset | null | undefined;
  readonly provider: ProviderDriverKind | null | undefined;
  readonly standingImplementation: ImplementationWorkflowSettings;
}): ComposerWorkflowSend {
  const workflowPreset = resolveComposerWorkflowPreset(input);
  const workflowAvailable = isPlanningWorkflowAvailableForProvider(input.provider);
  return {
    workflowPreset,
    workflowPromptId:
      workflowAvailable && workflowPreset !== null
        ? (WORKFLOW_PRESET_DEFINITION_BY_ID[workflowPreset].workflowPromptId ?? null)
        : null,
    workflowImplementationSettings:
      input.draftWorkflow?.implementationSettings ??
      implementationDefaultsForWorkflowPreset(workflowPreset ?? "fast-plan") ??
      input.standingImplementation,
    clearWorkflowMode: (input.threadPreset ?? null) !== null && workflowPreset === null,
  };
}

/** The send fields worth storing: a plain turn on a plain thread carries none. */
export function composerWorkflowSendForQueue(
  send: ComposerWorkflowSend,
): ComposerWorkflowSend | undefined {
  return send.workflowPreset === null && send.workflowPromptId === null && !send.clearWorkflowMode
    ? undefined
    : send;
}

/** The draft choice a queued message restores when it bounces back into the composer. */
export function draftWorkflowFromQueued(send: ComposerWorkflowSend): ComposerDraftWorkflow {
  return {
    preset: send.workflowPreset,
    lastPreset: send.workflowPreset,
    implementationSettings:
      send.workflowPreset === null ? null : send.workflowImplementationSettings,
  };
}

export function composerModeChoiceFor(input: {
  readonly interactionMode: ProviderInteractionMode;
  readonly workflowPreset: WorkflowPreset | null;
}): ComposerModeChoice {
  const mode = resolveComposerPrimaryMode(input);
  if (mode === "workflow" && input.workflowPreset !== null) {
    return { kind: "workflow", preset: input.workflowPreset };
  }
  return mode === "plan" ? { kind: "plan" } : { kind: "build" };
}
