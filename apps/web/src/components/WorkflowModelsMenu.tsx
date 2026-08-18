import type { EnvironmentId, ModelSelection, WorkflowPreset } from "@t3tools/contracts";
import {
  WORKFLOW_PRESET_DEFINITION_BY_ID,
  type WorkflowPresetHelpStep,
} from "@t3tools/shared/workflowPresets";
import { SlidersHorizontal } from "lucide-react";
import { useState } from "react";

import { Popover, PopoverPopup, PopoverTrigger } from "./ui/popover";
import { ScrollArea } from "~/components/ui/scroll-area";
import {
  useWorkflowModelChoices,
  WorkflowStepModelPins,
  type SetWorkflowStepModel,
  type WorkflowModelPinKey,
} from "./WorkflowModelPins";

/** Steps that start an agent of their own — the rest have nothing to pin. */
function pinnableSteps(preset: WorkflowPreset | null): ReadonlyArray<WorkflowPresetHelpStep> {
  if (preset === null) return [];
  return (WORKFLOW_PRESET_DEFINITION_BY_ID[preset]?.helpSteps ?? []).filter(
    (step) => step.skillId !== undefined,
  );
}

function WorkflowModelsBody(props: {
  readonly environmentId: EnvironmentId;
  readonly preset: WorkflowPreset | null;
  readonly pinFor: (key: WorkflowModelPinKey) => ModelSelection | null;
  readonly rootModelSelection: ModelSelection;
  readonly onSetStepModel: SetWorkflowStepModel;
}) {
  const choices = useWorkflowModelChoices(props.environmentId);
  const steps = pinnableSteps(props.preset);

  if (steps.length === 0) {
    return (
      <p className="px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
        This workflow has no steps with agents of their own, so there is nothing to pin.
      </p>
    );
  }

  return (
    <ScrollArea className="max-h-[26rem]">
      <div className="space-y-3 px-3 py-2">
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Every step runs on the workflow&apos;s model unless you pin it, and each agent a step
          starts follows that step unless you pin it too. Pins apply to the next agent a step starts
          — stop and start a step to reach work already running.
        </p>
        {steps.map((step) => (
          <div key={step.label} className="border-t border-border/70 pt-2 first:border-t-0">
            <WorkflowStepModelPins
              stepLabel={step.label}
              workflowPromptId={step.skillId!}
              subSteps={step.subSteps ?? []}
              pinFor={props.pinFor}
              rootModelSelection={props.rootModelSelection}
              choices={choices}
              onSetStepModel={props.onSetStepModel}
            />
          </div>
        ))}
      </div>
    </ScrollArea>
  );
}

/**
 * Every step and sub-step of one running workflow in a single popup.
 *
 * The per-step menus tune one stage at a time; this is where a whole run gets
 * laid out — cheap models for the mechanical steps, an expensive one for the
 * review that needs it — without opening nine menus.
 */
export function WorkflowModelsMenu(props: {
  readonly environmentId: EnvironmentId;
  readonly preset: WorkflowPreset | null;
  readonly pinFor: (key: WorkflowModelPinKey) => ModelSelection | null;
  readonly rootModelSelection: ModelSelection;
  readonly onSetStepModel: SetWorkflowStepModel | undefined;
}) {
  const [open, setOpen] = useState(false);
  const { onSetStepModel } = props;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label="Workflow step models"
        title="Choose the model for each step and sub-step of this workflow"
        className="cursor-pointer inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-border/80 px-2 text-xs font-medium hover:bg-accent"
      >
        <SlidersHorizontal className="size-3" aria-hidden /> Models
      </PopoverTrigger>
      <PopoverPopup side="bottom" align="end" className="w-80 p-0">
        <div className="border-b border-border/70 px-3 py-2">
          <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            Step models
          </div>
          <div className="truncate text-xs font-semibold text-foreground">
            {props.preset === null
              ? "Workflow"
              : (WORKFLOW_PRESET_DEFINITION_BY_ID[props.preset]?.label ?? "Workflow")}
          </div>
        </div>
        {open && onSetStepModel !== undefined ? (
          <WorkflowModelsBody
            environmentId={props.environmentId}
            preset={props.preset}
            pinFor={props.pinFor}
            rootModelSelection={props.rootModelSelection}
            onSetStepModel={onSetStepModel}
          />
        ) : null}
      </PopoverPopup>
    </Popover>
  );
}
