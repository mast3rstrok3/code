import {
  AuthSettingsWriteScope,
  DEFAULT_MAX_PARALLEL_APP_REVIEWS,
  DEFAULT_MAX_PARALLEL_TICKETS,
  MAX_PARALLEL_TICKETS,
  WORKFLOW_START_MODEL_PINS,
  type LaunchableWorkflow,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import {
  engineeringWorkflowDefaultSteps,
  setWorkflowStepModelDefault,
  skippableImplementationSettingForStep,
  standingWorkflowStepModel,
  type SkippableImplementationSetting,
} from "@t3tools/client-runtime/workflow-step-models";
import {
  resolveAppReviewStepParts,
  setWorkflowStepReviewPartsOverride,
} from "@t3tools/shared/appReviewParts";
import { workflowStartModel } from "@t3tools/shared/projectSettings";
import { normalizeImplementationWorkflowSettings } from "@t3tools/shared/workflowPresets";
import {
  resolveWorkflowStepCycleBudget,
  setWorkflowStepCycleOverride,
  workflowStepCycleKeysEqual,
} from "@t3tools/shared/workflowStepCycles";
import { useState } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { ListSection } from "../../components/ui/ListSection";
import { NumberField } from "../../components/ui/NumberField";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { readEnvironmentScope, useEnvironmentsWithScope } from "../../state/session";
import { GrillAnswererSection } from "../workflows/WorkflowRunSettingsSheet";
import {
  WorkflowModelPinRow,
  WorkflowReviewModelsSection,
  WorkflowStepTuningSections,
  workflowTuningSteps,
  type WorkflowTuningBinding,
} from "../workflows/WorkflowTuning";
import {
  AndroidSettingsEnvironmentFilter,
  SettingsEnvironmentFilterHeader,
} from "./components/SettingsEnvironmentFilterHeader";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { useSettingsEnvironmentFilter, type SettingsTarget } from "./settings-environment-filter";
import { resolveMobileSettingsTargets } from "./settings-scoped-server";
import { useSettingsWriter } from "./useSettingsWriter";

/** Feature's reviewers run in threads of their own, so only they take a model of their own. */
const FEATURE_REVIEW_STEPS = [
  { label: "App Review", key: { workflowPromptId: "implementation.browser-app-review.codex" } },
  { label: "Code Review", key: { workflowPromptId: "implementation.code-review.codex" } },
] as const;

const SKIPPABLE_STEP_LABELS: ReadonlyArray<{
  readonly setting: SkippableImplementationSetting;
  readonly label: string;
}> = engineeringWorkflowDefaultSteps("planning").flatMap((step) => {
  const setting = skippableImplementationSettingForStep(step);
  return setting === null ? [] : [{ setting, label: step.label }];
});

/**
 * The standing defaults every new workflow run starts from, as the web
 * Settings → Workflows page sets them. Pins set from a running workflow's
 * sheet govern that run only.
 */
export function SettingsWorkflowsRouteScreen() {
  const insets = useSafeAreaInsets();
  return (
    <>
      <SettingsEnvironmentFilterHeader />
      <SettingsScreen title="Workflows" trailing={<AndroidSettingsEnvironmentFilter />}>
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          showsVerticalScrollIndicator={false}
          className="flex-1"
          contentContainerClassName="gap-6 px-5 pt-4"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        >
          <WorkflowDefaults />
        </ScrollView>
      </SettingsScreen>
    </>
  );
}

function WorkflowDefaults() {
  const { selectedTargets } = useSettingsEnvironmentFilter();
  const writable = useEnvironmentsWithScope(selectedTargets, AuthSettingsWriteScope);
  const writeSettings = useSettingsWriter();
  const [pendingWrites, setPendingWrites] = useState(0);
  const reference = selectedTargets[0] ?? null;
  if (reference === null) {
    return (
      <Text className="text-sm text-foreground-muted">
        Connect an environment to edit its workflow defaults.
      </Text>
    );
  }
  const settings = reference.serverConfig.settings;
  const canWrite = selectedTargets.every((target) => writable.has(target.environmentId));
  const disabled = !canWrite || pendingWrites > 0;
  // Each environment's lists are patched from its own settings, so writing
  // one choice to several environments never copies another's pins across.
  const write = (plan: (settings: ServerSettings) => ServerSettingsPatch) => {
    const targets = selectedTargets.filter((target) =>
      readEnvironmentScope(target.environmentId, AuthSettingsWriteScope),
    );
    if (targets.length === 0) return;
    setPendingWrites((count) => count + 1);
    void writeSettings(
      resolveMobileSettingsTargets(targets, null),
      targets.map((target) => ({
        environmentId: target.environmentId,
        patch: plan(target.serverConfig.settings),
      })),
    ).finally(() => setPendingWrites((count) => count - 1));
  };
  const setStepModel =
    (workflow: LaunchableWorkflow | null): WorkflowTuningBinding["onSetPin"] =>
    (key, selection) =>
      write((current) => ({
        workflowStepModels: [
          ...setWorkflowStepModelDefault(current.workflowStepModels, key, selection, workflow),
        ],
      }));
  const setImplementation = (change: Partial<ServerSettings["implementation"]>) =>
    write((current) => ({
      implementation: normalizeImplementationWorkflowSettings({
        ...current.implementation,
        ...change,
      }),
    }));
  const engineeringBinding: WorkflowTuningBinding = {
    environmentId: reference.environmentId,
    disabled,
    inheritedModelLabel: "Workflow model",
    pinFor: (key) => standingWorkflowStepModel(settings.workflowStepModels, key, "engineering"),
    onSetPin: setStepModel("engineering"),
    // One write for every pin, so later pins are not patched from stale settings.
    onSetPins: (keys, selection) =>
      write((current) => ({
        workflowStepModels: [
          ...keys.reduce(
            (models, key) => setWorkflowStepModelDefault(models, key, selection, "engineering"),
            current.workflowStepModels,
          ),
        ],
      })),
    cyclesFor: (key) =>
      settings.workflowStepCycles.find((entry) => workflowStepCycleKeysEqual(entry, key))
        ?.maxCycles ?? null,
    inheritedCycles: (key) => resolveWorkflowStepCycleBudget({ key }),
    onSetCycles: (key, maxCycles) =>
      write((current) => ({
        workflowStepCycles: [
          ...setWorkflowStepCycleOverride(current.workflowStepCycles, key, maxCycles),
        ],
      })),
    reviewPartsFor: (key) =>
      resolveAppReviewStepParts({ overrides: settings.workflowStepReviewParts, key }),
    hasReviewPartsOverride: (key) =>
      settings.workflowStepReviewParts.some((entry) => workflowStepCycleKeysEqual(entry, key)),
    onSetReviewParts: (key, parts) =>
      write((current) => ({
        workflowStepReviewParts: [
          ...setWorkflowStepReviewPartsOverride(current.workflowStepReviewParts, key, parts),
        ],
      })),
  };
  const startModelPin = (workflow: LaunchableWorkflow) => (
    <WorkflowModelPinRow
      label="Starting model"
      separated={false}
      environmentId={reference.environmentId}
      pinned={workflowStartModel(settings, workflow)}
      inheritedLabel="Default for new threads"
      disabled={disabled}
      onSelect={(selection) =>
        setStepModel(null)({ workflowPromptId: WORKFLOW_START_MODEL_PINS[workflow] }, selection)
      }
    />
  );

  return (
    <>
      {selectedTargets.length > 1 ? (
        <Text className="px-2 text-xs text-foreground-muted">
          Showing {targetLabel(reference)}. Changes apply to every selected environment.
        </Text>
      ) : null}
      <ListSection
        title="Feature workflow"
        footer="What a Feature runs on when whoever starts it names no model. Its reviewers use their own model when one is set."
      >
        {startModelPin("feature")}
        {FEATURE_REVIEW_STEPS.map((step) => (
          <WorkflowModelPinRow
            key={step.label}
            label={step.label}
            separated
            environmentId={reference.environmentId}
            pinned={standingWorkflowStepModel(settings.workflowStepModels, step.key, "feature")}
            inheritedLabel="Workflow model"
            disabled={disabled}
            onSelect={(selection) => setStepModel("feature")(step.key, selection)}
          />
        ))}
      </ListSection>
      <ListSection
        title="Engineering workflow"
        footer="Steps without their own model follow the starting model."
      >
        {startModelPin("engineering")}
      </ListSection>
      <ListSection title="Ticket scheduling" footer="Budgets for runs without their own settings.">
        <View className="px-4 py-3">
          <NumberField
            label="Parallel tickets"
            min={1}
            max={MAX_PARALLEL_TICKETS}
            value={settings.implementation.maxParallelTickets ?? DEFAULT_MAX_PARALLEL_TICKETS}
            disabled={disabled}
            onValueChange={(maxParallelTickets) => setImplementation({ maxParallelTickets })}
          />
        </View>
        <View className="border-t border-border-subtle px-4 py-3">
          <NumberField
            label="Parallel App Reviews"
            min={1}
            max={MAX_PARALLEL_TICKETS}
            value={
              settings.implementation.maxParallelAppReviews ?? DEFAULT_MAX_PARALLEL_APP_REVIEWS
            }
            disabled={disabled}
            onValueChange={(maxParallelAppReviews) => setImplementation({ maxParallelAppReviews })}
          />
        </View>
      </ListSection>
      <GrillAnswererSection
        value={settings.implementation.grillAnswerer ?? "human"}
        disabled={disabled}
        onChange={(grillAnswerer) => setImplementation({ grillAnswerer })}
      />
      <ListSection title="Steps that run by default">
        {SKIPPABLE_STEP_LABELS.map((step, index) => (
          <View key={step.setting} className={index > 0 ? "border-t border-border-subtle" : ""}>
            <SettingsSwitchRow
              label={step.label}
              value={settings.implementation[step.setting]}
              disabled={disabled}
              onValueChange={(enabled) =>
                setImplementation({
                  [step.setting]: enabled,
                  // A pull request has to exist before it can be babysat.
                  ...(step.setting === "pullRequestCreationEnabled" && !enabled
                    ? { pullRequestBabysittingEnabled: false }
                    : {}),
                  ...(step.setting === "pullRequestBabysittingEnabled" && enabled
                    ? { pullRequestCreationEnabled: true }
                    : {}),
                })
              }
            />
          </View>
        ))}
      </ListSection>
      <WorkflowReviewModelsSection preset="planning" binding={engineeringBinding} />
      <WorkflowStepTuningSections
        steps={workflowTuningSteps("planning")}
        binding={engineeringBinding}
      />
    </>
  );
}

function targetLabel(target: SettingsTarget): string {
  return target.label;
}
