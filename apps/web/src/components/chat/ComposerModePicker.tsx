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
  type WorkflowPresetDefinition,
} from "@t3tools/shared/workflowPresets";
import {
  BotIcon,
  CheckIcon,
  ChevronRightIcon,
  CircleHelpIcon,
  PencilRulerIcon,
  SparklesIcon,
  WorkflowIcon,
} from "lucide-react";
import type { KeyboardEvent } from "react";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

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

function WorkflowHelp({ definition }: { readonly definition: WorkflowPresetDefinition }) {
  return (
    <Popover>
      <PopoverTrigger
        closeDelay={120}
        delay={120}
        openOnHover
        render={
          <Button
            aria-label={`How ${definition.label} workflow works`}
            className="pointer-coarse:min-h-11 pointer-coarse:min-w-11 size-8 rounded-md text-muted-foreground"
            size="icon-xs"
            variant="ghost"
          />
        }
      >
        <CircleHelpIcon aria-hidden="true" className="size-4" />
      </PopoverTrigger>
      <PopoverPopup
        align="end"
        className="max-h-[min(28rem,var(--available-height))] w-[min(22rem,var(--available-width))]"
        initialFocus={false}
        side="right"
        sideOffset={8}
        viewportClassName="overflow-y-auto p-3 [--viewport-inline-padding:--spacing(3)]"
      >
        <div className="grid gap-2">
          <div className="font-semibold text-sm">{definition.label} workflow</div>
          <ol className="grid list-decimal gap-2 pl-5 text-xs leading-5">
            {definition.helpSteps.map((step) => (
              <li key={step.label}>
                <span className="font-medium text-foreground">{step.label}</span>
                {step.threadBoundary || step.note ? (
                  <span className="text-muted-foreground">
                    {" · "}
                    {[step.threadBoundary, step.note].filter(Boolean).join(", ")}
                  </span>
                ) : null}
              </li>
            ))}
          </ol>
        </div>
      </PopoverPopup>
    </Popover>
  );
}

export function WorkflowPresetRows(props: {
  readonly activePreset: WorkflowPreset | null;
  readonly workflowAvailable: boolean;
  readonly onSelect: (preset: WorkflowPreset) => void;
}) {
  return (
    <div className="grid gap-4" data-composer-mode-view="workflow" role="menu">
      {(["plan", "engineering"] as const).map((group) => (
        <section className="grid gap-1" key={group}>
          <div className="px-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            {group === "plan" ? "Plan" : "Engineering"}
          </div>
          {WORKFLOW_PRESET_DEFINITIONS.filter((definition) => definition.group === group).map(
            (definition) => {
              const selected = props.activePreset === definition.id;
              const unavailable = definition.availability === "under-development";
              return (
                <div
                  className={cn(
                    "grid grid-cols-[minmax(0,1fr)_auto] items-center rounded-md",
                    selected && "bg-accent",
                  )}
                  key={definition.id}
                >
                  <button
                    aria-checked={selected}
                    className="grid min-h-12 min-w-0 grid-cols-[1rem_minmax(0,1fr)] gap-x-2 rounded-md px-2 py-2 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                    data-composer-mode-option
                    disabled={!props.workflowAvailable || unavailable}
                    onClick={() => props.onSelect(definition.id)}
                    onKeyDown={composerModeOptionKeyDown}
                    role="menuitemradio"
                    type="button"
                  >
                    <span className="mt-0.5 size-4">
                      {selected ? <CheckIcon aria-hidden="true" className="size-4" /> : null}
                    </span>
                    <span className="grid min-w-0 gap-0.5">
                      <span className="font-medium text-sm">{definition.label}</span>
                      <span className="text-muted-foreground text-xs leading-4">
                        {!props.workflowAvailable
                          ? "Available for Codex, Claude, and OpenCode providers."
                          : unavailable
                            ? (definition.unavailableReason ?? "Under development")
                            : definition.description}
                      </span>
                    </span>
                  </button>
                  <WorkflowHelp definition={definition} />
                </div>
              );
            },
          )}
        </section>
      ))}
    </div>
  );
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
      label: "Workflows",
      description: "Choose and configure a guided workflow.",
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
                  ? "Available for Codex and Claude providers in v1."
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
