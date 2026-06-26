import { useAtomValue } from "@effect/atom-react";
import {
  type ArchivedSnapshotEntry,
  createArchivedThreadSnapshotsAtomFamily,
  makeArchivedThreadsEnvironmentKey,
} from "@t3tools/client-runtime/state/threads";
import {
  DEFAULT_WORKSPACE_USER_VIEW,
  type EnvironmentId,
  type WorkspaceUserView,
} from "@t3tools/contracts";
import { useCallback, useMemo } from "react";

import { appAtomRegistry } from "../../state/atom-registry";
import { orchestrationEnvironment } from "../../state/orchestration";

function archivedSnapshotAtom(
  environmentId: EnvironmentId,
  userView: WorkspaceUserView = DEFAULT_WORKSPACE_USER_VIEW,
) {
  return orchestrationEnvironment.archivedShellSnapshot({
    environmentId,
    input: { userView },
  });
}

const archivedSnapshotsAtom = createArchivedThreadSnapshotsAtomFamily({
  getSnapshotAtom: archivedSnapshotAtom,
  labelPrefix: "mobile:archived-thread-snapshots",
});

export function refreshArchivedThreadsForEnvironment(environmentId: EnvironmentId): void {
  appAtomRegistry.refresh(archivedSnapshotAtom(environmentId));
}

export function useArchivedThreadSnapshots(environmentIds: ReadonlyArray<EnvironmentId>): {
  readonly snapshots: ReadonlyArray<ArchivedSnapshotEntry>;
  readonly error: string | null;
  readonly isLoading: boolean;
  readonly refresh: () => void;
} {
  const environmentKey = useMemo(
    () => makeArchivedThreadsEnvironmentKey(environmentIds, DEFAULT_WORKSPACE_USER_VIEW),
    [environmentIds],
  );
  const result = useAtomValue(archivedSnapshotsAtom(environmentKey));
  const refresh = useCallback(() => {
    for (const environmentId of environmentIds) {
      appAtomRegistry.refresh(archivedSnapshotAtom(environmentId, DEFAULT_WORKSPACE_USER_VIEW));
    }
  }, [environmentIds]);

  return { ...result, refresh };
}
