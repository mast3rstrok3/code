import { useAtomValue } from "@effect/atom-react";
import { createWorkflowEnvironmentAtoms } from "@t3tools/client-runtime/state/workflows";
import {
  DEFAULT_SERVER_SETTINGS,
  type EnvironmentId,
  type ScopedThreadRef,
  type ServerSettings,
  type WorkflowArtifactsGetInput,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentQuery } from "./query";
import { serverEnvironment } from "./server";

export const workflowEnvironment = createWorkflowEnvironmentAtoms(connectionAtomRuntime);

// Each hook subscribes only while its caller is mounted: the snapshot carries
// every workflow thread in the environment, so it must not stay open behind a
// closed sheet.
export function useWorkflowSnapshot(environmentId: EnvironmentId | null) {
  return useEnvironmentQuery(
    environmentId === null ? null : workflowEnvironment.snapshot({ environmentId, input: {} }),
  );
}

export function useWorkflowThread(ref: ScopedThreadRef | null) {
  return useEnvironmentQuery(
    ref === null
      ? null
      : workflowEnvironment.thread({
          environmentId: ref.environmentId,
          input: { threadId: ref.threadId },
        }),
  );
}

export function useThreadPlanningWorkflow(ref: ScopedThreadRef | null) {
  return useWorkflowThread(ref).data?.planningWorkflow ?? null;
}

export function useThreadAppReviews(ref: ScopedThreadRef | null) {
  return useWorkflowThread(ref).data?.appReviews ?? [];
}

export function useAppReviewWorkflowRuns(environmentId: EnvironmentId | null) {
  return useWorkflowSnapshot(environmentId).data?.appReviewWorkflowRuns ?? [];
}

export function useWorkflowArtifacts(
  environmentId: EnvironmentId,
  input: WorkflowArtifactsGetInput | null,
) {
  return useEnvironmentQuery(
    input === null ? null : workflowEnvironment.artifacts({ environmentId, input }),
  );
}

export function useWorkflowCatalog(environmentId: EnvironmentId | null) {
  return useEnvironmentQuery(
    environmentId === null ? null : serverEnvironment.workflowCatalog({ environmentId, input: {} }),
  );
}

export function useCanDispatchWorkflowCommand(environmentId: EnvironmentId): boolean {
  return useAtomValue(workflowEnvironment.dispatchCommand.permissionAtom(environmentId));
}

export type WorkflowSettings = Pick<
  ServerSettings,
  "workflowStepModels" | "workflowStepCycles" | "workflowStepReviewParts" | "implementation"
>;

const DEFAULT_WORKFLOW_SETTINGS: WorkflowSettings = {
  workflowStepModels: DEFAULT_SERVER_SETTINGS.workflowStepModels,
  workflowStepCycles: DEFAULT_SERVER_SETTINGS.workflowStepCycles,
  workflowStepReviewParts: DEFAULT_SERVER_SETTINGS.workflowStepReviewParts,
  implementation: DEFAULT_SERVER_SETTINGS.implementation,
};

// Selected as one equality-checked slice so unrelated settings writes do not
// re-render workflow surfaces.
const workflowSettingsAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): WorkflowSettings => {
    const settings = get(serverEnvironment.configValueAtom(environmentId))?.settings;
    return settings === undefined
      ? DEFAULT_WORKFLOW_SETTINGS
      : {
          workflowStepModels: settings.workflowStepModels,
          workflowStepCycles: settings.workflowStepCycles,
          workflowStepReviewParts: settings.workflowStepReviewParts,
          implementation: settings.implementation,
        };
  }).pipe(
    Atom.withEquality(
      (left: WorkflowSettings, right: WorkflowSettings) =>
        left.workflowStepModels === right.workflowStepModels &&
        left.workflowStepCycles === right.workflowStepCycles &&
        left.workflowStepReviewParts === right.workflowStepReviewParts &&
        left.implementation === right.implementation,
    ),
    Atom.withLabel(`mobile-workflow-settings:${environmentId}`),
  ),
);

export function useWorkflowSettings(environmentId: EnvironmentId): WorkflowSettings {
  return useAtomValue(workflowSettingsAtom(environmentId));
}

export function workflowSettingsValueAtom(environmentId: EnvironmentId) {
  return workflowSettingsAtom(environmentId);
}
