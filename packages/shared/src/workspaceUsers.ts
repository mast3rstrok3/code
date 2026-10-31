import {
  type ClientSettingsPatch,
  DEFAULT_WORKSPACE_USER_ID,
  DEFAULT_WORKSPACE_USER_VIEW,
  type WorkspaceUser,
  WorkspaceUserId,
  type WorkspaceUserView,
} from "@t3tools/contracts";

export function workspaceUserViewCacheKey(userView: WorkspaceUserView): string {
  return userView.kind === "all" ? "all" : `user:${userView.userId}`;
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

/** Records saved before users existed have no owner; they belong to the default user. */
export function isOwnedByWorkspaceUserView(
  entity: { readonly ownerUserId?: WorkspaceUserId | undefined },
  userView: WorkspaceUserView,
): boolean {
  return (
    userView.kind === "all" || (entity.ownerUserId ?? DEFAULT_WORKSPACE_USER_ID) === userView.userId
  );
}

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
