import type {
  EnvironmentId,
  ImplementationWorkflowSettings,
  ModelSelection,
  ProviderInteractionMode,
  WorkflowPreset,
  WorkflowStepCycleOverride,
  WorkflowStepModelOverride,
  WorkflowStepReviewPartsOverride,
} from "@t3tools/contracts";
import {
  describeComposerMode,
  resolveComposerPrimaryMode,
  type ComposerBuildSkill,
  type ComposerPrimaryMode,
} from "@t3tools/client-runtime/workflow-composer-mode";
import {
  BotIcon,
  CheckIcon,
  ChevronRightIcon,
  PencilRulerIcon,
  SparklesIcon,
  WorkflowIcon,
} from "lucide-react";
import { memo, type KeyboardEvent } from "react";
import { Menu, MenuPopup, MenuTrigger } from "../ui/menu";
import { useComposerMenuState } from "./useComposerMenuState";
import { ComposerControl, ComposerControlIcon } from "./ComposerControl";

export type ComposerModeCatalog = "skills" | "workflows";

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

const COMPOSER_MODE_ICON = {
  build: BotIcon,
  plan: PencilRulerIcon,
  workflow: WorkflowIcon,
  skill: SparklesIcon,
} as const;

function buildComposerModeTriggerDisplay(input: Parameters<typeof describeComposerMode>[0]) {
  const display = describeComposerMode(input);
  return { ...display, icon: COMPOSER_MODE_ICON[display.kind] };
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
    {
      id: "build",
      label: "Build",
      description: "Make implementation changes.",
      icon: BotIcon,
    },
    ...(props.showPrimaryModes
      ? ([
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
  readonly hidden?: boolean | undefined;
  readonly size?: "sm" | "xs" | undefined;
}) {
  const [open, setOpen] = useComposerMenuState(props.hidden);
  const display = buildComposerModeTriggerDisplay(props.controls);

  return (
    <Menu open={open} onOpenChange={setOpen}>
      <MenuTrigger
        render={
          <ComposerControl
            className="max-w-48 min-w-0 shrink justify-start overflow-hidden whitespace-nowrap"
            aria-label={display.label}
            size={props.size ?? "sm"}
          />
        }
      >
        <ComposerControlIcon icon={display.icon} size={props.size ?? "sm"} />
        <span className="min-w-0 truncate">{display.label}</span>
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
