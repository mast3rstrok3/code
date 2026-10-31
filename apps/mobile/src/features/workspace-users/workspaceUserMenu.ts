import type { MenuAction } from "@react-native-menu/menu";
import type { EnvironmentId, WorkspaceUser, WorkspaceUserView } from "@t3tools/contracts";
import { workspaceUserViewCacheKey } from "@t3tools/shared/workspaceUsers";

import { workspaceUserScopeIsSelectable } from "./workspaceUserScope";

export interface WorkspaceUserMenuOption {
  /** `all` or `user:<id>`, the keys `workspaceUserScopePatch` reads. */
  readonly key: string;
  readonly title: string;
  readonly selected: boolean;
}

export interface WorkspaceUserMenuScope {
  readonly environmentId: EnvironmentId;
  readonly title: string;
  readonly options: ReadonlyArray<WorkspaceUserMenuOption>;
}

/**
 * One "User" submenu per environment that has people to switch between. Users
 * belong to their server, so with several such environments each gets its own.
 */
export function buildWorkspaceUserMenuScopes(input: {
  readonly scopes: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly users: ReadonlyArray<WorkspaceUser>;
    readonly view: WorkspaceUserView;
  }>;
  readonly environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
  }>;
  readonly selectedEnvironmentId: EnvironmentId | null;
}): WorkspaceUserMenuScope[] {
  const labels = new Map(
    input.environments.map((environment) => [environment.environmentId, environment.label]),
  );
  const visible = input.scopes.filter(
    (scope) =>
      workspaceUserScopeIsSelectable(scope.users) &&
      labels.has(scope.environmentId) &&
      (input.selectedEnvironmentId === null || input.selectedEnvironmentId === scope.environmentId),
  );
  return visible
    .map((scope) => {
      const selectedKey = workspaceUserViewCacheKey(scope.view);
      return {
        environmentId: scope.environmentId,
        title: visible.length === 1 ? "User" : `User · ${labels.get(scope.environmentId)}`,
        options: [
          { key: "all", title: "Everyone", selected: selectedKey === "all" },
          ...scope.users.map((user) => ({
            key: `user:${user.id}`,
            title: user.displayName,
            selected: selectedKey === `user:${user.id}`,
          })),
        ],
      };
    })
    .sort((left, right) => left.title.localeCompare(right.title));
}

/** A view narrowed to one person counts as a customized thread list. */
export function workspaceUserMenuIsCustomized(scopes: ReadonlyArray<WorkspaceUserMenuScope>) {
  return scopes.some(
    (scope) => !scope.options.some((option) => option.key === "all" && option.selected),
  );
}

const ACTION_ID_PREFIX = "workspace-user:";

/** Android menus report a flat action id, so it carries the scope index and option key. */
function workspaceUserMenuActionId(scopeIndex: number, optionKey: string): string {
  return `${ACTION_ID_PREFIX}${scopeIndex}:${optionKey}`;
}

export function workspaceUserMenuActions(
  scopes: ReadonlyArray<WorkspaceUserMenuScope>,
): MenuAction[] {
  return scopes.map((scope, scopeIndex) => ({
    id: workspaceUserMenuActionId(scopeIndex, "menu"),
    title: scope.title,
    subactions: scope.options.map((option) => ({
      id: workspaceUserMenuActionId(scopeIndex, option.key),
      title: option.title,
      state: option.selected ? ("on" as const) : ("off" as const),
    })),
  }));
}

export function parseWorkspaceUserMenuActionId(
  actionId: string,
  scopes: ReadonlyArray<WorkspaceUserMenuScope>,
): { readonly environmentId: EnvironmentId; readonly key: string } | null {
  if (!actionId.startsWith(ACTION_ID_PREFIX)) return null;
  const rest = actionId.slice(ACTION_ID_PREFIX.length);
  const separator = rest.indexOf(":");
  if (separator < 0) return null;
  const scope = scopes[Number(rest.slice(0, separator))];
  const key = rest.slice(separator + 1);
  if (!scope?.options.some((option) => option.key === key)) return null;
  return { environmentId: scope.environmentId, key };
}
