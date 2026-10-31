import type { MenuAction } from "@react-native-menu/menu";
import type { EnvironmentId, ModelSelection, WorkflowPreset } from "@t3tools/contracts";
import {
  engineeringWorkflowDefaultSteps,
  type WorkflowModelPinKey,
} from "@t3tools/client-runtime/workflow-step-models";
import {
  WORKFLOW_PRESET_DEFINITION_BY_ID,
  workflowPresetStepCanPinModel,
  type WorkflowPresetSubStep,
} from "@t3tools/shared/workflowPresets";
import {
  findWorkflowStepCycleTarget,
  workflowStepCycleKeyId,
  type WorkflowStepCycleKey,
  type WorkflowStepCycleTarget,
} from "@t3tools/shared/workflowStepCycles";
import * as Haptics from "expo-haptics";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { ListSection } from "../../components/ui/ListSection";
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
  /** The budget this surface stores for a key; null means it inherits. */
  readonly cyclesFor: (key: WorkflowStepCycleKey) => number | null;
  readonly inheritedCycles: (key: WorkflowStepCycleKey) => number;
  readonly onSetCycles: (key: WorkflowStepCycleKey, maxCycles: number | null) => void;
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
        if (pinKeys.length === 0 && cycleTargets.length === 0) return null;
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
          </ListSection>
        );
      })}
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
    { id: "inherit", title: props.inheritedLabel, state: props.pinned === null ? "on" : "off" },
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
      value={
        props.pinned === null ? props.inheritedLabel : (pinnedOption?.label ?? props.pinned.model)
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
