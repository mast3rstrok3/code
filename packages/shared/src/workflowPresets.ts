import type { ProviderInteractionMode, WorkflowPreset } from "@t3tools/contracts";

export type WorkflowPresetRoute = "product" | "implementation" | "planning";

export interface WorkflowPresetHelpStep {
  readonly label: string;
  readonly threadBoundary?: "same thread" | "new thread" | "new child thread" | "new review thread";
  readonly note?: string;
}

export interface WorkflowPresetDefinition {
  readonly id: WorkflowPreset;
  readonly label: string;
  readonly description: string;
  readonly route: WorkflowPresetRoute;
  readonly interactionMode: ProviderInteractionMode;
  readonly workflowPromptId?: string;
  readonly helpSteps: ReadonlyArray<WorkflowPresetHelpStep>;
}

export const WORKFLOW_PRESET_DEFINITIONS: ReadonlyArray<WorkflowPresetDefinition> = [
  {
    id: "fix",
    label: "Fix",
    description: "Lock the fix, plan it here, then build it in one child thread.",
    route: "product",
    interactionMode: "product-workflow",
    workflowPromptId: "product.fix.codex",
    helpSteps: [
      { label: "Product direction grill", threadBoundary: "same thread", note: "human-guided" },
      { label: "CLI Plan mode", threadBoundary: "same thread", note: "automatic" },
      { label: "CLI Build mode", threadBoundary: "new child thread", note: "automatic" },
    ],
  },
  {
    id: "fast-feature",
    label: "Fast feature",
    description: "Plan and build a focused feature, then run both review loops.",
    route: "product",
    interactionMode: "product-workflow",
    workflowPromptId: "product.fast-feature.codex",
    helpSteps: [
      { label: "Product direction grill", threadBoundary: "same thread" },
      { label: "CLI Plan mode", threadBoundary: "same thread" },
      {
        label: "Worktree, app dev stack, and CLI Build",
        threadBoundary: "new child thread",
      },
      {
        label: "Dev Review",
        threadBoundary: "new review thread",
        note: "up to three attempts, feedback returns to Build",
      },
      {
        label: "Code Review",
        threadBoundary: "new review thread",
        note: "single pass, applies fixes and commits",
      },
      { label: "Change request publication" },
    ],
  },
  {
    id: "full-feature",
    label: "Full feature",
    description: "Run the complete Planning and Implementation workflows.",
    route: "product",
    interactionMode: "product-workflow",
    workflowPromptId: "product.full-feature.codex",
    helpSteps: [
      { label: "Product direction grill" },
      { label: "Spec authoring" },
      { label: "Planning tickets" },
      { label: "Ticket review and revision cycles", note: "repeats until approved" },
      { label: "TDD implementation workers" },
      { label: "Merge gate and required validation" },
      { label: "Dev Review and automatic fixes", note: "up to three attempts" },
      { label: "Code Review", note: "single pass, applies fixes and commits" },
      { label: "Change request publication" },
    ],
  },
  {
    id: "implementation",
    label: "Implementation",
    description: "Implement a selected Spec through validation and review.",
    route: "implementation",
    interactionMode: "implementation-workflow",
    helpSteps: [
      { label: "Load the selected Spec and initialize orchestration" },
      { label: "Run dependency-aware TDD implementation workers" },
      { label: "Integrate worker branches and run the merge gate" },
      { label: "Run Dev Review and automatic fixes", note: "up to three attempts" },
      { label: "Run Code Review", note: "single pass, applies fixes and commits" },
      { label: "Publish the change request" },
    ],
  },
  {
    id: "planning",
    label: "Planning",
    description: "Create a reviewed Spec and dependency-aware planning tickets.",
    route: "planning",
    interactionMode: "planning-workflow",
    helpSteps: [
      { label: "Grill and domain modeling" },
      { label: "Spec authoring" },
      { label: "Planning-ticket authoring" },
      { label: "Ticket review and revision cycles", note: "repeats until approved" },
    ],
  },
];

export const WORKFLOW_PRESET_DEFINITION_BY_ID = Object.fromEntries(
  WORKFLOW_PRESET_DEFINITIONS.map((definition) => [definition.id, definition]),
) as Readonly<Record<WorkflowPreset, WorkflowPresetDefinition>>;

export function interactionModeForWorkflowPreset(preset: WorkflowPreset): ProviderInteractionMode {
  return WORKFLOW_PRESET_DEFINITION_BY_ID[preset].interactionMode;
}

export function workflowPromptIdForPreset(
  preset: WorkflowPreset | null | undefined,
): string | undefined {
  return preset ? WORKFLOW_PRESET_DEFINITION_BY_ID[preset].workflowPromptId : undefined;
}

export function inferDisplayedWorkflowPreset(input: {
  readonly interactionMode: ProviderInteractionMode | null | undefined;
  readonly workflowPreset: WorkflowPreset | null | undefined;
}): WorkflowPreset | null {
  if (input.workflowPreset) return input.workflowPreset;
  switch (input.interactionMode) {
    case "product-workflow":
      return "full-feature";
    case "implementation-workflow":
      return "implementation";
    case "planning-workflow":
      return "planning";
    default:
      return null;
  }
}

export function isProductWorkflowPreset(
  preset: WorkflowPreset | null | undefined,
): preset is "fix" | "fast-feature" | "full-feature" {
  return preset === "fix" || preset === "fast-feature" || preset === "full-feature";
}

export function expectedIntentKindForWorkflowPreset(
  preset: WorkflowPreset | null | undefined,
): "fix" | "feature" | null {
  if (preset === "fix") return "fix";
  if (preset === "fast-feature" || preset === "full-feature") return "feature";
  return null;
}

export function isProductWorkflowRoot(thread: {
  readonly interactionMode: ProviderInteractionMode;
  readonly workflowPreset?: WorkflowPreset | null;
  readonly workflowRole: string | null;
}): boolean {
  return (
    thread.workflowRole === null &&
    (thread.interactionMode === "product-workflow" ||
      isProductWorkflowPreset(thread.workflowPreset))
  );
}
