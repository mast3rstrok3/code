import type {
  OrchestrationSessionStatus,
  OrchestrationThreadWorkflowRole,
  WorkflowPreset,
} from "@t3tools/contracts";

export interface WorkflowModelThread {
  readonly environmentId: string;
  readonly id: string;
  readonly parentThreadId: string | null;
  readonly workflowRole: OrchestrationThreadWorkflowRole | null;
  readonly workflowContext?: {
    readonly workflowId: string;
    readonly parentWorkflowId?: string | null | undefined;
    readonly rootThreadId: string;
  } | null;
  readonly workflowSubagentBatchProvenance?: {
    readonly batchId: string;
  } | null;
  readonly workflowPreset?: WorkflowPreset | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
  readonly settledAt: string | null;
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
  readonly backgroundLiveness?: "working" | "monitoring" | null | undefined;
  readonly latestTurn: {
    readonly state: "running" | "interrupted" | "completed" | "error";
    readonly requestedAt: string;
    readonly startedAt: string | null;
    readonly completedAt: string | null;
  } | null;
  readonly session: {
    readonly status: OrchestrationSessionStatus;
    readonly updatedAt: string;
  } | null;
}

export type WorkflowThreadStatus =
  | "working"
  | "monitoring"
  | "approval"
  | "input"
  | "completed"
  | "failed"
  | "stopped"
  | "archived";

export interface WorkflowTreeRow<TThread extends WorkflowModelThread> {
  readonly thread: TThread;
  readonly depth: number;
  readonly parentThreadKey: string | null;
}

export interface WorkflowGroup<TThread extends WorkflowModelThread> {
  readonly id: string;
  readonly kind: "workflow" | "batch" | "legacy";
  readonly sourceId: string;
  readonly parentGroupId: string | null;
  readonly depth: number;
  readonly createdAt: string;
  readonly preset: WorkflowPreset | null;
  readonly rows: readonly WorkflowTreeRow<TThread>[];
  readonly activeCount: number;
  readonly settledCount: number;
  readonly isActive: boolean;
}

export interface WorkflowRoot<TThread extends WorkflowModelThread> {
  readonly root: TThread;
  readonly members: readonly TThread[];
  readonly groups: readonly WorkflowGroup<TThread>[];
}

export interface WorkflowViewModel<TThread extends WorkflowModelThread> {
  readonly ownerThreadKeyByThreadKey: ReadonlyMap<string, string>;
  readonly rootsByThreadKey: ReadonlyMap<string, WorkflowRoot<TThread>>;
  readonly topLevelThreads: readonly TThread[];
}

export function workflowThreadKey(thread: Pick<WorkflowModelThread, "environmentId" | "id">) {
  return `${thread.environmentId}:${thread.id}`;
}

function timestampMs(value: string): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function resolveWorkflowThreadStatus(thread: WorkflowModelThread): WorkflowThreadStatus {
  if (thread.archivedAt !== null) return "archived";
  if (thread.hasPendingApprovals) return "approval";
  if (thread.hasPendingUserInput) return "input";
  if (thread.session?.status === "running" || thread.session?.status === "starting") {
    return "working";
  }
  if (thread.session?.status === "error" || thread.latestTurn?.state === "error") return "failed";
  if (thread.backgroundLiveness === "working") return "working";
  if (thread.backgroundLiveness === "monitoring") return "monitoring";
  if (
    thread.session?.status === "interrupted" ||
    thread.session?.status === "stopped" ||
    thread.latestTurn?.state === "interrupted"
  ) {
    return "stopped";
  }
  return "completed";
}

export function workflowStatusIsActive(status: WorkflowThreadStatus): boolean {
  return (
    status === "working" || status === "monitoring" || status === "approval" || status === "input"
  );
}

const WORKFLOW_STATUS_PRIORITY: Record<WorkflowThreadStatus, number> = {
  approval: 8,
  input: 7,
  working: 6,
  monitoring: 5,
  failed: 4,
  stopped: 3,
  completed: 2,
  archived: 1,
};

export function resolveWorkflowRollupStatus(
  threads: readonly WorkflowModelThread[],
): WorkflowThreadStatus | null {
  let highest: WorkflowThreadStatus | null = null;
  for (const thread of threads) {
    const status = resolveWorkflowThreadStatus(thread);
    if (highest === null || WORKFLOW_STATUS_PRIORITY[status] > WORKFLOW_STATUS_PRIORITY[highest]) {
      highest = status;
    }
  }
  return highest;
}

export function resolveWorkflowLifecycle<TThread extends WorkflowModelThread>(
  members: readonly TThread[],
  classify: (thread: TThread) => "active" | "snoozed" | "settled",
): "active" | "snoozed" | "settled" {
  let hasSnoozed = false;
  for (const member of members) {
    const lifecycle = classify(member);
    if (lifecycle === "active") return "active";
    if (lifecycle === "snoozed") hasSnoozed = true;
  }
  return hasSnoozed ? "snoozed" : "settled";
}

function resolveOwner<TThread extends WorkflowModelThread>(
  thread: TThread,
  byKey: ReadonlyMap<string, TThread>,
): TThread {
  const contextRootId = thread.workflowContext?.rootThreadId;
  const contextRoot = contextRootId
    ? byKey.get(`${thread.environmentId}:${contextRootId}`)
    : undefined;
  // A nested workflow's rootThreadId identifies its local controller (for
  // example, Dev Review can root at a Fast Feature Build child). Continue up
  // the physical thread ancestry so every nested workflow remains visible from
  // the thread that initiated the complete workflow tree.
  let current = contextRoot ?? thread;
  const path: TThread[] = [];
  const indexByKey = new Map<string, number>();
  while (current.parentThreadId !== null) {
    const currentKey = workflowThreadKey(current);
    const cycleIndex = indexByKey.get(currentKey);
    if (cycleIndex !== undefined) {
      return path.slice(cycleIndex).toSorted((left, right) => left.id.localeCompare(right.id))[0]!;
    }
    indexByKey.set(currentKey, path.length);
    path.push(current);
    const parent = byKey.get(`${current.environmentId}:${current.parentThreadId}`);
    if (!parent || parent === current) break;
    current = parent;
  }
  return current;
}

function resolveLegacyBranchKey<TThread extends WorkflowModelThread>(
  thread: TThread,
  owner: TThread,
  byKey: ReadonlyMap<string, TThread>,
): string {
  let current = thread;
  const visited = new Set<string>();
  while (current.parentThreadId !== null && current.parentThreadId !== owner.id) {
    const currentKey = workflowThreadKey(current);
    if (visited.has(currentKey)) break;
    visited.add(currentKey);
    const parent = byKey.get(`${current.environmentId}:${current.parentThreadId}`);
    if (!parent || parent === current) break;
    current = parent;
  }
  return current.id;
}

function sortOldestFirst<TThread extends WorkflowModelThread>(left: TThread, right: TThread) {
  return (
    timestampMs(left.createdAt) - timestampMs(right.createdAt) || left.id.localeCompare(right.id)
  );
}

function buildGroupRows<TThread extends WorkflowModelThread>(threads: readonly TThread[]) {
  const byKey = new Map(threads.map((thread) => [workflowThreadKey(thread), thread] as const));
  const parentByKey = new Map<string, string | null>();
  for (const thread of threads) {
    const key = workflowThreadKey(thread);
    if (thread.parentThreadId === null || thread.parentThreadId === thread.id) {
      parentByKey.set(key, null);
      continue;
    }
    const parentKey = `${thread.environmentId}:${thread.parentThreadId}`;
    parentByKey.set(key, byKey.has(parentKey) ? parentKey : null);
  }

  // Break every edge participating in a cycle. Orphans and corrupt branches
  // become roots, so the renderer always emits each surviving shell once.
  for (const startKey of byKey.keys()) {
    const path: string[] = [];
    const indexByKey = new Map<string, number>();
    let currentKey: string | null = startKey;
    while (currentKey !== null) {
      const cycleIndex = indexByKey.get(currentKey);
      if (cycleIndex !== undefined) {
        for (const cycleKey of path.slice(cycleIndex)) parentByKey.set(cycleKey, null);
        break;
      }
      indexByKey.set(currentKey, path.length);
      path.push(currentKey);
      currentKey = parentByKey.get(currentKey) ?? null;
    }
  }

  const childrenByParent = new Map<string, TThread[]>();
  for (const thread of threads) {
    const parentKey = parentByKey.get(workflowThreadKey(thread));
    if (parentKey === null || parentKey === undefined) continue;
    const children = childrenByParent.get(parentKey);
    if (children) children.push(thread);
    else childrenByParent.set(parentKey, [thread]);
  }
  for (const children of childrenByParent.values()) children.sort(sortOldestFirst);

  const rows: WorkflowTreeRow<TThread>[] = [];
  const emitted = new Set<string>();
  const emit = (thread: TThread, depth: number) => {
    const key = workflowThreadKey(thread);
    if (emitted.has(key)) return;
    emitted.add(key);
    rows.push({ thread, depth, parentThreadKey: parentByKey.get(key) ?? null });
    for (const child of childrenByParent.get(key) ?? []) emit(child, depth + 1);
  };
  const roots = threads
    .filter((thread) => parentByKey.get(workflowThreadKey(thread)) === null)
    .toSorted(sortOldestFirst);
  for (const root of roots) emit(root, 0);
  for (const thread of [...threads].sort(sortOldestFirst)) emit(thread, 0);
  return rows;
}

export function buildWorkflowViewModel<TThread extends WorkflowModelThread>(
  threads: readonly TThread[],
): WorkflowViewModel<TThread> {
  const byKey = new Map(threads.map((thread) => [workflowThreadKey(thread), thread] as const));
  const ownerThreadKeyByThreadKey = new Map<string, string>();
  const membersByOwnerKey = new Map<string, TThread[]>();

  for (const thread of threads) {
    const owner = resolveOwner(thread, byKey);
    const threadKey = workflowThreadKey(thread);
    const ownerKey = workflowThreadKey(owner);
    ownerThreadKeyByThreadKey.set(threadKey, ownerKey);
    const members = membersByOwnerKey.get(ownerKey);
    if (members) members.push(thread);
    else membersByOwnerKey.set(ownerKey, [thread]);
  }

  const rootsByThreadKey = new Map<string, WorkflowRoot<TThread>>();
  for (const [ownerKey, members] of membersByOwnerKey) {
    const owner = byKey.get(ownerKey);
    if (!owner) continue;
    const descendants = members.filter((thread) => workflowThreadKey(thread) !== ownerKey);
    const grouped = new Map<
      string,
      { kind: WorkflowGroup<TThread>["kind"]; sourceId: string; threads: TThread[] }
    >();
    for (const thread of descendants) {
      const contextId = thread.workflowContext?.workflowId;
      const batchId = thread.workflowSubagentBatchProvenance?.batchId;
      const kind = contextId ? "workflow" : batchId ? "batch" : "legacy";
      const sourceId = contextId ?? batchId ?? resolveLegacyBranchKey(thread, owner, byKey);
      const groupId = `${kind}:${sourceId}`;
      const group = grouped.get(groupId);
      if (group) group.threads.push(thread);
      else grouped.set(groupId, { kind, sourceId, threads: [thread] });
    }

    const groupIdByThreadKey = new Map<string, string>();
    const groupIdByWorkflowId = new Map<string, string>();
    for (const [groupId, group] of grouped) {
      if (group.kind === "workflow") groupIdByWorkflowId.set(group.sourceId, groupId);
      for (const thread of group.threads) {
        groupIdByThreadKey.set(workflowThreadKey(thread), groupId);
      }
    }

    const parentGroupIdById = new Map<string, string | null>();
    for (const [groupId, group] of grouped) {
      const declaredParentWorkflowId = group.threads.find(
        (thread) => thread.workflowContext?.parentWorkflowId != null,
      )?.workflowContext?.parentWorkflowId;
      const declaredParentGroupId =
        declaredParentWorkflowId === undefined || declaredParentWorkflowId === null
          ? undefined
          : groupIdByWorkflowId.get(declaredParentWorkflowId);
      if (declaredParentGroupId !== undefined && declaredParentGroupId !== groupId) {
        parentGroupIdById.set(groupId, declaredParentGroupId);
        continue;
      }
      let parentGroupId: string | null = null;
      for (const thread of [...group.threads].sort(sortOldestFirst)) {
        let parentThreadId = thread.parentThreadId;
        const visited = new Set<string>();
        while (parentThreadId !== null) {
          const parentKey = `${thread.environmentId}:${parentThreadId}`;
          if (visited.has(parentKey)) break;
          visited.add(parentKey);
          const candidateGroupId = groupIdByThreadKey.get(parentKey);
          if (candidateGroupId !== undefined && candidateGroupId !== groupId) {
            parentGroupId = candidateGroupId;
            break;
          }
          const parent = byKey.get(parentKey);
          if (!parent) break;
          parentThreadId = parent.parentThreadId;
        }
        if (parentGroupId !== null) break;
      }
      parentGroupIdById.set(groupId, parentGroupId);
    }

    // Corrupt cross-workflow ancestry must not make the group renderer recurse
    // forever. Break every group edge participating in a cycle, matching the
    // thread-row cycle handling above.
    for (const startId of grouped.keys()) {
      const path: string[] = [];
      const indexById = new Map<string, number>();
      let currentId: string | null = startId;
      while (currentId !== null) {
        const cycleIndex = indexById.get(currentId);
        if (cycleIndex !== undefined) {
          for (const cycleId of path.slice(cycleIndex)) parentGroupIdById.set(cycleId, null);
          break;
        }
        indexById.set(currentId, path.length);
        path.push(currentId);
        currentId = parentGroupIdById.get(currentId) ?? null;
      }
    }

    const depthByGroupId = new Map<string, number>();
    const resolveGroupDepth = (groupId: string): number => {
      const cached = depthByGroupId.get(groupId);
      if (cached !== undefined) return cached;
      const parentGroupId = parentGroupIdById.get(groupId) ?? null;
      const depth = parentGroupId === null ? 0 : resolveGroupDepth(parentGroupId) + 1;
      depthByGroupId.set(groupId, depth);
      return depth;
    };

    const unorderedGroups = [...grouped.entries()].map(([id, group]): WorkflowGroup<TThread> => {
      const rows = buildGroupRows(group.threads);
      const statuses = rows.map((row) => resolveWorkflowThreadStatus(row.thread));
      const activeCount = statuses.filter(workflowStatusIsActive).length;
      return {
        id,
        kind: group.kind,
        sourceId: group.sourceId,
        parentGroupId: parentGroupIdById.get(id) ?? null,
        depth: resolveGroupDepth(id),
        createdAt: group.threads.reduce(
          (earliest, thread) =>
            timestampMs(thread.createdAt) < timestampMs(earliest) ? thread.createdAt : earliest,
          group.threads[0]?.createdAt ?? owner.createdAt,
        ),
        preset:
          group.threads.find((thread) => thread.workflowPreset != null)?.workflowPreset ??
          (group.kind === "workflow" ? owner.workflowPreset : null) ??
          null,
        rows,
        activeCount,
        settledCount: statuses.length - activeCount,
        isActive: activeCount > 0,
      };
    });

    const compareGroups = (left: WorkflowGroup<TThread>, right: WorkflowGroup<TThread>) =>
      timestampMs(left.createdAt) - timestampMs(right.createdAt) || left.id.localeCompare(right.id);
    const childrenByParentId = new Map<string, WorkflowGroup<TThread>[]>();
    for (const group of unorderedGroups) {
      if (group.parentGroupId === null) continue;
      const children = childrenByParentId.get(group.parentGroupId);
      if (children) children.push(group);
      else childrenByParentId.set(group.parentGroupId, [group]);
    }
    for (const children of childrenByParentId.values()) children.sort(compareGroups);

    // Workflow cards follow the generated step tree: a parent run comes first,
    // followed immediately by its sub-workflows in creation order.
    const groups: WorkflowGroup<TThread>[] = [];
    const emittedGroups = new Set<string>();
    const emitGroup = (group: WorkflowGroup<TThread>) => {
      if (emittedGroups.has(group.id)) return;
      emittedGroups.add(group.id);
      groups.push(group);
      for (const child of childrenByParentId.get(group.id) ?? []) emitGroup(child);
    };
    for (const group of unorderedGroups
      .filter((candidate) => candidate.parentGroupId === null)
      .sort(compareGroups)) {
      emitGroup(group);
    }
    for (const group of unorderedGroups.sort(compareGroups)) emitGroup(group);

    rootsByThreadKey.set(ownerKey, { root: owner, members, groups });
  }

  return {
    ownerThreadKeyByThreadKey,
    rootsByThreadKey,
    topLevelThreads: threads.filter((thread) => thread.parentThreadId === null),
  };
}

export function selectWorkflowRootForThread<TThread extends WorkflowModelThread>(
  model: WorkflowViewModel<TThread>,
  thread: Pick<WorkflowModelThread, "environmentId" | "id"> | null | undefined,
): WorkflowRoot<TThread> | null {
  if (!thread) return null;
  const threadKey = workflowThreadKey(thread);
  const ownerKey = model.ownerThreadKeyByThreadKey.get(threadKey) ?? threadKey;
  return model.rootsByThreadKey.get(ownerKey) ?? null;
}
