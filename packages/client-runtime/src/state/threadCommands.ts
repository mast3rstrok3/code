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
  type LaunchThreadDevReviewInput,
  type LoadThreadPlanningSpecBundleInput,
  type CreateThreadPlanningSpecInput,
  type RequestThreadPlanningTicketReviewInput,
  type RespondToThreadApprovalInput,
  type RespondToThreadUserInputInput,
  type RevertThreadCheckpointInput,
  type RetryThreadImplementationChangeRequestInput,
  type RetryThreadImplementationRunInput,
  type SetThreadInteractionModeInput,
  type SetThreadComposerModeInput,
  type SetThreadRuntimeModeInput,
  type StartThreadPlanningStageInput,
  type SettleThreadInput,
  type SnoozeThreadInput,
  type StartThreadTurnInput,
  type StopThreadSessionInput,
  type UnarchiveThreadInput,
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
  launchThreadDevReview,
  loadThreadPlanningSpecBundle,
  requestThreadPlanningTicketReview,
  respondToThreadApproval,
  respondToThreadUserInput,
  revertThreadCheckpoint,
  retryThreadImplementationChangeRequest,
  retryThreadImplementationRun,
  setThreadInteractionMode,
  setThreadComposerMode,
  setThreadRuntimeMode,
  startThreadPlanningStage,
  settleThread,
  snoozeThread,
  startThreadTurn,
  stopThreadSession,
  unarchiveThread,
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
  LaunchThreadDevReviewInput,
  LoadThreadPlanningSpecBundleInput,
  CreateThreadPlanningSpecInput,
  RequestThreadPlanningTicketReviewInput,
  RespondToThreadApprovalInput,
  RespondToThreadUserInputInput,
  RevertThreadCheckpointInput,
  RetryThreadImplementationChangeRequestInput,
  RetryThreadImplementationRunInput,
  SetThreadInteractionModeInput,
  SetThreadComposerModeInput,
  SetThreadRuntimeModeInput,
  StartThreadPlanningStageInput,
  SettleThreadInput,
  SnoozeThreadInput,
  StartThreadTurnInput,
  StopThreadSessionInput,
  UnarchiveThreadInput,
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
    launchDevReview: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:launch-dev-review",
      execute: (input: LaunchThreadDevReviewInput) => launchThreadDevReview(input),
      scheduler,
      concurrency: {
        mode: "serial" as const,
        key: ({
          environmentId,
          input,
        }: {
          environmentId: string;
          input: LaunchThreadDevReviewInput;
        }) => JSON.stringify([environmentId, input.sourceThreadId, input.reviewThreadId]),
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
