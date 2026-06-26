import {
  DEFAULT_WORKSPACE_USER_VIEW,
  type EnvironmentId,
  type WorkspaceUser,
  type WorkspaceUserView,
} from "@t3tools/contracts";

export function workspaceUserViewCacheKey(userView: WorkspaceUserView): string {
  return userView.kind === "all" ? "all" : `user:${userView.userId}`;
}

export function environmentShellCacheKey(
  environmentId: EnvironmentId,
  userView: WorkspaceUserView,
): string {
  const userViewKey = workspaceUserViewCacheKey(userView);
  return userViewKey === "all" ? environmentId : `${environmentId}::${userViewKey}`;
}

export function resolveWorkspaceUserView(
  userView: WorkspaceUserView,
  workspaceUsers: ReadonlyArray<WorkspaceUser>,
): WorkspaceUserView {
  if (userView.kind === "all") {
    return userView;
  }
  return workspaceUsers.some((user) => user.id === userView.userId)
    ? userView
    : DEFAULT_WORKSPACE_USER_VIEW;
}
