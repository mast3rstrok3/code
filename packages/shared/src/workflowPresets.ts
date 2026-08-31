import type {
  ImplementationWorkflowSettings,
  ProviderInteractionMode,
  WorkflowPreset,
} from "@t3tools/contracts";

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
  readonly group?: "plan" | "engineering";
  readonly availability?: "available" | "under-development";
  readonly unavailableReason?: string;
  readonly implementationDefaults?: ImplementationWorkflowSettings;
}

const FULL_IMPLEMENTATION_DEFAULTS: ImplementationWorkflowSettings = {
  ticketAppReviewEnabled: true,
  appReviewEnabled: true,
  finalCodeReviewEnabled: true,
  pullRequestCreationEnabled: true,
  pullRequestBabysittingEnabled: true,
};

/**
 * The four agents an App Review cycle runs in order, each in its own thread:
 * end-to-end tests, browser review, gap analysis, and the fix.
 */
const APP_REVIEW_SUB_STEPS: ReadonlyArray<WorkflowPresetSubStep> = [
  {
    label: "End-to-end test",
    workflowPromptId: "implementation.e2e-app-review.codex",
    note: "runs the project's e2eCommands when t3.json declares them",
  },
  {
    label: "Browser review",
    workflowPromptId: "implementation.browser-app-review.codex",
    note: "reviews what the automated tests cannot prove and saves browser evidence",
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

const PLAN_HELP_STEPS: ReadonlyArray<WorkflowPresetHelpStep> = [
  {
    label: "Planning",
    skillId: "planning.fast-feature.codex",
    threadBoundary: "same thread",
    note: "uses native CLI Plan mode and answers planning questions automatically",
  },
  {
    label: "Build",
    skillId: "implementation.tdd.codex",
    threadBoundary: "new child thread",
    note: "runs every planned workstream in order in one Build thread",
  },
  {
    label: "App Review",
    skillId: "implementation.browser-app-review.codex",
    threadBoundary: "new review thread",
    note: "runs acceptance lanes in order in the durable reviewer thread",
    subSteps: APP_REVIEW_SUB_STEPS,
  },
  {
    label: "Final Code Review",
    skillId: "implementation.code-review.codex",
    threadBoundary: "new review thread",
    note: "one review-and-fix thread per cycle; stops clean or repeats up to five cycles",
  },
  { label: "Create pull request", note: "publishes the reviewed branch" },
  {
    label: "Babysit pull request",
    skillId: "implementation.change-request-babysitter.codex",
    threadBoundary: "new review thread",
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
    description: "Plan a focused feature, then build and review it one stage thread at a time.",
    route: "product",
    interactionMode: "plan",
    workflowPromptId: "planning.fast-feature.codex",
    helpSteps: [
      {
        label: "Planning",
        skillId: "planning.fast-feature.codex",
        threadBoundary: "same thread",
        note: "discovers repository facts in the planning thread",
      },
      {
        label: "Building",
        skillId: "implementation.tdd.codex",
        threadBoundary: "new child thread",
        note: "runs ordered workstreams in one Build thread",
      },
      {
        label: "App Review",
        skillId: "implementation.browser-app-review.codex",
        threadBoundary: "new review thread",
        note: "runs acceptance lanes in order in the durable reviewer thread",
      },
      {
        label: "Code Review",
        skillId: "implementation.code-review.codex",
        threadBoundary: "new review thread",
        note: "one thread per review-and-fix cycle; stops clean or repeats up to five cycles",
      },
    ],
  },
  {
    id: "quick-plan",
    label: "Quick Plan",
    description: "Plan with the provider CLI, build the change, validate it, and stop.",
    route: "product",
    interactionMode: "plan",
    workflowPromptId: "planning.fast-feature.codex",
    helpSteps: PLAN_HELP_STEPS,
    group: "plan",
    availability: "available",
    implementationDefaults: {
      ...FULL_IMPLEMENTATION_DEFAULTS,
      appReviewEnabled: false,
      finalCodeReviewEnabled: false,
      pullRequestCreationEnabled: false,
      pullRequestBabysittingEnabled: false,
    },
  },
  {
    id: "fast-plan",
    label: "Fast Plan",
    description: "Plan and build with the provider CLI, then review and publish the change.",
    route: "product",
    interactionMode: "plan",
    workflowPromptId: "planning.fast-feature.codex",
    helpSteps: PLAN_HELP_STEPS,
    group: "plan",
    availability: "available",
    implementationDefaults: FULL_IMPLEMENTATION_DEFAULTS,
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
      { label: "Start and probe AppStack from the integrated worktree", note: "automatic" },
      {
        label: "Nested App Review against the shared AppStack",
        skillId: "implementation.browser-app-review.codex",
        threadBoundary: "new review thread",
        note: "automatic; App Review has its own cycle budget",
        subSteps: APP_REVIEW_SUB_STEPS,
      },
      {
        label: "Code Review",
        skillId: "implementation.code-review.codex",
        threadBoundary: "new review thread",
        note: "automatic; one thread per review-and-fix cycle, up to five cycles",
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
    // rather than a turn, and the run's reactor owns all four agents' prompts.
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
    group: "engineering",
    availability: "under-development",
    unavailableReason: "Under development",
    implementationDefaults: FULL_IMPLEMENTATION_DEFAULTS,
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
    description:
      "Run every ready ticket concurrently, with one active thread per ticket or root review step.",
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
        note: "all ready tickets concurrently; one logical implementation per ticket with one interrupted-launch retry",
        subSteps: [
          { label: "TDD implementation worker", workflowPromptId: "implementation.tdd.codex" },
          {
            label: "Ticket App Review",
            workflowPromptId: "implementation.browser-app-review.codex",
            note: "the review's own agents follow the App Review step",
          },
          {
            label: "Ticket Code Review",
            workflowPromptId: "implementation.code-review.codex",
            note: "stops clean or repeats findings in a fresh cycle, up to five cycles",
          },
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
        note: "one active thread per ordered review phase; ten cycles maximum and one interrupted-phase retry",
        subSteps: APP_REVIEW_SUB_STEPS,
      },
      {
        label: "Final Code Review",
        skillId: "implementation.code-review.codex",
        threadBoundary: "new review thread",
        note: "one thread per cycle; stops clean or repeats up to five cycles and owns final validation",
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
      "Plan, run every ready ticket concurrently, then use one thread for each ticket or root step.",
    route: "planning",
    interactionMode: "planning-workflow",
    // The first turn is the grill, and naming it here is what earns the thread
    // its structured-question tool: the session is provisioned from the prompt
    // id the turn carries, not from the interaction mode alone.
    workflowPromptId: "planning.grill-stage.codex",
    group: "engineering",
    availability: "available",
    implementationDefaults: FULL_IMPLEMENTATION_DEFAULTS,
    helpSteps: [
      { label: "Prepare shared worktree and App Stack", note: "automatic" },
      {
        label: "Grill with Docs",
        skillId: "planning.grill-stage.codex",
        threadBoundary: "same thread",
        note: "human-guided",
      },
      {
        label: "Spec authoring",
        skillId: "planning.spec.codex",
        threadBoundary: "same thread",
        note: "automatic",
      },
      {
        label: "Ticket authoring",
        skillId: "planning.tickets.codex",
        threadBoundary: "same thread",
        note: "automatic",
      },
      {
        label: "Ticket review and revision",
        skillId: "planning.ticket-reviewer.codex",
        threadBoundary: "new review thread",
        note: "automatic; five cycles by default and five at most",
      },
      {
        label: "Execute ticket waves",
        skillId: "implementation.tdd.codex",
        threadBoundary: "new child thread",
        note: "automatic; all ready tickets concurrently, with one active step thread per ticket",
        subSteps: [
          { label: "TDD implementation worker", workflowPromptId: "implementation.tdd.codex" },
          {
            label: "Ticket App Review",
            workflowPromptId: "implementation.browser-app-review.codex",
            note: "the review's own agents follow the App Review step",
          },
          {
            label: "Ticket Code Review",
            workflowPromptId: "implementation.code-review.codex",
            note: "stops clean or repeats findings in a fresh cycle, up to five cycles",
          },
        ],
      },
      {
        label: "Merge ticket branches",
        skillId: "implementation.merge-gate.codex",
        threadBoundary: "new child thread",
        note: "automatic",
      },
      {
        label: "Final App Review",
        skillId: "implementation.browser-app-review.codex",
        threadBoundary: "new review thread",
        note: "automatic; one active thread per ordered review phase; ten review cycles by default",
        subSteps: APP_REVIEW_SUB_STEPS,
      },
      {
        label: "Final Code Review",
        skillId: "implementation.code-review.codex",
        threadBoundary: "new review thread",
        note: "automatic; one thread per cycle, up to five cycles, with complete validation in the ending cycle",
      },
      {
        label: "Create pull request",
        note: "automatic; publishes the reviewed and validated branch",
      },
      {
        label: "Babysit pull request",
        skillId: "implementation.change-request-babysitter.codex",
        threadBoundary: "new review thread",
        note: "automatic; fixes CI or review failures until the latest commit is green",
      },
    ],
  },
];

const ENGINEERING_WORKFLOW_DEFINITION = GUIDED_WORKFLOW_PRESET_DEFINITIONS.find(
  (definition) => definition.id === "planning",
)!;

const FAST_ENGINEERING_WORKFLOW_DEFINITION: WorkflowPresetDefinition = {
  ...ENGINEERING_WORKFLOW_DEFINITION,
  id: "fast-engineering",
  label: "Fast Engineering",
  description:
    "Run the Engineering Workflow with ticket and combined App Reviews skipped by default.",
  implementationDefaults: {
    ...FULL_IMPLEMENTATION_DEFAULTS,
    ticketAppReviewEnabled: false,
    appReviewEnabled: false,
  },
};

const ALL_WORKFLOW_PRESET_DEFINITIONS: ReadonlyArray<WorkflowPresetDefinition> = [
  ...GUIDED_WORKFLOW_PRESET_DEFINITIONS,
  FAST_ENGINEERING_WORKFLOW_DEFINITION,
];

export const WORKFLOW_PRESET_DEFINITIONS: ReadonlyArray<WorkflowPresetDefinition> = [
  "quick-plan",
  "fast-plan",
  "fast-engineering",
  "planning",
  "wayfinder",
].map((id) => ALL_WORKFLOW_PRESET_DEFINITIONS.find((definition) => definition.id === id)!);

export const WORKFLOW_PRESET_DEFINITION_BY_ID = Object.fromEntries(
  [...LEGACY_WORKFLOW_PRESET_DEFINITIONS, ...ALL_WORKFLOW_PRESET_DEFINITIONS].map((definition) => [
    definition.id,
    definition,
  ]),
) as Readonly<Record<WorkflowPreset, WorkflowPresetDefinition>>;

export function normalizeImplementationWorkflowSettings(
  settings: ImplementationWorkflowSettings,
): ImplementationWorkflowSettings {
  if (settings.pullRequestCreationEnabled || !settings.pullRequestBabysittingEnabled) {
    return settings;
  }
  return { ...settings, pullRequestBabysittingEnabled: false };
}

export function implementationDefaultsForWorkflowPreset(
  preset: WorkflowPreset,
): ImplementationWorkflowSettings | null {
  const defaults = WORKFLOW_PRESET_DEFINITION_BY_ID[preset].implementationDefaults;
  return defaults === undefined ? null : normalizeImplementationWorkflowSettings({ ...defaults });
}

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
): preset is
  | "fix"
  | "fast-feature"
  | "quick-plan"
  | "fast-plan"
  | "full-feature"
  | "product-planning" {
  return (
    preset === "fix" ||
    preset === "fast-feature" ||
    preset === "quick-plan" ||
    preset === "fast-plan" ||
    preset === "full-feature" ||
    preset === "product-planning"
  );
}

export function expectedIntentKindForWorkflowPreset(
  preset: WorkflowPreset | null | undefined,
): "fix" | "feature" | null {
  if (preset === "fix") return "fix";
  if (
    preset === "fast-feature" ||
    preset === "quick-plan" ||
    preset === "fast-plan" ||
    preset === "full-feature" ||
    preset === "product-planning"
  )
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
