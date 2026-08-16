import {
  type ModelSelection,
  type OrchestrationThreadWorkflowRole,
  type ProviderInteractionMode,
  type ProviderOptionSelection,
  ProviderDriverKind,
  type ServerSettings,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";

import { WORKFLOW_PROMPT_IDS } from "../provider/WorkflowPromptRegistry.ts";
import { findEnabledProviderInstanceIdForDriver } from "../serverSettings.ts";

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
   * Hardlock this sub-agent to a specific driver/model regardless of the
   * parent thread's selection. Applied at spawn time by
   * `resolveWorkflowSubagentModelSelection`; when no enabled instance of the
   * driver exists the spawn falls back to the parent's selection.
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
    disallowedParentWorkflowRoles: ["implementation-qa-reviewer", "app-review-reviewer"],
    modelOverride: {
      driver: ProviderDriverKind.make("codex"),
      model: "gpt-5.6-sol",
      options: [{ id: "reasoningEffort", value: "high" }],
    },
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
