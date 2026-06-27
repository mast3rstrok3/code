import * as Crypto from "effect/Crypto";
import { Atom } from "effect/unstable/reactivity";

import { createAtomCommandScheduler, createEnvironmentCommand } from "./runtime.ts";
import {
  type ArchiveThreadInput,
  type CreateThreadInput,
  type DeleteThreadInput,
  type InterruptThreadTurnInput,
  type LaunchThreadImplementationRunInput,
  type LaunchThreadDevReviewInput,
  type LoadThreadPlanningPrdBundleInput,
  type CreateThreadPlanningPrdInput,
  type RequestThreadPlanningIssueReviewInput,
  type RespondToThreadApprovalInput,
  type RespondToThreadUserInputInput,
  type RevertThreadCheckpointInput,
  type RetryThreadImplementationChangeRequestInput,
  type SetThreadInteractionModeInput,
  type SetThreadRuntimeModeInput,
  type StartThreadPlanningStageInput,
  type StartThreadTurnInput,
  type StopThreadSessionInput,
  type UnarchiveThreadInput,
  type UpdateThreadMetadataInput,
  archiveThread,
  createThreadPlanningPrd,
  createThread,
  deleteThread,
  interruptThreadTurn,
  launchThreadImplementationRun,
  launchThreadDevReview,
  loadThreadPlanningPrdBundle,
  requestThreadPlanningIssueReview,
  respondToThreadApproval,
  respondToThreadUserInput,
  revertThreadCheckpoint,
  retryThreadImplementationChangeRequest,
  setThreadInteractionMode,
  setThreadRuntimeMode,
  startThreadPlanningStage,
  startThreadTurn,
  stopThreadSession,
  unarchiveThread,
  updateThreadMetadata,
} from "../operations/commands.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

export type {
  ArchiveThreadInput,
  CreateThreadInput,
  DeleteThreadInput,
  InterruptThreadTurnInput,
  LaunchThreadImplementationRunInput,
  LaunchThreadDevReviewInput,
  LoadThreadPlanningPrdBundleInput,
  CreateThreadPlanningPrdInput,
  RequestThreadPlanningIssueReviewInput,
  RespondToThreadApprovalInput,
  RespondToThreadUserInputInput,
  RevertThreadCheckpointInput,
  RetryThreadImplementationChangeRequestInput,
  SetThreadInteractionModeInput,
  SetThreadRuntimeModeInput,
  StartThreadPlanningStageInput,
  StartThreadTurnInput,
  StopThreadSessionInput,
  UnarchiveThreadInput,
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
    createPlanningPrd: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:planning-prd:create",
      execute: (input: CreateThreadPlanningPrdInput) => createThreadPlanningPrd(input),
      scheduler,
      concurrency,
    }),
    startPlanningStage: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:planning-stage:start",
      execute: (input: StartThreadPlanningStageInput) => startThreadPlanningStage(input),
      scheduler,
      concurrency,
    }),
    loadPlanningPrdBundle: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:planning-prd-bundle:load",
      execute: (input: LoadThreadPlanningPrdBundleInput) => loadThreadPlanningPrdBundle(input),
      scheduler,
      concurrency,
    }),
    requestPlanningIssueReview: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:planning-issue-review:request",
      execute: (input: RequestThreadPlanningIssueReviewInput) =>
        requestThreadPlanningIssueReview(input),
      scheduler,
      concurrency: {
        mode: "serial" as const,
        key: ({
          environmentId,
          input,
        }: {
          environmentId: string;
          input: RequestThreadPlanningIssueReviewInput;
        }) => JSON.stringify([environmentId, input.threadId, input.prdId]),
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
        }) => JSON.stringify([environmentId, input.threadId, input.prdId]),
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
