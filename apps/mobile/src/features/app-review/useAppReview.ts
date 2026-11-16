import {
  selectAppReviewRunsForPanel,
  selectHeadlineAppReviewRun,
  selectLatestAppReviewControllerRun,
} from "@t3tools/client-runtime/app-review";
import type { AppReviewWorkflowRun, EnvironmentId, ThreadId } from "@t3tools/contracts";

import { useAppReviewWorkflowRuns, useWorkflowThread } from "../../state/workflows";
import { useWorkflowCommands, useWorkflowRun } from "../workflows/useWorkflowRun";

/**
 * The App Reviews around one thread, read the way the web panel reads them:
 * a workflow member sees every review in its workflow's artifacts, any other
 * thread sees the runs that touch it and its own records. Everything
 * subscribes while the caller is mounted and no longer.
 */
export function useAppReview(environmentId: EnvironmentId, threadId: ThreadId) {
  const workflowRun = useWorkflowRun(environmentId, threadId);
  const commands = useWorkflowCommands(environmentId, workflowRun.rootId);
  const thread = useWorkflowThread({ environmentId, threadId });
  const artifacts = workflowRun.artifacts;
  const records = artifacts?.appReviews ?? thread.data?.appReviews ?? [];
  const allRuns = workflowRun.appReviewWorkflowRuns;
  const tickets = artifacts?.tickets ?? thread.data?.planningWorkflow?.tickets ?? [];
  const runs = selectAppReviewRunsForPanel({
    runs: allRuns,
    openedThreadId: threadId,
    workflowScoped: artifacts !== null,
    tickets,
  });
  const sessionStatusById = new Map(
    workflowRun.threads.flatMap((candidate) =>
      candidate.session === null ? [] : [[candidate.id, candidate.session.status] as const],
    ),
  );
  return {
    runs,
    allRuns,
    records,
    tickets,
    headlineRun: selectHeadlineAppReviewRun(runs),
    activeRun: runs.find((run) => run.status === "running") ?? null,
    sessionStatusFor: (id: ThreadId) => sessionStatusById.get(id),
    loading: workflowRun.loading,
    error: workflowRun.error,
    refresh: workflowRun.refresh,
    commands,
  };
}

export type AppReviewData = ReturnType<typeof useAppReview>;

/**
 * The status of the run a controller thread drives, for the floating control.
 * Only a controller subscribes; every other thread pays nothing.
 */
export function useAppReviewControllerStatus(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  isController: boolean,
): AppReviewWorkflowRun["status"] | null {
  const runs = useAppReviewWorkflowRuns(isController ? environmentId : null);
  return isController ? (selectLatestAppReviewControllerRun(runs, threadId)?.status ?? null) : null;
}
