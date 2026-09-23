import { useEffect } from "react";
import { UserRoundIcon } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { WorkspaceUserId } from "@t3tools/contracts";
import {
  resolveWorkspaceUserView,
  workspaceUserViewCacheKey,
} from "@t3tools/shared/workspaceUsers";
import {
  useClientSettings,
  usePrimarySettings,
  useUpdateClientSettings,
} from "../../hooks/useSettings";
import { resolveDefaultThreadOwnerUserId } from "../../lib/workspaceUsers";
import { setActiveWorkspaceUserView } from "../../state/shell";
import { Button } from "../ui/button";
import {
  Menu,
  MenuTrigger,
  MenuPopup,
  MenuGroup,
  MenuGroupLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuItem,
} from "../ui/menu";

export function WorkspaceUserMenu() {
  const workspaceUsers = usePrimarySettings((settings) => settings.workspaceUsers);
  const activeWorkspaceUserId = useClientSettings((settings) => settings.activeWorkspaceUserId);
  const savedView = useClientSettings((settings) => settings.activeWorkspaceUserView);
  const updateSettings = useUpdateClientSettings();
  const navigate = useNavigate();
  const userId = resolveDefaultThreadOwnerUserId({ activeWorkspaceUserId, workspaceUsers });
  const user = workspaceUsers.find((candidate) => candidate.id === userId);
  const view = resolveWorkspaceUserView(savedView, workspaceUsers);
  const viewKey = workspaceUserViewCacheKey(view);

  useEffect(() => {
    setActiveWorkspaceUserView(view);
  }, [view]);

  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            className="relative z-10 ml-auto mr-2 min-w-0 max-w-36"
            aria-label={`Active user: ${user?.displayName ?? userId}`}
          />
        }
      >
        <UserRoundIcon className="size-3.5 shrink-0" />
        <span className="truncate">{user?.displayName ?? userId}</span>
      </MenuTrigger>
      <MenuPopup align="end" className="min-w-56">
        <MenuGroup>
          <MenuGroupLabel>Acting as</MenuGroupLabel>
          <MenuRadioGroup
            value={userId}
            onValueChange={(value) => {
              const nextId = WorkspaceUserId.make(value);
              updateSettings({
                activeWorkspaceUserId: nextId,
                activeWorkspaceUserView: { kind: "user", userId: nextId },
              });
            }}
          >
            {workspaceUsers.map((candidate) => (
              <MenuRadioItem key={candidate.id} value={candidate.id}>
                {candidate.displayName}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
        <MenuSeparator />
        <MenuGroup>
          <MenuGroupLabel>Show threads</MenuGroupLabel>
          <MenuRadioGroup
            value={viewKey}
            onValueChange={(value) =>
              updateSettings({
                activeWorkspaceUserView:
                  value === "all"
                    ? { kind: "all" }
                    : { kind: "user", userId: WorkspaceUserId.make(value.slice(5)) },
              })
            }
          >
            <MenuRadioItem value="all">Everyone</MenuRadioItem>
            {workspaceUsers.map((candidate) => (
              <MenuRadioItem key={candidate.id} value={`user:${candidate.id}`}>
                {candidate.id === userId
                  ? `My threads (${candidate.displayName})`
                  : candidate.displayName}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
        <MenuSeparator />
        <MenuItem onClick={() => void navigate({ to: "/settings/users" })}>Manage users</MenuItem>
      </MenuPopup>
    </Menu>
  );
}
