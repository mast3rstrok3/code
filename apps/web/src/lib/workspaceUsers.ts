import {
  type ClientSettingsPatch,
  DEFAULT_WORKSPACE_USER_ID,
  type WorkspaceUser,
  WorkspaceUserId,
} from "@t3tools/contracts";

export function resolveDefaultThreadOwnerUserId(input: {
  readonly activeWorkspaceUserId: WorkspaceUserId;
  readonly workspaceUsers: ReadonlyArray<WorkspaceUser>;
}): WorkspaceUserId {
  const { activeWorkspaceUserId, workspaceUsers } = input;
  if (workspaceUsers.some((user) => user.id === activeWorkspaceUserId)) {
    return activeWorkspaceUserId;
  }
  return DEFAULT_WORKSPACE_USER_ID;
}

/**
 * Project pickers offer only the acting user's projects, whatever the thread
 * view shows: a new thread belongs to the acting user, so it starts in their project.
 */
export function isProjectGroupOwnedBy(
  group: { readonly memberProjects: ReadonlyArray<{ readonly ownerUserId?: WorkspaceUserId }> },
  ownerUserId: WorkspaceUserId,
): boolean {
  return group.memberProjects.some(
    (project) => (project.ownerUserId ?? DEFAULT_WORKSPACE_USER_ID) === ownerUserId,
  );
}

/**
 * The sidebar's user scope. Picking a person both shows and acts as them, so
 * the new-thread project picker always has that person's projects loaded;
 * "all" widens the view and keeps the acting user.
 */
export function workspaceUserScopePatch(
  scopeKey: string,
): Pick<ClientSettingsPatch, "activeWorkspaceUserId" | "activeWorkspaceUserView"> {
  if (!scopeKey.startsWith("user:")) {
    return { activeWorkspaceUserView: { kind: "all" } };
  }
  const userId = WorkspaceUserId.make(scopeKey.slice("user:".length));
  return { activeWorkspaceUserId: userId, activeWorkspaceUserView: { kind: "user", userId } };
}
