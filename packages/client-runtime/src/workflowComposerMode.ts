import {
  isPlanningWorkflowInteractionMode,
  ProviderDriverKind,
  type ProviderInteractionMode,
  type WorkflowPreset,
  type WorkflowSkillContract,
} from "@t3tools/contracts";
import {
  inferDisplayedWorkflowPreset,
  WORKFLOW_PRESET_DEFINITION_BY_ID,
  WORKFLOW_PRESET_DEFINITIONS,
} from "@t3tools/shared/workflowPresets";

const PLANNING_WORKFLOW_PROVIDERS: ReadonlySet<ProviderDriverKind> = new Set([
  ProviderDriverKind.make("codex"),
  ProviderDriverKind.make("claudeAgent"),
  ProviderDriverKind.make("opencode"),
]);

export function isPlanningWorkflowAvailableForProvider(
  provider: ProviderDriverKind | null | undefined,
): boolean {
  return provider !== null && provider !== undefined && PLANNING_WORKFLOW_PROVIDERS.has(provider);
}

export function resolveComposerInteractionModeForProvider(input: {
  interactionMode: ProviderInteractionMode;
  provider: ProviderDriverKind | null | undefined;
}): ProviderInteractionMode {
  if (
    (isPlanningWorkflowInteractionMode(input.interactionMode) ||
      input.interactionMode === "implementation-workflow") &&
    !isPlanningWorkflowAvailableForProvider(input.provider)
  ) {
    return "default";
  }
  return input.interactionMode;
}

export type ComposerPrimaryMode = "build" | "plan" | "workflow";

export type ComposerBuildSkill = Pick<
  WorkflowSkillContract,
  "id" | "title" | "description" | "promptText" | "workflowIds"
>;

export function sortComposerBuildSkills(
  skills: ReadonlyArray<ComposerBuildSkill>,
): ComposerBuildSkill[] {
  return [...skills].sort(
    (left, right) => left.title.localeCompare(right.title) || left.id.localeCompare(right.id),
  );
}

export function resolveComposerPrimaryMode(input: {
  readonly interactionMode: ProviderInteractionMode;
  readonly workflowPreset: WorkflowPreset | null;
}): ComposerPrimaryMode {
  if (input.workflowPreset !== null || input.interactionMode.endsWith("-workflow")) {
    return "workflow";
  }
  return input.interactionMode === "plan" ? "plan" : "build";
}

export function resolveWorkflowPresetForPicker(input: {
  readonly interactionMode: ProviderInteractionMode;
  readonly workflowPreset: WorkflowPreset | null;
  readonly lastWorkflowPreset: WorkflowPreset | null;
}): WorkflowPreset {
  const activePreset = inferDisplayedWorkflowPreset(input);
  if (activePreset !== null) return activePreset;
  const rememberedPreset = WORKFLOW_PRESET_DEFINITIONS.some(
    (definition) => definition.id === input.lastWorkflowPreset,
  )
    ? input.lastWorkflowPreset
    : null;
  return rememberedPreset ?? ("fast-plan" as const);
}

/**
 * Label for the control that opens the mode section. `shortLabel` is null for
 * plain Build, which keeps the default from taking space beside the model
 * traits. `kind` lets each client pick its own icon.
 */
export function describeComposerMode(input: {
  readonly interactionMode: ProviderInteractionMode;
  readonly workflowPreset: WorkflowPreset | null;
  readonly lastWorkflowPreset: WorkflowPreset | null;
  readonly buildSkills: ReadonlyArray<ComposerBuildSkill>;
  readonly selectedBuildSkillId: string | null;
}): {
  readonly kind: ComposerPrimaryMode | "skill";
  readonly label: string;
  readonly shortLabel: string | null;
} {
  const activeMode = resolveComposerPrimaryMode(input);
  if (activeMode === "workflow") {
    const presetLabel =
      WORKFLOW_PRESET_DEFINITION_BY_ID[resolveWorkflowPresetForPicker(input)].label;
    return { kind: "workflow", label: `Workflow · ${presetLabel}`, shortLabel: presetLabel };
  }
  if (activeMode === "plan") {
    return { kind: "plan", label: "Plan", shortLabel: "Plan" };
  }
  if (input.selectedBuildSkillId !== null) {
    const skillTitle =
      input.buildSkills.find((skill) => skill.id === input.selectedBuildSkillId)?.title ?? "Skill";
    return { kind: "skill", label: `Build · ${skillTitle}`, shortLabel: skillTitle };
  }
  return { kind: "build", label: "Build", shortLabel: null };
}
