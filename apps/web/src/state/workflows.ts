import { createWorkflowEnvironmentAtoms } from "@t3tools/client-runtime/state/workflows";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentQuery } from "./query";
export const workflowEnvironment = createWorkflowEnvironmentAtoms(connectionAtomRuntime);
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
