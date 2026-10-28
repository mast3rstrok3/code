import type {
  ImplementationWorkflowSettings,
  LaunchableWorkflow,
  ModelSelection,
  WorkflowStepModelOverride,
} from "@t3tools/contracts";
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
  readonly phase: "planning" | "implementation";
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
  preset: "fast-plan" | "planning" = "planning",
): ReadonlyArray<EngineeringWorkflowDefaultStep> {
  const definition = WORKFLOW_PRESET_DEFINITION_BY_ID[preset];
  const planningStepCount = preset === "fast-plan" ? 1 : 5;
  return definition.helpSteps.map((step, index) => {
    const label = withoutPhasePrefix(step.label);
    const phase = index < planningStepCount ? "planning" : "implementation";
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

const LAUNCHABLE_WORKFLOWS: ReadonlyArray<LaunchableWorkflow> = ["feature", "engineering"];

function defaultEntry(
  key: WorkflowModelPinKey,
  workflow: LaunchableWorkflow | null,
  modelSelection: ModelSelection,
): WorkflowStepModelOverride {
  // Optional keys stay absent rather than undefined so the patch encodes as the contract's.
  return {
    workflowPromptId: key.workflowPromptId,
    ...(key.stepWorkflowPromptId === undefined
      ? {}
      : { stepWorkflowPromptId: key.stepWorkflowPromptId }),
    ...(workflow === null ? {} : { workflow }),
    modelSelection,
  };
}

function findDefault(
  defaults: ReadonlyArray<WorkflowStepModelOverride>,
  key: WorkflowModelPinKey,
  workflow: LaunchableWorkflow | null,
): WorkflowStepModelOverride | undefined {
  return defaults.find(
    (entry) => workflowStepModelPinKeysEqual(entry, key) && (entry.workflow ?? null) === workflow,
  );
}

/**
 * The standing default one workflow's step runs on: its own, else the unscoped
 * one settings stored before workflows had their own, which the server still
 * honours. Null with `workflow` null reads only unscoped defaults.
 */
export function standingWorkflowStepModel(
  defaults: ReadonlyArray<WorkflowStepModelOverride>,
  key: WorkflowModelPinKey,
  workflow: LaunchableWorkflow | null,
): ModelSelection | null {
  return (
    (workflow === null ? undefined : findDefault(defaults, key, workflow))?.modelSelection ??
    findDefault(defaults, key, null)?.modelSelection ??
    null
  );
}

/**
 * The default pins after setting or clearing one workflow's pin.
 *
 * An unscoped default that the change would otherwise leave shadowing this
 * workflow is split into one default per other workflow first, so clearing a
 * pin really clears it here while the other workflow keeps the model it had.
 */
export function setWorkflowStepModelDefault(
  defaults: ReadonlyArray<WorkflowStepModelOverride>,
  key: WorkflowModelPinKey,
  selection: ModelSelection | null,
  workflow: LaunchableWorkflow | null = null,
): ReadonlyArray<WorkflowStepModelOverride> {
  const legacy = workflow === null ? undefined : findDefault(defaults, key, null);
  const inherited =
    legacy === undefined
      ? []
      : LAUNCHABLE_WORKFLOWS.filter(
          (other) => other !== workflow && findDefault(defaults, key, other) === undefined,
        ).map((other) => defaultEntry(key, other, legacy.modelSelection));
  const others = defaults.filter(
    (entry) =>
      !workflowStepModelPinKeysEqual(entry, key) ||
      ((entry.workflow ?? null) !== workflow && entry !== legacy),
  );
  return [
    ...others,
    ...inherited,
    ...(selection === null ? [] : [defaultEntry(key, workflow, selection)]),
  ];
}

export function setWorkflowStepModelDefaults(
  defaults: ReadonlyArray<WorkflowStepModelOverride>,
  keys: ReadonlyArray<WorkflowModelPinKey>,
  selection: ModelSelection | null,
  workflow: LaunchableWorkflow | null = null,
): ReadonlyArray<WorkflowStepModelOverride> {
  return keys.reduce(
    (current, key) => setWorkflowStepModelDefault(current, key, selection, workflow),
    defaults,
  );
}
