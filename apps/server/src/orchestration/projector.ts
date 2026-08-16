import type { OrchestrationEvent, OrchestrationReadModel, ThreadId } from "@t3tools/contracts";
import {
  type AppReviewRecord,
  type AppReviewWorkflowRun,
  type OrchestrationImplementationRun,
  OrchestrationCheckpointSummary,
  OrchestrationMessage,
  OrchestrationPlanningWorkflow,
  OrchestrationSession,
  OrchestrationThread,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { toProjectorDecodeError, type OrchestrationProjectorDecodeError } from "./Errors.ts";
import {
  MessageSentPayloadSchema,
  ProjectCreatedPayload,
  ProjectDeletedPayload,
  ProjectMetaUpdatedPayload,
  ThreadActivityAppendedPayload,
  ThreadArchivedPayload,
  ThreadCreatedPayload,
  ThreadDeletedPayload,
  ThreadAppReviewCreatedPayload,
  ThreadAppReviewEvidenceUpdatedPayload,
  ThreadAppReviewUpdatedPayload,
  ThreadAppReviewWorkflowLaunchedPayload,
  ThreadAppReviewWorkflowUpdatedPayload,
  ThreadAppReviewWorkflowCancelRequestedPayload,
  ThreadAppReviewWorkflowResumeRequestedPayload,
  ThreadWorkflowSubagentBatchCreatedPayload,
  ThreadWorkflowSubagentBatchChildUpdatedPayload,
  ThreadWorkflowSubagentBatchCompletedPayload,
  ThreadInteractionModeSetPayload,
  ThreadComposerModeSetPayload,
  ThreadMetaUpdatedPayload,
  ThreadImplementationChangeRequestRetryRequestedPayload,
  ThreadImplementationRunCancelRequestedPayload,
  ThreadImplementationRunLaunchedPayload,
  ThreadImplementationRunUpdatedPayload,
  ThreadPlanningTicketReviewRequestedPayload,
  ThreadPlanningTicketsCreatedPayload,
  ThreadPlanningTicketsRevisedPayload,
  ThreadPlanningSpecBundleLoadedPayload,
  ThreadPlanningSpecCreatedPayload,
  ThreadPlanningStageStartedPayload,
  ThreadPlanningWorkflowStageSetPayload,
  ThreadProposedPlanUpsertedPayload,
  ThreadRuntimeModeSetPayload,
  ThreadSettledPayload,
  ThreadPinnedPayload,
  ThreadPinReorderedPayload,
  ThreadSnoozedPayload,
  ThreadUnpinnedPayload,
  ThreadUnarchivedPayload,
  ThreadUnsettledPayload,
  ThreadUnsnoozedPayload,
  ThreadRevertedPayload,
  ThreadSessionSetPayload,
  ThreadTurnDiffCompletedPayload,
} from "./Schemas.ts";

type ThreadPatch = Partial<Omit<OrchestrationThread, "id" | "projectId">>;
const MAX_THREAD_MESSAGES = 2_000;
const MAX_THREAD_CHECKPOINTS = 500;

function checkpointStatusToLatestTurnState(status: "ready" | "missing" | "error") {
  if (status === "error") return "error" as const;
  if (status === "missing") return "interrupted" as const;
  return "completed" as const;
}

/**
 * Turn state to settle a still-running latest turn with when its session
 * leaves the "running" status, or null while the session is (re)starting or
 * running and the turn must stay unsettled.
 */
function settledTurnStateForSessionStatus(
  status: OrchestrationSession["status"],
): "completed" | "interrupted" | "error" | null {
  switch (status) {
    case "idle":
    case "ready":
      return "completed";
    case "error":
      return "error";
    case "interrupted":
    case "stopped":
      return "interrupted";
    case "starting":
    case "running":
      return null;
  }
}

function updateThread(
  threads: ReadonlyArray<OrchestrationThread>,
  threadId: ThreadId,
  patch: ThreadPatch,
): OrchestrationThread[] {
  return threads.map((thread) => (thread.id === threadId ? { ...thread, ...patch } : thread));
}

function decodeForEvent<A>(
  schema: Schema.Decoder<A, never>,
  value: unknown,
  eventType: OrchestrationEvent["type"],
  field: string,
): Effect.Effect<A, OrchestrationProjectorDecodeError> {
  return Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError(toProjectorDecodeError(`${eventType}:${field}`)),
  );
}

function retainThreadMessagesAfterRevert(
  messages: ReadonlyArray<OrchestrationMessage>,
  retainedTurnIds: ReadonlySet<string>,
  turnCount: number,
): ReadonlyArray<OrchestrationMessage> {
  const retainedMessageIds = new Set<string>();
  for (const message of messages) {
    if (message.role === "system") {
      retainedMessageIds.add(message.id);
      continue;
    }
    if (message.turnId !== null && retainedTurnIds.has(message.turnId)) {
      retainedMessageIds.add(message.id);
    }
  }

  const retainedUserCount = messages.filter(
    (message) => message.role === "user" && retainedMessageIds.has(message.id),
  ).length;
  const missingUserCount = Math.max(0, turnCount - retainedUserCount);
  if (missingUserCount > 0) {
    const fallbackUserMessages = messages
      .filter(
        (message) =>
          message.role === "user" &&
          !retainedMessageIds.has(message.id) &&
          (message.turnId === null || retainedTurnIds.has(message.turnId)),
      )
      .toSorted(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
      )
      .slice(0, missingUserCount);
    for (const message of fallbackUserMessages) {
      retainedMessageIds.add(message.id);
    }
  }

  const retainedAssistantCount = messages.filter(
    (message) => message.role === "assistant" && retainedMessageIds.has(message.id),
  ).length;
  const missingAssistantCount = Math.max(0, turnCount - retainedAssistantCount);
  if (missingAssistantCount > 0) {
    const fallbackAssistantMessages = messages
      .filter(
        (message) =>
          message.role === "assistant" &&
          !retainedMessageIds.has(message.id) &&
          (message.turnId === null || retainedTurnIds.has(message.turnId)),
      )
      .toSorted(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
      )
      .slice(0, missingAssistantCount);
    for (const message of fallbackAssistantMessages) {
      retainedMessageIds.add(message.id);
    }
  }

  return messages.filter((message) => retainedMessageIds.has(message.id));
}

function retainThreadActivitiesAfterRevert(
  activities: ReadonlyArray<OrchestrationThread["activities"][number]>,
  retainedTurnIds: ReadonlySet<string>,
): ReadonlyArray<OrchestrationThread["activities"][number]> {
  return activities.filter(
    (activity) => activity.turnId === null || retainedTurnIds.has(activity.turnId),
  );
}

function retainThreadProposedPlansAfterRevert(
  proposedPlans: ReadonlyArray<OrchestrationThread["proposedPlans"][number]>,
  retainedTurnIds: ReadonlySet<string>,
): ReadonlyArray<OrchestrationThread["proposedPlans"][number]> {
  return proposedPlans.filter(
    (proposedPlan) => proposedPlan.turnId === null || retainedTurnIds.has(proposedPlan.turnId),
  );
}

function compareThreadActivities(
  left: OrchestrationThread["activities"][number],
  right: OrchestrationThread["activities"][number],
): number {
  if (left.sequence !== undefined && right.sequence !== undefined) {
    if (left.sequence !== right.sequence) {
      return left.sequence - right.sequence;
    }
  } else if (left.sequence !== undefined) {
    return 1;
  } else if (right.sequence !== undefined) {
    return -1;
  }

  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

function compareAppReviews(left: AppReviewRecord, right: AppReviewRecord): number {
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

function compareImplementationRuns(
  left: OrchestrationImplementationRun,
  right: OrchestrationImplementationRun,
): number {
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

function upsertAppReview(
  appReviews: ReadonlyArray<AppReviewRecord>,
  appReview: AppReviewRecord,
): AppReviewRecord[] {
  return [...appReviews.filter((entry) => entry.id !== appReview.id), appReview]
    .toSorted(compareAppReviews)
    .slice(-200);
}

function upsertImplementationRun(
  runs: ReadonlyArray<OrchestrationImplementationRun>,
  run: OrchestrationImplementationRun,
): OrchestrationImplementationRun[] {
  return [...runs.filter((entry) => entry.id !== run.id), run].toSorted(compareImplementationRuns);
}

function upsertAppReviewWorkflowRun(
  runs: ReadonlyArray<AppReviewWorkflowRun>,
  run: AppReviewWorkflowRun,
): AppReviewWorkflowRun[] {
  return [...runs.filter((entry) => entry.id !== run.id), run].toSorted(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
  );
}

function emptyPlanningWorkflow(): OrchestrationPlanningWorkflow {
  return {
    stage: "grill",
    createTicketsAvailable: false,
    spec: null,
    wayfinderMap: null,
    tickets: [],
    reviewCycles: [],
    activeReview: null,
  };
}

export function createEmptyReadModel(nowIso: string): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    threads: [],
    implementationRuns: [],
    appReviewWorkflowRuns: [],
    updatedAt: nowIso,
  };
}

export function projectEvent(
  model: OrchestrationReadModel,
  event: OrchestrationEvent,
): Effect.Effect<OrchestrationReadModel, OrchestrationProjectorDecodeError> {
  const nextBase: OrchestrationReadModel = {
    ...model,
    snapshotSequence: event.sequence,
    updatedAt: event.occurredAt,
  };

  switch (event.type) {
    case "project.created":
      return decodeForEvent(ProjectCreatedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => {
          const existing = nextBase.projects.find((entry) => entry.id === payload.projectId);
          const nextProject = {
            id: payload.projectId,
            title: payload.title,
            workspaceRoot: payload.workspaceRoot,
            defaultModelSelection: payload.defaultModelSelection,
            defaultThreadEnvMode: null,
            faviconPath: payload.faviconPath ?? null,
            scripts: payload.scripts,
            createdAt: payload.createdAt,
            updatedAt: payload.updatedAt,
            deletedAt: null,
          };

          return {
            ...nextBase,
            projects: existing
              ? nextBase.projects.map((entry) =>
                  entry.id === payload.projectId ? nextProject : entry,
                )
              : [...nextBase.projects, nextProject],
          };
        }),
      );

    case "project.meta-updated":
      return decodeForEvent(ProjectMetaUpdatedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          projects: nextBase.projects.map((project) =>
            project.id === payload.projectId
              ? {
                  ...project,
                  ...(payload.title !== undefined ? { title: payload.title } : {}),
                  ...(payload.workspaceRoot !== undefined
                    ? { workspaceRoot: payload.workspaceRoot }
                    : {}),
                  ...(payload.defaultModelSelection !== undefined
                    ? { defaultModelSelection: payload.defaultModelSelection }
                    : {}),
                  ...(payload.defaultThreadEnvMode !== undefined
                    ? { defaultThreadEnvMode: payload.defaultThreadEnvMode }
                    : {}),
                  ...(payload.faviconPath !== undefined
                    ? { faviconPath: payload.faviconPath }
                    : {}),
                  ...(payload.scripts !== undefined ? { scripts: payload.scripts } : {}),
                  updatedAt: payload.updatedAt,
                }
              : project,
          ),
        })),
      );

    case "project.deleted":
      return decodeForEvent(ProjectDeletedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          projects: nextBase.projects.map((project) =>
            project.id === payload.projectId
              ? {
                  ...project,
                  deletedAt: payload.deletedAt,
                  updatedAt: payload.deletedAt,
                }
              : project,
          ),
        })),
      );

    case "thread.created":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          ThreadCreatedPayload,
          event.payload,
          event.type,
          "payload",
        );
        const thread: OrchestrationThread = yield* decodeForEvent(
          OrchestrationThread,
          {
            id: payload.threadId,
            projectId: payload.projectId,
            ownerUserId: payload.ownerUserId,
            parentThreadId: payload.parentThreadId ?? null,
            workflowRole: payload.workflowRole ?? null,
            workflowContext: payload.workflowContext ?? null,
            ...(payload.workflowSubagentBatchProvenance === undefined
              ? {}
              : { workflowSubagentBatchProvenance: payload.workflowSubagentBatchProvenance }),
            title: payload.title,
            modelSelection: payload.modelSelection,
            runtimeMode: payload.runtimeMode,
            interactionMode: payload.interactionMode,
            workflowPreset: payload.workflowPreset ?? null,
            branch: payload.branch,
            worktreePath: payload.worktreePath,
            latestTurn: null,
            createdAt: payload.createdAt,
            updatedAt: payload.updatedAt,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            snoozedUntil: null,
            snoozedAt: null,
            deletedAt: null,
            messages: [],
            proposedPlans: [],
            planningWorkflow: null,
            appReviews: [],
            workflowSubagentBatches: [],
            activities: [],
            checkpoints: [],
            session: null,
          },
          event.type,
          "thread",
        );
        const existing = nextBase.threads.find((entry) => entry.id === thread.id);
        return {
          ...nextBase,
          threads: existing
            ? nextBase.threads.map((entry) => (entry.id === thread.id ? thread : entry))
            : [...nextBase.threads, thread],
        };
      });

    case "thread.deleted":
      return decodeForEvent(ThreadDeletedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            deletedAt: payload.deletedAt,
            updatedAt: payload.deletedAt,
          }),
        })),
      );

    case "thread.archived":
      return decodeForEvent(ThreadArchivedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            archivedAt: payload.archivedAt,
            titleRegeneration: null,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.unarchived":
      return decodeForEvent(ThreadUnarchivedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            archivedAt: null,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.settled":
      return decodeForEvent(ThreadSettledPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            settledOverride: "settled",
            settledAt: payload.settledAt,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.unsettled":
      return decodeForEvent(ThreadUnsettledPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            settledOverride: payload.reason === "user" ? "active" : null,
            settledAt: null,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.snoozed":
      return decodeForEvent(ThreadSnoozedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            snoozedUntil: payload.snoozedUntil,
            snoozedAt: payload.snoozedAt,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.unsnoozed":
      return decodeForEvent(ThreadUnsnoozedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            snoozedUntil: null,
            snoozedAt: null,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.pinned":
      return decodeForEvent(ThreadPinnedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            pinnedAt: payload.pinnedAt,
            ...(payload.pinOrderKey !== undefined ? { pinOrderKey: payload.pinOrderKey } : {}),
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.unpinned":
      return decodeForEvent(ThreadUnpinnedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            pinnedAt: null,
            // Unpin clears the slot: re-pinning is "pin again", not "restore
            // an ancient position".
            pinOrderKey: null,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.pin-reordered":
      return decodeForEvent(ThreadPinReorderedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            pinOrderKey: payload.orderKey,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.meta-updated":
      return decodeForEvent(ThreadMetaUpdatedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            ...(payload.ownerUserId !== undefined ? { ownerUserId: payload.ownerUserId } : {}),
            ...(payload.title !== undefined ? { title: payload.title } : {}),
            ...(payload.titleRegeneration !== undefined
              ? { titleRegeneration: payload.titleRegeneration }
              : {}),
            ...(payload.modelSelection !== undefined
              ? { modelSelection: payload.modelSelection }
              : {}),
            ...(payload.branch !== undefined ? { branch: payload.branch } : {}),
            ...(payload.worktreePath !== undefined ? { worktreePath: payload.worktreePath } : {}),
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.runtime-mode-set":
      return decodeForEvent(ThreadRuntimeModeSetPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            runtimeMode: payload.runtimeMode,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.interaction-mode-set":
      return decodeForEvent(
        ThreadInteractionModeSetPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            interactionMode: payload.interactionMode,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.composer-mode-set":
      return decodeForEvent(
        ThreadComposerModeSetPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            interactionMode: payload.interactionMode,
            workflowPreset: payload.workflowPreset,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.planning-stage-started":
      return decodeForEvent(
        ThreadPlanningStageStartedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => {
          const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
          if (!thread) return nextBase;
          const workflow = thread.planningWorkflow ?? emptyPlanningWorkflow();
          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              planningWorkflow: {
                ...workflow,
                stage: payload.stage,
                createTicketsAvailable: payload.stage === "tickets-authoring",
              },
              ...(payload.workflowContext !== undefined && thread.workflowContext === null
                ? { workflowContext: payload.workflowContext }
                : {}),
              updatedAt: event.occurredAt,
            }),
          };
        }),
      );

    case "thread.planning-spec-created":
      return decodeForEvent(
        ThreadPlanningSpecCreatedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => {
          const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
          if (!thread) return nextBase;
          const workflow = thread.planningWorkflow ?? emptyPlanningWorkflow();
          const stage = payload.stage ?? "tickets-authoring";
          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              planningWorkflow: {
                ...workflow,
                ...(payload.artifactKind === "wayfinder-map"
                  ? { wayfinderMap: payload.spec }
                  : { spec: payload.spec }),
                stage,
                createTicketsAvailable: stage === "tickets-authoring",
              },
              updatedAt: payload.spec.updatedAt,
            }),
          };
        }),
      );

    case "thread.planning-tickets-created":
      return decodeForEvent(
        ThreadPlanningTicketsCreatedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => {
          const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
          if (!thread) return nextBase;
          const workflow = thread.planningWorkflow ?? emptyPlanningWorkflow();
          const stage = payload.stage ?? "ticket-review";
          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              planningWorkflow: {
                ...workflow,
                ...(payload.spec === undefined ? {} : { spec: payload.spec }),
                stage,
                createTicketsAvailable: false,
                tickets: [
                  ...workflow.tickets.filter((ticket) => ticket.specId !== payload.specId),
                  ...payload.tickets,
                ],
              },
              updatedAt: event.occurredAt,
            }),
          };
        }),
      );

    case "thread.planning-tickets-revised":
      return decodeForEvent(
        ThreadPlanningTicketsRevisedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => {
          const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
          if (!thread) return nextBase;
          const workflow = thread.planningWorkflow ?? emptyPlanningWorkflow();
          const reviewCycles =
            payload.reviewCycle === undefined
              ? workflow.reviewCycles
              : [
                  ...workflow.reviewCycles.filter(
                    (entry) => entry.cycleNumber !== payload.reviewCycle?.cycleNumber,
                  ),
                  payload.reviewCycle,
                ].toSorted((left, right) => left.cycleNumber - right.cycleNumber);
          const stage = payload.stage ?? workflow.stage;
          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              planningWorkflow: {
                ...workflow,
                stage,
                createTicketsAvailable: stage === "tickets-authoring",
                tickets: payload.tickets,
                reviewCycles,
                activeReview: null,
              },
              updatedAt: payload.revisedAt,
            }),
          };
        }),
      );

    case "thread.planning-ticket-review-requested":
      return decodeForEvent(
        ThreadPlanningTicketReviewRequestedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => {
          const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
          if (!thread) return nextBase;
          const workflow = thread.planningWorkflow ?? emptyPlanningWorkflow();
          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              planningWorkflow: {
                ...workflow,
                stage: payload.stage,
                createTicketsAvailable: false,
                activeReview: {
                  cycleNumber: payload.cycleNumber,
                  mode: payload.mode,
                  reviewerThreadId: payload.reviewerThreadId,
                  targetPlanningTicketIds: payload.targetPlanningTicketIds,
                  requestedAt: payload.requestedAt,
                },
              },
              updatedAt: payload.requestedAt,
            }),
          };
        }),
      );

    case "thread.planning-spec-bundle-loaded":
      return decodeForEvent(
        ThreadPlanningSpecBundleLoadedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => {
          const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
          if (!thread || payload.bundle === undefined) return nextBase;
          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              planningWorkflow: {
                stage: "completed",
                createTicketsAvailable: false,
                spec: payload.bundle.spec,
                tickets: payload.bundle.tickets,
                reviewCycles: payload.bundle.reviewCycles,
                activeReview: null,
              },
              updatedAt: payload.loadedAt,
            }),
          };
        }),
      );

    case "thread.planning-workflow-stage-set":
      return decodeForEvent(
        ThreadPlanningWorkflowStageSetPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => {
          const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
          if (!thread) return nextBase;
          const workflow = thread.planningWorkflow ?? emptyPlanningWorkflow();
          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              planningWorkflow: {
                ...workflow,
                stage: payload.stage,
                createTicketsAvailable: payload.stage === "tickets-authoring",
              },
              updatedAt: payload.updatedAt,
            }),
          };
        }),
      );

    case "thread.implementation-run-launched":
      return decodeForEvent(
        ThreadImplementationRunLaunchedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => ({
          ...nextBase,
          implementationRuns: upsertImplementationRun(nextBase.implementationRuns, payload.run),
        })),
      );

    case "thread.implementation-run-updated":
      return decodeForEvent(
        ThreadImplementationRunUpdatedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => ({
          ...nextBase,
          implementationRuns: upsertImplementationRun(nextBase.implementationRuns, payload.run),
        })),
      );

    case "thread.implementation-run-cancel-requested":
      return decodeForEvent(
        ThreadImplementationRunCancelRequestedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => ({
          ...nextBase,
          implementationRuns: upsertImplementationRun(nextBase.implementationRuns, payload.run),
        })),
      );

    case "thread.implementation-change-request-retry-requested":
      return decodeForEvent(
        ThreadImplementationChangeRequestRetryRequestedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => ({
          ...nextBase,
          implementationRuns: upsertImplementationRun(nextBase.implementationRuns, payload.run),
        })),
      );

    case "thread.app-review-workflow-launched":
      return decodeForEvent(
        ThreadAppReviewWorkflowLaunchedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => ({
          ...nextBase,
          appReviewWorkflowRuns: upsertAppReviewWorkflowRun(
            nextBase.appReviewWorkflowRuns ?? [],
            payload.run,
          ),
        })),
      );

    case "thread.app-review-workflow-updated":
      return decodeForEvent(
        ThreadAppReviewWorkflowUpdatedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => ({
          ...nextBase,
          appReviewWorkflowRuns: upsertAppReviewWorkflowRun(
            nextBase.appReviewWorkflowRuns ?? [],
            payload.run,
          ),
        })),
      );

    case "thread.app-review-workflow-cancel-requested":
      return decodeForEvent(
        ThreadAppReviewWorkflowCancelRequestedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => ({
          ...nextBase,
          appReviewWorkflowRuns: upsertAppReviewWorkflowRun(
            nextBase.appReviewWorkflowRuns ?? [],
            payload.run,
          ),
        })),
      );

    case "thread.app-review-workflow-resume-requested":
      return decodeForEvent(
        ThreadAppReviewWorkflowResumeRequestedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => ({
          ...nextBase,
          appReviewWorkflowRuns: upsertAppReviewWorkflowRun(
            nextBase.appReviewWorkflowRuns ?? [],
            payload.run,
          ),
        })),
      );

    case "thread.message-sent":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          MessageSentPayloadSchema,
          event.payload,
          event.type,
          "payload",
        );
        const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
        if (!thread) {
          return nextBase;
        }

        const message: OrchestrationMessage = yield* decodeForEvent(
          OrchestrationMessage,
          {
            id: payload.messageId,
            role: payload.role,
            text: payload.text,
            ...(payload.attachments !== undefined ? { attachments: payload.attachments } : {}),
            turnId: payload.turnId,
            streaming: payload.streaming,
            createdAt: payload.createdAt,
            updatedAt: payload.updatedAt,
          },
          event.type,
          "message",
        );

        const existingMessage = thread.messages.find((entry) => entry.id === message.id);
        const messages = existingMessage
          ? thread.messages.map((entry) =>
              entry.id === message.id
                ? {
                    ...entry,
                    text: message.streaming
                      ? `${entry.text}${message.text}`
                      : message.text.length > 0
                        ? message.text
                        : entry.text,
                    streaming: message.streaming,
                    updatedAt: message.updatedAt,
                    turnId: message.turnId,
                    ...(message.attachments !== undefined
                      ? { attachments: message.attachments }
                      : {}),
                  }
                : entry,
            )
          : [...thread.messages, message];
        const cappedMessages = messages.slice(-MAX_THREAD_MESSAGES);

        return {
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            messages: cappedMessages,
            updatedAt: event.occurredAt,
          }),
        };
      });

    case "thread.session-set":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          ThreadSessionSetPayload,
          event.payload,
          event.type,
          "payload",
        );
        const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
        if (!thread) {
          return nextBase;
        }

        const session: OrchestrationSession = yield* decodeForEvent(
          OrchestrationSession,
          payload.session,
          event.type,
          "session",
        );

        // Leaving the "running" session status is the turn-end signal: settle
        // a still-running latest turn so its duration reflects the whole turn.
        const settledTurnState = settledTurnStateForSessionStatus(session.status);
        return {
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            session,
            latestTurn:
              session.status === "running" && session.activeTurnId !== null
                ? {
                    turnId: session.activeTurnId,
                    state: "running",
                    requestedAt:
                      thread.latestTurn?.turnId === session.activeTurnId
                        ? thread.latestTurn.requestedAt
                        : session.updatedAt,
                    startedAt:
                      thread.latestTurn?.turnId === session.activeTurnId
                        ? (thread.latestTurn.startedAt ?? session.updatedAt)
                        : session.updatedAt,
                    completedAt: null,
                    assistantMessageId:
                      thread.latestTurn?.turnId === session.activeTurnId
                        ? thread.latestTurn.assistantMessageId
                        : null,
                  }
                : thread.latestTurn !== null &&
                    thread.latestTurn.state === "running" &&
                    settledTurnState !== null
                  ? {
                      ...thread.latestTurn,
                      state: settledTurnState,
                      // A running turn's completedAt can only hold a mid-turn
                      // placeholder checkpoint timestamp — the session leaving
                      // "running" is the authoritative turn end.
                      completedAt: session.updatedAt,
                    }
                  : thread.latestTurn,
            updatedAt: event.occurredAt,
          }),
        };
      });

    case "thread.proposed-plan-upserted":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          ThreadProposedPlanUpsertedPayload,
          event.payload,
          event.type,
          "payload",
        );
        const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
        if (!thread) {
          return nextBase;
        }

        const proposedPlans = [
          ...thread.proposedPlans.filter((entry) => entry.id !== payload.proposedPlan.id),
          payload.proposedPlan,
        ]
          .toSorted(
            (left, right) =>
              left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
          )
          .slice(-200);

        return {
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            proposedPlans,
            updatedAt: event.occurredAt,
          }),
        };
      });

    case "thread.app-review-created":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          ThreadAppReviewCreatedPayload,
          event.payload,
          event.type,
          "payload",
        );
        const review = payload.appReview;
        return {
          ...nextBase,
          threads: nextBase.threads.map((thread) =>
            thread.id === review.sourceThreadId || thread.id === review.reviewThreadId
              ? {
                  ...thread,
                  appReviews: upsertAppReview(thread.appReviews, review),
                  updatedAt: event.occurredAt,
                }
              : thread,
          ),
        };
      });

    case "thread.app-review-updated":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          ThreadAppReviewUpdatedPayload,
          event.payload,
          event.type,
          "payload",
        );
        return {
          ...nextBase,
          threads: nextBase.threads.map((thread) => {
            if (thread.id !== payload.sourceThreadId && thread.id !== payload.reviewThreadId) {
              return thread;
            }
            const existing = thread.appReviews.find((entry) => entry.id === payload.reviewId);
            if (!existing) return thread;
            const updated = {
              ...existing,
              ...(payload.status !== undefined ? { status: payload.status } : {}),
              ...(payload.document !== undefined ? { document: payload.document } : {}),
              updatedAt: payload.updatedAt,
            };
            return {
              ...thread,
              appReviews: upsertAppReview(thread.appReviews, updated),
              updatedAt: event.occurredAt,
            };
          }),
        };
      });

    case "thread.app-review-evidence-updated":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          ThreadAppReviewEvidenceUpdatedPayload,
          event.payload,
          event.type,
          "payload",
        );
        return {
          ...nextBase,
          threads: nextBase.threads.map((thread) => {
            if (thread.id !== payload.sourceThreadId && thread.id !== payload.reviewThreadId) {
              return thread;
            }
            const existing = thread.appReviews.find((entry) => entry.id === payload.reviewId);
            if (!existing) return thread;
            const updated = {
              ...existing,
              evidence: payload.evidence,
              updatedAt: payload.updatedAt,
            };
            return {
              ...thread,
              appReviews: upsertAppReview(thread.appReviews, updated),
              updatedAt: event.occurredAt,
            };
          }),
        };
      });

    case "thread.workflow-subagent-batch-created":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          ThreadWorkflowSubagentBatchCreatedPayload,
          event.payload,
          event.type,
          "payload",
        );
        const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
        if (!thread) return nextBase;
        return {
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            workflowSubagentBatches: [
              ...(thread.workflowSubagentBatches ?? []).filter(
                (batch) => batch.id !== payload.batch.id,
              ),
              payload.batch,
            ].toSorted(
              (left, right) =>
                left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
            ),
            updatedAt: event.occurredAt,
          }),
        };
      });

    case "thread.workflow-subagent-batch-child-updated":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          ThreadWorkflowSubagentBatchChildUpdatedPayload,
          event.payload,
          event.type,
          "payload",
        );
        const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
        if (!thread) return nextBase;
        return {
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            workflowSubagentBatches: (thread.workflowSubagentBatches ?? []).map((batch) =>
              batch.id !== payload.batchId
                ? batch
                : {
                    ...batch,
                    status: payload.batchStatus,
                    children: batch.children.map((child) =>
                      child.index === payload.child.index ? payload.child : child,
                    ),
                  },
            ),
            updatedAt: event.occurredAt,
          }),
        };
      });

    case "thread.workflow-subagent-batch-completed":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          ThreadWorkflowSubagentBatchCompletedPayload,
          event.payload,
          event.type,
          "payload",
        );
        const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
        if (!thread) return nextBase;
        return {
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            workflowSubagentBatches: (thread.workflowSubagentBatches ?? []).map((batch) =>
              batch.id === payload.batchId
                ? { ...batch, status: "completed", completedAt: payload.completedAt }
                : batch,
            ),
            updatedAt: event.occurredAt,
          }),
        };
      });

    case "thread.turn-diff-completed":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          ThreadTurnDiffCompletedPayload,
          event.payload,
          event.type,
          "payload",
        );
        const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
        if (!thread) {
          return nextBase;
        }

        const checkpoint = yield* decodeForEvent(
          OrchestrationCheckpointSummary,
          {
            turnId: payload.turnId,
            checkpointTurnCount: payload.checkpointTurnCount,
            checkpointRef: payload.checkpointRef,
            status: payload.status,
            files: payload.files,
            assistantMessageId: payload.assistantMessageId,
            completedAt: payload.completedAt,
          },
          event.type,
          "checkpoint",
        );

        // Do not let a placeholder (status "missing") overwrite a checkpoint
        // that has already been captured with a real git ref (status "ready").
        // ProviderRuntimeIngestion may fire multiple turn.diff.updated events
        // per turn; without this guard later placeholders would clobber the
        // real capture dispatched by CheckpointReactor.
        const existing = thread.checkpoints.find((entry) => entry.turnId === checkpoint.turnId);
        if (existing && existing.status !== "missing" && checkpoint.status === "missing") {
          return nextBase;
        }

        const checkpoints = [
          ...thread.checkpoints.filter((entry) => entry.turnId !== checkpoint.turnId),
          checkpoint,
        ]
          .toSorted((left, right) => left.checkpointTurnCount - right.checkpointTurnCount)
          .slice(-MAX_THREAD_CHECKPOINTS);

        // Mid-turn diff updates produce placeholder checkpoints; record the
        // checkpoint, but don't settle a turn its session is still running.
        const turnStillRunning =
          thread.session?.status === "running" && thread.session.activeTurnId === payload.turnId;

        return {
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            checkpoints,
            latestTurn: turnStillRunning
              ? thread.latestTurn
              : {
                  turnId: payload.turnId,
                  state: checkpointStatusToLatestTurnState(payload.status),
                  requestedAt:
                    thread.latestTurn?.turnId === payload.turnId
                      ? thread.latestTurn.requestedAt
                      : payload.completedAt,
                  startedAt:
                    thread.latestTurn?.turnId === payload.turnId
                      ? (thread.latestTurn.startedAt ?? payload.completedAt)
                      : payload.completedAt,
                  completedAt: payload.completedAt,
                  assistantMessageId: payload.assistantMessageId,
                },
            updatedAt: event.occurredAt,
          }),
        };
      });

    case "thread.reverted":
      return decodeForEvent(ThreadRevertedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => {
          const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
          if (!thread) {
            return nextBase;
          }

          const checkpoints = thread.checkpoints
            .filter((entry) => entry.checkpointTurnCount <= payload.turnCount)
            .toSorted((left, right) => left.checkpointTurnCount - right.checkpointTurnCount)
            .slice(-MAX_THREAD_CHECKPOINTS);
          const retainedTurnIds = new Set(checkpoints.map((checkpoint) => checkpoint.turnId));
          const messages = retainThreadMessagesAfterRevert(
            thread.messages,
            retainedTurnIds,
            payload.turnCount,
          ).slice(-MAX_THREAD_MESSAGES);
          const proposedPlans = retainThreadProposedPlansAfterRevert(
            thread.proposedPlans,
            retainedTurnIds,
          ).slice(-200);
          const activities = retainThreadActivitiesAfterRevert(thread.activities, retainedTurnIds);

          const latestCheckpoint = checkpoints.at(-1) ?? null;
          const latestTurn =
            latestCheckpoint === null
              ? null
              : {
                  turnId: latestCheckpoint.turnId,
                  state: checkpointStatusToLatestTurnState(latestCheckpoint.status),
                  requestedAt: latestCheckpoint.completedAt,
                  startedAt: latestCheckpoint.completedAt,
                  completedAt: latestCheckpoint.completedAt,
                  assistantMessageId: latestCheckpoint.assistantMessageId,
                };

          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              checkpoints,
              messages,
              proposedPlans,
              activities,
              latestTurn,
              updatedAt: event.occurredAt,
            }),
          };
        }),
      );

    case "thread.activity-appended":
      return decodeForEvent(
        ThreadActivityAppendedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => {
          const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
          if (!thread) {
            return nextBase;
          }

          const activities = [
            ...thread.activities.filter((entry) => entry.id !== payload.activity.id),
            payload.activity,
          ]
            .toSorted(compareThreadActivities)
            .slice(-500);

          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              activities,
              updatedAt: event.occurredAt,
            }),
          };
        }),
      );

    default:
      return Effect.succeed(nextBase);
  }
}
