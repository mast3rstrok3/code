import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  ModelSelection,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { Pause, RotateCcw, Settings2 } from "lucide-react";
import { useMemo, useState } from "react";

import { cn } from "~/lib/utils";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../providerInstances";
import { getCustomModelOptionsByInstance } from "../modelSelection";
import { primaryServerProvidersAtom, serverEnvironment } from "../state/server";
import { useEnvironmentSettings } from "../hooks/useSettings";
import { Popover, PopoverPopup, PopoverTrigger } from "./ui/popover";
import { ProviderModelPicker } from "./chat/ProviderModelPicker";
import { getTriggerDisplayModelName } from "./chat/providerIconUtils";

/**
 * Auto/Custom model choice for one step.
 *
 * Split from the menu so the provider and settings subscriptions it needs
 * exist only while a menu is open — a workflow renders a row for every stage,
 * and none of them should carry a picker's state until it is asked for.
 */
function WorkflowStepModelSection(props: {
  readonly environmentId: EnvironmentId;
  readonly stepLabel: string;
  readonly workflowPromptId: string;
  readonly pinnedSelection: ModelSelection | null;
  readonly usesRootThread: boolean;
  readonly rootModelSelection: ModelSelection;
  readonly onSetStepModel: (workflowPromptId: string, selection: ModelSelection | null) => void;
}) {
  // The workflow may live in a non-primary environment, so its own providers
  // and settings decide what can be pinned.
  const environmentConfig = useAtomValue(serverEnvironment.configValueAtom(props.environmentId));
  const primaryProviders = useAtomValue(primaryServerProvidersAtom);
  const providers = environmentConfig?.providers ?? primaryProviders;
  const settings = useEnvironmentSettings(props.environmentId);

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

  const activeSelection = props.pinnedSelection ?? props.rootModelSelection;
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

  return (
    <>
      <div className="flex gap-1 rounded-md bg-muted p-0.5">
        {(
          [
            ["auto", "Auto"],
            ["custom", "Custom"],
          ] as const
        ).map(([mode, label]) => {
          const selected =
            mode === "auto" ? props.pinnedSelection === null : props.pinnedSelection !== null;
          return (
            <button
              key={mode}
              type="button"
              aria-pressed={selected}
              onClick={() =>
                props.onSetStepModel(
                  props.workflowPromptId,
                  mode === "auto"
                    ? null
                    : createModelSelection(
                        props.rootModelSelection.instanceId,
                        props.rootModelSelection.model,
                      ),
                )
              }
              className={cn(
                "cursor-pointer flex-1 rounded-[5px] px-2 py-1 text-xs font-medium",
                selected
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {label}
            </button>
          );
        })}
      </div>
      {props.pinnedSelection === null ? (
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Runs on the model this workflow was started with (
          {describeSelection(props.rootModelSelection)}).
        </p>
      ) : (
        <ProviderModelPicker
          activeInstanceId={activeSelection.instanceId}
          model={activeSelection.model}
          lockedProvider={null}
          instanceEntries={instanceEntries}
          modelOptionsByInstance={modelOptionsByInstance}
          triggerVariant="outline"
          triggerClassName="w-full justify-between text-foreground/90 hover:text-foreground"
          triggerAriaLabel={`Model for ${props.stepLabel}`}
          onInstanceModelChange={(instanceId: ProviderInstanceId, model: string) => {
            props.onSetStepModel(props.workflowPromptId, createModelSelection(instanceId, model));
          }}
        />
      )}
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
  readonly pinnedSelection: ModelSelection | null;
  /** True when the step's work happens in the workflow's main thread. */
  readonly usesRootThread: boolean;
  readonly rootModelSelection: ModelSelection;
  readonly restartLabel: string;
  readonly restartDisabledReason: string | null;
  readonly runningThreadIds: readonly ThreadId[];
  readonly onSetStepModel:
    | ((workflowPromptId: string, selection: ModelSelection | null) => void)
    | undefined;
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
              pinnedSelection={props.pinnedSelection}
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
