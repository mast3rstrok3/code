import {
  DEFAULT_WORKSPACE_USER_ID,
  type WorkspaceUser,
  type WorkspaceUserId,
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
  group: { readonly memberProjects: ReadonlyArray<{ readonly ownerUserId: WorkspaceUserId }> },
  ownerUserId: WorkspaceUserId,
): boolean {
  return group.memberProjects.some((project) => project.ownerUserId === ownerUserId);
}
