import {
  DEFAULT_WORKSPACE_USER_ID,
  DEFAULT_WORKSPACE_USER_VIEW,
  type EnvironmentId,
  type WorkspaceUser,
  type WorkspaceUserId,
  type WorkspaceUserView,
} from "@t3tools/contracts";
import {
  isOwnedByWorkspaceUserView,
  resolveDefaultThreadOwnerUserId,
  resolveWorkspaceUserView,
  workspaceUserScopePatch,
} from "@t3tools/shared/workspaceUsers";

import type { WorkspaceUserScope } from "../../persistence/mobile-preferences";

export interface ResolvedWorkspaceUserScope {
  readonly view: WorkspaceUserView;
  readonly actingUserId: WorkspaceUserId;
}

/** A switcher is only offered once a server has someone to switch between. */
export function workspaceUserScopeIsSelectable(
  workspaceUsers: ReadonlyArray<WorkspaceUser> | null,
): workspaceUsers is ReadonlyArray<WorkspaceUser> {
  return workspaceUsers !== null && workspaceUsers.length > 1;
}

/**
 * `workspaceUsers` is null until the server's settings arrive. The saved view
 * stands until then, so a reconnect does not flash everyone's threads.
 */
export function resolveWorkspaceUserScope(
  saved: WorkspaceUserScope | undefined,
  workspaceUsers: ReadonlyArray<WorkspaceUser> | null,
): ResolvedWorkspaceUserScope {
  const savedView = saved?.view ?? DEFAULT_WORKSPACE_USER_VIEW;
  const savedUserId = saved?.activeUserId ?? DEFAULT_WORKSPACE_USER_ID;
  if (workspaceUsers === null) {
    return { view: savedView, actingUserId: savedUserId };
  }
  return {
    // Without a switcher there is no way back from a single-user view.
    view: workspaceUserScopeIsSelectable(workspaceUsers)
      ? resolveWorkspaceUserView(savedView, workspaceUsers)
      : DEFAULT_WORKSPACE_USER_VIEW,
    actingUserId: resolveDefaultThreadOwnerUserId({
      activeWorkspaceUserId: savedUserId,
      workspaceUsers,
    }),
  };
}

/** Picking a person shows and acts as them; "all" widens the view and keeps the acting user. */
export function selectWorkspaceUserScope(
  saved: WorkspaceUserScope | undefined,
  scopeKey: string,
): WorkspaceUserScope {
  const patch = workspaceUserScopePatch(scopeKey);
  const activeUserId = patch.activeWorkspaceUserId ?? saved?.activeUserId;
  return {
    ...(activeUserId === undefined ? {} : { activeUserId }),
    view: patch.activeWorkspaceUserView ?? DEFAULT_WORKSPACE_USER_VIEW,
  };
}

/**
 * New tasks start only in the acting user's projects, whatever the thread view
 * shows. Environments whose settings have not loaded keep every project, as do
 * projects `isShared` marks as everyone's (the server's folder for threads
 * without a project).
 */
export function filterProjectsForActingUsers<
  P extends { readonly environmentId: EnvironmentId; readonly ownerUserId?: WorkspaceUserId },
>(
  projects: ReadonlyArray<P>,
  actingUserIds: ReadonlyMap<EnvironmentId, WorkspaceUserId>,
  isShared: (project: P) => boolean = () => false,
): P[] {
  return projects.filter((project) => {
    const actingUserId = actingUserIds.get(project.environmentId);
    return (
      actingUserId === undefined ||
      isOwnedByWorkspaceUserView(project, { kind: "user", userId: actingUserId }) ||
      isShared(project)
    );
  });
}
