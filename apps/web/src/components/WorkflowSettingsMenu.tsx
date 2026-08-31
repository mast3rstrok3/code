import type {
  EnvironmentId,
  ImplementationWorkflowSettings,
  ModelSelection,
  WorkflowPreset,
  WorkflowStepCycleOverride,
  WorkflowStepModelOverride,
  WorkflowStepReviewPartsOverride,
} from "@t3tools/contracts";
import { WORKFLOW_RECOVERY_FALLBACK_MODEL_PIN } from "@t3tools/contracts";
import {
  WORKFLOW_PRESET_DEFINITION_BY_ID,
  type WorkflowPresetHelpStep,
  workflowPresetStepCanPinModel,
} from "@t3tools/shared/workflowPresets";
import { SlidersHorizontal } from "lucide-react";
import { useState } from "react";

import { Popover, PopoverPopup, PopoverTrigger } from "./ui/popover";
import { ScrollArea } from "~/components/ui/scroll-area";
import { EngineeringWorkflowSettings } from "./EngineeringWorkflowSettings";
import { Switch } from "./ui/switch";
import { WorkflowStepCyclePins, type SetWorkflowStepCycles } from "./WorkflowStepCycles";
import {
  WorkflowStepReviewPartPins,
  type SetWorkflowStepReviewParts,
} from "./WorkflowStepReviewParts";
import {
  useWorkflowModelChoices,
  workflowModelPinKey,
  WorkflowModelPinControls,
  WorkflowStepModelPins,
  type SetWorkflowStepModel,
  type WorkflowModelPinKey,
} from "./WorkflowModelPins";
import {
  setWorkflowStepModelsOneAtATime,
  WorkflowModelQuickPins,
  type SetWorkflowStepModels,
} from "./WorkflowModelQuickPins";

/** Steps that start an agent of their own — the rest have nothing to set. */
function pinnableSteps(preset: WorkflowPreset | null): ReadonlyArray<WorkflowPresetHelpStep> {
  if (preset === null) return [];
  return (WORKFLOW_PRESET_DEFINITION_BY_ID[preset]?.helpSteps ?? []).filter((step) =>
    workflowPresetStepCanPinModel(preset, step),
  );
}

function PlanWorkflowStageControls(props: {
  readonly settings: ImplementationWorkflowSettings;
  readonly onChange: (settings: ImplementationWorkflowSettings) => void;
}) {
  const entries = [
    ["Ticket App Review", "ticketAppReviewEnabled"],
    ["Final App Review", "appReviewEnabled"],
    ["Final Code Review", "finalCodeReviewEnabled"],
    ["Create pull request", "pullRequestCreationEnabled"],
    ["Babysit pull request", "pullRequestBabysittingEnabled"],
  ] as const;
  const update = (key: (typeof entries)[number][1], checked: boolean) => {
    const next = { ...props.settings, [key]: checked };
    if (key === "pullRequestCreationEnabled" && !checked) {
      next.pullRequestBabysittingEnabled = false;
    }
    if (key === "pullRequestBabysittingEnabled" && checked) {
      next.pullRequestCreationEnabled = true;
    }
    props.onChange(next);
  };
  return (
    <section className="space-y-2 border-t border-border/70 pt-3">
      <h3 className="text-xs font-semibold text-foreground">Optional stages</h3>
      <div className="divide-y divide-border/60 overflow-hidden rounded-md border border-border/60">
        {entries.map(([label, key]) => (
          <label className="flex items-center justify-between gap-3 p-3 text-xs" key={key}>
            <span>{label}</span>
            <Switch
              checked={props.settings[key]}
              onCheckedChange={(checked) => update(key, checked === true)}
              aria-label={`Run ${label}`}
            />
          </label>
        ))}
      </div>
    </section>
  );
}

const RECOVERY_BACKUP_PIN_KEY: WorkflowModelPinKey = {
  workflowPromptId: WORKFLOW_RECOVERY_FALLBACK_MODEL_PIN,
};

export function WorkflowSettingsBody(props: {
  readonly environmentId: EnvironmentId;
  readonly preset: WorkflowPreset | null;
  readonly pinFor: (key: WorkflowModelPinKey) => ModelSelection | null;
  readonly rootModelSelection: ModelSelection;
  readonly rootLabel?: string | undefined;
  readonly description?: string | undefined;
  readonly onSetStepModel: SetWorkflowStepModel;
  readonly onSetStepModels?: SetWorkflowStepModels | undefined;
  readonly defaultStepModels?: ReadonlyArray<WorkflowStepModelOverride> | undefined;
  readonly stepCycles?: ReadonlyArray<WorkflowStepCycleOverride> | undefined;
  readonly defaultStepCycles?: ReadonlyArray<WorkflowStepCycleOverride> | undefined;
  readonly onSetStepCycles?: SetWorkflowStepCycles | undefined;
  readonly stepReviewParts?: ReadonlyArray<WorkflowStepReviewPartsOverride> | undefined;
  readonly defaultStepReviewParts?: ReadonlyArray<WorkflowStepReviewPartsOverride> | undefined;
  readonly onSetStepReviewParts?: SetWorkflowStepReviewParts | undefined;
  readonly implementationSettings?: ImplementationWorkflowSettings | undefined;
  readonly onSetImplementationSettings?:
    | ((settings: ImplementationWorkflowSettings) => void)
    | undefined;
  readonly implementationSettingsScope?: "defaults" | "run" | undefined;
}) {
  const choices = useWorkflowModelChoices(props.environmentId);
  const steps = pinnableSteps(props.preset);
  const defaultPinFor = (key: WorkflowModelPinKey): ModelSelection | null =>
    props.defaultStepModels?.find(
      (entry) => workflowModelPinKey(entry) === workflowModelPinKey(key),
    )?.modelSelection ?? null;
  const recoveryBackup = props.pinFor(RECOVERY_BACKUP_PIN_KEY);
  const defaultRecoveryBackup = defaultPinFor(RECOVERY_BACKUP_PIN_KEY);
  const recoveryInheritedSelection = defaultRecoveryBackup ?? props.rootModelSelection;
  const recoveryBackupControl = (
    <section className="space-y-2 border-b border-border/70 pb-4">
      <h3 className="text-xs font-semibold text-foreground">Recovery backup</h3>
      <WorkflowModelPinControls
        pinKey={RECOVERY_BACKUP_PIN_KEY}
        label="Backup provider and model"
        note="Used only after one recovery attempt on the primary model fails. An identical choice stays on the primary."
        pinnedSelection={recoveryBackup}
        inheritedSelection={recoveryInheritedSelection}
        inheritedLabel={
          defaultRecoveryBackup === null
            ? "Auto has no standing backup. Recovery stays on the primary model."
            : `Auto follows Settings (${choices.describeSelection(defaultRecoveryBackup)})`
        }
        choices={choices}
        onSetStepModel={props.onSetStepModel}
      />
    </section>
  );

  if (steps.length === 0) {
    return (
      <div className="space-y-3 px-3 py-2">
        {recoveryBackupControl}
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          This workflow has no other agent model settings.
        </p>
      </div>
    );
  }

  if (
    (props.preset === "planning" || props.preset === "fast-engineering") &&
    props.onSetStepCycles !== undefined &&
    props.onSetStepReviewParts !== undefined
  ) {
    return (
      <ScrollArea className="max-h-[min(42rem,75vh)]">
        <div className="space-y-4 px-3 py-2">
          {recoveryBackupControl}
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {props.description ??
              "Set models, cycle budgets, and App Review parts in workflow order. App Review stops at 10 cycles. Ticket and Final Code Review stop clean or run at most five cycles. Recovery continues the current cycle thread. Changes apply to the next agent each step starts."}
          </p>
          <EngineeringWorkflowSettings
            preset={props.preset}
            pinFor={props.pinFor}
            defaultPinFor={defaultPinFor}
            rootModelSelection={props.rootModelSelection}
            rootLabel={props.rootLabel ?? "The workflow model"}
            choices={choices}
            onSetStepModel={props.onSetStepModel}
            onSetStepModels={
              props.onSetStepModels ?? setWorkflowStepModelsOneAtATime(props.onSetStepModel)
            }
            stepCycles={props.stepCycles ?? []}
            defaultStepCycles={props.defaultStepCycles}
            onSetStepCycles={props.onSetStepCycles}
            stepReviewParts={props.stepReviewParts ?? []}
            defaultStepReviewParts={props.defaultStepReviewParts}
            onSetStepReviewParts={props.onSetStepReviewParts}
            implementationSettings={props.implementationSettings}
            onSetImplementationSettings={props.onSetImplementationSettings}
            implementationSettingsScope={props.implementationSettingsScope}
          />
        </div>
      </ScrollArea>
    );
  }

  return (
    <ScrollArea className="max-h-[26rem]">
      <div className="space-y-3 px-3 py-2">
        {recoveryBackupControl}
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {props.description ??
            "Set models for steps that start separate threads, cycle budgets, and the parts an App Review verifies. App Review stops at 10 cycles. Ticket and Final Code Review stop clean or run at most five cycles. Recovery continues the current cycle thread. Shared-thread steps use the workflow composer model. Changes apply to the next agent a step starts."}
        </p>
        <WorkflowModelQuickPins
          preset={props.preset}
          pinFor={props.pinFor}
          rootModelSelection={props.rootModelSelection}
          rootLabel={props.rootLabel ?? "The workflow model"}
          choices={choices}
          onSetStepModels={
            props.onSetStepModels ?? setWorkflowStepModelsOneAtATime(props.onSetStepModel)
          }
        />
        {steps.map((step) => {
          const subStepWorkflowPromptIds = (step.subSteps ?? []).map(
            (subStep) => subStep.workflowPromptId,
          );
          return (
            <div key={step.label} className="border-t border-border/70 pt-2 first:border-t-0">
              <WorkflowStepModelPins
                stepLabel={step.label}
                workflowPromptId={step.skillId!}
                subSteps={step.subSteps ?? []}
                pinFor={props.pinFor}
                rootModelSelection={props.rootModelSelection}
                rootLabel={props.rootLabel}
                choices={choices}
                onSetStepModel={props.onSetStepModel}
              />
              {props.onSetStepCycles ? (
                <WorkflowStepCyclePins
                  workflowPromptId={step.skillId!}
                  subStepWorkflowPromptIds={subStepWorkflowPromptIds}
                  overrides={props.stepCycles ?? []}
                  defaults={props.defaultStepCycles}
                  onSetStepCycles={props.onSetStepCycles}
                  className="mt-3 space-y-2 border-t border-border/60 pt-3"
                />
              ) : null}
              {props.onSetStepReviewParts ? (
                <WorkflowStepReviewPartPins
                  workflowPromptId={step.skillId!}
                  subStepWorkflowPromptIds={subStepWorkflowPromptIds}
                  overrides={props.stepReviewParts ?? []}
                  defaults={props.defaultStepReviewParts}
                  onSetStepReviewParts={props.onSetStepReviewParts}
                  className="mt-3 space-y-2 border-t border-border/60 pt-3"
                />
              ) : null}
            </div>
          );
        })}
        {(props.preset === "quick-plan" || props.preset === "fast-plan") &&
        props.implementationSettings !== undefined &&
        props.onSetImplementationSettings !== undefined ? (
          <PlanWorkflowStageControls
            settings={props.implementationSettings}
            onChange={props.onSetImplementationSettings}
          />
        ) : null}
      </div>
    </ScrollArea>
  );
}

/**
 * Every step of one running workflow in a single popup.
 *
 * The per-step menus tune one stage at a time; this is where a whole run gets
 * laid out — cheap models for the mechanical steps, fewer cycles on the slow
 * ones, an App Review that skips the browser — without opening nine menus. The
 * two entry points carry the same settings on purpose, so nothing is reachable
 * from only one of them.
 */
export function WorkflowSettingsMenu(props: {
  readonly environmentId: EnvironmentId;
  readonly preset: WorkflowPreset | null;
  readonly pinFor: (key: WorkflowModelPinKey) => ModelSelection | null;
  readonly rootModelSelection: ModelSelection;
  /** Names what an unpinned step follows. Defaults to the run's own model. */
  readonly rootLabel?: string | undefined;
  readonly description?: string | undefined;
  readonly heading?: string | undefined;
  readonly onSetStepModel: SetWorkflowStepModel | undefined;
  readonly defaultStepModels?: ReadonlyArray<WorkflowStepModelOverride> | undefined;
  /** The run's own cycle budgets, and the standing defaults behind them. */
  readonly stepCycles?: ReadonlyArray<WorkflowStepCycleOverride> | undefined;
  readonly defaultStepCycles?: ReadonlyArray<WorkflowStepCycleOverride> | undefined;
  readonly onSetStepCycles?: SetWorkflowStepCycles | undefined;
  /** The run's own App Review parts, and the standing defaults behind them. */
  readonly stepReviewParts?: ReadonlyArray<WorkflowStepReviewPartsOverride> | undefined;
  readonly defaultStepReviewParts?: ReadonlyArray<WorkflowStepReviewPartsOverride> | undefined;
  readonly onSetStepReviewParts?: SetWorkflowStepReviewParts | undefined;
}) {
  const [open, setOpen] = useState(false);
  const { onSetStepModel } = props;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label="Workflow settings"
        title="Set the model, cycles, and review parts for every step of this workflow"
        className="cursor-pointer inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-border/80 px-2 text-xs font-medium hover:bg-accent"
      >
        <SlidersHorizontal className="size-3" aria-hidden /> Settings
      </PopoverTrigger>
      <PopoverPopup
        side="bottom"
        align="end"
        className={
          props.preset === "planning" || props.preset === "fast-engineering"
            ? "w-[min(42rem,calc(100vw-2rem))] p-0"
            : "w-80 p-0"
        }
      >
        <div className="border-b border-border/70 px-3 py-2">
          <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            {props.heading ?? "Workflow settings"}
          </div>
          <div className="truncate text-xs font-semibold text-foreground">
            {props.preset === null
              ? "Workflow"
              : (WORKFLOW_PRESET_DEFINITION_BY_ID[props.preset]?.label ?? "Workflow")}
          </div>
        </div>
        {open && onSetStepModel !== undefined ? (
          <WorkflowSettingsBody
            environmentId={props.environmentId}
            preset={props.preset}
            pinFor={props.pinFor}
            rootModelSelection={props.rootModelSelection}
            rootLabel={props.rootLabel}
            description={props.description}
            onSetStepModel={onSetStepModel}
            defaultStepModels={props.defaultStepModels}
            stepCycles={props.stepCycles}
            defaultStepCycles={props.defaultStepCycles}
            onSetStepCycles={props.onSetStepCycles}
            stepReviewParts={props.stepReviewParts}
            defaultStepReviewParts={props.defaultStepReviewParts}
            onSetStepReviewParts={props.onSetStepReviewParts}
          />
        ) : null}
      </PopoverPopup>
    </Popover>
  );
}
