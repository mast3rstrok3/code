import type { WorkflowPreset } from "@t3tools/contracts";
import { setWorkflowStepReviewPartsOverride } from "@t3tools/shared/appReviewParts";
import { WORKFLOW_PRESET_DEFINITION_BY_ID } from "@t3tools/shared/workflowPresets";
import { setWorkflowStepCycleOverride } from "@t3tools/shared/workflowStepCycles";
import { ArrowLeftIcon, CheckIcon, CircleHelpIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "~/lib/utils";
import { WorkflowSettingsBody } from "../WorkflowSettingsMenu";
import {
  setWorkflowStepModelDefault,
  setWorkflowStepModelDefaults,
} from "../settings/workflowStepModelDefaults";
import { WorkflowCatalogContent } from "../settings/WorkflowCatalogContent";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import {
  composerModeOptionKeyDown,
  sortComposerBuildSkills,
  WorkflowPresetRows,
  type ComposerBuildSkill,
  type ComposerModeCatalog,
  type ComposerWorkflowDefaults,
} from "./ComposerModePicker";

function SkillHelp({ skill }: { readonly skill: ComposerBuildSkill }) {
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            aria-label={`Read ${skill.title} skill instructions`}
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
        className="w-[min(38rem,var(--available-width))] p-0"
        side="right"
        sideOffset={8}
        viewportClassName="max-h-[min(34rem,var(--available-height))] overflow-y-auto p-3 [--viewport-inline-padding:--spacing(3)]"
      >
        <div className="mb-2 font-semibold text-sm">{skill.title}</div>
        <WorkflowCatalogContent
          text={skill.promptText}
          label={`${skill.title} skill instructions`}
          maxHeightClassName="max-h-none"
        />
      </PopoverPopup>
    </Popover>
  );
}

export function ComposerModeCatalogDialog(props: {
  readonly catalog: ComposerModeCatalog | null;
  readonly activePreset: WorkflowPreset | null;
  readonly workflowAvailable: boolean;
  readonly buildSkills: ReadonlyArray<ComposerBuildSkill>;
  readonly selectedBuildSkillId: string | null;
  readonly workflowDefaults: ComposerWorkflowDefaults;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSelectPreset: (preset: WorkflowPreset) => void;
  readonly onSelectSkill: (skillId: string) => void;
}) {
  const [configuringPreset, setConfiguringPreset] = useState<WorkflowPreset | null>(null);
  const [stepModels, setStepModels] = useState(props.workflowDefaults.stepModels);
  const [stepCycles, setStepCycles] = useState(props.workflowDefaults.stepCycles);
  const [stepReviewParts, setStepReviewParts] = useState(props.workflowDefaults.stepReviewParts);

  useEffect(() => {
    if (props.catalog === null) return;
    setConfiguringPreset(null);
    setStepModels(props.workflowDefaults.stepModels);
    setStepCycles(props.workflowDefaults.stepCycles);
    setStepReviewParts(props.workflowDefaults.stepReviewParts);
  }, [
    props.catalog,
    props.workflowDefaults.stepCycles,
    props.workflowDefaults.stepModels,
    props.workflowDefaults.stepReviewParts,
  ]);

  const definition =
    configuringPreset === null ? null : WORKFLOW_PRESET_DEFINITION_BY_ID[configuringPreset];
  const title =
    definition === null ? (props.catalog === "skills" ? "Skills" : "Workflows") : definition.label;
  const description =
    definition === null
      ? props.catalog === "skills"
        ? "Choose a skill for the next Build turn. Open the help button to read its full instructions."
        : "Choose a workflow, review how it runs, then confirm its settings before it starts."
      : "Review the standing defaults, change any that should apply to this and future runs, then use the workflow.";

  return (
    <Dialog open={props.catalog !== null} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-3xl overflow-hidden">
        <DialogHeader className="border-b border-border/70 pr-14">
          {definition === null ? null : (
            <Button
              aria-label="Back to workflows"
              className="mb-1 w-fit"
              onClick={() => setConfiguringPreset(null)}
              size="sm"
              variant="ghost"
            >
              <ArrowLeftIcon aria-hidden="true" />
              Workflows
            </Button>
          )}
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogPanel className="px-4 py-4 sm:px-6">
          {definition !== null ? (
            <WorkflowSettingsBody
              environmentId={props.workflowDefaults.environmentId}
              preset={definition.id}
              pinFor={(key) =>
                stepModels.find(
                  (entry) =>
                    entry.workflowPromptId === key.workflowPromptId &&
                    (entry.stepWorkflowPromptId ?? null) === (key.stepWorkflowPromptId ?? null),
                )?.modelSelection ?? null
              }
              rootModelSelection={props.workflowDefaults.rootModelSelection}
              rootLabel="The model selected in the composer"
              description="Every step follows the composer model and standing cycle defaults unless you set an override. You can change the same controls after the workflow starts."
              onSetStepModel={(key, selection) =>
                setStepModels((current) => setWorkflowStepModelDefault(current, key, selection))
              }
              onSetStepModels={(keys, selection) =>
                setStepModels((current) => setWorkflowStepModelDefaults(current, keys, selection))
              }
              stepCycles={stepCycles}
              onSetStepCycles={(key, maxCycles) =>
                setStepCycles((current) => setWorkflowStepCycleOverride(current, key, maxCycles))
              }
              stepReviewParts={stepReviewParts}
              onSetStepReviewParts={(key, parts) =>
                setStepReviewParts((current) =>
                  setWorkflowStepReviewPartsOverride(current, key, parts),
                )
              }
            />
          ) : props.catalog === "skills" ? (
            <div className="grid gap-1" data-composer-mode-view="skills" role="menu">
              {sortComposerBuildSkills(props.buildSkills).map((skill) => {
                const selected = props.selectedBuildSkillId === skill.id;
                return (
                  <div
                    className={cn(
                      "grid grid-cols-[minmax(0,1fr)_auto] items-center rounded-md",
                      selected && "bg-accent",
                    )}
                    key={skill.id}
                  >
                    <button
                      aria-checked={selected}
                      className="grid min-h-12 min-w-0 grid-cols-[1rem_minmax(0,1fr)] gap-x-2 rounded-md px-2 py-2 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                      data-composer-mode-option
                      onClick={() => {
                        props.onSelectSkill(skill.id);
                        props.onOpenChange(false);
                      }}
                      onKeyDown={composerModeOptionKeyDown}
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
                    <SkillHelp skill={skill} />
                  </div>
                );
              })}
            </div>
          ) : (
            <WorkflowPresetRows
              activePreset={props.activePreset}
              onSelect={setConfiguringPreset}
              workflowAvailable={props.workflowAvailable}
            />
          )}
        </DialogPanel>
        {definition === null ? null : (
          <DialogFooter>
            <Button variant="outline" onClick={() => props.onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                props.workflowDefaults.onChange({ stepModels, stepCycles, stepReviewParts });
                props.onSelectPreset(definition.id);
                props.onOpenChange(false);
              }}
            >
              Use {definition.label}
            </Button>
          </DialogFooter>
        )}
      </DialogPopup>
    </Dialog>
  );
}
