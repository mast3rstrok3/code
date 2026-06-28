import { CheckIcon, ExternalLinkIcon, KeyRoundIcon, PlusIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { WorkspaceUser } from "@t3tools/contracts";

import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";
import {
  clearWorkspaceUserGithubPersonalAccessToken,
  createWorkspaceUser,
  renameWorkspaceUser,
  replaceWorkspaceUserGithubPersonalAccessToken,
  validateAddWorkspaceUser,
  validateRenameWorkspaceUser,
  type WorkspaceUserDisplayNameValidation,
} from "./UsersSettings.logic";

const GITHUB_PERSONAL_ACCESS_TOKEN_URL = "https://github.com/settings/tokens/new";
const GITHUB_PERSONAL_ACCESS_TOKEN_DISPLAY_URL = "github.com/settings/tokens/new";

function validationMessage(validation: WorkspaceUserDisplayNameValidation): string | null {
  if (validation.valid || validation.reason === "unchanged") {
    return null;
  }
  if (validation.reason === "blank") {
    return "Display name is required.";
  }
  return "Display name already exists.";
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
  const [tokenDraft, setTokenDraft] = useState("");
  const configured = Boolean(user.github.personalAccessTokenRedacted);
  const renameValidation = validateRenameWorkspaceUser({ user, displayName, workspaceUsers });
  const renameMessage = validationMessage(renameValidation);
  const trimmedToken = tokenDraft.trim();

  useEffect(() => {
    setDisplayName(user.displayName);
    setTokenDraft("");
  }, [user.displayName, user.id, user.github.personalAccessTokenRedacted]);

  const handleRename = () => {
    const nextUsers = renameWorkspaceUser(workspaceUsers, user.id, displayName);
    updateWorkspaceUserArray(nextUsers, onWorkspaceUsersChange);
  };

  const handleSaveToken = () => {
    const nextUsers = replaceWorkspaceUserGithubPersonalAccessToken(
      workspaceUsers,
      user.id,
      tokenDraft,
    );
    updateWorkspaceUserArray(nextUsers, onWorkspaceUsersChange);
    if (nextUsers) {
      setTokenDraft("");
    }
  };

  const handleClearToken = () => {
    const nextUsers = clearWorkspaceUserGithubPersonalAccessToken(workspaceUsers, user.id);
    updateWorkspaceUserArray(nextUsers, onWorkspaceUsersChange);
    setTokenDraft("");
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

      <form
        className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto_auto]"
        onSubmit={(event) => {
          event.preventDefault();
          if (trimmedToken.length > 0) {
            handleSaveToken();
          }
        }}
      >
        <Input
          size="sm"
          type="password"
          value={tokenDraft}
          autoComplete="off"
          aria-label={`${user.displayName} GitHub personal access token`}
          placeholder={
            configured ? "Replace GitHub personal access token" : "GitHub personal access token"
          }
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
          disabled={!configured && trimmedToken.length === 0}
          onClick={handleClearToken}
        >
          <XIcon className="size-3.5" />
          Clear
        </Button>
      </form>

      <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px] text-muted-foreground">
        <span>Generate a GitHub token at</span>
        <a
          href={GITHUB_PERSONAL_ACCESS_TOKEN_URL}
          target="_blank"
          rel="noreferrer"
          className="inline-flex min-w-0 items-center gap-1 rounded-sm font-mono text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
        >
          <span className="truncate">{GITHUB_PERSONAL_ACCESS_TOKEN_DISPLAY_URL}</span>
          <ExternalLinkIcon className="size-3 shrink-0" aria-hidden />
        </a>
      </p>
    </div>
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
