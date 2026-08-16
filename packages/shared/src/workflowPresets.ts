import type { ProviderInteractionMode, WorkflowPreset } from "@t3tools/contracts";

export type WorkflowPresetRoute = "product" | "implementation" | "planning" | "review";

export interface WorkflowPresetHelpStep {
  readonly label: string;
  readonly skillId?: string;
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

// These definitions remain available for decoding and rendering historical
// threads, but they are not selectable workflows or catalog entries.
const LEGACY_WORKFLOW_PRESET_DEFINITIONS: ReadonlyArray<WorkflowPresetDefinition> = [
  {
    id: "fix",
    label: "Fix",
    description: "Legacy fix workflow.",
    route: "product",
    interactionMode: "product-workflow",
    workflowPromptId: "product.fix.codex",
    helpSteps: [],
  },
  {
    id: "app-review",
    label: "App Review",
    description: "Nested or panel-launched browser review workflow.",
    route: "review",
    interactionMode: "default",
    helpSteps: [],
  },
];

export const WORKFLOW_PRESET_DEFINITIONS: ReadonlyArray<WorkflowPresetDefinition> = [
  {
    id: "fast-feature",
    label: "Fast feature",
    description: "Plan and build a focused feature, then run both review loops.",
    route: "product",
    interactionMode: "product-workflow",
    workflowPromptId: "product.fast-feature.codex",
    helpSteps: [
      { label: "Create shared worktree" },
      {
        label: "Product Grill",
        skillId: "product.fast-feature.codex",
        threadBoundary: "same thread",
      },
      { label: "CLI Plan mode", threadBoundary: "same thread" },
      {
        label: "CLI Build in the shared worktree",
        skillId: "implementation.tdd.codex",
        threadBoundary: "new child thread",
      },
      { label: "Start and probe AppDevStack from the completed Build" },
      {
        label: "Run nested App Review against AppDevStack",
        skillId: "implementation.browser-app-review.codex",
        threadBoundary: "new review thread",
        note: "App Review owns UI review, same-thread planning, and fresh Implement cycles",
      },
      {
        label: "Code Review",
        skillId: "implementation.code-review.codex",
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
      { label: "Create shared worktree", note: "automatic" },
      {
        label: "Product Grill",
        skillId: "product.full-feature.codex",
        note: "human-guided",
      },
      {
        label: "Engineering Grill",
        skillId: "planning.engineering-grill-automatic.codex",
        note: "automatic",
      },
      { label: "Spec authoring", skillId: "planning.spec.codex", note: "automatic" },
      { label: "Planning tickets", skillId: "planning.tickets.codex", note: "automatic" },
      {
        label: "Ticket review and revision cycles",
        skillId: "planning.ticket-reviewer.codex",
        note: "automatic; up to three cycles",
      },
      {
        label: "TDD implementation workers",
        skillId: "implementation.tdd.codex",
        note: "automatic",
      },
      {
        label: "Merge gate and required validation",
        skillId: "implementation.merge-gate.codex",
        note: "automatic",
      },
      { label: "Start and probe AppDevStack from the integrated worktree", note: "automatic" },
      {
        label: "Nested App Review against the shared AppDevStack",
        skillId: "implementation.browser-app-review.codex",
        note: "automatic; App Review has its own cycle budget",
      },
      {
        label: "Code Review",
        skillId: "implementation.code-review.codex",
        note: "automatic; single pass, applies fixes and commits",
      },
      { label: "Change request publication", note: "automatic" },
    ],
  },
  {
    id: "wayfinder",
    label: "Wayfinder",
    description:
      "Map a large, uncertain effort into durable decision tickets before writing a Spec.",
    route: "planning",
    interactionMode: "planning-workflow",
    workflowPromptId: "planning.wayfinder.codex",
    helpSteps: [
      { label: "Name the destination", skillId: "planning.wayfinder.codex" },
      { label: "Engineering Grill", skillId: "planning.grill-stage.codex" },
      { label: "Create the Wayfinder Map", skillId: "planning.wayfinder.codex" },
      { label: "Resolve research tickets", skillId: "planning.research.codex" },
      { label: "Resolve prototype tickets", skillId: "planning.prototype.codex" },
      { label: "Advance the decision frontier", skillId: "planning.wayfinder.codex" },
      { label: "Hand off the resolved map to Spec authoring", skillId: "planning.spec.codex" },
    ],
  },
  {
    id: "implementation",
    label: "Implementation",
    description: "Implement a selected Spec through validation and review.",
    route: "implementation",
    interactionMode: "implementation-workflow",
    helpSteps: [
      {
        label: "Load the selected Spec and reuse its Planning workspace",
        skillId: "implementation.orchestrator-planning.codex",
      },
      {
        label: "Run dependency-aware TDD implementation workers",
        skillId: "implementation.tdd.codex",
      },
      {
        label: "Integrate worker branches and run the merge gate",
        skillId: "implementation.merge-gate.codex",
      },
      { label: "Start and probe AppDevStack from the integrated worktree" },
      {
        label: "Run nested App Review against the shared AppDevStack",
        skillId: "implementation.browser-app-review.codex",
        note: "App Review has its own cycle budget",
      },
      {
        label: "Run Code Review",
        skillId: "implementation.code-review.codex",
        note: "single pass, applies fixes and commits",
      },
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
      { label: "Create shared worktree" },
      {
        label: "Engineering Grill",
        skillId: "planning.grill-stage.codex",
        note: "human-guided",
      },
      { label: "Spec authoring", skillId: "planning.spec.codex", note: "automatic" },
      {
        label: "Planning-ticket authoring",
        skillId: "planning.tickets.codex",
        note: "automatic",
      },
      {
        label: "Ticket review and revision cycles",
        skillId: "planning.ticket-reviewer.codex",
        note: "automatic; up to three cycles",
      },
    ],
  },
];

export const WORKFLOW_PRESET_DEFINITION_BY_ID = Object.fromEntries(
  [...LEGACY_WORKFLOW_PRESET_DEFINITIONS, ...WORKFLOW_PRESET_DEFINITIONS].map((definition) => [
    definition.id,
    definition,
  ]),
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
