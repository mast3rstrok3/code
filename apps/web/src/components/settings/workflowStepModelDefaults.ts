import type { ModelSelection } from "@t3tools/contracts";
import type { WorkflowStepModelOverride } from "@t3tools/contracts";
import {
  WORKFLOW_PRESET_DEFINITIONS,
  type WorkflowPresetSubStep,
  workflowPresetStepCanPinModel,
} from "@t3tools/shared/workflowPresets";

import type { WorkflowModelPinKey } from "../WorkflowModelPins";

/**
 * One step a default model can be set for, plus the agents it starts.
 *
 * Defaults are keyed by prompt id alone, so the same step shared by several
 * workflows is one entry here — setting "App Review" once covers every
 * workflow that runs it.
 */
export interface WorkflowStepModelDefaultTarget {
  readonly label: string;
  readonly workflowPromptId: string;
  readonly subSteps: ReadonlyArray<WorkflowPresetSubStep>;
}

/** "Planning phase · Spec authoring" reads as "Spec authoring" outside a run. */
function withoutPhasePrefix(label: string): string {
  const separator = label.indexOf(" · ");
  return separator === -1 ? label : label.slice(separator + 3);
}

export function workflowStepModelDefaultTargets(): ReadonlyArray<WorkflowStepModelDefaultTarget> {
  const byPromptId = new Map<
    string,
    { label: string; subSteps: Map<string, WorkflowPresetSubStep> }
  >();
  for (const definition of WORKFLOW_PRESET_DEFINITIONS) {
    for (const step of definition.helpSteps) {
      if (!workflowPresetStepCanPinModel(definition.id, step)) continue;
      const entry = byPromptId.get(step.skillId) ?? {
        label: withoutPhasePrefix(step.label),
        subSteps: new Map<string, WorkflowPresetSubStep>(),
      };
      for (const subStep of step.subSteps ?? []) {
        if (!entry.subSteps.has(subStep.workflowPromptId)) {
          entry.subSteps.set(subStep.workflowPromptId, subStep);
        }
      }
      byPromptId.set(step.skillId, entry);
    }
  }
  return [...byPromptId.entries()].map(([workflowPromptId, entry]) => ({
    label: entry.label,
    workflowPromptId,
    subSteps: [...entry.subSteps.values()],
  }));
}

export function workflowStepModelPinKeysEqual(
  left: WorkflowModelPinKey,
  right: WorkflowModelPinKey,
): boolean {
  return (
    left.workflowPromptId === right.workflowPromptId &&
    (left.stepWorkflowPromptId ?? null) === (right.stepWorkflowPromptId ?? null)
  );
}

/**
 * The default pins after setting or clearing one of them.
 *
 * `stepWorkflowPromptId` stays absent rather than explicitly undefined so the
 * settings patch encodes as the contract's optional key.
 */
export function setWorkflowStepModelDefault(
  defaults: ReadonlyArray<WorkflowStepModelOverride>,
  key: WorkflowModelPinKey,
  selection: ModelSelection | null,
): ReadonlyArray<WorkflowStepModelOverride> {
  const others = defaults.filter((entry) => !workflowStepModelPinKeysEqual(entry, key));
  if (selection === null) return others;
  return [
    ...others,
    {
      workflowPromptId: key.workflowPromptId,
      ...(key.stepWorkflowPromptId === undefined
        ? {}
        : { stepWorkflowPromptId: key.stepWorkflowPromptId }),
      modelSelection: selection,
    },
  ];
}

export function setWorkflowStepModelDefaults(
  defaults: ReadonlyArray<WorkflowStepModelOverride>,
  keys: ReadonlyArray<WorkflowModelPinKey>,
  selection: ModelSelection | null,
): ReadonlyArray<WorkflowStepModelOverride> {
  return keys.reduce(
    (current, key) => setWorkflowStepModelDefault(current, key, selection),
    defaults,
  );
}
