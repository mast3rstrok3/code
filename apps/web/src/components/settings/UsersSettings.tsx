import { CheckIcon, ExternalLinkIcon, KeyRoundIcon, PlusIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { WorkspaceUser } from "@t3tools/contracts";

import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";
import {
  addWorkspaceUserGithubOwnerToken,
  clearWorkspaceUserGithubPersonalAccessToken,
  createWorkspaceUser,
  githubFineGrainedTokenUrl,
  type GithubOwnerTokenValidation,
  removeWorkspaceUserGithubOwnerToken,
  renameWorkspaceUser,
  replaceWorkspaceUserGithubOwnerToken,
  replaceWorkspaceUserGithubPersonalAccessToken,
  validateAddGithubOwnerToken,
  validateAddWorkspaceUser,
  validateRenameWorkspaceUser,
  type WorkspaceUserDisplayNameValidation,
} from "./UsersSettings.logic";

function GithubTokenLink({ owner, children }: { owner?: string; children: string }) {
  return (
    <a
      href={githubFineGrainedTokenUrl(owner)}
      target="_blank"
      rel="noreferrer"
      className="inline-flex min-w-0 items-center gap-1 rounded-sm text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
    >
      <span className="truncate">{children}</span>
      <ExternalLinkIcon className="size-3 shrink-0" aria-hidden />
    </a>
  );
}

function validationMessage(validation: WorkspaceUserDisplayNameValidation): string | null {
  if (validation.valid || validation.reason === "unchanged") {
    return null;
  }
  if (validation.reason === "blank") {
    return "Display name is required.";
  }
  return "Display name already exists.";
}

function ownerTokenValidationMessage(validation: GithubOwnerTokenValidation): string | null {
  if (validation.valid || validation.reason === "blank-owner") {
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

function updateWorkspaceUserArray(
  nextUsers: ReadonlyArray<WorkspaceUser> | null,
  onWorkspaceUsersChange: (users: ReadonlyArray<WorkspaceUser>) => void,
): void {
  if (nextUsers) {
    onWorkspaceUsersChange(nextUsers);
  }
}

function WorkspaceUserSettingsRow({
  user,
  workspaceUsers,
  onWorkspaceUsersChange,
}: {
  readonly user: WorkspaceUser;
  readonly workspaceUsers: ReadonlyArray<WorkspaceUser>;
  readonly onWorkspaceUsersChange: (users: ReadonlyArray<WorkspaceUser>) => void;
}) {
  const [displayName, setDisplayName] = useState(user.displayName);
  const configured = Boolean(user.github.personalAccessTokenRedacted);
  const ownerTokens = user.github.ownerTokens ?? [];
  const renameValidation = validateRenameWorkspaceUser({ user, displayName, workspaceUsers });
  const renameMessage = validationMessage(renameValidation);

  useEffect(() => {
    setDisplayName(user.displayName);
  }, [user.displayName, user.id]);

  const handleRename = () => {
    const nextUsers = renameWorkspaceUser(workspaceUsers, user.id, displayName);
    updateWorkspaceUserArray(nextUsers, onWorkspaceUsersChange);
  };

  return (
    <div className="grid gap-3 border-t border-border/60 px-4 py-3.5 first:border-t-0 sm:px-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="truncate text-[13px] font-semibold tracking-[-0.01em] text-foreground">
              {user.displayName}
            </span>
            <Badge variant={configured ? "success" : "secondary"} size="sm">
              {configured ? "Token configured" : "No token"}
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground/80">
            Stable user id <code className="text-[11px]">{user.id}</code>
          </p>
        </div>
      </div>

      <form
        className="grid gap-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          if (renameValidation.valid) {
            handleRename();
          }
        }}
      >
        <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
          <Input
            size="sm"
            value={displayName}
            aria-label={`${user.displayName} display name`}
            aria-invalid={renameMessage ? true : undefined}
            onChange={(event) => setDisplayName(event.target.value)}
          />
          <Button type="submit" size="sm" variant="outline" disabled={!renameValidation.valid}>
            <CheckIcon className="size-3.5" />
            Rename
          </Button>
        </div>
        {renameMessage ? <p className="text-[11px] text-destructive">{renameMessage}</p> : null}
      </form>

      <GithubTokenForm
        label={`${user.displayName} default GitHub personal access token`}
        placeholder={
          configured
            ? "Replace default GitHub token"
            : "Default GitHub token, for repositories no owner token covers"
        }
        configured={configured}
        clearLabel="Clear"
        onSave={(token) =>
          replaceWorkspaceUserGithubPersonalAccessToken(workspaceUsers, user.id, token)
        }
        onClear={() => clearWorkspaceUserGithubPersonalAccessToken(workspaceUsers, user.id)}
        onWorkspaceUsersChange={onWorkspaceUsersChange}
      />

      {ownerTokens.map((token) => (
        <div key={token.owner} className="grid gap-1.5">
          <div className="flex items-center gap-2 text-xs">
            <span className="font-medium text-foreground">{token.owner}</span>
            <span className="text-muted-foreground">repositories</span>
          </div>
          <GithubTokenForm
            label={`${user.displayName} GitHub token for ${token.owner}`}
            placeholder={`Replace token for ${token.owner}`}
            configured={Boolean(token.personalAccessTokenRedacted)}
            clearLabel="Remove"
            onSave={(value) =>
              replaceWorkspaceUserGithubOwnerToken(workspaceUsers, user.id, token.owner, value)
            }
            onClear={() =>
              removeWorkspaceUserGithubOwnerToken(workspaceUsers, user.id, token.owner)
            }
            onWorkspaceUsersChange={onWorkspaceUsersChange}
          />
        </div>
      ))}

      <AddGithubOwnerTokenForm
        user={user}
        workspaceUsers={workspaceUsers}
        onWorkspaceUsersChange={onWorkspaceUsersChange}
      />

      <div className="grid gap-1 text-[11px] text-muted-foreground">
        <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
          <GithubTokenLink>Create a fine-grained GitHub token</GithubTokenLink>
          <span>with the permissions below already selected.</span>
        </p>
        <p>
          Contents and Pull requests: read and write. Commit statuses and Actions: read. Choose the
          repositories yourself, since GitHub cannot pre-select them. Add Workflows (read and write)
          if agents edit <code>.github/workflows</code>, and Issues if they work with issues. A
          token covers one user or organization; the owner token form links to one for that owner.
        </p>
      </div>
    </div>
  );
}

function GithubTokenForm({
  label,
  placeholder,
  configured,
  clearLabel,
  onSave,
  onClear,
  onWorkspaceUsersChange,
}: {
  readonly label: string;
  readonly placeholder: string;
  readonly configured: boolean;
  readonly clearLabel: "Clear" | "Remove";
  readonly onSave: (token: string) => ReadonlyArray<WorkspaceUser> | null;
  readonly onClear: () => ReadonlyArray<WorkspaceUser> | null;
  readonly onWorkspaceUsersChange: (users: ReadonlyArray<WorkspaceUser>) => void;
}) {
  const [tokenDraft, setTokenDraft] = useState("");
  const trimmedToken = tokenDraft.trim();

  const handleSave = () => {
    const nextUsers = onSave(tokenDraft);
    updateWorkspaceUserArray(nextUsers, onWorkspaceUsersChange);
    if (nextUsers) {
      setTokenDraft("");
    }
  };

  const handleClear = () => {
    updateWorkspaceUserArray(onClear(), onWorkspaceUsersChange);
    setTokenDraft("");
  };

  return (
    <form
      className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto_auto]"
      onSubmit={(event) => {
        event.preventDefault();
        if (trimmedToken.length > 0) {
          handleSave();
        }
      }}
    >
      <Input
        size="sm"
        type="password"
        value={tokenDraft}
        autoComplete="off"
        aria-label={label}
        placeholder={placeholder}
        onChange={(event) => setTokenDraft(event.target.value)}
      />
      <Button type="submit" size="sm" variant="outline" disabled={trimmedToken.length === 0}>
        <KeyRoundIcon className="size-3.5" />
        {configured ? "Replace" : "Save"}
      </Button>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        disabled={clearLabel === "Clear" && !configured && trimmedToken.length === 0}
        onClick={handleClear}
      >
        <XIcon className="size-3.5" />
        {clearLabel}
      </Button>
    </form>
  );
}

function AddGithubOwnerTokenForm({
  user,
  workspaceUsers,
  onWorkspaceUsersChange,
}: {
  readonly user: WorkspaceUser;
  readonly workspaceUsers: ReadonlyArray<WorkspaceUser>;
  readonly onWorkspaceUsersChange: (users: ReadonlyArray<WorkspaceUser>) => void;
}) {
  const [owner, setOwner] = useState("");
  const [tokenDraft, setTokenDraft] = useState("");
  const validation = validateAddGithubOwnerToken(user, owner, tokenDraft);
  const message = ownerTokenValidationMessage(validation);

  const handleAdd = () => {
    const nextUsers = addWorkspaceUserGithubOwnerToken(workspaceUsers, user.id, owner, tokenDraft);
    updateWorkspaceUserArray(nextUsers, onWorkspaceUsersChange);
    if (nextUsers) {
      setOwner("");
      setTokenDraft("");
    }
  };

  return (
    <form
      className="grid gap-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        if (validation.valid) {
          handleAdd();
        }
      }}
    >
      <div className="grid gap-2 sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)_auto]">
        <Input
          size="sm"
          value={owner}
          autoComplete="off"
          aria-label={`${user.displayName} GitHub token owner`}
          aria-invalid={message ? true : undefined}
          placeholder="GitHub user or org"
          onChange={(event) => setOwner(event.target.value)}
        />
        <Input
          size="sm"
          type="password"
          value={tokenDraft}
          autoComplete="off"
          aria-label={`${user.displayName} GitHub token for owner`}
          placeholder="Token for that owner's repositories"
          onChange={(event) => setTokenDraft(event.target.value)}
        />
        <Button type="submit" size="sm" variant="outline" disabled={!validation.valid}>
          <PlusIcon className="size-3.5" />
          Add owner token
        </Button>
      </div>
      {message ? (
        <p className="text-[11px] text-destructive">{message}</p>
      ) : validation.valid || validation.reason === "blank-token" ? (
        <p className="text-[11px] text-muted-foreground">
          <GithubTokenLink owner={owner}>{`Create a token for ${owner.trim()}`}</GithubTokenLink>
        </p>
      ) : null}
    </form>
  );
}

function AddWorkspaceUserRow({
  workspaceUsers,
  onWorkspaceUsersChange,
}: {
  readonly workspaceUsers: ReadonlyArray<WorkspaceUser>;
  readonly onWorkspaceUsersChange: (users: ReadonlyArray<WorkspaceUser>) => void;
}) {
  const [displayName, setDisplayName] = useState("");
  const validation = validateAddWorkspaceUser(displayName, workspaceUsers);
  const message = displayName.length > 0 ? validationMessage(validation) : null;

  const handleAddUser = () => {
    const user = createWorkspaceUser(displayName, workspaceUsers);
    if (!user) {
      return;
    }
    onWorkspaceUsersChange([...workspaceUsers, user]);
    setDisplayName("");
  };

  return (
    <form
      className="grid gap-1.5 border-t border-border/60 px-4 py-3.5 sm:px-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (validation.valid) {
          handleAddUser();
        }
      }}
    >
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
        <Input
          size="sm"
          value={displayName}
          aria-label="New workspace user display name"
          aria-invalid={message ? true : undefined}
          placeholder="New workspace user"
          onChange={(event) => setDisplayName(event.target.value)}
        />
        <Button type="submit" size="sm" variant="outline" disabled={!validation.valid}>
          <PlusIcon className="size-3.5" />
          Add user
        </Button>
      </div>
      {message ? <p className="text-[11px] text-destructive">{message}</p> : null}
    </form>
  );
}

export function UsersSettingsPanel() {
  const workspaceUsers = usePrimarySettings((settings) => settings.workspaceUsers);
  const updateSettings = useUpdatePrimarySettings();
  const updateWorkspaceUsers = useCallback(
    (users: ReadonlyArray<WorkspaceUser>) => {
      updateSettings({ workspaceUsers: [...users] });
    },
    [updateSettings],
  );

  return (
    <SettingsPageContainer>
      <p className="px-4 text-sm text-muted-foreground sm:px-5">
        Choose your user in the sidebar before starting a thread. Each thread keeps its owner when
        you switch users or view someone else's threads. Every user, including the main user, needs
        a name and a valid GitHub token before running an agent. Commits use the name entered here.
        Pushes and pull requests use that user's token. A fine-grained token covers one GitHub user
        or organization, so add an owner token for each extra one. Threads use the token whose owner
        matches the project's GitHub remote, and the default token otherwise.
      </p>
      <SettingsSection title="Users">
        {workspaceUsers.map((user) => (
          <WorkspaceUserSettingsRow
            key={user.id}
            user={user}
            workspaceUsers={workspaceUsers}
            onWorkspaceUsersChange={updateWorkspaceUsers}
          />
        ))}
        <AddWorkspaceUserRow
          workspaceUsers={workspaceUsers}
          onWorkspaceUsersChange={updateWorkspaceUsers}
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
