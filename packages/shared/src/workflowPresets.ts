import type { ProviderInteractionMode, WorkflowPreset } from "@t3tools/contracts";

export type WorkflowPresetRoute = "product" | "implementation" | "planning" | "review";

/**
 * One agent a step starts, as the model settings surface it.
 *
 * A step is a phase of the run, not a single agent: "Execute ticket waves"
 * starts TDD workers, ticket App Reviews, and ticket Code Reviews. Each entry
 * here is separately pinnable; the step's own pin covers any that are not.
 * Only work that runs in a thread of its own can appear — an agent's later
 * turns in the same thread keep the model that thread launched with.
 */
export interface WorkflowPresetSubStep {
  readonly label: string;
  readonly workflowPromptId: string;
  readonly note?: string;
}

export interface WorkflowPresetHelpStep {
  readonly label: string;
  readonly skillId?: string;
  readonly threadBoundary?: "same thread" | "new thread" | "new child thread" | "new review thread";
  readonly note?: string;
  /**
   * The agents this step starts, when it starts more than the one its own
   * `skillId` names. Absent means the step is its own single agent.
   */
  readonly subSteps?: ReadonlyArray<WorkflowPresetSubStep>;
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

/**
 * The three agents an App Review cycle runs, each in its own thread: the
 * review (the project's e2e commands first, then the browser), the gap
 * analysis that writes repair tickets, and the fix.
 */
const APP_REVIEW_SUB_STEPS: ReadonlyArray<WorkflowPresetSubStep> = [
  {
    label: "E2E tests & browser review",
    workflowPromptId: "implementation.browser-app-review.codex",
    note: "runs the project's e2eCommands first when t3.json declares them",
  },
  {
    label: "Gap analysis & repair tickets",
    workflowPromptId: "matt-pocock.to-tickets",
    note: "each ticket names the failing test its repair must make pass",
  },
  {
    label: "Repair implementation",
    workflowPromptId: "matt-pocock.implement",
  },
];

// These definitions remain available for decoding and rendering historical
// threads, but they are not selectable workflows or catalog entries.
const LEGACY_WORKFLOW_PRESET_DEFINITIONS: ReadonlyArray<WorkflowPresetDefinition> = [
  {
    id: "product-planning",
    label: "Product planning",
    description: "Legacy product-only planning workflow.",
    route: "product",
    interactionMode: "product-workflow",
    workflowPromptId: "product.planning.codex",
    helpSteps: [],
  },
  {
    id: "fix",
    label: "Fix",
    description: "Legacy fix workflow.",
    route: "product",
    interactionMode: "product-workflow",
    workflowPromptId: "product.fix.codex",
    helpSteps: [],
  },
];

// Keep every previously shipped definition available for rendering durable runs, while exposing
// only the unified Engineering Workflow as a new composer/catalog entry.
const GUIDED_WORKFLOW_PRESET_DEFINITIONS: ReadonlyArray<WorkflowPresetDefinition> = [
  {
    id: "fast-feature",
    label: "Fast feature",
    description: "Plan and build a focused feature quickly, then review it and open a PR.",
    route: "product",
    interactionMode: "plan",
    workflowPromptId: "planning.fast-feature.codex",
    helpSteps: [
      {
        label: "Planning",
        skillId: "planning.fast-feature.codex",
        threadBoundary: "same thread",
        note: "may delegate independent research in parallel",
      },
      {
        label: "Building",
        skillId: "implementation.tdd.codex",
        threadBoundary: "new child thread",
        note: "may delegate independent implementation work in parallel",
      },
      {
        label: "App Review",
        skillId: "implementation.browser-app-review.codex",
        threadBoundary: "new review thread",
        note: "may delegate independent review analysis in parallel",
      },
      {
        label: "Code Review",
        skillId: "implementation.code-review.codex",
        threadBoundary: "new review thread",
        note: "single pass, applies fixes, commits, and opens the PR for human handoff",
      },
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
        threadBoundary: "same thread",
        note: "human-guided",
      },
      {
        label: "Engineering Grill",
        skillId: "planning.engineering-grill-automatic.codex",
        threadBoundary: "same thread",
        note: "automatic",
      },
      {
        label: "Spec authoring",
        skillId: "planning.spec.codex",
        threadBoundary: "same thread",
        note: "automatic",
      },
      {
        label: "Planning tickets",
        skillId: "planning.tickets.codex",
        threadBoundary: "same thread",
        note: "automatic",
      },
      {
        label: "Ticket review and revision cycles",
        skillId: "planning.ticket-reviewer.codex",
        threadBoundary: "new review thread",
        note: "automatic; five cycles by default",
      },
      {
        label: "TDD implementation workers",
        skillId: "implementation.tdd.codex",
        threadBoundary: "new child thread",
        note: "automatic",
      },
      {
        label: "Merge gate and required validation",
        skillId: "implementation.merge-gate.codex",
        threadBoundary: "new child thread",
        note: "automatic",
      },
      { label: "Start and probe AppDevStack from the integrated worktree", note: "automatic" },
      {
        label: "Nested App Review against the shared AppDevStack",
        skillId: "implementation.browser-app-review.codex",
        threadBoundary: "new review thread",
        note: "automatic; App Review has its own cycle budget",
        subSteps: APP_REVIEW_SUB_STEPS,
      },
      {
        label: "Code Review",
        skillId: "implementation.code-review.codex",
        threadBoundary: "new review thread",
        note: "automatic; single pass, applies fixes and commits",
      },
      { label: "Change request publication", note: "automatic" },
    ],
  },
  {
    id: "app-review",
    label: "App Review",
    description:
      "Run the project's e2e tests, drive the running app in a browser, ticket every gap, and fix it.",
    route: "review",
    interactionMode: "default",
    // No entry prompt: sending in this mode dispatches an App Review launch
    // rather than a turn, and the run's reactor owns all three agents' prompts.
    helpSteps: [
      {
        label: "App Review cycles",
        skillId: "implementation.browser-app-review.codex",
        threadBoundary: "new review thread",
        note: "ten review, repair-ticket, and fix cycles by default; a passing review ends the run early",
        subSteps: APP_REVIEW_SUB_STEPS,
      },
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
      {
        label: "Name the destination",
        skillId: "planning.wayfinder.codex",
        threadBoundary: "same thread",
      },
      {
        label: "Engineering Grill",
        skillId: "planning.grill-stage.codex",
        threadBoundary: "same thread",
      },
      {
        label: "Create the Wayfinder Map",
        skillId: "planning.wayfinder.codex",
        threadBoundary: "same thread",
      },
      {
        label: "Resolve research tickets",
        skillId: "planning.research.codex",
        threadBoundary: "new child thread",
      },
      {
        label: "Resolve prototype tickets",
        skillId: "planning.prototype.codex",
        threadBoundary: "new child thread",
      },
      {
        label: "Advance the decision frontier",
        skillId: "planning.wayfinder.codex",
        threadBoundary: "same thread",
      },
      {
        label: "Hand off the resolved map to Spec authoring",
        skillId: "planning.spec.codex",
        threadBoundary: "same thread",
      },
    ],
  },
  {
    id: "implementation",
    label: "Implementation",
    description: "Implement durable tickets—or create them from the prompt—through review and PR.",
    route: "implementation",
    interactionMode: "implementation-workflow",
    workflowPromptId: "implementation.orchestrator-planning.codex",
    helpSteps: [
      {
        label: "Load Planning tickets or create tickets from the prompt",
        skillId: "implementation.orchestrator-planning.codex",
        threadBoundary: "same thread",
      },
      {
        label: "Execute ticket waves",
        skillId: "implementation.tdd.codex",
        threadBoundary: "new child thread",
        note: "workers, ten App Review cycles by default, and one Code Review per ticket",
        subSteps: [
          { label: "TDD implementation worker", workflowPromptId: "implementation.tdd.codex" },
          {
            label: "Ticket App Review",
            workflowPromptId: "implementation.browser-app-review.codex",
            note: "the review's own agents follow the App Review step",
          },
          { label: "Ticket Code Review", workflowPromptId: "implementation.code-review.codex" },
        ],
      },
      {
        label: "Merge ticket branches into the starting worktree",
        skillId: "implementation.merge-gate.codex",
        threadBoundary: "new child thread",
      },
      {
        label: "Run App Review",
        skillId: "implementation.browser-app-review.codex",
        threadBoundary: "new review thread",
        note: "ten review, repair-plan, and fix cycles by default",
        subSteps: APP_REVIEW_SUB_STEPS,
      },
      {
        label: "Final Code Review",
        skillId: "implementation.code-review.codex",
        threadBoundary: "new review thread",
        note: "includes final validation",
      },
      {
        label: "Create pull request",
        note: "publishes the reviewed and validated branch",
      },
      {
        label: "Babysit pull request",
        skillId: "implementation.change-request-babysitter.codex",
        threadBoundary: "new review thread",
        note: "fixes CI or review failures until the latest commit is green",
      },
    ],
  },
  {
    id: "planning",
    label: "Engineering Workflow",
    description:
      "Plan with a Product or Engineering Grill, then implement, review, and publish the result.",
    route: "planning",
    interactionMode: "planning-workflow",
    // The first turn is the grill, and naming it here is what earns the thread
    // its structured-question tool: the session is provisioned from the prompt
    // id the turn carries, not from the interaction mode alone.
    workflowPromptId: "planning.grill-stage.codex",
    helpSteps: [
      { label: "Planning phase · Prepare shared worktree and App Dev Stack", note: "automatic" },
      {
        label: "Planning phase · Grill with Docs",
        skillId: "planning.grill-stage.codex",
        threadBoundary: "same thread",
        note: "human-guided",
      },
      {
        label: "Planning phase · Spec authoring",
        skillId: "planning.spec.codex",
        threadBoundary: "same thread",
        note: "automatic",
      },
      {
        label: "Planning phase · Ticket authoring",
        skillId: "planning.tickets.codex",
        threadBoundary: "same thread",
        note: "automatic",
      },
      {
        label: "Planning phase · Ticket review and revision cycles",
        skillId: "planning.ticket-reviewer.codex",
        threadBoundary: "new review thread",
        note: "automatic; five cycles by default",
      },
      {
        label: "Implementation phase · Execute ticket waves",
        skillId: "implementation.tdd.codex",
        threadBoundary: "new child thread",
        note: "automatic; parallel workers, eligible App Reviews, and one Code Review per ticket",
        subSteps: [
          { label: "TDD implementation worker", workflowPromptId: "implementation.tdd.codex" },
          {
            label: "Ticket App Review",
            workflowPromptId: "implementation.browser-app-review.codex",
            note: "the review's own agents follow the App Review step",
          },
          { label: "Ticket Code Review", workflowPromptId: "implementation.code-review.codex" },
        ],
      },
      {
        label: "Implementation phase · Merge ticket branches",
        skillId: "implementation.merge-gate.codex",
        threadBoundary: "new child thread",
        note: "automatic",
      },
      {
        label: "Implementation phase · App Review",
        skillId: "implementation.browser-app-review.codex",
        threadBoundary: "new review thread",
        note: "automatic; ten review, repair-plan, and fix cycles by default",
        subSteps: APP_REVIEW_SUB_STEPS,
      },
      {
        label: "Implementation phase · Final Code Review",
        skillId: "implementation.code-review.codex",
        threadBoundary: "new review thread",
        note: "automatic; includes final validation",
      },
      {
        label: "Implementation phase · Create pull request",
        note: "automatic; publishes the reviewed and validated branch",
      },
      {
        label: "Implementation phase · Babysit pull request",
        skillId: "implementation.change-request-babysitter.codex",
        threadBoundary: "new review thread",
        note: "automatic; fixes CI or review failures until the latest commit is green",
      },
    ],
  },
];

export const WORKFLOW_PRESET_DEFINITIONS: ReadonlyArray<WorkflowPresetDefinition> = [
  "fast-feature",
  "planning",
  "wayfinder",
  "app-review",
].map((id) => GUIDED_WORKFLOW_PRESET_DEFINITIONS.find((definition) => definition.id === id)!);

export const WORKFLOW_PRESET_DEFINITION_BY_ID = Object.fromEntries(
  [...LEGACY_WORKFLOW_PRESET_DEFINITIONS, ...GUIDED_WORKFLOW_PRESET_DEFINITIONS].map(
    (definition) => [definition.id, definition],
  ),
) as Readonly<Record<WorkflowPreset, WorkflowPresetDefinition>>;

/** Whether a workflow step runs turns in the workflow root instead of starting a thread. */
export function workflowPresetStepUsesRootThread(
  preset: WorkflowPreset,
  step: WorkflowPresetHelpStep,
): boolean {
  if (step.threadBoundary !== undefined) return step.threadBoundary === "same thread";
  const definition = WORKFLOW_PRESET_DEFINITION_BY_ID[preset];
  if (step.skillId !== undefined && step.skillId === definition.workflowPromptId) return true;
  if (step.label.toLowerCase().includes("create shared worktree")) return true;
  return false;
}

/** Model pins only apply when the step starts an agent in a separate thread. */
export function workflowPresetStepCanPinModel(
  preset: WorkflowPreset,
  step: WorkflowPresetHelpStep,
): step is WorkflowPresetHelpStep & { readonly skillId: string } {
  return step.skillId !== undefined && !workflowPresetStepUsesRootThread(preset, step);
}

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
): preset is "fix" | "fast-feature" | "full-feature" | "product-planning" {
  return (
    preset === "fix" ||
    preset === "fast-feature" ||
    preset === "full-feature" ||
    preset === "product-planning"
  );
}

export function expectedIntentKindForWorkflowPreset(
  preset: WorkflowPreset | null | undefined,
): "fix" | "feature" | null {
  if (preset === "fix") return "fix";
  if (preset === "fast-feature" || preset === "full-feature" || preset === "product-planning")
    return "feature";
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
