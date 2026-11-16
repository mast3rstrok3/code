import type { WorkspaceUser } from "@t3tools/contracts";
import {
  createWorkspaceUserIdFromDisplayName,
  hasWorkspaceUserDisplayNameConflict,
} from "./workspaceUsers.ts";

export type WorkspaceUserDisplayNameValidation =
  | {
      readonly valid: true;
      readonly displayName: string;
    }
  | {
      readonly valid: false;
      readonly reason: "blank" | "duplicate" | "unchanged";
    };

/** Null when there is nothing to tell the user, including an unchanged name. */
export function workspaceUserDisplayNameMessage(
  validation: WorkspaceUserDisplayNameValidation,
): string | null {
  if (validation.valid || validation.reason === "unchanged") {
    return null;
  }
  if (validation.reason === "blank") {
    return "Display name is required.";
  }
  return "Display name already exists.";
}

/** Owner and legacy ownerless tokens alike authenticate the user's runs. */
export function workspaceUserGithubTokenCount(user: WorkspaceUser): number {
  return (user.github.ownerTokens?.length ?? 0) + (user.github.personalAccessTokenRedacted ? 1 : 0);
}

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

/** Removes the legacy token saved before tokens had owners. */
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

function updateWorkspaceUser(
  workspaceUsers: ReadonlyArray<WorkspaceUser>,
  userId: WorkspaceUser["id"],
  update: (user: WorkspaceUser) => WorkspaceUser,
): ReadonlyArray<WorkspaceUser> | null {
  if (!workspaceUsers.some((user) => user.id === userId)) {
    return null;
  }
  return workspaceUsers.map((user) => (user.id === userId ? update(user) : user));
}

export type GithubOwnerTokenValidation =
  | { readonly valid: true; readonly owner: string; readonly personalAccessToken: string }
  | {
      readonly valid: false;
      readonly reason: "blank-owner" | "invalid-owner" | "duplicate-owner" | "blank-token";
    };

/** A blank owner gets no message yet; a blank token only disables saving. */
export function githubOwnerTokenValidationMessage(
  validation: GithubOwnerTokenValidation,
): string | null {
  if (validation.valid) {
    return null;
  }
  if (validation.reason === "invalid-owner") {
    return "Enter a GitHub user or organization name.";
  }
  if (validation.reason === "duplicate-owner") {
    return "That owner already has a token.";
  }
  return null;
}

// GitHub user and organization logins: letters, digits, and single inner hyphens.
const GITHUB_OWNER_PATTERN = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d]))*$/i;

export function validateAddGithubOwnerToken(
  user: WorkspaceUser,
  owner: string,
  personalAccessToken: string,
): GithubOwnerTokenValidation {
  const trimmedOwner = owner.trim();
  if (trimmedOwner.length === 0) {
    return { valid: false, reason: "blank-owner" };
  }
  if (!GITHUB_OWNER_PATTERN.test(trimmedOwner)) {
    return { valid: false, reason: "invalid-owner" };
  }
  if (
    user.github.ownerTokens?.some(
      (token) => token.owner.toLowerCase() === trimmedOwner.toLowerCase(),
    )
  ) {
    return { valid: false, reason: "duplicate-owner" };
  }
  const trimmedToken = personalAccessToken.trim();
  if (trimmedToken.length === 0) {
    return { valid: false, reason: "blank-token" };
  }
  return { valid: true, owner: trimmedOwner, personalAccessToken: trimmedToken };
}

export function addWorkspaceUserGithubOwnerToken(
  workspaceUsers: ReadonlyArray<WorkspaceUser>,
  userId: WorkspaceUser["id"],
  owner: string,
  personalAccessToken: string,
): ReadonlyArray<WorkspaceUser> | null {
  const user = workspaceUsers.find((candidate) => candidate.id === userId);
  if (!user) {
    return null;
  }
  const validation = validateAddGithubOwnerToken(user, owner, personalAccessToken);
  if (!validation.valid) {
    return null;
  }
  return updateWorkspaceUser(workspaceUsers, userId, (candidate) => ({
    ...candidate,
    github: {
      ...candidate.github,
      ownerTokens: [
        ...(candidate.github.ownerTokens ?? []),
        {
          owner: validation.owner,
          personalAccessToken: validation.personalAccessToken,
          personalAccessTokenRedacted: false,
        },
      ],
    },
  }));
}

export function replaceWorkspaceUserGithubOwnerToken(
  workspaceUsers: ReadonlyArray<WorkspaceUser>,
  userId: WorkspaceUser["id"],
  owner: string,
  personalAccessToken: string,
): ReadonlyArray<WorkspaceUser> | null {
  const trimmedToken = personalAccessToken.trim();
  if (trimmedToken.length === 0) {
    return null;
  }
  return updateWorkspaceUser(workspaceUsers, userId, (user) => ({
    ...user,
    github: {
      ...user.github,
      ownerTokens: (user.github.ownerTokens ?? []).map((token) =>
        token.owner === owner
          ? { ...token, personalAccessToken: trimmedToken, personalAccessTokenRedacted: false }
          : token,
      ),
    },
  }));
}

export function removeWorkspaceUserGithubOwnerToken(
  workspaceUsers: ReadonlyArray<WorkspaceUser>,
  userId: WorkspaceUser["id"],
  owner: string,
): ReadonlyArray<WorkspaceUser> | null {
  return updateWorkspaceUser(workspaceUsers, userId, (user) => ({
    ...user,
    github: {
      ...user.github,
      ownerTokens: (user.github.ownerTokens ?? []).filter((token) => token.owner !== owner),
    },
  }));
}

/**
 * Permissions T3 Code threads need: push, pull requests, reading CI, and pushing commits that
 * touch `.github/workflows` (GitHub rejects those pushes without `workflows`, which is write-only).
 * GitHub cannot pre-fill repository access, so the user still picks the repositories.
 */
const GITHUB_FINE_GRAINED_TOKEN_PERMISSIONS = {
  contents: "write",
  pull_requests: "write",
  workflows: "write",
  statuses: "read",
  actions: "read",
} as const;

/** GitHub's fine-grained token form, pre-filled for `owner` (defaults to the signed-in account). */
export function githubFineGrainedTokenUrl(owner?: string): string {
  const trimmedOwner = owner?.trim();
  const params = new URLSearchParams({
    name: (trimmedOwner ? `T3 Code ${trimmedOwner}` : "T3 Code").slice(0, 40),
    description: "Used by T3 Code threads to push and open pull requests.",
    ...(trimmedOwner ? { target_name: trimmedOwner } : {}),
    ...GITHUB_FINE_GRAINED_TOKEN_PERMISSIONS,
  });
  return `https://github.com/settings/personal-access-tokens/new?${params.toString()}`;
}
