import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentProject,
  EnvironmentThread,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import {
  type EnvironmentThreadStatus,
  mergeEnvironmentThread,
} from "@t3tools/client-runtime/state/threads";
import type {
  OrchestrationMessage,
  OrchestrationImplementationRun,
  OrchestrationPlanningSpecId,
  OrchestrationPlanningWorkflow,
  OrchestrationProposedPlan,
  OrchestrationSession,
  OrchestrationThreadActivity,
  DevReviewRecord,
  ScopedProjectRef,
  ScopedThreadRef,
  ServerConfig,
} from "@t3tools/contracts";
import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";
import { useMemo } from "react";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentProjects } from "./projects";
import { environmentServerConfigsAtom } from "./server";
import { allEnvironmentShellsBootstrappedAtom } from "./shell";
import { environmentThreadDetails, environmentThreadShells, threadEnvironment } from "./threads";
import { useAtomCommand } from "./use-atom-command";

const EMPTY_PROJECT_REFS: ReadonlyArray<ScopedProjectRef> = Object.freeze([]);
const EMPTY_THREAD_REFS: ReadonlyArray<ScopedThreadRef> = Object.freeze([]);
const EMPTY_MESSAGES: ReadonlyArray<OrchestrationMessage> = Object.freeze([]);
const EMPTY_ACTIVITIES: ReadonlyArray<OrchestrationThreadActivity> = Object.freeze([]);
const EMPTY_PROPOSED_PLANS: ReadonlyArray<OrchestrationProposedPlan> = Object.freeze([]);
const EMPTY_DEV_REVIEWS: ReadonlyArray<DevReviewRecord> = Object.freeze([]);
const EMPTY_IMPLEMENTATION_RUNS: ReadonlyArray<OrchestrationImplementationRun> = Object.freeze([]);

const EMPTY_PROJECT_ATOM = Atom.make<EnvironmentProject | null>(null).pipe(
  Atom.withLabel("web-project:empty"),
);
const EMPTY_PROJECT_REFS_ATOM = Atom.make(EMPTY_PROJECT_REFS).pipe(
  Atom.withLabel("web-project-refs:empty"),
);
const EMPTY_THREAD_REFS_ATOM = Atom.make(EMPTY_THREAD_REFS).pipe(
  Atom.withLabel("web-thread-refs:empty"),
);
const EMPTY_THREAD_SHELL_ATOM = Atom.make<EnvironmentThreadShell | null>(null).pipe(
  Atom.withLabel("web-thread-shell:empty"),
);
const EMPTY_THREAD_DETAIL_ATOM = Atom.make<EnvironmentThread | null>(null).pipe(
  Atom.withLabel("web-thread-detail:empty"),
);
const EMPTY_THREAD_STATUS_ATOM = Atom.make<EnvironmentThreadStatus>("empty").pipe(
  Atom.withLabel("web-thread-status:empty"),
);
const EMPTY_MESSAGES_ATOM = Atom.make(EMPTY_MESSAGES).pipe(
  Atom.withLabel("web-thread-messages:empty"),
);
const EMPTY_ACTIVITIES_ATOM = Atom.make(EMPTY_ACTIVITIES).pipe(
  Atom.withLabel("web-thread-activities:empty"),
);
const EMPTY_PROPOSED_PLANS_ATOM = Atom.make(EMPTY_PROPOSED_PLANS).pipe(
  Atom.withLabel("web-thread-proposed-plans:empty"),
);
const EMPTY_DEV_REVIEWS_ATOM = Atom.make(EMPTY_DEV_REVIEWS).pipe(
  Atom.withLabel("web-thread-dev-reviews:empty"),
);
const EMPTY_PLANNING_WORKFLOW_ATOM = Atom.make<OrchestrationPlanningWorkflow | null>(null).pipe(
  Atom.withLabel("web-thread-planning-workflow:empty"),
);
const EMPTY_IMPLEMENTATION_RUNS_ATOM = Atom.make(EMPTY_IMPLEMENTATION_RUNS).pipe(
  Atom.withLabel("web-implementation-runs:empty"),
);
const EMPTY_SESSION_ATOM = Atom.make<OrchestrationSession | null>(null).pipe(
  Atom.withLabel("web-thread-session:empty"),
);

export const activeEnvironmentIdAtom = Atom.make<EnvironmentId | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("web-active-environment-id"),
);

export function useActiveEnvironmentId(): EnvironmentId | null {
  return useAtomValue(activeEnvironmentIdAtom);
}

export function readActiveEnvironmentId(): EnvironmentId | null {
  return appAtomRegistry.get(activeEnvironmentIdAtom);
}

export function setActiveEnvironmentId(environmentId: EnvironmentId | null): void {
  appAtomRegistry.set(activeEnvironmentIdAtom, environmentId);
}

export function useProjectRefs(): ReadonlyArray<ScopedProjectRef> {
  return useAtomValue(environmentProjects.projectRefsAtom);
}

export function useThreadRefs(): ReadonlyArray<ScopedThreadRef> {
  return useAtomValue(environmentThreadShells.threadRefsAtom);
}

export function useEnvironmentProjectRefs(
  environmentId: EnvironmentId | null,
): ReadonlyArray<ScopedProjectRef> {
  return useAtomValue(
    environmentId === null
      ? EMPTY_PROJECT_REFS_ATOM
      : environmentProjects.environmentProjectRefsAtom(environmentId),
  );
}

export function useEnvironmentThreadRefs(
  environmentId: EnvironmentId | null,
): ReadonlyArray<ScopedThreadRef> {
  return useAtomValue(
    environmentId === null
      ? EMPTY_THREAD_REFS_ATOM
      : environmentThreadShells.environmentThreadRefsAtom(environmentId),
  );
}

export function useProjects(): ReadonlyArray<EnvironmentProject> {
  return useAtomValue(environmentProjects.projectsAtom);
}

export function useServerConfigs(): ReadonlyMap<EnvironmentId, ServerConfig> {
  return useAtomValue(environmentServerConfigsAtom);
}

export function useThreadShells(): ReadonlyArray<EnvironmentThreadShell> {
  return useAtomValue(environmentThreadShells.threadShellsAtom);
}

export function useAllEnvironmentShellsBootstrapped(): boolean {
  return useAtomValue(allEnvironmentShellsBootstrappedAtom);
}

export function useThreadShellsForProjectRefs(
  refs: ReadonlyArray<ScopedProjectRef>,
): ReadonlyArray<EnvironmentThreadShell> {
  return useAtomValue(environmentThreadShells.threadShellsForProjectRefsAtom(refs));
}

export function useProject(ref: ScopedProjectRef | null): EnvironmentProject | null {
  return useAtomValue(ref === null ? EMPTY_PROJECT_ATOM : environmentProjects.projectAtom(ref));
}

export function useThreadShell(ref: ScopedThreadRef | null): EnvironmentThreadShell | null {
  return useAtomValue(
    ref === null ? EMPTY_THREAD_SHELL_ATOM : environmentThreadShells.threadShellAtom(ref),
  );
}

export function useThreadDetail(ref: ScopedThreadRef | null): EnvironmentThread | null {
  return useAtomValue(
    ref === null ? EMPTY_THREAD_DETAIL_ATOM : environmentThreadDetails.detailAtom(ref),
  );
}

export function useThreadStatus(ref: ScopedThreadRef | null): EnvironmentThreadStatus {
  return useAtomValue(
    ref === null ? EMPTY_THREAD_STATUS_ATOM : environmentThreadDetails.statusAtom(ref),
  );
}

/** Detail collections composed with shell-authoritative thread/workspace metadata. */
export function useThread(ref: ScopedThreadRef | null): EnvironmentThread | null {
  const shell = useThreadShell(ref);
  const detail = useThreadDetail(ref);
  return useMemo(() => mergeEnvironmentThread(detail, shell), [detail, shell]);
}

export function useThreadMessages(
  ref: ScopedThreadRef | null,
): ReadonlyArray<OrchestrationMessage> {
  return useAtomValue(
    ref === null ? EMPTY_MESSAGES_ATOM : environmentThreadDetails.messagesAtom(ref),
  );
}

export function useThreadActivities(
  ref: ScopedThreadRef | null,
): ReadonlyArray<OrchestrationThreadActivity> {
  return useAtomValue(
    ref === null ? EMPTY_ACTIVITIES_ATOM : environmentThreadDetails.activitiesAtom(ref),
  );
}

export function useThreadProposedPlans(
  ref: ScopedThreadRef | null,
): ReadonlyArray<OrchestrationProposedPlan> {
  return useAtomValue(
    ref === null ? EMPTY_PROPOSED_PLANS_ATOM : environmentThreadDetails.proposedPlansAtom(ref),
  );
}

export function useThreadPlanningWorkflow(
  ref: ScopedThreadRef | null,
): OrchestrationPlanningWorkflow | null {
  return useAtomValue(
    ref === null
      ? EMPTY_PLANNING_WORKFLOW_ATOM
      : environmentThreadDetails.planningWorkflowAtom(ref),
  );
}

export function useThreadDevReviews(ref: ScopedThreadRef | null): ReadonlyArray<DevReviewRecord> {
  return useAtomValue(
    ref === null ? EMPTY_DEV_REVIEWS_ATOM : environmentThreadDetails.devReviewsAtom(ref),
  );
}

export function useImplementationRuns(
  environmentId: EnvironmentId | null,
): ReadonlyArray<OrchestrationImplementationRun> {
  return useAtomValue(
    environmentId === null
      ? EMPTY_IMPLEMENTATION_RUNS_ATOM
      : environmentThreadShells.environmentImplementationRunsAtom(environmentId),
  );
}

export function useImplementationRunsForSpec(
  environmentId: EnvironmentId | null,
  specId: OrchestrationPlanningSpecId | null,
): ReadonlyArray<OrchestrationImplementationRun> {
  return useAtomValue(
    environmentId === null || specId === null
      ? EMPTY_IMPLEMENTATION_RUNS_ATOM
      : environmentThreadShells.implementationRunsBySpecAtom({ environmentId, specId }),
  );
}

export function usePlanningWorkflowThreadShells(
  environmentId: EnvironmentId | null,
  projectId?: ProjectId | null,
): ReadonlyArray<EnvironmentThreadShell> {
  const shells = useThreadShells();
  return useMemo(
    () =>
      environmentId === null
        ? []
        : shells.filter(
            (thread) =>
              thread.environmentId === environmentId &&
              (projectId === undefined || projectId === null || thread.projectId === projectId) &&
              (thread.parentThreadId !== null ||
                thread.workflowRole !== null ||
                thread.planningWorkflowSummary !== undefined),
          ),
    [environmentId, projectId, shells],
  );
}

export function useThreadSession(ref: ScopedThreadRef | null): OrchestrationSession | null {
  return useAtomValue(
    ref === null ? EMPTY_SESSION_ATOM : environmentThreadDetails.sessionAtom(ref),
  );
}

export function useLoadPlanningSpecBundleCommand() {
  return useAtomCommand(threadEnvironment.loadPlanningSpecBundle, {
    label: "planning Spec bundle load",
  });
}

export function useRequestPlanningTicketReviewCommand() {
  return useAtomCommand(threadEnvironment.requestPlanningTicketReview, {
    label: "planning ticket review request",
  });
}

export function useLaunchImplementationRunCommand() {
  return useAtomCommand(threadEnvironment.launchImplementationRun, {
    label: "implementation run launch",
  });
}

export function useRetryImplementationChangeRequestCommand() {
  return useAtomCommand(threadEnvironment.retryImplementationChangeRequest, {
    label: "implementation change request retry",
  });
}

export function useRetryImplementationRunCommand() {
  return useAtomCommand(threadEnvironment.retryImplementationRun, {
    label: "implementation run retry",
  });
}

export function readProject(ref: ScopedProjectRef): EnvironmentProject | null {
  return appAtomRegistry.get(environmentProjects.projectAtom(ref));
}

export function readThreadShell(ref: ScopedThreadRef): EnvironmentThreadShell | null {
  return appAtomRegistry.get(environmentThreadShells.threadShellAtom(ref));
}

/** Whether the environment's server understands thread.settle/unsettle.
    False for pre-settlement servers (capability defaults false on decode),
    so clients under version skew fall back instead of erroring. */
export function readEnvironmentSupportsSettlement(environmentId: EnvironmentId): boolean {
  return (
    appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
      .threadSettlement === true
  );
}

/** Whether the environment's server understands thread.snooze/unsnooze.
    Same version-skew contract as settlement. */
export function readEnvironmentSupportsSnooze(environmentId: EnvironmentId): boolean {
  return (
    appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
      .threadSnooze === true
  );
}

export function readThreadDetail(ref: ScopedThreadRef): EnvironmentThread | null {
  return appAtomRegistry.get(environmentThreadDetails.detailAtom(ref));
}

export function readEnvironmentThreadRefs(
  environmentId: EnvironmentId,
): ReadonlyArray<ScopedThreadRef> {
  return appAtomRegistry.get(environmentThreadShells.environmentThreadRefsAtom(environmentId));
}

export function readThreadRefs(): ReadonlyArray<ScopedThreadRef> {
  return appAtomRegistry.get(environmentThreadShells.threadRefsAtom);
}

export function findThreadRef(threadId: ThreadId): ScopedThreadRef | null {
  return (
    appAtomRegistry
      .get(environmentThreadShells.threadRefsAtom)
      .find((ref) => ref.threadId === threadId) ?? null
  );
}
