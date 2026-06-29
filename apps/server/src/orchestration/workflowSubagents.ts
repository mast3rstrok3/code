import type { OrchestrationThreadWorkflowRole, ProviderInteractionMode } from "@t3tools/contracts";

import {
  normalizeWorkflowPromptId,
  WORKFLOW_PROMPT_IDS,
} from "../provider/WorkflowPromptRegistry.ts";

export type WorkflowSubagentParentWorkflowRole = OrchestrationThreadWorkflowRole | null;

export interface WorkflowSubagentSpawnDefinition {
  readonly workflowPromptId: string;
  readonly interactionMode: ProviderInteractionMode;
  readonly workflowRole: OrchestrationThreadWorkflowRole | null;
  readonly threadIdTag: string;
  readonly defaultTitlePrefix: string;
  readonly expectedResult: string;
  readonly allowedParentWorkflowRoles: "any" | ReadonlyArray<WorkflowSubagentParentWorkflowRole>;
}

const WORKFLOW_SUBAGENT_SPAWN_DEFINITIONS: ReadonlyArray<WorkflowSubagentSpawnDefinition> = [
  {
    workflowPromptId: WORKFLOW_PROMPT_IDS.productGrillStageCodex,
    interactionMode: "product-workflow",
    workflowRole: null,
    threadIdTag: "workflow-product-grill",
    defaultTitlePrefix: "Product Grill",
    expectedResult: "product-intent-locked",
    allowedParentWorkflowRoles: "any",
  },
  {
    workflowPromptId: WORKFLOW_PROMPT_IDS.planningGrillStageCodex,
    interactionMode: "planning-workflow",
    workflowRole: "planning-orchestrator",
    threadIdTag: "workflow-planning-grill",
    defaultTitlePrefix: "Planning Grill",
    expectedResult: "planning-prd-artifact",
    allowedParentWorkflowRoles: "any",
  },
  {
    workflowPromptId: WORKFLOW_PROMPT_IDS.planningPrdCodex,
    interactionMode: "planning-workflow",
    workflowRole: "planning-orchestrator",
    threadIdTag: "workflow-planning-prd",
    defaultTitlePrefix: "Planning PRD",
    expectedResult: "planning-prd-artifact",
    allowedParentWorkflowRoles: "any",
  },
  {
    workflowPromptId: WORKFLOW_PROMPT_IDS.planningIssuesCodex,
    interactionMode: "planning-workflow",
    workflowRole: "planning-orchestrator",
    threadIdTag: "workflow-planning-issues",
    defaultTitlePrefix: "Planning Issues",
    expectedResult: "planning-issues-artifact",
    allowedParentWorkflowRoles: "any",
  },
  {
    workflowPromptId: WORKFLOW_PROMPT_IDS.planningIssueReviewerCodex,
    interactionMode: "planning-workflow",
    workflowRole: "planning-reviewer",
    threadIdTag: "workflow-planning-reviewer",
    defaultTitlePrefix: "Planning Review",
    expectedResult: "planning-reviewer-verdict",
    allowedParentWorkflowRoles: [null, "planning-orchestrator"],
  },
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
    workflowPromptId: WORKFLOW_PROMPT_IDS.implementationBrowserDevReviewCodex,
    interactionMode: "implementation-workflow",
    workflowRole: "implementation-qa-reviewer",
    threadIdTag: "workflow-implementation-qa-reviewer",
    defaultTitlePrefix: "Browser Dev Review",
    expectedResult: "dev-review-document",
    allowedParentWorkflowRoles: [null, "implementation-orchestrator"],
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
];

const WORKFLOW_SUBAGENT_SPAWN_DEFINITION_BY_PROMPT_ID = new Map(
  WORKFLOW_SUBAGENT_SPAWN_DEFINITIONS.map((definition) => [
    normalizeWorkflowPromptId(definition.workflowPromptId),
    definition,
  ]),
);

export function resolveWorkflowSubagentSpawnDefinition(
  workflowPromptId: string,
): WorkflowSubagentSpawnDefinition | undefined {
  return WORKFLOW_SUBAGENT_SPAWN_DEFINITION_BY_PROMPT_ID.get(
    normalizeWorkflowPromptId(workflowPromptId),
  );
}

export function isWorkflowSubagentParentRoleAllowed(
  definition: WorkflowSubagentSpawnDefinition,
  workflowRole: WorkflowSubagentParentWorkflowRole,
): boolean {
  return (
    definition.allowedParentWorkflowRoles === "any" ||
    definition.allowedParentWorkflowRoles.includes(workflowRole)
  );
}
