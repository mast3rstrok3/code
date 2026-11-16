import type { EnvironmentId } from "@t3tools/contracts";

import {
  useLoadedWorkspaceUserScopes,
  useSelectWorkspaceUserScope,
} from "../../state/workspace-users";
import { buildWorkspaceUserMenuScopes } from "./workspaceUserMenu";

/** The thread list's "User" submenus and what picking an option does. */
export function useWorkspaceUserMenu(
  environments: ReadonlyArray<{ readonly environmentId: EnvironmentId; readonly label: string }>,
  selectedEnvironmentId: EnvironmentId | null,
) {
  const scopes = useLoadedWorkspaceUserScopes();
  const select = useSelectWorkspaceUserScope();
  return {
    userScopes: buildWorkspaceUserMenuScopes({ scopes, environments, selectedEnvironmentId }),
    onUserScopeChange: select,
  } as const;
}
