import { useAtomValue } from "@effect/atom-react";
import {
  type ArchivedSnapshotEntry,
  createArchivedThreadSnapshotsAtomFamily,
  makeArchivedThreadsEnvironmentKey,
} from "@t3tools/client-runtime/state/threads";
import { DEFAULT_WORKSPACE_USER_VIEW, type EnvironmentId } from "@t3tools/contracts";
import { isOwnedByWorkspaceUserView } from "@t3tools/shared/workspaceUsers";
import { AsyncResult, Atom } from "effect/reactivity";
import { useMemo } from "react";

import { appAtomRegistry } from "../../state/atom-registry";
import { orchestrationEnvironment } from "../../state/orchestration";
import { workspaceUserViewAtom } from "../../state/workspace-users";

// One unfiltered fetch per environment; switching users filters it locally.
function archivedSourceAtom(environmentId: EnvironmentId) {
  return orchestrationEnvironment.archivedShellSnapshot({
    environmentId,
    input: { userView: DEFAULT_WORKSPACE_USER_VIEW },
  });
}

const archivedSnapshotAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => {
    const view = get(workspaceUserViewAtom(environmentId));
    return AsyncResult.map(get(archivedSourceAtom(environmentId)), (snapshot) =>
      view.kind === "all"
        ? snapshot
        : {
            ...snapshot,
            threads: snapshot.threads.filter((thread) => isOwnedByWorkspaceUserView(thread, view)),
          },
    );
  }),
);

const archivedSnapshotsAtom = createArchivedThreadSnapshotsAtomFamily({
  getSnapshotAtom: archivedSnapshotAtom,
  labelPrefix: "mobile:archived-thread-snapshots",
});

export function refreshArchivedThreadsForEnvironment(environmentId: EnvironmentId): void {
  appAtomRegistry.refresh(archivedSourceAtom(environmentId));
}

export function useArchivedThreadSnapshots(environmentIds: ReadonlyArray<EnvironmentId>): {
  readonly snapshots: ReadonlyArray<ArchivedSnapshotEntry>;
  readonly error: string | null;
  readonly isLoading: boolean;
  readonly refresh: () => void;
} {
  const environmentKey = useMemo(
    () => makeArchivedThreadsEnvironmentKey(environmentIds),
    [environmentIds],
  );
  const result = useAtomValue(archivedSnapshotsAtom(environmentKey));
  const refresh = () => {
    for (const environmentId of environmentIds) {
      appAtomRegistry.refresh(archivedSourceAtom(environmentId));
    }
  };

  return { ...result, refresh };
}
