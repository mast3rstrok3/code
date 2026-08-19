import type { EnvironmentId, ModelSelection } from "@t3tools/contracts";
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
 * The pin picker for one ticket stage, split out so the provider and settings
 * subscriptions it needs exist only while the menu is open. A run renders a row
 * per stage per ticket, and none of them should carry a picker's state until
 * somebody asks for it.
 */
function TicketStageModelSection(props: {
  readonly environmentId: EnvironmentId;
  readonly stageLabel: string;
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
      label={props.stageLabel}
      pinnedSelection={props.pinnedSelection}
      inheritedSelection={props.inheritedSelection}
      inheritedLabel={props.inheritedLabel}
      choices={choices}
      onSetStepModel={props.onSetStepModel}
    />
  );
}

/**
 * Start one stage of one ticket again.
 *
 * The stage runs in a new thread, so the attempt that failed stays readable
 * beside it. Re-running implementation also reopens the tickets that failed
 * only because this one did, since those carried no work of their own.
 *
 * The pin above the button is the same per-step pin the Workflows panel writes,
 * so changing it here both moves this re-run and sticks for later agents of the
 * stage.
 */
export function WorkflowTicketStageRerunMenu(props: {
  readonly environmentId: EnvironmentId;
  readonly ticketLabel: string;
  readonly stageLabel: string;
  readonly pinKey: WorkflowModelPinKey;
  readonly pinnedSelection: ModelSelection | null;
  readonly inheritedSelection: ModelSelection;
  readonly inheritedLabel: string;
  /** Set when the stage cannot start again yet, and says why. */
  readonly disabledReason: string | null;
  readonly onSetStepModel: SetWorkflowStepModel | undefined;
  readonly onRerun: (() => void) | undefined;
}) {
  const [open, setOpen] = useState(false);
  const { onSetStepModel, onRerun } = props;
  const label = `Start ${props.stageLabel} again for ${props.ticketLabel}`;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label={label}
        title={label}
        className="cursor-pointer ml-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        Re-run <RotateCcw className="size-3" aria-hidden />
      </PopoverTrigger>
      <PopoverPopup side="bottom" align="end" className="w-72 p-0">
        <div className="border-b border-border/70 px-3 py-2">
          <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            Start again
          </div>
          <div className="truncate text-xs font-semibold text-foreground">
            {props.stageLabel} · {props.ticketLabel}
          </div>
        </div>

        <div className="space-y-2 px-3 py-2">
          <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            Model
          </div>
          {open && onSetStepModel !== undefined ? (
            <TicketStageModelSection
              environmentId={props.environmentId}
              stageLabel={props.stageLabel}
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
            Start {props.stageLabel} again
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
