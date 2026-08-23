import type { ModelSelection, WorkflowPreset } from "@t3tools/contracts";

import {
  WorkflowModelPinControls,
  type SetWorkflowStepModel,
  type WorkflowModelChoices,
  type WorkflowModelPinKey,
} from "./WorkflowModelPins";
import {
  resolveWorkflowModelQuickActionSelection,
  workflowModelQuickActions,
} from "./workflowModelQuickActions";

export type SetWorkflowStepModels = (
  keys: ReadonlyArray<WorkflowModelPinKey>,
  selection: ModelSelection | null,
) => void;

export function WorkflowModelQuickPins(props: {
  /** Undefined shows standing defaults for every selectable workflow. */
  readonly preset: WorkflowPreset | null | undefined;
  readonly pinFor: (key: WorkflowModelPinKey) => ModelSelection | null;
  /** Effective models after standing defaults and parent-step inheritance. */
  readonly selectionFor?: ((key: WorkflowModelPinKey) => ModelSelection | null) | undefined;
  readonly rootModelSelection: ModelSelection;
  readonly rootLabel: string;
  readonly choices: WorkflowModelChoices;
  readonly onSetStepModels: SetWorkflowStepModels;
}) {
  const actions = workflowModelQuickActions(props.preset);
  if (actions.length === 0) return null;

  return (
    <div className="space-y-3 rounded-lg border border-border/70 bg-muted/20 p-3">
      <div>
        <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          Quick model assignments
        </div>
        <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
          Set common review roles here, or tune them in their chronological steps below.
        </p>
      </div>
      {actions.map((action) => {
        const pinnedState = resolveWorkflowModelQuickActionSelection(action.pinKeys, props.pinFor);
        const effectiveState = resolveWorkflowModelQuickActionSelection(
          action.pinKeys,
          props.selectionFor ?? props.pinFor,
        );
        return (
          <WorkflowModelPinControls
            key={action.id}
            pinKey={action.pinKeys[0]!}
            label={action.label}
            note={action.description}
            pinnedSelection={pinnedState.mixed ? null : pinnedState.selection}
            inheritedSelection={effectiveState.selection ?? props.rootModelSelection}
            inheritedLabel={props.rootLabel}
            mixed={effectiveState.mixed}
            choices={props.choices}
            onSetStepModel={(_key, selection) => props.onSetStepModels(action.pinKeys, selection)}
          />
        );
      })}
    </div>
  );
}

export function setWorkflowStepModelsOneAtATime(
  onSetStepModel: SetWorkflowStepModel,
): SetWorkflowStepModels {
  return (keys, selection) => {
    for (const key of keys) onSetStepModel(key, selection);
  };
}
