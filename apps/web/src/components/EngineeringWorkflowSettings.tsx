import type {
  ImplementationWorkflowSettings,
  ModelSelection,
  WorkflowStepCycleOverride,
  WorkflowStepReviewPartsOverride,
} from "@t3tools/contracts";
import {
  resolveLayeredAppReviewStepParts,
  type AppReviewParts,
} from "@t3tools/shared/appReviewParts";
import { ChevronDownIcon, ChevronRightIcon, PlusIcon, XIcon } from "lucide-react";
import { useState } from "react";

import {
  engineeringWorkflowDefaultSteps,
  skippableImplementationSettingForStep,
  type EngineeringWorkflowDefaultStep,
} from "./settings/workflowStepModelDefaults";
import {
  WorkflowModelPinControls,
  type SetWorkflowStepModel,
  type WorkflowModelChoices,
  type WorkflowModelPinKey,
} from "./WorkflowModelPins";
import { WorkflowModelQuickPins, type SetWorkflowStepModels } from "./WorkflowModelQuickPins";
import { WorkflowStepCyclePins, type SetWorkflowStepCycles } from "./WorkflowStepCycles";
import type { SetWorkflowStepReviewParts } from "./WorkflowStepReviewParts";
import { Button } from "./ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "./ui/collapsible";

type AppReviewPhaseControl = {
  readonly label: string;
  readonly key: WorkflowModelPinKey;
  readonly note: string;
} & ({ readonly part: null } | { readonly part: keyof AppReviewParts; readonly addLabel: string });

const TDD_STEP_KEY = { workflowPromptId: "implementation.tdd.codex" } as const;
const TICKET_APP_REVIEW_KEY = {
  workflowPromptId: "implementation.browser-app-review.codex",
  stepWorkflowPromptId: "implementation.tdd.codex",
} as const;
const TICKET_CODE_REVIEW_KEY = {
  workflowPromptId: "implementation.code-review.codex",
  stepWorkflowPromptId: "implementation.tdd.codex",
} as const;
const APP_REVIEW_KEY = {
  workflowPromptId: "implementation.browser-app-review.codex",
} as const;
const TICKET_APP_REVIEW_PHASES = [
  {
    label: "End-to-end test",
    addLabel: "Add end-to-end test step",
    part: "e2e",
    key: {
      workflowPromptId: "implementation.e2e-app-review.codex",
      stepWorkflowPromptId: "implementation.tdd.codex",
    },
    note: "runs the project's e2e commands when t3.json declares them",
  },
  {
    label: "Browser LLM review",
    addLabel: "Add browser LLM review step",
    part: "browser",
    key: TICKET_APP_REVIEW_KEY,
    note: "the quick assignment at the top sets this expensive ticket review thread",
  },
  {
    label: "Gap analysis and repair tickets",
    part: null,
    key: {
      workflowPromptId: "matt-pocock.to-tickets",
      stepWorkflowPromptId: "implementation.tdd.codex",
    },
    note: "turns each actionable ticket finding into a repair ticket",
  },
  {
    label: "Repair implementation",
    part: null,
    key: {
      workflowPromptId: "matt-pocock.implement",
      stepWorkflowPromptId: "implementation.tdd.codex",
    },
    note: "implements the ticket repair work before the next review cycle",
  },
] as const satisfies ReadonlyArray<AppReviewPhaseControl>;
const APP_REVIEW_PHASES = [
  {
    label: "End-to-end test",
    addLabel: "Add end-to-end test step",
    part: "e2e",
    key: {
      workflowPromptId: "implementation.e2e-app-review.codex",
      stepWorkflowPromptId: "implementation.browser-app-review.codex",
    },
    note: "runs the project's e2e commands when t3.json declares them",
  },
  {
    label: "Browser LLM review",
    addLabel: "Add browser LLM review step",
    part: "browser",
    key: {
      workflowPromptId: "implementation.browser-app-review.codex",
      stepWorkflowPromptId: "implementation.browser-app-review.codex",
    },
    note: "the quick assignment at the top sets this expensive review thread",
  },
  {
    label: "Gap analysis and repair tickets",
    part: null,
    key: {
      workflowPromptId: "matt-pocock.to-tickets",
      stepWorkflowPromptId: "implementation.browser-app-review.codex",
    },
    note: "turns each actionable finding into a repair ticket",
  },
  {
    label: "Repair implementation",
    part: null,
    key: {
      workflowPromptId: "matt-pocock.implement",
      stepWorkflowPromptId: "implementation.browser-app-review.codex",
    },
    note: "implements the repair tickets before the next review cycle",
  },
] as const satisfies ReadonlyArray<AppReviewPhaseControl>;

export interface EngineeringWorkflowSettingsProps {
  readonly preset: "quick-plan" | "fast-plan" | "planning" | "fast-engineering";
  readonly pinFor: (key: WorkflowModelPinKey) => ModelSelection | null;
  readonly defaultPinFor?: ((key: WorkflowModelPinKey) => ModelSelection | null) | undefined;
  readonly rootModelSelection: ModelSelection;
  readonly rootLabel: string;
  readonly choices: WorkflowModelChoices;
  readonly onSetStepModel: SetWorkflowStepModel;
  readonly onSetStepModels: SetWorkflowStepModels;
  readonly stepCycles: ReadonlyArray<WorkflowStepCycleOverride>;
  readonly defaultStepCycles?: ReadonlyArray<WorkflowStepCycleOverride> | undefined;
  readonly onSetStepCycles: SetWorkflowStepCycles;
  readonly stepReviewParts: ReadonlyArray<WorkflowStepReviewPartsOverride>;
  readonly defaultStepReviewParts?: ReadonlyArray<WorkflowStepReviewPartsOverride> | undefined;
  readonly onSetStepReviewParts: SetWorkflowStepReviewParts;
  readonly implementationSettings?: ImplementationWorkflowSettings | undefined;
  readonly onSetImplementationSettings?:
    | ((settings: ImplementationWorkflowSettings) => void)
    | undefined;
  readonly implementationSettingsScope?: "defaults" | "run" | undefined;
}

function implementationStepEnabled(
  props: EngineeringWorkflowSettingsProps,
  target: EngineeringWorkflowDefaultStep,
): boolean {
  const setting = skippableImplementationSettingForStep(target);
  return setting === null || props.implementationSettings?.[setting] !== false;
}

function setImplementationStepEnabled(
  props: EngineeringWorkflowSettingsProps,
  target: EngineeringWorkflowDefaultStep,
  enabled: boolean,
): void {
  const setting = skippableImplementationSettingForStep(target);
  const implementationSettings = props.implementationSettings;
  const onSetImplementationSettings = props.onSetImplementationSettings;
  if (
    setting === null ||
    implementationSettings === undefined ||
    onSetImplementationSettings === undefined
  ) {
    return;
  }
  const next = { ...implementationSettings, [setting]: enabled };
  if (setting === "pullRequestCreationEnabled" && !enabled) {
    next.pullRequestBabysittingEnabled = false;
  }
  if (setting === "pullRequestBabysittingEnabled" && enabled) {
    next.pullRequestCreationEnabled = true;
  }
  onSetImplementationSettings(next);
}

function StepModelControl(props: {
  readonly label: string;
  readonly note?: string | undefined;
  readonly pinKey: WorkflowModelPinKey;
  readonly pinFor: (key: WorkflowModelPinKey) => ModelSelection | null;
  readonly inheritedSelection: ModelSelection;
  readonly inheritedLabel: string;
  readonly choices: WorkflowModelChoices;
  readonly onSetStepModel: SetWorkflowStepModel;
  readonly indented?: boolean | undefined;
}) {
  return (
    <WorkflowModelPinControls
      pinKey={props.pinKey}
      label={props.label}
      note={props.note}
      pinnedSelection={props.pinFor(props.pinKey)}
      inheritedSelection={props.inheritedSelection}
      inheritedLabel={props.inheritedLabel}
      choices={props.choices}
      onSetStepModel={props.onSetStepModel}
      {...(props.indented === undefined ? {} : { indented: props.indented })}
    />
  );
}

function effectiveSelection(
  props: Pick<EngineeringWorkflowSettingsProps, "pinFor" | "defaultPinFor" | "rootModelSelection">,
  key: WorkflowModelPinKey,
): ModelSelection {
  const exact = props.pinFor(key) ?? props.defaultPinFor?.(key);
  if (exact !== null && exact !== undefined) return exact;
  if (key.stepWorkflowPromptId !== undefined) {
    const stepKey = { workflowPromptId: key.stepWorkflowPromptId };
    const step = props.pinFor(stepKey) ?? props.defaultPinFor?.(stepKey);
    if (step !== null && step !== undefined) return step;
  }
  return props.rootModelSelection;
}

function inheritedSelection(
  props: EngineeringWorkflowSettingsProps,
  key: WorkflowModelPinKey,
  fallback: ModelSelection,
): ModelSelection {
  return props.defaultPinFor?.(key) ?? fallback;
}

function AppReviewPhaseControls(
  props: EngineeringWorkflowSettingsProps & {
    readonly phases: ReadonlyArray<AppReviewPhaseControl>;
    readonly reviewKey: WorkflowModelPinKey;
    readonly reviewSelection: ModelSelection;
    readonly inheritedLabel: string;
  },
) {
  const parts = resolveLayeredAppReviewStepParts({
    threadOverrides: props.stepReviewParts,
    settingsOverrides: props.defaultStepReviewParts,
    key: props.reviewKey,
  });
  const setPart = (part: keyof AppReviewParts, enabled: boolean) => {
    props.onSetStepReviewParts(props.reviewKey, { ...parts, [part]: enabled });
  };

  return (
    <ol className="divide-y divide-border/60 overflow-hidden rounded-md border border-border/60">
      {props.phases.map((phase, index) => {
        if (phase.part !== null && !parts[phase.part]) {
          return (
            <li key={phase.label} className="p-3">
              <button
                type="button"
                className="cursor-pointer flex min-h-6 items-center gap-1 text-left text-xs font-medium text-muted-foreground hover:text-foreground"
                onClick={() => setPart(phase.part, true)}
              >
                <PlusIcon aria-hidden="true" className="size-3.5" />
                {phase.addLabel}
              </button>
            </li>
          );
        }
        return (
          <li key={phase.label} className="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-2 p-3">
            <span className="flex size-6 items-center justify-center rounded-full bg-muted text-[11px] font-semibold text-muted-foreground">
              {index + 1}
            </span>
            <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-2">
              <StepModelControl
                label={phase.label}
                note={phase.note}
                pinKey={phase.key}
                pinFor={props.pinFor}
                inheritedSelection={inheritedSelection(props, phase.key, props.reviewSelection)}
                inheritedLabel={props.inheritedLabel}
                choices={props.choices}
                onSetStepModel={props.onSetStepModel}
              />
              {phase.part === null ? null : (
                <Button
                  aria-label={`Remove ${phase.label} step`}
                  className="-mr-1 -mt-1"
                  onClick={() => setPart(phase.part, false)}
                  size="icon-micro"
                  title={`Remove ${phase.label} step`}
                  variant="ghost-muted"
                >
                  <XIcon aria-hidden="true" />
                </Button>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function EngineeringWorkflowStepControls(
  props: EngineeringWorkflowSettingsProps & {
    readonly target: EngineeringWorkflowDefaultStep;
    readonly workflowPromptId: string;
  },
) {
  const rootLabel = props.rootLabel;
  const implementationSettings = props.implementationSettings;
  const onSetImplementationSettings = props.onSetImplementationSettings;
  if (
    props.workflowPromptId === TDD_STEP_KEY.workflowPromptId &&
    props.target.label === "Execute ticket waves"
  ) {
    const implementationSelection = effectiveSelection(props, TDD_STEP_KEY);
    const ticketReviewSelection = effectiveSelection(props, TICKET_APP_REVIEW_KEY);
    const ticketAppReviewEnabled = implementationSettings?.ticketAppReviewEnabled !== false;
    return (
      <div className="divide-y divide-border/60 overflow-hidden rounded-md border border-border/60">
        <div className="p-3">
          <StepModelControl
            label="Implementation worker"
            note="implements one ticket in its own child thread"
            pinKey={TDD_STEP_KEY}
            pinFor={props.pinFor}
            inheritedSelection={inheritedSelection(props, TDD_STEP_KEY, props.rootModelSelection)}
            inheritedLabel={rootLabel}
            choices={props.choices}
            onSetStepModel={props.onSetStepModel}
          />
        </div>
        {ticketAppReviewEnabled ? (
          <div className="space-y-3 p-3">
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="text-xs font-medium text-foreground">Ticket App Review</div>
                <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                  Runs before the ticket's Code Review. Each step can use its own model.
                </p>
              </div>
              {implementationSettings && onSetImplementationSettings ? (
                <Button
                  aria-label="Remove Ticket App Review"
                  className="-mr-1 -mt-1"
                  onClick={() =>
                    onSetImplementationSettings({
                      ...implementationSettings,
                      ticketAppReviewEnabled: false,
                    })
                  }
                  size="icon-micro"
                  title="Remove Ticket App Review"
                  variant="ghost-muted"
                >
                  <XIcon aria-hidden="true" />
                </Button>
              ) : null}
            </div>
            <WorkflowStepCyclePins
              workflowPromptId={TDD_STEP_KEY.workflowPromptId}
              subStepWorkflowPromptIds={[TICKET_APP_REVIEW_KEY.workflowPromptId]}
              overrides={props.stepCycles}
              defaults={props.defaultStepCycles}
              inheritedLabel="Runs the built-in number of cycles"
              onSetStepCycles={props.onSetStepCycles}
              showHeading={false}
            />
            <AppReviewPhaseControls
              {...props}
              phases={TICKET_APP_REVIEW_PHASES}
              reviewKey={TICKET_APP_REVIEW_KEY}
              reviewSelection={ticketReviewSelection}
              inheritedLabel={`Follows the ticket review default (${props.choices.describeSelection(ticketReviewSelection)})`}
            />
          </div>
        ) : (
          <button
            type="button"
            className="cursor-pointer flex min-h-12 w-full items-center gap-1 p-3 text-left text-xs font-medium text-muted-foreground hover:bg-accent/40 hover:text-foreground"
            onClick={() =>
              implementationSettings &&
              onSetImplementationSettings?.({
                ...implementationSettings,
                ticketAppReviewEnabled: true,
              })
            }
          >
            <PlusIcon aria-hidden="true" className="size-3.5" />
            Add Ticket App Review
          </button>
        )}
        <div className="grid gap-4 p-3 sm:grid-cols-2">
          <StepModelControl
            label="Ticket Code Review"
            note="reviews the ticket after implementation and App Review"
            pinKey={TICKET_CODE_REVIEW_KEY}
            pinFor={props.pinFor}
            inheritedSelection={inheritedSelection(
              props,
              TICKET_CODE_REVIEW_KEY,
              implementationSelection,
            )}
            inheritedLabel={`Follows the implementation step (${props.choices.describeSelection(implementationSelection)})`}
            choices={props.choices}
            onSetStepModel={props.onSetStepModel}
          />
          <WorkflowStepCyclePins
            workflowPromptId={TDD_STEP_KEY.workflowPromptId}
            subStepWorkflowPromptIds={[TICKET_CODE_REVIEW_KEY.workflowPromptId]}
            overrides={props.stepCycles}
            defaults={props.defaultStepCycles}
            inheritedLabel="Runs the built-in number of cycles"
            onSetStepCycles={props.onSetStepCycles}
            showHeading={false}
          />
        </div>
      </div>
    );
  }

  if (props.workflowPromptId === APP_REVIEW_KEY.workflowPromptId) {
    const appReviewSelection = effectiveSelection(props, APP_REVIEW_KEY);
    return (
      <div className="space-y-3 rounded-md border border-border/60 p-3">
        <div className="grid gap-4 sm:grid-cols-2">
          <StepModelControl
            label="App Review default"
            note="the fallback for App Review steps that do not have their own model"
            pinKey={APP_REVIEW_KEY}
            pinFor={props.pinFor}
            inheritedSelection={inheritedSelection(props, APP_REVIEW_KEY, props.rootModelSelection)}
            inheritedLabel={rootLabel}
            choices={props.choices}
            onSetStepModel={props.onSetStepModel}
          />
          <WorkflowStepCyclePins
            workflowPromptId={APP_REVIEW_KEY.workflowPromptId}
            subStepWorkflowPromptIds={[]}
            overrides={props.stepCycles}
            defaults={props.defaultStepCycles}
            inheritedLabel="Runs the built-in number of cycles"
            onSetStepCycles={props.onSetStepCycles}
            showHeading={false}
          />
        </div>
        <AppReviewPhaseControls
          {...props}
          phases={APP_REVIEW_PHASES}
          reviewKey={APP_REVIEW_KEY}
          reviewSelection={appReviewSelection}
          inheritedLabel={`Follows the App Review default (${props.choices.describeSelection(appReviewSelection)})`}
        />
      </div>
    );
  }

  const pinKey = { workflowPromptId: props.workflowPromptId };
  return (
    <div className="space-y-3">
      <StepModelControl
        label={props.target.label}
        note={props.target.note}
        pinKey={pinKey}
        pinFor={props.pinFor}
        inheritedSelection={inheritedSelection(props, pinKey, props.rootModelSelection)}
        inheritedLabel={rootLabel}
        choices={props.choices}
        onSetStepModel={props.onSetStepModel}
      />
      <WorkflowStepCyclePins
        workflowPromptId={props.workflowPromptId}
        subStepWorkflowPromptIds={[]}
        overrides={props.stepCycles}
        defaults={props.defaultStepCycles}
        inheritedLabel="Runs the built-in number of cycles"
        onSetStepCycles={props.onSetStepCycles}
        className="space-y-2 border-t border-border/60 pt-3"
      />
    </div>
  );
}

function EngineeringWorkflowStepRow(
  props: EngineeringWorkflowSettingsProps & { readonly target: EngineeringWorkflowDefaultStep },
) {
  const [open, setOpen] = useState(false);
  const { target } = props;
  const enabled = implementationStepEnabled(props, target);
  const configurable = target.modelMode === "configurable" && target.workflowPromptId !== undefined;
  const setting = skippableImplementationSettingForStep(target);
  const canChangeEnabled =
    setting !== null &&
    props.implementationSettings !== undefined &&
    props.onSetImplementationSettings !== undefined;

  if (!enabled && canChangeEnabled) {
    return (
      <div
        data-engineering-workflow-step={target.number}
        className="border-t border-border/60 p-3 first:border-t-0"
      >
        <button
          type="button"
          className="cursor-pointer flex min-h-7 items-center gap-1 text-left text-xs font-medium text-muted-foreground hover:text-foreground"
          onClick={() => setImplementationStepEnabled(props, target, true)}
        >
          <PlusIcon aria-hidden="true" className="size-3.5" />
          Add {target.label}
        </button>
      </div>
    );
  }

  const summary =
    target.modelMode === "none"
      ? "Automatic"
      : target.modelMode === "workflow" || target.workflowPromptId === undefined
        ? props.choices.describeSelection(props.rootModelSelection)
        : props.choices.describeSelection(
            effectiveSelection(props, { workflowPromptId: target.workflowPromptId }),
          );

  if (!configurable) {
    return (
      <div
        data-engineering-workflow-step={target.number}
        className="grid grid-cols-[1.75rem_minmax(0,1fr)_auto] gap-2 border-t border-border/60 p-3 first:border-t-0"
      >
        <span className="flex size-7 items-center justify-center rounded-full bg-muted text-xs font-semibold text-muted-foreground">
          {target.number}
        </span>
        <div className="min-w-0 self-center">
          <div className="truncate text-xs font-medium text-foreground">{target.label}</div>
          <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{summary}</div>
        </div>
        {canChangeEnabled ? (
          <Button
            aria-label={`Remove ${target.label}`}
            onClick={() => setImplementationStepEnabled(props, target, false)}
            size="icon-micro"
            title={`Remove ${target.label}`}
            variant="ghost-muted"
          >
            <XIcon aria-hidden="true" />
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <Collapsible
      data-engineering-workflow-step={target.number}
      onOpenChange={setOpen}
      open={open}
      className="border-t border-border/60 first:border-t-0"
    >
      <div className="grid grid-cols-[1.75rem_minmax(0,1fr)_auto] items-center gap-2 p-3">
        <span className="flex size-7 items-center justify-center rounded-full bg-muted text-xs font-semibold text-muted-foreground">
          {target.number}
        </span>
        <CollapsibleTrigger className="flex min-w-0 items-center gap-2 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring">
          {open ? (
            <ChevronDownIcon
              aria-hidden="true"
              className="size-3.5 shrink-0 text-muted-foreground"
            />
          ) : (
            <ChevronRightIcon
              aria-hidden="true"
              className="size-3.5 shrink-0 text-muted-foreground"
            />
          )}
          <span className="min-w-0">
            <span className="block truncate text-xs font-medium text-foreground">
              {target.label}
            </span>
            <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
              {summary}
            </span>
          </span>
        </CollapsibleTrigger>
        {canChangeEnabled ? (
          <Button
            aria-label={`Remove ${target.label}`}
            onClick={() => {
              setOpen(false);
              setImplementationStepEnabled(props, target, false);
            }}
            size="icon-micro"
            title={`Remove ${target.label}`}
            variant="ghost-muted"
          >
            <XIcon aria-hidden="true" />
          </Button>
        ) : null}
      </div>
      <CollapsiblePanel>
        <div className="border-t border-border/60 px-3 pb-3 pt-3 sm:pl-[3.75rem]">
          <EngineeringWorkflowStepControls
            {...props}
            target={target}
            workflowPromptId={target.workflowPromptId}
          />
        </div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

function WorkflowPhaseSection(
  props: EngineeringWorkflowSettingsProps & {
    readonly label: string;
    readonly targets: ReadonlyArray<EngineeringWorkflowDefaultStep>;
  },
) {
  const [open, setOpen] = useState(false);
  const enabledCount = props.targets.filter((target) =>
    implementationStepEnabled(props, target),
  ).length;
  const stepNoun = props.targets.length === 1 ? "step" : "steps";
  const summary =
    enabledCount === props.targets.length
      ? `${props.targets.length} ${stepNoun}`
      : `${enabledCount} of ${props.targets.length} ${stepNoun} added`;

  return (
    <Collapsible
      className="max-w-lg overflow-hidden rounded-lg border border-border/70"
      onOpenChange={setOpen}
      open={open}
    >
      <CollapsibleTrigger className="flex min-h-12 w-full items-center gap-2 px-3 text-left outline-none hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
        {open ? (
          <ChevronDownIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRightIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1">
          <span className="block text-xs font-semibold text-foreground">{props.label}</span>
          <span className="mt-0.5 block text-[11px] text-muted-foreground">{summary}</span>
        </span>
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <div className="border-t border-border/60">
          {props.targets.map((target) => (
            <EngineeringWorkflowStepRow {...props} key={target.number} target={target} />
          ))}
        </div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

function WorkflowModelSetup(
  props: EngineeringWorkflowSettingsProps & {
    readonly effectivePinFor: (key: WorkflowModelPinKey) => ModelSelection;
  },
) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible
      className="max-w-lg overflow-hidden rounded-lg border border-border/70"
      onOpenChange={setOpen}
      open={open}
    >
      <CollapsibleTrigger className="flex min-h-12 w-full items-center gap-2 px-3 text-left outline-none hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
        {open ? (
          <ChevronDownIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRightIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0">
          <span className="block text-xs font-semibold text-foreground">Model setup</span>
          <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
            Preselected workflow and review models
          </span>
        </span>
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <div className="border-t border-border/60 p-3">
          <WorkflowModelQuickPins
            preset={props.preset}
            pinFor={props.pinFor}
            selectionFor={props.effectivePinFor}
            rootModelSelection={props.rootModelSelection}
            rootLabel={props.rootLabel}
            choices={props.choices}
            onSetStepModels={props.onSetStepModels}
          />
        </div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

export function EngineeringWorkflowSettings(props: EngineeringWorkflowSettingsProps) {
  const targets = engineeringWorkflowDefaultSteps(props.preset);
  const effectivePinFor = (key: WorkflowModelPinKey) => effectiveSelection(props, key);
  return (
    <div className="space-y-3">
      <WorkflowModelSetup {...props} effectivePinFor={effectivePinFor} />
      {(
        [
          { id: "planning", label: "Planning phase" },
          { id: "implementation", label: "Implementation phase" },
        ] as const
      ).map((phase) => (
        <WorkflowPhaseSection
          {...props}
          key={phase.id}
          label={phase.label}
          targets={targets.filter((target) => target.phase === phase.id)}
        />
      ))}
    </div>
  );
}
