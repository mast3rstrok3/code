import {
  DEFAULT_WORKSPACE_USER_VIEW,
  EnvironmentId,
  type OrchestrationShellSnapshot,
  type WorkspaceUserView,
  WorkspaceUserId,
} from "@t3tools/contracts";
import { workspaceUserViewCacheKey } from "@t3tools/shared/model";
import * as Arr from "effect/Array";
import { pipe } from "effect/Function";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

export interface ArchivedSnapshotEntry {
  readonly environmentId: EnvironmentId;
  readonly snapshot: OrchestrationShellSnapshot;
}

export interface ArchivedThreadSnapshotsState {
  readonly snapshots: ReadonlyArray<ArchivedSnapshotEntry>;
  readonly error: string | null;
  readonly isLoading: boolean;
}

const ARCHIVED_THREADS_ENVIRONMENT_KEY_SEPARATOR = "\u001f";
const ARCHIVED_THREADS_VIEW_KEY_SEPARATOR = "\u001e";
const environmentIdOrder = Order.String as Order.Order<EnvironmentId>;

export function makeArchivedThreadsEnvironmentKey(
  environmentIds: ReadonlyArray<EnvironmentId>,
  userView: WorkspaceUserView = DEFAULT_WORKSPACE_USER_VIEW,
): string {
  const environmentsKey = pipe(
    environmentIds,
    Arr.sort(environmentIdOrder),
    (sortedEnvironmentIds) => sortedEnvironmentIds.join(ARCHIVED_THREADS_ENVIRONMENT_KEY_SEPARATOR),
  );
  return `${workspaceUserViewCacheKey(userView)}${ARCHIVED_THREADS_VIEW_KEY_SEPARATOR}${environmentsKey}`;
}

export function parseArchivedThreadsEnvironmentKey(key: string): ReadonlyArray<EnvironmentId> {
  const environmentsKey = key.includes(ARCHIVED_THREADS_VIEW_KEY_SEPARATOR)
    ? (key.split(ARCHIVED_THREADS_VIEW_KEY_SEPARATOR, 2)[1] ?? "")
    : key;
  if (environmentsKey.length === 0) {
    return [];
  }
  return pipe(
    environmentsKey.split(ARCHIVED_THREADS_ENVIRONMENT_KEY_SEPARATOR),
    Arr.map((environmentId) => EnvironmentId.make(environmentId)),
  );
}

export function parseArchivedThreadsWorkspaceUserViewKey(key: string): WorkspaceUserView {
  if (!key.includes(ARCHIVED_THREADS_VIEW_KEY_SEPARATOR)) {
    return DEFAULT_WORKSPACE_USER_VIEW;
  }
  const viewKey = key.split(ARCHIVED_THREADS_VIEW_KEY_SEPARATOR, 2)[0] ?? "all";
  return viewKey.startsWith("user:")
    ? { kind: "user", userId: WorkspaceUserId.make(viewKey.slice("user:".length)) }
    : DEFAULT_WORKSPACE_USER_VIEW;
}

export function createArchivedThreadSnapshotsAtomFamily<E>(options: {
  readonly getSnapshotAtom: (
    environmentId: EnvironmentId,
    userView: WorkspaceUserView,
  ) => Atom.Atom<AsyncResult.AsyncResult<OrchestrationShellSnapshot, E>>;
  readonly labelPrefix: string;
}) {
  return Atom.family((environmentKey: string) =>
    Atom.make((get): ArchivedThreadSnapshotsState => {
      const snapshots: ArchivedSnapshotEntry[] = [];
      let error: string | null = null;
      let isLoading = false;

      const userView = parseArchivedThreadsWorkspaceUserViewKey(environmentKey);
      for (const environmentId of parseArchivedThreadsEnvironmentKey(environmentKey)) {
        const result = get(options.getSnapshotAtom(environmentId, userView));
        isLoading ||= result.waiting;

        const snapshot = Option.getOrNull(AsyncResult.value(result));
        if (snapshot !== null) {
          snapshots.push({ environmentId, snapshot });
        }

        if (error === null && result._tag === "Failure") {
          error = "Failed to load archived threads.";
        }
      }

      return { snapshots, error, isLoading };
    }).pipe(Atom.withLabel(`${options.labelPrefix}:${environmentKey}`)),
  );
}
