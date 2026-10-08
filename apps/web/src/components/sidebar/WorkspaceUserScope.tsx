import { useEffect } from "react";
import {
  resolveWorkspaceUserView,
  workspaceUserViewCacheKey,
} from "@t3tools/shared/workspaceUsers";
import {
  useClientSettings,
  usePrimarySettings,
  useUpdateClientSettings,
} from "../../hooks/useSettings";
import { workspaceUserScopePatch } from "../../lib/workspaceUsers";
import { setActiveWorkspaceUserView } from "../../state/shell";
import { Toggle, ToggleGroup } from "../ui/toggle-group";

/** The saved user view, resolved against the users that still exist. */
export function useWorkspaceUserView() {
  const workspaceUsers = usePrimarySettings((settings) => settings.workspaceUsers);
  const savedView = useClientSettings((settings) => settings.activeWorkspaceUserView);
  const view = resolveWorkspaceUserView(savedView, workspaceUsers);
  const user =
    view.kind === "user" ? workspaceUsers.find((candidate) => candidate.id === view.userId) : null;
  return { workspaceUsers, view, user: user ?? null };
}

/** Feeds the saved user view to the shell subscription, which filters projects and threads by owner. */
export function WorkspaceUserViewSync() {
  const { view } = useWorkspaceUserView();
  useEffect(() => {
    setActiveWorkspaceUserView(view);
  }, [view]);
  return null;
}

/** Everyone / per-user segmented control heading the sidebar's project filter. */
export function WorkspaceUserScopeToggle() {
  const { workspaceUsers, view } = useWorkspaceUserView();
  const updateSettings = useUpdateClientSettings();
  return (
    <ToggleGroup
      aria-label="Show threads for"
      className="mx-3 mt-2.5 w-auto *:min-w-0 *:flex-1"
      value={[workspaceUserViewCacheKey(view)]}
      onValueChange={(next) => {
        const scopeKey = next[0];
        if (scopeKey) updateSettings(workspaceUserScopePatch(scopeKey));
      }}
    >
      <Toggle value="all">Everyone</Toggle>
      {workspaceUsers.map((user) => (
        <Toggle key={user.id} value={`user:${user.id}`}>
          <span className="truncate">{user.displayName}</span>
        </Toggle>
      ))}
    </ToggleGroup>
  );
}
