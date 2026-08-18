import type { EnvironmentId, ModelSelection, ThreadId } from "@t3tools/contracts";
import type { WorkflowPresetSubStep } from "@t3tools/shared/workflowPresets";
import { Pause, RotateCcw, Settings2 } from "lucide-react";
import { useState } from "react";

import { Popover, PopoverPopup, PopoverTrigger } from "./ui/popover";
import {
  useWorkflowModelChoices,
  WorkflowStepModelPins,
  type SetWorkflowStepModel,
  type WorkflowModelPinKey,
} from "./WorkflowModelPins";

/**
 * The step's model choices, split out so the provider and settings
 * subscriptions they need exist only while a menu is open — a workflow renders
 * a row for every stage, and none of them should carry a picker's state until
 * it is asked for.
 */
function WorkflowStepModelSection(props: {
  readonly environmentId: EnvironmentId;
  readonly stepLabel: string;
  readonly workflowPromptId: string;
  readonly subSteps: ReadonlyArray<WorkflowPresetSubStep>;
  readonly pinFor: (key: WorkflowModelPinKey) => ModelSelection | null;
  readonly usesRootThread: boolean;
  readonly rootModelSelection: ModelSelection;
  readonly onSetStepModel: SetWorkflowStepModel;
}) {
  const choices = useWorkflowModelChoices(props.environmentId);
  return (
    <>
      <WorkflowStepModelPins
        stepLabel={props.stepLabel}
        workflowPromptId={props.workflowPromptId}
        subSteps={props.subSteps}
        pinFor={props.pinFor}
        rootModelSelection={props.rootModelSelection}
        choices={choices}
        onSetStepModel={props.onSetStepModel}
      />
      {props.usesRootThread ? (
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          This step also runs in the workflow&apos;s main thread. A pin covers the agents this step
          starts; the main thread follows its own composer.
        </p>
      ) : null}
    </>
  );
}

/**
 * Per-step controls for a running workflow: which agent runs the step, and
 * stopping or starting it again.
 *
 * A pin applies to the next agent the step starts — a later cycle, a restart,
 * a wave that has not begun. Agents already running keep the model they
 * launched with, so stopping and starting the step again is how a pin reaches
 * work in flight.
 */
export function WorkflowStepSettingsMenu(props: {
  readonly environmentId: EnvironmentId;
  readonly stepLabel: string;
  /** Null for steps with no agent of their own, e.g. worktree preparation. */
  readonly workflowPromptId: string | null;
  /** The agents this step starts, when it starts more than one kind. */
  readonly subSteps: ReadonlyArray<WorkflowPresetSubStep>;
  readonly pinFor: (key: WorkflowModelPinKey) => ModelSelection | null;
  /** True when the step's work happens in the workflow's main thread. */
  readonly usesRootThread: boolean;
  readonly rootModelSelection: ModelSelection;
  readonly restartLabel: string;
  readonly restartDisabledReason: string | null;
  readonly runningThreadIds: readonly ThreadId[];
  readonly onSetStepModel: SetWorkflowStepModel | undefined;
  readonly onRestart: (() => void) | undefined;
  readonly onStop: ((threadIds: readonly ThreadId[]) => void) | undefined;
}) {
  const [open, setOpen] = useState(false);
  const { workflowPromptId, onSetStepModel } = props;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label={`Settings for ${props.stepLabel}`}
        title={`Settings for ${props.stepLabel}`}
        className="cursor-pointer mt-1 flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <Settings2 className="size-3.5" aria-hidden />
      </PopoverTrigger>
      <PopoverPopup side="bottom" align="end" className="w-72 p-0">
        <div className="border-b border-border/70 px-3 py-2">
          <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            Step settings
          </div>
          <div className="truncate text-xs font-semibold text-foreground">{props.stepLabel}</div>
        </div>

        <div className="space-y-2 px-3 py-2">
          <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            Model
          </div>
          {open && workflowPromptId !== null && onSetStepModel !== undefined ? (
            <WorkflowStepModelSection
              environmentId={props.environmentId}
              stepLabel={props.stepLabel}
              workflowPromptId={workflowPromptId}
              subSteps={props.subSteps}
              pinFor={props.pinFor}
              usesRootThread={props.usesRootThread}
              rootModelSelection={props.rootModelSelection}
              onSetStepModel={onSetStepModel}
            />
          ) : (
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              This step has no agent of its own, so there is no model to choose.
            </p>
          )}
        </div>

        <div className="space-y-1 border-t border-border/70 px-2 py-2">
          <button
            type="button"
            disabled={props.runningThreadIds.length === 0 || props.onStop === undefined}
            title={
              props.runningThreadIds.length === 0
                ? "Nothing is running in this step"
                : "Stop this step and its active agent sessions"
            }
            onClick={() => {
              props.onStop?.(props.runningThreadIds);
              setOpen(false);
            }}
            className="cursor-pointer flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs font-medium hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
          >
            <Pause className="size-3.5" aria-hidden />
            Stop step
          </button>
          <button
            type="button"
            disabled={props.restartDisabledReason !== null || props.onRestart === undefined}
            title={props.restartDisabledReason ?? props.restartLabel}
            onClick={() => {
              props.onRestart?.();
              setOpen(false);
            }}
            className="cursor-pointer flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs font-medium hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
          >
            <RotateCcw className="size-3.5" aria-hidden />
            Start step again
          </button>
          {props.restartDisabledReason !== null ? (
            <p className="px-2 text-[11px] leading-relaxed text-muted-foreground">
              {props.restartDisabledReason}
            </p>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
