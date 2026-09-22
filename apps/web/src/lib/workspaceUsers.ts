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
