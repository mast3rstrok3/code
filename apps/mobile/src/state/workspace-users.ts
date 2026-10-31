import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, WorkspaceUser, WorkspaceUserId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { useCallback, useMemo } from "react";

import type { WorkspaceUserScope } from "../persistence/mobile-preferences";
import {
  resolveWorkspaceUserScope,
  selectWorkspaceUserScope,
  type ResolvedWorkspaceUserScope,
} from "../features/workspace-users/workspaceUserScope";
import { appAtomRegistry } from "./atom-registry";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "./preferences";
import { environmentServerConfigsAtom, serverEnvironment } from "./server";

/** Null until the server's settings arrive. */
export const workspaceUsersAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make(
    (get): ReadonlyArray<WorkspaceUser> | null =>
      get(serverEnvironment.settingsValueAtom(environmentId))?.workspaceUsers ?? null,
  ).pipe(Atom.withLabel(`mobile:workspace-users:${environmentId}`)),
);

const savedWorkspaceUserScopeAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): WorkspaceUserScope | undefined => {
    const preferences = get(mobilePreferencesAtom);
    return AsyncResult.isSuccess(preferences)
      ? preferences.value.workspaceUserScopes?.[environmentId]
      : undefined;
  }).pipe(Atom.withLabel(`mobile:workspace-user-scope:saved:${environmentId}`)),
);

export const workspaceUserScopeAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): ResolvedWorkspaceUserScope =>
    resolveWorkspaceUserScope(
      get(savedWorkspaceUserScopeAtom(environmentId)),
      get(workspaceUsersAtom(environmentId)),
    ),
  ).pipe(Atom.withLabel(`mobile:workspace-user-scope:${environmentId}`)),
);

/** Feeds the shell, which filters projects and threads by owner. */
export const workspaceUserViewAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => get(workspaceUserScopeAtom(environmentId)).view).pipe(
    Atom.withLabel(`mobile:workspace-user-view:${environmentId}`),
  ),
);

export interface EnvironmentWorkspaceUserScope extends ResolvedWorkspaceUserScope {
  readonly environmentId: EnvironmentId;
  readonly users: ReadonlyArray<WorkspaceUser>;
}

/** Every environment whose settings have loaded, for views that span environments. */
const loadedWorkspaceUserScopesAtom = Atom.make((get) => {
  const preferences = get(mobilePreferencesAtom);
  const saved = AsyncResult.isSuccess(preferences)
    ? preferences.value.workspaceUserScopes
    : undefined;
  const scopes: EnvironmentWorkspaceUserScope[] = [];
  for (const [environmentId, config] of get(environmentServerConfigsAtom)) {
    const users = config.settings.workspaceUsers;
    scopes.push({
      environmentId,
      users,
      ...resolveWorkspaceUserScope(saved?.[environmentId], users),
    });
  }
  return scopes;
}).pipe(Atom.withLabel("mobile:workspace-user-scopes"));

export function useLoadedWorkspaceUserScopes(): ReadonlyArray<EnvironmentWorkspaceUserScope> {
  return useAtomValue(loadedWorkspaceUserScopesAtom);
}

/** Environments without loaded settings are absent; callers fall back per environment. */
export function useActingWorkspaceUserIds(): ReadonlyMap<EnvironmentId, WorkspaceUserId> {
  const scopes = useLoadedWorkspaceUserScopes();
  return useMemo(
    () => new Map(scopes.map((scope) => [scope.environmentId, scope.actingUserId])),
    [scopes],
  );
}

/** Read at submit time: the acting user owns what this device creates on the server. */
export function readActingWorkspaceUserId(environmentId: EnvironmentId) {
  return appAtomRegistry.get(workspaceUserScopeAtom(environmentId)).actingUserId;
}

export function useWorkspaceUsers(environmentId: EnvironmentId) {
  return useAtomValue(workspaceUsersAtom(environmentId));
}

export function useSelectWorkspaceUserScope() {
  const updatePreferences = useAtomSet(updateMobilePreferencesAtom);
  return useCallback(
    (environmentId: EnvironmentId, scopeKey: string) =>
      updatePreferences({
        transform: (current) => ({
          workspaceUserScopes: {
            ...current.workspaceUserScopes,
            [environmentId]: selectWorkspaceUserScope(
              current.workspaceUserScopes?.[environmentId],
              scopeKey,
            ),
          },
        }),
      }),
    [updatePreferences],
  );
}
