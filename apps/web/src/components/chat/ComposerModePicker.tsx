import type {
  ProviderInteractionMode,
  WorkflowPreset,
  WorkflowSkillContract,
} from "@t3tools/contracts";
import {
  inferDisplayedWorkflowPreset,
  interactionModeForWorkflowPreset,
  WORKFLOW_PRESET_DEFINITION_BY_ID,
  WORKFLOW_PRESET_DEFINITIONS,
  type WorkflowPresetDefinition,
} from "@t3tools/shared/workflowPresets";
import {
  ArrowLeftIcon,
  BotIcon,
  CheckIcon,
  ChevronRightIcon,
  CircleHelpIcon,
  PencilRulerIcon,
  SparklesIcon,
  WorkflowIcon,
} from "lucide-react";
import {
  type KeyboardEvent,
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { cn } from "~/lib/utils";
import { AnimatedHeight } from "../AnimatedHeight";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

export type ComposerPrimaryMode = "build" | "plan" | "workflow";
export type ComposerModePickerView = "primary" | "workflow" | "skills";

export type ComposerBuildSkill = Pick<
  WorkflowSkillContract,
  "id" | "title" | "description" | "workflowIds"
>;

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
  return rememberedPreset ?? ("full-feature" as const);
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

function optionKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  event.preventDefault();
  const container = event.currentTarget.closest<HTMLElement>("[data-composer-mode-view]");
  if (container) focusRelativeOption(container, event.key === "ArrowDown" ? 1 : -1);
}

function WorkflowHelp({ definition }: { readonly definition: WorkflowPresetDefinition }) {
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) setPinned(false);
      }}
    >
      <PopoverTrigger
        render={
          <Button
            aria-label={`How ${definition.label} workflow works`}
            className="pointer-coarse:min-h-11 pointer-coarse:min-w-11 size-8 rounded-md text-muted-foreground"
            size="icon-xs"
            variant="ghost"
            onBlur={() => {
              if (!pinned) setOpen(false);
            }}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setPinned((current) => {
                const next = !current;
                setOpen(next);
                return next;
              });
            }}
            onFocus={() => setOpen(true)}
            onMouseEnter={() => setOpen(true)}
            onMouseLeave={() => {
              if (!pinned) setOpen(false);
            }}
          />
        }
      >
        <CircleHelpIcon aria-hidden="true" className="size-4" />
      </PopoverTrigger>
      <PopoverPopup
        align="end"
        className="max-h-[min(28rem,var(--available-height))] w-[min(22rem,var(--available-width))]"
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
                    {" — "}
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
    <div className="grid gap-1" data-composer-mode-view="workflow" role="menu">
      {WORKFLOW_PRESET_DEFINITIONS.map((definition) => {
        const selected = props.activePreset === definition.id;
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
              disabled={!props.workflowAvailable}
              onClick={() => props.onSelect(definition.id)}
              onKeyDown={optionKeyDown}
              role="menuitemradio"
              type="button"
            >
              <span className="mt-0.5 size-4">
                {selected ? <CheckIcon aria-hidden="true" className="size-4" /> : null}
              </span>
              <span className="grid min-w-0 gap-0.5">
                <span className="font-medium text-sm">{definition.label}</span>
                <span className="text-muted-foreground text-xs leading-4">
                  {props.workflowAvailable
                    ? definition.description
                    : "Available for Codex and Claude providers in v1."}
                </span>
              </span>
            </button>
            <WorkflowHelp definition={definition} />
          </div>
        );
      })}
    </div>
  );
}

export function ComposerModePickerContent(props: {
  readonly view: ComposerModePickerView;
  readonly activeMode: ComposerPrimaryMode;
  readonly activePreset: WorkflowPreset | null;
  readonly workflowAvailable: boolean;
  readonly buildSkills: ReadonlyArray<ComposerBuildSkill>;
  readonly selectedBuildSkillId: string | null;
  readonly onBack: () => void;
  readonly onOpenSkills: () => void;
  readonly onOpenWorkflow: () => void;
  readonly onSelectSkill: (skillId: string) => void;
  readonly onSelectPrimary: (mode: "build" | "plan") => void;
  readonly onSelectPreset: (preset: WorkflowPreset) => void;
}) {
  if (props.view === "skills") {
    return (
      <div
        className="grid w-[24rem] max-w-[calc(100vw-1rem)] gap-2 motion-safe:animate-in motion-safe:slide-in-from-right-3 motion-safe:duration-200"
        data-composer-mode-view="skills-shell"
      >
        <div className="grid grid-cols-[2rem_1fr_2rem] items-center">
          <Button
            aria-label="Back to composer modes"
            onClick={props.onBack}
            size="icon-xs"
            variant="ghost"
          >
            <ArrowLeftIcon aria-hidden="true" />
          </Button>
          <div className="text-center font-semibold text-sm">Build with a skill</div>
        </div>
        <div
          className="grid max-h-[min(28rem,var(--available-height))] gap-1 overflow-y-auto"
          data-composer-mode-view="skills"
          role="menu"
        >
          {sortComposerBuildSkills(props.buildSkills).map((skill) => {
            const selected = props.selectedBuildSkillId === skill.id;
            return (
              <button
                aria-checked={selected}
                className="grid min-h-12 grid-cols-[1rem_minmax(0,1fr)] gap-x-2 rounded-md px-2 py-2 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                data-composer-mode-option
                key={skill.id}
                onClick={() => props.onSelectSkill(skill.id)}
                onKeyDown={optionKeyDown}
                role="menuitemradio"
                type="button"
              >
                <span className="mt-0.5 size-4">
                  {selected ? <CheckIcon aria-hidden="true" className="size-4" /> : null}
                </span>
                <span className="grid min-w-0 gap-0.5">
                  <span className="font-medium text-sm">{skill.title}</span>
                  <span className="text-muted-foreground text-xs leading-4">
                    {skill.description}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  if (props.view === "workflow") {
    return (
      <div
        className="grid w-[24rem] max-w-[calc(100vw-1rem)] gap-2 motion-safe:animate-in motion-safe:slide-in-from-right-3 motion-safe:duration-200"
        data-composer-mode-view="workflow-shell"
      >
        <div className="grid grid-cols-[2rem_1fr_2rem] items-center">
          <Button
            aria-label="Back to composer modes"
            onClick={props.onBack}
            size="icon-xs"
            variant="ghost"
          >
            <ArrowLeftIcon aria-hidden="true" />
          </Button>
          <div className="text-center font-semibold text-sm">Workflow</div>
        </div>
        <WorkflowPresetRows
          activePreset={props.activePreset}
          onSelect={props.onSelectPreset}
          workflowAvailable={props.workflowAvailable}
        />
      </div>
    );
  }

  const options: ReadonlyArray<{
    readonly id: ComposerPrimaryMode | "skills";
    readonly label: string;
    readonly description: string;
    readonly icon: typeof BotIcon;
  }> = [
    { id: "build", label: "Build", description: "Make implementation changes.", icon: BotIcon },
    {
      id: "plan",
      label: "Plan",
      description: "Plan without changing files.",
      icon: PencilRulerIcon,
    },
    {
      id: "workflow",
      label: "Workflow",
      description: "Choose a guided multi-thread workflow.",
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
    <div
      className="grid w-64 gap-1 motion-safe:animate-in motion-safe:slide-in-from-left-3 motion-safe:duration-200"
      data-composer-mode-view="primary"
      role="menu"
    >
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
            onKeyDown={optionKeyDown}
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

export const ComposerModePicker = memo(function ComposerModePicker(props: {
  readonly interactionMode: ProviderInteractionMode;
  readonly workflowPreset: WorkflowPreset | null;
  readonly lastWorkflowPreset: WorkflowPreset | null;
  readonly workflowAvailable: boolean;
  readonly buildSkills: ReadonlyArray<ComposerBuildSkill>;
  readonly selectedBuildSkillId: string | null;
  readonly onChange: (mode: ProviderInteractionMode, preset: WorkflowPreset | null) => void;
  readonly onBuildSkillChange: (skillId: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const activeMode = resolveComposerPrimaryMode(props);
  const displayedPreset = resolveWorkflowPresetForPicker(props);
  const [view, setView] = useState<ComposerModePickerView>(
    activeMode === "workflow" ? "workflow" : "primary",
  );
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setView(activeMode === "workflow" ? "workflow" : "primary");
  }, [activeMode, open]);

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      const options = contentRef.current?.querySelectorAll<HTMLButtonElement>(
        "button[data-composer-mode-option]:not(:disabled)",
      );
      const selected = Array.from(options ?? []).find(
        (option) => option.getAttribute("aria-checked") === "true",
      );
      (selected ?? options?.[0])?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [open, view]);

  const selectPreset = useCallback(
    (preset: WorkflowPreset) => {
      props.onChange(interactionModeForWorkflowPreset(preset), preset);
      setOpen(false);
    },
    [props],
  );
  const triggerLabel =
    activeMode === "workflow"
      ? `Workflow · ${WORKFLOW_PRESET_DEFINITION_BY_ID[displayedPreset].label}`
      : activeMode === "plan"
        ? "Plan"
        : props.selectedBuildSkillId
          ? `Build · ${props.buildSkills.find((skill) => skill.id === props.selectedBuildSkillId)?.title ?? "Skill"}`
          : "Build";
  const triggerIcon: ReactNode =
    activeMode === "workflow" ? (
      <WorkflowIcon className="size-4" />
    ) : activeMode === "plan" ? (
      <PencilRulerIcon className="size-4" />
    ) : props.selectedBuildSkillId ? (
      <SparklesIcon className="size-4" />
    ) : (
      <BotIcon className="size-4" />
    );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button aria-label="Composer mode" className="font-medium" size="sm" variant="ghost" />
        }
      >
        {triggerIcon}
        <span>{triggerLabel}</span>
      </PopoverTrigger>
      <PopoverPopup
        align="start"
        className={cn(
          "duration-200 motion-reduce:transition-none",
          view === "primary" ? "[--popup-width:17rem]" : "[--popup-width:25rem]",
        )}
        viewportClassName="p-2 [--viewport-inline-padding:--spacing(2)]"
      >
        <div ref={contentRef}>
          <AnimatedHeight>
            <ComposerModePickerContent
              activeMode={activeMode}
              activePreset={activeMode === "workflow" ? displayedPreset : null}
              buildSkills={props.buildSkills}
              selectedBuildSkillId={props.selectedBuildSkillId}
              onBack={() => setView("primary")}
              onOpenSkills={() => setView("skills")}
              onOpenWorkflow={() => setView("workflow")}
              onSelectPreset={(preset) => {
                props.onBuildSkillChange(null);
                selectPreset(preset);
              }}
              onSelectSkill={(skillId) => {
                props.onChange("default", null);
                props.onBuildSkillChange(skillId);
                setOpen(false);
              }}
              onSelectPrimary={(mode) => {
                props.onBuildSkillChange(null);
                props.onChange(mode === "build" ? "default" : "plan", null);
                setOpen(false);
              }}
              view={view}
              workflowAvailable={props.workflowAvailable}
            />
          </AnimatedHeight>
        </div>
      </PopoverPopup>
    </Popover>
  );
});
