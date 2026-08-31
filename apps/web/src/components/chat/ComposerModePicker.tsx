import type {
  EnvironmentId,
  ImplementationWorkflowSettings,
  ModelSelection,
  ProviderInteractionMode,
  WorkflowPreset,
  WorkflowSkillContract,
  WorkflowStepCycleOverride,
  WorkflowStepModelOverride,
  WorkflowStepReviewPartsOverride,
} from "@t3tools/contracts";
import {
  inferDisplayedWorkflowPreset,
  WORKFLOW_PRESET_DEFINITION_BY_ID,
  WORKFLOW_PRESET_DEFINITIONS,
} from "@t3tools/shared/workflowPresets";
import {
  BotIcon,
  CheckIcon,
  ChevronRightIcon,
  PencilRulerIcon,
  SparklesIcon,
  WorkflowIcon,
} from "lucide-react";
import { memo, type KeyboardEvent, useState } from "react";
import { Menu, MenuPopup, MenuTrigger } from "../ui/menu";
import { ComposerControl, ComposerControlChevron, ComposerControlIcon } from "./ComposerControl";

export type ComposerPrimaryMode = "build" | "plan" | "workflow";
export type ComposerModeCatalog = "skills" | "workflows";

export type ComposerBuildSkill = Pick<
  WorkflowSkillContract,
  "id" | "title" | "description" | "promptText" | "workflowIds"
>;

export interface ComposerWorkflowDefaults {
  readonly environmentId: EnvironmentId;
  readonly rootModelSelection: ModelSelection;
  readonly stepModels: ReadonlyArray<WorkflowStepModelOverride>;
  readonly stepCycles: ReadonlyArray<WorkflowStepCycleOverride>;
  readonly stepReviewParts: ReadonlyArray<WorkflowStepReviewPartsOverride>;
  readonly implementationSettings: ImplementationWorkflowSettings;
  readonly onChange: (defaults: {
    readonly stepModels: ReadonlyArray<WorkflowStepModelOverride>;
    readonly stepCycles: ReadonlyArray<WorkflowStepCycleOverride>;
    readonly stepReviewParts: ReadonlyArray<WorkflowStepReviewPartsOverride>;
  }) => void;
}

export type ComposerModeControls = {
  readonly interactionMode: ProviderInteractionMode;
  readonly workflowPreset: WorkflowPreset | null;
  readonly lastWorkflowPreset: WorkflowPreset | null;
  readonly workflowAvailable: boolean;
  readonly showPrimaryModes: boolean;
  readonly buildSkills: ReadonlyArray<ComposerBuildSkill>;
  readonly selectedBuildSkillId: string | null;
  readonly workflowDefaults: ComposerWorkflowDefaults;
  readonly onOpenCatalog: (catalog: ComposerModeCatalog) => void;
  readonly onInteractionModeChange: (
    mode: ProviderInteractionMode,
    preset: WorkflowPreset | null,
    implementationSettings?: ImplementationWorkflowSettings | null,
  ) => void;
  readonly onBuildSkillChange: (skillId: string | null) => void;
};

export function sortComposerBuildSkills(
  skills: ReadonlyArray<ComposerBuildSkill>,
): ComposerBuildSkill[] {
  return skills.toSorted(
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

/**
 * Label and icon for the control that opens the mode section. `shortLabel` is
 * null for plain Build, which keeps the default from taking space beside the
 * model traits.
 */
export function buildComposerModeTriggerDisplay(input: {
  readonly interactionMode: ProviderInteractionMode;
  readonly workflowPreset: WorkflowPreset | null;
  readonly lastWorkflowPreset: WorkflowPreset | null;
  readonly buildSkills: ReadonlyArray<ComposerBuildSkill>;
  readonly selectedBuildSkillId: string | null;
}): { label: string; shortLabel: string | null; icon: typeof BotIcon } {
  const activeMode = resolveComposerPrimaryMode(input);
  if (activeMode === "workflow") {
    const presetLabel =
      WORKFLOW_PRESET_DEFINITION_BY_ID[resolveWorkflowPresetForPicker(input)].label;
    return { label: `Workflow · ${presetLabel}`, shortLabel: presetLabel, icon: WorkflowIcon };
  }
  if (activeMode === "plan") {
    return { label: "Plan", shortLabel: "Plan", icon: PencilRulerIcon };
  }
  if (input.selectedBuildSkillId !== null) {
    const skillTitle =
      input.buildSkills.find((skill) => skill.id === input.selectedBuildSkillId)?.title ?? "Skill";
    return { label: `Build · ${skillTitle}`, shortLabel: skillTitle, icon: SparklesIcon };
  }
  return { label: "Build", shortLabel: null, icon: BotIcon };
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
  return rememberedPreset ?? ("quick-plan" as const);
}

function focusRelativeOption(container: HTMLElement, direction: 1 | -1) {
  const options = Array.from(
    container.querySelectorAll<HTMLButtonElement>(
      "button[data-composer-mode-option]:not(:disabled)",
    ),
  );
  if (options.length === 0) return;
  const currentIndex = options.indexOf(document.activeElement as HTMLButtonElement);
  const nextIndex =
    currentIndex < 0 ? 0 : (currentIndex + direction + options.length) % options.length;
  options[nextIndex]?.focus();
}

export function composerModeOptionKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  event.preventDefault();
  const container = event.currentTarget.closest<HTMLElement>("[data-composer-mode-view]");
  if (container) focusRelativeOption(container, event.key === "ArrowDown" ? 1 : -1);
}

export function ComposerModePickerContent(props: {
  readonly activeMode: ComposerPrimaryMode;
  readonly workflowAvailable: boolean;
  readonly showPrimaryModes: boolean;
  readonly buildSkills: ReadonlyArray<ComposerBuildSkill>;
  readonly onOpenSkills: () => void;
  readonly onOpenWorkflow: () => void;
  readonly onSelectPrimary: (mode: "build" | "plan") => void;
}) {
  const options: ReadonlyArray<{
    readonly id: ComposerPrimaryMode | "skills";
    readonly label: string;
    readonly description: string;
    readonly icon: typeof BotIcon;
  }> = [
    ...(props.showPrimaryModes
      ? ([
          {
            id: "build",
            label: "Build",
            description: "Make implementation changes.",
            icon: BotIcon,
          },
          {
            id: "plan",
            label: "Plan",
            description: "Plan without changing files.",
            icon: PencilRulerIcon,
          },
        ] as const)
      : []),
    {
      id: "workflow",
      label: "Engineering workflow",
      description: "Choose a variant and configure its steps.",
      icon: WorkflowIcon,
    },
    {
      id: "skills",
      label: "Skills",
      description: "Invoke an engineering skill in Build mode.",
      icon: SparklesIcon,
    },
  ];

  return (
    <div className="grid w-64 gap-1" data-composer-mode-view="primary" role="menu">
      {options.map((option) => {
        const Icon = option.icon;
        const selected = props.activeMode === option.id;
        return (
          <button
            aria-checked={selected}
            className="grid min-h-12 grid-cols-[1rem_minmax(0,1fr)_1rem] items-start gap-2 rounded-md px-2 py-2 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            data-composer-mode-option
            disabled={
              (option.id === "workflow" && !props.workflowAvailable) ||
              (option.id === "skills" && props.buildSkills.length === 0)
            }
            key={option.id}
            onClick={() =>
              option.id === "workflow"
                ? props.onOpenWorkflow()
                : option.id === "skills"
                  ? props.onOpenSkills()
                  : props.onSelectPrimary(option.id)
            }
            onKeyDown={composerModeOptionKeyDown}
            role="menuitemradio"
            type="button"
          >
            <Icon aria-hidden="true" className="mt-0.5 size-4 text-muted-foreground" />
            <span className="grid gap-0.5">
              <span className="font-medium text-sm">{option.label}</span>
              <span className="text-muted-foreground text-xs leading-4">
                {option.id === "workflow" && !props.workflowAvailable
                  ? "Available for Codex, Claude, and OpenCode providers."
                  : option.description}
              </span>
            </span>
            {option.id === "workflow" || option.id === "skills" ? (
              <ChevronRightIcon aria-hidden="true" className="mt-0.5 size-4" />
            ) : selected ? (
              <CheckIcon aria-hidden="true" className="mt-0.5 size-4" />
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

/** The composer's separate Build, Plan, Workflow, and Skills selector. */
export const ComposerModeControl = memo(function ComposerModeControl(props: {
  readonly controls: ComposerModeControls;
}) {
  const [open, setOpen] = useState(false);
  const display = buildComposerModeTriggerDisplay(props.controls);

  return (
    <Menu open={open} onOpenChange={setOpen}>
      <MenuTrigger
        render={
          <ComposerControl
            className="max-w-48 min-w-0 shrink justify-start overflow-hidden whitespace-nowrap"
            aria-label={display.label}
          />
        }
      >
        <ComposerControlIcon icon={display.icon} />
        <span className="min-w-0 truncate">{display.label}</span>
        <ComposerControlChevron />
      </MenuTrigger>
      <MenuPopup align="start">
        <ComposerModePickerContent
          activeMode={resolveComposerPrimaryMode(props.controls)}
          buildSkills={props.controls.buildSkills}
          showPrimaryModes={props.controls.showPrimaryModes}
          workflowAvailable={props.controls.workflowAvailable}
          onOpenSkills={() => {
            setOpen(false);
            props.controls.onOpenCatalog("skills");
          }}
          onOpenWorkflow={() => {
            setOpen(false);
            props.controls.onOpenCatalog("workflows");
          }}
          onSelectPrimary={(mode) => {
            props.controls.onBuildSkillChange(null);
            props.controls.onInteractionModeChange(mode === "build" ? "default" : "plan", null);
            setOpen(false);
          }}
        />
      </MenuPopup>
    </Menu>
  );
});
