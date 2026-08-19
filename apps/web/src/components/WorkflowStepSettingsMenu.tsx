import type { EnvironmentId, ModelSelection, ThreadId } from "@t3tools/contracts";
import type { WorkflowPresetSubStep } from "@t3tools/shared/workflowPresets";
import { Eraser, Pause, Play, RotateCcw, Settings2, SkipForward } from "lucide-react";
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
 * Controls for one scope of a running workflow: which agent runs it, and
 * stopping, starting or clearing it. The same menu serves a step, a wave, a
 * ticket and a ticket's stages, so `scopeNoun` names what the buttons act on.
 *
 * A pin applies to the next agent the scope starts — a later cycle, a restart,
 * a wave that has not begun. Agents already running keep the model they
 * launched with, so stopping and starting again is how a pin reaches work in
 * flight.
 *
 * Clearing keeps every commit; it drops what the scope recorded so the run can
 * reach it again. A clear that covers more than one thing asks first, because
 * it is one click away from discarding a whole wave's results.
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
  /**
   * The paused scopes covering this one, empty when it is running. A row can
   * sit under more than one: its own pause and the workflow's.
   */
  readonly pausedScopeThreadIds?: readonly ThreadId[];
  readonly onResume?: ((threadIds: readonly ThreadId[]) => void) | undefined;
  /** What the buttons act on. "step" unless the menu sits on a smaller scope. */
  readonly scopeNoun?: string;
  readonly onClear?: (() => void) | undefined;
  readonly clearDisabledReason?: string | null;
  /** Set when clearing covers more than one thing, so the menu asks first. */
  readonly confirmClearMessage?: string | null;
  /** Whether the run is currently told to pass over this scope. */
  readonly skipped?: boolean;
  readonly onSetSkipped?: ((skipped: boolean) => void) | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const { workflowPromptId, onSetStepModel } = props;
  const noun = props.scopeNoun ?? "step";
  const pausedScopeThreadIds = props.pausedScopeThreadIds ?? [];
  // A paused scope has nothing to stop and everything to resume, so the two
  // trade places rather than sitting next to each other.
  const paused = pausedScopeThreadIds.length > 0;
  // Starting a paused scope again would run one agent and then stall: the run
  // still refuses to take the next step under a pause. Resume is the way
  // forward, and it re-enters the same stage.
  const restartDisabledReason = paused
    ? `This ${noun} is paused. Resume it to pick the run back up.`
    : props.restartDisabledReason;
  const clearDisabledReason = props.clearDisabledReason ?? null;
  const confirmClearMessage = props.confirmClearMessage ?? null;

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setConfirmingClear(false);
      }}
    >
      <PopoverTrigger
        aria-label={`Settings for ${props.stepLabel}`}
        title={`Settings for ${props.stepLabel}`}
        data-testid="workflow-scope-menu"
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
          {paused ? (
            <button
              type="button"
              disabled={props.onResume === undefined}
              title={`Let the run pick this ${noun} back up where it stopped`}
              onClick={() => {
                props.onResume?.(pausedScopeThreadIds);
                setOpen(false);
              }}
              className="cursor-pointer flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs font-medium hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
            >
              <Play className="size-3.5" aria-hidden />
              Resume {noun}
            </button>
          ) : (
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
              Stop {noun}
            </button>
          )}
          <button
            type="button"
            disabled={restartDisabledReason !== null || props.onRestart === undefined}
            title={restartDisabledReason ?? props.restartLabel}
            onClick={() => {
              props.onRestart?.();
              setOpen(false);
            }}
            className="cursor-pointer flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs font-medium hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
          >
            <RotateCcw className="size-3.5" aria-hidden />
            Start {noun} again
          </button>
          {restartDisabledReason !== null ? (
            <p className="px-2 text-[11px] leading-relaxed text-muted-foreground">
              {restartDisabledReason}
            </p>
          ) : null}
          {props.onClear === undefined ? null : (
            <>
              <button
                type="button"
                disabled={clearDisabledReason !== null}
                title={clearDisabledReason ?? `Clear this ${noun} without starting it`}
                onClick={() => {
                  if (confirmClearMessage !== null && !confirmingClear) {
                    setConfirmingClear(true);
                    return;
                  }
                  props.onClear?.();
                  setConfirmingClear(false);
                  setOpen(false);
                }}
                className="cursor-pointer flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs font-medium text-destructive hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
              >
                <Eraser className="size-3.5" aria-hidden />
                {confirmingClear ? `Yes, clear ${noun}` : `Clear ${noun}`}
              </button>
              {confirmingClear && confirmClearMessage !== null ? (
                <>
                  <p className="px-2 text-[11px] leading-relaxed text-muted-foreground">
                    {confirmClearMessage}
                  </p>
                  <button
                    type="button"
                    onClick={() => setConfirmingClear(false)}
                    className="cursor-pointer flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs font-medium hover:bg-accent"
                  >
                    Cancel
                  </button>
                </>
              ) : null}
              {clearDisabledReason !== null ? (
                <p className="px-2 text-[11px] leading-relaxed text-muted-foreground">
                  {clearDisabledReason}
                </p>
              ) : null}
            </>
          )}
          {props.onSetSkipped === undefined ? null : (
            <button
              type="button"
              title={
                props.skipped === true
                  ? `Let the run do this ${noun} again`
                  : `Have the run pass over this ${noun}`
              }
              onClick={() => {
                props.onSetSkipped?.(props.skipped !== true);
                setOpen(false);
              }}
              className="cursor-pointer flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs font-medium hover:bg-accent"
            >
              <SkipForward className="size-3.5" aria-hidden />
              {props.skipped === true ? `Stop skipping ${noun}` : `Skip ${noun}`}
            </button>
          )}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
