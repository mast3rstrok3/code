import { AsyncResult, Atom } from "effect/reactivity";
import { DEFAULT_WORKSPACE_USER_ID } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import {
  type ArchivedSnapshotEntry,
  createArchivedThreadSnapshotsAtomFamily,
  makeArchivedThreadsEnvironmentKey,
} from "@t3tools/client-runtime/state/threads";
import { type EnvironmentId, type WorkspaceUserView } from "@t3tools/contracts";
import { useCallback, useMemo } from "react";

import { orchestrationEnvironment } from "../state/orchestration";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useClientSettings, usePrimarySettings } from "../hooks/useSettings";
import { resolveWorkspaceUserView } from "@t3tools/shared/model";
import { activeWorkspaceUserViewAtom } from "../state/shell";

const archivedSnapshotForEnvironment = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => {
    const view = get(activeWorkspaceUserViewAtom);
    return AsyncResult.map(
      get(orchestrationEnvironment.archivedShellSnapshot({ environmentId, input: {} })),
      (snapshot) =>
        view.kind === "all"
          ? snapshot
          : {
              ...snapshot,
              threads: snapshot.threads.filter(
                (thread) => (thread.ownerUserId ?? DEFAULT_WORKSPACE_USER_ID) === view.userId,
              ),
            },
    );
  }),
);
function archivedSnapshotAtom(environmentId: EnvironmentId, _userView?: WorkspaceUserView) {
  return archivedSnapshotForEnvironment(environmentId);
}

const archivedSnapshotsAtom = createArchivedThreadSnapshotsAtomFamily({
  getSnapshotAtom: archivedSnapshotAtom,
  labelPrefix: "web:archived-thread-snapshots",
});

export function refreshArchivedThreadsForEnvironment(environmentId: EnvironmentId): void {
  appAtomRegistry.refresh(
    archivedSnapshotAtom(environmentId, appAtomRegistry.get(activeWorkspaceUserViewAtom)),
  );
}

export function useArchivedThreadSnapshots(environmentIds: ReadonlyArray<EnvironmentId>): {
  readonly snapshots: ReadonlyArray<ArchivedSnapshotEntry>;
  readonly error: string | null;
  readonly isLoading: boolean;
  readonly refresh: () => void;
} {
  const activeWorkspaceUserView = useClientSettings((s) => s.activeWorkspaceUserView);
  const workspaceUsers = usePrimarySettings((s) => s.workspaceUsers);
  const userView = useMemo(
    () => resolveWorkspaceUserView(activeWorkspaceUserView, workspaceUsers),
    [activeWorkspaceUserView, workspaceUsers],
  );
  const environmentKey = useMemo(
    () => makeArchivedThreadsEnvironmentKey(environmentIds),
    [environmentIds, userView],
  );
  const result = useAtomValue(archivedSnapshotsAtom(environmentKey));
  const refresh = useCallback(() => {
    for (const environmentId of environmentIds) {
      appAtomRegistry.refresh(archivedSnapshotAtom(environmentId, userView));
    }
  }, [environmentIds, userView]);

  return {
    ...result,
    refresh,
  };
}
