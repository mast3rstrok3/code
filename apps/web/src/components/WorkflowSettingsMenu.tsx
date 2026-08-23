import type {
  EnvironmentId,
  ModelSelection,
  WorkflowPreset,
  WorkflowStepCycleOverride,
  WorkflowStepReviewPartsOverride,
} from "@t3tools/contracts";
import {
  WORKFLOW_PRESET_DEFINITION_BY_ID,
  type WorkflowPresetHelpStep,
} from "@t3tools/shared/workflowPresets";
import { SlidersHorizontal } from "lucide-react";
import { useState } from "react";

import { Popover, PopoverPopup, PopoverTrigger } from "./ui/popover";
import { ScrollArea } from "~/components/ui/scroll-area";
import { WorkflowStepCyclePins, type SetWorkflowStepCycles } from "./WorkflowStepCycles";
import {
  WorkflowStepReviewPartPins,
  type SetWorkflowStepReviewParts,
} from "./WorkflowStepReviewParts";
import {
  useWorkflowModelChoices,
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
  return (WORKFLOW_PRESET_DEFINITION_BY_ID[preset]?.helpSteps ?? []).filter(
    (step) => step.skillId !== undefined,
  );
}

export function WorkflowSettingsBody(props: {
  readonly environmentId: EnvironmentId;
  readonly preset: WorkflowPreset | null;
  readonly pinFor: (key: WorkflowModelPinKey) => ModelSelection | null;
  readonly rootModelSelection: ModelSelection;
  readonly rootLabel?: string | undefined;
  readonly description?: string | undefined;
  readonly onSetStepModel: SetWorkflowStepModel;
  readonly onSetStepModels?: SetWorkflowStepModels | undefined;
  readonly stepCycles?: ReadonlyArray<WorkflowStepCycleOverride> | undefined;
  readonly defaultStepCycles?: ReadonlyArray<WorkflowStepCycleOverride> | undefined;
  readonly onSetStepCycles?: SetWorkflowStepCycles | undefined;
  readonly stepReviewParts?: ReadonlyArray<WorkflowStepReviewPartsOverride> | undefined;
  readonly defaultStepReviewParts?: ReadonlyArray<WorkflowStepReviewPartsOverride> | undefined;
  readonly onSetStepReviewParts?: SetWorkflowStepReviewParts | undefined;
}) {
  const choices = useWorkflowModelChoices(props.environmentId);
  const steps = pinnableSteps(props.preset);

  if (steps.length === 0) {
    return (
      <p className="px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
        This workflow has no steps with agents of their own, so there is nothing to set.
      </p>
    );
  }

  return (
    <ScrollArea className="max-h-[26rem]">
      <div className="space-y-3 px-3 py-2">
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {props.description ??
            "Everything this run does per step: which model it uses, how many cycles it repeats, and which parts an App Review verifies. Settings apply to the next agent a step starts — stop and start a step to reach work already running."}
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
      <PopoverPopup side="bottom" align="end" className="w-80 p-0">
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
