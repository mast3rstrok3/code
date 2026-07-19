import {
  type DevReviewDocument,
  EMPTY_DEV_REVIEW_EVIDENCE,
  EventId,
  MessageId,
  type OrchestrationImplementationRun,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationPlanningTicket,
  type OrchestrationPlanningSpec,
  type OrchestrationPlanningSpecBundle,
  type OrchestrationReadModel,
  PLANNING_REVIEW_MAX_CYCLES,
  type PlanningReviewerTicketEdit,
  ThreadId,
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
} from "./commandInvariants.ts";
import { WORKFLOW_PROMPT_IDS } from "../provider/WorkflowPromptRegistry.ts";
import { validatePlanningTicketFileChanges } from "./planningTicketFiles.ts";
import { buildPlanImplementationThreadTitle } from "@t3tools/shared/orchestrationPlanning";
import { isProductWorkflowPreset, isProductWorkflowRoot } from "@t3tools/shared/workflowPresets";

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const EMPTY_DEV_REVIEW_DOCUMENT: DevReviewDocument = {
  verdict: "pending",
  summary: "",
  checks: [],
  findings: [],
  questions: [],
  nextSteps: [],
};

const DEFAULT_IMPLEMENTATION_VALIDATION_COMMANDS = ["vp check", "vp run typecheck"] as const;

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
    return { cycleNumber, mode: "full" as const, targetPlanningTicketIds: allTicketIds };
  }
  const targetPlanningTicketIds = Array.from(
    new Set([...previous.failingPlanningTicketIds, ...previous.editedPlanningTicketIds]),
  ).filter((ticketId) => allTicketIds.includes(ticketId));
  return {
    cycleNumber,
    mode: "targeted" as const,
    targetPlanningTicketIds,
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

function buildProductPlanningSpecStagePrompt(
  command: Extract<OrchestrationCommand, { type: "thread.planning-workflow.launch" }>,
): string {
  return [
    "Run the Planning Workflow Spec authoring stage from this locked Product Workflow intent.",
    "",
    "Use this locked product intent as the authoritative source. Do not ask the user questions or reopen product intent.",
    "",
    "The Planning Workflow owns the project's domain model: while authoring the Spec, capture resolved terminology in the CONTEXT.md glossary and record warranted ADRs (formats in CONTEXT-FORMAT.md and ADR-FORMAT.md) without asking the user.",
    "",
    `Intent title: ${command.intentTitle}`,
    "",
    "Intent summary:",
    command.intentSummaryMarkdown,
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
          },
        ],
      },
      null,
      2,
    ),
    "```",
  ].join("\n");
}

function buildPlanningReviewerPrompt(input: {
  readonly spec: OrchestrationPlanningSpec;
  readonly tickets: ReadonlyArray<OrchestrationPlanningTicket>;
  readonly cycleNumber: number;
  readonly mode: "full" | "targeted";
  readonly targetPlanningTicketIds: ReadonlyArray<string>;
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
    "When ready, finish with exactly one fenced JSON block using this shape. Use the planning ticket ids shown below.",
    "```json",
    JSON.stringify(
      {
        type: "planning-reviewer-verdict",
        cycleNumber: input.cycleNumber,
        mode: input.mode,
        targetPlanningTicketIds: input.targetPlanningTicketIds,
        passed: false,
        failingPlanningTicketIds: ["planning-ticket-id"],
        dependencyFeedback: ["Dependency graph correction or empty array."],
        perTicketFeedback: [
          {
            ticketId: "planning-ticket-id",
            passed: false,
            feedbackMarkdown: "Concrete correction or approval note.",
          },
        ],
        ticketEdits: [],
      },
      null,
      2,
    ),
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
      attemptCount: 0,
      updatedAt: input.command.createdAt,
    };
  });
  const validationCommands =
    input.command.validationCommands !== undefined && input.command.validationCommands.length > 0
      ? input.command.validationCommands
      : [...DEFAULT_IMPLEMENTATION_VALIDATION_COMMANDS];
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
      finalDevReview: {
        required: true,
        completionBlocking: true,
        appDevStackSource: "orchestrator-worktree",
        autoStartAppDevStack: true,
        browserMcpProfile: "agent-browser",
        maxAttempts: 5,
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
    devReviewIds: [],
    devReviews: [],
    devReviewedHeadSha: null,
    activeDevReviewHeadSha: null,
    activeDevReviewThreadId: null,
    qaAttemptCount: 0,
    codeReviewedHeadSha: null,
    activeCodeReviewHeadSha: null,
    activeCodeReviewThreadId: null,
    codeReviewAttemptCount: 0,
    activeFixerThreadId: null,
    fixOrigin: null,
    latestCodeReviewReportMarkdown: null,
    handoffTarget: "orchestrator-worktree",
    baseBranchMergePolicy: "never-auto-merge",
    changeRequest: null,
    changeRequestFailure: null,
    changeRequestPublisherUserId: input.publisherUserId,
    fastBuildResult: null,
    retryableFailure: null,
    createdAt: input.command.createdAt,
    updatedAt: input.command.createdAt,
  };
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
          ...(command.modelSelection !== undefined
            ? { modelSelection: command.modelSelection }
            : {}),
          ...(branch !== undefined ? { branch } : {}),
          ...(command.worktreePath !== undefined ? { worktreePath: command.worktreePath } : {}),
          updatedAt: occurredAt,
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
      if (!isProductWorkflowRoot(productRootThread)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Thread '${command.threadId}' is not a Product Workflow root thread.`,
        });
      }

      const crypto = yield* Crypto.Crypto;
      const planningThreadUuid = yield* crypto.randomUUIDv4;
      const messageUuid = yield* crypto.randomUUIDv4;
      const planningThreadId = ThreadId.make(`thread-planning-orchestrator-${planningThreadUuid}`);
      const messageId = MessageId.make(`message-product-spec-stage-${messageUuid}`);
      const planningThreadCreatedEvent: PlannedOrchestrationEvent = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: planningThreadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.created",
        payload: {
          threadId: planningThreadId,
          projectId: productRootThread.projectId,
          ownerUserId: productRootThread.ownerUserId,
          parentThreadId: productRootThread.id,
          workflowRole: "planning-orchestrator",
          workflowContext: productRootThread.workflowContext ?? {
            workflowId: WorkflowId.make(`workflow-${productRootThread.id}`),
            rootThreadId: productRootThread.id,
            ticketScope: [],
          },
          title: `Plan ${command.intentTitle}`,
          modelSelection: productRootThread.modelSelection,
          runtimeMode: productRootThread.runtimeMode,
          interactionMode: "planning-workflow",
          branch: productRootThread.branch,
          worktreePath: productRootThread.worktreePath,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
      const stageStartedEvent: PlannedOrchestrationEvent = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: planningThreadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        causationEventId: planningThreadCreatedEvent.eventId,
        type: "thread.planning-stage-started",
        payload: {
          threadId: planningThreadId,
          stage: "spec-authoring",
          startedAt: command.createdAt,
        },
      };
      const promptEvent: PlannedOrchestrationEvent = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: planningThreadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        causationEventId: stageStartedEvent.eventId,
        type: "thread.message-sent",
        payload: {
          threadId: planningThreadId,
          messageId,
          role: "user",
          text: buildProductPlanningSpecStagePrompt(command),
          turnId: null,
          streaming: false,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
      const turnStartRequestedEvent: PlannedOrchestrationEvent = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: planningThreadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        causationEventId: promptEvent.eventId,
        type: "thread.turn-start-requested",
        payload: {
          threadId: planningThreadId,
          messageId,
          modelSelection: productRootThread.modelSelection,
          runtimeMode: productRootThread.runtimeMode,
          interactionMode: "planning-workflow",
          workflowPromptId: WORKFLOW_PROMPT_IDS.planningSpecCodex,
          createdAt: command.createdAt,
        },
      };
      return [planningThreadCreatedEvent, stageStartedEvent, promptEvent, turnStartRequestedEvent];
    }

    case "thread.planning-stage.start": {
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
      if (thread.planningWorkflow?.spec !== null && thread.planningWorkflow?.spec !== undefined) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Thread '${command.threadId}' already has a Spec for this Planning Workflow.`,
        });
      }

      const crypto = yield* Crypto.Crypto;
      const messageUuid = yield* crypto.randomUUIDv4;
      const messageId = MessageId.make(`message-planning-spec-stage-${messageUuid}`);
      const stageStartedEvent: PlannedOrchestrationEvent = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: thread.id,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.planning-stage-started",
        payload: {
          threadId: thread.id,
          stage: "spec-authoring",
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
          text: buildPlanningSpecStagePrompt(),
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
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
          workflowPromptId: WORKFLOW_PROMPT_IDS.planningSpecCodex,
          createdAt: command.createdAt,
        },
      };
      return [stageStartedEvent, promptEvent, turnStartRequestedEvent];
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
      if (thread.interactionMode !== "planning-workflow") {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Thread '${command.threadId}' is not in Planning Workflow mode.`,
        });
      }
      if (thread.planningWorkflow?.spec !== null && thread.planningWorkflow?.spec !== undefined) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Thread '${command.threadId}' already has a Spec for this Planning Workflow.`,
        });
      }
      const crypto = yield* Crypto.Crypto;
      const specUuid = yield* crypto.randomUUIDv4;
      const ticketMessageUuid = yield* crypto.randomUUIDv4;
      const spec = buildPlanningSpecFromArtifact({
        specId: `spec-${specUuid}`,
        threadId: thread.id,
        command,
      });
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
          spec,
          stage: "tickets-authoring",
        },
      };
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
          text: buildPlanningTicketsStagePrompt(spec),
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
      if (thread.interactionMode !== "planning-workflow") {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Thread '${command.threadId}' is not in Planning Workflow mode.`,
        });
      }
      if (workflow === null || workflow === undefined || spec === null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Planning Thread '${thread.id}' does not have a Spec for Planning Tickets.`,
        });
      }
      if (spec.id !== command.specId) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Planning Tickets artifact targets Spec '${command.specId}', expected '${spec.id}'.`,
        });
      }
      const crypto = yield* Crypto.Crypto;
      const generatedTicketIds = yield* Effect.forEach(command.tickets, () =>
        crypto.randomUUIDv4.pipe(Effect.map((uuid) => `planning-ticket-${uuid}`)),
      );
      const tickets = buildPlanningTicketsFromArtifact({
        specId: spec.id,
        command,
        generatedTicketIds,
      });
      if (typeof tickets === "string") {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: tickets,
        });
      }
      const validationError = validatePlanningTicketGraph(spec.id, tickets);
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
                specId: spec.id,
                tickets,
                stage: "ticket-review",
                revisedAt: command.createdAt,
              }
            : {
                threadId: thread.id,
                specId: spec.id,
                tickets,
                stage: "ticket-review",
              },
      } satisfies PlannedOrchestrationEvent;
    }

    case "thread.planning-ticket-review.request": {
      const planningThread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
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
      const { cycleNumber, mode, targetPlanningTicketIds } = reviewRequest;
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
              rootThreadId: planningThread.id,
              ticketScope: [],
            }),
            ticketScope: targetPlanningTicketIds,
          },
          title: `Review ${spec.title}`,
          modelSelection: planningThread.modelSelection,
          runtimeMode: planningThread.runtimeMode,
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
          runtimeMode: planningThread.runtimeMode,
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
      const passed = inferredPassed && edits.length === 0;
      const cycleNumber = activeReview.cycleNumber;
      const status = command.runtimeFailure
        ? ("runtime-failed" as const)
        : edits.length > 0
          ? ("revised" as const)
          : passed
            ? ("passed" as const)
            : ("failed" as const);
      const remainingTargetPlanningTicketIds = Array.from(
        new Set([...failingPlanningTicketIds, ...editedPlanningTicketIds]),
      ).filter((ticketId) => editedTickets.some((ticket) => ticket.id === ticketId));
      const reviewCompleted =
        passed ||
        (command.runtimeFailure !== true &&
          status === "revised" &&
          remainingTargetPlanningTicketIds.length === 0);
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
      if (sourceThread.workflowPreset !== "fast-feature") {
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
      const validationCommands =
        command.validationCommands && command.validationCommands.length > 0
          ? command.validationCommands
          : [...DEFAULT_IMPLEMENTATION_VALIDATION_COMMANDS];
      const run: OrchestrationImplementationRun = {
        id: `implementation-run-${runUuid}`,
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
          finalDevReview: {
            required: true,
            completionBlocking: true,
            appDevStackSource: "orchestrator-worktree",
            autoStartAppDevStack: true,
            browserMcpProfile: "agent-browser",
            maxAttempts: 5,
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
        devReviewIds: [],
        devReviews: [],
        devReviewedHeadSha: null,
        activeDevReviewHeadSha: null,
        activeDevReviewThreadId: null,
        qaAttemptCount: 0,
        codeReviewedHeadSha: null,
        activeCodeReviewHeadSha: null,
        activeCodeReviewThreadId: null,
        codeReviewAttemptCount: 0,
        activeFixerThreadId: null,
        fixOrigin: null,
        latestCodeReviewReportMarkdown: null,
        handoffTarget: "orchestrator-worktree",
        baseBranchMergePolicy: "never-auto-merge",
        changeRequest: null,
        changeRequestFailure: null,
        changeRequestPublisherUserId: sourceThread.ownerUserId,
        fastBuildResult: null,
        retryableFailure: null,
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
          workflowPreset: "fast-feature",
          workflowContext: sourceThread.workflowContext ?? null,
          title: buildPlanImplementationThreadTitle(plan.planMarkdown),
          modelSelection: sourceThread.modelSelection,
          runtimeMode: sourceThread.runtimeMode,
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
            workflowId: bundle.spec.workflowId,
            rootThreadId: launcherThread.workflowContext?.rootThreadId ?? launcherThread.id,
            ticketScope: bundle.tickets.map((ticket) => ticket.id),
          },
          title: `Implement ${bundle.spec.title}`,
          modelSelection: launcherThread.modelSelection,
          runtimeMode: launcherThread.runtimeMode,
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

    case "thread.dev-review.launch": {
      const sourceThread = yield* requireThread({
        readModel,
        command,
        threadId: command.sourceThreadId,
      });
      yield* requireThreadAbsent({
        readModel,
        command,
        threadId: command.reviewThreadId,
      });
      const existingReview = readModel.threads.some((thread) =>
        thread.devReviews.some((review) => review.id === command.reviewId),
      );
      if (existingReview) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Dev Review '${command.reviewId}' already exists and cannot be created twice.`,
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
      const reviewRecord = {
        id: command.reviewId,
        sourceThreadId: command.sourceThreadId,
        reviewThreadId: command.reviewThreadId,
        planningTicketIds,
        sourceTurnId: sourceThread.latestTurn?.turnId ?? null,
        status: "running" as const,
        document: EMPTY_DEV_REVIEW_DOCUMENT,
        evidence: EMPTY_DEV_REVIEW_EVIDENCE,
        createdAt: command.createdAt,
        updatedAt: command.createdAt,
      };
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
          workflowRole: "implementation-qa-reviewer",
          workflowContext:
            sourceThread.workflowContext == null
              ? null
              : { ...sourceThread.workflowContext, ticketScope: planningTicketIds },
          ...(command.batchProvenance !== undefined
            ? { workflowSubagentBatchProvenance: command.batchProvenance }
            : {}),
          title: "Browser Dev Review",
          modelSelection: command.modelSelection,
          runtimeMode: command.runtimeMode,
          interactionMode: "implementation-workflow",
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
        type: "thread.dev-review-created",
        payload: {
          threadId: command.sourceThreadId,
          devReview: reviewRecord,
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
          titleSeed: "Browser Dev Review",
          runtimeMode: command.runtimeMode,
          interactionMode: "implementation-workflow",
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
          detail: "Browser Dev Review batch child is missing or is not pending.",
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
            devReviewId: command.reviewId,
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
      if (command.batch.children.length === 0) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Workflow sub-agent batch must contain at least one child.",
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
          runtimeMode: command.runtimeMode,
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
          runtimeMode: command.runtimeMode,
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
      return [completedEvent, messageEvent, turnEvent];
    }

    case "thread.turn.start": {
      const targetThread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
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
          ...(sourceProposedPlan !== undefined ? { sourceProposedPlan } : {}),
          createdAt: command.createdAt,
        },
      };
      return [userMessageEvent, turnStartRequestedEvent];
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
        type: "thread.session-stop-requested",
        payload: {
          threadId: command.threadId,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.session.set": {
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
          metadata: {},
        })),
        type: "thread.session-set",
        payload: {
          threadId: command.threadId,
          session: command.session,
        },
      };
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
      yield* requireThread({
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
      return {
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
    }

    case "thread.dev-review.update": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const review = thread.devReviews.find((entry) => entry.id === command.reviewId);
      if (!review) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Dev Review '${command.reviewId}' does not exist on thread '${command.threadId}'.`,
        });
      }
      if (command.status === undefined && command.document === undefined) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Dev Review update must include status or document.",
        });
      }
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.dev-review-updated",
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

    case "thread.dev-review.evidence.update": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const review = thread.devReviews.find((entry) => entry.id === command.reviewId);
      if (!review) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Dev Review '${command.reviewId}' does not exist on thread '${command.threadId}'.`,
        });
      }
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.dev-review-evidence-updated",
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
