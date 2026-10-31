import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  DEFAULT_MAX_PARALLEL_APP_REVIEWS,
  DEFAULT_MAX_PARALLEL_TICKETS,
  MAX_PARALLEL_TICKETS,
  type EnvironmentId,
  type GrillAnswerer,
  type ThreadId,
} from "@t3tools/contracts";
import { workflowModelPinKey } from "@t3tools/client-runtime/workflow-step-models";
import {
  resolveWorkflowStepCycleBudget,
  workflowStepCycleKeysEqual,
} from "@t3tools/shared/workflowStepCycles";
import { Platform, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { ErrorBanner } from "../../components/ui/ErrorBanner";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { ListSection } from "../../components/ui/ListSection";
import { NumberField } from "../../components/ui/NumberField";
import { runSettingsCommand, useWorkflowCommands, useWorkflowRun } from "./useWorkflowRun";
import { WorkflowSheetFrame } from "./WorkflowSheetFrame";
import { WorkflowStepTuningSections, workflowTuningSteps } from "./WorkflowTuning";

type WorkflowSettingsTarget = {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  /** Narrows the screen to one step's models and cycles. */
  readonly stepWorkflowPromptId?: string;
};

/** One run's tuning: concurrency, who answers the grill, and per-step models and cycles. */
export function WorkflowRunSettingsSheet({ route }: StaticScreenProps<WorkflowSettingsTarget>) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const target = route.params;
  const run = useWorkflowRun(target.environmentId, target.threadId);
  const commands = useWorkflowCommands(target.environmentId, run.rootId);
  const root = run.workflow?.root ?? null;
  const preset = root?.workflowPreset ?? null;
  const steps =
    preset === null
      ? []
      : workflowTuningSteps(preset).filter(
          (step) =>
            target.stepWorkflowPromptId === undefined ||
            step.workflowPromptId === target.stepWorkflowPromptId,
        );
  const disabled = !commands.canDispatch || commands.busy;
  const runSettings = root?.workflowImplementationSettings ?? run.settings.implementation;
  const setRunSettings = (change: Parameters<typeof runSettingsCommand>[0]["change"]) => {
    if (root === null) return;
    void commands.send(
      runSettingsCommand({
        base: commands.base(),
        root,
        standing: run.settings.implementation,
        change,
      }),
    );
  };
  const title =
    target.stepWorkflowPromptId === undefined
      ? "Models and cycles"
      : (steps[0]?.label ?? "Step settings");

  return (
    <WorkflowSheetFrame
      screenId="thread-workflow-settings-native"
      title={title}
      onBack={() => navigation.goBack()}
    >
      <ScrollView
        contentInsetAdjustmentBehavior={Platform.OS === "ios" ? "automatic" : "never"}
        keyboardShouldPersistTaps="handled"
        contentContainerClassName="gap-6 px-5 pt-2"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 16) + 8 }}
      >
        {commands.error !== null ? <ErrorBanner message={commands.error} /> : null}
        {root === null ? (
          <Text className="pt-6 text-center text-sm text-foreground-muted">
            {run.loading ? "Loading the workflow…" : "This thread is not part of a workflow."}
          </Text>
        ) : null}
        {root !== null && target.stepWorkflowPromptId === undefined ? (
          <>
            <ListSection
              title="Run"
              footer="Applies to this run only. Settings → Workflows holds the standing defaults."
            >
              <View className="px-4 py-3">
                <NumberField
                  label="Parallel tickets"
                  min={1}
                  max={MAX_PARALLEL_TICKETS}
                  value={runSettings.maxParallelTickets ?? DEFAULT_MAX_PARALLEL_TICKETS}
                  disabled={disabled}
                  onValueChange={(maxParallelTickets) => setRunSettings({ maxParallelTickets })}
                />
              </View>
              <View className="border-t border-border-subtle px-4 py-3">
                <NumberField
                  label="Parallel App Reviews"
                  min={1}
                  max={MAX_PARALLEL_TICKETS}
                  value={runSettings.maxParallelAppReviews ?? DEFAULT_MAX_PARALLEL_APP_REVIEWS}
                  disabled={disabled}
                  onValueChange={(maxParallelAppReviews) =>
                    setRunSettings({ maxParallelAppReviews })
                  }
                />
              </View>
            </ListSection>
            <GrillAnswererSection
              value={runSettings.grillAnswerer ?? "human"}
              disabled={disabled}
              onChange={(grillAnswerer) => setRunSettings({ grillAnswerer })}
            />
          </>
        ) : null}
        {root !== null ? (
          <WorkflowStepTuningSections
            steps={steps}
            binding={{
              environmentId: target.environmentId,
              disabled,
              inheritedModelLabel: "Workflow default",
              pinFor: (key) =>
                (root.workflowStepModels ?? []).find(
                  (entry) => workflowModelPinKey(entry) === workflowModelPinKey(key),
                )?.modelSelection ?? null,
              onSetPin: (key, modelSelection) =>
                void commands.send({
                  type: "thread.workflow.step-model.set",
                  ...commands.base(),
                  workflowPromptId: key.workflowPromptId,
                  ...(key.stepWorkflowPromptId === undefined
                    ? {}
                    : { stepWorkflowPromptId: key.stepWorkflowPromptId }),
                  modelSelection,
                }),
              cyclesFor: (key) =>
                (root.workflowStepCycles ?? []).find((entry) =>
                  workflowStepCycleKeysEqual(entry, key),
                )?.maxCycles ?? null,
              inheritedCycles: (key) =>
                resolveWorkflowStepCycleBudget({
                  key,
                  settingsOverrides: run.settings.workflowStepCycles,
                }),
              onSetCycles: (key, maxCycles) =>
                void commands.send({
                  type: "thread.workflow.step-cycles.set",
                  ...commands.base(),
                  workflowPromptId: key.workflowPromptId,
                  ...(key.stepWorkflowPromptId === undefined
                    ? {}
                    : { stepWorkflowPromptId: key.stepWorkflowPromptId }),
                  maxCycles,
                }),
            }}
          />
        ) : null}
        {root !== null && steps.length === 0 ? (
          <Text className="text-sm text-foreground-muted">
            This step shares the workflow's main thread, so it uses the model selected in that
            thread's composer.
          </Text>
        ) : null}
      </ScrollView>
    </WorkflowSheetFrame>
  );
}

export function GrillAnswererSection(props: {
  readonly value: GrillAnswerer;
  readonly disabled: boolean;
  readonly onChange: (value: GrillAnswerer) => void;
}) {
  return (
    <ListSection
      title="Grill answers"
      footer="A judge answers from the task and the Grill's recommendations so the workflow can run unattended."
    >
      <ListChoiceRow
        label="You answer"
        selected={props.value === "human"}
        disabled={props.disabled}
        onPress={() => props.onChange("human")}
      />
      <ListChoiceRow
        label="Judge answers"
        separated
        selected={props.value === "judge"}
        disabled={props.disabled}
        onPress={() => props.onChange("judge")}
      />
    </ListSection>
  );
}
