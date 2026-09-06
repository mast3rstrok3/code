// @effect-diagnostics nodeBuiltinImport:off - The static catalog loads bundled Markdown synchronously at module initialization.
import type {
  ProviderInteractionMode,
  WorkflowCatalog,
  WorkflowDocContract,
  WorkflowPromptContract,
  WorkflowSkillContract,
} from "@t3tools/contracts";
import { isPlanningWorkflowInteractionMode } from "@t3tools/contracts";
import { appendWorkflowSkillInstructions } from "@t3tools/shared/serverSettings";
import { WORKFLOW_PRESET_DEFINITIONS } from "@t3tools/shared/workflowPresets";

import * as NodeFS from "node:fs";
import * as Schema from "effect/Schema";
import { WorkflowPromptContracts } from "@t3tools/contracts";
import skillFiles from "./workflow-skills/catalog.json" with { type: "json" };

export const WORKFLOW_PROMPT_IDS = {
  workflowAgentCommunications: "workflow.agent-communications",
  sharedGrillingCodex: "shared.grilling.codex",
  planningGrillStageCodex: "planning.grill-stage.codex",
  planningAutomaticEngineeringGrillCodex: "planning.engineering-grill-automatic.codex",
  planningProductContextCodex: "planning.product-context.codex",
  planningSpecCodex: "planning.spec.codex",
  planningTicketsCodex: "planning.tickets.codex",
  planningTicketReviewerCodex: "planning.ticket-reviewer.codex",
  implementationOrchestratorPlanningCodex: "implementation.orchestrator-planning.codex",
  implementationTddCodex: "implementation.tdd.codex",
  implementationMergeGateCodex: "implementation.merge-gate.codex",
  implementationE2eAppReviewCodex: "implementation.e2e-app-review.codex",
  implementationBrowserAppReviewCodex: "implementation.browser-app-review.codex",
  implementationFixCodex: "implementation.fix.codex",
  implementationCodeReviewCodex: "implementation.code-review.codex",
  implementationChangeRequestBabysitterCodex: "implementation.change-request-babysitter.codex",
  productFixCodex: "product.fix.codex",
  productFastFeatureCodex: "product.fast-feature.codex",
  productFullFeatureCodex: "product.full-feature.codex",
  productPlanningCodex: "product.planning.codex",
  planningDomainModelingCodex: "planning.domain-modeling.codex",
  planningPrototypeCodex: "planning.prototype.codex",
  planningWayfinderCodex: "planning.wayfinder.codex",
  planningResearchCodex: "planning.research.codex",
  planningFastFeatureCodex: "planning.fast-feature.codex",
} as const;

const CATALOG_SKILL_ID_BY_PROMPT_ID: Readonly<Record<string, string>> = {
  [WORKFLOW_PROMPT_IDS.planningGrillStageCodex]: "matt-pocock.grill-with-docs",
  [WORKFLOW_PROMPT_IDS.planningAutomaticEngineeringGrillCodex]: "matt-pocock.grill-with-docs",
  [WORKFLOW_PROMPT_IDS.planningProductContextCodex]: "matt-pocock.domain-modeling",
  [WORKFLOW_PROMPT_IDS.planningDomainModelingCodex]: "matt-pocock.domain-modeling",
  [WORKFLOW_PROMPT_IDS.planningPrototypeCodex]: "matt-pocock.prototype",
  [WORKFLOW_PROMPT_IDS.planningWayfinderCodex]: "matt-pocock.wayfinder",
  [WORKFLOW_PROMPT_IDS.planningResearchCodex]: "matt-pocock.research",
  [WORKFLOW_PROMPT_IDS.planningSpecCodex]: "matt-pocock.to-spec",
  [WORKFLOW_PROMPT_IDS.planningTicketsCodex]: "matt-pocock.to-tickets",
  [WORKFLOW_PROMPT_IDS.implementationOrchestratorPlanningCodex]: "matt-pocock.implement",
  [WORKFLOW_PROMPT_IDS.implementationTddCodex]: "matt-pocock.tdd",
  [WORKFLOW_PROMPT_IDS.implementationCodeReviewCodex]: "matt-pocock.code-review",
};

function readSkillFile(file: string): string {
  return NodeFS.readFileSync(new URL(`./workflow-skills/${file}`, import.meta.url), "utf8").trim();
}

export const WORKFLOW_REQUEST_USER_INPUT_CODE_MODE_FORWARDING =
  "When Code Mode calls workflow_request_user_input, keep its returned answers visible to the model by passing the complete result to the outer text(result) helper, for example: const result = await tools.workflow_request_user_input(...); text(result). Dynamic tool results use contentItems, not result.content; never discard or selectively read the returned value.";

export const WORKFLOW_PROMPT_REGISTRY = Schema.decodeUnknownSync(WorkflowPromptContracts)(
  skillFiles.map(({ file, workflowInstructionsFile, associatedDocs, ...contract }) => ({
    ...contract,
    promptText: [
      readSkillFile(file),
      ...(workflowInstructionsFile ? [readSkillFile(workflowInstructionsFile)] : []),
    ].join("\n\n"),
    ...(associatedDocs
      ? {
          associatedDocs: associatedDocs.map(({ file, ...doc }) => ({
            ...doc,
            content: readSkillFile(file),
          })),
        }
      : {}),
  })),
);

function cloneWorkflowPromptContract(contract: WorkflowPromptContract): WorkflowPromptContract {
  return {
    ...contract,
    associatedDocs: contract.associatedDocs?.map((doc) => ({ ...doc })),
  };
}

export function listWorkflowPromptContracts(): WorkflowPromptContract[] {
  return WORKFLOW_PROMPT_REGISTRY.map(cloneWorkflowPromptContract);
}

const VISIBLE_T3_SKILL_IDS = new Set<string>([
  WORKFLOW_PROMPT_IDS.implementationE2eAppReviewCodex,
  WORKFLOW_PROMPT_IDS.planningFastFeatureCodex,
  WORKFLOW_PROMPT_IDS.productFullFeatureCodex,
  WORKFLOW_PROMPT_IDS.productPlanningCodex,
  WORKFLOW_PROMPT_IDS.planningTicketReviewerCodex,
  WORKFLOW_PROMPT_IDS.implementationMergeGateCodex,
  WORKFLOW_PROMPT_IDS.implementationBrowserAppReviewCodex,
  WORKFLOW_PROMPT_IDS.implementationFixCodex,
  WORKFLOW_PROMPT_IDS.implementationChangeRequestBabysitterCodex,
]);

const ENGINEERING_SKILL_IDS = new Set(
  skillFiles.filter((skill) => skill.id.startsWith("matt-pocock.")).map((skill) => skill.id),
);

function catalogSkillIdForPromptId(promptId: string): string {
  return CATALOG_SKILL_ID_BY_PROMPT_ID[promptId] ?? promptId;
}

function summarizeWorkflowDoc(content: string): string {
  const paragraph = content
    .replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "")
    .replace(/```[\s\S]*?```/g, "")
    .split(/\r?\n\s*\r?\n/)
    .filter(
      (candidate) => !candidate.trim().startsWith("```") && !candidate.trim().startsWith("#!"),
    )
    .map((candidate) =>
      candidate
        .replace(/^#+\s+.*$/gm, "")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .find((candidate) => candidate.length >= 20);
  if (paragraph === undefined) {
    return "Supporting instructions loaded by this skill when needed.";
  }
  return paragraph.length > 240 ? `${paragraph.slice(0, 237).trimEnd()}…` : paragraph;
}

function buildWorkflowCatalog(): WorkflowCatalog {
  const promptContracts: ReadonlyArray<WorkflowPromptContract> = WORKFLOW_PROMPT_REGISTRY;
  const promptContractById = new Map(promptContracts.map((contract) => [contract.id, contract]));
  const workflowOrder = [
    "quick-plan",
    "fast-plan",
    "fast-engineering",
    "planning",
    "wayfinder",
    "fast-feature",
    "app-review",
    "full-feature",
    "product-planning",
    "implementation",
  ];
  const workflows = WORKFLOW_PRESET_DEFINITIONS.toSorted(
    (left, right) => workflowOrder.indexOf(left.id) - workflowOrder.indexOf(right.id),
  ).map((definition, workflowIndex) => ({
    id: definition.id,
    order: workflowIndex + 1,
    title: definition.label,
    description: definition.description,
    interactionMode: definition.interactionMode,
    steps: definition.helpSteps.map((step) => {
      const skillId = step.skillId ? catalogSkillIdForPromptId(step.skillId) : undefined;
      const skillTitle = skillId
        ? promptContractById.get(skillId)?.title.replace(/^\d+\.\s+/, "")
        : undefined;
      const stepContext = skillTitle && skillTitle !== step.label ? step.label : undefined;
      return {
        label: skillTitle ?? step.label,
        ...(skillId ? { skillId } : {}),
        ...(step.skillId ? { workflowPromptId: step.skillId } : {}),
        ...(step.threadBoundary ? { threadBoundary: step.threadBoundary } : {}),
        ...(stepContext || step.note
          ? { note: [stepContext, step.note].filter(Boolean).join(" · ") }
          : {}),
      };
    }),
  }));

  const workflowIdsBySkill = new Map<string, string[]>();
  for (const workflow of workflows) {
    for (const step of workflow.steps) {
      if (step.skillId === undefined) continue;
      const ids = workflowIdsBySkill.get(step.skillId) ?? [];
      if (!ids.includes(workflow.id)) ids.push(workflow.id);
      workflowIdsBySkill.set(step.skillId, ids);
    }
  }
  const implicitWorkflowIdsBySkill: Readonly<Record<string, readonly string[]>> = {
    "matt-pocock.grill-with-docs": ["fast-engineering", "planning"],
    "matt-pocock.domain-modeling": [
      "full-feature",
      "product-planning",
      "wayfinder",
      "fast-engineering",
      "planning",
    ],
    "matt-pocock.implement": [
      "quick-plan",
      "fast-plan",
      "fast-engineering",
      "planning",
      "wayfinder",
      "full-feature",
      "implementation",
      "app-review",
    ],
    "matt-pocock.to-tickets": [
      "quick-plan",
      "fast-plan",
      "fast-engineering",
      "planning",
      "wayfinder",
      "app-review",
    ],
    [WORKFLOW_PROMPT_IDS.implementationFixCodex]: [
      "quick-plan",
      "fast-plan",
      "fast-engineering",
      "planning",
      "wayfinder",
      "fast-feature",
      "full-feature",
      "implementation",
    ],
  };
  for (const [skillId, workflowIds] of Object.entries(implicitWorkflowIdsBySkill)) {
    const ids = workflowIdsBySkill.get(skillId) ?? [];
    for (const workflowId of workflowIds) {
      if (!ids.includes(workflowId)) ids.push(workflowId);
    }
    workflowIdsBySkill.set(skillId, ids);
  }
  // A skill's workflow pills link into this catalog, so an id it does not
  // contain has nothing to open. The implicit map above still names retired
  // presets such as Full Feature, which historical runs render from but the
  // catalog no longer exposes. Ordering follows the catalog rather than the
  // order the ids happened to be discovered in.
  const catalogWorkflowOrder = new Map<string, number>(
    workflows.map((workflow, index) => [workflow.id, index]),
  );
  for (const [skillId, ids] of workflowIdsBySkill) {
    workflowIdsBySkill.set(
      skillId,
      ids
        .filter((workflowId) => catalogWorkflowOrder.has(workflowId))
        .toSorted(
          (left, right) => catalogWorkflowOrder.get(left)! - catalogWorkflowOrder.get(right)!,
        ),
    );
  }

  const promptIdsBySkill = new Map<string, string[]>();
  for (const contract of promptContracts) {
    const skillId = catalogSkillIdForPromptId(contract.id);
    const promptIds = promptIdsBySkill.get(skillId) ?? [];
    promptIds.push(contract.id);
    promptIdsBySkill.set(skillId, promptIds);
  }

  type MutableCatalogSkill = Omit<WorkflowSkillContract, "docIds"> & { docIds: string[] };
  const skills: MutableCatalogSkill[] = promptContracts
    .filter(
      (contract) => ENGINEERING_SKILL_IDS.has(contract.id) || VISIBLE_T3_SKILL_IDS.has(contract.id),
    )
    .map((contract) => ({
      id: contract.id,
      order: contract.order,
      workflow: contract.workflow,
      role: contract.role,
      stage: contract.stage,
      title: contract.title.replace(/^\d+\.\s+/, ""),
      description: contract.description,
      promptText: contract.promptText,
      workflowAnnotations: promptContracts
        .filter(
          (candidate) =>
            candidate.id !== contract.id && catalogSkillIdForPromptId(candidate.id) === contract.id,
        )
        .map((candidate) => ({
          workflowPromptId: candidate.id,
          title: candidate.title,
          text: candidate.promptText,
        })),
      promptIds: promptIdsBySkill.get(contract.id) ?? [contract.id],
      docIds: [],
      buildModes: ENGINEERING_SKILL_IDS.has(contract.id) ? (["build"] as const) : [],
      workflowIds: workflowIdsBySkill.get(contract.id) ?? [],
    }))
    .toSorted(
      (left, right) => left.title.localeCompare(right.title) || left.id.localeCompare(right.id),
    )
    .map((skill, index) => ({ ...skill, order: index + 1 }));

  const docsById = new Map<
    string,
    Omit<WorkflowDocContract, "skillIds"> & { skillIds: string[] }
  >();
  const skillsById = new Map(skills.map((skill) => [skill.id, skill]));
  for (const contract of promptContracts) {
    const catalogSkillId = catalogSkillIdForPromptId(contract.id);
    const skill = skillsById.get(catalogSkillId);
    if (skill === undefined) continue;
    for (const doc of contract.associatedDocs ?? []) {
      const existing = docsById.get(doc.id);
      if (existing !== undefined) {
        if (
          existing.title !== doc.title ||
          existing.path !== doc.path ||
          existing.content !== doc.content
        ) {
          throw new Error(`Conflicting workflow doc '${doc.id}'`);
        }
        if (!existing.skillIds.includes(skill.id)) existing.skillIds.push(skill.id);
      } else {
        docsById.set(doc.id, {
          ...doc,
          description: summarizeWorkflowDoc(doc.content),
          skillIds: [skill.id],
        });
      }
      if (!skill.docIds.includes(doc.id)) skill.docIds.push(doc.id);
    }
  }

  const skillIds = new Set(skills.map((skill) => skill.id));
  for (const workflow of workflows) {
    for (const step of workflow.steps) {
      if (step.skillId !== undefined && !skillIds.has(step.skillId)) {
        throw new Error(`Unknown workflow skill '${step.skillId}' in '${workflow.id}'`);
      }
    }
  }

  const docs = [...docsById.values()].map((doc, _index, allDocs) => {
    const duplicatesAnUpstreamDocForSkill =
      !doc.id.startsWith("matt-pocock.") &&
      doc.skillIds.some((skillId) =>
        allDocs.some(
          (candidate) =>
            candidate.id.startsWith("matt-pocock.") &&
            candidate.title === doc.title &&
            candidate.skillIds.includes(skillId),
        ),
      );
    return duplicatesAnUpstreamDocForSkill ? { ...doc, title: `${doc.title} (T3 workflow)` } : doc;
  });

  return {
    workflows,
    skills,
    docs: docs.toSorted(
      (left, right) => left.title.localeCompare(right.title) || left.id.localeCompare(right.id),
    ),
  };
}

const WORKFLOW_CATALOG = buildWorkflowCatalog();

export function listWorkflowCatalog(): WorkflowCatalog {
  return structuredClone(WORKFLOW_CATALOG);
}

export function resolveWorkflowDoc(docId: string): WorkflowDocContract | undefined {
  const doc = WORKFLOW_CATALOG.docs.find((candidate) => candidate.id === docId);
  return doc === undefined ? undefined : structuredClone(doc);
}

export function resolveWorkflowPromptContract(id: string): WorkflowPromptContract {
  const contract = WORKFLOW_PROMPT_REGISTRY.find((entry) => entry.id === id);
  if (contract === undefined) {
    throw new Error(`Unknown workflow prompt contract '${id}'`);
  }
  return cloneWorkflowPromptContract(contract);
}

export function isRegisteredWorkflowPromptId(id: string): boolean {
  return WORKFLOW_PROMPT_REGISTRY.some((entry) => entry.id === id);
}

export function isBrowserAppReviewWorkflowPromptId(
  workflowPromptId: string | null | undefined,
): boolean {
  return (
    workflowPromptId !== null &&
    workflowPromptId !== undefined &&
    workflowPromptId === WORKFLOW_PROMPT_IDS.implementationBrowserAppReviewCodex
  );
}

export function isE2eAppReviewWorkflowPromptId(
  workflowPromptId: string | null | undefined,
): boolean {
  return workflowPromptId === WORKFLOW_PROMPT_IDS.implementationE2eAppReviewCodex;
}

export function isInteractiveStructuredInputWorkflowPromptId(
  workflowPromptId: string | null | undefined,
): boolean {
  return (
    workflowPromptId === WORKFLOW_PROMPT_IDS.planningGrillStageCodex ||
    workflowPromptId === WORKFLOW_PROMPT_IDS.productFixCodex ||
    workflowPromptId === WORKFLOW_PROMPT_IDS.productFastFeatureCodex ||
    workflowPromptId === WORKFLOW_PROMPT_IDS.productPlanningCodex ||
    workflowPromptId === WORKFLOW_PROMPT_IDS.productFullFeatureCodex
  );
}

export function isInteractiveStructuredInputWorkflow(input: {
  readonly interactionMode?: ProviderInteractionMode | undefined;
  readonly workflowPromptId?: string | undefined;
}): boolean {
  if (input.interactionMode === "planning-workflow") {
    return input.workflowPromptId === WORKFLOW_PROMPT_IDS.planningGrillStageCodex;
  }
  if (input.interactionMode !== "product-workflow") {
    return false;
  }
  return isInteractiveStructuredInputWorkflowPromptId(input.workflowPromptId);
}

export function isPreviewMcpWorkflowPromptId(workflowPromptId: string | null | undefined): boolean {
  return isBrowserAppReviewWorkflowPromptId(workflowPromptId);
}

export function isAppReviewMcpWorkflowPromptId(
  workflowPromptId: string | null | undefined,
): boolean {
  return (
    isE2eAppReviewWorkflowPromptId(workflowPromptId) ||
    isBrowserAppReviewWorkflowPromptId(workflowPromptId)
  );
}

function renderAssociatedDocReference(
  doc: NonNullable<WorkflowPromptContract["associatedDocs"]>[number],
) {
  return `<doc id="${doc.id}" path="${doc.path}" title="${doc.title}" />`;
}

/** Apply saved skill instructions and any additional instructions for this exact step. */
export function appendWorkflowStepInstructions(
  text: string,
  workflowPromptId: string | undefined,
  instructions: Readonly<Record<string, string>>,
): string {
  if (!workflowPromptId || !isRegisteredWorkflowPromptId(workflowPromptId)) return text;
  return appendWorkflowSkillInstructions(
    text,
    catalogSkillIdForPromptId(workflowPromptId),
    workflowPromptId,
    instructions,
  );
}

export function resolveWorkflowSkillInstructions(id: string): string {
  return resolveWorkflowPromptContract(id).promptText;
}

export function resolveWorkflowPromptText(id: string): string {
  const contract = resolveWorkflowPromptContract(id);
  const promptText = resolveWorkflowSkillInstructions(id);
  if (contract.associatedDocs === undefined || contract.associatedDocs.length === 0) {
    return promptText;
  }

  if (
    ENGINEERING_SKILL_IDS.has(contract.id) &&
    !["matt-pocock.grill-with-docs", "matt-pocock.domain-modeling"].includes(contract.id)
  ) {
    const docs = contract.associatedDocs
      .map(
        (doc) => `<skill-doc id="${doc.id}" path="${doc.path}">
${doc.content}
</skill-doc>`,
      )
      .join("\n\n");
    return `${promptText}\n\n<supporting-skill-docs>\nThe referenced supporting files are bundled below for this Build invocation.\n${docs}\n</supporting-skill-docs>`;
  }

  const docs = contract.associatedDocs.map(renderAssociatedDocReference).join("\n");
  return `${promptText}\n\n<available-workflow-docs>\nLoad a supporting document only when relevant by calling workflow_doc_get with its id.\n${docs}\n</available-workflow-docs>`;
}

/**
 * Renders the resolved workflow prompt as a delimited block for embedding into the persisted user
 * message of a workflow sub-step turn. The body is byte-identical to the text injected via the
 * system channel (`resolveWorkflowSystemInstructions`), so a stale prompt is visible in the thread.
 */
export function buildWorkflowSkillCommandSection(
  workflowPromptId: string | null | undefined,
): string | null {
  if (workflowPromptId == null || !isRegisteredWorkflowPromptId(workflowPromptId)) {
    return null;
  }
  const contract = resolveWorkflowPromptContract(workflowPromptId);
  return `<workflow-skill id="${contract.id}" title="${contract.title}">
${resolveWorkflowPromptText(workflowPromptId)}
</workflow-skill>`;
}

export function appendWorkflowSkillCommandSection(
  promptText: string,
  workflowPromptId: string | null | undefined,
): string {
  const section = buildWorkflowSkillCommandSection(workflowPromptId);
  return section === null ? promptText : `${promptText}\n\n${section}`;
}

export function resolveWorkflowPromptId(input: {
  readonly interactionMode?: ProviderInteractionMode | undefined;
  readonly workflowPromptId?: string | undefined;
}): string | undefined {
  if (
    input.workflowPromptId !== undefined &&
    isRegisteredWorkflowPromptId(input.workflowPromptId)
  ) {
    return input.workflowPromptId;
  }
  switch (input.interactionMode) {
    case "planning-workflow":
      return WORKFLOW_PROMPT_IDS.planningGrillStageCodex;
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
    return undefined;
  }
  return resolveWorkflowPromptText(workflowPromptId);
}

export function isWorkflowInteractionMode(
  mode: ProviderInteractionMode | null | undefined,
): boolean {
  return isPlanningWorkflowInteractionMode(mode) || mode === "implementation-workflow";
}
