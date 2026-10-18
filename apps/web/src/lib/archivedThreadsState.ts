import { AsyncResult, Atom } from "effect/reactivity";
import { DEFAULT_WORKSPACE_USER_ID } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import {
  type ArchivedSnapshotEntry,
  createArchivedThreadSnapshotsAtomFamily,
  makeArchivedThreadsEnvironmentKey,
} from "@t3tools/client-runtime/state/threads";
import type { EnvironmentId } from "@t3tools/contracts";

import { orchestrationEnvironment } from "../state/orchestration";
import { appAtomRegistry } from "../rpc/atomRegistry";
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
// Reads the active workspace user view itself, so one atom per environment
// follows view changes without re-keying.
function archivedSnapshotAtom(environmentId: EnvironmentId) {
  return archivedSnapshotForEnvironment(environmentId);
}

const archivedSnapshotsAtom = createArchivedThreadSnapshotsAtomFamily({
  getSnapshotAtom: archivedSnapshotAtom,
  labelPrefix: "web:archived-thread-snapshots",
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
  const environmentKey = makeArchivedThreadsEnvironmentKey(environmentIds);
  const result = useAtomValue(archivedSnapshotsAtom(environmentKey));
  const refresh = () => {
    for (const environmentId of environmentIds) {
      appAtomRegistry.refresh(archivedSnapshotAtom(environmentId));
    }
  };

  return {
    ...result,
    refresh,
  };
}
