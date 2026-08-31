import type { ImplementationWorkflowSettings, ModelSelection } from "@t3tools/contracts";
import type { WorkflowStepModelOverride } from "@t3tools/contracts";
import {
  WORKFLOW_PRESET_DEFINITION_BY_ID,
  type WorkflowPresetSubStep,
  workflowPresetStepCanPinModel,
} from "@t3tools/shared/workflowPresets";

import type { WorkflowModelPinKey } from "../WorkflowModelPins";

/**
 * One ordered step in the Engineering Workflow settings view.
 */
export interface EngineeringWorkflowDefaultStep {
  readonly number: number;
  readonly phase: "planning" | "ticket-review" | "implementation";
  readonly label: string;
  readonly note?: string | undefined;
  readonly modelMode: "none" | "workflow" | "configurable";
  readonly workflowPromptId?: string | undefined;
  readonly subSteps: ReadonlyArray<WorkflowPresetSubStep>;
}

export type SkippableImplementationSetting = keyof Pick<
  ImplementationWorkflowSettings,
  | "appReviewEnabled"
  | "finalCodeReviewEnabled"
  | "pullRequestCreationEnabled"
  | "pullRequestBabysittingEnabled"
>;

export function skippableImplementationSettingForStep(
  step: EngineeringWorkflowDefaultStep,
): SkippableImplementationSetting | null {
  switch (step.label) {
    case "App Review":
    case "Run App Review":
    case "Final App Review":
      return "appReviewEnabled";
    case "Final Code Review":
      return "finalCodeReviewEnabled";
    case "Create pull request":
      return "pullRequestCreationEnabled";
    case "Babysit pull request":
      return "pullRequestBabysittingEnabled";
    default:
      return null;
  }
}

/** "Planning phase · Spec authoring" reads as "Spec authoring" outside a run. */
function withoutPhasePrefix(label: string): string {
  const separator = label.indexOf(" · ");
  return separator === -1 ? label : label.slice(separator + 3);
}

export function engineeringWorkflowDefaultSteps(
  preset: "planning" | "fast-engineering" = "planning",
): ReadonlyArray<EngineeringWorkflowDefaultStep> {
  const definition = WORKFLOW_PRESET_DEFINITION_BY_ID[preset];
  return definition.helpSteps.map((step, index) => {
    const label = withoutPhasePrefix(step.label);
    const phase = index < 4 ? "planning" : index === 4 ? "ticket-review" : "implementation";
    const configurable = workflowPresetStepCanPinModel(definition.id, step);
    return {
      number: index + 1,
      phase,
      label,
      ...(step.note === undefined ? {} : { note: step.note }),
      modelMode: configurable ? "configurable" : step.skillId === undefined ? "none" : "workflow",
      ...(configurable ? { workflowPromptId: step.skillId } : {}),
      subSteps: step.subSteps ?? [],
    };
  });
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
