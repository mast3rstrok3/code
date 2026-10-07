import { useState } from "react";
import type {
  EnvironmentId,
  ModelSelection,
  ProviderDriverKind,
  ProviderInteractionMode,
  WorkflowPreset,
} from "@t3tools/contracts";
import {
  implementationDefaultsForWorkflowPreset,
  WORKFLOW_PRESET_DEFINITION_BY_ID,
} from "@t3tools/shared/workflowPresets";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { useComposerDraftStore, type ComposerThreadTarget } from "~/composerDraftStore";
import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "~/hooks/useSettings";
import { useWorkflowCatalog } from "~/workflowCatalogState";
import { ComposerModeCatalogDialog } from "./ComposerModeCatalogDialog";
import type { ComposerModeCatalog, ComposerModeControls } from "./ComposerModePicker";
import { isPlanningWorkflowAvailableForProvider } from "./composerPlanningWorkflow";

export function useComposerWorkflowControls(input: {
  environmentId: EnvironmentId;
  target: ComposerThreadTarget;
  provider: ProviderDriverKind;
  modelSelection: ModelSelection;
  interactionMode: ProviderInteractionMode;
  showPrimaryModes: boolean;
  threadPreset: WorkflowPreset | null;
}) {
  const catalog = useWorkflowCatalog(input.environmentId);
  const settings = useEnvironmentSettings(input.environmentId);
  const updateSettings = useUpdateEnvironmentSettings(input.environmentId);
  const preset = useComposerDraftStore(
    (store) => store.getComposerDraft(input.target)?.workflowPreset,
  );
  const lastPreset = useComposerDraftStore(
    (store) => store.getComposerDraft(input.target)?.lastWorkflowPreset ?? null,
  );
  const implementationSettings = useComposerDraftStore(
    (store) => store.getComposerDraft(input.target)?.workflowImplementationSettings,
  );
  const setComposerMode = useComposerDraftStore((store) => store.setComposerMode);
  const targetKey = typeof input.target === "string" ? input.target : scopedThreadKey(input.target);
  const [skillsByTarget, setSkillsByTarget] = useState<Record<string, string | null>>({});
  const [openCatalog, setOpenCatalog] = useState<ComposerModeCatalog | null>(null);
  const selectedBuildSkillId = skillsByTarget[targetKey] ?? null;
  const workflowPreset = preset === undefined ? input.threadPreset : preset;
  const workflowAvailable = isPlanningWorkflowAvailableForProvider(input.provider);
  const buildSkills =
    catalog.status === "loaded"
      ? catalog.catalog.skills.filter((skill) => skill.buildModes.includes("build"))
      : [];
  const workflowDefaults = {
    environmentId: input.environmentId,
    rootModelSelection: input.modelSelection,
    stepModels: settings.workflowStepModels,
    stepCycles: settings.workflowStepCycles,
    stepReviewParts: settings.workflowStepReviewParts,
    implementationSettings:
      implementationSettings ??
      implementationDefaultsForWorkflowPreset(workflowPreset ?? "quick-plan") ??
      settings.implementation,
    onChange: (defaults: Parameters<ComposerModeControls["workflowDefaults"]["onChange"]>[0]) =>
      updateSettings({
        workflowStepModels: [...defaults.stepModels],
        workflowStepCycles: [...defaults.stepCycles],
        workflowStepReviewParts: [...defaults.stepReviewParts],
      }),
  };
  const selectSkill = (id: string | null) => {
    setSkillsByTarget((current) => ({ ...current, [targetKey]: id }));
    if (id !== null) setComposerMode(input.target, "default", null);
  };
  const controls: ComposerModeControls = {
    interactionMode: input.interactionMode,
    workflowPreset,
    lastWorkflowPreset: lastPreset,
    workflowAvailable,
    showPrimaryModes: input.showPrimaryModes,
    buildSkills,
    selectedBuildSkillId,
    workflowDefaults,
    onOpenCatalog: setOpenCatalog,
    onInteractionModeChange: (mode, nextPreset, nextSettings) => {
      selectSkill(null);
      setComposerMode(input.target, mode, nextPreset, nextSettings ?? undefined);
    },
    onBuildSkillChange: selectSkill,
  };
  return {
    controls,
    workflowPreset,
    clearWorkflowMode: input.threadPreset !== null && workflowPreset === null,
    workflowImplementationSettings: workflowDefaults.implementationSettings,
    workflowPromptId:
      workflowAvailable && workflowPreset !== null
        ? (WORKFLOW_PRESET_DEFINITION_BY_ID[workflowPreset].workflowPromptId ?? null)
        : selectedBuildSkillId,
    catalogDialog: (
      <ComposerModeCatalogDialog
        catalog={openCatalog}
        activePreset={workflowPreset}
        workflowAvailable={workflowAvailable}
        buildSkills={buildSkills}
        selectedBuildSkillId={selectedBuildSkillId}
        workflowDefaults={workflowDefaults}
        onOpenChange={(open) => {
          if (!open) setOpenCatalog(null);
        }}
        onSelectPreset={(nextPreset, nextSettings) =>
          controls.onInteractionModeChange(
            WORKFLOW_PRESET_DEFINITION_BY_ID[nextPreset].interactionMode,
            nextPreset,
            nextSettings,
          )
        }
        onSelectSkill={selectSkill}
      />
    ),
  };
}
