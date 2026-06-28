import {
  DEFAULT_WORKSPACE_USER_VIEW,
  type EnvironmentId,
  type WorkspaceUser,
  WorkspaceUserId,
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

export function createWorkspaceUserIdFromDisplayName(
  displayName: string,
  existingUsers: ReadonlyArray<WorkspaceUser>,
): WorkspaceUserId {
  const base =
    displayName
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "user";
  const existingIds = new Set<string>(existingUsers.map((user) => user.id));
  let candidate = base;
  let suffix = 2;
  while (existingIds.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return WorkspaceUserId.make(candidate);
}

export function hasWorkspaceUserDisplayNameConflict(
  displayName: string,
  existingUsers: ReadonlyArray<WorkspaceUser>,
  ignoredUserId?: WorkspaceUserId,
): boolean {
  const normalizedDisplayName = displayName.trim().toLowerCase();
  if (normalizedDisplayName.length === 0) {
    return false;
  }

  return existingUsers.some(
    (user) =>
      user.id !== ignoredUserId && user.displayName.trim().toLowerCase() === normalizedDisplayName,
  );
}
