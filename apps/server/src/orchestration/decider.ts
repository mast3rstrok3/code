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
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import type * as PlatformError from "effect/PlatformError";

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
import { projectEvent } from "./projector.ts";
import { WORKFLOW_PROMPT_IDS } from "../provider/WorkflowPromptRegistry.ts";

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
  for (const ticket of tickets) {
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
    workflowId: `workflow-${input.specId}`,
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
      specId: input.specId,
      ordinal: index + 1,
      title: ticket.title,
      bodyMarkdown: ticket.bodyMarkdown,
      dependencies,
      status: "open",
      createdAt: input.command.createdAt,
      updatedAt: input.command.createdAt,
    };
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
            dependencyKeys: [],
          },
        ],
      },
      null,
      2,
    ),
    "```",
    "",
    `# ${spec.title}`,
    "",
    spec.summaryMarkdown,
  ].join("\n");
}

function buildPlanningReviewerPrompt(input: {
  readonly spec: OrchestrationPlanningSpec;
  readonly tickets: ReadonlyArray<OrchestrationPlanningTicket>;
  readonly cycleNumber: number;
}): string {
  return [
    `Review planning ticket cycle ${input.cycleNumber} for Spec "${input.spec.title}".`,
    "",
    "Decide whether the ticket set is complete against the Spec and available context, and whether the proposed tickets are correct tracer-bullet vertical slices.",
    "",
    "Review for missing Spec coverage, incorrect horizontal slicing, oversized or undersized slices, incorrect dependency ordering, hidden prefactoring/migration/contract work, vague acceptance criteria, and missing expected tests.",
    "",
    "When ready, finish with exactly one fenced JSON block using this shape. Use the planning ticket ids shown below.",
    "```json",
    JSON.stringify(
      {
        type: "planning-reviewer-verdict",
        cycleNumber: input.cycleNumber,
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
      },
      null,
      2,
    ),
    "```",
    "",
    "## Spec",
    "",
    input.spec.summaryMarkdown,
    "",
    "## Planning Tickets",
    "",
    input.tickets
      .map(
        (ticket) => `#${ticket.ordinal} ${ticket.title}\nID: ${ticket.id}\n${ticket.bodyMarkdown}`,
      )
      .join("\n\n"),
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
    branch: `${input.command.orchestratorBranch}/ticket-${ticket.ordinal}`,
    worktreePath: `${input.command.orchestratorWorktreePath}-ticket-${ticket.ordinal}`,
  }));
  return {
    id: input.runId,
    specId: input.command.specId,
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
    terminalLineageTicketIds: [],
    finalValidation: null,
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
    qaAttemptCount: 0,
    codeReviewAttemptCount: 0,
    handoffTarget: "orchestrator-worktree",
    baseBranchMergePolicy: "never-auto-merge",
    changeRequest: null,
    changeRequestFailure: null,
    changeRequestPublisherUserId: input.publisherUserId,
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

const decideCommandSequence = Effect.fn("decideCommandSequence")(function* ({
  commands,
  readModel,
}: {
  readonly commands: ReadonlyArray<OrchestrationCommand>;
  readonly readModel: OrchestrationReadModel;
}): Effect.fn.Return<
  ReadonlyArray<PlannedOrchestrationEvent>,
  OrchestrationCommandInvariantError | PlatformError.PlatformError,
  Crypto.Crypto
> {
  let nextReadModel = readModel;
  let nextSequence = readModel.snapshotSequence;
  const plannedEvents: PlannedOrchestrationEvent[] = [];

  for (const nextCommand of commands) {
    const decided = yield* decideOrchestrationCommand({
      command: nextCommand,
      readModel: nextReadModel,
    });
    const nextEvents = Array.isArray(decided) ? decided : [decided];
    for (const nextEvent of nextEvents) {
      plannedEvents.push(nextEvent);
      nextSequence += 1;
      nextReadModel = yield* projectEvent(nextReadModel, {
        ...nextEvent,
        sequence: nextSequence,
      }).pipe(Effect.orDie);
    }
  }

  return plannedEvents;
});

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
        return yield* decideCommandSequence({
          readModel,
          commands: [
            ...activeThreads.map(
              (thread): Extract<OrchestrationCommand, { type: "thread.delete" }> => ({
                type: "thread.delete",
                commandId: command.commandId,
                threadId: thread.id,
              }),
            ),
            {
              type: "project.delete",
              commandId: command.commandId,
              projectId: command.projectId,
            },
          ],
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
          ...(command.workflowSubagentBatchProvenance !== undefined
            ? { workflowSubagentBatchProvenance: command.workflowSubagentBatchProvenance }
            : {}),
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
    }

    case "thread.delete": {
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
        type: "thread.deleted",
        payload: {
          threadId: command.threadId,
          deletedAt: occurredAt,
        },
      };
    }

    case "thread.archive": {
      yield* requireThreadNotArchived({
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
        type: "thread.archived",
        payload: {
          threadId: command.threadId,
          archivedAt: occurredAt,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.unarchive": {
      yield* requireThreadArchived({
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
        type: "thread.unarchived",
        payload: {
          threadId: command.threadId,
          updatedAt: occurredAt,
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
      if (
        productRootThread.interactionMode !== "product-workflow" ||
        productRootThread.workflowRole !== null
      ) {
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
      const crypto = yield* Crypto.Crypto;
      const reviewerThreadUuid = yield* crypto.randomUUIDv4;
      const reviewerMessageUuid = yield* crypto.randomUUIDv4;
      const reviewerThreadId = ThreadId.make(`thread-planning-reviewer-${reviewerThreadUuid}`);
      const reviewerMessageId = MessageId.make(`message-planning-reviewer-${reviewerMessageUuid}`);
      const cycleNumber = workflow.reviewCycles.length + 1;
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
          text: buildPlanningReviewerPrompt({ spec, tickets, cycleNumber }),
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
      const passed =
        command.passed ??
        !/\b(fail|failed|failing|blocker|blocked)\b/i.test(command.verdictMarkdown);
      const cycleNumber = workflow.reviewCycles.length + 1;
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
            status: passed ? "passed" : "failed",
            reviewerThreadId: command.reviewerThreadId,
            reviewerMessageId: command.reviewerMessageId,
            verdictMarkdown: command.verdictMarkdown,
            failingPlanningTicketIds: command.failingPlanningTicketIds ?? [],
            dependencyFeedback: command.dependencyFeedback ?? [],
            perTicketFeedback: command.perTicketFeedback ?? [],
            createdAt: command.createdAt,
          },
          tickets: workflow.tickets,
          stage: passed ? "completed" : "ticket-revision",
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

      const reviewRecord = {
        id: command.reviewId,
        sourceThreadId: command.sourceThreadId,
        reviewThreadId: command.reviewThreadId,
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
