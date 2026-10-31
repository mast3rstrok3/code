import type { MenuAction } from "@react-native-menu/menu";
import type { EnvironmentId, ModelSelection, WorkflowPreset } from "@t3tools/contracts";
import {
  resolveWorkflowModelQuickActionSelection,
  workflowModelQuickActions,
} from "@t3tools/client-runtime/workflow-model-quick-actions";
import {
  engineeringWorkflowDefaultSteps,
  type WorkflowModelPinKey,
} from "@t3tools/client-runtime/workflow-step-models";
import {
  APP_REVIEW_PARTS_TARGETS,
  describeAppReviewParts,
  REVIEW_TEST_PLATFORM_LABELS,
  REVIEW_TEST_PLATFORMS,
  resolveReviewTestPlatforms,
  type AppReviewParts,
  type AppReviewPartsTarget,
} from "@t3tools/shared/appReviewParts";
import {
  WORKFLOW_PRESET_DEFINITION_BY_ID,
  workflowPresetStepCanPinModel,
  type WorkflowPresetSubStep,
} from "@t3tools/shared/workflowPresets";
import {
  findWorkflowStepCycleTarget,
  workflowStepCycleKeyId,
  workflowStepCycleKeysEqual,
  type WorkflowStepCycleKey,
  type WorkflowStepCycleTarget,
} from "@t3tools/shared/workflowStepCycles";
import * as Haptics from "expo-haptics";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { ListSection } from "../../components/ui/ListSection";
import { ListToggleRow } from "../../components/ui/ListToggleRow";
import { Menu } from "../../components/ui/Menu";
import { buildModelOptions, groupByProvider } from "../../lib/modelOptions";
import { useEnvironmentServerConfig } from "../../state/entities";

/** One workflow step as the tuning screens list it. */
export interface WorkflowTuningStep {
  readonly label: string;
  readonly phase: string | null;
  /** Null for a step with no agent of its own. */
  readonly workflowPromptId: string | null;
  readonly subSteps: ReadonlyArray<WorkflowPresetSubStep>;
  /** Shared-thread steps run on the main thread's model. */
  readonly pinnable: boolean;
}

export function workflowTuningSteps(preset: WorkflowPreset): readonly WorkflowTuningStep[] {
  if (preset === "fast-plan" || preset === "planning") {
    return engineeringWorkflowDefaultSteps(preset).map((step) => ({
      label: step.label,
      phase: step.phase === "planning" ? "Planning" : "Implementation",
      workflowPromptId: step.workflowPromptId ?? null,
      subSteps: step.subSteps,
      pinnable: step.modelMode === "configurable",
    }));
  }
  return WORKFLOW_PRESET_DEFINITION_BY_ID[preset].helpSteps.map((step) => ({
    label: step.label,
    phase: null,
    workflowPromptId: step.skillId ?? null,
    subSteps: step.subSteps ?? [],
    pinnable: workflowPresetStepCanPinModel(preset, step),
  }));
}

export interface WorkflowTuningBinding {
  readonly environmentId: EnvironmentId;
  readonly disabled: boolean;
  /** The pin this surface stores for a key; null means it inherits. */
  readonly pinFor: (key: WorkflowModelPinKey) => ModelSelection | null;
  readonly inheritedModelLabel: string;
  readonly onSetPin: (key: WorkflowModelPinKey, selection: ModelSelection | null) => void;
  /** One choice for several pins, written together so no write overtakes another. */
  readonly onSetPins: (
    keys: ReadonlyArray<WorkflowModelPinKey>,
    selection: ModelSelection | null,
  ) => void;
  /** The budget this surface stores for a key; null means it inherits. */
  readonly cyclesFor: (key: WorkflowStepCycleKey) => number | null;
  readonly inheritedCycles: (key: WorkflowStepCycleKey) => number;
  readonly onSetCycles: (key: WorkflowStepCycleKey, maxCycles: number | null) => void;
  /** The parts a review runs for a key, after this surface's layers. */
  readonly reviewPartsFor: (key: WorkflowStepCycleKey) => AppReviewParts;
  /** Whether this surface stores its own parts for a key. */
  readonly hasReviewPartsOverride: (key: WorkflowStepCycleKey) => boolean;
  /** Null clears this surface's entry so the key inherits again. */
  readonly onSetReviewParts: (key: WorkflowStepCycleKey, parts: AppReviewParts | null) => void;
}

/** The App Review targets one step or its sub-steps start. */
function reviewPartsTargets(step: WorkflowTuningStep): readonly AppReviewPartsTarget[] {
  const promptId = step.workflowPromptId;
  if (promptId === null) return [];
  return APP_REVIEW_PARTS_TARGETS.filter(
    (target) =>
      workflowStepCycleKeysEqual(target.key, { workflowPromptId: promptId }) ||
      step.subSteps.some((subStep) =>
        workflowStepCycleKeysEqual(target.key, {
          workflowPromptId: subStep.workflowPromptId,
          stepWorkflowPromptId: promptId,
        }),
      ),
  );
}

/** Each step's model pins and cycle budgets, as grouped Settings rows with native menus. */
export function WorkflowStepTuningSections(props: {
  readonly steps: readonly WorkflowTuningStep[];
  readonly binding: WorkflowTuningBinding;
}) {
  const config = useEnvironmentServerConfig(props.binding.environmentId);
  const providerGroups = groupByProvider(buildModelOptions(config, null, undefined, null));
  return (
    <>
      {props.steps.map((step) => {
        const promptId = step.workflowPromptId;
        const pinKeys: { readonly label: string; readonly key: WorkflowModelPinKey }[] =
          promptId === null || !step.pinnable
            ? []
            : [
                { label: "Model", key: { workflowPromptId: promptId } },
                ...step.subSteps.map((subStep) => ({
                  label: subStep.label,
                  key: {
                    workflowPromptId: subStep.workflowPromptId,
                    stepWorkflowPromptId: promptId,
                  },
                })),
              ];
        const cycleTargets =
          promptId === null
            ? []
            : [
                findWorkflowStepCycleTarget({ workflowPromptId: promptId }),
                ...step.subSteps.map((subStep) =>
                  findWorkflowStepCycleTarget({
                    workflowPromptId: subStep.workflowPromptId,
                    stepWorkflowPromptId: promptId,
                  }),
                ),
              ].filter((target): target is WorkflowStepCycleTarget => target !== undefined);
        const partsTargets = reviewPartsTargets(step);
        if (pinKeys.length === 0 && cycleTargets.length === 0 && partsTargets.length === 0) {
          return null;
        }
        return (
          <ListSection
            key={`${step.phase ?? ""}:${step.label}:${step.workflowPromptId ?? ""}`}
            title={step.phase === null ? step.label : `${step.phase} · ${step.label}`}
          >
            {pinKeys.map((pin, pinIndex) => (
              <ModelPinRow
                key={`${pin.key.stepWorkflowPromptId ?? ""}:${pin.key.workflowPromptId}`}
                label={pin.label}
                separated={pinIndex > 0}
                pinned={props.binding.pinFor(pin.key)}
                inheritedLabel={props.binding.inheritedModelLabel}
                providerGroups={providerGroups}
                disabled={props.binding.disabled}
                onSelect={(selection) => props.binding.onSetPin(pin.key, selection)}
              />
            ))}
            {cycleTargets.map((target, targetIndex) => (
              <CyclesRow
                key={workflowStepCycleKeyId(target.key)}
                target={target}
                separated={pinKeys.length > 0 || targetIndex > 0}
                cycles={props.binding.cyclesFor(target.key)}
                inherited={props.binding.inheritedCycles(target.key)}
                disabled={props.binding.disabled}
                onSelect={(maxCycles) => props.binding.onSetCycles(target.key, maxCycles)}
              />
            ))}
            {partsTargets.map((target) => (
              <ReviewPartsRows
                key={workflowStepCycleKeyId(target.key)}
                target={target}
                binding={props.binding}
              />
            ))}
          </ListSection>
        );
      })}
    </>
  );
}

/**
 * The models the review roles run on wherever a workflow starts them, one
 * choice per role. A role with differing pins across its steps reads Mixed
 * until one choice overwrites them all.
 */
export function WorkflowReviewModelsSection(props: {
  /** Undefined lists the roles of every selectable workflow. */
  readonly preset: WorkflowPreset | null | undefined;
  readonly binding: WorkflowTuningBinding;
}) {
  const actions = workflowModelQuickActions(props.preset);
  const config = useEnvironmentServerConfig(props.binding.environmentId);
  if (actions.length === 0) return null;
  const providerGroups = groupByProvider(buildModelOptions(config, null, undefined, null));
  return (
    <ListSection
      title="Review models"
      footer="These reviews use the chosen model whatever model started the workflow. Tune single phases in the steps below."
    >
      {actions.map((action, index) => {
        const state = resolveWorkflowModelQuickActionSelection(
          action.pinKeys,
          props.binding.pinFor,
        );
        return (
          <ModelPinRow
            key={action.id}
            label={action.label}
            description={action.description}
            separated={index > 0}
            pinned={state.mixed ? null : state.selection}
            mixed={state.mixed}
            inheritedLabel={props.binding.inheritedModelLabel}
            providerGroups={providerGroups}
            disabled={props.binding.disabled}
            onSelect={(selection) => props.binding.onSetPins(action.pinKeys, selection)}
          />
        );
      })}
    </ListSection>
  );
}

/**
 * Whether a review runs its E2E tests and on which platforms. Turning E2E off
 * is a prohibition the server enforces: the review step is skipped.
 */
function ReviewPartsRows(props: {
  readonly target: AppReviewPartsTarget;
  readonly binding: WorkflowTuningBinding;
}) {
  const { target, binding } = props;
  const parts = binding.reviewPartsFor(target.key);
  const platforms = resolveReviewTestPlatforms(parts);
  const hasOverride = binding.hasReviewPartsOverride(target.key);
  return (
    <>
      <View className="border-t border-border-subtle">
        <ListToggleRow
          label={`${target.label} · E2E tests`}
          description={`${describeAppReviewParts(parts)}${parts.e2e ? "" : ". This review step is skipped"} · ${target.description}`}
          value={parts.e2e}
          disabled={binding.disabled}
          onValueChange={(e2e) => binding.onSetReviewParts(target.key, { ...parts, e2e })}
        />
      </View>
      <MenuRow
        label="E2E test platforms"
        description="Windows and Android can use configured runners from Linux. iOS and macOS need a Mac."
        value={platforms.map((platform) => REVIEW_TEST_PLATFORM_LABELS[platform]).join(", ")}
        separated
        disabled={binding.disabled}
        actions={[
          ...REVIEW_TEST_PLATFORMS.map((platform) => {
            const selected = platforms.includes(platform);
            return {
              id: `platform:${platform}`,
              title: REVIEW_TEST_PLATFORM_LABELS[platform],
              state: selected ? ("on" as const) : ("off" as const),
              // At least one platform stays selected.
              ...(selected && platforms.length === 1 ? { attributes: { disabled: true } } : {}),
            };
          }),
          ...(hasOverride
            ? [{ id: "auto", title: "Use the default parts", image: "arrow.uturn.backward" }]
            : []),
        ]}
        onAction={(id) => {
          if (id === "auto") {
            binding.onSetReviewParts(target.key, null);
            return;
          }
          const toggled = id.slice("platform:".length);
          const next = REVIEW_TEST_PLATFORMS.filter((platform) =>
            platform === toggled ? !platforms.includes(platform) : platforms.includes(platform),
          );
          const [first, ...rest] = next;
          if (first !== undefined) {
            binding.onSetReviewParts(target.key, { ...parts, testPlatforms: [first, ...rest] });
          }
        }}
      />
    </>
  );
}

function MenuRow(props: {
  readonly label: string;
  readonly value: string;
  readonly description?: string;
  readonly separated: boolean;
  readonly disabled: boolean;
  readonly actions: MenuAction[];
  readonly onAction: (id: string) => void;
}) {
  return (
    <Menu
      title={props.label}
      actions={props.actions}
      onPressAction={({ nativeEvent }) => {
        void Haptics.selectionAsync();
        props.onAction(nativeEvent.event);
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${props.label}, ${props.value}`}
        accessibilityHint={props.description}
        disabled={props.disabled}
        className={
          props.separated
            ? "min-h-14 flex-row items-center gap-3 border-t border-border-subtle px-4 py-3 active:opacity-70"
            : "min-h-14 flex-row items-center gap-3 px-4 py-3 active:opacity-70"
        }
        style={{ opacity: props.disabled ? 0.45 : 1 }}
      >
        <View className="min-w-0 flex-1 gap-0.5">
          <Text className="text-base text-foreground">{props.label}</Text>
          {props.description ? (
            <Text className="text-xs text-foreground-muted">{props.description}</Text>
          ) : null}
        </View>
        <Text numberOfLines={1} className="max-w-[45%] text-sm text-foreground-muted">
          {props.value}
        </Text>
        <SymbolView
          name="chevron.down"
          size={14}
          tintColorClassName="accent-chevron"
          type="monochrome"
        />
      </Pressable>
    </Menu>
  );
}

/** A single model pin row that loads its environment's model choices itself. */
export function WorkflowModelPinRow(
  props: Omit<Parameters<typeof ModelPinRow>[0], "providerGroups"> & {
    readonly environmentId: EnvironmentId;
  },
) {
  const config = useEnvironmentServerConfig(props.environmentId);
  return (
    <ModelPinRow
      {...props}
      providerGroups={groupByProvider(buildModelOptions(config, null, undefined, null))}
    />
  );
}

function ModelPinRow(props: {
  readonly label: string;
  readonly description?: string;
  /** The pins behind this row disagree, so no single model is selected. */
  readonly mixed?: boolean;
  readonly separated: boolean;
  readonly pinned: ModelSelection | null;
  readonly inheritedLabel: string;
  readonly providerGroups: ReturnType<typeof groupByProvider>;
  readonly disabled: boolean;
  readonly onSelect: (selection: ModelSelection | null) => void;
}) {
  const options = props.providerGroups.flatMap((group) => group.models);
  const pinnedOption =
    props.pinned === null
      ? null
      : options.find(
          (option) =>
            option.selection.instanceId === props.pinned?.instanceId &&
            option.selection.model === props.pinned.model,
        );
  const actions: MenuAction[] = [
    {
      id: "inherit",
      title: props.inheritedLabel,
      state: props.pinned === null && !props.mixed ? "on" : "off",
    },
    ...props.providerGroups.map((group) => ({
      id: `provider:${group.providerKey}`,
      title: group.providerLabel,
      subactions: group.models.map((option) => ({
        id: `model:${option.key}`,
        title: option.label,
        state: option === pinnedOption ? ("on" as const) : ("off" as const),
      })),
    })),
  ];
  return (
    <MenuRow
      label={props.label}
      {...(props.description === undefined ? {} : { description: props.description })}
      value={
        props.mixed
          ? "Mixed"
          : props.pinned === null
            ? props.inheritedLabel
            : (pinnedOption?.label ?? props.pinned.model)
      }
      separated={props.separated}
      disabled={props.disabled}
      actions={actions}
      onAction={(id) => {
        if (id === "inherit") {
          props.onSelect(null);
          return;
        }
        const option = options.find((candidate) => `model:${candidate.key}` === id);
        if (option !== undefined) props.onSelect(option.selection);
      }}
    />
  );
}

function CyclesRow(props: {
  readonly target: WorkflowStepCycleTarget;
  readonly separated: boolean;
  readonly cycles: number | null;
  readonly inherited: number;
  readonly disabled: boolean;
  readonly onSelect: (maxCycles: number | null) => void;
}) {
  const counts = Array.from({ length: props.target.maxCycles }, (_, index) => index + 1);
  return (
    <MenuRow
      label={props.target.label}
      description={props.target.description}
      value={props.cycles === null ? `Auto · ${props.inherited}` : String(props.cycles)}
      separated={props.separated}
      disabled={props.disabled}
      actions={[
        {
          id: "auto",
          title: `Auto · ${props.inherited}`,
          state: props.cycles === null ? "on" : "off",
        },
        ...counts.map((count) => ({
          id: `cycles:${count}`,
          title: String(count),
          state: props.cycles === count ? ("on" as const) : ("off" as const),
        })),
      ]}
      onAction={(id) => {
        if (id === "auto") {
          props.onSelect(null);
          return;
        }
        const count = Number.parseInt(id.slice("cycles:".length), 10);
        if (Number.isFinite(count)) props.onSelect(count);
      }}
    />
  );
}
