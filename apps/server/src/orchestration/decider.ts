import {
  type AppReviewDocument,
  AppReviewWorkflowCycleBudget,
  AppReviewWorkflowRunId,
  type AppReviewWorkflowRun,
  EMPTY_APP_REVIEW_EVIDENCE,
  EventId,
  IMPLEMENTATION_RUN_MAX_QA_REPAIRS,
  IMPLEMENTATION_STAGE_MAX_LAUNCHES,
  MessageId,
  type OrchestrationImplementationRerunTarget,
  type OrchestrationImplementationRun,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationPlanningReviewCycle,
  type OrchestrationPlanningTicket,
  type OrchestrationPlanningSpec,
  type OrchestrationPlanningSpecBundle,
  type OrchestrationReadModel,
  PLANNING_REVIEW_MAX_CYCLES,
  type PlanningReviewerTicketEdit,
  ThreadId,
  WORKFLOW_AUTOMATION_RUNTIME_MODE,
  WorkflowId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import type * as PlatformError from "effect/PlatformError";
import {
  collectHierarchyPostOrder,
  orderHierarchyPostOrder,
} from "@t3tools/shared/threadHierarchy";

import { OrchestrationCommandInvariantError } from "./Errors.ts";
import {
  listThreadsByProjectId,
  requireActiveProjectWorkspaceRootAbsent,
  requireProject,
  requireProjectAbsent,
  requireThread,
  requireThreadArchived,
  requireThreadAbsent,
  requireThreadNotArchived,
  requireWorkflowNotPaused,
} from "./commandInvariants.ts";
import { WORKFLOW_PROMPT_IDS } from "../provider/WorkflowPromptRegistry.ts";
import { appReviewPhaseStepPin, rerunTargetStepPin } from "./workflowSubagents.ts";
import { validatePlanningTicketFileChanges } from "./planningTicketFiles.ts";
import {
  PLANNING_REVIEWER_TICKET_EDIT_RULES,
  planningReviewerVerdictExampleJson,
} from "./workflowDirectives.ts";
import { isWorkflowThreadPaused } from "./workflowPause.ts";
import { NUDGEABLE_WORKFLOW_ROLES } from "./workflowNudge.ts";
import {
  normalizeImplementationRerunTargetForHalt,
  queueImplementationRerun,
} from "./implementationRerun.ts";
import { workflowStageTargetKey } from "./workflowStageExecutions.ts";
import { buildPlanImplementationThreadTitle } from "@t3tools/shared/orchestrationPlanning";
import { APP_REVIEW_PARTS_TARGETS } from "@t3tools/shared/appReviewParts";
import { resolveImplementationValidationCommands } from "@t3tools/shared/t3ProjectFile";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import { stageClaimBlocksRestart, stageClaimState } from "./stageClaim.ts";
import {
  isProductWorkflowPreset,
  isProductWorkflowRoot,
  WORKFLOW_PRESET_DEFINITION_BY_ID,
  workflowPresetStepUsesRootThread,
} from "@t3tools/shared/workflowPresets";
import {
  findWorkflowStepCycleTarget,
  resolveWorkflowStepCycleBudget,
  workflowStepCycleKeysEqual,
  type WorkflowStepCycleKey,
} from "@t3tools/shared/workflowStepCycles";

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const EMPTY_APP_REVIEW_DOCUMENT: AppReviewDocument = {
  verdict: "pending",
  summary: "",
  checks: [],
  findings: [],
  questions: [],
  nextSteps: [],
};

function optionalScopeMatches(
  requested: string | null | undefined,
  actual: string | null,
): boolean {
  return requested === undefined || requested === actual;
}

function findPlanningBundleBySpecId(
  readModel: OrchestrationReadModel,
  specId: string,
):
  | (OrchestrationPlanningSpecBundle & {
      readonly sourceThread: OrchestrationReadModel["threads"][number] | null;
    })
  | null {
  for (const thread of readModel.threads) {
    const workflow = thread.planningWorkflow;
    if (workflow?.spec?.id !== specId) continue;
    return {
      spec: {
        ...workflow.spec,
        ticketCount: workflow.tickets.length,
      },
      tickets: workflow.tickets,
      reviewCycles: workflow.reviewCycles,
      sourceThread: thread,
    };
  }
  return null;
}

function validatePlanningTicketGraph(
  specId: string,
  tickets: ReadonlyArray<OrchestrationPlanningTicket>,
): string | null {
  const ticketIds = new Set(tickets.map((ticket) => ticket.id));
  const ticketKeys = new Set<string>();
  for (const ticket of tickets) {
    const ticketKey = ticket.key ?? `LEGACY-${ticket.id}`;
    if (ticketKeys.has(ticketKey)) {
      return `Planning Ticket key '${ticketKey}' is duplicated.`;
    }
    ticketKeys.add(ticketKey);
    if (ticket.specId !== specId) {
      return `Planning Ticket '${ticket.id}' belongs to Spec '${ticket.specId}', expected '${specId}'.`;
    }
    if (ticket.appReviewEligible === true && !ticket.appReviewPlanMarkdown) {
      return `Planning Ticket '${ticket.id}' is App Review eligible but has no review plan.`;
    }
    if (ticket.appReviewScope !== undefined && ticket.appReviewEligible !== true) {
      return `Planning Ticket '${ticket.id}' sets appReviewScope without being App Review eligible.`;
    }
    for (const dependency of ticket.dependencies) {
      if (dependency.specId !== specId) {
        return `Planning Ticket '${ticket.id}' has a dependency in a different Spec.`;
      }
      if (!ticketIds.has(dependency.ticketId)) {
        return `Planning Ticket '${ticket.id}' depends on unknown ticket '${dependency.ticketId}'.`;
      }
      if (dependency.ticketId === ticket.id) {
        return `Planning Ticket '${ticket.id}' cannot depend on itself.`;
      }
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(tickets.map((ticket) => [ticket.id, ticket] as const));
  const visit = (ticketId: string): boolean => {
    if (visiting.has(ticketId)) return true;
    if (visited.has(ticketId)) return false;
    visiting.add(ticketId);
    const ticket = byId.get(ticketId);
    if (ticket?.dependencies.some((dependency) => visit(dependency.ticketId))) return true;
    visiting.delete(ticketId);
    visited.add(ticketId);
    return false;
  };
  if (tickets.some((ticket) => visit(ticket.id))) {
    return "Planning Ticket dependency graph contains a cycle.";
  }
  return null;
}

function buildPlanningSpecFromArtifact(input: {
  readonly specId: string;
  readonly threadId: ThreadId;
  readonly command: Extract<OrchestrationCommand, { type: "thread.planning-spec.apply" }>;
}): OrchestrationPlanningSpec {
  return {
    id: input.specId,
    title: input.command.title,
    summaryMarkdown: input.command.summaryMarkdown,
    tenantId: input.command.tenantId ?? null,
    teamId: input.command.teamId ?? null,
    sourceThreadId: input.threadId,
    sourceMessageIds: [input.command.sourceMessageId],
    createdBy: input.command.createdBy ?? null,
    workflowId: WorkflowId.make(`workflow-${input.specId}`),
    ticketCount: 0,
    createdAt: input.command.createdAt,
    updatedAt: input.command.createdAt,
  };
}

function buildPlanningTicketsFromArtifact(input: {
  readonly specId: string;
  readonly command: Extract<OrchestrationCommand, { type: "thread.planning-tickets.apply" }>;
  readonly generatedTicketIds: ReadonlyArray<string>;
}): OrchestrationPlanningTicket[] | string {
  const idByKey = new Map<string, string>();
  for (let index = 0; index < input.command.tickets.length; index += 1) {
    const ticket = input.command.tickets[index];
    const id = input.generatedTicketIds[index];
    if (!ticket || !id) continue;
    const fileChangesError = validatePlanningTicketFileChanges(ticket.plannedFileChanges);
    if (fileChangesError !== null) {
      return `Planning Ticket '${ticket.key}' is invalid: ${fileChangesError}`;
    }
    if (idByKey.has(ticket.key)) {
      return `Planning Ticket key '${ticket.key}' is duplicated.`;
    }
    idByKey.set(ticket.key, id);
  }

  return input.command.tickets.map((ticket, index) => {
    const ticketId = idByKey.get(ticket.key) ?? input.generatedTicketIds[index] ?? ticket.key;
    const dependencies = ticket.dependencyKeys.map((dependencyKey) => {
      const dependencyTicketId = idByKey.get(dependencyKey);
      if (dependencyTicketId === undefined) {
        return {
          specId: input.specId,
          ticketId: dependencyKey,
        };
      }
      return {
        specId: input.specId,
        ticketId: dependencyTicketId,
      };
    });
    return {
      id: ticketId,
      key: ticket.key,
      specId: input.specId,
      ordinal: index + 1,
      title: ticket.title,
      bodyMarkdown: ticket.bodyMarkdown,
      plannedFileChanges: [...ticket.plannedFileChanges],
      dependencies,
      appReviewEligible: ticket.appReviewEligible ?? false,
      ...(ticket.appReviewScope === undefined ? {} : { appReviewScope: ticket.appReviewScope }),
      appReviewPlanMarkdown: ticket.appReviewPlanMarkdown ?? null,
      status: "open",
      createdAt: input.command.createdAt,
      updatedAt: input.command.createdAt,
    };
  });
}

function nextPlanningReviewRequest(
  workflow: NonNullable<OrchestrationReadModel["threads"][number]["planningWorkflow"]>,
) {
  const cycleNumber = workflow.reviewCycles.length + 1;
  const allTicketIds = workflow.tickets.map((ticket) => ticket.id);
  const previous = workflow.reviewCycles.at(-1);
  if (previous === undefined || workflow.stage !== "ticket-review") {
    return {
      cycleNumber,
      mode: "full" as const,
      targetPlanningTicketIds: allTicketIds,
      previousCycle: previous,
    };
  }
  // Only tickets the last cycle could not resolve. A ticket the reviewer corrected and passed is
  // finished: re-reviewing the reviewer's own edit is what turned one run into five cycles of the
  // same tickets being rewritten.
  const targetPlanningTicketIds = Array.from(new Set(previous.failingPlanningTicketIds)).filter(
    (ticketId) => allTicketIds.includes(ticketId),
  );
  return {
    cycleNumber,
    mode: "targeted" as const,
    targetPlanningTicketIds,
    previousCycle: previous,
  };
}

function hasSameUniqueValues(left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean {
  const leftValues = new Set(left);
  const rightValues = new Set(right);
  return (
    leftValues.size === left.length &&
    rightValues.size === right.length &&
    leftValues.size === rightValues.size &&
    Array.from(leftValues).every((value) => rightValues.has(value))
  );
}

function applyPlanningReviewerEdits(input: {
  readonly specId: string;
  readonly tickets: ReadonlyArray<OrchestrationPlanningTicket>;
  readonly edits: ReadonlyArray<PlanningReviewerTicketEdit>;
  readonly targetPlanningTicketIds: ReadonlyArray<string>;
  readonly mode: "full" | "targeted";
  readonly generatedTicketIds: ReadonlyArray<string>;
  readonly updatedAt: string;
}): OrchestrationPlanningTicket[] | string {
  const targetIds = new Set(input.targetPlanningTicketIds);
  const tickets = new Map(input.tickets.map((ticket) => [ticket.id, { ...ticket }] as const));
  const dependencyKeysByTicketId = new Map<string, ReadonlyArray<string>>();

  for (let index = 0; index < input.edits.length; index += 1) {
    const edit = input.edits[index]!;
    if (edit.type === "create") {
      const fileChangesError = validatePlanningTicketFileChanges(edit.plannedFileChanges);
      if (fileChangesError !== null) {
        return `Reviewer-created Planning Ticket '${edit.key}' is invalid: ${fileChangesError}`;
      }
      if (
        input.mode === "targeted" &&
        (edit.replacesPlanningTicketIds.length === 0 ||
          edit.replacesPlanningTicketIds.some((ticketId) => !targetIds.has(ticketId)))
      ) {
        return "Targeted reviewer-created tickets must identify only targeted tickets they replace.";
      }
      const id = input.generatedTicketIds[index];
      if (id === undefined) return "Failed to allocate a stable Planning Ticket id.";
      tickets.set(id, {
        id,
        key: edit.key,
        specId: input.specId,
        ordinal: tickets.size + 1,
        title: edit.title,
        bodyMarkdown: edit.bodyMarkdown,
        plannedFileChanges: [...edit.plannedFileChanges],
        dependencies: [],
        appReviewEligible: edit.appReviewEligible,
        ...(edit.appReviewScope === undefined ? {} : { appReviewScope: edit.appReviewScope }),
        appReviewPlanMarkdown: edit.appReviewPlanMarkdown,
        status: "open",
        createdAt: input.updatedAt,
        updatedAt: input.updatedAt,
      });
      dependencyKeysByTicketId.set(id, edit.dependencyKeys);
      continue;
    }

    const ticket = tickets.get(edit.ticketId);
    if (ticket === undefined) return `Reviewer edit targets unknown ticket '${edit.ticketId}'.`;
    if (input.mode === "targeted" && !targetIds.has(edit.ticketId)) {
      return `Targeted reviewer cannot edit unrelated ticket '${edit.ticketId}'.`;
    }
    if (edit.type === "delete") {
      tickets.delete(edit.ticketId);
      continue;
    }
    if (edit.type === "update-dependencies") {
      dependencyKeysByTicketId.set(edit.ticketId, edit.dependencyKeys);
      tickets.set(edit.ticketId, { ...ticket, updatedAt: input.updatedAt });
      continue;
    }
    if (edit.plannedFileChanges !== undefined) {
      const fileChangesError = validatePlanningTicketFileChanges(edit.plannedFileChanges);
      if (fileChangesError !== null) {
        return `Reviewer update for Planning Ticket '${edit.ticketId}' is invalid: ${fileChangesError}`;
      }
    }
    dependencyKeysByTicketId.set(
      edit.ticketId,
      edit.dependencyKeys ??
        ticket.dependencies.map((dependency) => {
          const dependencyTicket = tickets.get(dependency.ticketId);
          return (
            dependencyTicket?.key ??
            (dependencyTicket === undefined ? dependency.ticketId : `LEGACY-${dependencyTicket.id}`)
          );
        }),
    );
    tickets.set(edit.ticketId, {
      ...ticket,
      ...(edit.title === undefined ? {} : { title: edit.title }),
      ...(edit.bodyMarkdown === undefined ? {} : { bodyMarkdown: edit.bodyMarkdown }),
      ...(edit.plannedFileChanges === undefined
        ? {}
        : { plannedFileChanges: [...edit.plannedFileChanges] }),
      ...(edit.appReviewEligible === undefined
        ? {}
        : { appReviewEligible: edit.appReviewEligible }),
      ...(edit.appReviewScope === undefined ? {} : { appReviewScope: edit.appReviewScope }),
      ...(edit.appReviewPlanMarkdown === undefined
        ? {}
        : { appReviewPlanMarkdown: edit.appReviewPlanMarkdown }),
      updatedAt: input.updatedAt,
    });
  }

  const finalTickets = Array.from(tickets.values());
  const ticketIdByKey = new Map<string, string>();
  for (const ticket of finalTickets) {
    const ticketKey = ticket.key ?? `LEGACY-${ticket.id}`;
    if (ticketIdByKey.has(ticketKey)) return `Planning Ticket key '${ticketKey}' is duplicated.`;
    ticketIdByKey.set(ticketKey, ticket.id);
  }
  return finalTickets.map((ticket, index) => {
    const dependencyKeys = dependencyKeysByTicketId.get(ticket.id);
    const dependencies =
      dependencyKeys === undefined
        ? ticket.dependencies
        : dependencyKeys.map((key) => ({
            specId: input.specId,
            ticketId: ticketIdByKey.get(key) ?? key,
          }));
    return { ...ticket, ordinal: index + 1, dependencies };
  });
}

function buildPlanningSpecStagePrompt(): string {
  return [
    "Create the Spec artifact for this planning workflow.",
    "",
    "When ready, finish with exactly one fenced JSON block using this shape:",
    "```json",
    JSON.stringify(
      {
        type: "planning-spec-artifact",
        title: "Short Spec title",
        summaryMarkdown:
          "Full Spec markdown with goals, non-goals, workflows, data, risks, and acceptance criteria.",
      },
      null,
      2,
    ),
    "```",
  ].join("\n");
}

function buildPlanningGrillRestartPrompt(): string {
  return [
    "Restart the Planning Workflow's Engineering Grill from the existing conversation.",
    "",
    "Treat prior answers and repository findings as context, but reopen the design frontier so the user can revise decisions. Do not discard or revert any worktree changes. When the shared understanding is locked again, finish with the planning-grill-complete directive.",
  ].join("\n");
}

function buildProductAutomaticEngineeringGrillStagePrompt(
  command: Extract<OrchestrationCommand, { type: "thread.planning-workflow.launch" }>,
): string {
  return [
    "Run the Planning Workflow's automatic Engineering Grill from this locked Product Grill intent.",
    "",
    "Use the locked product intent as the authoritative source for product decisions. Do not reopen or repeat Product Grill questions.",
    "",
    "Resolve the Engineering Grill's full frontier of engineering and domain decisions yourself. Do not ask the user questions or wait for confirmation. Maintain the domain glossary and warranted ADRs as decisions crystallize.",
    "",
    `Intent title: ${command.intentTitle}`,
    "",
    "Intent summary:",
    command.intentSummaryMarkdown,
  ].join("\n");
}

function buildProductContextStagePrompt(
  command: Extract<OrchestrationCommand, { type: "thread.planning-workflow.launch" }>,
): string {
  return [
    "Build durable product and domain context from this locked Product Grill intent.",
    "",
    "Do not run an Engineering Grill, make engineering decisions, or ask the user questions. Maintain CONTEXT.md, CONTEXT-MAP.md when warranted, and product/domain ADRs, then hand off to Spec authoring.",
    "",
    `Intent title: ${command.intentTitle}`,
    "",
    "Intent summary:",
    command.intentSummaryMarkdown,
  ].join("\n");
}

function buildPlanningTicketsStagePrompt(spec: OrchestrationPlanningSpec): string {
  return [
    "Decompose this Spec into implementation-ready planning tickets.",
    "",
    `Spec id: ${spec.id}`,
    `Workflow id: ${spec.workflowId}`,
    "",
    "Use workflow_spec_get to retrieve the Spec body when needed. Do not rely on prompt-embedded artifact content.",
    "",
    "Inspect the repository before naming planned files. Every ticket must include at least one exact repository-relative POSIX file path with action create, update, or delete. Do not use absolute paths, directories, guesses, or glob patterns. Represent renames as delete plus create.",
    "",
    "When ready, finish with exactly one fenced JSON block using this shape. Dependencies must reference ticket keys from the same JSON payload.",
    "```json",
    JSON.stringify(
      {
        type: "planning-tickets-artifact",
        specId: spec.id,
        tickets: [
          {
            key: "TICKET-1",
            title: "Narrow implementation ticket",
            bodyMarkdown: "Outcome, touched surfaces, acceptance criteria, and expected tests.",
            plannedFileChanges: [{ path: "apps/example/src/feature.ts", action: "update" }],
            dependencyKeys: [],
            appReviewEligible: true,
            appReviewScope: "both",
            appReviewPlanMarkdown:
              "Start the ticket worktree's App Stack, open the affected UI, exercise the primary flow, and capture the expected visible result.",
          },
        ],
      },
      null,
      2,
    ),
    "```",
  ].join("\n");
}

/**
 * A later cycle exists only because the cycle before it could not fix something itself. Handing
 * that cycle its predecessor's findings is what keeps the two from being the same review twice:
 * without them each reviewer re-derives the same objections from scratch and re-edits the same
 * ticket, which is how one run spent five cycles rediscovering a single ordering trap.
 */
function buildPlanningReviewCarryForward(input: {
  readonly previousCycle: OrchestrationPlanningReviewCycle | undefined;
  readonly targetPlanningTicketIds: ReadonlyArray<string>;
}): ReadonlyArray<string> {
  const previous = input.previousCycle;
  if (previous === undefined) return [];
  const targets = new Set(input.targetPlanningTicketIds);
  const carriedFeedback = previous.perTicketFeedback.filter(
    (entry) => !entry.passed && targets.has(entry.ticketId),
  );
  if (carriedFeedback.length === 0 && previous.dependencyFeedback.length === 0) return [];
  return [
    "",
    `Cycle ${previous.cycleNumber} could not resolve these findings itself. Verify each one against the current ticket and repository, then fix it with a ticketEdit or fail it again with a concrete reason. Do not re-derive an independent review of tickets that are not in scope.`,
    ...carriedFeedback.map((entry) => `- ${entry.ticketId}: ${entry.feedbackMarkdown}`),
    ...previous.dependencyFeedback.map((entry) => `- Dependency graph: ${entry}`),
  ];
}

function buildPlanningReviewerPrompt(input: {
  readonly spec: OrchestrationPlanningSpec;
  readonly tickets: ReadonlyArray<OrchestrationPlanningTicket>;
  readonly cycleNumber: number;
  readonly mode: "full" | "targeted";
  readonly targetPlanningTicketIds: ReadonlyArray<string>;
  readonly previousCycle: OrchestrationPlanningReviewCycle | undefined;
}): string {
  const reviewScopeInstructions =
    input.mode === "full"
      ? [
          "This is a full review. Call workflow_tickets_list, retrieve every listed ticket with workflow_ticket_get, and inspect every ticket before deciding the verdict.",
          "Return exactly one perTicketFeedback entry for every target ticket, and put every ticket marked failed in failingPlanningTicketIds.",
        ]
      : [
          "This is a targeted re-review. Retrieve and inspect only the target tickets listed above; previously passed tickets are out of scope.",
          "Return exactly one perTicketFeedback entry for every target ticket, and put every ticket still marked failed in failingPlanningTicketIds.",
          "A clean targeted pass completes ticket review; there is no additional full-review cycle.",
        ];
  return [
    `Review planning ticket cycle ${input.cycleNumber} (${input.mode}) for Spec '${input.spec.id}'.`,
    `Workflow id: ${input.spec.workflowId}`,
    `Target ticket ids: ${input.targetPlanningTicketIds.join(", ")}`,
    "",
    "Retrieve the canonical Spec with workflow_spec_get. The artifact bodies are intentionally not embedded in this prompt.",
    ...reviewScopeInstructions,
    "Decide whether the ticket set is complete against the Spec and available context, and whether the proposed tickets are correct tracer-bullet vertical slices.",
    "",
    "Review for missing Spec coverage, incorrect horizontal slicing, oversized or undersized slices, incorrect dependency ordering, hidden prefactoring/migration/contract work, vague acceptance criteria, and missing expected tests.",
    "Also verify every ticket has a complete, plausible plannedFileChanges list with exact repository-relative paths and correct create/update/delete actions. Missing lists on legacy tickets are findings and should be repaired with a ticket update. Reviewer-created tickets require a non-empty list; update edits may replace the list with plannedFileChanges.",
    "",
    "Fix what you can through ticketEdits. A ticket you correct and pass is finished — it is not reviewed again — so leave every edited ticket in the state you would approve. Fail a ticket only when the correction genuinely needs another cycle.",
    ...buildPlanningReviewCarryForward({
      previousCycle: input.previousCycle,
      targetPlanningTicketIds: input.targetPlanningTicketIds,
    }),
    "",
    "When ready, finish with exactly one fenced JSON block using this shape. Use the planning ticket ids shown below.",
    ...PLANNING_REVIEWER_TICKET_EDIT_RULES.map((rule) => `- ${rule}`),
    "```json",
    planningReviewerVerdictExampleJson({
      cycleNumber: input.cycleNumber,
      mode: input.mode,
      targetPlanningTicketIds: input.targetPlanningTicketIds,
    }),
    "```",
  ].join("\n");
}

function buildImplementationRun(input: {
  readonly runId: string;
  readonly orchestratorThreadId: ThreadId;
  readonly command: Extract<OrchestrationCommand, { type: "thread.implementation-run.launch" }>;
  readonly tickets: ReadonlyArray<OrchestrationPlanningTicket>;
  readonly publisherUserId: string | null;
}): OrchestrationImplementationRun {
  const ticketIds = input.tickets.map((ticket) => ticket.id);
  const succeeded = new Set<string>();
  const ticketStates = input.tickets.map((ticket) => {
    const dependencyTicketIds = ticket.dependencies.map((dependency) => dependency.ticketId);
    const ready = dependencyTicketIds.every((ticketId) => succeeded.has(ticketId));
    return {
      ticketId: ticket.id,
      status: ready ? ("ready" as const) : ("blocked" as const),
      dependencyTicketIds,
      workerThreadId: null,
      branch: null,
      worktreePath: null,
      workerResult: null,
      appDevStackTierDownAt: null,
      resourceCleanupAt: null,
      resourceCleanupRetention: null,
      attemptCount: 0,
      implementationGeneration: 0,
      appReviewGeneration: 0,
      appReviewLaunchCount: 0,
      codeReviewGeneration: 0,
      codeReviewLaunchCount: 0,
      codeReviewPassCount: 0,
      stageExecutions: [],
      updatedAt: input.command.createdAt,
    };
  });
  const validationCommands = resolveImplementationValidationCommands({
    explicitCommands: input.command.validationCommands,
  });
  const plannedWorkers = input.tickets.map((ticket) => ({
    ticketId: ticket.id,
    dependencyTicketIds: ticket.dependencies.map((dependency) => dependency.ticketId),
    branch: `${input.command.orchestratorBranch}-ticket-${ticket.ordinal}`,
    worktreePath: `${input.command.orchestratorWorktreePath}-ticket-${ticket.ordinal}`,
  }));
  const dependencyTicketIds = new Set(
    input.tickets.flatMap((ticket) => ticket.dependencies.map((dependency) => dependency.ticketId)),
  );
  const terminalLineageTicketIds = input.tickets
    .filter((ticket) => !dependencyTicketIds.has(ticket.id))
    .map((ticket) => ticket.id);
  return {
    id: input.runId,
    artifactSource: "planning-spec",
    skips: input.command.skips ?? [],
    specId: input.command.specId,
    sourceProposedPlan: null,
    planningTicketIds: ticketIds,
    orchestratorThreadId: input.orchestratorThreadId,
    status: "launch-pending",
    baseBranch: input.command.baseBranch,
    pinnedCommit: input.command.pinnedCommit,
    orchestratorBranch: input.command.orchestratorBranch,
    orchestratorWorktreePath: input.command.orchestratorWorktreePath,
    launchSummary: {
      specId: input.command.specId,
      planningTicketIds: ticketIds,
      baseBranch: input.command.baseBranch,
      pinnedCommit: input.command.pinnedCommit,
      orchestratorBranch: input.command.orchestratorBranch,
      orchestratorWorktreePath: input.command.orchestratorWorktreePath,
      dependencyEdges: input.tickets.flatMap((ticket) =>
        ticket.dependencies.map((dependency) => ({
          blockingTicketId: dependency.ticketId,
          dependentTicketId: ticket.id,
        })),
      ),
      initialReadyTicketIds: ticketStates
        .filter((state) => state.status === "ready")
        .map((state) => state.ticketId),
      plannedWorkers,
      validationCommands,
      finalAppReview: {
        required: true,
        completionBlocking: true,
        appDevStackSource: "orchestrator-worktree",
        autoStartAppDevStack: true,
        browserMcpProfile: "agent-browser",
        maxCycles: IMPLEMENTATION_RUN_MAX_QA_REPAIRS,
      },
      createdAt: input.command.createdAt,
    },
    ticketStates,
    workerResults: [],
    terminalLineageTicketIds,
    integrationHeadSha: null,
    finalValidation: null,
    finalValidationResults: [],
    validatedHeadSha: null,
    activeValidationHeadSha: null,
    activeValidationKind: null,
    activeValidatorThreadId: null,
    mergeGateAttemptCount: 0,
    appDevStack: {
      status: "not-requested",
      stackId: null,
      stackStatus: null,
      frontendUrl: null,
      frontendServiceName: null,
      displayName: null,
      lastErrorMarkdown: null,
      requestedAt: "",
      updatedAt: "",
    },
    qaTooling: {
      status: "unknown",
      agentBrowserPackage: "agent-browser@0.31.1",
      lastErrorMarkdown: null,
      checkedAt: "",
    },
    appReviewIds: [],
    appReviewStrategy: "nested-workflow",
    appReviewWorkflowRunIds: [],
    latestAppReviewWorkflowOutcome: null,
    appReviewUnblockAttemptCount: 0,
    appReviews: [],
    appReviewedHeadSha: null,
    activeAppReviewHeadSha: null,
    activeAppReviewThreadId: null,
    qaCycleCount: 0,
    qaAttemptCount: 0,
    qaExhaustedAt: null,
    qaExhaustionReason: null,
    lastQaFailure: null,
    appReviewExhaustedAt: null,
    codeReviewedHeadSha: null,
    activeCodeReviewHeadSha: null,
    activeCodeReviewThreadId: null,
    activeChangeRequestBabysitterThreadId: null,
    codeReviewAttemptCount: 0,
    finalCodeReviewGeneration: 0,
    finalCodeReviewLaunchCount: 0,
    finalCodeReviewPassCount: 0,
    codeReviewExhaustedAt: null,
    codeReviewExhaustionReason: null,
    reviewGateExhaustedAt: null,
    reviewGateExhaustionReason: null,
    activeFixerThreadId: null,
    fixOrigin: null,
    latestCodeReviewReportMarkdown: null,
    handoffTarget: "orchestrator-worktree",
    baseBranchMergePolicy: "never-auto-merge",
    changeRequest: null,
    changeRequestFailure: null,
    changeRequestPublisherUserId: input.publisherUserId,
    fastBuildResult: null,
    stageExecutions: [],
    validationJobs: [],
    retryableFailure: null,
    automationHalt: null,
    createdAt: input.command.createdAt,
    updatedAt: input.command.createdAt,
  };
}

/**
 * The thread still working the stage a re-run targets, when there is one.
 *
 * A re-run has to refuse while its stage is live. Starting a second agent on
 * the same branch is how one worktree ends up with two writers and a review
 * that cannot name the HEAD it produced.
 */
function liveRerunTargetThreadId(input: {
  readonly readModel: OrchestrationReadModel;
  readonly run: OrchestrationImplementationRun;
  readonly target: OrchestrationImplementationRerunTarget;
  readonly nowMs: number;
}): ThreadId | null {
  const liveThread = (threadId: ThreadId | null | undefined): ThreadId | null => {
    if (threadId == null) return null;
    const thread = input.readModel.threads.find((candidate) => candidate.id === threadId);
    // The shared policy, not a local re-derivation: a reactor that thought this
    // stage was dead while the decider thought it live is how a run ends up
    // asking for the same stage every minute and being refused every minute.
    return stageClaimBlocksRestart(
      stageClaimState({ thread, threads: input.readModel.threads, nowMs: input.nowMs }),
    )
      ? (thread?.id ?? null)
      : null;
  };
  const liveAppReviewWorkflow = (runId: string | null | undefined): ThreadId | null => {
    if (runId == null) return null;
    const reviewRun = (input.readModel.appReviewWorkflowRuns ?? []).find(
      (candidate) => candidate.id === runId,
    );
    if (reviewRun === undefined || reviewRun.status !== "running") return null;
    // A durable run can outlive the provider session for its active phase. In
    // that state the run needs replacing, not a permanent "still running"
    // rejection. The App Review phase rerun guard uses the same session check.
    return liveThread(reviewRun.activeThreadId);
  };
  if (input.target.kind === "ticket") {
    const ticketId = input.target.ticketId;
    const state = input.run.ticketStates.find((candidate) => candidate.ticketId === ticketId);
    if (state === undefined) return null;
    switch (input.target.stage) {
      case "implementation":
        return liveThread(state.workerThreadId);
      case "app-review":
        return liveAppReviewWorkflow(state.appReviewWorkflowRunId);
      case "code-review":
        return liveThread(state.codeReviewThreadId);
    }
  }
  switch (input.target.stage) {
    // Integration runs inline in the reactor, so no thread owns it.
    case "integration":
      return null;
    case "merge-gate":
      return liveThread(input.run.activeValidatorThreadId);
    case "app-review":
      return (
        liveThread(input.run.activeAppReviewThreadId) ??
        liveAppReviewWorkflow(
          (input.readModel.appReviewWorkflowRuns ?? []).find(
            (candidate) =>
              candidate.caller.type === "implementation" &&
              candidate.caller.implementationRunId === input.run.id &&
              candidate.caller.ticketId === undefined &&
              candidate.status === "running",
          )?.id,
        )
      );
    case "code-review":
      return liveThread(input.run.activeCodeReviewThreadId);
  }
}

function canRerunCanceledFinalCodeReview(input: {
  readonly run: OrchestrationImplementationRun;
  readonly target: OrchestrationImplementationRerunTarget;
}): boolean {
  const { run, target } = input;
  if (
    run.artifactSource !== "planning-spec" ||
    target.kind !== "run" ||
    target.stage !== "code-review" ||
    run.integrationHeadSha === null ||
    run.codeReviewAttemptCount === 0 ||
    !run.ticketStates.every((state) => state.status === "succeeded" || state.status === "failed")
  ) {
    return false;
  }
  return (
    run.activeCodeReviewHeadSha === run.integrationHeadSha ||
    run.codeReviewedHeadSha === run.integrationHeadSha
  );
}

/**
 * The thread still working an App Review run's current phase, when there is one.
 *
 * The four phases share one worktree. E2E and browser review own separate
 * durable records, so no phase can restart beneath its current agent.
 */
function liveAppReviewPhaseThreadId(input: {
  readonly readModel: OrchestrationReadModel;
  readonly run: AppReviewWorkflowRun;
}): ThreadId | null {
  const threadId = input.run.activeThreadId;
  if (threadId === null) return null;
  const thread = input.readModel.threads.find((candidate) => candidate.id === threadId);
  if (thread === undefined || thread.deletedAt !== null) return null;
  return thread.session?.status === "starting" || thread.session?.status === "running"
    ? thread.id
    : null;
}

/**
 * The caller's own thread still working in the App Review's worktree.
 *
 * An embedded review borrows the worktree of the ticket or run that launched
 * it. Reopening the review sends that ticket back to `app-reviewing`, so a
 * repair would land beside whatever the caller has since started there.
 */
function liveAppReviewCallerThreadId(input: {
  readonly readModel: OrchestrationReadModel;
  readonly run: AppReviewWorkflowRun;
}): ThreadId | null {
  const caller = input.run.caller;
  if (caller.type !== "implementation") return null;
  const implementationRun = input.readModel.implementationRuns.find(
    (candidate) => candidate.id === caller.implementationRunId,
  );
  if (implementationRun === undefined) return null;
  const ticketId = caller.ticketId;
  const candidates =
    ticketId === undefined
      ? [
          implementationRun.activeValidatorThreadId,
          implementationRun.activeCodeReviewThreadId,
          implementationRun.activeFixerThreadId,
        ]
      : (() => {
          const state = implementationRun.ticketStates.find(
            (candidate) => candidate.ticketId === ticketId,
          );
          return [state?.workerThreadId, state?.codeReviewThreadId];
        })();
  for (const threadId of candidates) {
    if (threadId == null) continue;
    const thread = input.readModel.threads.find((candidate) => candidate.id === threadId);
    if (thread === undefined || thread.deletedAt !== null) continue;
    if (thread.session?.status === "starting" || thread.session?.status === "running") {
      return thread.id;
    }
  }
  return null;
}

// Session adoption takes seconds; a user message still unadopted after this
// window is a failed/stale start, not pending work. Mirrors the client's
// QUEUED_TURN_START_GRACE_MS in client-runtime threadSettled.ts.
const QUEUED_TURN_START_GRACE_MS = 2 * 60 * 1_000;

/**
 * Blocked-on-you work derived from the thread's retained activities: an
 * approval or user-input request with no later resolution for the same
 * requestId. The server-side twin of the shell's hasPendingApprovals /
 * hasPendingUserInput flags, which the decider read model does not carry.
 * The clearing rules MUST match ProjectionPipeline's pending accounting —
 * resolved activities always clear, respond.failed clears only when the
 * failure detail marks the request stale/unknown — or settle would be
 * rejected on threads whose shell flags read as clear.
 */
/**
 * Whether a live App Review run is the one a cycle budget just changed.
 *
 * The two App Review budgets run the same agent and are told apart by the step
 * above them: a review launched for a single ticket belongs to "Execute ticket
 * waves", and one launched for the whole run belongs to the App Review step.
 * A standalone review from the App Review panel carries its own budget from
 * its launch dialog and is left alone.
 */
function appReviewRunMatchesCycleKey(
  readModel: OrchestrationReadModel,
  run: AppReviewWorkflowRun,
  rootThreadId: ThreadId,
  key: WorkflowStepCycleKey,
): boolean {
  const caller = run.caller;
  if (caller.type !== "implementation") return false;
  const expected: WorkflowStepCycleKey =
    caller.ticketId === undefined
      ? { workflowPromptId: WORKFLOW_PROMPT_IDS.implementationBrowserAppReviewCodex }
      : {
          workflowPromptId: WORKFLOW_PROMPT_IDS.implementationBrowserAppReviewCodex,
          stepWorkflowPromptId: WORKFLOW_PROMPT_IDS.implementationTddCodex,
        };
  if (!workflowStepCycleKeysEqual(expected, key)) return false;
  const orchestrator = readModel.threads.find(
    (candidate) => candidate.id === caller.orchestratorThreadId,
  );
  if (orchestrator === undefined) return false;
  return (orchestrator.workflowContext?.rootThreadId ?? orchestrator.id) === rootThreadId;
}

function isStaleRequestFailureDetail(payload: Record<string, unknown> | null): boolean {
  const detail = typeof payload?.detail === "string" ? payload.detail.toLowerCase() : null;
  if (detail === null) return false;
  return (
    detail.includes("stale pending approval request") ||
    detail.includes("unknown pending approval request") ||
    detail.includes("unknown pending permission request") ||
    detail.includes("stale pending user-input request") ||
    detail.includes("unknown pending user-input request") ||
    detail.includes("unknown pending user input request") ||
    detail.includes("unknown pending codex user input request")
  );
}

// Scans the read model's activities, which the projector caps at the most
// recent 500. That bound is safe here: an OPEN approval/user-input request
// blocks its turn, so the thread cannot accumulate hundreds of later
// activities while one is outstanding — a request that has scrolled out of
// the window is one whose turn kept running, i.e. it was resolved or went
// stale. (The projection pipeline's pendingApprovalCount reads the same
// capped stream and stays consistent with this view.)
function hasOpenBlockingRequest(thread: {
  readonly activities: ReadonlyArray<{ readonly kind: string; readonly payload: unknown }>;
}): boolean {
  const openRequestIds = new Set<string>();
  for (const activity of thread.activities) {
    const payload =
      typeof activity.payload === "object" && activity.payload !== null
        ? (activity.payload as Record<string, unknown>)
        : null;
    const requestId = typeof payload?.requestId === "string" ? payload.requestId : null;
    if (requestId === null) continue;
    if (activity.kind === "approval.requested" || activity.kind === "user-input.requested") {
      openRequestIds.add(requestId);
    } else if (activity.kind === "approval.resolved" || activity.kind === "user-input.resolved") {
      openRequestIds.delete(requestId);
    } else if (
      (activity.kind === "provider.approval.respond.failed" ||
        activity.kind === "provider.user-input.respond.failed") &&
      isStaleRequestFailureDetail(payload)
    ) {
      openRequestIds.delete(requestId);
    }
  }
  return openRequestIds.size > 0;
}

/**
 * A queued turn start — a user message no turn has picked up yet — is work
 * in flight even though session is still null (turn.start emits
 * message-sent + turn-start-requested; the session arrives later). Detection
 * mirrors the client's hasQueuedTurnStart: the newest user message is
 * strictly newer than every latestTurn timestamp (adoption stamps the new
 * turn's requestedAt with the message time, clearing this), and only within
 * the adoption grace window — historical threads whose last user message
 * postdates their turn timestamps (older-server data, mid-turn messages)
 * must not be blocked forever. A failed session start (status "error")
 * clears the block immediately.
 *
 * The age check is bounded on BOTH sides: message timestamps are
 * client-supplied, so a client clock ahead of the server yields a negative
 * age. Without the lower bound that negative age satisfies `<= grace` for
 * as long as the skew lasts, extending the block far past the intended two
 * minutes.
 */
function threadHasQueuedTurnStart(
  thread: {
    readonly messages: ReadonlyArray<{ readonly role: string; readonly createdAt: string }>;
    readonly latestTurn: {
      readonly requestedAt: string;
      readonly startedAt: string | null;
      readonly completedAt: string | null;
    } | null;
    readonly session: { readonly status: string } | null;
  },
  occurredAt: string,
): boolean {
  const latestUserMessageAtMs = thread.messages.reduce(
    (latest, message) =>
      message.role === "user" ? Math.max(latest, Date.parse(message.createdAt)) : latest,
    Number.NEGATIVE_INFINITY,
  );
  const latestTurnAtMs =
    thread.latestTurn === null
      ? Number.NEGATIVE_INFINITY
      : Math.max(
          ...[
            thread.latestTurn.requestedAt,
            thread.latestTurn.startedAt,
            thread.latestTurn.completedAt,
          ].map((candidate) =>
            candidate == null ? Number.NEGATIVE_INFINITY : Date.parse(candidate),
          ),
        );
  const queuedAgeMs = Date.parse(occurredAt) - latestUserMessageAtMs;
  return (
    thread.session?.status !== "error" &&
    Number.isFinite(latestUserMessageAtMs) &&
    latestUserMessageAtMs > latestTurnAtMs &&
    Math.abs(queuedAgeMs) <= QUEUED_TURN_START_GRACE_MS
  );
}

function withEventBase(
  input: Pick<OrchestrationCommand, "commandId"> & {
    readonly aggregateKind: OrchestrationEvent["aggregateKind"];
    readonly aggregateId: OrchestrationEvent["aggregateId"];
    readonly occurredAt: string;
    readonly metadata?: OrchestrationEvent["metadata"];
  },
): Effect.Effect<
  Omit<OrchestrationEvent, "sequence" | "type" | "payload">,
  PlatformError.PlatformError,
  Crypto.Crypto
> {
  return Crypto.Crypto.pipe(
    Effect.flatMap((crypto) =>
      crypto.randomUUIDv4.pipe(
        Effect.map((eventId) => ({
          eventId: EventId.make(eventId),
          aggregateKind: input.aggregateKind,
          aggregateId: input.aggregateId,
          occurredAt: input.occurredAt,
          commandId: input.commandId,
          causationEventId: null,
          correlationId: input.commandId,
          metadata: input.metadata ?? {},
        })),
      ),
    ),
  );
}

type PlannedOrchestrationEvent = Omit<OrchestrationEvent, "sequence">;

type DecideOrchestrationCommandResult =
  | PlannedOrchestrationEvent
  | ReadonlyArray<PlannedOrchestrationEvent>;

export const decideOrchestrationCommand = Effect.fn("decideOrchestrationCommand")(function* ({
  command,
  readModel,
}: {
  readonly command: OrchestrationCommand;
  readonly readModel: OrchestrationReadModel;
}): Effect.fn.Return<
  DecideOrchestrationCommandResult,
  OrchestrationCommandInvariantError | PlatformError.PlatformError,
  Crypto.Crypto
> {
  switch (command.type) {
    case "project.create": {
      yield* requireProjectAbsent({
        readModel,
        command,
        projectId: command.projectId,
      });
      yield* requireActiveProjectWorkspaceRootAbsent({
        readModel,
        command,
        workspaceRoot: command.workspaceRoot,
        exceptProjectId: command.projectId,
      });

      return {
        ...(yield* withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "project.created",
        payload: {
          projectId: command.projectId,
          title: command.title,
          workspaceRoot: command.workspaceRoot,
          defaultModelSelection: command.defaultModelSelection ?? null,
          faviconPath: null,
          projectIcon: null,
          scripts: [],
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "project.meta.update": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      if (command.workspaceRoot !== undefined) {
        yield* requireActiveProjectWorkspaceRootAbsent({
          readModel,
          command,
          workspaceRoot: command.workspaceRoot,
          exceptProjectId: command.projectId,
        });
      }
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "project.meta-updated",
        payload: {
          projectId: command.projectId,
          ...(command.title !== undefined ? { title: command.title } : {}),
          ...(command.workspaceRoot !== undefined ? { workspaceRoot: command.workspaceRoot } : {}),
          ...(command.defaultModelSelection !== undefined
            ? { defaultModelSelection: command.defaultModelSelection }
            : {}),
          ...(command.defaultThreadEnvMode !== undefined
            ? { defaultThreadEnvMode: command.defaultThreadEnvMode }
            : {}),
          ...(command.previewRecordingMode !== undefined
            ? { previewRecordingMode: command.previewRecordingMode }
            : {}),
          ...(command.autoPull !== undefined ? { autoPull: command.autoPull } : {}),
          ...(command.faviconPath !== undefined ? { faviconPath: command.faviconPath } : {}),
          ...(command.projectIcon !== undefined ? { projectIcon: command.projectIcon } : {}),
          ...(command.scripts !== undefined ? { scripts: command.scripts } : {}),
          updatedAt: occurredAt,
        },
      };
    }

    case "project.delete": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      const activeThreads = listThreadsByProjectId(readModel, command.projectId).filter(
        (thread) => thread.deletedAt === null,
      );
      if (activeThreads.length > 0 && command.force !== true) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Project '${command.projectId}' is not empty and cannot be deleted without force=true.`,
        });
      }
      if (activeThreads.length > 0) {
        const occurredAt = yield* nowIso;
        const events: PlannedOrchestrationEvent[] = [];
        for (const thread of orderHierarchyPostOrder(activeThreads, {
          getId: (entry) => entry.id,
          getParentId: (entry) => entry.parentThreadId,
        })) {
          events.push({
            ...(yield* withEventBase({
              aggregateKind: "thread",
              aggregateId: thread.id,
              occurredAt,
              commandId: command.commandId,
            })),
            type: "thread.deleted",
            payload: {
              threadId: thread.id,
              deletedAt: occurredAt,
            },
          });
        }
        events.push({
          ...(yield* withEventBase({
            aggregateKind: "project",
            aggregateId: command.projectId,
            occurredAt,
            commandId: command.commandId,
          })),
          type: "project.deleted",
          payload: {
            projectId: command.projectId,
            deletedAt: occurredAt,
          },
        });
        return events;
      }

      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "project.deleted" as const,
        payload: {
          projectId: command.projectId,
          deletedAt: occurredAt,
        },
      };
    }

    case "thread.create": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      yield* requireThreadAbsent({
        readModel,
        command,
        threadId: command.threadId,
      });
      const parentThread =
        command.parentThreadId == null
          ? undefined
          : readModel.threads.find((thread) => thread.id === command.parentThreadId);
      const workflowContext =
        command.workflowContext !== undefined
          ? command.workflowContext
          : (parentThread?.workflowContext ??
            (command.interactionMode === "product-workflow" ||
            isProductWorkflowPreset(command.workflowPreset) ||
            command.interactionMode === "planning-workflow" ||
            command.interactionMode === "implementation-workflow"
              ? {
                  workflowId: WorkflowId.make(`workflow-${command.threadId}`),
                  parentWorkflowId: null,
                  rootThreadId: command.threadId,
                  ticketScope: [],
                }
              : null));
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.created",
        payload: {
          threadId: command.threadId,
          projectId: command.projectId,
          ownerUserId: command.ownerUserId,
          ...(command.parentThreadId !== undefined
            ? { parentThreadId: command.parentThreadId }
            : {}),
          ...(command.workflowRole !== undefined ? { workflowRole: command.workflowRole } : {}),
          workflowContext,
          ...(command.workflowSubagentBatchProvenance !== undefined
            ? { workflowSubagentBatchProvenance: command.workflowSubagentBatchProvenance }
            : {}),
          title: command.title,
          modelSelection: command.modelSelection,
          runtimeMode: command.runtimeMode,
          interactionMode: command.interactionMode,
          ...(command.workflowPreset !== undefined
            ? { workflowPreset: command.workflowPreset }
            : {}),
          ...(command.workflowImplementationSettings !== undefined
            ? { workflowImplementationSettings: command.workflowImplementationSettings }
            : {}),
          branch: command.branch,
          worktreePath: command.worktreePath,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.delete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      const events: PlannedOrchestrationEvent[] = [];
      const targets = collectHierarchyPostOrder(readModel.threads, command.threadId, {
        getId: (thread) => thread.id,
        getParentId: (thread) => thread.parentThreadId,
      }).filter((thread) => thread.id === command.threadId || thread.deletedAt === null);
      const targetIds = new Set(targets.map((thread) => thread.id));
      for (const run of readModel.implementationRuns) {
        if (
          run.status === "completed" ||
          run.status === "canceled" ||
          !targetIds.has(run.orchestratorThreadId)
        ) {
          continue;
        }
        const sourceThreadId = readModel.threads.find(
          (thread) => thread.id === run.orchestratorThreadId,
        )?.parentThreadId;
        if (sourceThreadId === null || sourceThreadId === undefined) continue;
        events.push({
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: sourceThreadId,
            occurredAt,
            commandId: command.commandId,
          })),
          type: "thread.implementation-run-cancel-requested",
          payload: {
            sourceThreadId,
            run: {
              ...run,
              status: "canceled",
              retryableFailure: null,
              updatedAt: occurredAt,
            },
            reason: "Workflow thread deleted.",
          },
        });
      }
      for (const thread of targets) {
        events.push({
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: thread.id,
            occurredAt,
            commandId: command.commandId,
          })),
          type: "thread.deleted",
          payload: {
            threadId: thread.id,
            deletedAt: occurredAt,
          },
        });
      }
      return events;
    }

    case "thread.archive": {
      yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      const events: PlannedOrchestrationEvent[] = [];
      const targets = collectHierarchyPostOrder(readModel.threads, command.threadId, {
        getId: (thread) => thread.id,
        getParentId: (thread) => thread.parentThreadId,
      }).filter(
        (thread) =>
          thread.id === command.threadId ||
          (thread.deletedAt === null && thread.archivedAt === null),
      );
      for (const thread of targets) {
        events.push({
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: thread.id,
            occurredAt,
            commandId: command.commandId,
          })),
          type: "thread.archived",
          payload: {
            threadId: thread.id,
            archivedAt: occurredAt,
            updatedAt: occurredAt,
          },
        });
      }
      return events;
    }

    case "thread.unarchive": {
      yield* requireThreadArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      const events: PlannedOrchestrationEvent[] = [];
      const targets = collectHierarchyPostOrder(readModel.threads, command.threadId, {
        getId: (thread) => thread.id,
        getParentId: (thread) => thread.parentThreadId,
      }).filter(
        (thread) =>
          thread.id === command.threadId ||
          (thread.deletedAt === null && thread.archivedAt !== null),
      );
      for (const thread of targets) {
        events.push({
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: thread.id,
            occurredAt,
            commandId: command.commandId,
          })),
          type: "thread.unarchived",
          payload: {
            threadId: thread.id,
            updatedAt: occurredAt,
          },
        });
      }
      return events;
    }

    case "thread.settle": {
      yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      // A sidebar workflow card represents its complete descendant tree. A
      // settle on that card must therefore park the same hierarchy that
      // archive/delete operate on; settling only the root leaves active
      // children holding the card in the inbox forever.
      const targets = collectHierarchyPostOrder(readModel.threads, command.threadId, {
        getId: (thread) => thread.id,
        getParentId: (thread) => thread.parentThreadId,
      }).filter(
        (thread) =>
          thread.id === command.threadId ||
          (thread.deletedAt === null && thread.archivedAt === null),
      );
      // Server-side twin of the client's canSettle session check: a stale
      // or raced client must not settle a thread whose session is coming
      // alive or working.
      const occurredAt = yield* nowIso;
      for (const thread of targets) {
        if (thread.session?.status === "starting" || thread.session?.status === "running") {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `thread ${thread.id} has an active session and cannot be settled`,
          });
        }
        // Pending approval / user-input requests are blocked-on-you work: a
        // raced or stale client must not park them behind a settled override
        // that would surface only after the request resolves.
        if (hasOpenBlockingRequest(thread)) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `thread ${thread.id} has a pending approval or user-input request and cannot be settled`,
          });
        }
        // Settling inside the adoption window would hide just-requested work.
        if (threadHasQueuedTurnStart(thread, occurredAt)) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `thread ${thread.id} has a queued turn start and cannot be settled`,
          });
        }
      }
      const events: PlannedOrchestrationEvent[] = [];
      for (const thread of targets) {
        // Settling an already-settled thread re-emits with the original
        // settledAt: the engine rejects zero-event commands, and bulk-settle /
        // double-click must stay silent no-ops rather than surface errors.
        const alreadySettled = thread.settledOverride === "settled" && thread.settledAt !== null;
        events.push({
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: thread.id,
            occurredAt,
            commandId: command.commandId,
          })),
          type: "thread.settled",
          payload: {
            threadId: thread.id,
            settledAt: alreadySettled ? thread.settledAt : occurredAt,
            // A re-emission is a projected no-op: keep the existing updatedAt
            // so duplicate settles neither rewind nor churn ordering. A fresh
            // settle stamps the command time.
            updatedAt: alreadySettled ? thread.updatedAt : occurredAt,
          },
        });
        if (thread.pinnedAt != null) {
          events.push({
            ...(yield* withEventBase({
              aggregateKind: "thread",
              aggregateId: thread.id,
              occurredAt,
              commandId: command.commandId,
            })),
            type: "thread.unpinned",
            payload: {
              threadId: thread.id,
              updatedAt: occurredAt,
            },
          });
        }
        if (thread.snoozedUntil != null) {
          events.push({
            ...(yield* withEventBase({
              aggregateKind: "thread",
              aggregateId: thread.id,
              occurredAt,
              commandId: command.commandId,
            })),
            type: "thread.unsnoozed",
            payload: {
              threadId: thread.id,
              reason: "user",
              updatedAt: occurredAt,
            },
          });
        }
      }
      return events;
    }

    case "thread.auto-settle": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (thread.settledOverride !== null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `thread ${command.threadId} changed before automatic settlement`,
        });
      }
      if (thread.session?.status === "starting" || thread.session?.status === "running") {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `thread ${thread.id} has an active session and cannot be settled`,
        });
      }
      if (hasOpenBlockingRequest(thread)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `thread ${thread.id} has a pending approval or user-input request and cannot be settled`,
        });
      }
      const occurredAt = yield* nowIso;
      if (threadHasQueuedTurnStart(thread, occurredAt)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `thread ${thread.id} has a queued turn start and cannot be settled`,
        });
      }
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: thread.id,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.settled",
        payload: {
          threadId: thread.id,
          settledAt: command.settledAt,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.workflow.pause": {
      yield* requireThreadNotArchived({ readModel, command, threadId: command.threadId });
      const targets = collectHierarchyPostOrder(readModel.threads, command.threadId, {
        getId: (thread) => thread.id,
        getParentId: (thread) => thread.parentThreadId,
      }).filter(
        (thread) =>
          thread.id === command.threadId ||
          (thread.deletedAt === null && thread.archivedAt === null),
      );
      const events: PlannedOrchestrationEvent[] = [];
      // The pause itself is one mark on the scope the user stopped. Descendants
      // inherit it by the parent walk, which also covers a thread the run
      // created between the click and the last agent going quiet. Settling the
      // subtree below is inbox housekeeping and no longer carries the pause:
      // a stopped agent's trailing session write un-settles its thread, and
      // that used to read as a resume.
      events.push({
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.workflow-paused",
        payload: {
          threadId: command.threadId,
          pausedAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      });
      for (const thread of targets) {
        if (thread.session !== null) {
          events.push({
            ...(yield* withEventBase({
              aggregateKind: "thread",
              aggregateId: thread.id,
              occurredAt: command.createdAt,
              commandId: command.commandId,
            })),
            type: "thread.session-stop-requested",
            payload: { threadId: thread.id, createdAt: command.createdAt },
          });
        }
        events.push({
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: thread.id,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          })),
          type: "thread.settled",
          payload: {
            threadId: thread.id,
            settledAt: thread.settledAt ?? command.createdAt,
            updatedAt: thread.settledOverride === "settled" ? thread.updatedAt : command.createdAt,
          },
        });
      }
      return events;
    }

    case "thread.workflow.resume": {
      yield* requireThreadNotArchived({ readModel, command, threadId: command.threadId });
      // Resume clears every pause mark in the subtree, not just the one on the
      // thread the user clicked: a run can be paused at more than one scope
      // (a wave, then the whole workflow), and leaving an inner mark set would
      // resume a run that then refuses to start the branch it was told to.
      const pausedTargets = collectHierarchyPostOrder(readModel.threads, command.threadId, {
        getId: (thread) => thread.id,
        getParentId: (thread) => thread.parentThreadId,
      }).filter(
        (thread) =>
          thread.workflowPausedAt != null &&
          (thread.id === command.threadId ||
            (thread.deletedAt === null && thread.archivedAt === null)),
      );
      // Pause settles the whole subtree, so resume has to clear the whole
      // subtree: a still-settled descendant keeps failing the paused-ancestor
      // invariant the moment a reactor tries to re-enter its stage.
      const targets = collectHierarchyPostOrder(readModel.threads, command.threadId, {
        getId: (thread) => thread.id,
        getParentId: (thread) => thread.parentThreadId,
      }).filter(
        (thread) =>
          thread.settledOverride === "settled" &&
          (thread.id === command.threadId ||
            (thread.deletedAt === null && thread.archivedAt === null)),
      );
      const events: PlannedOrchestrationEvent[] = [];
      for (const thread of pausedTargets) {
        events.push({
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: thread.id,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          })),
          type: "thread.workflow-resumed",
          payload: {
            threadId: thread.id,
            updatedAt: command.createdAt,
          },
        });
      }
      for (const thread of targets) {
        events.push({
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: thread.id,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          })),
          type: "thread.unsettled",
          payload: {
            threadId: thread.id,
            // The thread the user resumed is the one they want back in the
            // inbox, so it is pinned active. Descendants take the neutral
            // server-side reset instead and settle again on their own once the
            // work they are about to be given finishes.
            reason: thread.id === command.threadId ? "user" : "activity",
            updatedAt: command.createdAt,
          },
        });
      }
      return events;
    }

    case "thread.workflow.step-model.set": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      // Pins live on the workflow root so every step of the run reads one
      // record, no matter which thread of the run the client had open.
      const rootThreadId = thread.workflowContext?.rootThreadId ?? thread.id;
      const rootThread =
        readModel.threads.find((candidate) => candidate.id === rootThreadId) ?? thread;
      const preset = rootThread.workflowPreset;
      if (
        command.modelSelection !== null &&
        command.stepWorkflowPromptId === undefined &&
        preset != null
      ) {
        const matchingSteps = WORKFLOW_PRESET_DEFINITION_BY_ID[preset].helpSteps.filter(
          (step) => step.skillId === command.workflowPromptId,
        );
        if (
          matchingSteps.length > 0 &&
          matchingSteps.every((step) => workflowPresetStepUsesRootThread(preset, step))
        ) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `Workflow step '${command.workflowPromptId}' shares the workflow's main thread and cannot have a separate model pin.`,
          });
        }
      }
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: rootThread.id,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.workflow-step-model-set",
        payload: {
          threadId: rootThread.id,
          workflowPromptId: command.workflowPromptId,
          ...(command.stepWorkflowPromptId === undefined
            ? {}
            : { stepWorkflowPromptId: command.stepWorkflowPromptId }),
          modelSelection: command.modelSelection,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.workflow.step-cycles.set": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      // Budgets live on the workflow root, like the step model pins.
      const rootThreadId = thread.workflowContext?.rootThreadId ?? thread.id;
      const rootThread =
        readModel.threads.find((candidate) => candidate.id === rootThreadId) ?? thread;
      const key = {
        workflowPromptId: command.workflowPromptId,
        ...(command.stepWorkflowPromptId === undefined
          ? {}
          : { stepWorkflowPromptId: command.stepWorkflowPromptId }),
      };
      const target = findWorkflowStepCycleTarget(key);
      if (target === undefined) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Workflow step '${command.workflowPromptId}' does not run in cycles, so it has no cycle budget.`,
        });
      }
      const boundedMaxCycles =
        command.maxCycles === null ? null : Math.min(command.maxCycles, target.maxCycles);
      const occurredAt = yield* nowIso;
      const events: PlannedOrchestrationEvent[] = [
        {
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: rootThread.id,
            occurredAt,
            commandId: command.commandId,
          })),
          type: "thread.workflow-step-cycles-set",
          payload: {
            threadId: rootThread.id,
            ...key,
            maxCycles: boundedMaxCycles,
            updatedAt: occurredAt,
          },
        },
      ];
      // A budget the run is already spending has to move with it, or the panel
      // keeps counting toward the old number and a review that ran out of
      // cycles can never be given more.
      const budget = resolveWorkflowStepCycleBudget({
        key,
        threadOverrides: boundedMaxCycles === null ? [] : [{ ...key, maxCycles: boundedMaxCycles }],
      });
      for (const run of readModel.appReviewWorkflowRuns ?? []) {
        if (run.status !== "running" || run.cycleBudget === budget) continue;
        // A review-only run is one cycle by definition, so a budget set for the
        // step it shares does not reach it.
        if (run.reviewOnly === true) continue;
        if (!appReviewRunMatchesCycleKey(readModel, run, rootThread.id, key)) continue;
        events.push({
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: run.controllerThreadId,
            occurredAt,
            commandId: command.commandId,
          })),
          type: "thread.app-review-workflow-updated",
          payload: {
            sourceThreadId: run.targetThreadId,
            run: {
              ...run,
              cycleBudget: AppReviewWorkflowCycleBudget.make(budget),
              updatedAt: occurredAt,
            },
          },
        });
      }
      return events;
    }

    case "thread.workflow.step-review-parts.set": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      // Review parts live on the workflow root, like the step model pins.
      const rootThreadId = thread.workflowContext?.rootThreadId ?? thread.id;
      const rootThread =
        readModel.threads.find((candidate) => candidate.id === rootThreadId) ?? thread;
      const key = {
        workflowPromptId: command.workflowPromptId,
        ...(command.stepWorkflowPromptId === undefined
          ? {}
          : { stepWorkflowPromptId: command.stepWorkflowPromptId }),
      };
      if (!APP_REVIEW_PARTS_TARGETS.some((target) => workflowStepCycleKeysEqual(target.key, key))) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Workflow step '${command.workflowPromptId}' is not an App Review, so it has no review parts.`,
        });
      }
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: rootThread.id,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.workflow-step-review-parts-set",
        payload: {
          threadId: rootThread.id,
          ...key,
          parts: command.parts,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.unsettle": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      // Idempotent by re-emission (see thread.settle): reducing the event a
      // second time lands on the same override state. A re-emission keeps
      // the existing updatedAt so duplicates do not churn ordering.
      const alreadyPinnedActive = thread.settledOverride === "active";
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.unsettled",
        payload: {
          threadId: command.threadId,
          reason: command.reason,
          updatedAt: alreadyPinnedActive ? thread.updatedAt : occurredAt,
        },
      };
    }

    case "thread.snooze": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      // A wake time in the past would create a thread that is snoozed and
      // woken at once — the row would never leave the inbox but still carry
      // snooze state. Reject instead of silently normalizing. The negated
      // comparison also catches unparseable wake times (IsoDateTime is
      // structurally just a string): NaN fails every comparison, and an
      // unparseable snoozedUntil must never persist.
      if (!(Date.parse(command.snoozedUntil) > Date.parse(occurredAt))) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `thread ${command.threadId} snooze wake time ${command.snoozedUntil} is not in the future`,
        });
      }
      // Blocked-on-you work must not be snoozed away: a pending approval or
      // user-input request is the agent waiting on the user, and hiding it
      // defeats the request. (A running session IS snoozable — snooze only
      // affects visibility, never the agent.)
      if (hasOpenBlockingRequest(thread)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `thread ${command.threadId} has a pending approval or user-input request and cannot be snoozed`,
        });
      }
      // A queued turn start — a user message no turn has adopted yet — is
      // invisible pending work: no session, no pending flags. Snoozing in
      // that window would hide a just-requested turn exactly the way settle
      // would.
      if (threadHasQueuedTurnStart(thread, occurredAt)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `thread ${command.threadId} has a queued turn start and cannot be snoozed`,
        });
      }
      // Re-snoozing an already-snoozed thread to the SAME wake time is a
      // duplicate (double-click, raced clients): re-emit with the original
      // timestamps so the projection is a no-op. A different wake time is a
      // real change and stamps fresh.
      const existingSnoozedAt =
        thread.snoozedUntil === command.snoozedUntil && thread.snoozedAt != null
          ? thread.snoozedAt
          : null;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.snoozed",
        payload: {
          threadId: command.threadId,
          snoozedUntil: command.snoozedUntil,
          snoozedAt: existingSnoozedAt ?? occurredAt,
          updatedAt: existingSnoozedAt !== null ? thread.updatedAt : occurredAt,
        },
      };
    }

    case "thread.unsnooze": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      // Idempotent by re-emission (see thread.settle): waking a thread that
      // is not snoozed lands on the same null state without churning
      // updatedAt.
      const alreadyAwake = thread.snoozedUntil == null;
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.unsnoozed",
        payload: {
          threadId: command.threadId,
          reason: command.reason,
          updatedAt: alreadyAwake ? thread.updatedAt : occurredAt,
        },
      };
    }

    case "thread.pin": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      // Re-pinning an already-pinned thread is a duplicate (double-click,
      // raced clients): re-emit with the original timestamps so the
      // projection is a no-op. Pinning has no lifecycle invariants — a pin
      // only ever promotes visibility, so it can never hide pending work.
      const existingPinnedAt = thread.pinnedAt ?? null;
      const pinnedEvent = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.pinned" as const,
        payload: {
          threadId: command.threadId,
          pinnedAt: existingPinnedAt ?? occurredAt,
          // A fresh pin takes the client's slot in the arranged order; on a
          // re-pin the existing key wins so raced duplicates cannot move a
          // thread the user already placed.
          ...(existingPinnedAt === null && command.orderKey !== undefined
            ? { pinOrderKey: command.orderKey }
            : {}),
          updatedAt: existingPinnedAt !== null ? thread.updatedAt : occurredAt,
        },
      };
      // Pinning is a promotion: it clears the parked states rather than
      // silently outranking them. An explicit settle un-settles (reason
      // "user", same override the un-settle button stamps), and a snooze's
      // return ticket is spent — the thread is on top NOW, not on Tuesday.
      const promotionEvents: Array<Omit<OrchestrationEvent, "sequence">> = [];
      if (thread.settledOverride === "settled") {
        promotionEvents.push({
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt,
            commandId: command.commandId,
          })),
          type: "thread.unsettled",
          payload: {
            threadId: command.threadId,
            reason: "user",
            updatedAt: occurredAt,
          },
        });
      }
      if (thread.snoozedUntil != null) {
        promotionEvents.push({
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt,
            commandId: command.commandId,
          })),
          type: "thread.unsnoozed",
          payload: {
            threadId: command.threadId,
            reason: "user",
            updatedAt: occurredAt,
          },
        });
      }
      return promotionEvents.length > 0 ? [pinnedEvent, ...promotionEvents] : pinnedEvent;
    }

    case "thread.unpin": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      // Idempotent by re-emission (see thread.settle): unpinning a thread
      // that is not pinned lands on the same null state without churning
      // updatedAt.
      const alreadyUnpinned = thread.pinnedAt == null;
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.unpinned",
        payload: {
          threadId: command.threadId,
          updatedAt: alreadyUnpinned ? thread.updatedAt : occurredAt,
        },
      };
    }

    case "thread.pin.reorder": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      // Only pinned threads have a slot in the arranged order. Rejecting
      // (rather than silently pinning) keeps a raced reorder-after-unpin
      // from resurrecting a pin the user just cleared.
      if (thread.pinnedAt == null) {
        return yield* Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `thread ${command.threadId} is not pinned and cannot be reordered`,
          }),
        );
      }
      // Idempotent by re-emission (see thread.settle): a duplicate drop on
      // the same slot keeps the existing updatedAt so it projects as a no-op.
      const keyUnchanged = thread.pinOrderKey === command.orderKey;
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.pin-reordered",
        payload: {
          threadId: command.threadId,
          orderKey: command.orderKey,
          updatedAt: keyUnchanged ? thread.updatedAt : occurredAt,
        },
      };
    }

    case "thread.meta.update": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const branch =
        command.branch !== undefined &&
        command.expectedBranch !== undefined &&
        thread.branch !== command.expectedBranch
          ? thread.branch
          : command.branch;
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.meta-updated",
        payload: {
          threadId: command.threadId,
          ...(command.ownerUserId !== undefined ? { ownerUserId: command.ownerUserId } : {}),
          ...(command.title !== undefined ? { title: command.title } : {}),
          ...(command.regenerateTitle === true
            ? {
                regenerateTitle: true as const,
                previousTitle: thread.title,
                titleRegeneration: {
                  requestId: command.commandId,
                  startedAt: occurredAt,
                },
              }
            : {}),
          ...(command.title !== undefined && thread.titleRegeneration != null
            ? { titleRegeneration: null }
            : {}),
          ...(command.modelSelection !== undefined
            ? { modelSelection: command.modelSelection }
            : {}),
          ...(branch !== undefined ? { branch } : {}),
          ...(command.worktreePath !== undefined ? { worktreePath: command.worktreePath } : {}),
          ...(command.linkedPullRequest !== undefined
            ? { linkedPullRequest: command.linkedPullRequest }
            : {}),
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.title.regeneration.complete": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const requestIsCurrent = thread.titleRegeneration?.requestId === command.requestId;
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.meta-updated",
        payload: {
          threadId: command.threadId,
          ...(requestIsCurrent && command.title !== undefined ? { title: command.title } : {}),
          ...(requestIsCurrent ? { titleRegeneration: null } : {}),
          updatedAt: requestIsCurrent ? occurredAt : thread.updatedAt,
        },
      };
    }

    case "thread.runtime-mode.set": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.runtime-mode-set",
        payload: {
          threadId: command.threadId,
          runtimeMode: command.runtimeMode,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.interaction-mode.set": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.interaction-mode-set",
        payload: {
          threadId: command.threadId,
          interactionMode: command.interactionMode,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.composer-mode.set": {
      yield* requireThread({ readModel, command, threadId: command.threadId });
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.composer-mode-set",
        payload: {
          threadId: command.threadId,
          interactionMode: command.interactionMode,
          workflowPreset: command.workflowPreset,
          ...(command.workflowImplementationSettings !== undefined
            ? { workflowImplementationSettings: command.workflowImplementationSettings }
            : {}),
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.planning-spec.create":
      return yield* decideOrchestrationCommand({
        readModel,
        command: {
          type: "thread.planning-stage.start",
          commandId: command.commandId,
          threadId: command.threadId,
          stage: "spec",
          createdAt: command.createdAt,
        },
      });

    case "thread.planning-workflow.launch": {
      const productRootThread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      yield* requireWorkflowNotPaused({ readModel, command, threadId: command.threadId });
      if (!isProductWorkflowRoot(productRootThread)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Thread '${command.threadId}' is not a Product Workflow root thread.`,
        });
      }

      if (
        productRootThread.planningWorkflow !== null &&
        productRootThread.planningWorkflow !== undefined
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Thread '${command.threadId}' already runs a Planning Workflow.`,
        });
      }

      // Planning continues in the product root thread so the grill context stays
      // in the conversation; the stage event stamps the workflow context the
      // planning-orchestrator child used to carry. The preset is pinned so the
      // thread still reads as a product root once its interaction mode flips.
      const crypto = yield* Crypto.Crypto;
      const messageUuid = yield* crypto.randomUUIDv4;
      const productContextOnly = productRootThread.workflowPreset === "product-planning";
      const messageId = MessageId.make(
        `message-product-${productContextOnly ? "context" : "engineering-grill"}-${messageUuid}`,
      );
      const modeSetEvent: PlannedOrchestrationEvent = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: productRootThread.id,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.composer-mode-set",
        payload: {
          threadId: productRootThread.id,
          interactionMode: "planning-workflow",
          workflowPreset: productRootThread.workflowPreset ?? "full-feature",
          updatedAt: command.createdAt,
        },
      };
      const runtimeModeSetEvent: PlannedOrchestrationEvent = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: productRootThread.id,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        causationEventId: modeSetEvent.eventId,
        type: "thread.runtime-mode-set",
        payload: {
          threadId: productRootThread.id,
          runtimeMode: WORKFLOW_AUTOMATION_RUNTIME_MODE,
          updatedAt: command.createdAt,
        },
      };
      const stageStartedEvent: PlannedOrchestrationEvent = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: productRootThread.id,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        causationEventId: modeSetEvent.eventId,
        type: "thread.planning-stage-started",
        payload: {
          threadId: productRootThread.id,
          workflowContext: productRootThread.workflowContext ?? {
            workflowId: WorkflowId.make(`workflow-${productRootThread.id}`),
            parentWorkflowId: null,
            rootThreadId: productRootThread.id,
            ticketScope: [],
          },
          stage: "grill",
          startedAt: command.createdAt,
        },
      };
      const promptEvent: PlannedOrchestrationEvent = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: productRootThread.id,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        causationEventId: stageStartedEvent.eventId,
        type: "thread.message-sent",
        payload: {
          threadId: productRootThread.id,
          messageId,
          role: "user",
          text: productContextOnly
            ? buildProductContextStagePrompt(command)
            : buildProductAutomaticEngineeringGrillStagePrompt(command),
          turnId: null,
          streaming: false,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
      const turnStartRequestedEvent: PlannedOrchestrationEvent = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: productRootThread.id,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        causationEventId: promptEvent.eventId,
        type: "thread.turn-start-requested",
        payload: {
          threadId: productRootThread.id,
          messageId,
          modelSelection: productRootThread.modelSelection,
          runtimeMode: WORKFLOW_AUTOMATION_RUNTIME_MODE,
          interactionMode: "planning-workflow",
          workflowPromptId: productContextOnly
            ? WORKFLOW_PROMPT_IDS.planningProductContextCodex
            : WORKFLOW_PROMPT_IDS.planningAutomaticEngineeringGrillCodex,
          createdAt: command.createdAt,
        },
      };
      return [
        modeSetEvent,
        runtimeModeSetEvent,
        stageStartedEvent,
        promptEvent,
        turnStartRequestedEvent,
      ];
    }

    case "thread.planning-stage.start": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      yield* requireWorkflowNotPaused({ readModel, command, threadId: command.threadId });
      if (thread.interactionMode !== "planning-workflow") {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Thread '${command.threadId}' is not in Planning Workflow mode.`,
        });
      }
      const spec = thread.planningWorkflow?.spec ?? null;
      if (command.stage === "tickets" && spec === null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Thread '${command.threadId}' does not have a Spec for Planning Tickets.`,
        });
      }

      const crypto = yield* Crypto.Crypto;
      const messageUuid = yield* crypto.randomUUIDv4;
      const messageId = MessageId.make(`message-planning-${command.stage}-stage-${messageUuid}`);
      const stage =
        command.stage === "grill"
          ? "grill"
          : command.stage === "spec"
            ? "spec-authoring"
            : "tickets-authoring";
      const workflowPromptId =
        command.stage === "grill"
          ? WORKFLOW_PROMPT_IDS.planningGrillStageCodex
          : command.stage === "spec"
            ? WORKFLOW_PROMPT_IDS.planningSpecCodex
            : WORKFLOW_PROMPT_IDS.planningTicketsCodex;
      const promptText =
        command.stage === "grill"
          ? buildPlanningGrillRestartPrompt()
          : command.stage === "spec"
            ? buildPlanningSpecStagePrompt()
            : buildPlanningTicketsStagePrompt(spec!);
      // Nothing upstream of this command requires a preset: a thread reaches the
      // planning stage machine on its interaction mode alone. Pin the
      // Engineering Workflow preset here so the thread that runs planning is
      // also the thread the implementation handoff recognises — without it,
      // planning completes and the workflow stops with nothing to show for it.
      const presetPinEvent: PlannedOrchestrationEvent | null =
        thread.workflowPreset == null
          ? {
              ...(yield* withEventBase({
                aggregateKind: "thread",
                aggregateId: thread.id,
                occurredAt: command.createdAt,
                commandId: command.commandId,
              })),
              type: "thread.composer-mode-set",
              payload: {
                threadId: thread.id,
                interactionMode: "planning-workflow",
                workflowPreset: "planning",
                updatedAt: command.createdAt,
              },
            }
          : null;
      // The grill is the workflow's human gate; from Spec authoring on, the
      // thread runs unattended.
      const runtimeModeSetEvent: PlannedOrchestrationEvent = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: thread.id,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.runtime-mode-set",
        payload: {
          threadId: thread.id,
          runtimeMode: WORKFLOW_AUTOMATION_RUNTIME_MODE,
          updatedAt: command.createdAt,
        },
      };
      const stageStartedEvent: PlannedOrchestrationEvent = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: thread.id,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        causationEventId: runtimeModeSetEvent.eventId,
        type: "thread.planning-stage-started",
        payload: {
          threadId: thread.id,
          stage,
          startedAt: command.createdAt,
        },
      };
      const promptEvent: PlannedOrchestrationEvent = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: thread.id,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        causationEventId: stageStartedEvent.eventId,
        type: "thread.message-sent",
        payload: {
          threadId: thread.id,
          messageId,
          role: "user",
          text: promptText,
          turnId: null,
          streaming: false,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
      const turnStartRequestedEvent: PlannedOrchestrationEvent = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: thread.id,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        causationEventId: promptEvent.eventId,
        type: "thread.turn-start-requested",
        payload: {
          threadId: thread.id,
          messageId,
          modelSelection: thread.modelSelection,
          runtimeMode: WORKFLOW_AUTOMATION_RUNTIME_MODE,
          interactionMode: thread.interactionMode,
          workflowPromptId,
          createdAt: command.createdAt,
        },
      };
      return [
        ...(presetPinEvent === null ? [] : [presetPinEvent]),
        runtimeModeSetEvent,
        stageStartedEvent,
        promptEvent,
        turnStartRequestedEvent,
      ];
    }

    case "thread.planning-workflow.stage.set": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (thread.interactionMode !== "planning-workflow") {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Thread '${command.threadId}' is not in Planning Workflow mode.`,
        });
      }
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: thread.id,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.planning-workflow-stage-set",
        payload: {
          threadId: thread.id,
          stage: command.stage,
          ...(command.reasonMarkdown !== undefined
            ? { reasonMarkdown: command.reasonMarkdown }
            : {}),
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.planning-spec.apply": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      yield* requireWorkflowNotPaused({ readModel, command, threadId: command.threadId });
      if (thread.interactionMode !== "planning-workflow") {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Thread '${command.threadId}' is not in Planning Workflow mode.`,
        });
      }
      const artifactKind = command.artifactKind ?? "spec";
      const existingArtifact =
        artifactKind === "wayfinder-map"
          ? (thread.planningWorkflow?.wayfinderMap ?? null)
          : (thread.planningWorkflow?.spec ?? null);
      if (
        artifactKind === "spec" &&
        existingArtifact !== null &&
        thread.planningWorkflow?.stage !== "spec-authoring"
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Thread '${command.threadId}' already has a Spec for this Planning Workflow.`,
        });
      }
      const crypto = yield* Crypto.Crypto;
      const specUuid = yield* crypto.randomUUIDv4;
      const ticketMessageUuid = yield* crypto.randomUUIDv4;
      const spec = buildPlanningSpecFromArtifact({
        specId:
          existingArtifact?.id ??
          (artifactKind === "wayfinder-map" ? `wayfinder-map-${specUuid}` : `spec-${specUuid}`),
        threadId: thread.id,
        command,
      });
      const resolvedArtifact =
        existingArtifact === null
          ? spec
          : {
              ...spec,
              sourceMessageIds: [
                ...existingArtifact.sourceMessageIds,
                ...spec.sourceMessageIds.filter(
                  (messageId) => !existingArtifact.sourceMessageIds.includes(messageId),
                ),
              ],
              workflowId: existingArtifact.workflowId,
              ticketCount: existingArtifact.ticketCount,
              createdAt: existingArtifact.createdAt,
            };
      const ticketMessageId = MessageId.make(`message-planning-tickets-stage-${ticketMessageUuid}`);
      const specCreatedEvent: PlannedOrchestrationEvent = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: thread.id,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.planning-spec-created",
        payload: {
          threadId: thread.id,
          spec: resolvedArtifact,
          artifactKind,
          stage: artifactKind === "wayfinder-map" ? "grill" : "tickets-authoring",
        },
      };
      if (artifactKind === "wayfinder-map") {
        return specCreatedEvent;
      }
      const ticketsPromptEvent: PlannedOrchestrationEvent = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: thread.id,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        causationEventId: specCreatedEvent.eventId,
        type: "thread.message-sent",
        payload: {
          threadId: thread.id,
          messageId: ticketMessageId,
          role: "user",
          text: buildPlanningTicketsStagePrompt(resolvedArtifact),
          turnId: null,
          streaming: false,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
      const ticketsTurnStartRequestedEvent: PlannedOrchestrationEvent = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: thread.id,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        causationEventId: ticketsPromptEvent.eventId,
        type: "thread.turn-start-requested",
        payload: {
          threadId: thread.id,
          messageId: ticketMessageId,
          modelSelection: thread.modelSelection,
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
          workflowPromptId: WORKFLOW_PROMPT_IDS.planningTicketsCodex,
          createdAt: command.createdAt,
        },
      };
      return [specCreatedEvent, ticketsPromptEvent, ticketsTurnStartRequestedEvent];
    }

    case "thread.planning-tickets.apply": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const workflow = thread.planningWorkflow;
      const spec = workflow?.spec ?? null;
      const wayfinderMap = workflow?.wayfinderMap ?? null;
      if (
        thread.interactionMode === "implementation-workflow" &&
        thread.workflowRole === null &&
        workflow == null
      ) {
        const promptSpec = buildPlanningSpecFromArtifact({
          specId: command.specId,
          threadId: thread.id,
          command: {
            type: "thread.planning-spec.apply",
            commandId: command.commandId,
            threadId: command.threadId,
            sourceMessageId: command.sourceMessageId,
            title: command.tickets[0]?.title ?? "Prompt implementation",
            summaryMarkdown:
              "Implementation tickets derived directly from the originating user prompt.",
            createdAt: command.createdAt,
          },
        });
        const crypto = yield* Crypto.Crypto;
        const generatedTicketIds = yield* Effect.forEach(command.tickets, () =>
          crypto.randomUUIDv4.pipe(Effect.map((uuid) => `planning-ticket-${uuid}`)),
        );
        const tickets = buildPlanningTicketsFromArtifact({
          specId: promptSpec.id,
          command,
          generatedTicketIds,
        });
        if (typeof tickets === "string") {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: tickets,
          });
        }
        const validationError = validatePlanningTicketGraph(promptSpec.id, tickets);
        if (validationError !== null) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: validationError,
          });
        }
        return {
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: thread.id,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          })),
          type: "thread.planning-tickets-created",
          payload: {
            threadId: thread.id,
            specId: promptSpec.id,
            spec: { ...promptSpec, ticketCount: tickets.length },
            tickets,
            stage: "completed",
          },
        } satisfies PlannedOrchestrationEvent;
      }
      if (thread.interactionMode !== "planning-workflow") {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Thread '${command.threadId}' is not in Planning Workflow mode.`,
        });
      }
      if (workflow === null || workflow === undefined || (spec === null && wayfinderMap === null)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Planning Thread '${thread.id}' does not have a Spec for Planning Tickets.`,
        });
      }
      const targetArtifact =
        spec?.id === command.specId
          ? spec
          : wayfinderMap?.id === command.specId
            ? wayfinderMap
            : null;
      if (targetArtifact === null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Planning Tickets artifact targets unknown planning artifact '${command.specId}'.`,
        });
      }
      const crypto = yield* Crypto.Crypto;
      const generatedTicketIds = yield* Effect.forEach(command.tickets, () =>
        crypto.randomUUIDv4.pipe(Effect.map((uuid) => `planning-ticket-${uuid}`)),
      );
      const tickets = buildPlanningTicketsFromArtifact({
        specId: targetArtifact.id,
        command,
        generatedTicketIds,
      });
      if (typeof tickets === "string") {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: tickets,
        });
      }
      const validationError = validatePlanningTicketGraph(targetArtifact.id, tickets);
      if (validationError !== null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: validationError,
        });
      }
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: thread.id,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type:
          workflow.stage === "ticket-revision"
            ? "thread.planning-tickets-revised"
            : "thread.planning-tickets-created",
        payload:
          workflow.stage === "ticket-revision"
            ? {
                threadId: thread.id,
                specId: targetArtifact.id,
                tickets,
                stage: targetArtifact === wayfinderMap ? "grill" : "ticket-review",
                revisedAt: command.createdAt,
              }
            : {
                threadId: thread.id,
                specId: targetArtifact.id,
                tickets,
                stage: targetArtifact === wayfinderMap ? "grill" : "ticket-review",
              },
      } satisfies PlannedOrchestrationEvent;
    }

    case "thread.planning-ticket-review.request": {
      const planningThread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      yield* requireWorkflowNotPaused({ readModel, command, threadId: command.threadId });
      const workflow = planningThread.planningWorkflow;
      const spec = workflow?.spec ?? null;
      const tickets = workflow?.tickets ?? [];
      if (spec === null || workflow === null || workflow === undefined) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Planning Thread '${planningThread.id}' does not have a Spec to review.`,
        });
      }
      if (spec.id !== command.specId) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Planning ticket review requested Spec '${command.specId}', expected '${spec.id}'.`,
        });
      }
      if (tickets.length === 0) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Planning Spec '${spec.id}' has no Planning Tickets to review.`,
        });
      }
      const validationError = validatePlanningTicketGraph(spec.id, tickets);
      if (validationError !== null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: validationError,
        });
      }
      if (workflow.activeReview != null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Planning review cycle ${workflow.activeReview.cycleNumber} is already active.`,
        });
      }
      const reviewRequest = nextPlanningReviewRequest(workflow);
      if (reviewRequest.cycleNumber > PLANNING_REVIEW_MAX_CYCLES) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Planning ticket review is limited to ${PLANNING_REVIEW_MAX_CYCLES} cycles.`,
        });
      }
      const crypto = yield* Crypto.Crypto;
      const reviewerThreadUuid = yield* crypto.randomUUIDv4;
      const reviewerMessageUuid = yield* crypto.randomUUIDv4;
      const reviewerThreadId = ThreadId.make(`thread-planning-reviewer-${reviewerThreadUuid}`);
      const reviewerMessageId = MessageId.make(`message-planning-reviewer-${reviewerMessageUuid}`);
      const { cycleNumber, mode, targetPlanningTicketIds, previousCycle } = reviewRequest;
      const cycleBudget = resolveWorkflowStepCycleBudget({
        key: { workflowPromptId: WORKFLOW_PROMPT_IDS.planningTicketReviewerCodex },
        threadOverrides: planningThread.workflowStepCycles,
      });
      if (targetPlanningTicketIds.length === 0) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Planning ticket review has no remaining tickets that require review.",
        });
      }
      const requestEvent: PlannedOrchestrationEvent = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: planningThread.id,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.planning-ticket-review-requested",
        payload: {
          threadId: planningThread.id,
          specId: spec.id,
          cycleNumber,
          mode,
          targetPlanningTicketIds,
          reviewerThreadId,
          reviewerMessageId,
          stage: "ticket-review",
          requestedAt: command.createdAt,
        },
      };
      const reviewerThreadCreatedEvent: PlannedOrchestrationEvent = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: reviewerThreadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        causationEventId: requestEvent.eventId,
        type: "thread.created",
        payload: {
          threadId: reviewerThreadId,
          projectId: planningThread.projectId,
          ownerUserId: planningThread.ownerUserId,
          parentThreadId: planningThread.id,
          workflowRole: "planning-reviewer",
          workflowContext: {
            ...(planningThread.workflowContext ?? {
              workflowId: spec.workflowId,
              parentWorkflowId: null,
              rootThreadId: planningThread.id,
              ticketScope: [],
            }),
            ticketScope: targetPlanningTicketIds,
          },
          title: `Review ${spec.title} · Cycle ${cycleNumber} of ${cycleBudget}`,
          modelSelection: planningThread.modelSelection,
          runtimeMode: WORKFLOW_AUTOMATION_RUNTIME_MODE,
          interactionMode: planningThread.interactionMode,
          branch: planningThread.branch,
          worktreePath: planningThread.worktreePath,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
      const reviewerPromptEvent: PlannedOrchestrationEvent = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: reviewerThreadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        causationEventId: reviewerThreadCreatedEvent.eventId,
        type: "thread.message-sent",
        payload: {
          threadId: reviewerThreadId,
          messageId: reviewerMessageId,
          role: "user",
          text: buildPlanningReviewerPrompt({
            spec,
            tickets,
            cycleNumber,
            mode,
            targetPlanningTicketIds,
            previousCycle,
          }),
          turnId: null,
          streaming: false,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
      const reviewerTurnStartRequestedEvent: PlannedOrchestrationEvent = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: reviewerThreadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        causationEventId: reviewerPromptEvent.eventId,
        type: "thread.turn-start-requested",
        payload: {
          threadId: reviewerThreadId,
          messageId: reviewerMessageId,
          modelSelection: planningThread.modelSelection,
          runtimeMode: WORKFLOW_AUTOMATION_RUNTIME_MODE,
          interactionMode: planningThread.interactionMode,
          workflowPromptId: WORKFLOW_PROMPT_IDS.planningTicketReviewerCodex,
          createdAt: command.createdAt,
        },
      };
      return [
        requestEvent,
        reviewerThreadCreatedEvent,
        reviewerPromptEvent,
        reviewerTurnStartRequestedEvent,
      ];
    }

    case "thread.planning-reviewer-verdict.apply": {
      const planningThread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const workflow = planningThread.planningWorkflow;
      const spec = workflow?.spec ?? null;
      if (workflow === null || workflow === undefined || spec === null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Planning Thread '${planningThread.id}' does not have a Spec to review.`,
        });
      }
      const activeReview = workflow.activeReview;
      if (activeReview == null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Planning reviewer verdict does not match an active review request.",
        });
      }
      if (activeReview.reviewerThreadId !== command.reviewerThreadId) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Reviewer thread '${command.reviewerThreadId}' is not assigned to cycle ${activeReview.cycleNumber}.`,
        });
      }
      if (command.cycleNumber !== undefined && command.cycleNumber !== activeReview.cycleNumber) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Reviewer verdict cycle ${command.cycleNumber} does not match active cycle ${activeReview.cycleNumber}.`,
        });
      }
      if (command.mode !== undefined && command.mode !== activeReview.mode) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Reviewer verdict mode '${command.mode}' does not match active mode '${activeReview.mode}'.`,
        });
      }
      if (
        command.targetPlanningTicketIds !== undefined &&
        !hasSameUniqueValues(command.targetPlanningTicketIds, activeReview.targetPlanningTicketIds)
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Reviewer verdict targets do not match the active review target set.",
        });
      }
      const edits = command.ticketEdits ?? [];
      const failingPlanningTicketIds = command.failingPlanningTicketIds ?? [];
      const activeTargetIds = new Set(activeReview.targetPlanningTicketIds);
      if (new Set(failingPlanningTicketIds).size !== failingPlanningTicketIds.length) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Reviewer verdict contains duplicate failing Planning Ticket ids.",
        });
      }
      const outOfScopeFailingTicketId = failingPlanningTicketIds.find(
        (ticketId) => !activeTargetIds.has(ticketId),
      );
      if (outOfScopeFailingTicketId !== undefined) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Reviewer verdict marks non-target Planning Ticket '${outOfScopeFailingTicketId}' as failing.`,
        });
      }
      const inferredPassed =
        command.passed ??
        !/\b(fail|failed|failing|blocker|blocked)\b/i.test(command.verdictMarkdown);
      if (
        command.runtimeFailure !== true &&
        !inferredPassed &&
        failingPlanningTicketIds.length === 0 &&
        edits.length === 0
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "A failed reviewer verdict must identify a failing or reworked Planning Ticket.",
        });
      }
      if (
        command.runtimeFailure !== true &&
        inferredPassed &&
        failingPlanningTicketIds.length > 0
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "A passing reviewer verdict cannot contain failing Planning Ticket ids.",
        });
      }
      const crypto = yield* Crypto.Crypto;
      const generatedTicketIds = yield* Effect.forEach(edits, (edit) =>
        edit.type === "create"
          ? crypto.randomUUIDv4.pipe(Effect.map((uuid) => `planning-ticket-${uuid}`))
          : Effect.succeed(""),
      );
      const editedTickets = applyPlanningReviewerEdits({
        specId: spec.id,
        tickets: workflow.tickets,
        edits,
        targetPlanningTicketIds: activeReview.targetPlanningTicketIds,
        mode: activeReview.mode,
        generatedTicketIds,
        updatedAt: command.createdAt,
      });
      if (typeof editedTickets === "string") {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: editedTickets,
        });
      }
      const graphError = validatePlanningTicketGraph(spec.id, editedTickets);
      if (graphError !== null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: graphError,
        });
      }
      const editedPlanningTicketIds = edits.flatMap((edit, index) => {
        if (edit.type === "create") {
          const generatedId = generatedTicketIds[index];
          return generatedId === undefined || generatedId.length === 0
            ? [...edit.replacesPlanningTicketIds]
            : [generatedId, ...edit.replacesPlanningTicketIds];
        }
        return [edit.ticketId];
      });
      // The reviewer's own corrections are the review, not work awaiting one: a cycle that passes
      // every target ticket ends ticket review whether or not it edited them on the way.
      const passed = inferredPassed;
      const cycleNumber = activeReview.cycleNumber;
      const status = command.runtimeFailure
        ? ("runtime-failed" as const)
        : edits.length > 0
          ? ("revised" as const)
          : passed
            ? ("passed" as const)
            : ("failed" as const);
      const remainingTargetPlanningTicketIds = failingPlanningTicketIds.filter((ticketId) =>
        editedTickets.some((ticket) => ticket.id === ticketId),
      );
      const reviewCompleted =
        command.runtimeFailure !== true &&
        (passed || remainingTargetPlanningTicketIds.length === 0);
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: planningThread.id,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.planning-tickets-revised",
        payload: {
          threadId: planningThread.id,
          specId: spec.id,
          reviewCycle: {
            cycleNumber,
            mode: activeReview.mode,
            status,
            reviewerThreadId: command.reviewerThreadId,
            reviewerMessageId: command.reviewerMessageId,
            verdictMarkdown: command.verdictMarkdown,
            failingPlanningTicketIds,
            targetPlanningTicketIds: activeReview.targetPlanningTicketIds,
            editedPlanningTicketIds,
            dependencyFeedback: command.dependencyFeedback ?? [],
            perTicketFeedback: command.perTicketFeedback ?? [],
            createdAt: command.createdAt,
          },
          tickets: editedTickets,
          stage: reviewCompleted ? "completed" : "ticket-review",
          revisedAt: command.createdAt,
        },
      };
    }

    case "thread.planning-spec-bundle.load": {
      const targetThread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const embeddedBundle =
        command.bundle === undefined
          ? null
          : ({
              spec: {
                ...command.bundle.spec,
                ticketCount: command.bundle.tickets.length,
              },
              tickets: command.bundle.tickets,
              reviewCycles: command.bundle.reviewCycles,
              sourceThread: null,
            } satisfies OrchestrationPlanningSpecBundle & {
              readonly sourceThread: OrchestrationReadModel["threads"][number] | null;
            });
      const bundle = embeddedBundle ?? findPlanningBundleBySpecId(readModel, command.specId);
      if (bundle === null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Planning Spec '${command.specId}' is not visible to this environment.`,
        });
      }
      if (!optionalScopeMatches(command.tenantId, bundle.spec.tenantId)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Planning Spec '${command.specId}' is not in tenant '${command.tenantId}'.`,
        });
      }
      if (!optionalScopeMatches(command.teamId, bundle.spec.teamId)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Planning Spec '${command.specId}' is not in team '${command.teamId}'.`,
        });
      }
      if (
        bundle.sourceThread !== null &&
        bundle.sourceThread.projectId !== targetThread.projectId
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Planning Spec '${command.specId}' belongs to a different project.`,
        });
      }
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.planning-spec-bundle-loaded",
        payload: {
          threadId: command.threadId,
          specId: bundle.spec.id,
          sourceThreadId: bundle.spec.sourceThreadId,
          bundle: {
            spec: bundle.spec,
            tickets: [...bundle.tickets],
            reviewCycles: [...bundle.reviewCycles],
          },
          loadedAt: command.createdAt,
        },
      };
    }

    case "thread.fast-feature-run.launch": {
      const sourceThread = yield* requireThread({ readModel, command, threadId: command.threadId });
      if (
        sourceThread.workflowPreset !== "fast-feature" &&
        sourceThread.workflowPreset !== "quick-plan" &&
        sourceThread.workflowPreset !== "fast-plan"
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Thread '${sourceThread.id}' does not have the fast-feature workflow preset.`,
        });
      }
      if (sourceThread.branch === null || sourceThread.branch.trim().length === 0) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Fast feature launch requires a named source branch.",
        });
      }
      const plan = sourceThread.proposedPlans.find(
        (candidate) => candidate.id === command.proposedPlanId,
      );
      if (!plan || plan.implementedAt !== null || plan.planMarkdown.trim().length === 0) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Proposed Plan '${command.proposedPlanId}' is not actionable.`,
        });
      }
      const duplicate = readModel.implementationRuns.find(
        (run) =>
          run.artifactSource === "proposed-plan" &&
          run.sourceProposedPlan?.threadId === sourceThread.id &&
          run.sourceProposedPlan.planId === plan.id &&
          run.status !== "canceled",
      );
      if (duplicate) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Fast feature run '${duplicate.id}' already launched this proposed plan.`,
        });
      }
      if (
        !command.baseBranch ||
        !command.pinnedCommit ||
        !command.orchestratorBranch ||
        !command.orchestratorWorktreePath
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail:
            "Fast feature launch requires server-resolved branch, commit, and worktree identity.",
        });
      }
      const crypto = yield* Crypto.Crypto;
      const runUuid = yield* crypto.randomUUIDv4;
      const threadUuid = yield* crypto.randomUUIDv4;
      const orchestratorThreadId = ThreadId.make(`thread-fast-feature-implementer-${threadUuid}`);
      const validationCommands = resolveImplementationValidationCommands({
        explicitCommands: command.validationCommands,
      });
      const run: OrchestrationImplementationRun = {
        id: `implementation-run-${runUuid}`,
        skips: command.skips ?? [],
        artifactSource: "proposed-plan",
        specId: null,
        sourceProposedPlan: { threadId: sourceThread.id, planId: plan.id },
        planningTicketIds: [],
        orchestratorThreadId,
        status: "launch-pending",
        baseBranch: command.baseBranch,
        pinnedCommit: command.pinnedCommit,
        orchestratorBranch: command.orchestratorBranch,
        orchestratorWorktreePath: command.orchestratorWorktreePath,
        launchSummary: {
          specId: null,
          planningTicketIds: [],
          baseBranch: command.baseBranch,
          pinnedCommit: command.pinnedCommit,
          orchestratorBranch: command.orchestratorBranch,
          orchestratorWorktreePath: command.orchestratorWorktreePath,
          dependencyEdges: [],
          initialReadyTicketIds: [],
          plannedWorkers: [],
          validationCommands,
          finalAppReview: {
            required: true,
            completionBlocking: true,
            appDevStackSource: "orchestrator-worktree",
            autoStartAppDevStack: true,
            browserMcpProfile: "agent-browser",
            maxCycles: IMPLEMENTATION_RUN_MAX_QA_REPAIRS,
          },
          createdAt: command.createdAt,
        },
        ticketStates: [],
        workerResults: [],
        terminalLineageTicketIds: [],
        integrationHeadSha: null,
        finalValidation: null,
        finalValidationResults: [],
        validatedHeadSha: null,
        activeValidationHeadSha: null,
        activeValidationKind: null,
        activeValidatorThreadId: null,
        mergeGateAttemptCount: 0,
        appDevStack: {
          status: "not-requested",
          stackId: null,
          stackStatus: null,
          frontendUrl: null,
          frontendServiceName: null,
          displayName: null,
          lastErrorMarkdown: null,
          requestedAt: "",
          updatedAt: "",
        },
        qaTooling: {
          status: "unknown",
          agentBrowserPackage: "agent-browser@0.31.1",
          lastErrorMarkdown: null,
          checkedAt: "",
        },
        appReviewIds: [],
        appReviewStrategy: "nested-workflow",
        appReviewWorkflowRunIds: [],
        latestAppReviewWorkflowOutcome: null,
        appReviewUnblockAttemptCount: 0,
        appReviews: [],
        appReviewedHeadSha: null,
        activeAppReviewHeadSha: null,
        activeAppReviewThreadId: null,
        qaCycleCount: 0,
        qaAttemptCount: 0,
        qaExhaustedAt: null,
        qaExhaustionReason: null,
        lastQaFailure: null,
        appReviewExhaustedAt: null,
        codeReviewedHeadSha: null,
        activeCodeReviewHeadSha: null,
        activeCodeReviewThreadId: null,
        activeChangeRequestBabysitterThreadId: null,
        codeReviewAttemptCount: 0,
        finalCodeReviewGeneration: 0,
        finalCodeReviewLaunchCount: 0,
        finalCodeReviewPassCount: 0,
        codeReviewExhaustedAt: null,
        codeReviewExhaustionReason: null,
        reviewGateExhaustedAt: null,
        reviewGateExhaustionReason: null,
        activeFixerThreadId: null,
        fixOrigin: null,
        latestCodeReviewReportMarkdown: null,
        handoffTarget: "orchestrator-worktree",
        baseBranchMergePolicy: "never-auto-merge",
        changeRequest: null,
        changeRequestFailure: null,
        changeRequestPublisherUserId: sourceThread.ownerUserId,
        fastBuildResult: null,
        stageExecutions: [],
        validationJobs: [],
        retryableFailure: null,
        automationHalt: null,
        createdAt: command.createdAt,
        updatedAt: command.createdAt,
      };
      const threadCreated: PlannedOrchestrationEvent = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: orchestratorThreadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.created",
        payload: {
          threadId: orchestratorThreadId,
          projectId: sourceThread.projectId,
          ownerUserId: sourceThread.ownerUserId,
          parentThreadId: sourceThread.id,
          workflowRole: "fast-feature-implementer",
          workflowPreset: sourceThread.workflowPreset,
          workflowContext: sourceThread.workflowContext ?? null,
          title: buildPlanImplementationThreadTitle(plan.planMarkdown),
          modelSelection: sourceThread.modelSelection,
          runtimeMode: WORKFLOW_AUTOMATION_RUNTIME_MODE,
          interactionMode: "default",
          branch: command.orchestratorBranch,
          worktreePath: command.orchestratorWorktreePath,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
      const launched: PlannedOrchestrationEvent = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: orchestratorThreadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        causationEventId: threadCreated.eventId,
        type: "thread.implementation-run-launched",
        payload: { sourceThreadId: sourceThread.id, run },
      };
      return [threadCreated, launched];
    }

    case "thread.implementation-run.launch": {
      const launcherThread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const bundle = findPlanningBundleBySpecId(readModel, command.specId);
      if (bundle === null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Planning Spec '${command.specId}' is not visible to this environment.`,
        });
      }
      if (bundle.tickets.length === 0) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Planning Spec '${command.specId}' has no Planning Tickets to implement.`,
        });
      }
      if (
        bundle.sourceThread !== null &&
        bundle.sourceThread.projectId !== launcherThread.projectId
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Planning Spec '${command.specId}' belongs to a different project.`,
        });
      }
      const duplicateRun = readModel.implementationRuns.find(
        (run) =>
          run.specId === command.specId &&
          run.orchestratorBranch === command.orchestratorBranch &&
          run.status !== "canceled",
      );
      if (duplicateRun !== undefined) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Implementation Run '${duplicateRun.id}' already uses orchestrator branch '${command.orchestratorBranch}' for Spec '${command.specId}'.`,
        });
      }
      const crypto = yield* Crypto.Crypto;
      const runUuid = yield* crypto.randomUUIDv4;
      const orchestratorThreadUuid = yield* crypto.randomUUIDv4;
      const orchestratorThreadId = ThreadId.make(
        `thread-implementation-orchestrator-${orchestratorThreadUuid}`,
      );
      const run = buildImplementationRun({
        runId: `implementation-run-${runUuid}`,
        orchestratorThreadId,
        command,
        tickets: bundle.tickets,
        publisherUserId: launcherThread.ownerUserId,
      });
      const orchestratorThreadCreatedEvent: PlannedOrchestrationEvent = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: orchestratorThreadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.created",
        payload: {
          threadId: orchestratorThreadId,
          projectId: launcherThread.projectId,
          ownerUserId: launcherThread.ownerUserId,
          parentThreadId: launcherThread.id,
          workflowRole: "implementation-orchestrator",
          workflowContext: {
            workflowId: WorkflowId.make(run.id),
            parentWorkflowId: launcherThread.workflowContext?.workflowId ?? null,
            rootThreadId: launcherThread.workflowContext?.rootThreadId ?? launcherThread.id,
            ticketScope: bundle.tickets.map((ticket) => ticket.id),
          },
          title: `Implement ${bundle.spec.title}`,
          modelSelection: launcherThread.modelSelection,
          runtimeMode: WORKFLOW_AUTOMATION_RUNTIME_MODE,
          interactionMode: "implementation-workflow",
          branch: command.orchestratorBranch,
          worktreePath: command.orchestratorWorktreePath,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
      const bundleLoadedEvent: PlannedOrchestrationEvent = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: orchestratorThreadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        causationEventId: orchestratorThreadCreatedEvent.eventId,
        type: "thread.planning-spec-bundle-loaded",
        payload: {
          threadId: orchestratorThreadId,
          specId: bundle.spec.id,
          sourceThreadId: bundle.spec.sourceThreadId,
          bundle: {
            spec: bundle.spec,
            tickets: [...bundle.tickets],
            reviewCycles: [...bundle.reviewCycles],
          },
          loadedAt: command.createdAt,
        },
      };
      const runLaunchedEvent: PlannedOrchestrationEvent = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: orchestratorThreadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        causationEventId: bundleLoadedEvent.eventId,
        type: "thread.implementation-run-launched",
        payload: {
          sourceThreadId: launcherThread.id,
          run,
        },
      };
      return [orchestratorThreadCreatedEvent, bundleLoadedEvent, runLaunchedEvent];
    }

    case "thread.implementation-run.update": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const existingRun = readModel.implementationRuns.find((run) => run.id === command.run.id);
      if (existingRun === undefined) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Implementation Run '${command.run.id}' does not exist.`,
        });
      }
      if (command.expectedStageExecutionTransition !== undefined) {
        const expected = command.expectedStageExecutionTransition;
        const executions = [
          ...existingRun.stageExecutions,
          ...existingRun.ticketStates.flatMap((ticket) => ticket.stageExecutions),
        ];
        const existingExecution = executions.find(
          (execution) => execution.executionId === expected.executionId,
        );
        const targetMatches =
          existingExecution !== undefined &&
          workflowStageTargetKey(existingExecution.target) ===
            workflowStageTargetKey(expected.target);
        if (
          !targetMatches ||
          existingExecution.generation !== expected.generation ||
          existingExecution.state !== expected.priorState ||
          existingExecution.leaseExpiresAt !== expected.priorLeaseExpiresAt
        ) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `Implementation Run '${command.run.id}' stage execution transition is stale.`,
          });
        }
        const nextExecutions = [
          ...command.run.stageExecutions,
          ...command.run.ticketStates.flatMap((ticket) => ticket.stageExecutions),
        ];
        const nextExecution = nextExecutions.find(
          (execution) => execution.executionId === expected.executionId,
        );
        if (
          nextExecution === undefined ||
          nextExecution.generation !== expected.generation ||
          workflowStageTargetKey(nextExecution.target) !== workflowStageTargetKey(expected.target)
        ) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `Implementation Run '${command.run.id}' stage execution transition is invalid.`,
          });
        }
      }
      for (const nextState of command.run.ticketStates) {
        const existingState = existingRun.ticketStates.find(
          (state) => state.ticketId === nextState.ticketId,
        );
        if (existingState === undefined) continue;
        for (const [claimName, existingClaim, nextClaim] of [
          ["Implementation", existingState.workerThreadId, nextState.workerThreadId],
          ["App Review", existingState.appReviewWorkflowRunId, nextState.appReviewWorkflowRunId],
          ["Code Review", existingState.codeReviewThreadId, nextState.codeReviewThreadId],
        ] as const) {
          if (nextClaim != null && existingClaim != null && nextClaim !== existingClaim) {
            return yield* new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: `Ticket '${nextState.ticketId}' ${claimName} claim is stale.`,
            });
          }
          if (
            claimName === "Implementation" &&
            existingClaim != null &&
            nextClaim == null &&
            command.run.status !== "canceled" &&
            (nextState.status === "ready" || nextState.status === "running")
          ) {
            const generationAdvanced =
              nextState.implementationGeneration > existingState.implementationGeneration;
            const resultPersisted =
              readModel.threads
                .find((thread) => thread.id === existingClaim)
                ?.activities.some(
                  (activity) => activity.kind === "implementation-worker-result",
                ) === true;
            if (!generationAdvanced && !resultPersisted) {
              return yield* new OrchestrationCommandInvariantError({
                commandType: command.type,
                detail: `Ticket '${nextState.ticketId}' ${claimName} claim cannot clear before its terminal result is persisted.`,
              });
            }
          }
        }
      }
      const claimedTicketStages = new Set<string>();
      for (const claim of command.expectedTicketStageClaims ?? []) {
        const claimKey = `${claim.ticketId}\0${claim.stage}`;
        if (claimedTicketStages.has(claimKey)) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `Ticket '${claim.ticketId}' ${claim.stage} claim is duplicated.`,
          });
        }
        claimedTicketStages.add(claimKey);
        const existingState = existingRun.ticketStates.find(
          (state) => state.ticketId === claim.ticketId,
        );
        const nextState = command.run.ticketStates.find(
          (state) => state.ticketId === claim.ticketId,
        );
        if (existingState === undefined || nextState === undefined) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `Ticket '${claim.ticketId}' stage claim references a missing ticket.`,
          });
        }
        const existingGeneration =
          claim.stage === "implementation"
            ? existingState.implementationGeneration
            : claim.stage === "app-review"
              ? existingState.appReviewGeneration
              : existingState.codeReviewGeneration;
        const nextGeneration =
          claim.stage === "implementation"
            ? nextState.implementationGeneration
            : claim.stage === "app-review"
              ? nextState.appReviewGeneration
              : nextState.codeReviewGeneration;
        const existingLaunchCount =
          claim.stage === "implementation"
            ? existingState.attemptCount
            : claim.stage === "app-review"
              ? existingState.appReviewLaunchCount
              : existingState.codeReviewLaunchCount;
        const nextLaunchCount =
          claim.stage === "implementation"
            ? nextState.attemptCount
            : claim.stage === "app-review"
              ? nextState.appReviewLaunchCount
              : nextState.codeReviewLaunchCount;
        const existingExecutionId =
          claim.stage === "implementation"
            ? existingState.workerThreadId
            : claim.stage === "app-review"
              ? existingState.appReviewWorkflowRunId
              : existingState.codeReviewThreadId;
        const nextExecutionId =
          claim.stage === "implementation"
            ? nextState.workerThreadId
            : claim.stage === "app-review"
              ? nextState.appReviewWorkflowRunId
              : nextState.codeReviewThreadId;
        if (
          existingRun.status === "canceled" ||
          existingRun.automationHalt !== null ||
          existingGeneration !== claim.generation ||
          existingLaunchCount !== claim.launchCount ||
          (existingExecutionId ?? null) !== claim.activeExecutionId
        ) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `Ticket '${claim.ticketId}' ${claim.stage} claim is stale.`,
          });
        }
        if (
          nextGeneration !== claim.generation ||
          nextLaunchCount !== claim.launchCount + 1 ||
          nextLaunchCount > IMPLEMENTATION_STAGE_MAX_LAUNCHES ||
          nextExecutionId == null
        ) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `Ticket '${claim.ticketId}' ${claim.stage} claim has an invalid transition.`,
          });
        }
      }
      if (
        command.expectedCodeReviewClaim !== undefined &&
        (existingRun.status === "canceled" ||
          existingRun.automationHalt !== null ||
          existingRun.codeReviewAttemptCount !== command.expectedCodeReviewClaim.attemptCount ||
          existingRun.activeCodeReviewThreadId !== command.expectedCodeReviewClaim.activeThreadId ||
          (command.expectedCodeReviewClaim.generation !== undefined &&
            existingRun.finalCodeReviewGeneration !== command.expectedCodeReviewClaim.generation) ||
          (command.expectedCodeReviewClaim.launchCount !== undefined &&
            existingRun.finalCodeReviewLaunchCount !== command.expectedCodeReviewClaim.launchCount))
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Implementation Run '${command.run.id}' Code Review claim is stale.`,
        });
      }
      if (
        command.expectedCodeReviewClaim !== undefined &&
        (command.run.status !== "code-reviewing" ||
          command.run.activeCodeReviewThreadId === null ||
          command.run.codeReviewAttemptCount !== command.expectedCodeReviewClaim.attemptCount + 1 ||
          (command.expectedCodeReviewClaim.generation !== undefined &&
            command.run.finalCodeReviewGeneration !== command.expectedCodeReviewClaim.generation) ||
          (command.expectedCodeReviewClaim.launchCount !== undefined &&
            (command.run.finalCodeReviewLaunchCount !==
              command.expectedCodeReviewClaim.launchCount + 1 ||
              command.run.finalCodeReviewLaunchCount > IMPLEMENTATION_STAGE_MAX_LAUNCHES)))
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Implementation Run '${command.run.id}' Code Review claim has an invalid transition.`,
        });
      }
      if (
        command.expectedChangeRequestClaim !== undefined &&
        (existingRun.status !== command.expectedChangeRequestClaim.status ||
          existingRun.changeRequest?.number !==
            (command.expectedChangeRequestClaim.changeRequestNumber ?? undefined) ||
          existingRun.activeChangeRequestBabysitterThreadId !==
            command.expectedChangeRequestClaim.activeBabysitterThreadId)
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Implementation Run '${command.run.id}' change request claim is stale.`,
        });
      }
      if (
        (command.run.artifactSource === "planning-spec" &&
          (command.run.specId === null || command.run.sourceProposedPlan !== null)) ||
        (command.run.artifactSource === "proposed-plan" &&
          (command.run.specId !== null || command.run.sourceProposedPlan === null))
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail:
            "Implementation Run artifact source must reference exactly one Planning Spec or proposed plan.",
        });
      }
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.implementation-run-updated",
        payload: {
          sourceThreadId: command.threadId,
          run: command.run,
        },
      };
    }

    case "thread.implementation-change-request.retry": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const existingRun = readModel.implementationRuns.find((run) => run.id === command.runId);
      if (existingRun === undefined) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Implementation Run '${command.runId}' does not exist.`,
        });
      }
      const run: OrchestrationImplementationRun = {
        ...existingRun,
        status: "running",
        changeRequestFailure: null,
        updatedAt: command.createdAt,
      };
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.implementation-change-request-retry-requested",
        payload: { run },
      };
    }

    case "thread.implementation-run.retry": {
      yield* requireThread({ readModel, command, threadId: command.threadId });
      const existingRun = readModel.implementationRuns.find((run) => run.id === command.runId);
      if (!existingRun || existingRun.retryableFailure === null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Implementation Run '${command.runId}' does not have a retryable failure.`,
        });
      }
      const failure = existingRun.retryableFailure;
      const queuedStates = new Set(["queued", "starting"]);
      const queuedRunStage =
        failure.ticketId === undefined
          ? failure.stage === "worktree-setup" || failure.stage === "source-dirty"
            ? "integration"
            : failure.stage === "merge-gate" ||
                failure.stage === "integration" ||
                failure.stage === "app-review" ||
                failure.stage === "code-review"
              ? failure.stage
              : null
          : null;
      const stageAlreadyQueued =
        queuedRunStage !== null &&
        existingRun.stageExecutions.some(
          (execution) =>
            queuedStates.has(execution.state) &&
            execution.target.kind === "run" &&
            execution.target.stage === queuedRunStage,
        );
      if (stageAlreadyQueued) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Implementation Run '${command.runId}' already has a stage queued or starting.`,
        });
      }
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.implementation-run-retry-requested",
        payload: { run: existingRun },
      };
    }

    case "thread.implementation-run.rerun": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const existingRun = readModel.implementationRuns.find((run) => run.id === command.runId);
      if (existingRun === undefined) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Implementation Run '${command.runId}' does not exist.`,
        });
      }
      const target = normalizeImplementationRerunTargetForHalt(existingRun, command.target);
      if (
        existingRun.status === "canceled" &&
        !canRerunCanceledFinalCodeReview({ run: existingRun, target })
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Implementation Run '${command.runId}' was canceled before it preserved an integrated final Code Review state.`,
        });
      }
      if (
        isWorkflowThreadPaused(readModel.threads, command.threadId) ||
        isWorkflowThreadPaused(readModel.threads, existingRun.orchestratorThreadId)
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Implementation Run '${command.runId}' is paused. Resume the workflow before starting a stage again.`,
        });
      }
      if (
        target.kind === "ticket" &&
        !existingRun.ticketStates.some((state) => state.ticketId === target.ticketId)
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Ticket '${target.ticketId}' is not part of Implementation Run '${command.runId}'.`,
        });
      }
      // Refuse while the stage is live. Two agents on one branch is how a
      // worktree ends up with two writers and a review that cannot name HEAD.
      const liveThreadId = liveRerunTargetThreadId({
        readModel,
        run: existingRun,
        target,
        nowMs: Date.parse(command.createdAt),
      });
      if (liveThreadId !== null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Thread '${liveThreadId}' is still running this stage. Stop it before starting the stage again.`,
        });
      }
      const stepPin = rerunTargetStepPin(target);
      if (command.modelSelection !== undefined && stepPin === null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Integration merges branches without an agent, so it takes no model.",
        });
      }
      const occurredAt = command.createdAt;
      const queued = queueImplementationRerun({
        run: existingRun,
        target,
        executionId: `workflow-execution-${command.commandId}`,
        createdAt: occurredAt,
      });
      const rerunEvent = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.implementation-run-rerun-requested" as const,
        payload: { run: queued.run, target },
      };
      if (command.modelSelection === undefined || stepPin === null) return rerunEvent;
      // Pins live on the workflow root, same as the Workflows panel writes them.
      const rootThreadId = thread.workflowContext?.rootThreadId ?? thread.id;
      const rootThread =
        readModel.threads.find((candidate) => candidate.id === rootThreadId) ?? thread;
      const modelSelection = command.modelSelection;
      return [
        {
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: rootThread.id,
            occurredAt,
            commandId: command.commandId,
          })),
          type: "thread.workflow-step-model-set",
          payload: {
            threadId: rootThread.id,
            workflowPromptId: stepPin.workflowPromptId,
            ...(stepPin.stepWorkflowPromptId === undefined
              ? {}
              : { stepWorkflowPromptId: stepPin.stepWorkflowPromptId }),
            modelSelection,
            updatedAt: occurredAt,
          },
        },
        rerunEvent,
      ];
    }

    case "thread.implementation-run.reset": {
      yield* requireThread({ readModel, command, threadId: command.threadId });
      const existingRun = readModel.implementationRuns.find((run) => run.id === command.runId);
      if (existingRun === undefined) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Implementation Run '${command.runId}' does not exist.`,
        });
      }
      if (existingRun.status === "canceled") {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Implementation Run '${command.runId}' was canceled.`,
        });
      }
      const target = command.target;
      if (
        target.kind === "ticket" &&
        !existingRun.ticketStates.some((state) => state.ticketId === target.ticketId)
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Ticket '${target.ticketId}' is not part of Implementation Run '${command.runId}'.`,
        });
      }
      // Clearing a stage out from under its own agent would leave that agent
      // writing results the run no longer expects, exactly as a re-run would.
      const liveThreadId = liveRerunTargetThreadId({
        readModel,
        run: existingRun,
        target,
        nowMs: Date.parse(command.createdAt),
      });
      if (liveThreadId !== null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Thread '${liveThreadId}' is still running this stage. Stop it before clearing the stage.`,
        });
      }
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.implementation-run-reset-requested" as const,
        payload: { run: existingRun, target },
      };
    }

    case "thread.implementation-run.skip": {
      yield* requireThread({ readModel, command, threadId: command.threadId });
      const existingRun = readModel.implementationRuns.find((run) => run.id === command.runId);
      if (existingRun === undefined) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Implementation Run '${command.runId}' does not exist.`,
        });
      }
      if (existingRun.status === "canceled") {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Implementation Run '${command.runId}' was canceled.`,
        });
      }
      const target = command.target;
      if (
        target.kind === "ticket" &&
        !existingRun.ticketStates.some((state) => state.ticketId === target.ticketId)
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Ticket '${target.ticketId}' is not part of Implementation Run '${command.runId}'.`,
        });
      }
      // A skip is a standing decision, so it is allowed to land on a stage that
      // is running. Stopping that stage is the caller's move, and the run reads
      // the skip the next time it would start the stage.
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.implementation-run-skip-set" as const,
        payload: { run: existingRun, target, skipped: command.skipped },
      };
    }

    case "thread.implementation-run.cancel": {
      yield* requireThread({ readModel, command, threadId: command.threadId });
      const existingRun = readModel.implementationRuns.find((run) => run.id === command.runId);
      if (existingRun === undefined) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Implementation Run '${command.runId}' does not exist.`,
        });
      }
      if (existingRun.status === "completed" || existingRun.status === "canceled") {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Implementation Run '${command.runId}' has already reached status '${existingRun.status}'.`,
        });
      }
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.implementation-run-cancel-requested",
        payload: {
          sourceThreadId: command.threadId,
          run: {
            ...existingRun,
            status: "canceled",
            retryableFailure: null,
            updatedAt: command.createdAt,
          },
          ...(command.reason !== undefined ? { reason: command.reason } : {}),
        },
      };
    }

    case "thread.app-review-workflow.launch": {
      const targetThread = yield* requireThread({
        readModel,
        command,
        threadId: command.targetThreadId,
      });
      const targetProject = readModel.projects.find(
        (project) => project.id === targetThread.projectId,
      );
      const targetPath = targetThread.worktreePath ?? targetProject?.workspaceRoot ?? null;
      if (targetPath === null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "App Review requires a prepared worktree.",
        });
      }
      const canonicalTargetPath = normalizeProjectPathForComparison(targetPath);
      if (
        command.caller.type === "standalone" &&
        (targetThread.latestTurn?.state === "running" ||
          targetThread.session?.status === "starting" ||
          targetThread.session?.status === "running" ||
          hasOpenBlockingRequest(targetThread) ||
          threadHasQueuedTurnStart(targetThread, command.createdAt))
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Standalone App Review requires the source turn to be settled.",
        });
      }
      if (
        command.caller.type === "standalone" &&
        command.caller.sourceThreadId !== command.targetThreadId
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Standalone App Review caller must reference the target thread.",
        });
      }
      if (command.caller.type === "implementation") {
        const caller = command.caller;
        const implementationRun = readModel.implementationRuns.find(
          (run) => run.id === caller.implementationRunId,
        );
        const ticketTargetMatches =
          caller.ticketId !== undefined &&
          implementationRun?.ticketStates.some(
            (state) =>
              state.ticketId === caller.ticketId &&
              state.workerThreadId === command.targetThreadId &&
              state.appReviewWorkflowRunId ===
                AppReviewWorkflowRunId.make(`app-review-workflow-${command.controllerThreadId}`),
          );
        if (
          implementationRun === undefined ||
          caller.orchestratorThreadId !== implementationRun.orchestratorThreadId ||
          (caller.ticketId === undefined
            ? implementationRun.orchestratorThreadId !== command.targetThreadId
            : !ticketTargetMatches)
        ) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: "Embedded App Review caller does not match an Implementation orchestrator.",
          });
        }
      }
      if (command.previewTargetsPinned === true && command.previewTargets.length === 0) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "A pinned App Review must name at least one preview target.",
        });
      }
      const duplicate = (readModel.appReviewWorkflowRuns ?? []).find((run) => {
        if (run.status !== "running") return false;
        const runTarget = readModel.threads.find((thread) => thread.id === run.targetThreadId);
        if (runTarget === undefined) return false;
        const runProject = readModel.projects.find((project) => project.id === runTarget.projectId);
        const runPath = runTarget.worktreePath ?? runProject?.workspaceRoot ?? null;
        return (
          runPath !== null && normalizeProjectPathForComparison(runPath) === canonicalTargetPath
        );
      });
      if (duplicate !== undefined) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `App Review Workflow '${duplicate.id}' already owns this worktree.`,
        });
      }
      if (command.controllerThreadId !== command.targetThreadId) {
        yield* requireThreadAbsent({
          readModel,
          command,
          threadId: command.controllerThreadId,
        });
      }
      const runId = AppReviewWorkflowRunId.make(
        `app-review-workflow-${command.controllerThreadId}`,
      );
      const run: AppReviewWorkflowRun = {
        id: runId,
        targetThreadId: command.targetThreadId,
        controllerThreadId: command.controllerThreadId,
        caller: command.caller,
        briefMarkdown: command.briefMarkdown,
        supportingContextMarkdown: command.supportingContextMarkdown ?? null,
        previewTargets: command.previewTargets,
        ...(command.previewTargetsPinned === undefined
          ? {}
          : { previewTargetsPinned: command.previewTargetsPinned }),
        ...(command.reviewOnly === undefined ? {} : { reviewOnly: command.reviewOnly }),
        ...(command.appReviewScope === undefined ? {} : { appReviewScope: command.appReviewScope }),
        // A review-only run has nothing for a second cycle to verify, so its
        // budget is one whatever the client asked for.
        cycleBudget:
          command.reviewOnly === true ? AppReviewWorkflowCycleBudget.make(1) : command.cycleBudget,
        cyclesUsed: 0,
        status: "running",
        cycles: [],
        activePhase: null,
        activeThreadId: null,
        phaseExecution: null,
        workspaceRevision: command.workspaceRevision ?? {
          headSha: "pending",
          workingTreeDiffHash: "pending",
          branchDiffHash: "pending",
          fingerprint: "pending",
        },
        finalHeadSha: null,
        outcome: null,
        failure: null,
        createdAt: command.createdAt,
        updatedAt: command.createdAt,
        completedAt: null,
      };
      const controllerCreated =
        command.controllerThreadId === command.targetThreadId
          ? null
          : ({
              ...(yield* withEventBase({
                aggregateKind: "thread",
                aggregateId: command.controllerThreadId,
                occurredAt: command.createdAt,
                commandId: command.commandId,
              })),
              type: "thread.created",
              payload: {
                threadId: command.controllerThreadId,
                projectId: targetThread.projectId,
                ownerUserId: targetThread.ownerUserId,
                parentThreadId: targetThread.id,
                workflowRole: "app-review-orchestrator",
                workflowContext: {
                  workflowId: WorkflowId.make(runId),
                  parentWorkflowId: targetThread.workflowContext?.workflowId ?? null,
                  rootThreadId: targetThread.workflowContext?.rootThreadId ?? targetThread.id,
                  ticketScope: targetThread.workflowContext?.ticketScope ?? [],
                },
                workflowPreset: "app-review",
                title: "App Review",
                modelSelection: command.modelSelection,
                runtimeMode: WORKFLOW_AUTOMATION_RUNTIME_MODE,
                interactionMode: "default",
                branch: targetThread.branch,
                worktreePath: targetThread.worktreePath,
                createdAt: command.createdAt,
                updatedAt: command.createdAt,
              },
            } satisfies Omit<OrchestrationEvent, "sequence">);
      const launched = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.controllerThreadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        ...(controllerCreated === null ? {} : { causationEventId: controllerCreated.eventId }),
        type: "thread.app-review-workflow-launched",
        payload: { sourceThreadId: command.targetThreadId, run },
      } satisfies Omit<OrchestrationEvent, "sequence">;
      return controllerCreated === null ? launched : [controllerCreated, launched];
    }

    case "thread.app-review-workflow.update": {
      yield* requireThread({ readModel, command, threadId: command.threadId });
      const existing = (readModel.appReviewWorkflowRuns ?? []).find(
        (run) => run.id === command.run.id,
      );
      if (existing === undefined || existing.controllerThreadId !== command.threadId) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `App Review Workflow '${command.run.id}' does not belong to this controller.`,
        });
      }
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.app-review-workflow-updated",
        payload: { sourceThreadId: existing.targetThreadId, run: command.run },
      };
    }

    case "thread.app-review-workflow.cancel": {
      yield* requireThread({ readModel, command, threadId: command.threadId });
      const existing = (readModel.appReviewWorkflowRuns ?? []).find(
        (run) => run.id === command.runId,
      );
      if (existing === undefined || existing.status !== "running") {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `App Review Workflow '${command.runId}' is not active.`,
        });
      }
      const run: AppReviewWorkflowRun = {
        ...existing,
        status: "failed",
        outcome: "failed",
        activePhase: null,
        activeThreadId: null,
        failure: {
          reason: "unknown",
          phase: existing.activePhase,
          cycleNumber: existing.cycles.at(-1)?.cycleNumber ?? null,
          detailMarkdown: command.reason ?? "App Review was stopped before it passed.",
          failedAt: command.createdAt,
        },
        finalHeadSha:
          existing.workspaceRevision.headSha === "pending"
            ? null
            : existing.workspaceRevision.headSha,
        updatedAt: command.createdAt,
        completedAt: command.createdAt,
      };
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: existing.controllerThreadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.app-review-workflow-cancel-requested",
        payload: {
          sourceThreadId: existing.targetThreadId,
          run,
          ...(command.reason === undefined ? {} : { reason: command.reason }),
        },
      };
    }

    case "thread.app-review-workflow.resume": {
      yield* requireThread({ readModel, command, threadId: command.threadId });
      const existing = (readModel.appReviewWorkflowRuns ?? []).find(
        (run) => run.id === command.runId,
      );
      if (
        existing === undefined ||
        existing.caller.type !== "implementation" ||
        existing.status !== "running" ||
        existing.activePhase !== null
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `App Review Workflow '${command.runId}' is not waiting for an embedded preview refresh.`,
        });
      }
      const run: AppReviewWorkflowRun = {
        ...existing,
        previewTargets: command.previewTargets,
        workspaceRevision: command.workspaceRevision,
        updatedAt: command.createdAt,
        completedAt: null,
      };
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: existing.controllerThreadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.app-review-workflow-resume-requested",
        payload: { sourceThreadId: existing.targetThreadId, run },
      };
    }

    case "thread.app-review-workflow.rerun": {
      const thread = yield* requireThread({ readModel, command, threadId: command.threadId });
      const existing = (readModel.appReviewWorkflowRuns ?? []).find(
        (run) => run.id === command.runId,
      );
      if (existing === undefined) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `App Review Workflow '${command.runId}' does not exist.`,
        });
      }
      // Every phase entry point works on the run's latest cycle, so that is the
      // one a re-run redoes. Earlier cycles are history.
      const cycle = existing.cycles.at(-1);
      if (cycle === undefined) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `App Review Workflow '${command.runId}' has not started a cycle yet.`,
        });
      }
      const liveThread = liveAppReviewPhaseThreadId({ readModel, run: existing });
      if (liveThread !== null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Thread '${liveThread}' is still running this App Review. Stop it before starting a phase again.`,
        });
      }
      // The review shares a worktree with the work that called it. If that work
      // has moved on and started an agent of its own, a repair would commit
      // underneath it.
      const liveCaller = liveAppReviewCallerThreadId({ readModel, run: existing });
      if (liveCaller !== null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Thread '${liveCaller}' is working in this App Review's worktree. Stop it before starting a phase again.`,
        });
      }
      // A redo of the browser review runs a new cycle rather than overwriting
      // the one that disappointed, so it needs budget left to run in.
      if (
        (command.phase === "e2e" || command.phase === "review") &&
        existing.cyclesUsed >= existing.cycleBudget
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `App Review Workflow '${command.runId}' has used all ${String(existing.cycleBudget)} of its cycles.`,
        });
      }
      if (command.phase === "planning" && cycle.actionableFindingsMarkdown === null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Gap analysis needs findings from the browser review of this cycle.",
        });
      }
      if (command.phase === "fixing" && existing.reviewOnly === true) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `App Review Workflow '${command.runId}' was launched to review only, so it has no repair step.`,
        });
      }
      if (command.phase === "fixing" && (cycle.repairTickets ?? []).length === 0) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "The repair step needs the repair tickets gap analysis writes.",
        });
      }
      const occurredAt = command.createdAt;
      const rerunEvent = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: existing.controllerThreadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.app-review-workflow-rerun-requested" as const,
        payload: {
          sourceThreadId: existing.targetThreadId,
          run: existing,
          phase: command.phase,
        },
      };
      if (command.modelSelection === undefined) return rerunEvent;
      const stepPin = appReviewPhaseStepPin(command.phase);
      const rootThreadId = thread.workflowContext?.rootThreadId ?? thread.id;
      const rootThread =
        readModel.threads.find((candidate) => candidate.id === rootThreadId) ?? thread;
      const modelSelection = command.modelSelection;
      return [
        {
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: rootThread.id,
            occurredAt,
            commandId: command.commandId,
          })),
          type: "thread.workflow-step-model-set",
          payload: {
            threadId: rootThread.id,
            workflowPromptId: stepPin.workflowPromptId,
            ...(stepPin.stepWorkflowPromptId === undefined
              ? {}
              : { stepWorkflowPromptId: stepPin.stepWorkflowPromptId }),
            modelSelection,
            updatedAt: occurredAt,
          },
        },
        rerunEvent,
      ];
    }

    case "thread.app-review.launch": {
      const sourceThread = yield* requireThread({
        readModel,
        command,
        threadId: command.sourceThreadId,
      });
      yield* requireWorkflowNotPaused({ readModel, command, threadId: command.sourceThreadId });
      yield* requireThreadAbsent({
        readModel,
        command,
        threadId: command.reviewThreadId,
      });
      const existingReview = readModel.threads.some((thread) =>
        thread.appReviews.some((review) => review.id === command.reviewId),
      );
      if (existingReview) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `App Review '${command.reviewId}' already exists and cannot be created twice.`,
        });
      }

      const inheritedTicketScope = sourceThread.workflowContext?.ticketScope ?? [];
      const workflowTicketScope =
        sourceThread.workflowContext == null
          ? []
          : Array.from(
              new Set(
                readModel.threads
                  .filter(
                    (thread) =>
                      thread.projectId === sourceThread.projectId &&
                      thread.workflowContext?.workflowId ===
                        sourceThread.workflowContext?.workflowId,
                  )
                  .flatMap((thread) =>
                    (thread.planningWorkflow?.tickets ?? []).map((ticket) => ticket.id),
                  ),
              ),
            );
      const planningTicketIds =
        command.planningTicketIds ??
        (inheritedTicketScope.length > 0 ? inheritedTicketScope : workflowTicketScope);
      // An App Review anchors to the Spec through its planning tickets. When
      // the source has no Spec — fast-feature runs and plan-mode threads —
      // the proposed plan itself is the review's anchor node.
      const runProposedPlan =
        readModel.implementationRuns.find(
          (run) => run.orchestratorThreadId === sourceThread.id && run.sourceProposedPlan !== null,
        )?.sourceProposedPlan ?? null;
      const threadProposedPlan =
        [...sourceThread.proposedPlans].sort((left, right) =>
          right.createdAt.localeCompare(left.createdAt),
        )[0] ?? null;
      const sourceProposedPlan =
        runProposedPlan ??
        (threadProposedPlan === null
          ? null
          : { threadId: sourceThread.id, planId: threadProposedPlan.id });
      const reviewRecord = {
        id: command.reviewId,
        sourceThreadId: command.sourceThreadId,
        reviewThreadId: command.reviewThreadId,
        ...(command.appReviewScope === undefined ? {} : { appReviewScope: command.appReviewScope }),
        planningTicketIds,
        ...(sourceProposedPlan === null ? {} : { sourceProposedPlan }),
        sourceTurnId: sourceThread.latestTurn?.turnId ?? null,
        status: "running" as const,
        document: EMPTY_APP_REVIEW_DOCUMENT,
        evidence: EMPTY_APP_REVIEW_EVIDENCE,
        createdAt: command.createdAt,
        updatedAt: command.createdAt,
      };
      const workflowReviewCycle = (readModel.appReviewWorkflowRuns ?? [])
        .flatMap((run) => run.cycles.map((cycle) => ({ run, cycle })))
        .find(
          ({ cycle }) =>
            cycle.reviewId === command.reviewId || cycle.e2eReviewId === command.reviewId,
        );
      const threadCreatedEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.reviewThreadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.created",
        payload: {
          threadId: command.reviewThreadId,
          projectId: sourceThread.projectId,
          ownerUserId: sourceThread.ownerUserId,
          parentThreadId: sourceThread.id,
          workflowRole:
            sourceThread.workflowRole === "app-review-orchestrator" ||
            sourceThread.workflowPreset === "app-review"
              ? "app-review-reviewer"
              : "implementation-qa-reviewer",
          workflowContext:
            sourceThread.workflowContext == null
              ? null
              : { ...sourceThread.workflowContext, ticketScope: planningTicketIds },
          ...(command.batchProvenance !== undefined
            ? { workflowSubagentBatchProvenance: command.batchProvenance }
            : {}),
          title:
            workflowReviewCycle === undefined
              ? command.appReviewScope === "e2e"
                ? "End-to-end test"
                : "Browser App Review"
              : command.appReviewScope === "e2e"
                ? `End-to-end test · Cycle ${workflowReviewCycle.cycle.cycleNumber} of ${workflowReviewCycle.run.cycleBudget}`
                : `Browser App Review · Cycle ${workflowReviewCycle.cycle.cycleNumber} of ${workflowReviewCycle.run.cycleBudget}`,
          modelSelection: command.modelSelection,
          runtimeMode: WORKFLOW_AUTOMATION_RUNTIME_MODE,
          interactionMode:
            sourceThread.workflowRole === "app-review-orchestrator" ||
            sourceThread.workflowPreset === "app-review"
              ? "default"
              : "implementation-workflow",
          branch: sourceThread.branch,
          worktreePath: sourceThread.worktreePath,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
      const reviewCreatedEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.sourceThreadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        causationEventId: threadCreatedEvent.eventId,
        type: "thread.app-review-created",
        payload: {
          threadId: command.sourceThreadId,
          appReview: reviewRecord,
        },
      };
      const userMessageEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.reviewThreadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        causationEventId: reviewCreatedEvent.eventId,
        type: "thread.message-sent",
        payload: {
          threadId: command.reviewThreadId,
          messageId: command.message.messageId,
          role: "user",
          text: command.message.text,
          attachments: command.message.attachments,
          turnId: null,
          streaming: false,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
      const turnStartRequestedEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.reviewThreadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        causationEventId: userMessageEvent.eventId,
        type: "thread.turn-start-requested",
        payload: {
          threadId: command.reviewThreadId,
          messageId: command.message.messageId,
          modelSelection: command.modelSelection,
          titleSeed: "Browser App Review",
          runtimeMode: WORKFLOW_AUTOMATION_RUNTIME_MODE,
          interactionMode:
            sourceThread.workflowRole === "app-review-orchestrator" ||
            sourceThread.workflowPreset === "app-review"
              ? "default"
              : "implementation-workflow",
          workflowPromptId: command.workflowPromptId,
          createdAt: command.createdAt,
        },
      };
      if (command.batchProvenance === undefined) {
        return [threadCreatedEvent, reviewCreatedEvent, userMessageEvent, turnStartRequestedEvent];
      }
      const batch = sourceThread.workflowSubagentBatches?.find(
        (entry) => entry.id === command.batchProvenance?.batchId,
      );
      const child = batch?.children.find(
        (entry) => entry.index === command.batchProvenance?.childIndex,
      );
      if (!batch || !child || child.status !== "pending") {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Browser App Review batch child is missing or is not pending.",
        });
      }
      const childUpdatedEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: sourceThread.id,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        causationEventId: turnStartRequestedEvent.eventId,
        type: "thread.workflow-subagent-batch-child-updated",
        payload: {
          threadId: sourceThread.id,
          batchId: batch.id,
          batchStatus: "running",
          child: {
            ...child,
            status: "running",
            childThreadId: command.reviewThreadId,
            appReviewId: command.reviewId,
          },
        },
      };
      return [
        threadCreatedEvent,
        reviewCreatedEvent,
        userMessageEvent,
        turnStartRequestedEvent,
        childUpdatedEvent,
      ];
    }

    case "thread.workflow-subagent-batch.create": {
      const thread = yield* requireThread({ readModel, command, threadId: command.threadId });
      if (command.batch.parentThreadId !== thread.id) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Workflow sub-agent batch parent does not match the target thread.",
        });
      }
      if (command.batch.children.length !== 1) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "A workflow sub-agent handoff must contain exactly one child.",
        });
      }
      const unfinishedBatch = thread.workflowSubagentBatches?.find(
        (batch) => batch.status !== "completed",
      );
      if (unfinishedBatch !== undefined) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Workflow sub-agent batch '${unfinishedBatch.id}' is still unfinished.`,
        });
      }
      if (thread.workflowSubagentBatches?.some((batch) => batch.id === command.batch.id)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Workflow sub-agent batch '${command.batch.id}' already exists.`,
        });
      }
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: thread.id,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.workflow-subagent-batch-created",
        payload: { threadId: thread.id, batch: command.batch },
      };
    }

    case "thread.workflow-subagent.launch": {
      const parent = yield* requireThread({
        readModel,
        command,
        threadId: command.parentThreadId,
      });
      yield* requireWorkflowNotPaused({ readModel, command, threadId: command.parentThreadId });
      yield* requireThreadAbsent({ readModel, command, threadId: command.threadId });
      const batch = parent.workflowSubagentBatches?.find((entry) => entry.id === command.batchId);
      const child = batch?.children.find((entry) => entry.index === command.childIndex);
      if (!batch || !child || child.status !== "pending") {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Workflow sub-agent batch child is missing or is not pending.",
        });
      }
      const threadCreatedEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.created",
        payload: {
          threadId: command.threadId,
          projectId: command.projectId,
          ownerUserId: command.ownerUserId,
          parentThreadId: command.parentThreadId,
          workflowRole: command.workflowRole,
          workflowContext: parent.workflowContext,
          workflowSubagentBatchProvenance: {
            batchId: command.batchId,
            childIndex: command.childIndex,
          },
          title: command.title,
          modelSelection: command.modelSelection,
          runtimeMode: WORKFLOW_AUTOMATION_RUNTIME_MODE,
          interactionMode: command.interactionMode,
          branch: command.branch,
          worktreePath: command.worktreePath,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
      const messageEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        causationEventId: threadCreatedEvent.eventId,
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.message.messageId,
          role: "user",
          text: command.message.text,
          attachments: command.message.attachments,
          turnId: null,
          streaming: false,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
      const turnEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        causationEventId: messageEvent.eventId,
        type: "thread.turn-start-requested",
        payload: {
          threadId: command.threadId,
          messageId: command.message.messageId,
          modelSelection: command.modelSelection,
          titleSeed: command.title,
          runtimeMode: WORKFLOW_AUTOMATION_RUNTIME_MODE,
          interactionMode: command.interactionMode,
          workflowPromptId: command.workflowPromptId,
          createdAt: command.createdAt,
        },
      };
      const childEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: parent.id,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        causationEventId: turnEvent.eventId,
        type: "thread.workflow-subagent-batch-child-updated",
        payload: {
          threadId: parent.id,
          batchId: batch.id,
          batchStatus: "running",
          child: { ...child, status: "running", childThreadId: command.threadId },
        },
      };
      return [threadCreatedEvent, messageEvent, turnEvent, childEvent];
    }

    case "thread.workflow-subagent-batch.child.reject":
    case "thread.workflow-subagent-batch.child.fail":
    case "thread.workflow-subagent-batch.child.complete": {
      const parent = yield* requireThread({ readModel, command, threadId: command.threadId });
      const batch = parent.workflowSubagentBatches?.find((entry) => entry.id === command.batchId);
      const child = batch?.children.find((entry) => entry.index === command.childIndex);
      if (!batch || !child) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Workflow sub-agent batch child does not exist.",
        });
      }
      if (["completed", "blocked", "rejected", "failed", "canceled"].includes(child.status)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Workflow sub-agent batch child is already terminal.",
        });
      }
      const updatedChild =
        command.type === "thread.workflow-subagent-batch.child.complete"
          ? {
              ...child,
              status: command.status,
              resultMarkdown: command.resultMarkdown,
              completedAt: command.completedAt,
            }
          : {
              ...child,
              status:
                command.type === "thread.workflow-subagent-batch.child.reject"
                  ? ("rejected" as const)
                  : (command.status ?? "failed"),
              failureDetail: command.failureDetail,
              completedAt: command.completedAt,
            };
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: parent.id,
          occurredAt: command.completedAt,
          commandId: command.commandId,
        })),
        type: "thread.workflow-subagent-batch-child-updated",
        payload: {
          threadId: parent.id,
          batchId: batch.id,
          batchStatus: batch.status === "launching" ? "running" : batch.status,
          child: updatedChild,
        },
      };
    }

    case "thread.workflow-subagent-batch.complete": {
      const parent = yield* requireThread({ readModel, command, threadId: command.threadId });
      const batch = parent.workflowSubagentBatches?.find((entry) => entry.id === command.batchId);
      if (!batch || batch.status === "completed") {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Workflow sub-agent batch does not exist or is already completed.",
        });
      }
      if (batch.children.some((child) => ["pending", "running"].includes(child.status))) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Workflow sub-agent batch still has non-terminal children.",
        });
      }
      const completedEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: parent.id,
          occurredAt: command.completedAt,
          commandId: command.commandId,
        })),
        type: "thread.workflow-subagent-batch-completed",
        payload: { threadId: parent.id, batchId: batch.id, completedAt: command.completedAt },
      };
      const messageEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: parent.id,
          occurredAt: command.completedAt,
          commandId: command.commandId,
        })),
        causationEventId: completedEvent.eventId,
        type: "thread.message-sent",
        payload: {
          threadId: parent.id,
          messageId: command.message.messageId,
          role: "user",
          text: command.message.text,
          attachments: command.message.attachments,
          turnId: null,
          streaming: false,
          createdAt: command.completedAt,
          updatedAt: command.completedAt,
        },
      };
      const turnEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: parent.id,
          occurredAt: command.completedAt,
          commandId: command.commandId,
        })),
        causationEventId: messageEvent.eventId,
        type: "thread.turn-start-requested",
        payload: {
          threadId: parent.id,
          messageId: command.message.messageId,
          runtimeMode: command.runtimeMode,
          interactionMode: command.interactionMode,
          createdAt: command.completedAt,
        },
      };
      // A pause withholds the hand-back turn but keeps the batch's bookkeeping:
      // its children are already finished, and nothing re-drives a completion
      // that was refused outright, so failing here would strand the batch as
      // running forever. Resume re-enters the stage through recovery.
      if (isWorkflowThreadPaused(readModel.threads, parent.id)) {
        return [completedEvent, messageEvent];
      }
      return [completedEvent, messageEvent, turnEvent];
    }

    case "thread.turn.start": {
      const targetThread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (
        command.commandId.startsWith("server:") &&
        isWorkflowThreadPaused(readModel.threads, targetThread.id)
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `workflow ancestor of ${targetThread.id} is paused`,
        });
      }
      if (command.freshProviderSession === true) {
        const recoveryCommand = command.commandId.startsWith("server:workflow-nudge:");
        const autonomousRole =
          targetThread.workflowRole !== null &&
          NUDGEABLE_WORKFLOW_ROLES.has(targetThread.workflowRole);
        const hasActiveTurn =
          targetThread.session?.status === "starting" ||
          targetThread.session?.status === "running" ||
          (targetThread.session !== null && targetThread.session.activeTurnId !== null);
        if (
          !recoveryCommand ||
          !autonomousRole ||
          isWorkflowThreadPaused(readModel.threads, targetThread.id) ||
          hasActiveTurn ||
          targetThread.latestTurn?.state !== "error"
        ) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `Fresh provider sessions are limited to server recovery on an unpaused autonomous workflow thread with a terminal failed turn.`,
          });
        }
      }
      const targetProject = readModel.projects.find(
        (project) => project.id === targetThread.projectId,
      );
      const targetPath = targetThread.worktreePath ?? targetProject?.workspaceRoot ?? null;
      const canonicalTargetPath =
        targetPath === null ? null : normalizeProjectPathForComparison(targetPath);
      const worktreeOwner = (readModel.appReviewWorkflowRuns ?? []).find((run) => {
        if (run.status !== "running") return false;
        const runTarget = readModel.threads.find((thread) => thread.id === run.targetThreadId);
        if (runTarget === undefined) return false;
        const runProject = readModel.projects.find((project) => project.id === runTarget.projectId);
        const runPath = runTarget.worktreePath ?? runProject?.workspaceRoot ?? null;
        return (
          canonicalTargetPath !== null &&
          runPath !== null &&
          normalizeProjectPathForComparison(runPath) === canonicalTargetPath
        );
      });
      if (worktreeOwner !== undefined && !command.commandId.startsWith("server:")) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `App Review Workflow '${worktreeOwner.id}' currently owns this worktree.`,
        });
      }
      const sourceProposedPlan = command.sourceProposedPlan;
      const sourceThread = sourceProposedPlan
        ? yield* requireThread({
            readModel,
            command,
            threadId: sourceProposedPlan.threadId,
          })
        : null;
      const sourcePlan =
        sourceProposedPlan && sourceThread
          ? sourceThread.proposedPlans.find((entry) => entry.id === sourceProposedPlan.planId)
          : null;
      if (sourceProposedPlan && !sourcePlan) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Proposed plan '${sourceProposedPlan.planId}' does not exist on thread '${sourceProposedPlan.threadId}'.`,
        });
      }
      if (sourceThread && sourceThread.projectId !== targetThread.projectId) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Proposed plan '${sourceProposedPlan?.planId}' belongs to thread '${sourceThread.id}' in a different project.`,
        });
      }
      const userMessageEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.message.messageId,
          role: "user",
          text: command.message.text,
          attachments: command.message.attachments,
          turnId: null,
          streaming: false,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
      const turnStartRequestedEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        causationEventId: userMessageEvent.eventId,
        type: "thread.turn-start-requested",
        payload: {
          threadId: command.threadId,
          messageId: command.message.messageId,
          ...(command.modelSelection !== undefined
            ? { modelSelection: command.modelSelection }
            : {}),
          ...(command.titleSeed !== undefined ? { titleSeed: command.titleSeed } : {}),
          runtimeMode: targetThread.runtimeMode,
          interactionMode: targetThread.interactionMode,
          ...(command.workflowPromptId !== undefined
            ? { workflowPromptId: command.workflowPromptId }
            : {}),
          ...(command.freshProviderSession !== undefined
            ? { freshProviderSession: command.freshProviderSession }
            : {}),
          ...(sourceProposedPlan !== undefined ? { sourceProposedPlan } : {}),
          createdAt: command.createdAt,
        },
      };
      // Real activity resets ANY override: it wakes an explicitly settled
      // thread, and it clears a keep-active pin back to neutral so the
      // thread can auto-settle again after this burst of work goes stale.
      // A snooze clears the same way — sending a message to a snoozed
      // thread is the user re-engaging, so the return ticket is spent.
      const lifecycleResetEvents: Array<Omit<OrchestrationEvent, "sequence">> = [];
      if (targetThread.settledOverride !== null) {
        lifecycleResetEvents.push({
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          })),
          type: "thread.unsettled",
          payload: {
            threadId: command.threadId,
            reason: "activity",
            updatedAt: command.createdAt,
          },
        });
      }
      if (targetThread.snoozedUntil != null) {
        lifecycleResetEvents.push({
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          })),
          type: "thread.unsnoozed",
          payload: {
            threadId: command.threadId,
            reason: "activity",
            updatedAt: command.createdAt,
          },
        });
      }
      return [...lifecycleResetEvents, userMessageEvent, turnStartRequestedEvent];
    }

    case "thread.turn.interrupt": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.turn-interrupt-requested",
        payload: {
          threadId: command.threadId,
          ...(command.turnId !== undefined ? { turnId: command.turnId } : {}),
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.approval.respond": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: {
            requestId: command.requestId,
          },
        })),
        type: "thread.approval-response-requested",
        payload: {
          threadId: command.threadId,
          requestId: command.requestId,
          decision: command.decision,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.user-input.respond": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: {
            requestId: command.requestId,
          },
        })),
        type: "thread.user-input-response-requested",
        payload: {
          threadId: command.threadId,
          requestId: command.requestId,
          answers: command.answers,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.checkpoint.revert": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.checkpoint-revert-requested",
        payload: {
          threadId: command.threadId,
          turnCount: command.turnCount,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.session.stop": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      // Settle-cleanup stops are conditional: between the settle landing and
      // this command, another client may have re-engaged the thread (a turn
      // start unsettles it and brings the session alive). Commands are
      // decided serially against this read model, so checking here — not in
      // the dispatcher's pre-settle snapshot — closes that race.
      if (command.onlyIfSettled === true) {
        const sessionComingAlive =
          thread.session?.status === "starting" || thread.session?.status === "running";
        if (
          thread.settledOverride !== "settled" ||
          sessionComingAlive ||
          threadHasQueuedTurnStart(thread, command.createdAt)
        ) {
          return yield* Effect.fail(
            new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: `thread ${command.threadId} was re-engaged after settle; skipping session stop`,
            }),
          );
        }
      }
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.session-stop-requested",
        payload: {
          threadId: command.threadId,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.session.set": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const sessionSetEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: {},
        })),
        type: "thread.session-set",
        payload: {
          threadId: command.threadId,
          session: command.session,
        },
      };
      // Only a session coming alive is activity worth waking a settled thread
      // for — status writes like ready/stopped/error arrive after the fact and
      // must not fight a user's explicit settle. Snooze is deliberately NOT
      // cleared here: snooze never pauses the agent, so its session starting
      // or erroring is not the user re-engaging. Blocked/failed work still
      // surfaces immediately — effectiveSnoozed refuses to classify a thread
      // with a raised hand (approval / input / failure / fresh completion)
      // as snoozed, without spending the return ticket.
      const isSessionActivity =
        command.session.status === "starting" || command.session.status === "running";
      // Real activity resets ANY override (settled wakes, active unpins).
      if (thread.settledOverride === null || !isSessionActivity) {
        return sessionSetEvent;
      }
      const unsettledEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.unsettled",
        payload: {
          threadId: command.threadId,
          reason: "activity",
          updatedAt: command.createdAt,
        },
      };
      return [unsettledEvent, sessionSetEvent];
    }

    case "thread.message.assistant.delta": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          role: "assistant",
          text: command.delta,
          turnId: command.turnId ?? null,
          streaming: true,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.message.assistant.complete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          role: "assistant",
          text: "",
          turnId: command.turnId ?? null,
          streaming: false,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.proposed-plan.upsert": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.proposed-plan-upserted",
        payload: {
          threadId: command.threadId,
          proposedPlan: command.proposedPlan,
        },
      };
    }

    case "thread.turn.diff.complete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.turn-diff-completed",
        payload: {
          threadId: command.threadId,
          turnId: command.turnId,
          checkpointTurnCount: command.checkpointTurnCount,
          checkpointRef: command.checkpointRef,
          status: command.status,
          files: command.files,
          assistantMessageId: command.assistantMessageId ?? null,
          completedAt: command.completedAt,
        },
      };
    }

    case "thread.revert.complete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.reverted",
        payload: {
          threadId: command.threadId,
          turnCount: command.turnCount,
        },
      };
    }

    case "thread.activity.append": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const requestId =
        typeof command.activity.payload === "object" &&
        command.activity.payload !== null &&
        "requestId" in command.activity.payload &&
        typeof (command.activity.payload as { requestId?: unknown }).requestId === "string"
          ? ((command.activity.payload as { requestId: string })
              .requestId as OrchestrationEvent["metadata"]["requestId"])
          : undefined;
      const activityAppendedEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          ...(requestId !== undefined ? { metadata: { requestId } } : {}),
        })),
        type: "thread.activity-appended",
        payload: {
          threadId: command.threadId,
          activity: command.activity,
        },
      };
      // An approval or user-input request is blocked-on-you work — it must
      // never stay hidden inside a settled slim row.
      const wakesSettledThread =
        command.activity.kind === "approval.requested" ||
        command.activity.kind === "user-input.requested";
      // Real activity resets ANY override (settled wakes, active unpins).
      if (thread.settledOverride === null || !wakesSettledThread) {
        return activityAppendedEvent;
      }
      const unsettledEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.unsettled",
        payload: {
          threadId: command.threadId,
          reason: "activity",
          updatedAt: command.createdAt,
        },
      };
      return [unsettledEvent, activityAppendedEvent];
    }

    case "thread.app-review.update": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const review = thread.appReviews.find((entry) => entry.id === command.reviewId);
      if (!review) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `App Review '${command.reviewId}' does not exist on thread '${command.threadId}'.`,
        });
      }
      if (command.status === undefined && command.document === undefined) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "App Review update must include status or document.",
        });
      }
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.app-review-updated",
        payload: {
          threadId: command.threadId,
          reviewId: command.reviewId,
          sourceThreadId: review.sourceThreadId,
          reviewThreadId: review.reviewThreadId,
          ...(command.status !== undefined ? { status: command.status } : {}),
          ...(command.document !== undefined ? { document: command.document } : {}),
          updatedAt: command.updatedAt,
        },
      };
    }

    case "thread.app-review.evidence.update": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const review = thread.appReviews.find((entry) => entry.id === command.reviewId);
      if (!review) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `App Review '${command.reviewId}' does not exist on thread '${command.threadId}'.`,
        });
      }
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.app-review-evidence-updated",
        payload: {
          threadId: command.threadId,
          reviewId: command.reviewId,
          sourceThreadId: review.sourceThreadId,
          reviewThreadId: review.reviewThreadId,
          evidence: command.evidence,
          updatedAt: command.updatedAt,
        },
      };
    }

    default: {
      command satisfies never;
      const fallback = command as never as { type: string };
      return yield* new OrchestrationCommandInvariantError({
        commandType: fallback.type,
        detail: `Unknown command type: ${fallback.type}`,
      });
    }
  }
});
