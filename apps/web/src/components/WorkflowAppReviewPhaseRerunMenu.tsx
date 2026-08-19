import type { AppReviewWorkflowPhase, EnvironmentId, ModelSelection } from "@t3tools/contracts";
import { RotateCcw } from "lucide-react";
import { useState } from "react";

import { Popover, PopoverPopup, PopoverTrigger } from "./ui/popover";
import {
  useWorkflowModelChoices,
  WorkflowModelPinControls,
  type SetWorkflowStepModel,
  type WorkflowModelPinKey,
} from "./WorkflowModelPins";

/**
 * The pin picker for one phase, split out so the provider and settings
 * subscriptions it needs exist only while the menu is open. A ten-cycle review
 * renders thirty phase rows, and none of them should carry a picker's state
 * until somebody asks for it.
 */
function AppReviewPhaseModelSection(props: {
  readonly environmentId: EnvironmentId;
  readonly phaseLabel: string;
  readonly pinKey: WorkflowModelPinKey;
  readonly pinnedSelection: ModelSelection | null;
  readonly inheritedSelection: ModelSelection;
  readonly inheritedLabel: string;
  readonly onSetStepModel: SetWorkflowStepModel;
}) {
  const choices = useWorkflowModelChoices(props.environmentId);
  return (
    <WorkflowModelPinControls
      pinKey={props.pinKey}
      label={props.phaseLabel}
      pinnedSelection={props.pinnedSelection}
      inheritedSelection={props.inheritedSelection}
      inheritedLabel={props.inheritedLabel}
      choices={choices}
      onSetStepModel={props.onSetStepModel}
    />
  );
}

/**
 * Start one phase of an App Review cycle again.
 *
 * The phase runs in a fresh thread and the phases after it are dropped, since
 * redoing gap analysis means the repair it planned no longer stands. Redoing
 * the browser review rewinds the whole cycle, so it costs no cycle budget.
 */
export function WorkflowAppReviewPhaseRerunMenu(props: {
  readonly environmentId: EnvironmentId;
  readonly cycleNumber: number;
  readonly phaseLabel: string;
  readonly phase: AppReviewWorkflowPhase;
  readonly pinKey: WorkflowModelPinKey;
  readonly pinnedSelection: ModelSelection | null;
  readonly inheritedSelection: ModelSelection;
  readonly inheritedLabel: string;
  /** Set when the phase cannot start again yet, and says why. */
  readonly disabledReason: string | null;
  readonly onSetStepModel: SetWorkflowStepModel | undefined;
  readonly onRerun: (() => void) | undefined;
}) {
  const [open, setOpen] = useState(false);
  const { onSetStepModel, onRerun } = props;
  const label = `Start ${props.phaseLabel} again in cycle ${props.cycleNumber}`;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label={label}
        title={label}
        className="cursor-pointer ml-auto inline-flex size-4 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <RotateCcw className="size-2.5" aria-hidden />
      </PopoverTrigger>
      <PopoverPopup side="bottom" align="end" className="w-72 p-0">
        <div className="border-b border-border/70 px-3 py-2">
          <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            Start again · cycle {props.cycleNumber}
          </div>
          <div className="truncate text-xs font-semibold text-foreground">{props.phaseLabel}</div>
        </div>

        <div className="space-y-2 px-3 py-2">
          <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            Model
          </div>
          {open && onSetStepModel !== undefined ? (
            <AppReviewPhaseModelSection
              environmentId={props.environmentId}
              phaseLabel={props.phaseLabel}
              pinKey={props.pinKey}
              pinnedSelection={props.pinnedSelection}
              inheritedSelection={props.inheritedSelection}
              inheritedLabel={props.inheritedLabel}
              onSetStepModel={onSetStepModel}
            />
          ) : null}
        </div>

        <div className="space-y-1 border-t border-border/70 px-2 py-2">
          <button
            type="button"
            disabled={props.disabledReason !== null || onRerun === undefined}
            title={props.disabledReason ?? label}
            onClick={() => {
              onRerun?.();
              setOpen(false);
            }}
            className="cursor-pointer flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs font-medium hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
          >
            <RotateCcw className="size-3.5" aria-hidden />
            Start {props.phaseLabel} again
          </button>
          {props.disabledReason !== null ? (
            <p className="px-2 text-[11px] leading-relaxed text-muted-foreground">
              {props.disabledReason}
            </p>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
