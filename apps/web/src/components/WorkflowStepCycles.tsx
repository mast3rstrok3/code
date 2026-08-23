import type { WorkflowStepCycleOverride } from "@t3tools/contracts";
import {
  findWorkflowStepCycleTarget,
  resolveWorkflowStepCycleBudget,
  workflowStepCycleKeyId,
  type WorkflowStepCycleKey,
  type WorkflowStepCycleTarget,
} from "@t3tools/shared/workflowStepCycles";
import { useEffect, useState } from "react";

import { Input } from "./ui/input";

export type SetWorkflowStepCycles = (key: WorkflowStepCycleKey, maxCycles: number | null) => void;

/**
 * Auto/Set for one step's cycle budget.
 *
 * Auto is not "unlimited" — it is the number the step would run anyway, which
 * `inheritedLabel` names so the choice is never a guess. The field commits on
 * blur and on Enter rather than per keystroke: every commit is a command, and
 * typing "12" should not first ask the server for one cycle.
 */
function WorkflowStepCycleControl(props: {
  readonly target: WorkflowStepCycleTarget;
  readonly setCycles: number | null;
  readonly inheritedCycles: number;
  readonly inheritedLabel: string;
  readonly onSetStepCycles: SetWorkflowStepCycles;
}) {
  const { target, setCycles, inheritedCycles } = props;
  const [draft, setDraft] = useState(String(setCycles ?? inheritedCycles));
  // A budget can move while the field is open: another client can set it, and
  // a run can be re-pointed at a different step.
  useEffect(() => {
    setDraft(String(setCycles ?? inheritedCycles));
  }, [setCycles, inheritedCycles]);

  const commit = () => {
    const parsed = Number.parseInt(draft, 10);
    if (!Number.isFinite(parsed)) {
      setDraft(String(setCycles ?? inheritedCycles));
      return;
    }
    const bounded = Math.min(target.maxCycles, Math.max(1, parsed));
    setDraft(String(bounded));
    if (bounded !== setCycles) props.onSetStepCycles(target.key, bounded);
  };

  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-xs font-medium text-foreground">{target.label}</span>
        <button
          type="button"
          onClick={() =>
            props.onSetStepCycles(target.key, setCycles === null ? inheritedCycles : null)
          }
          className="cursor-pointer shrink-0 text-[10px] font-medium uppercase tracking-wider text-muted-foreground hover:text-foreground"
        >
          {setCycles === null ? "Set" : "Auto"}
        </button>
      </div>
      {setCycles === null ? (
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {props.inheritedLabel} · {target.description}
        </p>
      ) : (
        <>
          <Input
            type="number"
            min={1}
            max={target.maxCycles}
            step={1}
            value={draft}
            aria-label={`Cycles for ${target.label}`}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                event.currentTarget.blur();
              }
            }}
            className="h-8 text-xs"
          />
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            1 to {target.maxCycles}. {target.description}
          </p>
        </>
      )}
    </div>
  );
}

/**
 * Cycle budgets for a step and the agents it starts, or nothing when none of
 * them loops.
 *
 * Rendered next to the model pins, and keyed the same way, so "how many times"
 * and "with which model" are set in one place. `defaults` is the standing
 * choice a run inherits; a Settings surface passes none and edits it directly.
 */
export function WorkflowStepCyclePins(props: {
  readonly workflowPromptId: string;
  readonly subStepWorkflowPromptIds: ReadonlyArray<string>;
  readonly overrides: ReadonlyArray<WorkflowStepCycleOverride>;
  readonly defaults?: ReadonlyArray<WorkflowStepCycleOverride> | undefined;
  /** How an unset budget is described. Defaults to naming the standing choice. */
  readonly inheritedLabel?: string | undefined;
  /** Replaces the default spacing when the section needs its own frame. */
  readonly className?: string | undefined;
  /** Hides the section label when a single cycle control sits beside its step. */
  readonly showHeading?: boolean | undefined;
  readonly onSetStepCycles: SetWorkflowStepCycles;
}) {
  const targets = [
    findWorkflowStepCycleTarget({ workflowPromptId: props.workflowPromptId }),
    ...props.subStepWorkflowPromptIds.map((subStepId) =>
      findWorkflowStepCycleTarget({
        workflowPromptId: subStepId,
        stepWorkflowPromptId: props.workflowPromptId,
      }),
    ),
  ].filter((target): target is WorkflowStepCycleTarget => target !== undefined);
  if (targets.length === 0) return null;

  return (
    <div className={props.className ?? "space-y-2"}>
      {props.showHeading === false ? null : (
        <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          Cycles
        </div>
      )}
      {targets.map((target) => {
        const setCycles =
          props.overrides.find(
            (entry) =>
              entry.workflowPromptId === target.key.workflowPromptId &&
              (entry.stepWorkflowPromptId ?? null) === (target.key.stepWorkflowPromptId ?? null),
          )?.maxCycles ?? null;
        const inheritedCycles = resolveWorkflowStepCycleBudget({
          key: target.key,
          settingsOverrides: props.defaults,
        });
        return (
          <WorkflowStepCycleControl
            key={workflowStepCycleKeyId(target.key)}
            target={target}
            setCycles={setCycles}
            inheritedCycles={inheritedCycles}
            inheritedLabel={
              props.inheritedLabel ?? `Runs up to ${String(inheritedCycles)} cycles by default`
            }
            onSetStepCycles={props.onSetStepCycles}
          />
        );
      })}
    </div>
  );
}
