import type { WorkspaceUser } from "@t3tools/contracts";
import {
  createWorkspaceUserIdFromDisplayName,
  hasWorkspaceUserDisplayNameConflict,
} from "@t3tools/shared/workspaceUsers";

export type WorkspaceUserDisplayNameValidation =
  | {
      readonly valid: true;
      readonly displayName: string;
    }
  | {
      readonly valid: false;
      readonly reason: "blank" | "duplicate" | "unchanged";
    };

export function validateAddWorkspaceUser(
  displayName: string,
  workspaceUsers: ReadonlyArray<WorkspaceUser>,
): WorkspaceUserDisplayNameValidation {
  const trimmedDisplayName = displayName.trim();
  if (trimmedDisplayName.length === 0) {
    return { valid: false, reason: "blank" };
  }
  if (hasWorkspaceUserDisplayNameConflict(trimmedDisplayName, workspaceUsers)) {
    return { valid: false, reason: "duplicate" };
  }
  return { valid: true, displayName: trimmedDisplayName };
}

export function validateRenameWorkspaceUser(input: {
  readonly user: WorkspaceUser;
  readonly displayName: string;
  readonly workspaceUsers: ReadonlyArray<WorkspaceUser>;
}): WorkspaceUserDisplayNameValidation {
  const trimmedDisplayName = input.displayName.trim();
  if (trimmedDisplayName.length === 0) {
    return { valid: false, reason: "blank" };
  }
  if (
    hasWorkspaceUserDisplayNameConflict(trimmedDisplayName, input.workspaceUsers, input.user.id)
  ) {
    return { valid: false, reason: "duplicate" };
  }
  if (trimmedDisplayName === input.user.displayName) {
    return { valid: false, reason: "unchanged" };
  }
  return { valid: true, displayName: trimmedDisplayName };
}

export function createWorkspaceUser(
  displayName: string,
  workspaceUsers: ReadonlyArray<WorkspaceUser>,
): WorkspaceUser | null {
  const validation = validateAddWorkspaceUser(displayName, workspaceUsers);
  if (!validation.valid) {
    return null;
  }

  return {
    id: createWorkspaceUserIdFromDisplayName(validation.displayName, workspaceUsers),
    displayName: validation.displayName,
    github: { personalAccessToken: "" },
  };
}

export function renameWorkspaceUser(
  workspaceUsers: ReadonlyArray<WorkspaceUser>,
  userId: WorkspaceUser["id"],
  displayName: string,
): ReadonlyArray<WorkspaceUser> | null {
  const user = workspaceUsers.find((candidate) => candidate.id === userId);
  if (!user) {
    return null;
  }

  const validation = validateRenameWorkspaceUser({ user, displayName, workspaceUsers });
  if (!validation.valid) {
    return null;
  }

  return workspaceUsers.map((candidate) =>
    candidate.id === userId ? { ...candidate, displayName: validation.displayName } : candidate,
  );
}

export function replaceWorkspaceUserGithubPersonalAccessToken(
  workspaceUsers: ReadonlyArray<WorkspaceUser>,
  userId: WorkspaceUser["id"],
  personalAccessToken: string,
): ReadonlyArray<WorkspaceUser> | null {
  const trimmedToken = personalAccessToken.trim();
  if (trimmedToken.length === 0) {
    return null;
  }

  let didReplace = false;
  const nextUsers = workspaceUsers.map((user) => {
    if (user.id !== userId) {
      return user;
    }
    didReplace = true;
    return {
      ...user,
      github: {
        ...user.github,
        personalAccessToken: trimmedToken,
        personalAccessTokenRedacted: false,
      },
    };
  });

  return didReplace ? nextUsers : null;
}

export function clearWorkspaceUserGithubPersonalAccessToken(
  workspaceUsers: ReadonlyArray<WorkspaceUser>,
  userId: WorkspaceUser["id"],
): ReadonlyArray<WorkspaceUser> | null {
  let didClear = false;
  const nextUsers = workspaceUsers.map((user) => {
    if (user.id !== userId) {
      return user;
    }
    didClear = true;
    return {
      ...user,
      github: {
        ...user.github,
        personalAccessToken: "",
        personalAccessTokenRedacted: false,
      },
    };
  });

  return didClear ? nextUsers : null;
}
