import type { ModelSelection, WorkflowPreset } from "@t3tools/contracts";
import {
  WORKFLOW_PRESET_DEFINITION_BY_ID,
  WORKFLOW_PRESET_DEFINITIONS,
  type WorkflowPresetDefinition,
} from "@t3tools/shared/workflowPresets";

import type { WorkflowModelPinKey } from "./WorkflowModelPins";

const APP_REVIEW_PROMPT_ID = "implementation.browser-app-review.codex";
const CODE_REVIEW_PROMPT_ID = "implementation.code-review.codex";
const TICKET_WAVE_PROMPT_ID = "implementation.tdd.codex";

export interface WorkflowModelQuickAction {
  readonly id: "e2e-browser-review" | "ticket-code-review" | "final-code-review";
  readonly label: string;
  readonly description: string;
  readonly pinKeys: ReadonlyArray<WorkflowModelPinKey>;
}

const QUICK_ACTION_DEFINITIONS = [
  {
    id: "e2e-browser-review",
    label: "E2E tests and browser review",
    description: "Set the expensive review thread for ticket and combined App Reviews.",
    workflowPromptId: APP_REVIEW_PROMPT_ID,
    matches: (key: WorkflowModelPinKey) =>
      key.stepWorkflowPromptId === TICKET_WAVE_PROMPT_ID ||
      key.stepWorkflowPromptId === APP_REVIEW_PROMPT_ID,
  },
  {
    id: "ticket-code-review",
    label: "Ticket Code Review",
    description: "Set the model that reviews each ticket after its implementation and App Review.",
    workflowPromptId: CODE_REVIEW_PROMPT_ID,
    matches: (key: WorkflowModelPinKey) => key.stepWorkflowPromptId === "implementation.tdd.codex",
  },
  {
    id: "final-code-review",
    label: "Final Code Review",
    description: "Set the model for final validation, pull request creation, and green checks.",
    workflowPromptId: CODE_REVIEW_PROMPT_ID,
    matches: (key: WorkflowModelPinKey) => key.stepWorkflowPromptId === undefined,
  },
] as const;

function pinKeyId(key: WorkflowModelPinKey): string {
  return `${key.stepWorkflowPromptId ?? ""}\u0000${key.workflowPromptId}`;
}

function pinKeysForPrompt(
  definitions: ReadonlyArray<WorkflowPresetDefinition>,
  workflowPromptId: string,
): ReadonlyArray<WorkflowModelPinKey> {
  const byId = new Map<string, WorkflowModelPinKey>();
  for (const definition of definitions) {
    for (const step of definition.helpSteps) {
      if (step.skillId === workflowPromptId) {
        const key = { workflowPromptId };
        byId.set(pinKeyId(key), key);
      }
      if (step.skillId === undefined) continue;
      for (const subStep of step.subSteps ?? []) {
        if (subStep.workflowPromptId !== workflowPromptId) continue;
        const key = {
          workflowPromptId,
          stepWorkflowPromptId: step.skillId,
        };
        byId.set(pinKeyId(key), key);
      }
    }
  }
  return [...byId.values()];
}

/** Review roles that users commonly pin to one model across a whole workflow. */
export function workflowModelQuickActions(
  preset: WorkflowPreset | null | undefined,
): ReadonlyArray<WorkflowModelQuickAction> {
  const definitions =
    preset === undefined
      ? WORKFLOW_PRESET_DEFINITIONS
      : preset === null
        ? []
        : [WORKFLOW_PRESET_DEFINITION_BY_ID[preset]];
  return QUICK_ACTION_DEFINITIONS.flatMap((action) => {
    const pinKeys = pinKeysForPrompt(definitions, action.workflowPromptId).filter(action.matches);
    return pinKeys.length === 0 ? [] : [{ ...action, pinKeys }];
  });
}

export function resolveWorkflowModelQuickActionSelection(
  pinKeys: ReadonlyArray<WorkflowModelPinKey>,
  pinFor: (key: WorkflowModelPinKey) => ModelSelection | null,
): { readonly selection: ModelSelection | null; readonly mixed: boolean } {
  const selections = pinKeys.map(pinFor);
  const first = selections[0] ?? null;
  if (selections.every((selection) => selection === null)) {
    return { selection: null, mixed: false };
  }
  if (
    first === null ||
    selections.some(
      (selection) =>
        selection === null ||
        selection.instanceId !== first.instanceId ||
        selection.model !== first.model,
    )
  ) {
    return { selection: null, mixed: true };
  }
  return { selection: first, mixed: false };
}
