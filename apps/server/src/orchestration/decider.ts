import {
  type DevReviewDocument,
  EventId,
  MessageId,
  type OrchestrationImplementationRun,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationPlanningIssue,
  type OrchestrationPlanningPrd,
  type OrchestrationPlanningPrdBundle,
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

function findPlanningBundleByPrdId(
  readModel: OrchestrationReadModel,
  prdId: string,
):
  | (OrchestrationPlanningPrdBundle & {
      readonly sourceThread: OrchestrationReadModel["threads"][number] | null;
    })
  | null {
  for (const thread of readModel.threads) {
    const workflow = thread.planningWorkflow;
    if (workflow?.prd?.id !== prdId) continue;
    return {
      prd: {
        ...workflow.prd,
        issueCount: workflow.issues.length,
      },
      issues: workflow.issues,
      reviewCycles: workflow.reviewCycles,
      sourceThread: thread,
    };
  }
  return null;
}

function validatePlanningIssueGraph(
  prdId: string,
  issues: ReadonlyArray<OrchestrationPlanningIssue>,
): string | null {
  const issueIds = new Set(issues.map((issue) => issue.id));
  for (const issue of issues) {
    if (issue.prdId !== prdId) {
      return `Planning Issue '${issue.id}' belongs to PRD '${issue.prdId}', expected '${prdId}'.`;
    }
    for (const dependency of issue.dependencies) {
      if (dependency.prdId !== prdId) {
        return `Planning Issue '${issue.id}' has a dependency in a different PRD.`;
      }
      if (!issueIds.has(dependency.issueId)) {
        return `Planning Issue '${issue.id}' depends on unknown issue '${dependency.issueId}'.`;
      }
      if (dependency.issueId === issue.id) {
        return `Planning Issue '${issue.id}' cannot depend on itself.`;
      }
    }
  }
  return null;
}

function buildPlanningPrdFromArtifact(input: {
  readonly prdId: string;
  readonly threadId: ThreadId;
  readonly command: Extract<OrchestrationCommand, { type: "thread.planning-prd.apply" }>;
}): OrchestrationPlanningPrd {
  return {
    id: input.prdId,
    title: input.command.title,
    summaryMarkdown: input.command.summaryMarkdown,
    tenantId: input.command.tenantId ?? null,
    teamId: input.command.teamId ?? null,
    sourceThreadId: input.threadId,
    sourceMessageIds: [input.command.sourceMessageId],
    createdBy: input.command.createdBy ?? null,
    workflowId: `workflow-${input.prdId}`,
    issueCount: 0,
    createdAt: input.command.createdAt,
    updatedAt: input.command.createdAt,
  };
}

function buildPlanningIssuesFromArtifact(input: {
  readonly prdId: string;
  readonly command: Extract<OrchestrationCommand, { type: "thread.planning-issues.apply" }>;
  readonly generatedIssueIds: ReadonlyArray<string>;
}): OrchestrationPlanningIssue[] | string {
  const idByKey = new Map<string, string>();
  for (let index = 0; index < input.command.issues.length; index += 1) {
    const issue = input.command.issues[index];
    const id = input.generatedIssueIds[index];
    if (!issue || !id) continue;
    if (idByKey.has(issue.key)) {
      return `Planning Issue key '${issue.key}' is duplicated.`;
    }
    idByKey.set(issue.key, id);
  }

  return input.command.issues.map((issue, index) => {
    const issueId = idByKey.get(issue.key) ?? input.generatedIssueIds[index] ?? issue.key;
    const dependencies = issue.dependencyKeys.map((dependencyKey) => {
      const dependencyIssueId = idByKey.get(dependencyKey);
      if (dependencyIssueId === undefined) {
        return {
          prdId: input.prdId,
          issueId: dependencyKey,
        };
      }
      return {
        prdId: input.prdId,
        issueId: dependencyIssueId,
      };
    });
    return {
      id: issueId,
      prdId: input.prdId,
      ordinal: index + 1,
      title: issue.title,
      bodyMarkdown: issue.bodyMarkdown,
      dependencies,
      status: "open",
      createdAt: input.command.createdAt,
      updatedAt: input.command.createdAt,
    };
  });
}

function buildPlanningPrdStagePrompt(): string {
  return [
    "Create the PRD artifact for this planning workflow.",
    "",
    "When ready, finish with exactly one fenced JSON block using this shape:",
    "```json",
    JSON.stringify(
      {
        type: "planning-prd-artifact",
        title: "Short PRD title",
        summaryMarkdown:
          "Full PRD markdown with goals, non-goals, workflows, data, risks, and acceptance criteria.",
      },
      null,
      2,
    ),
    "```",
  ].join("\n");
}

function buildProductPlanningPrdStagePrompt(
  command: Extract<OrchestrationCommand, { type: "thread.planning-workflow.launch" }>,
): string {
  return [
    "Run the Planning Workflow PRD authoring stage from this locked Product Grill intent.",
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
        type: "planning-prd-artifact",
        title: "Short PRD title",
        summaryMarkdown:
          "Full PRD markdown with goals, non-goals, workflows, data, risks, and acceptance criteria.",
      },
      null,
      2,
    ),
    "```",
  ].join("\n");
}

function buildPlanningIssuesStagePrompt(prd: OrchestrationPlanningPrd): string {
  return [
    "Decompose this PRD into implementation-ready planning issues.",
    "",
    `PRD id: ${prd.id}`,
    "",
    "When ready, finish with exactly one fenced JSON block using this shape. Dependencies must reference issue keys from the same JSON payload.",
    "```json",
    JSON.stringify(
      {
        type: "planning-issues-artifact",
        prdId: prd.id,
        issues: [
          {
            key: "ISSUE-1",
            title: "Narrow implementation issue",
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
    `# ${prd.title}`,
    "",
    prd.summaryMarkdown,
  ].join("\n");
}

function buildPlanningReviewerPrompt(input: {
  readonly prd: OrchestrationPlanningPrd;
  readonly issues: ReadonlyArray<OrchestrationPlanningIssue>;
  readonly cycleNumber: number;
}): string {
  return [
    `Review planning issue cycle ${input.cycleNumber} for PRD "${input.prd.title}".`,
    "",
    "Decide whether the issue set is complete against the PRD and available context, and whether the proposed issues are correct tracer-bullet vertical slices.",
    "",
    "Review for missing PRD coverage, incorrect horizontal slicing, oversized or undersized slices, incorrect dependency ordering, hidden prefactoring/migration/contract work, vague acceptance criteria, and missing expected tests.",
    "",
    "When ready, finish with exactly one fenced JSON block using this shape. Use the planning issue ids shown below.",
    "```json",
    JSON.stringify(
      {
        type: "planning-reviewer-verdict",
        cycleNumber: input.cycleNumber,
        passed: false,
        failingPlanningIssueIds: ["planning-issue-id"],
        dependencyFeedback: ["Dependency graph correction or empty array."],
        perIssueFeedback: [
          {
            issueId: "planning-issue-id",
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
    "## PRD",
    "",
    input.prd.summaryMarkdown,
    "",
    "## Planning Issues",
    "",
    input.issues
      .map((issue) => `#${issue.ordinal} ${issue.title}\nID: ${issue.id}\n${issue.bodyMarkdown}`)
      .join("\n\n"),
  ].join("\n");
}

function buildImplementationRun(input: {
  readonly runId: string;
  readonly orchestratorThreadId: ThreadId;
  readonly command: Extract<OrchestrationCommand, { type: "thread.implementation-run.launch" }>;
  readonly issues: ReadonlyArray<OrchestrationPlanningIssue>;
  readonly publisherUserId: string | null;
}): OrchestrationImplementationRun {
  const issueIds = input.issues.map((issue) => issue.id);
  const succeeded = new Set<string>();
  const issueStates = input.issues.map((issue) => {
    const dependencyIssueIds = issue.dependencies.map((dependency) => dependency.issueId);
    const ready = dependencyIssueIds.every((issueId) => succeeded.has(issueId));
    return {
      issueId: issue.id,
      status: ready ? ("ready" as const) : ("blocked" as const),
      dependencyIssueIds,
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
  const plannedWorkers = input.issues.map((issue) => ({
    issueId: issue.id,
    dependencyIssueIds: issue.dependencies.map((dependency) => dependency.issueId),
    branch: `${input.command.orchestratorBranch}/issue-${issue.ordinal}`,
    worktreePath: `${input.command.orchestratorWorktreePath}-issue-${issue.ordinal}`,
  }));
  return {
    id: input.runId,
    prdId: input.command.prdId,
    planningIssueIds: issueIds,
    orchestratorThreadId: input.orchestratorThreadId,
    status: "launch-pending",
    baseBranch: input.command.baseBranch,
    pinnedCommit: input.command.pinnedCommit,
    orchestratorBranch: input.command.orchestratorBranch,
    orchestratorWorktreePath: input.command.orchestratorWorktreePath,
    launchSummary: {
      prdId: input.command.prdId,
      planningIssueIds: issueIds,
      baseBranch: input.command.baseBranch,
      pinnedCommit: input.command.pinnedCommit,
      orchestratorBranch: input.command.orchestratorBranch,
      orchestratorWorktreePath: input.command.orchestratorWorktreePath,
      dependencyEdges: input.issues.flatMap((issue) =>
        issue.dependencies.map((dependency) => ({
          blockingIssueId: dependency.issueId,
          dependentIssueId: issue.id,
        })),
      ),
      initialReadyIssueIds: issueStates
        .filter((state) => state.status === "ready")
        .map((state) => state.issueId),
      plannedWorkers,
      validationCommands,
      finalDevReview: {
        required: true,
        completionBlocking: true,
        appDevStackSource: "orchestrator-worktree",
        autoStartAppDevStack: true,
        browserMcpProfile: "chrome-devtools",
        maxAttempts: 5,
      },
      createdAt: input.command.createdAt,
    },
    issueStates,
    workerResults: [],
    terminalLineageIssueIds: [],
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
      chromePath: null,
      mcpPackage: "chrome-devtools-mcp@latest",
      lastErrorMarkdown: null,
      checkedAt: "",
    },
    devReviewIds: [],
    devReviews: [],
    qaAttemptCount: 0,
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
        type: "thread.meta-updated",
        payload: {
          threadId: command.threadId,
          ...(command.ownerUserId !== undefined ? { ownerUserId: command.ownerUserId } : {}),
          ...(command.title !== undefined ? { title: command.title } : {}),
          ...(command.modelSelection !== undefined
            ? { modelSelection: command.modelSelection }
            : {}),
          ...(command.branch !== undefined ? { branch: command.branch } : {}),
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

    case "thread.planning-prd.create":
      return yield* decideOrchestrationCommand({
        readModel,
        command: {
          type: "thread.planning-stage.start",
          commandId: command.commandId,
          threadId: command.threadId,
          stage: "prd",
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
          detail: `Thread '${command.threadId}' is not a Product Grill root thread.`,
        });
      }

      const crypto = yield* Crypto.Crypto;
      const planningThreadUuid = yield* crypto.randomUUIDv4;
      const messageUuid = yield* crypto.randomUUIDv4;
      const planningThreadId = ThreadId.make(`thread-planning-orchestrator-${planningThreadUuid}`);
      const messageId = MessageId.make(`message-product-prd-stage-${messageUuid}`);
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
          stage: "prd-authoring",
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
          text: buildProductPlanningPrdStagePrompt(command),
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
          workflowPromptId: WORKFLOW_PROMPT_IDS.planningPrdCodex,
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
      if (thread.planningWorkflow?.prd !== null && thread.planningWorkflow?.prd !== undefined) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Thread '${command.threadId}' already has a PRD for this Planning Workflow.`,
        });
      }

      const crypto = yield* Crypto.Crypto;
      const messageUuid = yield* crypto.randomUUIDv4;
      const messageId = MessageId.make(`message-planning-prd-stage-${messageUuid}`);
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
          stage: "prd-authoring",
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
          text: buildPlanningPrdStagePrompt(),
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
          workflowPromptId: WORKFLOW_PROMPT_IDS.planningPrdCodex,
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

    case "thread.planning-prd.apply": {
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
      if (thread.planningWorkflow?.prd !== null && thread.planningWorkflow?.prd !== undefined) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Thread '${command.threadId}' already has a PRD for this Planning Workflow.`,
        });
      }
      const crypto = yield* Crypto.Crypto;
      const prdUuid = yield* crypto.randomUUIDv4;
      const issueMessageUuid = yield* crypto.randomUUIDv4;
      const prd = buildPlanningPrdFromArtifact({
        prdId: `prd-${prdUuid}`,
        threadId: thread.id,
        command,
      });
      const issueMessageId = MessageId.make(`message-planning-issues-stage-${issueMessageUuid}`);
      const prdCreatedEvent: PlannedOrchestrationEvent = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: thread.id,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.planning-prd-created",
        payload: {
          threadId: thread.id,
          prd,
          stage: "issues-authoring",
        },
      };
      const issuesPromptEvent: PlannedOrchestrationEvent = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: thread.id,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        causationEventId: prdCreatedEvent.eventId,
        type: "thread.message-sent",
        payload: {
          threadId: thread.id,
          messageId: issueMessageId,
          role: "user",
          text: buildPlanningIssuesStagePrompt(prd),
          turnId: null,
          streaming: false,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
      const issuesTurnStartRequestedEvent: PlannedOrchestrationEvent = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: thread.id,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        causationEventId: issuesPromptEvent.eventId,
        type: "thread.turn-start-requested",
        payload: {
          threadId: thread.id,
          messageId: issueMessageId,
          modelSelection: thread.modelSelection,
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
          workflowPromptId: WORKFLOW_PROMPT_IDS.planningIssuesCodex,
          createdAt: command.createdAt,
        },
      };
      return [prdCreatedEvent, issuesPromptEvent, issuesTurnStartRequestedEvent];
    }

    case "thread.planning-issues.apply": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const workflow = thread.planningWorkflow;
      const prd = workflow?.prd ?? null;
      if (thread.interactionMode !== "planning-workflow") {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Thread '${command.threadId}' is not in Planning Workflow mode.`,
        });
      }
      if (workflow === null || workflow === undefined || prd === null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Planning Thread '${thread.id}' does not have a PRD for Planning Issues.`,
        });
      }
      if (prd.id !== command.prdId) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Planning Issues artifact targets PRD '${command.prdId}', expected '${prd.id}'.`,
        });
      }
      const crypto = yield* Crypto.Crypto;
      const generatedIssueIds = yield* Effect.forEach(command.issues, () =>
        crypto.randomUUIDv4.pipe(Effect.map((uuid) => `planning-issue-${uuid}`)),
      );
      const issues = buildPlanningIssuesFromArtifact({
        prdId: prd.id,
        command,
        generatedIssueIds,
      });
      if (typeof issues === "string") {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: issues,
        });
      }
      const validationError = validatePlanningIssueGraph(prd.id, issues);
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
          workflow.stage === "issue-revision"
            ? "thread.planning-issues-revised"
            : "thread.planning-issues-created",
        payload:
          workflow.stage === "issue-revision"
            ? {
                threadId: thread.id,
                prdId: prd.id,
                issues,
                stage: "issue-review",
                revisedAt: command.createdAt,
              }
            : {
                threadId: thread.id,
                prdId: prd.id,
                issues,
                stage: "issue-review",
              },
      } satisfies PlannedOrchestrationEvent;
    }

    case "thread.planning-issue-review.request": {
      const planningThread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const workflow = planningThread.planningWorkflow;
      const prd = workflow?.prd ?? null;
      const issues = workflow?.issues ?? [];
      if (prd === null || workflow === null || workflow === undefined) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Planning Thread '${planningThread.id}' does not have a PRD to review.`,
        });
      }
      if (prd.id !== command.prdId) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Planning issue review requested PRD '${command.prdId}', expected '${prd.id}'.`,
        });
      }
      if (issues.length === 0) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Planning PRD '${prd.id}' has no Planning Issues to review.`,
        });
      }
      const validationError = validatePlanningIssueGraph(prd.id, issues);
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
        type: "thread.planning-issue-review-requested",
        payload: {
          threadId: planningThread.id,
          prdId: prd.id,
          cycleNumber,
          reviewerThreadId,
          reviewerMessageId,
          stage: "issue-review",
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
          title: `Review ${prd.title}`,
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
          text: buildPlanningReviewerPrompt({ prd, issues, cycleNumber }),
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
          workflowPromptId: WORKFLOW_PROMPT_IDS.planningIssueReviewerCodex,
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
      const prd = workflow?.prd ?? null;
      if (workflow === null || workflow === undefined || prd === null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Planning Thread '${planningThread.id}' does not have a PRD to review.`,
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
        type: "thread.planning-issues-revised",
        payload: {
          threadId: planningThread.id,
          prdId: prd.id,
          reviewCycle: {
            cycleNumber,
            status: passed ? "passed" : "failed",
            reviewerThreadId: command.reviewerThreadId,
            reviewerMessageId: command.reviewerMessageId,
            verdictMarkdown: command.verdictMarkdown,
            failingPlanningIssueIds: command.failingPlanningIssueIds ?? [],
            dependencyFeedback: command.dependencyFeedback ?? [],
            perIssueFeedback: command.perIssueFeedback ?? [],
            createdAt: command.createdAt,
          },
          issues: workflow.issues,
          stage: passed ? "completed" : "issue-revision",
          revisedAt: command.createdAt,
        },
      };
    }

    case "thread.planning-prd-bundle.load": {
      const targetThread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const embeddedBundle =
        command.bundle === undefined
          ? null
          : ({
              prd: {
                ...command.bundle.prd,
                issueCount: command.bundle.issues.length,
              },
              issues: command.bundle.issues,
              reviewCycles: command.bundle.reviewCycles,
              sourceThread: null,
            } satisfies OrchestrationPlanningPrdBundle & {
              readonly sourceThread: OrchestrationReadModel["threads"][number] | null;
            });
      const bundle = embeddedBundle ?? findPlanningBundleByPrdId(readModel, command.prdId);
      if (bundle === null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Planning PRD '${command.prdId}' is not visible to this environment.`,
        });
      }
      if (!optionalScopeMatches(command.tenantId, bundle.prd.tenantId)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Planning PRD '${command.prdId}' is not in tenant '${command.tenantId}'.`,
        });
      }
      if (!optionalScopeMatches(command.teamId, bundle.prd.teamId)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Planning PRD '${command.prdId}' is not in team '${command.teamId}'.`,
        });
      }
      if (
        bundle.sourceThread !== null &&
        bundle.sourceThread.projectId !== targetThread.projectId
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Planning PRD '${command.prdId}' belongs to a different project.`,
        });
      }
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.planning-prd-bundle-loaded",
        payload: {
          threadId: command.threadId,
          prdId: bundle.prd.id,
          sourceThreadId: bundle.prd.sourceThreadId,
          bundle: {
            prd: bundle.prd,
            issues: [...bundle.issues],
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
      const bundle = findPlanningBundleByPrdId(readModel, command.prdId);
      if (bundle === null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Planning PRD '${command.prdId}' is not visible to this environment.`,
        });
      }
      if (bundle.issues.length === 0) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Planning PRD '${command.prdId}' has no Planning Issues to implement.`,
        });
      }
      if (
        bundle.sourceThread !== null &&
        bundle.sourceThread.projectId !== launcherThread.projectId
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Planning PRD '${command.prdId}' belongs to a different project.`,
        });
      }
      const duplicateRun = readModel.implementationRuns.find(
        (run) =>
          run.prdId === command.prdId &&
          run.orchestratorBranch === command.orchestratorBranch &&
          run.status !== "canceled",
      );
      if (duplicateRun !== undefined) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Implementation Run '${duplicateRun.id}' already uses orchestrator branch '${command.orchestratorBranch}' for PRD '${command.prdId}'.`,
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
        issues: bundle.issues,
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
          title: `Implement ${bundle.prd.title}`,
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
        type: "thread.planning-prd-bundle-loaded",
        payload: {
          threadId: orchestratorThreadId,
          prdId: bundle.prd.id,
          sourceThreadId: bundle.prd.sourceThreadId,
          bundle: {
            prd: bundle.prd,
            issues: [...bundle.issues],
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
        replay: {
          status: "not-started" as const,
          eventCount: 0,
          startedAt: null,
          completedAt: null,
          durationMs: null,
          error: null,
        },
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
      return [threadCreatedEvent, reviewCreatedEvent, userMessageEvent, turnStartRequestedEvent];
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

    case "thread.dev-review.replay-metadata.update": {
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
        type: "thread.dev-review-replay-metadata-updated",
        payload: {
          threadId: command.threadId,
          reviewId: command.reviewId,
          sourceThreadId: review.sourceThreadId,
          reviewThreadId: review.reviewThreadId,
          replay: command.replay,
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
