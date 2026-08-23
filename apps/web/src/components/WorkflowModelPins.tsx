import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ModelSelection, ProviderInstanceId } from "@t3tools/contracts";
import type { WorkflowPresetSubStep } from "@t3tools/shared/workflowPresets";
import { createModelSelection } from "@t3tools/shared/model";
import { useMemo } from "react";

import { cn } from "~/lib/utils";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../providerInstances";
import { getCustomModelOptionsByInstance } from "../modelSelection";
import { primaryServerProvidersAtom, serverEnvironment } from "../state/server";
import { useEnvironmentSettings } from "../hooks/useSettings";
import { ProviderModelPicker } from "./chat/ProviderModelPicker";
import { getTriggerDisplayModelName } from "./chat/providerIconUtils";

/**
 * A pin is identified by the step it belongs to and, for a sub-step, the agent
 * within it. `stepWorkflowPromptId` is undefined for a step's own pin.
 */
export interface WorkflowModelPinKey {
  readonly workflowPromptId: string;
  readonly stepWorkflowPromptId?: string | undefined;
}

export type SetWorkflowStepModel = (
  key: WorkflowModelPinKey,
  selection: ModelSelection | null,
) => void;

export function workflowModelPinKey(key: WorkflowModelPinKey): string {
  // NUL separates the two ids so no prompt id can forge another pair's key.
  return `${key.stepWorkflowPromptId ?? ""}\u0000${key.workflowPromptId}`;
}

/**
 * Providers and models the workflow's own environment can offer.
 *
 * A workflow may live in a non-primary environment, so its providers and
 * settings — not the primary server's — decide what can be pinned. Callers
 * subscribe only while a menu is open: a workflow renders a row per stage and
 * none of them should carry a picker's state until it is asked for.
 */
export function useWorkflowModelChoices(environmentId: EnvironmentId) {
  const environmentConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const primaryProviders = useAtomValue(primaryServerProvidersAtom);
  const providers = environmentConfig?.providers ?? primaryProviders;
  const settings = useEnvironmentSettings(environmentId);

  const instanceEntries = useMemo(
    () =>
      sortProviderInstanceEntries(
        applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
      ),
    [providers, settings],
  );
  const modelOptionsByInstance = useMemo(
    () => getCustomModelOptionsByInstance(settings, providers),
    [providers, settings],
  );

  const describeSelection = (selection: ModelSelection): string => {
    const option = modelOptionsByInstance
      .get(selection.instanceId)
      ?.find((candidate) => candidate.slug === selection.model);
    const modelName = option ? getTriggerDisplayModelName(option) : selection.model;
    const instanceName = instanceEntries.find(
      (entry) => entry.instanceId === selection.instanceId,
    )?.displayName;
    return instanceName === undefined ? modelName : `${instanceName} · ${modelName}`;
  };

  return { instanceEntries, modelOptionsByInstance, describeSelection };
}

export type WorkflowModelChoices = ReturnType<typeof useWorkflowModelChoices>;

/**
 * Auto/Custom for one pin.
 *
 * Auto is not "no model" — it is whatever the pin above this one resolves to,
 * which `inheritedLabel` names so the choice is never a guess.
 */
export function WorkflowModelPinControls(props: {
  readonly pinKey: WorkflowModelPinKey;
  readonly label: string;
  readonly note?: string | undefined;
  readonly pinnedSelection: ModelSelection | null;
  readonly inheritedSelection: ModelSelection;
  readonly inheritedLabel: string;
  readonly choices: WorkflowModelChoices;
  readonly onSetStepModel: SetWorkflowStepModel;
  readonly indented?: boolean;
  /** True when a role-level control represents several pins with different values. */
  readonly mixed?: boolean;
}) {
  const active = props.pinnedSelection ?? props.inheritedSelection;
  return (
    <div className={cn("space-y-1.5", props.indented && "border-l border-border/70 pl-2")}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-xs font-medium text-foreground">{props.label}</span>
        <button
          type="button"
          onClick={() =>
            props.onSetStepModel(
              props.pinKey,
              props.pinnedSelection === null
                ? createModelSelection(
                    props.inheritedSelection.instanceId,
                    props.inheritedSelection.model,
                  )
                : null,
            )
          }
          className="cursor-pointer shrink-0 text-[10px] font-medium uppercase tracking-wider text-muted-foreground hover:text-foreground"
        >
          {props.mixed ? "Set all" : props.pinnedSelection === null ? "Set" : "Auto"}
        </button>
      </div>
      {props.pinnedSelection === null ? (
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {props.mixed ? "Models differ by step" : props.inheritedLabel}
          {props.note === undefined ? "" : ` · ${props.note}`}
        </p>
      ) : (
        <>
          <ProviderModelPicker
            activeInstanceId={active.instanceId}
            model={active.model}
            lockedProvider={null}
            instanceEntries={props.choices.instanceEntries}
            modelOptionsByInstance={props.choices.modelOptionsByInstance}
            triggerVariant="outline"
            triggerClassName="w-full justify-between text-foreground/90 hover:text-foreground"
            triggerAriaLabel={`Model for ${props.label}`}
            onInstanceModelChange={(instanceId: ProviderInstanceId, model: string) => {
              props.onSetStepModel(props.pinKey, createModelSelection(instanceId, model));
            }}
          />
          {props.note === undefined ? null : (
            <p className="text-[11px] leading-relaxed text-muted-foreground">{props.note}</p>
          )}
        </>
      )}
    </div>
  );
}

/**
 * One step's pin plus a pin for each agent the step starts.
 *
 * Sub-steps default to the step's own choice, so pinning the step moves the
 * whole step and a sub-step pin is only needed where one agent should differ.
 */
export function WorkflowStepModelPins(props: {
  readonly stepLabel: string;
  readonly workflowPromptId: string;
  readonly subSteps: ReadonlyArray<WorkflowPresetSubStep>;
  readonly pinFor: (key: WorkflowModelPinKey) => ModelSelection | null;
  readonly rootModelSelection: ModelSelection;
  /**
   * What an unpinned step falls back to. Defaults to naming the running
   * workflow's own model; Settings pins have no run yet, so they name the
   * model each future run brings instead.
   */
  readonly rootLabel?: string | undefined;
  readonly choices: WorkflowModelChoices;
  readonly onSetStepModel: SetWorkflowStepModel;
}) {
  const stepKey: WorkflowModelPinKey = { workflowPromptId: props.workflowPromptId };
  const stepPin = props.pinFor(stepKey);
  const stepSelection = stepPin ?? props.rootModelSelection;
  return (
    <div className="space-y-2">
      <WorkflowModelPinControls
        pinKey={stepKey}
        label={props.subSteps.length === 0 ? props.stepLabel : `${props.stepLabel} — whole step`}
        pinnedSelection={stepPin}
        inheritedSelection={props.rootModelSelection}
        inheritedLabel={
          props.rootLabel ??
          `Workflow model (${props.choices.describeSelection(props.rootModelSelection)})`
        }
        choices={props.choices}
        onSetStepModel={props.onSetStepModel}
      />
      {props.subSteps.map((subStep) => {
        const key: WorkflowModelPinKey = {
          workflowPromptId: subStep.workflowPromptId,
          stepWorkflowPromptId: props.workflowPromptId,
        };
        return (
          <WorkflowModelPinControls
            key={workflowModelPinKey(key)}
            pinKey={key}
            label={subStep.label}
            note={subStep.note}
            pinnedSelection={props.pinFor(key)}
            inheritedSelection={stepSelection}
            inheritedLabel={`Follows this step (${props.choices.describeSelection(stepSelection)})`}
            choices={props.choices}
            onSetStepModel={props.onSetStepModel}
            indented
          />
        );
      })}
    </div>
  );
}
