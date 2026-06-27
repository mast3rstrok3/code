import {
  DEFAULT_WORKSPACE_USER_ID,
  type WorkspaceUser,
  type WorkspaceUserId,
  type WorkspaceUserView,
} from "@t3tools/contracts";

export function resolveDefaultThreadOwnerUserId(input: {
  readonly activeWorkspaceUserView: WorkspaceUserView;
  readonly workspaceUsers: ReadonlyArray<WorkspaceUser>;
}): WorkspaceUserId {
  const { activeWorkspaceUserView, workspaceUsers } = input;
  if (
    activeWorkspaceUserView.kind === "user" &&
    workspaceUsers.some((user) => user.id === activeWorkspaceUserView.userId)
  ) {
    return activeWorkspaceUserView.userId;
  }
  return DEFAULT_WORKSPACE_USER_ID;
}
