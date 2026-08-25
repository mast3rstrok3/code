import {
  ApprovalRequestId,
  type AssistantDeliveryMode,
  CommandId,
  EventId,
  MessageId,
  type OrchestrationEvent,
  type OrchestrationMessage,
  type OrchestrationProposedPlanId,
  type OrchestrationThreadShell,
  CheckpointRef,
  classifyTaskAgentKind,
  isToolLifecycleItemType,
  ThreadId,
  type ThreadTokenUsageSnapshot,
  TurnId,
  type OrchestrationCheckpointSummary,
  type OrchestrationProposedPlan,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
  type ProviderRuntimeEvent,
  AppReviewId,
  WorkflowSubagentBatchId,
} from "@t3tools/contracts";
import * as Cache from "effect/Cache";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { makeKeyedDrainableWorker } from "@t3tools/shared/DrainableWorker";
import {
  expectedIntentKindForWorkflowPreset,
  isProductWorkflowRoot,
} from "@t3tools/shared/workflowPresets";

import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import { isGitRepository } from "../../git/Utils.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ThreadBackgroundLivenessService } from "../ThreadBackgroundLiveness.ts";
import { ThreadPlanProgressService } from "../ThreadPlanProgress.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  ProviderRuntimeIngestionService,
  type ProviderRuntimeIngestionShape,
} from "../Services/ProviderRuntimeIngestion.ts";
import { projectActivityPayload } from "../ActivityPayloadProjection.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  appendWorkflowSkillCommandSection,
  WORKFLOW_PROMPT_IDS,
} from "../../provider/WorkflowPromptRegistry.ts";
import {
  parseWorkflowDirectiveFromMarkdown,
  PLANNING_REVIEWER_TICKET_EDIT_RULES,
  planningReviewerVerdictExampleJson,
  type WorkflowDirective,
  type WorkflowAgentMessageTarget,
} from "../workflowDirectives.ts";
import {
  isWorkflowSubagentParentRoleAllowed,
  findWorkflowStepModels,
  resolveWorkflowStepModelSelection,
  resolveWorkflowSubagentSpawnDefinition,
} from "../workflowSubagents.ts";
import { canReplaceThreadTitle } from "../threadTitles.ts";

const providerTurnKey = (threadId: ThreadId, turnId: TurnId) => `${threadId}:${turnId}`;
const providerTaskKey = (threadId: ThreadId, taskId: string) => `${threadId}:${taskId}`;

// Fallback when the in-memory description cache no longer has the task name
// (server restart, session-exit sweep, TTL/capacity eviction): earlier
// task.started/task.progress activities for the task are persisted with it.
function findTaskTitleInActivities(
  activities: ReadonlyArray<OrchestrationThreadActivity> | undefined,
  taskId: string,
): string | undefined {
  if (!activities) {
    return undefined;
  }
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (!activity || (activity.kind !== "task.started" && activity.kind !== "task.progress")) {
      continue;
    }
    const payload =
      activity.payload && typeof activity.payload === "object"
        ? (activity.payload as { taskId?: unknown; title?: unknown; detail?: unknown })
        : undefined;
    if (payload?.taskId !== taskId) {
      continue;
    }
    const title =
      typeof payload.title === "string"
        ? payload.title
        : activity.kind === "task.started" && typeof payload.detail === "string"
          ? payload.detail
          : undefined;
    if (title && title.trim().length > 0) {
      return title;
    }
  }
  return undefined;
}

interface AssistantSegmentState {
  baseKey: string;
  nextSegmentIndex: number;
  activeMessageId: MessageId | null;
}

const TURN_MESSAGE_IDS_BY_TURN_CACHE_CAPACITY = 10_000;
const TURN_MESSAGE_IDS_BY_TURN_TTL = Duration.minutes(120);
const BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_CACHE_CAPACITY = 20_000;
const BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_TTL = Duration.minutes(120);
const BUFFERED_PROPOSED_PLAN_BY_ID_CACHE_CAPACITY = 10_000;
const BUFFERED_PROPOSED_PLAN_BY_ID_TTL = Duration.minutes(120);
const PROCESSED_WORKFLOW_DIRECTIVE_CACHE_CAPACITY = 10_000;
const PROCESSED_WORKFLOW_DIRECTIVE_TTL = Duration.minutes(120);
const TASK_DESCRIPTION_BY_TASK_CACHE_CAPACITY = 10_000;
const TASK_DESCRIPTION_BY_TASK_TTL = Duration.minutes(120);
const MAX_BUFFERED_ASSISTANT_CHARS = 24_000;
export const MAX_PRODUCT_INTENT_LOCK_REJECTION_BOUNCES = 3;
/**
 * How many times a planning reviewer may be handed the parser's complaint and asked to re-emit
 * before the cycle is failed. Two covers the shape mistakes that repeat across providers without
 * letting a reviewer that cannot produce a verdict at all stall the stage.
 */
export const MAX_PLANNING_REVIEWER_VERDICT_RETRIES = 2;
/**
 * How many times a planning root thread is handed its rejected Spec or Ticket artifact back for
 * re-emission. Past this the thread surfaces a needs-attention activity instead of retrying, so a
 * model that cannot produce the shape at all does not loop forever. Without any retry the stage
 * stalls silently: the rejection was only a server-side WARN while the thread sat "ready".
 */
export const MAX_PLANNING_ARTIFACT_RETRIES = 2;

/**
 * Server-synthesized user messages carry the `message-` prefix (see `serverMessageId` and the
 * hardcoded `message-*` ids in the workflow reactors/decider), while human clients generate bare
 * UUIDs (web `newMessageId`, mobile `commandMetadata`). The product intent gate relies on this
 * convention to tell a real human reply apart from server-authored prompts.
 */
const STRICT_PROVIDER_LIFECYCLE_GUARD = process.env.T3CODE_STRICT_PROVIDER_LIFECYCLE_GUARD !== "0";

type IngestionDomainEvent = Extract<
  OrchestrationEvent,
  {
    type:
      | "thread.turn-start-requested"
      | "thread.workflow-subagent-batch-child-updated"
      | "thread.app-review-updated";
  }
>;

type RuntimeIngestionInput =
  | {
      source: "runtime";
      event: ProviderRuntimeEvent;
    }
  | {
      source: "domain";
      event: IngestionDomainEvent;
    };

function toTurnId(value: TurnId | string | undefined): TurnId | undefined {
  return value === undefined ? undefined : TurnId.make(String(value));
}

function toApprovalRequestId(value: string | undefined): ApprovalRequestId | undefined {
  return value === undefined ? undefined : ApprovalRequestId.make(value);
}

function sameId(left: string | null | undefined, right: string | null | undefined): boolean {
  if (left === null || left === undefined || right === null || right === undefined) {
    return false;
  }
  return left === right;
}

function isPlanningArtifactThread(thread: {
  readonly interactionMode: string;
  readonly workflowRole: string | null;
}): boolean {
  return (
    thread.interactionMode === "planning-workflow" &&
    (thread.workflowRole === null || thread.workflowRole === "planning-orchestrator")
  );
}

function hasAssistantMessageForTurn(
  messages: ReadonlyArray<OrchestrationMessage>,
  turnId: TurnId,
  options?: { readonly streamingOnly?: boolean },
): boolean {
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message) {
      continue;
    }
    if (message.role !== "assistant" || message.turnId !== turnId) {
      continue;
    }
    if (options?.streamingOnly === true && !message.streaming) {
      continue;
    }
    return true;
  }
  return false;
}

function findLastAssistantMessageForTurn(
  messages: ReadonlyArray<OrchestrationMessage>,
  turnId: TurnId,
): OrchestrationMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "assistant" && message.turnId === turnId) {
      return message;
    }
  }
  return undefined;
}

function findMessageById(
  messages: ReadonlyArray<OrchestrationMessage>,
  messageId: MessageId,
): OrchestrationMessage | undefined {
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message?.id === messageId) {
      return message;
    }
  }
  return undefined;
}

function findProposedPlanById(
  proposedPlans: ReadonlyArray<
    Pick<OrchestrationProposedPlan, "id" | "createdAt" | "implementedAt" | "implementationThreadId">
  >,
  planId: string,
):
  | Pick<OrchestrationProposedPlan, "id" | "createdAt" | "implementedAt" | "implementationThreadId">
  | undefined {
  for (let index = 0; index < proposedPlans.length; index += 1) {
    const proposedPlan = proposedPlans[index];
    if (proposedPlan?.id === planId) {
      return proposedPlan;
    }
  }
  return undefined;
}

function hasCheckpointForTurn(
  checkpoints: ReadonlyArray<OrchestrationCheckpointSummary>,
  turnId: TurnId,
): boolean {
  for (let index = 0; index < checkpoints.length; index += 1) {
    if (checkpoints[index]?.turnId === turnId) {
      return true;
    }
  }
  return false;
}

function maxCheckpointTurnCount(
  checkpoints: ReadonlyArray<OrchestrationCheckpointSummary>,
): number {
  let maxTurnCount = 0;
  for (let index = 0; index < checkpoints.length; index += 1) {
    const checkpoint = checkpoints[index];
    if (checkpoint && checkpoint.checkpointTurnCount > maxTurnCount) {
      maxTurnCount = checkpoint.checkpointTurnCount;
    }
  }
  return maxTurnCount;
}

function truncateDetail(value: string, limit = 180): string {
  return value.length > limit ? `${value.slice(0, limit - 3)}...` : value;
}

function normalizeProposedPlanMarkdown(planMarkdown: string | undefined): string | undefined {
  const trimmed = planMarkdown?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed;
}

function hasRenderableAssistantText(text: string | undefined): boolean {
  return (text?.trim().length ?? 0) > 0;
}

function workflowDispatchErrorDetail(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return "Unknown workflow directive dispatch error";
}

function proposedPlanIdForTurn(threadId: ThreadId, turnId: TurnId): string {
  return `plan:${threadId}:turn:${turnId}`;
}

function proposedPlanIdFromEvent(event: ProviderRuntimeEvent, threadId: ThreadId): string {
  const turnId = toTurnId(event.turnId);
  if (turnId) {
    return proposedPlanIdForTurn(threadId, turnId);
  }
  if (event.itemId) {
    return `plan:${threadId}:item:${event.itemId}`;
  }
  return `plan:${threadId}:event:${event.eventId}`;
}

function assistantSegmentBaseKeyFromEvent(event: ProviderRuntimeEvent): string {
  return String(event.itemId ?? event.turnId ?? event.eventId);
}

function assistantSegmentMessageId(baseKey: string, segmentIndex: number): MessageId {
  return MessageId.make(
    segmentIndex === 0 ? `assistant:${baseKey}` : `assistant:${baseKey}:segment:${segmentIndex}`,
  );
}
function buildContextWindowActivityPayload(
  event: ProviderRuntimeEvent,
): ThreadTokenUsageSnapshot | undefined {
  if (event.type !== "thread.token-usage.updated" || event.payload.usage.usedTokens <= 0) {
    return undefined;
  }
  return event.payload.usage;
}

function normalizeRuntimeTurnState(
  value: string | undefined,
): "completed" | "failed" | "interrupted" | "cancelled" {
  switch (value) {
    case "failed":
    case "interrupted":
    case "cancelled":
    case "completed":
      return value;
    default:
      return "completed";
  }
}

/** Only a cleanly completed turn owes its workflow a final-result directive. */
export function turnOwesWorkflowDirective(
  event: Extract<ProviderRuntimeEvent, { readonly type: "turn.completed" | "turn.aborted" }>,
): boolean {
  return (
    event.type === "turn.completed" &&
    normalizeRuntimeTurnState(event.payload.state) === "completed"
  );
}

function orchestrationSessionStatusFromRuntimeState(
  state: "starting" | "running" | "waiting" | "ready" | "interrupted" | "stopped" | "error",
): "starting" | "running" | "ready" | "interrupted" | "stopped" | "error" {
  switch (state) {
    case "starting":
      return "starting";
    case "running":
    case "waiting":
      return "running";
    case "ready":
      return "ready";
    case "interrupted":
      return "interrupted";
    case "stopped":
      return "stopped";
    case "error":
      return "error";
  }
}

function sessionStatusAllowsActiveTurn(
  status: ReturnType<typeof orchestrationSessionStatusFromRuntimeState>,
): boolean {
  return status === "starting" || status === "running";
}

function requestKindFromCanonicalRequestType(
  requestType: string | undefined,
): "command" | "file-read" | "file-change" | undefined {
  switch (requestType) {
    case "command_execution_approval":
    case "exec_command_approval":
      return "command";
    case "file_read_approval":
      return "file-read";
    case "file_change_approval":
    case "apply_patch_approval":
      return "file-change";
    default:
      return undefined;
  }
}

/**
 * Copies the optional TaskAgentLinkage bundle from a task.* runtime payload
 * into the persisted activity payload. Identity fields ride on every row so
 * client folds survive activity retention; absent fields stay absent.
 */
function taskLinkageActivityFields(payload: Record<string, unknown>): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    // Server-stamped classification: persisted rows are self-describing, so
    // clients trust the stamp instead of re-deriving agent-vs-background
    // from taskType denylists and marker heuristics (legacy rows without a
    // stamp keep the client fallback).
    agentKind: classifyTaskAgentKind({
      taskType: typeof payload.taskType === "string" ? payload.taskType : undefined,
      agentId: typeof payload.agentId === "string" ? payload.agentId : undefined,
    }),
  };
  for (const key of [
    "taskType",
    "agentId",
    "title",
    "role",
    "model",
    "effort",
    "toolUseId",
    "parentAgentId",
    "workflowName",
    "agentIndex",
    "phaseIndex",
    "phaseTitle",
    "phases",
    "attempt",
    "runHandles",
    "outputFile",
    "agentPath",
    "timelineBypass",
    "typedUsage",
    "status",
    "error",
  ] as const) {
    if (payload[key] !== undefined) {
      fields[key] = payload[key];
    }
  }
  return fields;
}

export function runtimeEventToActivities(
  event: ProviderRuntimeEvent,
  taskTitle?: string,
): ReadonlyArray<OrchestrationThreadActivity> {
  const maybeSequence = (() => {
    const eventWithSequence = event as ProviderRuntimeEvent & { sessionSequence?: number };
    return eventWithSequence.sessionSequence !== undefined
      ? { sequence: eventWithSequence.sessionSequence }
      : {};
  })();
  switch (event.type) {
    case "request.opened": {
      if (event.payload.requestType === "tool_user_input") {
        return [];
      }
      const requestKind = requestKindFromCanonicalRequestType(event.payload.requestType);
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "approval",
          kind: "approval.requested",
          summary:
            requestKind === "command"
              ? "Command approval requested"
              : requestKind === "file-read"
                ? "File-read approval requested"
                : requestKind === "file-change"
                  ? "File-change approval requested"
                  : "Approval requested",
          payload: {
            requestId: toApprovalRequestId(event.requestId),
            ...(requestKind ? { requestKind } : {}),
            requestType: event.payload.requestType,
            ...(event.payload.detail ? { detail: event.payload.detail } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "request.resolved": {
      if (event.payload.requestType === "tool_user_input") {
        return [];
      }
      const requestKind = requestKindFromCanonicalRequestType(event.payload.requestType);
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "approval",
          kind: "approval.resolved",
          summary: "Approval resolved",
          payload: {
            requestId: toApprovalRequestId(event.requestId),
            ...(requestKind ? { requestKind } : {}),
            requestType: event.payload.requestType,
            ...(event.payload.decision ? { decision: event.payload.decision } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "runtime.error": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "error",
          kind: "runtime.error",
          summary: "Runtime error",
          payload: {
            message: truncateDetail(event.payload.message),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "tool.denied": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "error",
          kind: "tool.denied",
          summary: `Tool denied: ${event.payload.toolName}`,
          payload: {
            toolName: event.payload.toolName,
            ...(event.payload.toolUseId ? { toolUseId: event.payload.toolUseId } : {}),
            ...(event.payload.reason ? { detail: truncateDetail(event.payload.reason) } : {}),
            ...(event.payload.agentId ? { agentId: event.payload.agentId } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "runtime.warning": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "runtime.warning",
          // Use the adapter-supplied message as the row label so the work log
          // shows what the warning was about, not a generic "Runtime warning".
          summary: truncateDetail(event.payload.message, 120),
          payload: {
            message: truncateDetail(event.payload.message),
            ...(event.payload.detail !== undefined ? { detail: event.payload.detail } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "turn.plan.updated": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "turn.plan.updated",
          summary: "Plan updated",
          payload: {
            plan: event.payload.plan,
            ...(event.payload.explanation !== undefined
              ? { explanation: event.payload.explanation }
              : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "user-input.requested": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "user-input.requested",
          summary: "User input requested",
          payload: {
            ...(event.requestId ? { requestId: event.requestId } : {}),
            questions: event.payload.questions,
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "user-input.resolved": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "user-input.resolved",
          summary: "User input submitted",
          payload: {
            ...(event.requestId ? { requestId: event.requestId } : {}),
            answers: event.payload.answers,
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "task.started": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "task.started",
          summary:
            event.payload.taskType === "plan"
              ? "Plan task started"
              : event.payload.taskType
                ? `${event.payload.taskType} task started`
                : "Task started",
          payload: {
            taskId: event.payload.taskId,
            ...(event.payload.taskType ? { taskType: event.payload.taskType } : {}),
            ...(event.payload.description
              ? { detail: truncateDetail(event.payload.description) }
              : {}),
            ...taskLinkageActivityFields(event.payload as Record<string, unknown>),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "task.progress": {
      const linkage = taskLinkageActivityFields(event.payload as Record<string, unknown>);
      // Usage and activity are independent latest-state streams. Keeping them
      // under separate stable ids prevents a command/reasoning update from
      // replacing the last known token count (and prevents a usage-only tick
      // from blanking the last meaningful activity).
      const identityLinkage = { ...linkage };
      delete identityLinkage.typedUsage;
      delete identityLinkage.status;
      delete identityLinkage.error;
      const title =
        event.payload.description.trim().length > 0
          ? { title: truncateDetail(event.payload.description, 120) }
          : {};
      const hasProgressState =
        event.payload.typedUsage === undefined ||
        event.payload.summary !== undefined ||
        event.payload.lastToolName !== undefined ||
        event.payload.status !== undefined ||
        event.payload.error !== undefined;
      return [
        ...(hasProgressState
          ? [
              {
                // Stable per-task id: activity is "latest state", not
                // history, so each meaningful tick replaces the last. This
                // bounds a large fleet to one activity row per task.
                id: EventId.make(`task-progress:${event.threadId}:${event.payload.taskId}`),
                createdAt: event.createdAt,
                tone: "info" as const,
                kind: "task.progress" as const,
                summary:
                  event.payload.description.trim().length > 0
                    ? truncateDetail(event.payload.description, 120)
                    : "Reasoning update",
                payload: {
                  taskId: event.payload.taskId,
                  ...title,
                  detail: truncateDetail(event.payload.summary ?? event.payload.description),
                  ...(event.payload.summary
                    ? { summary: truncateDetail(event.payload.summary) }
                    : {}),
                  ...(event.payload.lastToolName
                    ? { lastToolName: event.payload.lastToolName }
                    : {}),
                  ...(event.payload.status ? { status: event.payload.status } : {}),
                  ...(event.payload.error ? { error: event.payload.error } : {}),
                  ...(event.payload.usage !== undefined ? { usage: event.payload.usage } : {}),
                  ...identityLinkage,
                },
                turnId: toTurnId(event.turnId) ?? null,
                ...maybeSequence,
              },
            ]
          : []),
        ...(event.payload.typedUsage !== undefined
          ? [
              {
                id: EventId.make(`task-usage:${event.threadId}:${event.payload.taskId}`),
                createdAt: event.createdAt,
                tone: "info" as const,
                kind: "task.progress" as const,
                summary: "Task usage updated",
                payload: {
                  taskId: event.payload.taskId,
                  ...title,
                  ...identityLinkage,
                  usageSnapshot: true,
                  typedUsage: event.payload.typedUsage,
                },
                turnId: toTurnId(event.turnId) ?? null,
                ...maybeSequence,
              },
            ]
          : []),
      ];
    }

    case "task.updated": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: event.payload.status === "failed" ? "error" : "info",
          kind: "task.updated",
          summary:
            event.payload.status === "failed"
              ? "Task failed"
              : event.payload.status
                ? `Task ${event.payload.status}`
                : "Task updated",
          payload: {
            taskId: event.payload.taskId,
            ...(event.payload.description
              ? { detail: truncateDetail(event.payload.description) }
              : {}),
            ...(event.payload.endedAt ? { endedAt: event.payload.endedAt } : {}),
            ...(event.payload.isBackgrounded !== undefined
              ? { isBackgrounded: event.payload.isBackgrounded }
              : {}),
            ...taskLinkageActivityFields(event.payload as Record<string, unknown>),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "tool.progress": {
      // Only agent-owned heartbeats are persisted: they feed the owning
      // agent's activity line. Parent-conversation tool progress stays
      // ephemeral (item lifecycle already covers it).
      if (event.payload.taskId === undefined) {
        return [];
      }
      return [
        {
          // Same stable-id treatment as task.progress: a heartbeat is
          // "what is this agent doing right now", so one row per task
          // (thread-scoped for the same global-PK collision reason).
          id: EventId.make(`tool-progress:${event.threadId}:${event.payload.taskId}`),
          createdAt: event.createdAt,
          tone: "info",
          kind: "tool.progress",
          summary: event.payload.toolName ?? "Tool progress",
          payload: {
            taskId: event.payload.taskId,
            ...(event.payload.toolName ? { toolName: event.payload.toolName } : {}),
            ...(event.payload.toolUseId ? { toolUseId: event.payload.toolUseId } : {}),
            ...(event.payload.elapsedSeconds !== undefined
              ? { elapsedSeconds: event.payload.elapsedSeconds }
              : {}),
            ...(event.payload.parentToolUseId
              ? { parentToolUseId: event.payload.parentToolUseId }
              : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "task.completed": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: event.payload.status === "failed" ? "error" : "info",
          kind: "task.completed",
          summary:
            event.payload.status === "failed"
              ? "Task failed"
              : event.payload.status === "stopped"
                ? "Task stopped"
                : "Task completed",
          payload: {
            taskId: event.payload.taskId,
            status: event.payload.status,
            ...(taskTitle ? { title: truncateDetail(taskTitle, 120) } : {}),
            // summary + detail mirror task.progress: clients label the row from
            // summary and keep detail for the preview/expanded body.
            ...(event.payload.summary
              ? {
                  summary: truncateDetail(event.payload.summary),
                  detail: truncateDetail(event.payload.summary),
                }
              : {}),
            ...(event.payload.usage !== undefined ? { usage: event.payload.usage } : {}),
            ...taskLinkageActivityFields(event.payload as Record<string, unknown>),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "thread.state.changed": {
      if (event.payload.state !== "compacted") {
        return [];
      }

      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "context-compaction",
          summary: "Context compacted",
          payload: {
            state: event.payload.state,
            ...(event.payload.detail !== undefined ? { detail: event.payload.detail } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "thread.token-usage.updated": {
      const payload = buildContextWindowActivityPayload(event);
      if (!payload) {
        return [];
      }

      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "context-window.updated",
          summary: "Context window updated",
          payload,
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "item.updated": {
      if (!isToolLifecycleItemType(event.payload.itemType)) {
        return [];
      }
      // A streaming update's `data` carries the full tool output accumulated
      // so far (adapters merge state forward), and a new activity is emitted
      // per chunk, so persisting `data` verbatim writes O(N²) bytes per tool
      // call into both the event store and the projection table. No reader
      // needs it: ws.ts and http.ts apply `projectActivityPayload` before any
      // payload reaches a client. Persist the projected form for non-terminal
      // updates; `item.completed` below still persists the full payload.
      return [
        projectActivityPayload({
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "tool",
          kind: "tool.updated",
          summary: event.payload.title ?? "Tool updated",
          payload: {
            itemType: event.payload.itemType,
            ...(event.itemId !== undefined ? { toolCallId: event.itemId } : {}),
            ...(event.payload.status ? { status: event.payload.status } : {}),
            ...(event.payload.detail ? { detail: truncateDetail(event.payload.detail) } : {}),
            ...(event.payload.data !== undefined ? { data: event.payload.data } : {}),
            ...(event.payload.agentId ? { agentId: event.payload.agentId } : {}),
            ...(event.payload.parentToolUseId
              ? { parentToolUseId: event.payload.parentToolUseId }
              : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        }),
      ];
    }

    case "item.completed": {
      if (!isToolLifecycleItemType(event.payload.itemType)) {
        return [];
      }
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "tool",
          kind: "tool.completed",
          summary: event.payload.title ?? "Tool",
          payload: {
            itemType: event.payload.itemType,
            ...(event.itemId !== undefined ? { toolCallId: event.itemId } : {}),
            ...(event.payload.status ? { status: event.payload.status } : {}),
            ...(event.payload.detail ? { detail: truncateDetail(event.payload.detail) } : {}),
            ...(event.payload.data !== undefined ? { data: event.payload.data } : {}),
            ...(event.payload.agentId ? { agentId: event.payload.agentId } : {}),
            ...(event.payload.parentToolUseId
              ? { parentToolUseId: event.payload.parentToolUseId }
              : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "item.started": {
      if (!isToolLifecycleItemType(event.payload.itemType)) {
        return [];
      }
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "tool",
          kind: "tool.started",
          summary: `${event.payload.title ?? "Tool"} started`,
          payload: {
            itemType: event.payload.itemType,
            ...(event.itemId !== undefined ? { toolCallId: event.itemId } : {}),
            ...(event.payload.status ? { status: event.payload.status } : {}),
            ...(event.payload.detail ? { detail: truncateDetail(event.payload.detail) } : {}),
            ...(event.payload.data !== undefined ? { data: event.payload.data } : {}),
            ...(event.payload.agentId ? { agentId: event.payload.agentId } : {}),
            ...(event.payload.parentToolUseId
              ? { parentToolUseId: event.payload.parentToolUseId }
              : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    default:
      break;
  }

  return [];
}

const make = Effect.gen(function* () {
  const threadBackgroundLiveness = yield* ThreadBackgroundLivenessService;
  const threadPlanProgress = yield* ThreadPlanProgressService;
  const crypto = yield* Crypto.Crypto;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const providerService = yield* ProviderService;
  const projectionTurnRepository = yield* ProjectionTurnRepository;
  const serverSettingsService = yield* ServerSettingsService;
  const providerCommandId = (event: ProviderRuntimeEvent, tag: string) =>
    crypto.randomUUIDv4.pipe(
      Effect.map((uuid) => CommandId.make(`provider:${event.eventId}:${tag}:${uuid}`)),
    );
  const serverMessageId = (tag: string) =>
    crypto.randomUUIDv4.pipe(Effect.map((uuid) => MessageId.make(`message-${tag}-${uuid}`)));
  const workflowBatchId = (threadId: ThreadId, messageId: MessageId) =>
    WorkflowSubagentBatchId.make(`workflow-batch:${threadId}:${messageId}`);
  const workflowChildThreadId = (batchId: WorkflowSubagentBatchId, childIndex: number) =>
    ThreadId.make(`workflow-child:${batchId}:${childIndex}`);
  const workflowChildMessageId = (batchId: WorkflowSubagentBatchId, childIndex: number) =>
    MessageId.make(`workflow-child-message:${batchId}:${childIndex}`);
  const workflowChildReviewId = (batchId: WorkflowSubagentBatchId, childIndex: number) =>
    AppReviewId.make(`workflow-child-review:${batchId}:${childIndex}`);
  const workflowCommandId = (batchId: WorkflowSubagentBatchId, tag: string, childIndex?: number) =>
    CommandId.make(`workflow:${batchId}:${tag}${childIndex === undefined ? "" : `:${childIndex}`}`);

  const turnMessageIdsByTurnKey = yield* Cache.make<string, Set<MessageId>>({
    capacity: TURN_MESSAGE_IDS_BY_TURN_CACHE_CAPACITY,
    timeToLive: TURN_MESSAGE_IDS_BY_TURN_TTL,
    lookup: () => Effect.succeed(new Set<MessageId>()),
  });

  const bufferedAssistantTextByMessageId = yield* Cache.make<MessageId, string>({
    capacity: BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_CACHE_CAPACITY,
    timeToLive: BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_TTL,
    lookup: () => Effect.succeed(""),
  });

  const assistantSegmentStateByTurnKey = yield* Cache.make<string, AssistantSegmentState>({
    capacity: TURN_MESSAGE_IDS_BY_TURN_CACHE_CAPACITY,
    timeToLive: TURN_MESSAGE_IDS_BY_TURN_TTL,
    lookup: () =>
      Effect.die(
        new Error("assistant segment state should be read through getOption before initialization"),
      ),
  });

  const bufferedProposedPlanById = yield* Cache.make<string, { text: string; createdAt: string }>({
    capacity: BUFFERED_PROPOSED_PLAN_BY_ID_CACHE_CAPACITY,
    timeToLive: BUFFERED_PROPOSED_PLAN_BY_ID_TTL,
    lookup: () => Effect.succeed({ text: "", createdAt: "" }),
  });

  const processedWorkflowDirectiveKeys = yield* Cache.make<string, boolean>({
    capacity: PROCESSED_WORKFLOW_DIRECTIVE_CACHE_CAPACITY,
    timeToLive: PROCESSED_WORKFLOW_DIRECTIVE_TTL,
    lookup: () => Effect.succeed(false),
  });

  // Task names arrive on task.started/task.progress but not on task.completed,
  // so remember them per task to title the completion activity.
  const taskDescriptionByTaskKey = yield* Cache.make<string, string>({
    capacity: TASK_DESCRIPTION_BY_TASK_CACHE_CAPACITY,
    timeToLive: TASK_DESCRIPTION_BY_TASK_TTL,
    lookup: () => Effect.succeed(""),
  });

  const rememberTaskDescription = (threadId: ThreadId, taskId: string, description: string) =>
    Cache.set(taskDescriptionByTaskKey, providerTaskKey(threadId, taskId), description);

  // Entries are left in place after completion so replayed or duplicate
  // terminal events stay titled; TTL, capacity, and the session-exit sweep
  // bound the cache.
  const lookupTaskDescription = (threadId: ThreadId, taskId: string) =>
    Cache.getOption(taskDescriptionByTaskKey, providerTaskKey(threadId, taskId)).pipe(
      Effect.map((description) =>
        Option.filter(description, (value) => value.length > 0).pipe(Option.getOrUndefined),
      ),
    );

  const resolveThreadDetail = Effect.fn("resolveThreadDetail")(function* (threadId: ThreadId) {
    return yield* projectionSnapshotQuery
      .getThreadDetailById(threadId)
      .pipe(Effect.map(Option.getOrUndefined));
  });

  const resolveThreadShell = Effect.fn("resolveThreadShell")(function* (threadId: ThreadId) {
    return yield* projectionSnapshotQuery
      .getThreadShellById(threadId)
      .pipe(Effect.map(Option.getOrUndefined));
  });

  const terminalWorkflowSubagentStatuses = new Set([
    "completed",
    "blocked",
    "rejected",
    "failed",
    "canceled",
  ]);

  const maybeCompleteWorkflowSubagentBatch = Effect.fn(
    "ProviderRuntimeIngestion.maybeCompleteWorkflowSubagentBatch",
  )(function* (parentThreadId: ThreadId, batchId: WorkflowSubagentBatchId, completedAt: string) {
    const parent = yield* resolveThreadDetail(parentThreadId);
    const batch = parent?.workflowSubagentBatches?.find((entry) => entry.id === batchId);
    if (
      !parent ||
      !batch ||
      batch.status === "completed" ||
      batch.children.some((child) => !terminalWorkflowSubagentStatuses.has(child.status))
    ) {
      return;
    }

    const aggregateMarkdown = [
      `Workflow sub-agent batch '${batch.id}' finished.`,
      "",
      ...batch.children
        .toSorted((left, right) => left.index - right.index)
        .flatMap((child) => [
          `## ${child.index + 1}. ${child.title}`,
          `- Status: ${child.status}`,
          `- Source thread: ${child.childThreadId ?? "not created"}`,
          ...(child.appReviewId === null ? [] : [`- App Review: ${child.appReviewId}`]),
          "",
          child.resultMarkdown ?? child.failureDetail ?? "No result detail was provided.",
          "",
        ]),
    ].join("\n");

    yield* orchestrationEngine
      .dispatch({
        type: "thread.workflow-subagent-batch.complete",
        commandId: workflowCommandId(batch.id, "complete"),
        threadId: parent.id,
        batchId: batch.id,
        message: {
          messageId: MessageId.make(`workflow-batch-result:${batch.id}`),
          role: "user",
          text: aggregateMarkdown,
          attachments: [],
        },
        runtimeMode: parent.runtimeMode,
        interactionMode: parent.interactionMode,
        completedAt,
        createdAt: completedAt,
      })
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logDebug("workflow sub-agent batch completion was already handled", {
            batchId,
            cause: Cause.pretty(cause),
          }),
        ),
      );
  });

  const completeFullAppReviewBatchChild = Effect.fn(
    "ProviderRuntimeIngestion.completeFullAppReviewBatchChild",
  )(function* (reviewId: AppReviewId, completedAt: string) {
    const snapshot = yield* projectionSnapshotQuery.getCommandReadModel();
    const parent = snapshot.threads.find((thread) =>
      thread.workflowSubagentBatches?.some((batch) =>
        batch.children.some((child) => child.appReviewId === reviewId),
      ),
    );
    const batch = parent?.workflowSubagentBatches?.find((entry) =>
      entry.children.some((child) => child.appReviewId === reviewId),
    );
    const child = batch?.children.find((entry) => entry.appReviewId === reviewId);
    const review = parent?.appReviews.find((entry) => entry.id === reviewId);
    if (
      !parent ||
      !batch ||
      !child ||
      child.status !== "running" ||
      !review ||
      !["passed", "failed", "blocked"].includes(review.status)
    ) {
      return;
    }
    const document = review.document;
    const resultMarkdown = [
      `Verdict: ${document.verdict}`,
      document.summary,
      document.checks.length === 0
        ? ""
        : `Checks:\n${document.checks.map((check) => `- ${check.label}: ${check.status} — ${check.notes}`).join("\n")}`,
      document.findings.length === 0
        ? ""
        : `Findings:\n${document.findings.map((finding) => `- [${finding.severity}] ${finding.title}: ${finding.details}`).join("\n")}`,
    ]
      .filter((entry) => entry.length > 0)
      .join("\n\n");
    yield* orchestrationEngine.dispatch({
      type: "thread.workflow-subagent-batch.child.complete",
      commandId: workflowCommandId(batch.id, `app-review:${review.id}`, child.index),
      threadId: parent.id,
      batchId: batch.id,
      childIndex: child.index,
      status: "completed",
      resultMarkdown,
      completedAt,
      createdAt: completedAt,
    });
  });

  const settleRunningBatchChildAfterTermination = Effect.fn(
    "ProviderRuntimeIngestion.settleRunningBatchChildAfterTermination",
  )(function* (
    thread: OrchestrationThreadShell,
    completedAt: string,
    status: "failed" | "canceled",
    detail: string,
  ) {
    const provenance = thread.workflowSubagentBatchProvenance;
    if (provenance == null || thread.parentThreadId === null) return;
    const parent = yield* resolveThreadDetail(thread.parentThreadId);
    const batch = parent?.workflowSubagentBatches?.find((entry) => entry.id === provenance.batchId);
    const child = batch?.children.find((entry) => entry.index === provenance.childIndex);
    if (!parent || !batch || !child || child.status !== "running") return;

    if (child.appReviewMode === "full" && child.appReviewId !== null) {
      const review = parent.appReviews.find((entry) => entry.id === child.appReviewId);
      if (review && ["passed", "failed"].includes(review.status)) {
        yield* completeFullAppReviewBatchChild(review.id, completedAt);
        return;
      }
      if (review) {
        yield* orchestrationEngine.dispatch({
          type: "thread.app-review.update",
          commandId: workflowCommandId(batch.id, "app-review-missing-evidence", child.index),
          threadId: parent.id,
          reviewId: review.id,
          status: "failed",
          document: {
            ...review.document,
            verdict: "failed",
            summary:
              review.document.summary ||
              "Full Browser App Review ended without the required terminal evidence.",
          },
          updatedAt: completedAt,
          createdAt: completedAt,
        });
        return;
      }
    }
    yield* orchestrationEngine.dispatch({
      type: "thread.workflow-subagent-batch.child.fail",
      commandId: workflowCommandId(batch.id, `terminated:${status}`, child.index),
      threadId: parent.id,
      batchId: batch.id,
      childIndex: child.index,
      status,
      failureDetail: detail,
      completedAt,
      createdAt: completedAt,
    });
  });

  const settleCanonicalAppReviewAfterTermination = Effect.fn(
    "ProviderRuntimeIngestion.settleCanonicalAppReviewAfterTermination",
  )(function* (input: {
    readonly event: ProviderRuntimeEvent;
    readonly thread: OrchestrationThreadShell;
    readonly completedAt: string;
  }) {
    if (
      input.thread.workflowRole !== "implementation-qa-reviewer" ||
      input.thread.parentThreadId === null
    ) {
      return;
    }
    const [reviewer, parent] = yield* Effect.all([
      resolveThreadDetail(input.thread.id),
      resolveThreadDetail(input.thread.parentThreadId),
    ]);
    const canonical = parent?.appReviews.find(
      (review) => review.reviewThreadId === input.thread.id && review.status === "running",
    );
    if (reviewer === undefined || parent === undefined || canonical === undefined) return;

    const nestedTerminal = [...reviewer.appReviews]
      .filter((review) => review.status === "passed" || review.status === "failed")
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
    if (nestedTerminal !== undefined) {
      yield* orchestrationEngine.dispatch({
        type: "thread.app-review.evidence.update",
        commandId: yield* providerCommandId(input.event, "canonical-review-adopt-evidence"),
        threadId: parent.id,
        reviewId: canonical.id,
        evidence: nestedTerminal.evidence,
        updatedAt: input.completedAt,
        createdAt: input.completedAt,
      });
    }
    yield* orchestrationEngine.dispatch({
      type: "thread.app-review.update",
      commandId: yield* providerCommandId(input.event, "canonical-review-settle"),
      threadId: parent.id,
      reviewId: canonical.id,
      status: nestedTerminal?.status ?? "failed",
      document: nestedTerminal?.document ?? {
        ...canonical.document,
        verdict: "failed",
        summary:
          canonical.document.summary ||
          "Browser App Review agent completed without terminally updating its canonical review.",
      },
      updatedAt: input.completedAt,
      createdAt: input.completedAt,
    });
  });

  const appendWorkflowDirectiveRejectedActivity = Effect.fn(
    "ProviderRuntimeIngestion.appendWorkflowDirectiveRejectedActivity",
  )(function* (input: {
    readonly event: ProviderRuntimeEvent;
    readonly threadId: ThreadId;
    readonly directiveType: string;
    readonly summary: string;
    readonly detail: string;
    readonly createdAt: string;
  }) {
    yield* orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: yield* providerCommandId(input.event, "workflow-directive-rejected"),
      threadId: input.threadId,
      activity: {
        id: EventId.make(yield* crypto.randomUUIDv4),
        tone: "error",
        kind: "workflow.directive.rejected",
        summary: input.summary,
        payload: {
          directiveType: input.directiveType,
          detail: input.detail,
        },
        turnId: null,
        createdAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });
  });

  const appendWorkflowSubagentModelFallbackActivity = Effect.fn(
    "ProviderRuntimeIngestion.appendWorkflowSubagentModelFallbackActivity",
  )(function* (input: {
    readonly event: ProviderRuntimeEvent;
    readonly threadId: ThreadId;
    readonly workflowPromptId: string;
    readonly detail: string;
    readonly requestedDriver: string | null;
    readonly requestedModel: string | null;
    readonly createdAt: string;
  }) {
    yield* orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: yield* providerCommandId(input.event, "workflow-subagent-model-fallback"),
      threadId: input.threadId,
      activity: {
        id: EventId.make(yield* crypto.randomUUIDv4),
        tone: "info",
        kind: "workflow.subagent.model-fallback",
        summary: "Workflow sub-agent model hardlock not honored",
        payload: {
          workflowPromptId: input.workflowPromptId,
          detail: input.detail,
          requestedDriver: input.requestedDriver,
          requestedModel: input.requestedModel,
        },
        turnId: null,
        createdAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });
  });

  const listActiveThreadShells = Effect.fn("ProviderRuntimeIngestion.listActiveThreadShells")(
    function* () {
      const snapshot = yield* projectionSnapshotQuery.getShellSnapshot();
      return snapshot.threads;
    },
  );

  function isDescendantThread(
    candidateThreadId: ThreadId,
    ancestorThreadId: ThreadId,
    threads: ReadonlyArray<OrchestrationThreadShell>,
  ): boolean {
    const threadById = new Map(threads.map((thread) => [thread.id, thread]));
    const seenThreadIds = new Set<string>();
    let current = threadById.get(candidateThreadId);
    while (current && current.parentThreadId !== null) {
      if (current.parentThreadId === ancestorThreadId) {
        return true;
      }
      if (seenThreadIds.has(current.id)) {
        return false;
      }
      seenThreadIds.add(current.id);
      current = threadById.get(current.parentThreadId);
    }
    return false;
  }

  const resolveWorkflowAgentMessageTarget = Effect.fn(
    "ProviderRuntimeIngestion.resolveWorkflowAgentMessageTarget",
  )(function* (input: {
    readonly sourceThread: OrchestrationThreadShell;
    readonly target: WorkflowAgentMessageTarget;
  }) {
    const threads = yield* listActiveThreadShells();
    const requestedTarget = input.target;
    if ("threadId" in requestedTarget) {
      const requestedThreadId = requestedTarget.threadId;
      const targetThread = threads.find((thread) => thread.id === requestedThreadId);
      if (!targetThread) {
        return {
          kind: "error" as const,
          detail: `Target thread '${requestedThreadId}' was not found or is not active.`,
        };
      }
      const allowed =
        targetThread.id === input.sourceThread.id ||
        input.sourceThread.parentThreadId === targetThread.id ||
        isDescendantThread(targetThread.id, input.sourceThread.id, threads);
      return allowed
        ? { kind: "resolved" as const, thread: targetThread }
        : {
            kind: "error" as const,
            detail: "Target thread must be the current thread, the direct parent, or a descendant.",
          };
    }

    if (requestedTarget.relation === "parent") {
      const parentThreadId = input.sourceThread.parentThreadId;
      if (parentThreadId === null) {
        return {
          kind: "error" as const,
          detail: `Thread '${input.sourceThread.id}' does not have a parent thread.`,
        };
      }
      const parentThread = threads.find((thread) => thread.id === parentThreadId);
      return parentThread
        ? { kind: "resolved" as const, thread: parentThread }
        : {
            kind: "error" as const,
            detail: `Parent thread '${parentThreadId}' was not found or is not active.`,
          };
    }

    const requestedWorkflowRole = requestedTarget.workflowRole;
    const childThreads = threads.filter(
      (thread) =>
        thread.parentThreadId === input.sourceThread.id &&
        thread.workflowRole === requestedWorkflowRole,
    );
    if (childThreads.length === 0) {
      return {
        kind: "error" as const,
        detail: `No direct child thread with workflowRole '${requestedWorkflowRole}' was found.`,
      };
    }
    if (childThreads.length > 1) {
      return {
        kind: "error" as const,
        detail: `Multiple direct child threads with workflowRole '${requestedWorkflowRole}' were found; target by threadId instead.`,
      };
    }
    const childThread = childThreads[0];
    if (!childThread) {
      return {
        kind: "error" as const,
        detail: `No direct child thread with workflowRole '${requestedWorkflowRole}' was found.`,
      };
    }
    return { kind: "resolved" as const, thread: childThread };
  });

  const rememberAssistantMessageId = (threadId: ThreadId, turnId: TurnId, messageId: MessageId) =>
    Cache.getOption(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId)).pipe(
      Effect.flatMap((existingIds) =>
        Cache.set(
          turnMessageIdsByTurnKey,
          providerTurnKey(threadId, turnId),
          Option.match(existingIds, {
            onNone: () => new Set([messageId]),
            onSome: (ids) => {
              const nextIds = new Set(ids);
              nextIds.add(messageId);
              return nextIds;
            },
          }),
        ),
      ),
    );

  const forgetAssistantMessageId = (threadId: ThreadId, turnId: TurnId, messageId: MessageId) =>
    Cache.getOption(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId)).pipe(
      Effect.flatMap((existingIds) =>
        Option.match(existingIds, {
          onNone: () => Effect.void,
          onSome: (ids) => {
            const nextIds = new Set(ids);
            nextIds.delete(messageId);
            if (nextIds.size === 0) {
              return Cache.invalidate(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId));
            }
            return Cache.set(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId), nextIds);
          },
        }),
      ),
    );

  const getAssistantMessageIdsForTurn = (threadId: ThreadId, turnId: TurnId) =>
    Cache.getOption(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId)).pipe(
      Effect.map((existingIds) =>
        Option.getOrElse(existingIds, (): Set<MessageId> => new Set<MessageId>()),
      ),
    );

  const clearAssistantMessageIdsForTurn = (threadId: ThreadId, turnId: TurnId) =>
    Cache.invalidate(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId));

  const getAssistantSegmentStateForTurn = (threadId: ThreadId, turnId: TurnId) =>
    Cache.getOption(assistantSegmentStateByTurnKey, providerTurnKey(threadId, turnId));

  const setAssistantSegmentStateForTurn = (
    threadId: ThreadId,
    turnId: TurnId,
    state: AssistantSegmentState,
  ) => Cache.set(assistantSegmentStateByTurnKey, providerTurnKey(threadId, turnId), state);

  const clearAssistantSegmentStateForTurn = (threadId: ThreadId, turnId: TurnId) =>
    Cache.invalidate(assistantSegmentStateByTurnKey, providerTurnKey(threadId, turnId));

  const getActiveAssistantMessageIdForTurn = (threadId: ThreadId, turnId: TurnId) =>
    getAssistantSegmentStateForTurn(threadId, turnId).pipe(
      Effect.map((state) =>
        Option.flatMap(state, (entry) =>
          entry.activeMessageId ? Option.some(entry.activeMessageId) : Option.none(),
        ),
      ),
    );

  const startAssistantSegmentForTurn = (input: {
    threadId: ThreadId;
    turnId: TurnId;
    baseKey: string;
  }) =>
    getAssistantSegmentStateForTurn(input.threadId, input.turnId).pipe(
      Effect.flatMap((existingState) =>
        Effect.gen(function* () {
          const nextState = Option.match(existingState, {
            onNone: () => ({
              baseKey: input.baseKey,
              nextSegmentIndex: 1,
              activeMessageId: assistantSegmentMessageId(input.baseKey, 0),
            }),
            onSome: (state) => {
              const segmentIndex = state.baseKey === input.baseKey ? state.nextSegmentIndex : 0;
              const messageId = assistantSegmentMessageId(input.baseKey, segmentIndex);
              return {
                baseKey: input.baseKey,
                nextSegmentIndex: state.baseKey === input.baseKey ? state.nextSegmentIndex + 1 : 1,
                activeMessageId: messageId,
              } satisfies AssistantSegmentState;
            },
          });
          yield* setAssistantSegmentStateForTurn(input.threadId, input.turnId, nextState);
          return nextState.activeMessageId!;
        }),
      ),
    );

  const getOrCreateAssistantMessageId = (input: {
    threadId: ThreadId;
    event: ProviderRuntimeEvent;
    turnId?: TurnId;
  }) =>
    Effect.gen(function* () {
      if (!input.turnId) {
        return assistantSegmentMessageId(assistantSegmentBaseKeyFromEvent(input.event), 0);
      }

      const activeMessageId = yield* getActiveAssistantMessageIdForTurn(
        input.threadId,
        input.turnId,
      );
      if (Option.isSome(activeMessageId)) {
        return activeMessageId.value;
      }

      return yield* startAssistantSegmentForTurn({
        threadId: input.threadId,
        turnId: input.turnId,
        baseKey: assistantSegmentBaseKeyFromEvent(input.event),
      });
    });

  const appendBufferedAssistantText = (messageId: MessageId, delta: string) =>
    Cache.getOption(bufferedAssistantTextByMessageId, messageId).pipe(
      Effect.flatMap((existingText) =>
        Effect.gen(function* () {
          const nextText = Option.match(existingText, {
            onNone: () => delta,
            onSome: (text) => `${text}${delta}`,
          });
          if (nextText.length <= MAX_BUFFERED_ASSISTANT_CHARS) {
            yield* Cache.set(bufferedAssistantTextByMessageId, messageId, nextText);
            return "";
          }

          // Safety valve: flush full buffered text as an assistant delta to cap memory.
          yield* Cache.invalidate(bufferedAssistantTextByMessageId, messageId);
          return nextText;
        }),
      ),
    );

  const takeBufferedAssistantText = (messageId: MessageId) =>
    Cache.getOption(bufferedAssistantTextByMessageId, messageId).pipe(
      Effect.flatMap((existingText) =>
        Cache.invalidate(bufferedAssistantTextByMessageId, messageId).pipe(
          Effect.as(Option.getOrElse(existingText, () => "")),
        ),
      ),
    );

  const clearBufferedAssistantText = (messageId: MessageId) =>
    Cache.invalidate(bufferedAssistantTextByMessageId, messageId);

  const appendBufferedProposedPlan = (planId: string, delta: string, createdAt: string) =>
    Cache.getOption(bufferedProposedPlanById, planId).pipe(
      Effect.flatMap((existingEntry) => {
        const existing = Option.getOrUndefined(existingEntry);
        return Cache.set(bufferedProposedPlanById, planId, {
          text: `${existing?.text ?? ""}${delta}`,
          createdAt:
            existing?.createdAt && existing.createdAt.length > 0 ? existing.createdAt : createdAt,
        });
      }),
    );

  const takeBufferedProposedPlan = (planId: string) =>
    Cache.getOption(bufferedProposedPlanById, planId).pipe(
      Effect.flatMap((existingEntry) =>
        Cache.invalidate(bufferedProposedPlanById, planId).pipe(
          Effect.as(Option.getOrUndefined(existingEntry)),
        ),
      ),
    );

  const clearBufferedProposedPlan = (planId: string) =>
    Cache.invalidate(bufferedProposedPlanById, planId);

  const clearAssistantMessageState = (messageId: MessageId) =>
    clearBufferedAssistantText(messageId);

  const dispatchWorkflowSubagentBatchDirective = Effect.fn(
    "ProviderRuntimeIngestion.dispatchWorkflowSubagentBatchDirective",
  )(function* (input: {
    readonly event: ProviderRuntimeEvent;
    readonly thread: OrchestrationThreadShell;
    readonly sourceMessageId: MessageId;
    readonly children: ReadonlyArray<
      Extract<WorkflowDirective, { type: "workflow-subagent-create" }>
    >;
    readonly createdAt: string;
  }) {
    const batchId = workflowBatchId(input.thread.id, input.sourceMessageId);
    const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
    const parentThread = readModel.threads.find((thread) => thread.id === input.thread.id);
    const rejectHandoff = Effect.fn("ProviderRuntimeIngestion.rejectWorkflowSubagentHandoff")(
      function* (detail: string, resumeParent: boolean) {
        yield* appendWorkflowDirectiveRejectedActivity({
          event: input.event,
          threadId: input.thread.id,
          directiveType:
            input.children.length === 1 ? "workflow-subagent-create" : "workflow-subagents-create",
          summary: "Workflow child handoff rejected",
          detail,
          createdAt: input.createdAt,
        });
        if (!resumeParent) return;
        const messageText = [
          `Workflow child handoff rejected: ${detail}`,
          "Continue this workflow stage in the current thread and complete the remaining work yourself.",
        ].join("\n\n");
        yield* orchestrationEngine.dispatch({
          type: "thread.turn.start",
          commandId: yield* providerCommandId(
            input.event,
            "workflow-subagent-handoff-rejected-resume",
          ),
          threadId: input.thread.id,
          message: {
            messageId: yield* serverMessageId("workflow-subagent-handoff-rejected"),
            role: "user",
            text: messageText,
            attachments: [],
          },
          runtimeMode: input.thread.runtimeMode,
          interactionMode: input.thread.interactionMode,
          createdAt: input.createdAt,
        });
      },
    );
    if (input.children.length !== 1) {
      yield* rejectHandoff(
        `A workflow stage may hand off to exactly one child. This request contained ${input.children.length} children.`,
        true,
      );
      return;
    }
    if (parentThread?.workflowSubagentBatches?.some((batch) => batch.id === batchId)) {
      return;
    }
    const unfinishedBatch = parentThread?.workflowSubagentBatches?.find(
      (batch) => batch.status !== "completed",
    );
    if (unfinishedBatch !== undefined) {
      yield* rejectHandoff(
        `Workflow child handoff '${unfinishedBatch.id}' is still unfinished. Wait for that child to return, then complete the stage in the current thread.`,
        false,
      );
      return;
    }
    const implementationRun = readModel.implementationRuns
      .filter(
        (run) =>
          run.orchestratorThreadId === input.thread.id &&
          run.status !== "completed" &&
          run.status !== "canceled",
      )
      .toSorted((left, right) => (left.updatedAt < right.updatedAt ? 1 : -1))[0];
    const productWorkflowThread = parentThread;
    const productWorkflowSpecId = productWorkflowThread?.planningWorkflow?.spec?.id ?? null;
    const productWorkflowRuns = readModel.implementationRuns.filter(
      (run) =>
        run.sourceProposedPlan?.threadId === input.thread.id ||
        (productWorkflowSpecId !== null && run.specId === productWorkflowSpecId),
    );
    const productWorkflowOwnsBrowserReview =
      (input.thread.workflowPreset === "fast-feature" ||
        input.thread.workflowPreset === "quick-plan" ||
        input.thread.workflowPreset === "fast-plan" ||
        input.thread.workflowPreset === "full-feature") &&
      (productWorkflowRuns.length === 0 ||
        productWorkflowRuns.some((run) => run.status !== "completed" && run.status !== "canceled"));
    const persistedChildren = input.children.map((child, index) => {
      const definition = resolveWorkflowSubagentSpawnDefinition(child.workflowPromptId);
      const isBrowser =
        child.workflowPromptId === WORKFLOW_PROMPT_IDS.implementationBrowserAppReviewCodex;
      const appReviewMode = isBrowser ? (child.appReviewMode ?? "feedback") : null;
      const expectedResult =
        isBrowser && appReviewMode === "feedback"
          ? "workflow-subagent-result"
          : (child.expectedResult ?? definition?.expectedResult ?? "workflow-subagent-result");
      return {
        index,
        workflowPromptId: child.workflowPromptId,
        title: child.title,
        expectedResult,
        appReviewMode,
        childThreadId: null,
        appReviewId: null,
        status: "pending" as const,
        resultMarkdown: null,
        failureDetail: null,
        createdAt: input.createdAt,
        completedAt: null,
      };
    });

    yield* orchestrationEngine.dispatch({
      type: "thread.workflow-subagent-batch.create",
      commandId: workflowCommandId(batchId, "create"),
      threadId: input.thread.id,
      batch: {
        id: batchId,
        parentThreadId: input.thread.id,
        sourceAssistantMessageId: input.sourceMessageId,
        status: "launching",
        children: persistedChildren,
        createdAt: input.createdAt,
        completedAt: null,
      },
      createdAt: input.createdAt,
    });

    const settings = yield* serverSettingsService.getSettings.pipe(
      Effect.orElseSucceed(() => undefined),
    );
    yield* Effect.forEach(
      input.children,
      (child, index) =>
        Effect.gen(function* () {
          const definition = resolveWorkflowSubagentSpawnDefinition(child.workflowPromptId);
          const reject = (detail: string) =>
            orchestrationEngine.dispatch({
              type: "thread.workflow-subagent-batch.child.reject",
              commandId: workflowCommandId(batchId, "reject", index),
              threadId: input.thread.id,
              batchId,
              childIndex: index,
              failureDetail: detail.slice(0, 4_000),
              completedAt: input.createdAt,
              createdAt: input.createdAt,
            });
          if (child.validationError !== undefined) {
            yield* reject(child.validationError);
            return;
          }
          if (
            child.workflowPromptId === WORKFLOW_PROMPT_IDS.implementationBrowserAppReviewCodex &&
            productWorkflowOwnsBrowserReview
          ) {
            yield* reject(
              `The selected ${input.thread.workflowPreset === "quick-plan" ? "Quick Plan" : input.thread.workflowPreset === "fast-plan" ? "Fast Plan" : input.thread.workflowPreset === "fast-feature" ? "Fast Feature" : "Full Feature"} workflow owns its planning, build, review, and publication sequence. Continue or recover that workflow instead of launching an ad hoc Browser App Review child.`,
            );
            return;
          }
          if (
            child.workflowPromptId === WORKFLOW_PROMPT_IDS.implementationBrowserAppReviewCodex &&
            (input.thread.workflowRole === "implementation-qa-reviewer" ||
              input.thread.workflowRole === "app-review-reviewer") &&
            (child.appReviewMode ?? "feedback") !== "feedback"
          ) {
            yield* reject(
              "A Browser App Review owner may launch only feedback-mode browser lanes. Durable evidence, verdicts, and repair cycles must remain with the parent review.",
            );
            return;
          }
          if (definition === undefined) {
            yield* reject(`Workflow prompt '${child.workflowPromptId}' is not spawnable.`);
            return;
          }
          if (!isWorkflowSubagentParentRoleAllowed(definition, input.thread.workflowRole)) {
            yield* reject(
              `Thread role '${input.thread.workflowRole ?? "root"}' cannot spawn '${definition.workflowPromptId}'.`,
            );
            return;
          }

          const resolvedModel = resolveWorkflowStepModelSelection({
            workflowPromptId: definition.workflowPromptId,
            definition,
            stepModels: findWorkflowStepModels(input.thread, readModel.threads),
            parentModelSelection: input.thread.modelSelection,
            settings,
          });
          if (resolvedModel.fallbackDetail !== null) {
            yield* appendWorkflowSubagentModelFallbackActivity({
              event: input.event,
              threadId: input.thread.id,
              workflowPromptId: definition.workflowPromptId,
              detail: resolvedModel.fallbackDetail,
              requestedDriver: definition.modelOverride?.driver ?? null,
              requestedModel: definition.modelOverride?.model ?? null,
              createdAt: input.createdAt,
            });
          }

          const childThreadId = workflowChildThreadId(batchId, index);
          const childMessageId = workflowChildMessageId(batchId, index);
          const persistedChild = persistedChildren[index]!;
          const childPrompt = appendWorkflowSkillCommandSection(
            [
              `Workflow sub-agent request from parent thread '${input.thread.id}'.`,
              `Target workflowPromptId: '${definition.workflowPromptId}'.`,
              `Expected result directive: '${persistedChild.expectedResult}'.`,
              ...(implementationRun === undefined
                ? []
                : [
                    `Implementation run ID: '${implementationRun.id}'. Use this exact value for any runId field.`,
                  ]),
              child.promptMarkdown,
            ].join("\n\n"),
            definition.workflowPromptId,
          );

          if (
            definition.workflowPromptId ===
              WORKFLOW_PROMPT_IDS.implementationBrowserAppReviewCodex &&
            persistedChild.appReviewMode === "full"
          ) {
            yield* orchestrationEngine.dispatch({
              type: "thread.app-review.launch",
              commandId: workflowCommandId(batchId, "full-review-launch", index),
              sourceThreadId: input.thread.id,
              reviewThreadId: childThreadId,
              reviewId: workflowChildReviewId(batchId, index),
              message: {
                messageId: childMessageId,
                role: "user",
                text: appendWorkflowSkillCommandSection(
                  [
                    `Run Browser App Review (full durable mode) for source thread ${input.thread.id}.`,
                    `Source title: ${input.thread.title}`,
                    `Review request:\n${child.promptMarkdown}`,
                  ].join("\n\n"),
                  definition.workflowPromptId,
                ),
                attachments: [],
              },
              modelSelection: resolvedModel.modelSelection,
              runtimeMode: input.thread.runtimeMode,
              workflowPromptId: definition.workflowPromptId,
              batchProvenance: { batchId, childIndex: index },
              createdAt: input.createdAt,
            });
            return;
          }

          yield* orchestrationEngine.dispatch({
            type: "thread.workflow-subagent.launch",
            commandId: workflowCommandId(batchId, "launch", index),
            threadId: childThreadId,
            batchId,
            childIndex: index,
            projectId: input.thread.projectId,
            ownerUserId: input.thread.ownerUserId,
            parentThreadId: input.thread.id,
            workflowRole: definition.workflowRole,
            title: child.title || definition.defaultTitlePrefix,
            modelSelection: resolvedModel.modelSelection,
            runtimeMode: input.thread.runtimeMode,
            interactionMode: definition.interactionMode,
            branch: input.thread.branch,
            worktreePath: input.thread.worktreePath,
            message: {
              messageId: childMessageId,
              role: "user",
              text:
                persistedChild.appReviewMode === "feedback"
                  ? `${childPrompt}\n\nThis is focused feedback mode. Use preview_* tools only, open previews with show: false, do not call app_review_* tools, and finish with exactly one fenced JSON directive shaped as { "type": "workflow-subagent-result", "status": "completed" | "blocked", "resultMarkdown": "concise findings, reproduction steps, blockers, and recommendations" }. Recording and screenshots are not required.`
                  : childPrompt,
              attachments: [],
            },
            workflowPromptId: definition.workflowPromptId,
            createdAt: input.createdAt,
          });
        }).pipe(
          Effect.catchCause((cause) =>
            orchestrationEngine.dispatch({
              type: "thread.workflow-subagent-batch.child.fail",
              commandId: workflowCommandId(batchId, "fail", index),
              threadId: input.thread.id,
              batchId,
              childIndex: index,
              failureDetail: workflowDispatchErrorDetail(cause).slice(0, 4_000),
              completedAt: input.createdAt,
              createdAt: input.createdAt,
            }),
          ),
        ),
      { concurrency: 1 },
    );
  });

  const dispatchWorkflowAgentMessageDirective = Effect.fn(
    "ProviderRuntimeIngestion.dispatchWorkflowAgentMessageDirective",
  )(function* (input: {
    readonly event: ProviderRuntimeEvent;
    readonly thread: OrchestrationThreadShell;
    readonly directive: Extract<WorkflowDirective, { type: "workflow-agent-message" }>;
    readonly createdAt: string;
  }) {
    const target = yield* resolveWorkflowAgentMessageTarget({
      sourceThread: input.thread,
      target: input.directive.target,
    });
    if (target.kind === "error") {
      yield* appendWorkflowDirectiveRejectedActivity({
        event: input.event,
        threadId: input.thread.id,
        directiveType: input.directive.type,
        summary: "Workflow agent message rejected",
        detail: target.detail,
        createdAt: input.createdAt,
      });
      return;
    }
    const targetThread = target.thread;
    if (targetThread === undefined) {
      yield* appendWorkflowDirectiveRejectedActivity({
        event: input.event,
        threadId: input.thread.id,
        directiveType: input.directive.type,
        summary: "Workflow agent message rejected",
        detail: "Workflow agent message target resolved without a thread.",
        createdAt: input.createdAt,
      });
      return;
    }

    const messageText = [
      `Workflow agent message from thread '${input.thread.id}'.`,
      `Purpose: ${input.directive.purpose}.`,
      input.directive.messageMarkdown,
    ].join("\n\n");

    yield* orchestrationEngine.dispatch({
      type: "thread.turn.start",
      commandId: yield* providerCommandId(input.event, "workflow-agent-message-turn"),
      threadId: targetThread.id,
      message: {
        messageId: yield* serverMessageId("workflow-agent-message"),
        role: "user",
        text: messageText,
        attachments: [],
      },
      runtimeMode: targetThread.runtimeMode,
      interactionMode: targetThread.interactionMode,
      createdAt: input.createdAt,
    });
  });

  const dispatchWorkflowDirective = (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    messageId: MessageId;
    directive: WorkflowDirective;
    createdAt: string;
  }) =>
    Effect.gen(function* () {
      const thread = yield* resolveThreadShell(input.threadId);
      if (!thread) {
        return;
      }

      switch (input.directive.type) {
        case "workflow-subagent-create": {
          yield* dispatchWorkflowSubagentBatchDirective({
            event: input.event,
            thread,
            sourceMessageId: input.messageId,
            children: [input.directive],
            createdAt: input.createdAt,
          });
          return;
        }

        case "workflow-subagents-create": {
          yield* dispatchWorkflowSubagentBatchDirective({
            event: input.event,
            thread,
            sourceMessageId: input.messageId,
            children: input.directive.children.map((child) => ({
              type: "workflow-subagent-create" as const,
              ...child,
            })),
            createdAt: input.createdAt,
          });
          return;
        }

        case "workflow-subagent-result":
          return;

        case "workflow-agent-message": {
          yield* dispatchWorkflowAgentMessageDirective({
            event: input.event,
            thread,
            directive: input.directive,
            createdAt: input.createdAt,
          });
          return;
        }

        case "product-intent-locked": {
          if (!isProductWorkflowRoot(thread)) {
            yield* Effect.logWarning(
              "provider workflow product intent directive ignored for non-product root thread",
              {
                directiveType: input.directive.type,
                threadId: thread.id,
                interactionMode: thread.interactionMode,
                workflowRole: thread.workflowRole,
              },
            );
            return;
          }

          const intentKind = input.directive.intentKind;
          const presetIntentKind = expectedIntentKindForWorkflowPreset(thread.workflowPreset);
          const detail = yield* resolveThreadDetail(thread.id);
          const gateFailureDetail =
            presetIntentKind === null
              ? "Product intent cannot lock without an explicit Fix, Fast Feature, or Full Feature workflow preset."
              : intentKind === null
                ? `product-intent-locked requires intentKind "${presetIntentKind}" for the selected workflow preset.`
                : intentKind !== presetIntentKind
                  ? `product-intent-locked intentKind "${intentKind}" conflicts with the selected workflow preset, which requires "${presetIntentKind}".`
                  : null;

          if (gateFailureDetail !== null) {
            yield* appendWorkflowDirectiveRejectedActivity({
              event: input.event,
              threadId: thread.id,
              directiveType: input.directive.type,
              summary: "Product intent lock rejected",
              detail: gateFailureDetail,
              createdAt: input.createdAt,
            });
            const priorRejections =
              detail?.activities.filter(
                (activity) =>
                  activity.kind === "workflow.directive.rejected" &&
                  (activity.payload as { directiveType?: string } | null)?.directiveType ===
                    "product-intent-locked",
              ).length ?? 0;
            if (priorRejections >= MAX_PRODUCT_INTENT_LOCK_REJECTION_BOUNCES) {
              yield* orchestrationEngine.dispatch({
                type: "thread.activity.append",
                commandId: yield* providerCommandId(input.event, "product-intent-gate-blocked"),
                threadId: thread.id,
                activity: {
                  id: EventId.make(yield* crypto.randomUUIDv4),
                  tone: "error",
                  kind: "product-workflow.needs-human-attention",
                  summary: "Product Workflow needs human attention",
                  payload: {
                    reasonMarkdown: `Product intent lock was rejected ${priorRejections + 1} times because it did not match the authoritative ${thread.workflowPreset ?? "missing"} preset.`,
                  },
                  turnId: null,
                  createdAt: input.createdAt,
                },
                createdAt: input.createdAt,
              });
              return;
            }
            yield* orchestrationEngine.dispatch({
              type: "thread.turn.start",
              commandId: yield* providerCommandId(input.event, "product-intent-gate-turn"),
              threadId: thread.id,
              message: {
                messageId: yield* serverMessageId("product-intent-gate"),
                role: "user",
                text: `Your product-intent-locked directive was rejected: ${gateFailureDetail}\n\nDo not ask for classification. Emit the lock again with intentKind "${presetIntentKind ?? "the selected preset's intent kind"}" after the user confirms the product intent is sufficiently locked.`,
                attachments: [],
              },
              runtimeMode: thread.runtimeMode,
              interactionMode: thread.interactionMode,
              createdAt: input.createdAt,
            });
            return;
          }

          yield* orchestrationEngine.dispatch({
            type: "thread.activity.append",
            commandId: yield* providerCommandId(input.event, "workflow-product-intent-locked"),
            threadId: thread.id,
            activity: {
              id: EventId.make(yield* crypto.randomUUIDv4),
              tone: "info",
              kind: "product-intent-locked",
              summary: input.directive.title,
              payload: {
                title: input.directive.title,
                summaryMarkdown: input.directive.summaryMarkdown,
                intentKind: input.directive.intentKind,
              },
              turnId: null,
              createdAt: input.createdAt,
            },
            createdAt: input.createdAt,
          });
          return;
        }

        case "planning-grill-complete": {
          if (!isPlanningArtifactThread(thread)) {
            yield* Effect.logWarning(
              "provider workflow directive ignored for non-planning thread",
              {
                directiveType: input.directive.type,
                threadId: thread.id,
                workflowRole: thread.workflowRole,
              },
            );
            return;
          }

          yield* orchestrationEngine.dispatch({
            type: "thread.planning-spec.create",
            commandId: yield* providerCommandId(input.event, "workflow-planning-grill-complete"),
            threadId: thread.id,
            createdAt: input.createdAt,
          });
          return;
        }

        case "planning-spec-artifact": {
          if (!isPlanningArtifactThread(thread)) {
            yield* Effect.logWarning(
              "provider workflow directive ignored for non-planning thread",
              {
                directiveType: input.directive.type,
                threadId: thread.id,
                workflowRole: thread.workflowRole,
              },
            );
            return;
          }

          yield* orchestrationEngine.dispatch({
            type: "thread.planning-spec.apply",
            commandId: yield* providerCommandId(input.event, "workflow-planning-spec-apply"),
            threadId: thread.id,
            sourceMessageId: input.messageId,
            title: input.directive.title,
            summaryMarkdown: input.directive.summaryMarkdown,
            createdAt: input.createdAt,
          });
          return;
        }

        case "wayfinder-map-artifact": {
          if (!isPlanningArtifactThread(thread)) {
            yield* Effect.logWarning("provider wayfinder map ignored for non-planning thread", {
              threadId: thread.id,
              workflowRole: thread.workflowRole,
            });
            return;
          }
          yield* orchestrationEngine.dispatch({
            type: "thread.planning-spec.apply",
            commandId: yield* providerCommandId(input.event, "workflow-wayfinder-map-apply"),
            threadId: thread.id,
            sourceMessageId: input.messageId,
            title: input.directive.title,
            summaryMarkdown: input.directive.summaryMarkdown,
            artifactKind: "wayfinder-map",
            createdAt: input.createdAt,
          });
          return;
        }

        case "planning-tickets-artifact": {
          if (
            !isPlanningArtifactThread(thread) &&
            !(thread.interactionMode === "implementation-workflow" && thread.workflowRole === null)
          ) {
            yield* Effect.logWarning(
              "provider workflow directive ignored for non-planning thread",
              {
                directiveType: input.directive.type,
                threadId: thread.id,
                workflowRole: thread.workflowRole,
              },
            );
            return;
          }

          yield* orchestrationEngine.dispatch({
            type: "thread.planning-tickets.apply",
            commandId: yield* providerCommandId(input.event, "workflow-planning-tickets-apply"),
            threadId: thread.id,
            sourceMessageId: input.messageId,
            specId: input.directive.specId,
            tickets: input.directive.tickets.map((ticket) => ({
              key: ticket.key,
              title: ticket.title,
              bodyMarkdown: ticket.bodyMarkdown,
              plannedFileChanges: ticket.plannedFileChanges.map((change) => ({ ...change })),
              dependencyKeys: [...ticket.dependencyKeys],
              appReviewEligible: ticket.appReviewEligible,
              ...(ticket.appReviewScope === undefined
                ? {}
                : { appReviewScope: ticket.appReviewScope }),
              appReviewPlanMarkdown: ticket.appReviewPlanMarkdown,
            })),
            createdAt: input.createdAt,
          });
          return;
        }

        case "planning-reviewer-verdict": {
          if (thread.workflowRole !== "planning-reviewer" || thread.parentThreadId === null) {
            yield* Effect.logWarning(
              "provider workflow reviewer verdict ignored for non-reviewer thread",
              {
                directiveType: input.directive.type,
                threadId: thread.id,
                workflowRole: thread.workflowRole,
              },
            );
            return;
          }

          const verdictMarkdown = [
            `Ticket review cycle ${input.directive.cycleNumber}: ${
              input.directive.passed ? "passed" : "failed"
            }.`,
            input.directive.dependencyFeedback.length > 0
              ? `Dependency feedback:\n${input.directive.dependencyFeedback
                  .map((entry) => `- ${entry}`)
                  .join("\n")}`
              : "",
            input.directive.perTicketFeedback.length > 0
              ? `Per-ticket feedback:\n${input.directive.perTicketFeedback
                  .map(
                    (entry) =>
                      `- ${entry.ticketId}: ${entry.passed ? "passed" : "failed"}\n  ${
                        entry.feedbackMarkdown
                      }`,
                  )
                  .join("\n")}`
              : "",
          ]
            .filter((entry) => entry.length > 0)
            .join("\n\n");

          yield* orchestrationEngine.dispatch({
            type: "thread.planning-reviewer-verdict.apply",
            commandId: yield* providerCommandId(input.event, "workflow-planning-review-apply"),
            threadId: thread.parentThreadId,
            reviewerThreadId: thread.id,
            reviewerMessageId: input.messageId,
            cycleNumber: input.directive.cycleNumber,
            mode: input.directive.mode,
            targetPlanningTicketIds: [...input.directive.targetPlanningTicketIds],
            ticketEdits: input.directive.ticketEdits.map((edit) => {
              switch (edit.type) {
                case "update":
                  return {
                    type: edit.type,
                    ticketId: edit.ticketId,
                    ...(edit.title === undefined ? {} : { title: edit.title }),
                    ...(edit.bodyMarkdown === undefined ? {} : { bodyMarkdown: edit.bodyMarkdown }),
                    ...(edit.plannedFileChanges === undefined
                      ? {}
                      : {
                          plannedFileChanges: edit.plannedFileChanges.map((change) => ({
                            ...change,
                          })),
                        }),
                    ...(edit.dependencyKeys === undefined
                      ? {}
                      : { dependencyKeys: [...edit.dependencyKeys] }),
                    ...(edit.appReviewEligible === undefined
                      ? {}
                      : { appReviewEligible: edit.appReviewEligible }),
                    ...(edit.appReviewScope === undefined
                      ? {}
                      : { appReviewScope: edit.appReviewScope }),
                    ...(edit.appReviewPlanMarkdown === undefined
                      ? {}
                      : { appReviewPlanMarkdown: edit.appReviewPlanMarkdown }),
                  };
                case "create":
                  return {
                    ...edit,
                    plannedFileChanges: edit.plannedFileChanges.map((change) => ({ ...change })),
                    dependencyKeys: [...edit.dependencyKeys],
                    replacesPlanningTicketIds: [...edit.replacesPlanningTicketIds],
                  };
                case "update-dependencies":
                  return { ...edit, dependencyKeys: [...edit.dependencyKeys] };
                case "delete":
                  return edit;
              }
            }),
            verdictMarkdown,
            passed: input.directive.passed,
            failingPlanningTicketIds: [...input.directive.failingPlanningTicketIds],
            dependencyFeedback: [...input.directive.dependencyFeedback],
            perTicketFeedback: input.directive.perTicketFeedback.map((entry) => ({
              ticketId: entry.ticketId,
              passed: entry.passed,
              feedbackMarkdown: entry.feedbackMarkdown,
            })),
            createdAt: input.createdAt,
          });
          return;
        }

        case "implementation-worker-result": {
          if (thread.workflowRole !== "implementation-worker") {
            yield* Effect.logWarning(
              "provider workflow worker result ignored for non-worker thread",
              {
                directiveType: input.directive.type,
                threadId: thread.id,
                workflowRole: thread.workflowRole,
              },
            );
            return;
          }

          yield* orchestrationEngine.dispatch({
            type: "thread.activity.append",
            commandId: yield* providerCommandId(input.event, "workflow-worker-result"),
            threadId: thread.id,
            activity: {
              id: EventId.make(yield* crypto.randomUUIDv4),
              tone: input.directive.status === "succeeded" ? "info" : "error",
              kind: "implementation-worker-result",
              summary: `Worker ${input.directive.ticketId} ${input.directive.status}`,
              payload: input.directive,
              turnId: null,
              createdAt: input.createdAt,
            },
            createdAt: input.createdAt,
          });
          return;
        }

        case "implementation-merge-gate-result": {
          if (thread.workflowRole !== "implementation-validator") {
            yield* Effect.logWarning(
              "provider workflow merge-gate result ignored for non-validator thread",
              {
                directiveType: input.directive.type,
                threadId: thread.id,
                workflowRole: thread.workflowRole,
              },
            );
            return;
          }

          yield* orchestrationEngine.dispatch({
            type: "thread.activity.append",
            commandId: yield* providerCommandId(input.event, "workflow-merge-gate-result"),
            threadId: thread.id,
            activity: {
              id: EventId.make(yield* crypto.randomUUIDv4),
              tone: input.directive.status === "passed" ? "info" : "error",
              kind: "implementation-merge-gate-result",
              summary: `Merge gate ${input.directive.status}`,
              payload: input.directive,
              turnId: null,
              createdAt: input.createdAt,
            },
            createdAt: input.createdAt,
          });
          return;
        }

        case "implementation-fix-result": {
          if (thread.workflowRole !== "implementation-fixer") {
            yield* Effect.logWarning("provider workflow fix result ignored for non-fixer thread", {
              directiveType: input.directive.type,
              threadId: thread.id,
              workflowRole: thread.workflowRole,
            });
            return;
          }

          yield* orchestrationEngine.dispatch({
            type: "thread.activity.append",
            commandId: yield* providerCommandId(input.event, "workflow-fix-result"),
            threadId: thread.id,
            activity: {
              id: EventId.make(yield* crypto.randomUUIDv4),
              tone: input.directive.status === "succeeded" ? "info" : "error",
              kind: "implementation-fix-result",
              summary: `Implementation fix ${input.directive.status}`,
              payload: input.directive,
              turnId: null,
              createdAt: input.createdAt,
            },
            createdAt: input.createdAt,
          });
          return;
        }

        case "app-review-repair-tickets": {
          // Gap analysis runs on the planner thread. Cycles recorded before it
          // moved out of the reviewer still emit from there.
          if (
            thread.workflowRole !== "app-review-planner" &&
            thread.workflowRole !== "app-review-reviewer"
          ) {
            yield* Effect.logWarning(
              "provider App Review repair tickets ignored for non-planner thread",
              { threadId: thread.id, workflowRole: thread.workflowRole },
            );
            return;
          }
          yield* orchestrationEngine.dispatch({
            type: "thread.activity.append",
            commandId: yield* providerCommandId(input.event, "app-review-repair-tickets"),
            threadId: thread.id,
            activity: {
              id: EventId.make(yield* crypto.randomUUIDv4),
              tone: "info",
              kind: "app-review-repair-tickets",
              summary: `Created ${input.directive.tickets.length} App Review repair ticket(s)`,
              payload: input.directive,
              turnId: null,
              createdAt: input.createdAt,
            },
            createdAt: input.createdAt,
          });
          return;
        }

        case "app-review-fix-result": {
          if (thread.workflowRole !== "app-review-fixer") {
            yield* Effect.logWarning(
              "provider App Review fix result ignored for non-fixer thread",
              {
                directiveType: input.directive.type,
                threadId: thread.id,
                workflowRole: thread.workflowRole,
              },
            );
            return;
          }

          yield* orchestrationEngine.dispatch({
            type: "thread.activity.append",
            commandId: yield* providerCommandId(input.event, "app-review-fix-result"),
            threadId: thread.id,
            activity: {
              id: EventId.make(yield* crypto.randomUUIDv4),
              tone: input.directive.status === "succeeded" ? "info" : "error",
              kind: "app-review-fix-result",
              summary: `App Review fix ${input.directive.status}`,
              payload: input.directive,
              turnId: null,
              createdAt: input.createdAt,
            },
            createdAt: input.createdAt,
          });
          return;
        }

        case "implementation-fast-build-result": {
          if (thread.workflowRole !== "fast-feature-implementer") {
            yield* Effect.logWarning(
              "provider workflow fast build result ignored for non-fast-feature thread",
              { threadId: thread.id, workflowRole: thread.workflowRole },
            );
            return;
          }
          yield* orchestrationEngine.dispatch({
            type: "thread.activity.append",
            commandId: yield* providerCommandId(input.event, "workflow-fast-build-result"),
            threadId: thread.id,
            activity: {
              id: EventId.make(yield* crypto.randomUUIDv4),
              tone: input.directive.status === "succeeded" ? "info" : "error",
              kind: "implementation-fast-build-result",
              summary: `Fast feature build ${input.directive.status}`,
              payload: input.directive,
              turnId: null,
              createdAt: input.createdAt,
            },
            createdAt: input.createdAt,
          });
          return;
        }

        case "implementation-code-review-result": {
          if (thread.workflowRole !== "implementation-code-reviewer") {
            yield* Effect.logWarning(
              "provider workflow code-review result ignored for non-code-reviewer thread",
              {
                directiveType: input.directive.type,
                threadId: thread.id,
                workflowRole: thread.workflowRole,
              },
            );
            return;
          }

          yield* orchestrationEngine.dispatch({
            type: "thread.activity.append",
            commandId: yield* providerCommandId(input.event, "workflow-code-review-result"),
            threadId: thread.id,
            activity: {
              id: EventId.make(yield* crypto.randomUUIDv4),
              tone: input.directive.status === "blocked" ? "error" : "info",
              kind: "implementation-code-review-result",
              summary: `Implementation code review ${input.directive.status}`,
              payload: input.directive,
              turnId: null,
              createdAt: input.createdAt,
            },
            createdAt: input.createdAt,
          });
          return;
        }

        case "implementation-change-request-babysit-result": {
          if (thread.workflowRole !== "implementation-change-request-babysitter") {
            yield* Effect.logWarning(
              "provider workflow change-request babysit result ignored for wrong thread",
              { threadId: thread.id, workflowRole: thread.workflowRole },
            );
            return;
          }
          yield* orchestrationEngine.dispatch({
            type: "thread.activity.append",
            commandId: yield* providerCommandId(
              input.event,
              "workflow-change-request-babysit-result",
            ),
            threadId: thread.id,
            activity: {
              id: EventId.make(yield* crypto.randomUUIDv4),
              tone: input.directive.status === "passed" ? "info" : "error",
              kind: "implementation-change-request-babysit-result",
              summary: `Change request checks ${input.directive.status}`,
              payload: input.directive,
              turnId: null,
              createdAt: input.createdAt,
            },
            createdAt: input.createdAt,
          });
          return;
        }
      }
    });

  const consumePlanningReviewerFailure = Effect.fn(
    "ProviderRuntimeIngestion.consumePlanningReviewerFailure",
  )(function* (input: {
    readonly event: ProviderRuntimeEvent;
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
    readonly detail: string;
    readonly createdAt: string;
    /** Aligns the retry with the turn that produced the bad verdict, so one turn buys one retry. */
    readonly dedupeScope?: string;
    /**
     * `false` for failures raised while the reviewer's turn is still running: the retry starts a
     * turn, and a thread that is already running one cannot take another.
     */
    readonly retryable?: boolean;
  }) {
    const thread = yield* resolveThreadDetail(input.threadId);
    if (thread?.workflowRole !== "planning-reviewer" || thread.parentThreadId === null) return;
    const parent = yield* resolveThreadDetail(thread.parentThreadId);
    const activeReview = parent?.planningWorkflow?.activeReview;
    if (activeReview === null || activeReview === undefined) return;
    if (activeReview.reviewerThreadId !== thread.id) return;

    // A verdict rejected over its shape carries a real review inside it. Failing the cycle throws
    // that review away, marks every target ticket failed and buys the next cycle nothing — one run
    // burned all five cycles this way, none of them applying a single edit. So hand the reviewer
    // the parser's complaint and the exact shape, and let the same thread re-emit.
    const priorRetries = thread.activities.filter(
      (activity) =>
        activity.kind === "workflow.directive.rejected" &&
        (activity.payload as { directiveType?: string } | null)?.directiveType ===
          "planning-reviewer-verdict",
    ).length;
    if (input.retryable !== false && priorRetries < MAX_PLANNING_REVIEWER_VERDICT_RETRIES) {
      const retryKey = `${input.threadId}:${activeReview.cycleNumber}:${input.dedupeScope ?? input.messageId}:planning-review-retry`;
      const retried = yield* Cache.getOption(processedWorkflowDirectiveKeys, retryKey);
      if (Option.getOrElse(retried, () => false)) return;
      yield* Cache.set(processedWorkflowDirectiveKeys, retryKey, true);
      yield* appendWorkflowDirectiveRejectedActivity({
        event: input.event,
        threadId: thread.id,
        directiveType: "planning-reviewer-verdict",
        summary: "Planning reviewer verdict rejected",
        detail: input.detail,
        createdAt: input.createdAt,
      });
      yield* orchestrationEngine.dispatch({
        type: "thread.turn.start",
        commandId: yield* providerCommandId(input.event, "workflow-planning-review-retry"),
        threadId: thread.id,
        message: {
          messageId: yield* serverMessageId("planning-review-retry"),
          role: "user",
          text: [
            `${input.detail}`,
            "",
            "Nothing from that verdict was applied. Keep every finding and correction you already made and re-emit the complete verdict for this cycle as exactly one fenced JSON block in the shape below. Do not review the tickets again.",
            ...PLANNING_REVIEWER_TICKET_EDIT_RULES.map((rule) => `- ${rule}`),
            "```json",
            planningReviewerVerdictExampleJson({
              cycleNumber: activeReview.cycleNumber,
              mode: activeReview.mode,
              targetPlanningTicketIds: [...activeReview.targetPlanningTicketIds],
            }),
            "```",
          ].join("\n"),
          attachments: [],
        },
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
        createdAt: input.createdAt,
      });
      return;
    }

    const failureKey = `${input.threadId}:${activeReview.cycleNumber}:planning-review-runtime-failure`;
    const existing = yield* Cache.getOption(processedWorkflowDirectiveKeys, failureKey);
    if (Option.getOrElse(existing, () => false)) return;
    yield* Cache.set(processedWorkflowDirectiveKeys, failureKey, true);
    yield* orchestrationEngine.dispatch({
      type: "thread.planning-reviewer-verdict.apply",
      commandId: yield* providerCommandId(input.event, "workflow-planning-review-failure"),
      threadId: thread.parentThreadId,
      reviewerThreadId: thread.id,
      reviewerMessageId: input.messageId,
      cycleNumber: activeReview.cycleNumber,
      mode: activeReview.mode,
      targetPlanningTicketIds: [...activeReview.targetPlanningTicketIds],
      ticketEdits: [],
      runtimeFailure: true,
      verdictMarkdown: input.detail,
      passed: false,
      failingPlanningTicketIds: [...activeReview.targetPlanningTicketIds],
      dependencyFeedback: [],
      perTicketFeedback: [],
      createdAt: input.createdAt,
    });
  });

  // A planning root thread whose Spec or Ticket artifact is rejected gets the parser's complaint
  // back as a retry turn, mirroring the reviewer-verdict retry above. Without this the stage
  // stalls silently: the rejection was a WARN log, the model got no feedback, and the thread sat
  // "ready" until the session reaper collected it.
  const consumePlanningArtifactFailure = Effect.fn(
    "ProviderRuntimeIngestion.consumePlanningArtifactFailure",
  )(function* (input: {
    readonly event: ProviderRuntimeEvent;
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
    readonly detail: string;
    readonly createdAt: string;
    /** Aligns the retry with the turn that produced the bad artifact, so one turn buys one retry. */
    readonly dedupeScope?: string;
  }) {
    const thread = yield* resolveThreadDetail(input.threadId);
    if (!thread || !isPlanningArtifactThread(thread)) return;
    const stage = thread.planningWorkflow?.stage;
    if (stage !== "spec-authoring" && stage !== "tickets-authoring") return;
    const directiveType =
      stage === "spec-authoring" ? "planning-spec-artifact" : "planning-tickets-artifact";

    const retryKey = `${input.threadId}:${stage}:${input.dedupeScope ?? input.messageId}:planning-artifact-retry`;
    const retried = yield* Cache.getOption(processedWorkflowDirectiveKeys, retryKey);
    if (Option.getOrElse(retried, () => false)) return;
    yield* Cache.set(processedWorkflowDirectiveKeys, retryKey, true);

    const priorRejections = thread.activities.filter(
      (activity) =>
        activity.kind === "workflow.directive.rejected" &&
        (activity.payload as { directiveType?: string } | null)?.directiveType === directiveType,
    ).length;
    yield* appendWorkflowDirectiveRejectedActivity({
      event: input.event,
      threadId: thread.id,
      directiveType,
      summary:
        stage === "spec-authoring"
          ? "Planning Spec artifact rejected"
          : "Planning Ticket artifact rejected",
      detail: input.detail,
      createdAt: input.createdAt,
    });

    if (priorRejections >= MAX_PLANNING_ARTIFACT_RETRIES) {
      yield* orchestrationEngine.dispatch({
        type: "thread.activity.append",
        commandId: yield* providerCommandId(input.event, "planning-artifact-blocked"),
        threadId: thread.id,
        activity: {
          id: EventId.make(yield* crypto.randomUUIDv4),
          tone: "error",
          kind: "planning-workflow.needs-human-attention",
          summary: "Planning workflow needs human attention",
          payload: {
            reasonMarkdown: `The ${directiveType} directive was rejected ${priorRejections + 1} times. Latest rejection: ${input.detail}`,
          },
          turnId: null,
          createdAt: input.createdAt,
        },
        createdAt: input.createdAt,
      });
      return;
    }

    yield* orchestrationEngine.dispatch({
      type: "thread.turn.start",
      commandId: yield* providerCommandId(input.event, "workflow-planning-artifact-retry"),
      threadId: thread.id,
      message: {
        messageId: yield* serverMessageId("planning-artifact-retry"),
        role: "user",
        text: [
          `Your ${directiveType} directive was rejected: ${input.detail}`,
          "",
          "Nothing was applied. Correct exactly this problem and re-emit the complete artifact as one fenced JSON block in the shape the stage instructions describe. Do not redo the analysis.",
        ].join("\n"),
        attachments: [],
      },
      runtimeMode: thread.runtimeMode,
      interactionMode: thread.interactionMode,
      createdAt: input.createdAt,
    });
  });

  const consumeFastFeatureBuildFailure = Effect.fn(
    "ProviderRuntimeIngestion.consumeFastFeatureBuildFailure",
  )(function* (input: {
    readonly event: ProviderRuntimeEvent;
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
    readonly detail: string;
    readonly createdAt: string;
    /**
     * Dedupe scope for the synthesized failure. A missing directive is a property of the whole
     * turn, so callers pass the turn id: keying by message id would report the same stalled turn
     * once per assistant segment.
     */
    readonly dedupeScope?: string;
  }) {
    const thread = yield* resolveThreadDetail(input.threadId);
    if (thread?.workflowRole !== "fast-feature-implementer") return;
    const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
    const run = readModel.implementationRuns.find(
      (candidate) =>
        candidate.artifactSource === "proposed-plan" &&
        candidate.orchestratorThreadId === thread.id &&
        candidate.status !== "canceled",
    );
    if (!run || run.fastBuildResult?.status === "succeeded") return;
    const failureKey = `${input.threadId}:${input.dedupeScope ?? input.messageId}:fast-feature-build-failure`;
    const existing = yield* Cache.getOption(processedWorkflowDirectiveKeys, failureKey);
    if (Option.getOrElse(existing, () => false)) return;
    yield* Cache.set(processedWorkflowDirectiveKeys, failureKey, true);
    yield* orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: yield* providerCommandId(input.event, "workflow-fast-build-failure"),
      threadId: thread.id,
      activity: {
        id: EventId.make(yield* crypto.randomUUIDv4),
        tone: "error",
        kind: "implementation-fast-build-result",
        summary: "Fast feature Build result was missing or malformed",
        payload: {
          type: "implementation-fast-build-result",
          runId: run.id,
          status: "blocked",
          validations: [],
          notesMarkdown: input.detail,
        },
        turnId: null,
        createdAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });
  });

  const consumeImplementationFixerFailure = Effect.fn(
    "ProviderRuntimeIngestion.consumeImplementationFixerFailure",
  )(function* (input: {
    readonly event: ProviderRuntimeEvent;
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
    readonly detail: string;
    readonly createdAt: string;
    readonly dedupeScope?: string;
  }) {
    const thread = yield* resolveThreadDetail(input.threadId);
    if (thread?.workflowRole !== "implementation-fixer") return;
    const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
    const run = readModel.implementationRuns.find(
      (candidate) =>
        (candidate.status === "fixing" || candidate.status === "code-review-fixing") &&
        candidate.activeFixerThreadId === thread.id,
    );
    if (run === undefined) return;
    const failureKey = `${input.threadId}:${input.dedupeScope ?? input.messageId}:implementation-fix-failure`;
    const existing = yield* Cache.getOption(processedWorkflowDirectiveKeys, failureKey);
    if (Option.getOrElse(existing, () => false)) return;
    yield* Cache.set(processedWorkflowDirectiveKeys, failureKey, true);
    yield* orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: yield* providerCommandId(input.event, "workflow-fix-failure"),
      threadId: thread.id,
      activity: {
        id: EventId.make(yield* crypto.randomUUIDv4),
        tone: "error",
        kind: "implementation-fix-result",
        summary: "Implementation fix result was missing or malformed",
        payload: {
          type: "implementation-fix-result",
          runId: run.id,
          status: "blocked",
          validations: [],
          notesMarkdown: input.detail,
        },
        turnId: null,
        createdAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });
  });

  const consumeAppReviewFixerFailure = Effect.fn(
    "ProviderRuntimeIngestion.consumeAppReviewFixerFailure",
  )(function* (input: {
    readonly event: ProviderRuntimeEvent;
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
    readonly detail: string;
    readonly createdAt: string;
    readonly dedupeScope?: string;
  }) {
    const thread = yield* resolveThreadDetail(input.threadId);
    if (thread?.workflowRole !== "app-review-fixer") return;
    const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
    const run = (readModel.appReviewWorkflowRuns ?? []).find(
      (candidate) =>
        candidate.status === "running" &&
        candidate.activePhase === "fixing" &&
        candidate.activeThreadId === thread.id,
    );
    const cycle = run?.cycles.at(-1);
    if (run === undefined || cycle?.planId === null || cycle?.planId === undefined) return;
    const failureKey = `${input.threadId}:${input.dedupeScope ?? input.messageId}:app-review-fix-failure`;
    const existing = yield* Cache.getOption(processedWorkflowDirectiveKeys, failureKey);
    if (Option.getOrElse(existing, () => false)) return;
    yield* Cache.set(processedWorkflowDirectiveKeys, failureKey, true);
    yield* orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: yield* providerCommandId(input.event, "app-review-fix-failure"),
      threadId: thread.id,
      activity: {
        id: EventId.make(yield* crypto.randomUUIDv4),
        tone: "error",
        kind: "app-review-fix-result",
        summary: "App Review fix result was missing or malformed",
        payload: {
          type: "app-review-fix-result",
          runId: run.id,
          planId: cycle.planId,
          status: "blocked",
          validations: [],
          notesMarkdown: input.detail,
        },
        turnId: null,
        createdAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });
  });

  const maybeProcessWorkflowDirective = (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    messageId: MessageId;
    turnId?: TurnId;
    markdown: string;
    createdAt: string;
    /**
     * Only a turn that has ended without its directive is a failure. Agents narrate between tool
     * calls, so synthesizing a failure per assistant message reports a build that is still running
     * as blocked — and burns its whole retry budget in the first minute.
     */
    synthesizeMissingDirectiveFailure?: boolean;
  }) =>
    Effect.gen(function* () {
      const thread = yield* resolveThreadShell(input.threadId);
      if (!thread) {
        return;
      }
      const synthesizeFailure = input.synthesizeMissingDirectiveFailure === true;
      const failureInput = { ...input, dedupeScope: input.turnId ?? input.messageId };

      const parseResult = parseWorkflowDirectiveFromMarkdown(input.markdown);
      if (parseResult.kind === "none") {
        if (synthesizeFailure) {
          yield* consumePlanningReviewerFailure({
            ...failureInput,
            detail: "Reviewer completed without the required planning-reviewer-verdict directive.",
          });
          yield* consumeFastFeatureBuildFailure({
            ...failureInput,
            detail:
              "Fast feature Build completed without the required implementation-fast-build-result directive.",
          });
          yield* consumeImplementationFixerFailure({
            ...failureInput,
            detail: "QA fixer completed without the required implementation-fix-result directive.",
          });
          yield* consumeAppReviewFixerFailure({
            ...failureInput,
            detail:
              "App Review fixer completed without the required app-review-fix-result directive.",
          });
        }
        return;
      }
      if (parseResult.kind === "error") {
        yield* Effect.logWarning("provider workflow directive parse failed", {
          threadId: input.threadId,
          messageId: input.messageId,
          detail: parseResult.message,
        });
        if (synthesizeFailure) {
          yield* consumePlanningArtifactFailure({
            ...failureInput,
            detail: parseResult.message,
          });
          yield* consumePlanningReviewerFailure({
            ...failureInput,
            detail: `Reviewer directive was rejected: ${parseResult.message}`,
          });
          yield* consumeFastFeatureBuildFailure({
            ...failureInput,
            detail: `Fast feature Build directive was rejected: ${parseResult.message}`,
          });
          yield* consumeImplementationFixerFailure({
            ...failureInput,
            detail: `QA fixer directive was rejected: ${parseResult.message}`,
          });
          yield* consumeAppReviewFixerFailure({
            ...failureInput,
            detail: `App Review fixer directive was rejected: ${parseResult.message}`,
          });
        }
        return;
      }

      if (thread.workflowRole === "fast-feature-implementer") {
        const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
        const run = readModel.implementationRuns.find(
          (candidate) =>
            candidate.artifactSource === "proposed-plan" &&
            candidate.orchestratorThreadId === thread.id &&
            candidate.status !== "canceled",
        );
        if (
          parseResult.directive.type !== "implementation-fast-build-result" ||
          run === undefined ||
          parseResult.directive.runId !== run.id
        ) {
          if (synthesizeFailure) {
            yield* consumeFastFeatureBuildFailure({
              ...failureInput,
              detail:
                "Fast feature Build completed with a directive for the wrong workflow stage or run.",
            });
          }
          return;
        }
      }

      if (thread.workflowRole === "implementation-fixer") {
        const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
        const run = readModel.implementationRuns.find(
          (candidate) =>
            (candidate.status === "fixing" || candidate.status === "code-review-fixing") &&
            candidate.activeFixerThreadId === thread.id,
        );
        if (
          parseResult.directive.type !== "implementation-fix-result" ||
          run === undefined ||
          parseResult.directive.runId !== run.id
        ) {
          if (synthesizeFailure) {
            yield* consumeImplementationFixerFailure({
              ...failureInput,
              detail:
                "QA fixer completed with a directive for the wrong workflow stage or active run.",
            });
          }
          return;
        }
      }

      if (thread.workflowRole === "app-review-fixer") {
        const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
        const run = (readModel.appReviewWorkflowRuns ?? []).find(
          (candidate) =>
            candidate.status === "running" &&
            candidate.activePhase === "fixing" &&
            candidate.activeThreadId === thread.id,
        );
        const cycle = run?.cycles.at(-1);
        if (
          parseResult.directive.type !== "app-review-fix-result" ||
          run === undefined ||
          cycle?.planId === null ||
          cycle?.planId === undefined ||
          parseResult.directive.runId !== run.id ||
          parseResult.directive.planId !== cycle.planId
        ) {
          if (synthesizeFailure) {
            yield* consumeAppReviewFixerFailure({
              ...failureInput,
              detail:
                "App Review fixer completed with a directive for the wrong run or proposed plan.",
            });
          }
          return;
        }
      }

      const directiveKey = `${input.threadId}:${input.messageId}:${parseResult.directive.type}`;
      const existing = yield* Cache.getOption(processedWorkflowDirectiveKeys, directiveKey);
      if (Option.getOrElse(existing, () => false)) {
        return;
      }
      yield* Cache.set(processedWorkflowDirectiveKeys, directiveKey, true);

      const dispatchExit = yield* Effect.exit(
        dispatchWorkflowDirective({
          event: input.event,
          threadId: input.threadId,
          messageId: input.messageId,
          directive: parseResult.directive,
          createdAt: input.createdAt,
        }),
      );
      if (dispatchExit._tag === "Failure") {
        const detail = workflowDispatchErrorDetail(dispatchExit.cause);
        yield* Effect.logWarning("provider workflow directive dispatch failed", {
          threadId: input.threadId,
          messageId: input.messageId,
          directiveType: parseResult.directive.type,
          detail,
          cause: Cause.pretty(dispatchExit.cause),
        });
        yield* consumePlanningReviewerFailure({
          ...input,
          detail: `Reviewer directive was rejected: ${detail}`,
          retryable: false,
        });
        yield* consumeImplementationFixerFailure({
          ...input,
          detail: `QA fixer directive was rejected: ${detail}`,
        });
        yield* consumeAppReviewFixerFailure({
          ...input,
          detail: `App Review fixer directive was rejected: ${detail}`,
        });
        return;
      }

      const provenance = thread.workflowSubagentBatchProvenance;
      if (provenance == null) {
        return;
      }
      const parent = thread.parentThreadId
        ? yield* resolveThreadDetail(thread.parentThreadId)
        : undefined;
      const batch = parent?.workflowSubagentBatches?.find(
        (entry) => entry.id === provenance.batchId,
      );
      const child = batch?.children.find((entry) => entry.index === provenance.childIndex);
      if (!parent || !batch || !child || child.status !== "running") {
        return;
      }
      if (child.appReviewMode === "full") {
        return;
      }
      if (parseResult.directive.type !== child.expectedResult) {
        return;
      }
      const blocked =
        parseResult.directive.type === "workflow-subagent-result"
          ? parseResult.directive.status === "blocked"
          : parseResult.directive.type === "implementation-fix-result" ||
              parseResult.directive.type === "app-review-fix-result" ||
              parseResult.directive.type === "implementation-code-review-result"
            ? parseResult.directive.status === "blocked"
            : false;
      yield* orchestrationEngine.dispatch({
        type: "thread.workflow-subagent-batch.child.complete",
        commandId: workflowCommandId(batch.id, `result:${input.messageId}`, child.index),
        threadId: parent.id,
        batchId: batch.id,
        childIndex: child.index,
        status: blocked ? "blocked" : "completed",
        resultMarkdown:
          parseResult.directive.type === "workflow-subagent-result"
            ? parseResult.directive.resultMarkdown
            : input.markdown,
        completedAt: input.createdAt,
        createdAt: input.createdAt,
      });
    });

  /**
   * Settles a workflow turn that ended without the directive its role owes. Message finalization
   * cannot carry this on its own: assistant message ids are forgotten as each item completes, so
   * by `turn.completed` there is usually nothing left to finalize. Reading the turn's last
   * assistant message straight from the projection keeps the check stateless and restart-safe.
   */
  const consumeMissingWorkflowDirectiveForTurn = Effect.fn(
    "ProviderRuntimeIngestion.consumeMissingWorkflowDirectiveForTurn",
  )(function* (input: {
    readonly event: Extract<
      ProviderRuntimeEvent,
      { readonly type: "turn.completed" | "turn.aborted" }
    >;
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
    readonly createdAt: string;
  }) {
    if (!turnOwesWorkflowDirective(input.event)) return;
    const thread = yield* resolveThreadDetail(input.threadId);
    const expectedDirectiveType =
      thread?.workflowRole === "fast-feature-implementer"
        ? "implementation-fast-build-result"
        : thread?.workflowRole === "planning-reviewer"
          ? "planning-reviewer-verdict"
          : thread?.workflowRole === "implementation-fixer"
            ? "implementation-fix-result"
            : thread?.workflowRole === "app-review-fixer"
              ? "app-review-fix-result"
              : null;
    if (thread === undefined) return;

    if (expectedDirectiveType === null) {
      // A planning root thread in an artifact stage gets a rejected artifact handed back as a
      // retry. Turns that end without attempting a directive are ordinary conversation and stay
      // quiet, and an aborted turn was stopped on purpose — no retry behind the user's back.
      const stage = thread.planningWorkflow?.stage;
      if (
        input.event.type === "turn.completed" &&
        isPlanningArtifactThread(thread) &&
        (stage === "spec-authoring" || stage === "tickets-authoring")
      ) {
        const lastArtifactMessage = findLastAssistantMessageForTurn(thread.messages, input.turnId);
        const artifactParseResult = parseWorkflowDirectiveFromMarkdown(
          lastArtifactMessage?.text ?? "",
        );
        if (artifactParseResult.kind === "error") {
          yield* consumePlanningArtifactFailure({
            event: input.event,
            threadId: input.threadId,
            messageId: lastArtifactMessage?.id ?? MessageId.make(`assistant:${input.turnId}`),
            dedupeScope: input.turnId,
            createdAt: input.createdAt,
            detail: artifactParseResult.message,
          });
        }
      }
      return;
    }

    const lastAssistantMessage = findLastAssistantMessageForTurn(thread.messages, input.turnId);
    const messageId = lastAssistantMessage?.id ?? MessageId.make(`assistant:${input.turnId}`);
    // Item completion normally consumes the directive first. Re-read the durable message at the
    // terminal turn boundary as a fallback for dropped item events and process restarts between
    // message projection and directive dispatch. The in-memory key and command receipts keep the
    // ordinary path exactly-once.
    yield* maybeProcessWorkflowDirective({
      event: input.event,
      threadId: input.threadId,
      messageId,
      turnId: input.turnId,
      markdown: lastAssistantMessage?.text ?? "",
      createdAt: input.createdAt,
      synthesizeMissingDirectiveFailure: true,
    });
  });

  const flushBufferedAssistantMessage = (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    messageId: MessageId;
    turnId?: TurnId;
    createdAt: string;
    commandTag: string;
  }) =>
    Effect.gen(function* () {
      const bufferedText = yield* takeBufferedAssistantText(input.messageId);
      if (!hasRenderableAssistantText(bufferedText)) {
        return false;
      }

      yield* orchestrationEngine.dispatch({
        type: "thread.message.assistant.delta",
        commandId: yield* providerCommandId(input.event, input.commandTag),
        threadId: input.threadId,
        messageId: input.messageId,
        delta: bufferedText,
        ...(input.turnId ? { turnId: input.turnId } : {}),
        createdAt: input.createdAt,
      });
      return true;
    });

  const flushBufferedAssistantMessagesForTurn = (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    turnId: TurnId;
    createdAt: string;
    commandTag: string;
  }) =>
    Effect.gen(function* () {
      const assistantMessageIds = yield* getAssistantMessageIdsForTurn(
        input.threadId,
        input.turnId,
      );
      const flushedMessageIds = new Set<MessageId>();
      yield* Effect.forEach(
        assistantMessageIds,
        (messageId) =>
          flushBufferedAssistantMessage({
            event: input.event,
            threadId: input.threadId,
            messageId,
            turnId: input.turnId,
            createdAt: input.createdAt,
            commandTag: input.commandTag,
          }).pipe(
            Effect.tap((flushed) =>
              flushed ? Effect.sync(() => flushedMessageIds.add(messageId)) : Effect.void,
            ),
          ),
        { concurrency: 1 },
      ).pipe(Effect.asVoid);
      return flushedMessageIds;
    });

  const finalizeAssistantMessage = (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    messageId: MessageId;
    turnId?: TurnId;
    createdAt: string;
    commandTag: string;
    finalDeltaCommandTag: string;
    fallbackText?: string;
    existingText?: string;
    hasProjectedMessage?: boolean;
    processWorkflowDirective?: boolean;
    synthesizeMissingDirectiveFailure?: boolean;
  }) =>
    Effect.gen(function* () {
      const bufferedText = yield* takeBufferedAssistantText(input.messageId);
      const text =
        bufferedText.length > 0
          ? bufferedText
          : (input.fallbackText?.trim().length ?? 0) > 0
            ? input.fallbackText!
            : "";
      const hasRenderableText = hasRenderableAssistantText(text);

      if (hasRenderableText) {
        yield* orchestrationEngine.dispatch({
          type: "thread.message.assistant.delta",
          commandId: yield* providerCommandId(input.event, input.finalDeltaCommandTag),
          threadId: input.threadId,
          messageId: input.messageId,
          delta: text,
          ...(input.turnId ? { turnId: input.turnId } : {}),
          createdAt: input.createdAt,
        });
      }

      if (input.hasProjectedMessage || hasRenderableText) {
        yield* orchestrationEngine.dispatch({
          type: "thread.message.assistant.complete",
          commandId: yield* providerCommandId(input.event, input.commandTag),
          threadId: input.threadId,
          messageId: input.messageId,
          ...(input.turnId ? { turnId: input.turnId } : {}),
          createdAt: input.createdAt,
        });
      }

      if (input.processWorkflowDirective === true) {
        const directiveMarkdown = `${input.existingText ?? ""}${hasRenderableText ? text : ""}`;
        if (hasRenderableAssistantText(directiveMarkdown)) {
          yield* maybeProcessWorkflowDirective({
            event: input.event,
            threadId: input.threadId,
            messageId: input.messageId,
            ...(input.turnId ? { turnId: input.turnId } : {}),
            markdown: directiveMarkdown,
            createdAt: input.createdAt,
            ...(input.synthesizeMissingDirectiveFailure === true
              ? { synthesizeMissingDirectiveFailure: true }
              : {}),
          });
        }
      }
      yield* clearAssistantMessageState(input.messageId);
    });

  const finalizeActiveAssistantSegmentForTurn = (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    turnId: TurnId;
    createdAt: string;
    commandTag: string;
    finalDeltaCommandTag: string;
    hasProjectedMessage: boolean;
    flushedMessageIds?: ReadonlySet<MessageId>;
  }) =>
    Effect.gen(function* () {
      const activeMessageId = yield* getActiveAssistantMessageIdForTurn(
        input.threadId,
        input.turnId,
      );
      if (Option.isNone(activeMessageId)) {
        return;
      }

      yield* finalizeAssistantMessage({
        event: input.event,
        threadId: input.threadId,
        messageId: activeMessageId.value,
        turnId: input.turnId,
        createdAt: input.createdAt,
        commandTag: input.commandTag,
        finalDeltaCommandTag: input.finalDeltaCommandTag,
        hasProjectedMessage:
          input.hasProjectedMessage ||
          (input.flushedMessageIds?.has(activeMessageId.value) ?? false),
      });
      yield* forgetAssistantMessageId(input.threadId, input.turnId, activeMessageId.value);

      const state = yield* getAssistantSegmentStateForTurn(input.threadId, input.turnId);
      if (Option.isSome(state)) {
        yield* setAssistantSegmentStateForTurn(input.threadId, input.turnId, {
          ...state.value,
          activeMessageId: null,
        });
      }
    });

  const upsertProposedPlan = (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    threadProposedPlans: ReadonlyArray<{
      id: string;
      createdAt: string;
      implementedAt: string | null;
      implementationThreadId: ThreadId | null;
    }>;
    planId: string;
    turnId?: TurnId;
    planMarkdown: string | undefined;
    createdAt: string;
    updatedAt: string;
  }) =>
    Effect.gen(function* () {
      const planMarkdown = normalizeProposedPlanMarkdown(input.planMarkdown);
      if (!planMarkdown) {
        return;
      }

      const existingPlan = findProposedPlanById(input.threadProposedPlans, input.planId);
      yield* orchestrationEngine.dispatch({
        type: "thread.proposed-plan.upsert",
        commandId: yield* providerCommandId(input.event, "proposed-plan-upsert"),
        threadId: input.threadId,
        proposedPlan: {
          id: input.planId,
          turnId: input.turnId ?? null,
          planMarkdown,
          implementedAt: existingPlan?.implementedAt ?? null,
          implementationThreadId: existingPlan?.implementationThreadId ?? null,
          createdAt: existingPlan?.createdAt ?? input.createdAt,
          updatedAt: input.updatedAt,
        },
        createdAt: input.updatedAt,
      });
    });

  const finalizeBufferedProposedPlan = (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    threadProposedPlans: ReadonlyArray<{
      id: string;
      createdAt: string;
      implementedAt: string | null;
      implementationThreadId: ThreadId | null;
    }>;
    planId: string;
    turnId?: TurnId;
    fallbackMarkdown?: string;
    updatedAt: string;
  }) =>
    Effect.gen(function* () {
      const bufferedPlan = yield* takeBufferedProposedPlan(input.planId);
      const bufferedMarkdown = normalizeProposedPlanMarkdown(bufferedPlan?.text);
      const fallbackMarkdown = normalizeProposedPlanMarkdown(input.fallbackMarkdown);
      const planMarkdown = bufferedMarkdown ?? fallbackMarkdown;
      if (!planMarkdown) {
        return;
      }

      yield* upsertProposedPlan({
        event: input.event,
        threadId: input.threadId,
        threadProposedPlans: input.threadProposedPlans,
        planId: input.planId,
        ...(input.turnId ? { turnId: input.turnId } : {}),
        planMarkdown,
        createdAt:
          bufferedPlan?.createdAt && bufferedPlan.createdAt.length > 0
            ? bufferedPlan.createdAt
            : input.updatedAt,
        updatedAt: input.updatedAt,
      });
      yield* clearBufferedProposedPlan(input.planId);
    });

  const clearTurnStateForSession = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const prefix = `${threadId}:`;
      const proposedPlanPrefix = `plan:${threadId}:`;
      const turnKeys = Array.from(yield* Cache.keys(turnMessageIdsByTurnKey));
      const assistantSegmentKeys = Array.from(yield* Cache.keys(assistantSegmentStateByTurnKey));
      const proposedPlanKeys = Array.from(yield* Cache.keys(bufferedProposedPlanById));
      const taskDescriptionKeys = Array.from(yield* Cache.keys(taskDescriptionByTaskKey));
      yield* Effect.forEach(
        turnKeys,
        (key) =>
          Effect.gen(function* () {
            if (!key.startsWith(prefix)) {
              return;
            }

            const messageIds = yield* Cache.getOption(turnMessageIdsByTurnKey, key);
            if (Option.isSome(messageIds)) {
              yield* Effect.forEach(messageIds.value, clearAssistantMessageState, {
                concurrency: 1,
              }).pipe(Effect.asVoid);
            }

            yield* Cache.invalidate(turnMessageIdsByTurnKey, key);
          }),
        { concurrency: 1 },
      ).pipe(Effect.asVoid);
      yield* Effect.forEach(
        assistantSegmentKeys,
        (key) =>
          key.startsWith(prefix)
            ? Cache.invalidate(assistantSegmentStateByTurnKey, key)
            : Effect.void,
        { concurrency: 1 },
      ).pipe(Effect.asVoid);
      yield* Effect.forEach(
        proposedPlanKeys,
        (key) =>
          key.startsWith(proposedPlanPrefix)
            ? Cache.invalidate(bufferedProposedPlanById, key)
            : Effect.void,
        { concurrency: 1 },
      ).pipe(Effect.asVoid);
      yield* Effect.forEach(
        taskDescriptionKeys,
        (key) =>
          key.startsWith(prefix) ? Cache.invalidate(taskDescriptionByTaskKey, key) : Effect.void,
        { concurrency: 1 },
      ).pipe(Effect.asVoid);
    });

  const getSourceProposedPlanReferenceForPendingTurnStart = Effect.fn(
    "getSourceProposedPlanReferenceForPendingTurnStart",
  )(function* (threadId: ThreadId) {
    const pendingTurnStart = yield* projectionTurnRepository.getPendingTurnStartByThreadId({
      threadId,
    });
    if (Option.isNone(pendingTurnStart)) {
      return null;
    }

    const sourceThreadId = pendingTurnStart.value.sourceProposedPlanThreadId;
    const sourcePlanId = pendingTurnStart.value.sourceProposedPlanId;
    if (sourceThreadId === null || sourcePlanId === null) {
      return null;
    }

    return {
      sourceThreadId,
      sourcePlanId,
    } as const;
  });

  const getExpectedProviderTurnIdForThread = Effect.fn("getExpectedProviderTurnIdForThread")(
    function* (threadId: ThreadId) {
      const sessions = yield* providerService.listSessions();
      const session = sessions.find((entry) => entry.threadId === threadId);
      return session?.activeTurnId;
    },
  );

  const getSourceProposedPlanReferenceForAcceptedTurnStart = Effect.fn(
    "getSourceProposedPlanReferenceForAcceptedTurnStart",
  )(function* (threadId: ThreadId, eventTurnId: TurnId | undefined) {
    if (eventTurnId === undefined) {
      return null;
    }

    const expectedTurnId = yield* getExpectedProviderTurnIdForThread(threadId);
    if (!sameId(expectedTurnId, eventTurnId)) {
      return null;
    }

    return yield* getSourceProposedPlanReferenceForPendingTurnStart(threadId);
  });

  const markSourceProposedPlanImplemented = Effect.fn("markSourceProposedPlanImplemented")(
    function* (
      sourceThreadId: ThreadId,
      sourcePlanId: OrchestrationProposedPlanId,
      implementationThreadId: ThreadId,
      implementedAt: string,
    ) {
      const sourceThread = yield* resolveThreadDetail(sourceThreadId);
      const sourcePlan = sourceThread?.proposedPlans.find((entry) => entry.id === sourcePlanId);
      if (!sourceThread || !sourcePlan || sourcePlan.implementedAt !== null) {
        return;
      }

      const commandUuid = yield* crypto.randomUUIDv4;
      yield* orchestrationEngine.dispatch({
        type: "thread.proposed-plan.upsert",
        commandId: CommandId.make(
          `provider:source-proposed-plan-implemented:${implementationThreadId}:${commandUuid}`,
        ),
        threadId: sourceThread.id,
        proposedPlan: {
          ...sourcePlan,
          implementedAt,
          implementationThreadId,
          updatedAt: implementedAt,
        },
        createdAt: implementedAt,
      });
    },
  );

  const processRuntimeEvent = (event: ProviderRuntimeEvent) =>
    Effect.gen(function* () {
      const thread = yield* resolveThreadShell(event.threadId);
      if (!thread) return;

      let loadedThreadDetail: OrchestrationThread | null | undefined;
      const getLoadedThreadDetail = () =>
        Effect.gen(function* () {
          if (loadedThreadDetail !== undefined) {
            return loadedThreadDetail;
          }
          loadedThreadDetail = (yield* resolveThreadDetail(thread.id)) ?? null;
          return loadedThreadDetail;
        });

      const now = event.createdAt;
      const eventTurnId = toTurnId(event.turnId);
      const activeTurnId = thread.session?.activeTurnId ?? null;
      const pendingTurnStart = yield* projectionTurnRepository.getPendingTurnStartByThreadId({
        threadId: thread.id,
      });
      const hasPendingTurnStart =
        Option.isSome(pendingTurnStart) && thread.session?.status === "starting";

      const conflictsWithActiveTurn =
        activeTurnId !== null && eventTurnId !== undefined && !sameId(activeTurnId, eventTurnId);
      const missingTurnForActiveTurn = activeTurnId !== null && eventTurnId === undefined;

      // A turn.started that conflicts with the active turn is legitimate when
      // the server itself has a turn start pending for this thread AND the
      // provider session already tracks the event's turn as its active turn:
      // steering a running turn makes some providers (e.g. opencode) open a
      // new turn without ever completing the superseded one. A stale
      // turn.started for some other turn id still gets rejected.
      const conflictingTurnStartIsPendingTurnStart =
        event.type === "turn.started" && conflictsWithActiveTurn
          ? sameId(yield* getExpectedProviderTurnIdForThread(thread.id), eventTurnId) &&
            Option.isSome(pendingTurnStart)
          : false;

      const shouldApplyThreadLifecycle = (() => {
        if (!STRICT_PROVIDER_LIFECYCLE_GUARD) {
          return true;
        }
        switch (event.type) {
          case "session.exited":
            return true;
          case "session.started":
          case "thread.started":
            return true;
          case "turn.started":
            return !conflictsWithActiveTurn || conflictingTurnStartIsPendingTurnStart;
          case "turn.completed":
            if (conflictsWithActiveTurn || missingTurnForActiveTurn) {
              return false;
            }
            // Only the active turn may close the lifecycle state.
            if (activeTurnId !== null && eventTurnId !== undefined) {
              return sameId(activeTurnId, eventTurnId);
            }
            // No active turn tracked: accept only completions that name their
            // turn (covers a real completion whose turn.started was lost). An
            // untargeted completion cannot prove it belongs to any turn this
            // thread ran — the known emitter was the Claude resume handshake
            // (system/init + result(num_turns: 0)), which is not a turn at
            // all — and applying it here stomps the "starting" lifecycle
            // state while a turn start is pending.
            return eventTurnId !== undefined;
          default:
            return true;
        }
      })();
      const acceptedTurnStartedSourcePlan =
        event.type === "turn.started" && shouldApplyThreadLifecycle
          ? yield* getSourceProposedPlanReferenceForAcceptedTurnStart(thread.id, eventTurnId)
          : null;

      if (
        event.type === "session.started" ||
        event.type === "session.state.changed" ||
        event.type === "session.exited" ||
        event.type === "thread.started" ||
        event.type === "turn.started" ||
        event.type === "turn.completed"
      ) {
        const status = (() => {
          switch (event.type) {
            case "session.state.changed": {
              const runtimeStatus = orchestrationSessionStatusFromRuntimeState(event.payload.state);
              return hasPendingTurnStart && runtimeStatus === "ready" ? "starting" : runtimeStatus;
            }
            case "turn.started":
              return "running";
            case "session.exited":
              return "stopped";
            case "turn.completed":
              return normalizeRuntimeTurnState(event.payload.state) === "failed"
                ? "error"
                : "ready";
            case "session.started":
            case "thread.started":
              // Provider thread/session start notifications can arrive during an
              // active or pending turn; preserve that lifecycle state.
              return activeTurnId !== null ? "running" : hasPendingTurnStart ? "starting" : "ready";
          }
        })();
        const nextActiveTurnId =
          event.type === "turn.started"
            ? (eventTurnId ?? null)
            : event.type === "turn.completed" || event.type === "session.exited"
              ? null
              : event.type === "session.state.changed" &&
                  !sessionStatusAllowsActiveTurn(
                    orchestrationSessionStatusFromRuntimeState(event.payload.state),
                  )
                ? null
                : activeTurnId;
        const lastError =
          event.type === "session.state.changed" && event.payload.state === "error"
            ? (event.payload.reason ?? thread.session?.lastError ?? "Provider session error")
            : event.type === "turn.completed" &&
                normalizeRuntimeTurnState(event.payload.state) === "failed"
              ? (event.payload.errorMessage ?? thread.session?.lastError ?? "Turn failed")
              : status === "ready"
                ? null
                : (thread.session?.lastError ?? null);

        if (shouldApplyThreadLifecycle) {
          if (event.type === "turn.started" && acceptedTurnStartedSourcePlan !== null) {
            yield* markSourceProposedPlanImplemented(
              acceptedTurnStartedSourcePlan.sourceThreadId,
              acceptedTurnStartedSourcePlan.sourcePlanId,
              thread.id,
              now,
            ).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning(
                  "provider runtime ingestion failed to mark source proposed plan",
                  {
                    eventId: event.eventId,
                    eventType: event.type,
                    cause: Cause.pretty(cause),
                  },
                ),
              ),
            );
          }

          yield* orchestrationEngine.dispatch({
            type: "thread.session.set",
            commandId: yield* providerCommandId(event, "thread-session-set"),
            threadId: thread.id,
            session: {
              threadId: thread.id,
              status,
              providerName: event.provider,
              ...(event.providerInstanceId !== undefined
                ? { providerInstanceId: event.providerInstanceId }
                : {}),
              runtimeMode: thread.session?.runtimeMode ?? "full-access",
              activeTurnId: nextActiveTurnId,
              lastError,
              updatedAt: now,
            },
            createdAt: now,
          });

          if (
            event.type === "turn.completed" &&
            normalizeRuntimeTurnState(event.payload.state) === "failed" &&
            eventTurnId !== undefined
          ) {
            const recovery = event.payload.recovery ?? {
              disposition: "unknown" as const,
              reason: "unknown" as const,
            };
            yield* orchestrationEngine.dispatch({
              type: "thread.activity.append",
              commandId: yield* providerCommandId(event, "provider-turn-failed"),
              threadId: thread.id,
              activity: {
                id: EventId.make(yield* crypto.randomUUIDv4),
                tone: "error",
                kind: "provider.turn.failed",
                summary: `Provider turn failed: ${recovery.reason}`,
                payload: {
                  turnId: eventTurnId,
                  provider: event.provider,
                  providerInstanceId:
                    event.providerInstanceId ?? thread.session?.providerInstanceId ?? null,
                  model: thread.modelSelection.model,
                  recovery,
                  errorMessage: event.payload.errorMessage ?? null,
                },
                turnId: eventTurnId,
                createdAt: now,
              },
              createdAt: now,
            });
          }
        }
      }

      const assistantDelta =
        event.type === "content.delta" && event.payload.streamKind === "assistant_text"
          ? event.payload.delta
          : undefined;
      const proposedPlanDelta =
        event.type === "turn.proposed.delta" ? event.payload.delta : undefined;

      if (assistantDelta && assistantDelta.length > 0) {
        const turnId = toTurnId(event.turnId);
        const assistantMessageId = yield* getOrCreateAssistantMessageId({
          threadId: thread.id,
          event,
          ...(turnId ? { turnId } : {}),
        });
        if (turnId) {
          yield* rememberAssistantMessageId(thread.id, turnId, assistantMessageId);
        }

        const assistantDeliveryMode: AssistantDeliveryMode = yield* Effect.map(
          serverSettingsService.getSettings,
          (settings) => (settings.enableLegacyTokenStreaming ? "streaming" : "buffered"),
        );
        if (assistantDeliveryMode === "buffered") {
          const spillChunk = yield* appendBufferedAssistantText(assistantMessageId, assistantDelta);
          if (spillChunk.length > 0) {
            yield* orchestrationEngine.dispatch({
              type: "thread.message.assistant.delta",
              commandId: yield* providerCommandId(event, "assistant-delta-buffer-spill"),
              threadId: thread.id,
              messageId: assistantMessageId,
              delta: spillChunk,
              ...(turnId ? { turnId } : {}),
              createdAt: now,
            });
          }
        } else {
          yield* orchestrationEngine.dispatch({
            type: "thread.message.assistant.delta",
            commandId: yield* providerCommandId(event, "assistant-delta"),
            threadId: thread.id,
            messageId: assistantMessageId,
            delta: assistantDelta,
            ...(turnId ? { turnId } : {}),
            createdAt: now,
          });
        }
      }

      const pauseForUserTurnId =
        event.type === "request.opened" || event.type === "user-input.requested"
          ? toTurnId(event.turnId)
          : undefined;
      if (pauseForUserTurnId) {
        const detailedThread = yield* getLoadedThreadDetail();
        const assistantDeliveryMode: AssistantDeliveryMode = yield* Effect.map(
          serverSettingsService.getSettings,
          (settings) => (settings.enableLegacyTokenStreaming ? "streaming" : "buffered"),
        );
        const flushedMessageIds =
          assistantDeliveryMode === "buffered"
            ? yield* flushBufferedAssistantMessagesForTurn({
                event,
                threadId: thread.id,
                turnId: pauseForUserTurnId,
                createdAt: now,
                commandTag:
                  event.type === "request.opened"
                    ? "assistant-delta-flush-on-request-opened"
                    : "assistant-delta-flush-on-user-input-requested",
              })
            : new Set<MessageId>();
        yield* finalizeActiveAssistantSegmentForTurn({
          event,
          threadId: thread.id,
          turnId: pauseForUserTurnId,
          createdAt: now,
          commandTag:
            event.type === "request.opened"
              ? "assistant-complete-on-request-opened"
              : "assistant-complete-on-user-input-requested",
          finalDeltaCommandTag:
            event.type === "request.opened"
              ? "assistant-delta-finalize-on-request-opened"
              : "assistant-delta-finalize-on-user-input-requested",
          hasProjectedMessage:
            detailedThread !== null &&
            hasAssistantMessageForTurn(detailedThread.messages, pauseForUserTurnId, {
              streamingOnly: true,
            }),
          flushedMessageIds,
        });
      }

      if (proposedPlanDelta && proposedPlanDelta.length > 0) {
        const planId = proposedPlanIdFromEvent(event, thread.id);
        yield* appendBufferedProposedPlan(planId, proposedPlanDelta, now);
      }

      const assistantCompletion =
        event.type === "item.completed" && event.payload.itemType === "assistant_message"
          ? {
              messageId: MessageId.make(
                `assistant:${event.itemId ?? event.turnId ?? event.eventId}`,
              ),
              fallbackText: event.payload.detail,
            }
          : undefined;
      const proposedPlanCompletion =
        event.type === "turn.proposed.completed"
          ? {
              planId: proposedPlanIdFromEvent(event, thread.id),
              turnId: toTurnId(event.turnId),
              planMarkdown: event.payload.planMarkdown,
            }
          : undefined;

      if (assistantCompletion) {
        const detailedThread = yield* getLoadedThreadDetail();
        const messages = detailedThread?.messages ?? [];
        const turnId = toTurnId(event.turnId);
        const activeAssistantMessageId = turnId
          ? yield* getActiveAssistantMessageIdForTurn(thread.id, turnId)
          : Option.none<MessageId>();
        const hasAssistantMessagesForTurn =
          turnId !== undefined ? hasAssistantMessageForTurn(messages, turnId) : false;
        const assistantMessageId = Option.getOrElse(
          activeAssistantMessageId,
          () => assistantCompletion.messageId,
        );
        const existingAssistantMessage = findMessageById(messages, assistantMessageId);
        const shouldApplyFallbackCompletionText =
          !existingAssistantMessage || existingAssistantMessage.text.length === 0;

        const shouldSkipRedundantCompletion =
          Option.isNone(activeAssistantMessageId) &&
          turnId !== undefined &&
          hasAssistantMessagesForTurn &&
          (assistantCompletion.fallbackText?.trim().length ?? 0) === 0;

        if (!shouldSkipRedundantCompletion) {
          if (turnId && Option.isNone(activeAssistantMessageId)) {
            yield* rememberAssistantMessageId(thread.id, turnId, assistantMessageId);
          }

          yield* finalizeAssistantMessage({
            event,
            threadId: thread.id,
            messageId: assistantMessageId,
            ...(turnId ? { turnId } : {}),
            createdAt: now,
            commandTag: "assistant-complete",
            finalDeltaCommandTag: "assistant-delta-finalize",
            hasProjectedMessage: existingAssistantMessage !== undefined,
            processWorkflowDirective: true,
            // One assistant item is a segment of a turn, not the end of it.
            synthesizeMissingDirectiveFailure: false,
            ...(existingAssistantMessage?.text !== undefined
              ? { existingText: existingAssistantMessage.text }
              : {}),
            ...(assistantCompletion.fallbackText !== undefined && shouldApplyFallbackCompletionText
              ? { fallbackText: assistantCompletion.fallbackText }
              : {}),
          });

          if (turnId) {
            yield* forgetAssistantMessageId(thread.id, turnId, assistantMessageId);
          }
        }

        if (turnId) {
          yield* clearAssistantSegmentStateForTurn(thread.id, turnId);
        }
      }

      if (proposedPlanCompletion) {
        const detailedThread = yield* getLoadedThreadDetail();
        yield* finalizeBufferedProposedPlan({
          event,
          threadId: thread.id,
          threadProposedPlans: detailedThread?.proposedPlans ?? [],
          planId: proposedPlanCompletion.planId,
          ...(proposedPlanCompletion.turnId ? { turnId: proposedPlanCompletion.turnId } : {}),
          fallbackMarkdown: proposedPlanCompletion.planMarkdown,
          updatedAt: now,
        });
      }

      if (event.type === "turn.completed") {
        const detailedThread = yield* getLoadedThreadDetail();
        const messages = detailedThread?.messages ?? [];
        const proposedPlans = detailedThread?.proposedPlans ?? [];
        const turnId = toTurnId(event.turnId);
        const turnCompletedSuccessfully = turnOwesWorkflowDirective(event);
        if (turnId) {
          const assistantMessageIds = yield* getAssistantMessageIdsForTurn(thread.id, turnId);
          yield* Effect.forEach(
            assistantMessageIds,
            (assistantMessageId) =>
              finalizeAssistantMessage({
                event,
                threadId: thread.id,
                messageId: assistantMessageId,
                turnId,
                createdAt: now,
                commandTag: "assistant-complete-finalize",
                finalDeltaCommandTag: "assistant-delta-finalize-fallback",
                hasProjectedMessage: findMessageById(messages, assistantMessageId) !== undefined,
                processWorkflowDirective: true,
                synthesizeMissingDirectiveFailure: turnCompletedSuccessfully,
                ...(findMessageById(messages, assistantMessageId)?.text !== undefined
                  ? { existingText: findMessageById(messages, assistantMessageId)!.text }
                  : {}),
              }),
            { concurrency: 1 },
          ).pipe(Effect.asVoid);
          yield* clearAssistantMessageIdsForTurn(thread.id, turnId);
          yield* clearAssistantSegmentStateForTurn(thread.id, turnId);

          yield* finalizeBufferedProposedPlan({
            event,
            threadId: thread.id,
            threadProposedPlans: proposedPlans,
            planId: proposedPlanIdForTurn(thread.id, turnId),
            turnId,
            updatedAt: now,
          });

          if (turnCompletedSuccessfully) {
            yield* consumeMissingWorkflowDirectiveForTurn({
              event,
              threadId: thread.id,
              turnId,
              createdAt: now,
            });
          }
        }
      }

      if (event.type === "session.exited") {
        yield* clearTurnStateForSession(thread.id);
      }

      if (event.type === "runtime.error") {
        const runtimeErrorMessage = event.payload.message;

        const shouldApplyRuntimeError = !STRICT_PROVIDER_LIFECYCLE_GUARD
          ? true
          : activeTurnId === null || eventTurnId === undefined || sameId(activeTurnId, eventTurnId);

        if (shouldApplyRuntimeError) {
          yield* orchestrationEngine.dispatch({
            type: "thread.session.set",
            commandId: yield* providerCommandId(event, "runtime-error-session-set"),
            threadId: thread.id,
            session: {
              threadId: thread.id,
              status: "error",
              providerName: event.provider,
              ...(event.providerInstanceId !== undefined
                ? { providerInstanceId: event.providerInstanceId }
                : {}),
              runtimeMode: thread.session?.runtimeMode ?? "full-access",
              activeTurnId: eventTurnId ?? null,
              lastError: runtimeErrorMessage,
              updatedAt: now,
            },
            createdAt: now,
          });
        }
      }

      if (event.type === "thread.metadata.updated" && event.payload.name) {
        if (canReplaceThreadTitle(thread.title)) {
          yield* orchestrationEngine.dispatch({
            type: "thread.meta.update",
            commandId: yield* providerCommandId(event, "thread-meta-update"),
            threadId: thread.id,
            title: event.payload.name,
          });
        }
      }

      if (event.type === "turn.diff.updated") {
        const turnId = toTurnId(event.turnId);
        const checkpointContext = turnId
          ? yield* projectionSnapshotQuery
              .getThreadCheckpointContext(thread.id)
              .pipe(Effect.map(Option.getOrUndefined))
          : undefined;
        const workspaceCwd =
          checkpointContext?.worktreePath ?? checkpointContext?.workspaceRoot ?? undefined;
        if (turnId && checkpointContext && workspaceCwd && isGitRepository(workspaceCwd)) {
          // Skip if a checkpoint already exists for this turn. A real
          // (non-placeholder) capture from CheckpointReactor should not
          // be clobbered, and dispatching a duplicate placeholder for the
          // same turnId would produce an unstable checkpointTurnCount.
          if (hasCheckpointForTurn(checkpointContext.checkpoints, turnId)) {
            // Already tracked; no-op.
          } else {
            const assistantMessageId = MessageId.make(
              `assistant:${event.itemId ?? event.turnId ?? event.eventId}`,
            );
            yield* orchestrationEngine.dispatch({
              type: "thread.turn.diff.complete",
              commandId: yield* providerCommandId(event, "thread-turn-diff-complete"),
              threadId: thread.id,
              turnId,
              completedAt: now,
              checkpointRef: CheckpointRef.make(`provider-diff:${event.eventId}`),
              status: "missing",
              files: [],
              assistantMessageId,
              checkpointTurnCount: maxCheckpointTurnCount(checkpointContext.checkpoints) + 1,
              createdAt: now,
            });
          }
        }
      }

      if (
        event.type === "turn.completed" &&
        activeTurnId !== null &&
        eventTurnId !== undefined &&
        sameId(activeTurnId, eventTurnId)
      ) {
        yield* settleRunningBatchChildAfterTermination(
          thread,
          now,
          "failed",
          normalizeRuntimeTurnState(event.payload.state) === "failed"
            ? (event.payload.errorMessage ?? "Workflow sub-agent turn failed.")
            : "Workflow sub-agent turn completed without its required result directive.",
        );
        yield* settleCanonicalAppReviewAfterTermination({ event, thread, completedAt: now });
      } else if (event.type === "session.exited") {
        yield* settleRunningBatchChildAfterTermination(
          thread,
          now,
          "canceled",
          "Workflow sub-agent session exited before producing its required result.",
        );
        yield* settleCanonicalAppReviewAfterTermination({ event, thread, completedAt: now });
      } else if (event.type === "runtime.error") {
        yield* settleRunningBatchChildAfterTermination(
          thread,
          now,
          "failed",
          event.payload.message,
        );
        yield* settleCanonicalAppReviewAfterTermination({ event, thread, completedAt: now });
      }

      if (event.type === "task.started" || event.type === "task.progress") {
        const description = event.payload.description?.trim();
        if (description) {
          yield* rememberTaskDescription(thread.id, event.payload.taskId, description);
        }
      }
      // Working-indicator plan progress: current step while the turn runs,
      // cleared on settle so a finished plan never lingers as stale UI.
      // Events carrying a turn id that conflicts with the active turn are
      // stale (superseded turn) and must neither overwrite nor clear the
      // active turn's progress; session.exited always clears.
      if (event.type === "session.exited") {
        threadPlanProgress.clearThreadPlanProgress(thread.id);
      } else if (!conflictsWithActiveTurn) {
        if (event.type === "turn.plan.updated") {
          threadPlanProgress.recordPlanProgress(thread.id, event.payload.plan);
        } else if (event.type === "turn.completed" || event.type === "turn.aborted") {
          threadPlanProgress.clearThreadPlanProgress(thread.id);
        }
      }

      // Sidebar background liveness: fed from the same lifecycle stream,
      // read by the shell query at mapping time (no persistence).
      switch (event.type) {
        case "task.started":
        case "task.progress":
        case "task.updated":
        case "task.completed": {
          const payload = event.payload as {
            taskId: string;
            taskType?: string;
            status?: string;
            agentId?: string;
          };
          threadBackgroundLiveness.recordTaskLiveness({
            threadId: thread.id,
            taskId: payload.taskId,
            taskType: payload.taskType,
            status: payload.status,
            agentId: payload.agentId,
            kind:
              event.type === "task.started"
                ? "started"
                : event.type === "task.progress"
                  ? "progress"
                  : event.type === "task.updated"
                    ? "updated"
                    : "completed",
          });
          break;
        }
        case "session.exited":
          threadBackgroundLiveness.clearThreadLiveness(thread.id);
          break;
        default:
          break;
      }

      let taskTitle: string | undefined;
      if (event.type === "task.completed") {
        taskTitle = yield* lookupTaskDescription(thread.id, event.payload.taskId);
        if (!taskTitle) {
          const threadDetail = yield* getLoadedThreadDetail();
          taskTitle = findTaskTitleInActivities(threadDetail?.activities, event.payload.taskId);
        }
      }

      const activities = runtimeEventToActivities(event, taskTitle);
      yield* Effect.forEach(activities, (activity) =>
        providerCommandId(event, "thread-activity-append").pipe(
          Effect.flatMap((commandId) =>
            orchestrationEngine.dispatch({
              type: "thread.activity.append",
              commandId,
              threadId: thread.id,
              activity,
              createdAt: activity.createdAt,
            }),
          ),
        ),
      ).pipe(Effect.asVoid);
    });

  const processDomainEvent = (event: IngestionDomainEvent) =>
    Effect.gen(function* () {
      if (event.type === "thread.workflow-subagent-batch-child-updated") {
        yield* maybeCompleteWorkflowSubagentBatch(
          event.payload.threadId,
          event.payload.batchId,
          event.occurredAt,
        );
        return;
      }
      if (event.type === "thread.app-review-updated") {
        if (event.payload.status !== "passed" && event.payload.status !== "failed") {
          return;
        }
        yield* completeFullAppReviewBatchChild(event.payload.reviewId, event.occurredAt);
      }
    });

  const processInput = (input: RuntimeIngestionInput) =>
    input.source === "runtime" ? processRuntimeEvent(input.event) : processDomainEvent(input.event);

  const processInputSafely = (input: RuntimeIngestionInput) =>
    processInput(input).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("provider runtime ingestion failed to process event", {
          source: input.source,
          eventId: input.event.eventId,
          eventType: input.event.type,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeKeyedDrainableWorker({
    key: (input: RuntimeIngestionInput) =>
      String(input.source === "runtime" ? input.event.threadId : input.event.aggregateId),
    process: processInputSafely,
  });

  const start: ProviderRuntimeIngestionShape["start"] = () =>
    Effect.gen(function* () {
      // These streams are hot and do not replay. Startup reconciliation may launch provider turns
      // before server activation, so acquire both subscriptions synchronously before forking.
      const runtimeEvents =
        providerService.subscribeEvents === undefined
          ? providerService.streamEvents
          : Stream.fromSubscription(yield* providerService.subscribeEvents);
      const domainEvents =
        orchestrationEngine.subscribeDomainEvents === undefined
          ? orchestrationEngine.streamDomainEvents
          : Stream.fromSubscription(yield* orchestrationEngine.subscribeDomainEvents);
      yield* Effect.forkScoped(
        Stream.runForEach(runtimeEvents, (event) => worker.enqueue({ source: "runtime", event })),
      );
      yield* Effect.forkScoped(
        Stream.runForEach(domainEvents, (event) => {
          if (
            event.type !== "thread.turn-start-requested" &&
            event.type !== "thread.workflow-subagent-batch-child-updated" &&
            event.type !== "thread.app-review-updated"
          ) {
            return Effect.void;
          }
          return worker.enqueue({ source: "domain", event });
        }),
      );
    });

  return {
    start,
    drain: worker.drain,
  } satisfies ProviderRuntimeIngestionShape;
});

export const ProviderRuntimeIngestionLive = Layer.effect(
  ProviderRuntimeIngestionService,
  make,
).pipe(Layer.provide(ProjectionTurnRepositoryLive));
