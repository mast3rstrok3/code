import {
  type AppReviewWorkflowPhase,
  type ModelSelection,
  type OrchestrationImplementationRerunTarget,
  type OrchestrationThreadWorkflowRole,
  type ProviderInteractionMode,
  type ProviderOptionSelection,
  type ProviderDriverKind,
  type ServerSettings,
  type WorkflowStepModelOverride,
  type WorkflowStepReviewPartsOverride,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";

import { WORKFLOW_PROMPT_IDS } from "../provider/WorkflowPromptRegistry.ts";
import {
  findEnabledProviderInstanceIdForDriver,
  isProviderInstanceEnabled,
} from "../serverSettings.ts";

export type WorkflowSubagentParentWorkflowRole = OrchestrationThreadWorkflowRole | null;

export interface WorkflowSubagentSpawnDefinition {
  readonly workflowPromptId: string;
  readonly interactionMode: ProviderInteractionMode;
  readonly workflowRole: OrchestrationThreadWorkflowRole | null;
  readonly threadIdTag: string;
  readonly defaultTitlePrefix: string;
  readonly expectedResult: string;
  readonly allowedParentWorkflowRoles: "any" | ReadonlyArray<WorkflowSubagentParentWorkflowRole>;
  readonly disallowedParentWorkflowRoles?: ReadonlyArray<WorkflowSubagentParentWorkflowRole>;
  /**
   * Lock this sub-agent to a specific driver/model regardless of the parent
   * thread's selection. Applied at spawn time by
   * `resolveWorkflowSubagentModelSelection`; when no enabled instance of the
   * driver exists the spawn falls back to the parent's selection.
   *
   * No shipped definition sets one. A workflow step runs the model the
   * workflow was started with unless the user pins the step, so adding an
   * override here silently overrides the user's own choice for every run.
   */
  readonly modelOverride?: {
    readonly driver: ProviderDriverKind;
    readonly model: string;
    readonly options?: ReadonlyArray<ProviderOptionSelection>;
  };
}

const WORKFLOW_SUBAGENT_SPAWN_DEFINITIONS: ReadonlyArray<WorkflowSubagentSpawnDefinition> = [
  ...(
    [
      [WORKFLOW_PROMPT_IDS.productFixCodex, "Product Fix", "product-fix"],
      [WORKFLOW_PROMPT_IDS.productFastFeatureCodex, "Product Fast Feature", "product-fast-feature"],
      [WORKFLOW_PROMPT_IDS.productFullFeatureCodex, "Product Full Feature", "product-full-feature"],
      [WORKFLOW_PROMPT_IDS.productPlanningCodex, "Product Planning", "product-planning"],
    ] as const
  ).map(
    ([workflowPromptId, title, threadIdTag]): WorkflowSubagentSpawnDefinition => ({
      workflowPromptId,
      interactionMode: "product-workflow",
      workflowRole: null,
      threadIdTag: `workflow-${threadIdTag}`,
      defaultTitlePrefix: title,
      expectedResult: "product-intent-locked",
      allowedParentWorkflowRoles: "any",
    }),
  ),
  {
    workflowPromptId: WORKFLOW_PROMPT_IDS.planningGrillStageCodex,
    interactionMode: "planning-workflow",
    workflowRole: "planning-orchestrator",
    threadIdTag: "workflow-planning-grill",
    defaultTitlePrefix: "Planning Grill",
    expectedResult: "planning-spec-artifact",
    allowedParentWorkflowRoles: "any",
  },
  {
    workflowPromptId: WORKFLOW_PROMPT_IDS.planningSpecCodex,
    interactionMode: "planning-workflow",
    workflowRole: "planning-orchestrator",
    threadIdTag: "workflow-planning-spec",
    defaultTitlePrefix: "Planning Spec",
    expectedResult: "planning-spec-artifact",
    allowedParentWorkflowRoles: "any",
  },
  {
    workflowPromptId: WORKFLOW_PROMPT_IDS.planningTicketsCodex,
    interactionMode: "planning-workflow",
    workflowRole: "planning-orchestrator",
    threadIdTag: "workflow-planning-tickets",
    defaultTitlePrefix: "Planning Tickets",
    expectedResult: "planning-tickets-artifact",
    allowedParentWorkflowRoles: "any",
  },
  {
    workflowPromptId: WORKFLOW_PROMPT_IDS.planningTicketReviewerCodex,
    interactionMode: "planning-workflow",
    workflowRole: "planning-reviewer",
    threadIdTag: "workflow-planning-reviewer",
    defaultTitlePrefix: "Planning Review",
    expectedResult: "planning-reviewer-verdict",
    allowedParentWorkflowRoles: [null, "planning-orchestrator"],
  },
  ...[
    [WORKFLOW_PROMPT_IDS.planningDomainModelingCodex, "Domain Modeling", "domain-modeling"],
    [WORKFLOW_PROMPT_IDS.planningPrototypeCodex, "Prototype", "prototype"],
    [WORKFLOW_PROMPT_IDS.planningWayfinderCodex, "Wayfinder", "wayfinder"],
    [WORKFLOW_PROMPT_IDS.planningResearchCodex, "Research", "research"],
  ].map(([workflowPromptId, title, tag]) => ({
    workflowPromptId: workflowPromptId!,
    interactionMode: "planning-workflow" as const,
    workflowRole: "planning-reviewer" as const,
    threadIdTag: `workflow-planning-${tag}`,
    defaultTitlePrefix: title!,
    expectedResult: "workflow-subagent-result",
    allowedParentWorkflowRoles: "any" as const,
  })),
  {
    workflowPromptId: WORKFLOW_PROMPT_IDS.implementationOrchestratorPlanningCodex,
    interactionMode: "implementation-workflow",
    workflowRole: "implementation-orchestrator",
    threadIdTag: "workflow-implementation-orchestrator",
    defaultTitlePrefix: "Implementation Orchestrator",
    expectedResult: "implementation-worker-result",
    allowedParentWorkflowRoles: "any",
  },
  {
    workflowPromptId: WORKFLOW_PROMPT_IDS.implementationTddCodex,
    interactionMode: "implementation-workflow",
    workflowRole: "implementation-worker",
    threadIdTag: "workflow-implementation-worker",
    defaultTitlePrefix: "Implementation Worker",
    expectedResult: "implementation-worker-result",
    allowedParentWorkflowRoles: [null, "implementation-orchestrator"],
  },
  {
    workflowPromptId: WORKFLOW_PROMPT_IDS.implementationMergeGateCodex,
    interactionMode: "implementation-workflow",
    workflowRole: "implementation-validator",
    threadIdTag: "workflow-implementation-validator",
    defaultTitlePrefix: "Implementation Merge Gate",
    expectedResult: "implementation-merge-gate-result",
    allowedParentWorkflowRoles: [null, "implementation-orchestrator"],
  },
  {
    workflowPromptId: WORKFLOW_PROMPT_IDS.implementationBrowserAppReviewCodex,
    interactionMode: "implementation-workflow",
    workflowRole: "implementation-qa-reviewer",
    threadIdTag: "workflow-implementation-qa-reviewer",
    defaultTitlePrefix: "Browser App Review",
    expectedResult: "app-review-document",
    allowedParentWorkflowRoles: "any",
  },
  {
    workflowPromptId: WORKFLOW_PROMPT_IDS.implementationFixCodex,
    interactionMode: "implementation-workflow",
    workflowRole: "implementation-fixer",
    threadIdTag: "workflow-implementation-fixer",
    defaultTitlePrefix: "Implementation Fix",
    expectedResult: "implementation-fix-result",
    allowedParentWorkflowRoles: [null, "implementation-orchestrator"],
  },
  {
    workflowPromptId: WORKFLOW_PROMPT_IDS.implementationCodeReviewCodex,
    interactionMode: "implementation-workflow",
    workflowRole: "implementation-code-reviewer",
    threadIdTag: "workflow-implementation-code-reviewer",
    defaultTitlePrefix: "Implementation Code Review",
    expectedResult: "implementation-code-review-result",
    allowedParentWorkflowRoles: [null, "implementation-orchestrator"],
  },
];

const WORKFLOW_SUBAGENT_SPAWN_DEFINITION_BY_PROMPT_ID = new Map(
  WORKFLOW_SUBAGENT_SPAWN_DEFINITIONS.map((definition) => [
    definition.workflowPromptId,
    definition,
  ]),
);

export function resolveWorkflowSubagentSpawnDefinition(
  workflowPromptId: string,
): WorkflowSubagentSpawnDefinition | undefined {
  return WORKFLOW_SUBAGENT_SPAWN_DEFINITION_BY_PROMPT_ID.get(workflowPromptId);
}

export function isWorkflowSubagentParentRoleAllowed(
  definition: WorkflowSubagentSpawnDefinition,
  workflowRole: WorkflowSubagentParentWorkflowRole,
): boolean {
  if (definition.disallowedParentWorkflowRoles?.includes(workflowRole)) return false;
  return (
    definition.allowedParentWorkflowRoles === "any" ||
    definition.allowedParentWorkflowRoles.includes(workflowRole)
  );
}

/**
 * Resolve the model selection a workflow sub-agent should be spawned with.
 *
 * Definitions without a `modelOverride` inherit the parent's selection. For
 * overridden definitions, the override is applied when an enabled instance of
 * the override driver exists (preferring the parent's own instance so a codex
 * parent keeps its account); otherwise the spawn falls back to the parent's
 * selection and `fallbackDetail` explains why, so callers can surface an
 * activity instead of blocking the run.
 */
export function resolveWorkflowSubagentModelSelection(input: {
  readonly definition: WorkflowSubagentSpawnDefinition | undefined;
  readonly parentModelSelection: ModelSelection;
  readonly settings: ServerSettings | undefined;
}): {
  readonly modelSelection: ModelSelection;
  readonly overrideApplied: boolean;
  readonly fallbackDetail: string | null;
} {
  const override = input.definition?.modelOverride;
  if (override === undefined) {
    return {
      modelSelection: input.parentModelSelection,
      overrideApplied: false,
      fallbackDetail: null,
    };
  }

  if (input.settings === undefined) {
    return {
      modelSelection: input.parentModelSelection,
      overrideApplied: false,
      fallbackDetail: `Server settings could not be read; keeping the parent model selection instead of '${override.driver}' model '${override.model}'.`,
    };
  }

  const instanceId = findEnabledProviderInstanceIdForDriver(
    input.settings,
    override.driver,
    input.parentModelSelection.instanceId,
  );
  if (instanceId === undefined) {
    return {
      modelSelection: input.parentModelSelection,
      overrideApplied: false,
      fallbackDetail: `No enabled '${override.driver}' provider instance is configured; keeping the parent model selection instead of '${override.driver}' model '${override.model}'.`,
    };
  }

  return {
    modelSelection: createModelSelection(instanceId, override.model, override.options),
    overrideApplied: true,
    fallbackDetail: null,
  };
}

/**
 * A thread as far as step pins are concerned: pins live on the workflow root,
 * so any thread of a run can find them through its workflow context.
 */
export interface WorkflowStepModelThread {
  readonly id: string;
  readonly workflowContext?: { readonly rootThreadId: string } | null | undefined;
  readonly workflowStepModels?: ReadonlyArray<WorkflowStepModelOverride> | undefined;
}

/**
 * Find the step pins that govern `thread`'s run.
 *
 * Nested runs (an implementation orchestrator under a planning root) carry the
 * root's id in their workflow context, so a spawn deep in the run still reads
 * the pins the user set on the workflow they see in the panel.
 */
export function findWorkflowStepModels(
  thread: WorkflowStepModelThread,
  threads: ReadonlyArray<WorkflowStepModelThread>,
): ReadonlyArray<WorkflowStepModelOverride> | undefined {
  const rootThreadId = thread.workflowContext?.rootThreadId ?? thread.id;
  if (rootThreadId === thread.id) return thread.workflowStepModels;
  return (
    threads.find((candidate) => candidate.id === rootThreadId)?.workflowStepModels ??
    thread.workflowStepModels
  );
}

/** A thread as far as run-level App Review parts are concerned. */
export interface WorkflowStepReviewPartsThread {
  readonly id: string;
  readonly workflowContext?: { readonly rootThreadId: string } | null | undefined;
  readonly workflowStepReviewParts?: ReadonlyArray<WorkflowStepReviewPartsOverride> | undefined;
}

/**
 * Find the run-level App Review parts that govern `thread`'s run. Like the
 * step pins, they live on the workflow root.
 */
export function findWorkflowStepReviewParts(
  thread: WorkflowStepReviewPartsThread,
  threads: ReadonlyArray<WorkflowStepReviewPartsThread>,
): ReadonlyArray<WorkflowStepReviewPartsOverride> | undefined {
  const rootThreadId = thread.workflowContext?.rootThreadId ?? thread.id;
  if (rootThreadId === thread.id) return thread.workflowStepReviewParts;
  return (
    threads.find((candidate) => candidate.id === rootThreadId)?.workflowStepReviewParts ??
    thread.workflowStepReviewParts
  );
}

/**
 * Find the pin that governs one spawn, most specific first:
 *   1. this sub-step's own pin, scoped to the step that starts it
 *   2. the step's pin, which covers every agent the step starts
 *   3. an unscoped pin on this prompt — only when the spawn *is* the step,
 *      otherwise it would pick up a sibling step's pin (a ticket Code Review
 *      would inherit the final Code Review's model)
 */
function findWorkflowStepPin(
  pins: ReadonlyArray<WorkflowStepModelOverride>,
  workflowPromptId: string,
  stepWorkflowPromptId: string | undefined,
): WorkflowStepModelOverride | undefined {
  if (stepWorkflowPromptId === undefined) {
    return pins.find(
      (entry) =>
        entry.workflowPromptId === workflowPromptId && entry.stepWorkflowPromptId === undefined,
    );
  }
  return (
    pins.find(
      (entry) =>
        entry.workflowPromptId === workflowPromptId &&
        entry.stepWorkflowPromptId === stepWorkflowPromptId,
    ) ??
    pins.find(
      (entry) =>
        entry.workflowPromptId === stepWorkflowPromptId && entry.stepWorkflowPromptId === undefined,
    )
  );
}

/**
 * Resolve the model a workflow step should run with, honoring the user's
 * per-step pin ahead of any definition hardlock.
 *
 * Precedence is deliberate: a pin set from the Workflows panel governs the one
 * run it was set on and outranks the standing default from Settings, which in
 * turn outranks the definition's hardlock and the parent's inherited
 * selection. A pin whose provider instance is no longer enabled is ignored, and
 * `fallbackDetail` explains the demotion so callers can surface an activity
 * instead of silently running the wrong model.
 */
export function resolveWorkflowStepModelSelection(input: {
  readonly workflowPromptId: string;
  /**
   * The workflow step this spawn belongs to, when the spawn is a sub-step
   * rather than the step itself — a per-ticket Code Review runs under "Execute
   * ticket waves". Leave unset when the spawn *is* the step.
   */
  readonly stepWorkflowPromptId?: string | undefined;
  readonly definition: WorkflowSubagentSpawnDefinition | undefined;
  readonly stepModels: ReadonlyArray<WorkflowStepModelOverride> | undefined;
  readonly parentModelSelection: ModelSelection;
  readonly settings: ServerSettings | undefined;
}): {
  readonly modelSelection: ModelSelection;
  readonly overrideApplied: boolean;
  readonly fallbackDetail: string | null;
} {
  const step = input.stepWorkflowPromptId;
  const pin =
    findWorkflowStepPin(input.stepModels ?? [], input.workflowPromptId, step) ??
    findWorkflowStepPin(input.settings?.workflowStepModels ?? [], input.workflowPromptId, step);
  if (pin === undefined) {
    return resolveWorkflowSubagentModelSelection({
      definition: input.definition,
      parentModelSelection: input.parentModelSelection,
      settings: input.settings,
    });
  }

  const inherited = resolveWorkflowSubagentModelSelection({
    definition: input.definition,
    parentModelSelection: input.parentModelSelection,
    settings: input.settings,
  });
  if (input.settings === undefined) {
    return {
      modelSelection: inherited.modelSelection,
      overrideApplied: false,
      fallbackDetail: `Server settings could not be read; ignoring the pinned model '${pin.modelSelection.model}' for step '${input.workflowPromptId}'.`,
    };
  }
  if (!isProviderInstanceEnabled(input.settings, pin.modelSelection.instanceId)) {
    return {
      modelSelection: inherited.modelSelection,
      overrideApplied: false,
      fallbackDetail: `The provider instance pinned for step '${input.workflowPromptId}' is no longer enabled; ignoring the pinned model '${pin.modelSelection.model}'.`,
    };
  }
  return {
    modelSelection: pin.modelSelection,
    overrideApplied: true,
    fallbackDetail: null,
  };
}

/**
 * The step pin a re-run of `target` would write.
 *
 * Re-running a stage with a different model sets the same pin the Workflows
 * panel writes, so the choice survives the re-run and governs every later agent
 * of that stage. Integration merges branches without an agent, so it has no
 * pin and returns null.
 */
export function rerunTargetStepPin(target: OrchestrationImplementationRerunTarget): {
  readonly workflowPromptId: string;
  readonly stepWorkflowPromptId?: string;
} | null {
  if (target.kind === "ticket") {
    // Per-ticket reviews are sub-steps of the wave that starts them.
    switch (target.stage) {
      case "implementation":
        return { workflowPromptId: WORKFLOW_PROMPT_IDS.implementationTddCodex };
      case "app-review":
        return {
          workflowPromptId: WORKFLOW_PROMPT_IDS.implementationBrowserAppReviewCodex,
          stepWorkflowPromptId: WORKFLOW_PROMPT_IDS.implementationTddCodex,
        };
      case "code-review":
        return {
          workflowPromptId: WORKFLOW_PROMPT_IDS.implementationCodeReviewCodex,
          stepWorkflowPromptId: WORKFLOW_PROMPT_IDS.implementationTddCodex,
        };
    }
  }
  switch (target.stage) {
    case "integration":
      return null;
    case "merge-gate":
      return { workflowPromptId: WORKFLOW_PROMPT_IDS.implementationMergeGateCodex };
    case "app-review":
      return { workflowPromptId: WORKFLOW_PROMPT_IDS.implementationBrowserAppReviewCodex };
    case "code-review":
      return { workflowPromptId: WORKFLOW_PROMPT_IDS.implementationCodeReviewCodex };
  }
}

/**
 * The step pin one App Review phase reads.
 *
 * All three agents run under the App Review step, so they resolve as its
 * sub-steps and carry it as `stepWorkflowPromptId`. Matches the sub-step ids
 * the Workflows panel already writes pins against.
 */
export function appReviewPhaseStepPin(phase: AppReviewWorkflowPhase): {
  readonly workflowPromptId: string;
  readonly stepWorkflowPromptId?: string;
} {
  switch (phase) {
    case "review":
      return { workflowPromptId: WORKFLOW_PROMPT_IDS.implementationBrowserAppReviewCodex };
    case "planning":
      return {
        workflowPromptId: "matt-pocock.to-tickets",
        stepWorkflowPromptId: WORKFLOW_PROMPT_IDS.implementationBrowserAppReviewCodex,
      };
    case "fixing":
      return {
        workflowPromptId: "matt-pocock.implement",
        stepWorkflowPromptId: WORKFLOW_PROMPT_IDS.implementationBrowserAppReviewCodex,
      };
  }
}
