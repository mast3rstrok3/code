import type {
  ModelSelection,
  WorkflowStepCycleOverride,
  WorkflowStepReviewPartsOverride,
} from "@t3tools/contracts";

import {
  engineeringWorkflowDefaultSteps,
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
import {
  WorkflowStepReviewPartPins,
  type SetWorkflowStepReviewParts,
} from "./WorkflowStepReviewParts";

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
    label: "E2E tests and browser review",
    key: TICKET_APP_REVIEW_KEY,
    note: "the quick assignment at the top sets this expensive ticket review thread",
  },
  {
    label: "Gap analysis and repair tickets",
    key: {
      workflowPromptId: "matt-pocock.to-tickets",
      stepWorkflowPromptId: "implementation.tdd.codex",
    },
    note: "turns each actionable ticket finding into a repair ticket",
  },
  {
    label: "Repair implementation",
    key: {
      workflowPromptId: "matt-pocock.implement",
      stepWorkflowPromptId: "implementation.tdd.codex",
    },
    note: "implements the ticket repair work before the next review cycle",
  },
] as const;
const APP_REVIEW_PHASES = [
  {
    label: "E2E tests and browser review",
    key: {
      workflowPromptId: "implementation.browser-app-review.codex",
      stepWorkflowPromptId: "implementation.browser-app-review.codex",
    },
    note: "the quick assignment at the top sets this expensive review thread",
  },
  {
    label: "Gap analysis and repair tickets",
    key: {
      workflowPromptId: "matt-pocock.to-tickets",
      stepWorkflowPromptId: "implementation.browser-app-review.codex",
    },
    note: "turns each actionable finding into a repair ticket",
  },
  {
    label: "Repair implementation",
    key: {
      workflowPromptId: "matt-pocock.implement",
      stepWorkflowPromptId: "implementation.browser-app-review.codex",
    },
    note: "implements the repair tickets before the next review cycle",
  },
] as const;

export interface EngineeringWorkflowSettingsProps {
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

function EngineeringWorkflowStepControls(
  props: EngineeringWorkflowSettingsProps & {
    readonly target: EngineeringWorkflowDefaultStep;
    readonly workflowPromptId: string;
  },
) {
  const rootLabel = props.rootLabel;
  if (props.workflowPromptId === TDD_STEP_KEY.workflowPromptId) {
    const implementationSelection = effectiveSelection(props, TDD_STEP_KEY);
    const ticketReviewSelection = effectiveSelection(props, TICKET_APP_REVIEW_KEY);
    return (
      <div className="space-y-3">
        <div className="text-xs font-semibold text-foreground">{props.target.label}</div>
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
          <div className="space-y-3 p-3">
            <div>
              <div className="text-xs font-medium text-foreground">Ticket App Review</div>
              <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                Runs before the ticket's Code Review. Each phase can use its own model.
              </p>
            </div>
            <div className="grid gap-4 border-t border-border/60 pt-3 sm:grid-cols-2">
              <StepModelControl
                label={TICKET_APP_REVIEW_PHASES[0].label}
                note={TICKET_APP_REVIEW_PHASES[0].note}
                pinKey={TICKET_APP_REVIEW_PHASES[0].key}
                pinFor={props.pinFor}
                inheritedSelection={inheritedSelection(
                  props,
                  TICKET_APP_REVIEW_PHASES[0].key,
                  implementationSelection,
                )}
                inheritedLabel={`Follows the implementation step (${props.choices.describeSelection(implementationSelection)})`}
                choices={props.choices}
                onSetStepModel={props.onSetStepModel}
                indented
              />
              <WorkflowStepCyclePins
                workflowPromptId={TDD_STEP_KEY.workflowPromptId}
                subStepWorkflowPromptIds={[TICKET_APP_REVIEW_KEY.workflowPromptId]}
                overrides={props.stepCycles}
                defaults={props.defaultStepCycles}
                inheritedLabel="Runs the built-in number of cycles"
                onSetStepCycles={props.onSetStepCycles}
                showHeading={false}
              />
            </div>
            <div className="space-y-3 border-t border-border/60 pt-3">
              {TICKET_APP_REVIEW_PHASES.slice(1).map((phase) => (
                <StepModelControl
                  key={phase.label}
                  label={phase.label}
                  note={phase.note}
                  pinKey={phase.key}
                  pinFor={props.pinFor}
                  inheritedSelection={inheritedSelection(props, phase.key, ticketReviewSelection)}
                  inheritedLabel={`Follows the ticket review thread (${props.choices.describeSelection(ticketReviewSelection)})`}
                  choices={props.choices}
                  onSetStepModel={props.onSetStepModel}
                  indented
                />
              ))}
            </div>
            <WorkflowStepReviewPartPins
              workflowPromptId={TDD_STEP_KEY.workflowPromptId}
              subStepWorkflowPromptIds={[TICKET_APP_REVIEW_KEY.workflowPromptId]}
              overrides={props.stepReviewParts}
              defaults={props.defaultStepReviewParts}
              onSetStepReviewParts={props.onSetStepReviewParts}
              className="space-y-2 border-t border-border/60 pt-3"
            />
          </div>
          <div className="p-3">
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
          </div>
        </div>
      </div>
    );
  }

  if (props.workflowPromptId === APP_REVIEW_KEY.workflowPromptId) {
    const appReviewSelection = effectiveSelection(props, APP_REVIEW_KEY);
    return (
      <div className="space-y-3">
        <div className="text-xs font-semibold text-foreground">{props.target.label}</div>
        <div className="space-y-3 rounded-md border border-border/60 p-3">
          <div className="grid gap-4 sm:grid-cols-2">
            <StepModelControl
              label="App Review default"
              note="the fallback for App Review phases that do not have their own model"
              pinKey={APP_REVIEW_KEY}
              pinFor={props.pinFor}
              inheritedSelection={inheritedSelection(
                props,
                APP_REVIEW_KEY,
                props.rootModelSelection,
              )}
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
          <div className="space-y-3 border-t border-border/60 pt-3">
            {APP_REVIEW_PHASES.map((phase) => (
              <StepModelControl
                key={phase.label}
                label={phase.label}
                note={phase.note}
                pinKey={phase.key}
                pinFor={props.pinFor}
                inheritedSelection={inheritedSelection(props, phase.key, appReviewSelection)}
                inheritedLabel={`Follows the App Review default (${props.choices.describeSelection(appReviewSelection)})`}
                choices={props.choices}
                onSetStepModel={props.onSetStepModel}
                indented
              />
            ))}
          </div>
          <WorkflowStepReviewPartPins
            workflowPromptId={APP_REVIEW_KEY.workflowPromptId}
            subStepWorkflowPromptIds={APP_REVIEW_PHASES.map((phase) => phase.key.workflowPromptId)}
            overrides={props.stepReviewParts}
            defaults={props.defaultStepReviewParts}
            onSetStepReviewParts={props.onSetStepReviewParts}
            className="space-y-2 border-t border-border/60 pt-3"
          />
        </div>
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

export function EngineeringWorkflowSettings(props: EngineeringWorkflowSettingsProps) {
  const targets = engineeringWorkflowDefaultSteps();
  const effectivePinFor = (key: WorkflowModelPinKey) => effectiveSelection(props, key);
  return (
    <div className="space-y-5">
      <div className="max-w-lg">
        <WorkflowModelQuickPins
          preset="planning"
          pinFor={props.pinFor}
          selectionFor={effectivePinFor}
          rootModelSelection={props.rootModelSelection}
          rootLabel={props.rootLabel}
          choices={props.choices}
          onSetStepModels={props.onSetStepModels}
        />
      </div>
      {(
        [
          { id: "planning", label: "Planning" },
          { id: "ticket-review", label: "Ticket review" },
          { id: "implementation", label: "Implementation" },
        ] as const
      ).map((phase) => (
        <section key={phase.id} className="max-w-lg space-y-2">
          <h3 className="text-xs font-semibold text-foreground">{phase.label}</h3>
          <div className="overflow-hidden rounded-lg border border-border/70">
            {targets
              .filter((target) => target.phase === phase.id)
              .map((target) => (
                <div
                  key={target.number}
                  data-engineering-workflow-step={target.number}
                  className="grid grid-cols-[1.75rem_minmax(0,1fr)] gap-2 border-t border-border/60 p-3 first:border-t-0"
                >
                  <span className="flex size-7 items-center justify-center rounded-full bg-muted text-xs font-semibold text-muted-foreground">
                    {target.number}
                  </span>
                  {target.modelMode === "configurable" && target.workflowPromptId ? (
                    <EngineeringWorkflowStepControls
                      {...props}
                      target={target}
                      workflowPromptId={target.workflowPromptId}
                    />
                  ) : (
                    <div className="min-w-0">
                      <div className="text-xs font-medium text-foreground">{target.label}</div>
                      <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                        {target.modelMode === "workflow"
                          ? "Uses the model selected when the workflow starts."
                          : "This automatic setup step does not run a model."}
                        {target.note === undefined ? "" : ` ${target.note}.`}
                      </p>
                    </div>
                  )}
                </div>
              ))}
          </div>
        </section>
      ))}
    </div>
  );
}
