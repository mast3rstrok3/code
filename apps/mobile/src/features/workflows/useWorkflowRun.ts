import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import {
  buildWorkflowViewModel,
  selectWorkflowRootForThread,
} from "@t3tools/client-runtime/workflow-model";
import {
  CommandId,
  type ClientOrchestrationCommand,
  type EnvironmentId,
  type ImplementationWorkflowSettings,
  type ProviderInteractionMode,
  type ThreadId,
  type WorkflowPreset,
} from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { uuidv4 } from "../../lib/uuid";
import { pendingWorkflowQuestions } from "./workflowQuestions";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  useCanDispatchWorkflowCommand,
  useWorkflowArtifacts,
  useWorkflowSettings,
  useWorkflowSnapshot,
  useWorkflowThread,
  workflowEnvironment,
} from "../../state/workflows";

/**
 * Everything a workflow surface reads for the workflow around one thread: the
 * root and its members, the runs, the planning artifacts, and open questions.
 * It subscribes while the caller is mounted and no longer.
 */
export function useWorkflowRun(environmentId: EnvironmentId, threadId: ThreadId) {
  const snapshot = useWorkflowSnapshot(environmentId);
  const settings = useWorkflowSettings(environmentId);
  const threads = (snapshot.data?.threads ?? []).map((thread) => ({ ...thread, environmentId }));
  const model = buildWorkflowViewModel(threads);
  const workflow = selectWorkflowRootForThread(model, { environmentId, id: threadId });
  const rootId = workflow?.root.id ?? threadId;
  const rootDetail = useWorkflowThread({ environmentId, threadId: rootId });
  const artifacts = useWorkflowArtifacts(
    environmentId,
    rootDetail.data === null ? null : { projectId: rootDetail.data.projectId, threadId: rootId },
  );
  // Artifacts are a query; the snapshot is the live signal that they moved.
  const refreshArtifacts = artifacts.refresh;
  const snapshotData = snapshot.data;
  useEffect(() => {
    if (snapshotData !== null) refreshArtifacts();
  }, [snapshotData, refreshArtifacts]);
  const planning = rootDetail.data?.planningWorkflow ?? null;
  return {
    workflow,
    rootId,
    rootDetail: rootDetail.data,
    settings,
    implementationRuns:
      artifacts.data?.implementationRuns ?? snapshot.data?.implementationRuns ?? [],
    appReviewWorkflowRuns:
      artifacts.data?.appReviewWorkflowRuns ?? snapshot.data?.appReviewWorkflowRuns ?? [],
    tickets: artifacts.data?.tickets ?? planning?.tickets ?? [],
    spec: artifacts.data?.spec ?? planning?.spec ?? null,
    pendingQuestions: pendingWorkflowQuestions(rootDetail.data?.activities ?? []),
    loading: snapshot.data === null && snapshot.error === null,
    error: snapshot.error,
    refresh: () => {
      snapshot.refresh();
      rootDetail.refresh();
    },
  };
}

export type WorkflowRun = ReturnType<typeof useWorkflowRun>;

/** Sends workflow commands for one root thread, gated on the dispatch permission. */
export function useWorkflowCommands(environmentId: EnvironmentId, rootId: ThreadId) {
  const dispatch = useAtomCommand(workflowEnvironment.dispatchCommand);
  const canDispatch = useCanDispatchWorkflowCommand(environmentId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const base = () => ({
    commandId: CommandId.make(uuidv4()),
    threadId: rootId,
    createdAt: new Date().toISOString(),
  });
  const send = async (command: ClientOrchestrationCommand): Promise<boolean> => {
    if (!canDispatch) return false;
    setBusy(true);
    setError(null);
    try {
      const result = await dispatch({ environmentId, input: { command } });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        setError("The workflow command failed. Check the notification for details.");
      }
      return result._tag === "Success";
    } finally {
      setBusy(false);
    }
  };
  return { canDispatch, busy, error, send, base };
}

export type WorkflowCommands = ReturnType<typeof useWorkflowCommands>;

/** The run-level settings change the web sends through the root's composer mode. */
export function runSettingsCommand(input: {
  readonly base: ReturnType<WorkflowCommands["base"]>;
  readonly root: {
    readonly interactionMode: ProviderInteractionMode;
    readonly workflowPreset?: WorkflowPreset | null | undefined;
    readonly workflowImplementationSettings?: ImplementationWorkflowSettings | undefined;
  };
  readonly standing: ImplementationWorkflowSettings;
  readonly change: Partial<ImplementationWorkflowSettings>;
}): ClientOrchestrationCommand {
  return {
    type: "thread.composer-mode.set",
    ...input.base,
    interactionMode: input.root.interactionMode,
    workflowPreset: input.root.workflowPreset ?? null,
    workflowImplementationSettings: {
      ...(input.root.workflowImplementationSettings ?? input.standing),
      ...input.change,
    },
  };
}
