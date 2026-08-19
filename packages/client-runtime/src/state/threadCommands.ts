import * as Crypto from "effect/Crypto";
import { Atom } from "effect/unstable/reactivity";

import { createAtomCommandScheduler, createEnvironmentCommand } from "./runtime.ts";
import {
  type ArchiveThreadInput,
  type CancelThreadImplementationRunInput,
  type CreateThreadInput,
  type DeleteThreadInput,
  type InterruptThreadTurnInput,
  type LaunchThreadImplementationRunInput,
  type LaunchThreadFastFeatureRunInput,
  type LaunchThreadAppReviewInput,
  type LaunchThreadAppReviewWorkflowInput,
  type CancelThreadAppReviewWorkflowInput,
  type LoadThreadPlanningSpecBundleInput,
  type CreateThreadPlanningSpecInput,
  type RequestThreadPlanningTicketReviewInput,
  type RespondToThreadApprovalInput,
  type RespondToThreadUserInputInput,
  type RevertThreadCheckpointInput,
  type RetryThreadImplementationChangeRequestInput,
  type RerunThreadAppReviewPhaseInput,
  type RerunThreadImplementationStageInput,
  type ResetThreadImplementationStageInput,
  type SetThreadImplementationSkipInput,
  type RetryThreadImplementationRunInput,
  type SetThreadInteractionModeInput,
  type SetThreadComposerModeInput,
  type SetThreadRuntimeModeInput,
  type StartThreadPlanningStageInput,
  type PinThreadInput,
  type PauseThreadWorkflowInput,
  type ResumeThreadWorkflowInput,
  type SetThreadWorkflowStepModelInput,
  type ReorderPinnedThreadInput,
  type SettleThreadInput,
  type SnoozeThreadInput,
  type StartThreadTurnInput,
  type StopThreadSessionInput,
  type UnarchiveThreadInput,
  type UnpinThreadInput,
  type UnsettleThreadInput,
  type UnsnoozeThreadInput,
  type UpdateThreadMetadataInput,
  archiveThread,
  cancelThreadImplementationRun,
  createThreadPlanningSpec,
  createThread,
  deleteThread,
  interruptThreadTurn,
  launchThreadImplementationRun,
  launchThreadFastFeatureRun,
  launchThreadAppReview,
  launchThreadAppReviewWorkflow,
  cancelThreadAppReviewWorkflow,
  loadThreadPlanningSpecBundle,
  requestThreadPlanningTicketReview,
  respondToThreadApproval,
  respondToThreadUserInput,
  revertThreadCheckpoint,
  retryThreadImplementationChangeRequest,
  rerunThreadAppReviewPhase,
  rerunThreadImplementationStage,
  resetThreadImplementationStage,
  setThreadImplementationSkip,
  retryThreadImplementationRun,
  setThreadInteractionMode,
  setThreadComposerMode,
  setThreadRuntimeMode,
  startThreadPlanningStage,
  pinThread,
  pauseThreadWorkflow,
  resumeThreadWorkflow,
  setThreadWorkflowStepModel,
  reorderPinnedThread,
  settleThread,
  snoozeThread,
  startThreadTurn,
  stopThreadSession,
  unarchiveThread,
  unpinThread,
  unsettleThread,
  unsnoozeThread,
  updateThreadMetadata,
} from "../operations/commands.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

export type {
  ArchiveThreadInput,
  CancelThreadImplementationRunInput,
  CreateThreadInput,
  DeleteThreadInput,
  InterruptThreadTurnInput,
  LaunchThreadImplementationRunInput,
  LaunchThreadFastFeatureRunInput,
  LaunchThreadAppReviewInput,
  LaunchThreadAppReviewWorkflowInput,
  CancelThreadAppReviewWorkflowInput,
  LoadThreadPlanningSpecBundleInput,
  CreateThreadPlanningSpecInput,
  RequestThreadPlanningTicketReviewInput,
  RespondToThreadApprovalInput,
  RespondToThreadUserInputInput,
  RevertThreadCheckpointInput,
  RerunThreadAppReviewPhaseInput,
  RerunThreadImplementationStageInput,
  ResetThreadImplementationStageInput,
  RetryThreadImplementationChangeRequestInput,
  SetThreadImplementationSkipInput,
  RetryThreadImplementationRunInput,
  SetThreadInteractionModeInput,
  SetThreadComposerModeInput,
  SetThreadRuntimeModeInput,
  StartThreadPlanningStageInput,
  PinThreadInput,
  PauseThreadWorkflowInput,
  ResumeThreadWorkflowInput,
  SetThreadWorkflowStepModelInput,
  ReorderPinnedThreadInput,
  SettleThreadInput,
  SnoozeThreadInput,
  StartThreadTurnInput,
  StopThreadSessionInput,
  UnarchiveThreadInput,
  UnpinThreadInput,
  UnsettleThreadInput,
  UnsnoozeThreadInput,
  UpdateThreadMetadataInput,
} from "../operations/commands.ts";

export function createThreadEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | Crypto.Crypto | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  const concurrency = {
    mode: "serial" as const,
    key: ({ environmentId, input }: { environmentId: string; input: { threadId: string } }) =>
      JSON.stringify([environmentId, input.threadId]),
  };
  return {
    create: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:create",
      execute: (input: CreateThreadInput) => createThread(input),
      scheduler,
      concurrency,
    }),
    delete: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:delete",
      execute: (input: DeleteThreadInput) => deleteThread(input),
      scheduler,
      concurrency,
    }),
    archive: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:archive",
      execute: (input: ArchiveThreadInput) => archiveThread(input),
      scheduler,
      concurrency,
    }),
    unarchive: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:unarchive",
      execute: (input: UnarchiveThreadInput) => unarchiveThread(input),
      scheduler,
      concurrency,
    }),
    settle: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:settle",
      execute: (input: SettleThreadInput) => settleThread(input),
      scheduler,
      concurrency,
    }),
    pauseWorkflow: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:workflow:pause",
      execute: (input: PauseThreadWorkflowInput) => pauseThreadWorkflow(input),
      scheduler,
      concurrency,
    }),
    resumeWorkflow: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:workflow:resume",
      execute: (input: ResumeThreadWorkflowInput) => resumeThreadWorkflow(input),
      scheduler,
      concurrency,
    }),
    setWorkflowStepModel: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:workflow:step-model:set",
      execute: (input: SetThreadWorkflowStepModelInput) => setThreadWorkflowStepModel(input),
      scheduler,
      concurrency,
    }),
    unsettle: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:unsettle",
      execute: (input: UnsettleThreadInput) => unsettleThread(input),
      scheduler,
      concurrency,
    }),
    snooze: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:snooze",
      execute: (input: SnoozeThreadInput) => snoozeThread(input),
      scheduler,
      concurrency,
    }),
    unsnooze: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:unsnooze",
      execute: (input: UnsnoozeThreadInput) => unsnoozeThread(input),
      scheduler,
      concurrency,
    }),
    pin: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:pin",
      execute: (input: PinThreadInput) => pinThread(input),
      scheduler,
      concurrency,
    }),
    unpin: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:unpin",
      execute: (input: UnpinThreadInput) => unpinThread(input),
      scheduler,
      concurrency,
    }),
    reorderPin: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:reorder-pin",
      execute: (input: ReorderPinnedThreadInput) => reorderPinnedThread(input),
      scheduler,
      concurrency,
    }),
    updateMetadata: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:update-metadata",
      execute: (input: UpdateThreadMetadataInput) => updateThreadMetadata(input),
      scheduler,
      concurrency,
    }),
    setRuntimeMode: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:set-runtime-mode",
      execute: (input: SetThreadRuntimeModeInput) => setThreadRuntimeMode(input),
      scheduler,
      concurrency,
    }),
    setInteractionMode: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:set-interaction-mode",
      execute: (input: SetThreadInteractionModeInput) => setThreadInteractionMode(input),
      scheduler,
      concurrency,
    }),
    setComposerMode: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:set-composer-mode",
      execute: (input: SetThreadComposerModeInput) => setThreadComposerMode(input),
      scheduler,
      concurrency,
    }),
    startTurn: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:start-turn",
      execute: (input: StartThreadTurnInput) => startThreadTurn(input),
      scheduler,
      concurrency,
    }),
    launchAppReview: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:launch-app-review",
      execute: (input: LaunchThreadAppReviewInput) => launchThreadAppReview(input),
      scheduler,
      concurrency: {
        mode: "serial" as const,
        key: ({
          environmentId,
          input,
        }: {
          environmentId: string;
          input: LaunchThreadAppReviewInput;
        }) => JSON.stringify([environmentId, input.sourceThreadId, input.reviewThreadId]),
      },
    }),
    launchAppReviewWorkflow: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:launch-app-review-workflow",
      execute: (input: LaunchThreadAppReviewWorkflowInput) => launchThreadAppReviewWorkflow(input),
      scheduler,
      concurrency: {
        mode: "serial" as const,
        key: ({
          environmentId,
          input,
        }: {
          environmentId: string;
          input: LaunchThreadAppReviewWorkflowInput;
        }) => JSON.stringify([environmentId, input.targetThreadId]),
      },
    }),
    cancelAppReviewWorkflow: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:cancel-app-review-workflow",
      execute: (input: CancelThreadAppReviewWorkflowInput) => cancelThreadAppReviewWorkflow(input),
      scheduler,
      concurrency: {
        mode: "serial" as const,
        key: ({
          environmentId,
          input,
        }: {
          environmentId: string;
          input: CancelThreadAppReviewWorkflowInput;
        }) => JSON.stringify([environmentId, input.runId]),
      },
    }),
    createPlanningSpec: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:planning-spec:create",
      execute: (input: CreateThreadPlanningSpecInput) => createThreadPlanningSpec(input),
      scheduler,
      concurrency,
    }),
    startPlanningStage: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:planning-stage:start",
      execute: (input: StartThreadPlanningStageInput) => startThreadPlanningStage(input),
      scheduler,
      concurrency,
    }),
    loadPlanningSpecBundle: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:planning-spec-bundle:load",
      execute: (input: LoadThreadPlanningSpecBundleInput) => loadThreadPlanningSpecBundle(input),
      scheduler,
      concurrency,
    }),
    requestPlanningTicketReview: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:planning-ticket-review:request",
      execute: (input: RequestThreadPlanningTicketReviewInput) =>
        requestThreadPlanningTicketReview(input),
      scheduler,
      concurrency: {
        mode: "serial" as const,
        key: ({
          environmentId,
          input,
        }: {
          environmentId: string;
          input: RequestThreadPlanningTicketReviewInput;
        }) => JSON.stringify([environmentId, input.threadId, input.specId]),
      },
    }),
    launchImplementationRun: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:implementation-run:launch",
      execute: (input: LaunchThreadImplementationRunInput) => launchThreadImplementationRun(input),
      scheduler,
      concurrency: {
        mode: "serial" as const,
        key: ({
          environmentId,
          input,
        }: {
          environmentId: string;
          input: LaunchThreadImplementationRunInput;
        }) => JSON.stringify([environmentId, input.threadId, input.specId]),
      },
    }),
    launchFastFeatureRun: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:fast-feature-run:launch",
      execute: (input: LaunchThreadFastFeatureRunInput) => launchThreadFastFeatureRun(input),
      scheduler,
      concurrency: {
        mode: "serial" as const,
        key: ({
          environmentId,
          input,
        }: {
          environmentId: string;
          input: LaunchThreadFastFeatureRunInput;
        }) => JSON.stringify([environmentId, input.threadId, input.proposedPlanId]),
      },
    }),
    retryImplementationChangeRequest: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:implementation-change-request:retry",
      execute: (input: RetryThreadImplementationChangeRequestInput) =>
        retryThreadImplementationChangeRequest(input),
      scheduler,
      concurrency: {
        mode: "serial" as const,
        key: ({
          environmentId,
          input,
        }: {
          environmentId: string;
          input: RetryThreadImplementationChangeRequestInput;
        }) => JSON.stringify([environmentId, input.threadId, input.runId]),
      },
    }),
    retryImplementationRun: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:implementation-run:retry",
      execute: (input: RetryThreadImplementationRunInput) => retryThreadImplementationRun(input),
      scheduler,
      concurrency: {
        mode: "serial" as const,
        key: ({
          environmentId,
          input,
        }: {
          environmentId: string;
          input: RetryThreadImplementationRunInput;
        }) => JSON.stringify([environmentId, input.threadId, input.runId]),
      },
    }),
    rerunImplementationStage: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:implementation-run:rerun",
      execute: (input: RerunThreadImplementationStageInput) =>
        rerunThreadImplementationStage(input),
      scheduler,
      concurrency: {
        mode: "serial" as const,
        key: ({
          environmentId,
          input,
        }: {
          environmentId: string;
          input: RerunThreadImplementationStageInput;
        }) =>
          JSON.stringify([
            environmentId,
            input.threadId,
            input.runId,
            input.target.kind === "ticket"
              ? [input.target.ticketId, input.target.stage]
              : input.target.stage,
          ]),
      },
    }),
    resetImplementationStage: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:implementation-run:reset",
      execute: (input: ResetThreadImplementationStageInput) =>
        resetThreadImplementationStage(input),
      scheduler,
      concurrency: {
        mode: "serial" as const,
        key: ({
          environmentId,
          input,
        }: {
          environmentId: string;
          input: ResetThreadImplementationStageInput;
        }) =>
          JSON.stringify([
            environmentId,
            input.threadId,
            input.runId,
            input.target.kind === "ticket"
              ? [input.target.ticketId, input.target.stage]
              : input.target.stage,
          ]),
      },
    }),
    setImplementationSkip: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:implementation-run:skip",
      execute: (input: SetThreadImplementationSkipInput) => setThreadImplementationSkip(input),
      scheduler,
      concurrency: {
        mode: "serial" as const,
        key: ({
          environmentId,
          input,
        }: {
          environmentId: string;
          input: SetThreadImplementationSkipInput;
        }) =>
          JSON.stringify([
            environmentId,
            input.threadId,
            input.runId,
            input.target.kind === "ticket"
              ? [input.target.ticketId, input.target.stage ?? "all"]
              : input.target.stage,
          ]),
      },
    }),
    rerunAppReviewPhase: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:app-review-workflow:rerun",
      execute: (input: RerunThreadAppReviewPhaseInput) => rerunThreadAppReviewPhase(input),
      scheduler,
      concurrency: {
        mode: "serial" as const,
        key: ({
          environmentId,
          input,
        }: {
          environmentId: string;
          input: RerunThreadAppReviewPhaseInput;
        }) => JSON.stringify([environmentId, input.threadId, input.runId, input.phase]),
      },
    }),
    cancelImplementationRun: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:implementation-run:cancel",
      execute: (input: CancelThreadImplementationRunInput) => cancelThreadImplementationRun(input),
      scheduler,
      concurrency: {
        mode: "serial" as const,
        key: ({
          environmentId,
          input,
        }: {
          environmentId: string;
          input: CancelThreadImplementationRunInput;
        }) => JSON.stringify([environmentId, input.threadId, input.runId]),
      },
    }),
    interruptTurn: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:interrupt-turn",
      execute: (input: InterruptThreadTurnInput) => interruptThreadTurn(input),
      scheduler,
      concurrency,
    }),
    respondToApproval: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:respond-to-approval",
      execute: (input: RespondToThreadApprovalInput) => respondToThreadApproval(input),
      scheduler,
      concurrency,
    }),
    respondToUserInput: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:respond-to-user-input",
      execute: (input: RespondToThreadUserInputInput) => respondToThreadUserInput(input),
      scheduler,
      concurrency,
    }),
    revertCheckpoint: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:revert-checkpoint",
      execute: (input: RevertThreadCheckpointInput) => revertThreadCheckpoint(input),
      scheduler,
      concurrency,
    }),
    stopSession: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:stop-session",
      execute: (input: StopThreadSessionInput) => stopThreadSession(input),
      scheduler,
      concurrency,
    }),
  };
}
