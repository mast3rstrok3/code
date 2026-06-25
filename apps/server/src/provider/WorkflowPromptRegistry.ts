import type { ProviderInteractionMode, WorkflowPromptContract } from "@t3tools/contracts";
import { isPlanningWorkflowInteractionMode } from "@t3tools/contracts";

export const WORKFLOW_PROMPT_IDS = {
  workflowAgentCommunications: "workflow.agent-communications",
  planningGrillStageCodex: "planning.grill-stage.codex",
  planningPrdCodex: "planning.prd.codex",
  planningIssuesCodex: "planning.issues.codex",
  planningIssueReviewerCodex: "planning.issue-reviewer.codex",
  implementationOrchestratorPlanningCodex: "implementation.orchestrator-planning.codex",
  implementationTddCodex: "implementation.tdd.codex",
  implementationMergeGateCodex: "implementation.merge-gate.codex",
  implementationBrowserDevReviewCodex: "implementation.browser-dev-review.codex",
  yoloGrillStageCodex: "yolo.grill-stage.codex",
} as const;

const WORKFLOW_AGENT_COMMUNICATIONS_PROMPT = `## Agent-Only Thread Messaging

When this workflow needs to communicate with another workflow thread, keep the message concise and structured. Report blockers explicitly, name the target workflow stage, and include the next actionable step.`;

const PLANNING_GRILL_PROMPT = `<collaboration_mode># Planning Workflow: Grill

Challenge the request against the repository's actual language, architecture, and constraints before writing a plan. Explore first, ask one high-value question at a time when intent cannot be inferred, and update or propose durable planning context as decisions become clear.

Finish only when the intent, scope, risks, terminology, and acceptance criteria are decision-complete enough to create a PRD.
</collaboration_mode>`;

const PLANNING_PRD_PROMPT = `<collaboration_mode># Planning Workflow: PRD

Turn the agreed planning context into a durable PRD. Include goals, non-goals, user workflows, constraints, interfaces, data flow, failure modes, rollout notes, and acceptance criteria. Keep implementation decisions explicit enough that issue decomposition can proceed without new product questions.
</collaboration_mode>`;

const PLANNING_ISSUES_PROMPT = `<collaboration_mode># Planning Workflow: Issues

Decompose the PRD into implementation-ready planning issues. Each issue must have a narrow outcome, dependencies, touched surfaces, expected tests, and clear completion criteria. Prefer tracer-bullet ordering that validates contracts early.
</collaboration_mode>`;

const PLANNING_REVIEW_PROMPT = `<collaboration_mode># Planning Workflow: Issue Review

Review planning issues for dependency correctness, missing contracts, vague acceptance criteria, hidden migrations, and test gaps. Return concrete corrections rather than general approval.
</collaboration_mode>`;

const IMPLEMENTATION_ORCHESTRATOR_PROMPT = `<collaboration_mode># Implementation Workflow: Orchestrator Start

Plan the implementation run from the PRD and planning issues. Identify worktree strategy, issue order, validation commands, required app-dev/browser review surfaces, merge gates, and how progress will be reported.
</collaboration_mode>`;

const IMPLEMENTATION_TDD_PROMPT = `<collaboration_mode># Implementation Workflow: TDD Implementation

Implement one planning issue at a time with a red-green-refactor loop. Keep changes scoped, preserve existing behavior unless the issue requires changing it, and run the narrowest useful verification before widening to project checks.
</collaboration_mode>`;

const IMPLEMENTATION_MERGE_GATE_PROMPT = `<collaboration_mode># Implementation Workflow: Merge Gate

Merge completed implementation work, resolve conflicts deliberately, run required validation, and fix failures until checks pass or the blocker is concrete and reproducible.
</collaboration_mode>`;

const IMPLEMENTATION_BROWSER_DEV_REVIEW_PROMPT = `<collaboration_mode># Implementation Workflow: Browser Dev Review

Exercise the app-dev stack from the implementation worktree. Verify the relevant UI flows in-browser, capture concrete failures with reproduction steps, and create Dev Review findings before marking the implementation complete.
</collaboration_mode>`;

const YOLO_GRILL_PROMPT = `<collaboration_mode># YOLO Workflow: Intent Grill

Align with the user on outcome and intent only. This is the single human gate. After that, make the remaining planning and implementation decisions autonomously from the repository, existing docs, and established patterns.

Finish by restating the confirmed intent and planned outcome, then proceed as if the Planning Workflow and Implementation Workflow can run without further confirmation.
</collaboration_mode>`;

export const WORKFLOW_PROMPT_REGISTRY = [
  {
    id: WORKFLOW_PROMPT_IDS.workflowAgentCommunications,
    order: 1,
    workflow: "shared",
    role: "workflow-communications",
    stage: "agent-communications",
    title: "Agent Communications",
    description:
      "Shared workflow instructions for workflow thread messaging, blockers, and stage handoffs.",
    promptText: WORKFLOW_AGENT_COMMUNICATIONS_PROMPT,
  },
  {
    id: WORKFLOW_PROMPT_IDS.planningGrillStageCodex,
    order: 1,
    workflow: "planning",
    role: "planning-thread",
    stage: "grill",
    title: "1. Grill",
    description: "Challenges the plan against repo language and constraints before PRD authoring.",
    promptText: PLANNING_GRILL_PROMPT,
    associatedDocs: [
      {
        id: "planning.grill-stage.context-format",
        title: "CONTEXT.md Format",
        path: "CONTEXT-FORMAT.md",
        content:
          "Capture durable domain language, key constraints, open questions, and decisions that future workflow stages must preserve.",
      },
      {
        id: "planning.grill-stage.adr-format",
        title: "ADR Format",
        path: "ADR-FORMAT.md",
        content:
          "Record meaningful architectural decisions with context, decision, consequences, alternatives considered, and validation notes.",
      },
    ],
  },
  {
    id: WORKFLOW_PROMPT_IDS.planningPrdCodex,
    order: 2,
    workflow: "planning",
    role: "planning-thread",
    stage: "prd",
    title: "2. PRD",
    description: "Creates the durable PRD artifact from planning context and locked decisions.",
    promptText: PLANNING_PRD_PROMPT,
  },
  {
    id: WORKFLOW_PROMPT_IDS.planningIssuesCodex,
    order: 3,
    workflow: "planning",
    role: "planning-thread",
    stage: "issues",
    title: "3. Issues",
    description:
      "Decomposes the PRD into implementation-ready planning issues with dependencies and tests.",
    promptText: PLANNING_ISSUES_PROMPT,
  },
  {
    id: WORKFLOW_PROMPT_IDS.planningIssueReviewerCodex,
    order: 4,
    workflow: "planning",
    role: "planning-reviewer",
    stage: "issue-review",
    title: "4. Issues Review",
    description:
      "Reviews planning issues for dependency correctness, readiness, and PRD alignment.",
    promptText: PLANNING_REVIEW_PROMPT,
  },
  {
    id: WORKFLOW_PROMPT_IDS.implementationOrchestratorPlanningCodex,
    order: 1,
    workflow: "implementation",
    role: "implementation-orchestrator",
    stage: "orchestrator-start",
    title: "1. Orchestrator Start",
    description: "Plans a durable implementation orchestration run from a PRD.",
    promptText: IMPLEMENTATION_ORCHESTRATOR_PROMPT,
  },
  {
    id: WORKFLOW_PROMPT_IDS.implementationTddCodex,
    order: 2,
    workflow: "implementation",
    role: "implementation-worker",
    stage: "tdd",
    title: "2. TDD Implementation",
    description:
      "Implements planning issues with a red-green-refactor loop and focused validation.",
    promptText: IMPLEMENTATION_TDD_PROMPT,
    associatedDocs: [
      {
        id: "implementation.tdd.deep-modules",
        title: "Deep Modules",
        path: "deep-modules.md",
        content: "Prefer small public surfaces and explicit ownership boundaries.",
      },
      {
        id: "implementation.tdd.interface-design",
        title: "Interface Design for Testability",
        path: "interface-design.md",
        content: "Design interfaces around observable behavior and narrow dependencies.",
      },
      {
        id: "implementation.tdd.mocking",
        title: "When to Mock",
        path: "mocking.md",
        content: "Mock external boundaries, not the behavior under test.",
      },
      {
        id: "implementation.tdd.logging",
        title: "Logging for TDD",
        path: "logging.md",
        content: "Use logs to explain state transitions, retries, and failure causes.",
      },
      {
        id: "implementation.tdd.refactoring",
        title: "Refactor Candidates",
        path: "refactoring.md",
        content: "Refactor only when it reduces real duplication, risk, or complexity.",
      },
      {
        id: "implementation.tdd.tests",
        title: "Good and Bad Tests",
        path: "tests.md",
        content: "Prefer behavior-focused tests that fail for user-visible regressions.",
      },
    ],
  },
  {
    id: WORKFLOW_PROMPT_IDS.implementationMergeGateCodex,
    order: 3,
    workflow: "implementation",
    role: "implementation-validator",
    stage: "merge-gate",
    title: "3. Merge Gate",
    description: "Merges implementation work and fixes validation failures until green.",
    promptText: IMPLEMENTATION_MERGE_GATE_PROMPT,
  },
  {
    id: WORKFLOW_PROMPT_IDS.implementationBrowserDevReviewCodex,
    order: 4,
    workflow: "implementation",
    role: "implementation-qa-reviewer",
    stage: "browser-dev-review",
    title: "4. Browser Dev Review",
    description: "Tests the app-dev stack and creates concrete Dev Review findings.",
    promptText: IMPLEMENTATION_BROWSER_DEV_REVIEW_PROMPT,
  },
  {
    id: WORKFLOW_PROMPT_IDS.yoloGrillStageCodex,
    order: 1,
    workflow: "yolo",
    role: "planning-thread",
    stage: "grill",
    title: "1. Intent Grill",
    description:
      "Aligns with the user on intent and outcome before autonomous planning and implementation.",
    promptText: YOLO_GRILL_PROMPT,
  },
] as const satisfies ReadonlyArray<WorkflowPromptContract>;

function cloneWorkflowPromptContract(contract: WorkflowPromptContract): WorkflowPromptContract {
  return {
    ...contract,
    associatedDocs: contract.associatedDocs?.map((doc) => ({ ...doc })),
  };
}

export function listWorkflowPromptContracts(): WorkflowPromptContract[] {
  return WORKFLOW_PROMPT_REGISTRY.map(cloneWorkflowPromptContract);
}

export function resolveWorkflowPromptContract(id: string): WorkflowPromptContract {
  const contract = WORKFLOW_PROMPT_REGISTRY.find((entry) => entry.id === id);
  if (contract === undefined) {
    throw new Error(`Unknown workflow prompt contract '${id}'`);
  }
  return cloneWorkflowPromptContract(contract);
}

function renderAssociatedDoc(doc: NonNullable<WorkflowPromptContract["associatedDocs"]>[number]) {
  return `<associated-doc id="${doc.id}" path="${doc.path}" title="${doc.title}">
${doc.content}
</associated-doc>`;
}

export function resolveWorkflowPromptText(id: string): string {
  const contract = resolveWorkflowPromptContract(id);
  if (contract.associatedDocs === undefined || contract.associatedDocs.length === 0) {
    return contract.promptText;
  }

  const docs = contract.associatedDocs.map(renderAssociatedDoc).join("\n\n");
  return `${contract.promptText}\n\n${docs}`;
}

export function resolveWorkflowPromptId(input: {
  readonly interactionMode?: ProviderInteractionMode | undefined;
  readonly workflowPromptId?: string | undefined;
}): string | undefined {
  if (input.workflowPromptId !== undefined) {
    return input.workflowPromptId;
  }
  switch (input.interactionMode) {
    case "planning-workflow":
      return WORKFLOW_PROMPT_IDS.planningGrillStageCodex;
    case "yolo-workflow":
      return WORKFLOW_PROMPT_IDS.yoloGrillStageCodex;
    case "implementation-workflow":
      return WORKFLOW_PROMPT_IDS.implementationOrchestratorPlanningCodex;
    default:
      return undefined;
  }
}

export function resolveWorkflowSystemInstructions(input: {
  readonly interactionMode?: ProviderInteractionMode | undefined;
  readonly workflowPromptId?: string | undefined;
}): string | undefined {
  const workflowPromptId = resolveWorkflowPromptId(input);
  if (workflowPromptId === undefined) {
    return undefined;
  }

  if (workflowPromptId === WORKFLOW_PROMPT_IDS.workflowAgentCommunications) {
    return resolveWorkflowPromptText(workflowPromptId);
  }

  return `${resolveWorkflowPromptText(
    WORKFLOW_PROMPT_IDS.workflowAgentCommunications,
  )}\n\n${resolveWorkflowPromptText(workflowPromptId)}`;
}

export function isWorkflowInteractionMode(
  mode: ProviderInteractionMode | null | undefined,
): boolean {
  return isPlanningWorkflowInteractionMode(mode) || mode === "implementation-workflow";
}
