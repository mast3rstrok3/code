import * as React from "react";
import type { SidebarProjectSortOrder, SidebarThreadSortOrder } from "@t3tools/contracts/settings";
import {
  getThreadSortTimestamp,
  sortThreads,
  toSortableTimestamp,
  type ThreadSortInput,
} from "../lib/threadSort";
import type { SidebarThreadSummary, Thread } from "../types";
import { cn } from "../lib/utils";
import { isLatestTurnSettled } from "../session-logic";
import { resolveServerBackedAppStageLabel } from "../branding.logic";

export const THREAD_SELECTION_SAFE_SELECTOR = "[data-thread-item], [data-thread-selection-safe]";
export const THREAD_JUMP_HINT_SHOW_DELAY_MS = 100;
// Visible sidebar rows are prewarmed into the thread-detail cache so opening a
// nearby thread usually reuses an already-hot subscription.
export const SIDEBAR_THREAD_PREWARM_LIMIT = 10;
export type SidebarNewThreadEnvMode = "local" | "worktree";
export const SIDEBAR_THREAD_TREE_MAX_VISUAL_DEPTH = 3;
type SidebarProject = {
  id: string;
  title: string;
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
};

export type ThreadTraversalDirection = "previous" | "next";

export interface ThreadStatusPill {
  label:
    | "Working"
    | "Connecting"
    | "Completed"
    | "Pending Approval"
    | "Awaiting Input"
    | "Plan Ready";
  colorClass: string;
  dotClass: string;
  pulse: boolean;
}

const THREAD_STATUS_PRIORITY: Record<ThreadStatusPill["label"], number> = {
  "Pending Approval": 5,
  "Awaiting Input": 4,
  Working: 3,
  Connecting: 3,
  "Plan Ready": 2,
  Completed: 1,
};

type ThreadStatusInput = Pick<
  SidebarThreadSummary,
  | "hasActionableProposedPlan"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "interactionMode"
  | "latestTurn"
  | "session"
> & {
  lastVisitedAt?: string | undefined;
};

export interface ThreadJumpHintVisibilityController {
  sync: (shouldShow: boolean) => void;
  dispose: () => void;
}

export interface SidebarThreadTreeRow<TThread> {
  readonly thread: TThread;
  readonly threadKey: string;
  readonly parentThreadKey: string | null;
  readonly rootThreadKey: string;
  readonly depth: number;
  readonly visualDepth: number;
  readonly hasChildren: boolean;
}

export function buildSidebarThreadTreeRows<
  TThread extends Pick<Thread, "id" | "parentThreadId"> & ThreadSortInput,
>(
  threads: readonly TThread[],
  sortOrder: SidebarThreadSortOrder,
  options?: {
    readonly getThreadKey?: (thread: TThread) => string;
    readonly getParentThreadKey?: (thread: TThread) => string | null;
  },
): SidebarThreadTreeRow<TThread>[] {
  const getThreadKey = options?.getThreadKey ?? ((thread: TThread) => String(thread.id));
  const getParentThreadKey =
    options?.getParentThreadKey ??
    ((thread: TThread) => (thread.parentThreadId === null ? null : String(thread.parentThreadId)));
  const sortedThreads = sortThreads(threads, sortOrder);
  const threadByKey = new Map<string, TThread>();
  for (const thread of sortedThreads) {
    threadByKey.set(getThreadKey(thread), thread);
  }

  const parentKeyByThreadKey = new Map<string, string | null>();
  const childrenByParentKey = new Map<string, TThread[]>();
  for (const thread of sortedThreads) {
    const threadKey = getThreadKey(thread);
    const rawParentKey = getParentThreadKey(thread);
    const parentThreadKey =
      rawParentKey !== null && rawParentKey !== threadKey && threadByKey.has(rawParentKey)
        ? rawParentKey
        : null;
    parentKeyByThreadKey.set(threadKey, parentThreadKey);
    if (parentThreadKey !== null) {
      const children = childrenByParentKey.get(parentThreadKey);
      if (children === undefined) {
        childrenByParentKey.set(parentThreadKey, [thread]);
      } else {
        children.push(thread);
      }
    }
  }

  const treeSortTimestampByThreadKey = new Map<string, number>();
  const resolveTreeSortTimestamp = (thread: TThread, ancestry: Set<string>): number => {
    const threadKey = getThreadKey(thread);
    const existing = treeSortTimestampByThreadKey.get(threadKey);
    if (existing !== undefined) {
      return existing;
    }
    if (ancestry.has(threadKey)) {
      return getThreadSortTimestamp(thread, sortOrder);
    }
    const nextAncestry = new Set(ancestry);
    nextAncestry.add(threadKey);
    let timestamp = getThreadSortTimestamp(thread, sortOrder);
    for (const child of childrenByParentKey.get(threadKey) ?? []) {
      timestamp = Math.max(timestamp, resolveTreeSortTimestamp(child, nextAncestry));
    }
    treeSortTimestampByThreadKey.set(threadKey, timestamp);
    return timestamp;
  };

  const sortRootThreads = (rootThreads: readonly TThread[]): TThread[] =>
    [...rootThreads].sort((left, right) => {
      const timestampDiff =
        resolveTreeSortTimestamp(right, new Set()) - resolveTreeSortTimestamp(left, new Set());
      if (timestampDiff !== 0) {
        return timestampDiff;
      }
      return getThreadKey(right).localeCompare(getThreadKey(left));
    });

  const rows: SidebarThreadTreeRow<TThread>[] = [];
  const emitted = new Set<string>();

  const emit = (thread: TThread, rootThreadKey: string, depth: number, ancestry: Set<string>) => {
    const threadKey = getThreadKey(thread);
    if (emitted.has(threadKey) || ancestry.has(threadKey)) {
      return;
    }
    emitted.add(threadKey);
    const nextAncestry = new Set(ancestry);
    nextAncestry.add(threadKey);
    const children = childrenByParentKey.get(threadKey) ?? [];
    rows.push({
      thread,
      threadKey,
      parentThreadKey: parentKeyByThreadKey.get(threadKey) ?? null,
      rootThreadKey,
      depth,
      visualDepth: Math.min(depth, SIDEBAR_THREAD_TREE_MAX_VISUAL_DEPTH),
      hasChildren: children.length > 0,
    });
    for (const child of children) {
      emit(child, rootThreadKey, depth + 1, nextAncestry);
    }
  };

  const roots = sortedThreads.filter(
    (thread) => parentKeyByThreadKey.get(getThreadKey(thread)) === null,
  );
  for (const thread of sortRootThreads(roots)) {
    emit(thread, getThreadKey(thread), 0, new Set());
  }

  for (const thread of sortRootThreads(sortedThreads)) {
    const threadKey = getThreadKey(thread);
    if (!emitted.has(threadKey)) {
      emit(thread, threadKey, 0, new Set());
    }
  }

  return rows;
}

export function selectVisibleSidebarThreadRows<TThread>(input: {
  rows: readonly SidebarThreadTreeRow<TThread>[];
  activeThreadKey: string | null | undefined;
  expanded: boolean;
  previewLimit: number;
  collapsedThreadKeys?: ReadonlySet<string> | undefined;
}): {
  hasHiddenThreads: boolean;
  visibleRows: SidebarThreadTreeRow<TThread>[];
  hiddenRows: SidebarThreadTreeRow<TThread>[];
} {
  const rootThreadKeys: string[] = [];
  for (const row of input.rows) {
    if (row.depth === 0 && !rootThreadKeys.includes(row.rootThreadKey)) {
      rootThreadKeys.push(row.rootThreadKey);
    }
  }

  const activePathKeys = new Set<string>();
  const rowByKey = new Map(input.rows.map((row) => [row.threadKey, row] as const));
  const activeThreadKey = input.activeThreadKey ?? null;
  const selectedActiveRow =
    activeThreadKey === null ? null : (rowByKey.get(activeThreadKey) ?? null);
  let activeRow = selectedActiveRow;
  const activePathGuard = new Set<string>();
  while (activeRow !== null && !activePathGuard.has(activeRow.threadKey)) {
    activePathGuard.add(activeRow.threadKey);
    activePathKeys.add(activeRow.threadKey);
    activeRow =
      activeRow.parentThreadKey === null ? null : (rowByKey.get(activeRow.parentThreadKey) ?? null);
  }

  const applyCollapsedThreadRows = (
    rows: readonly SidebarThreadTreeRow<TThread>[],
  ): SidebarThreadTreeRow<TThread>[] => {
    const collapsedThreadKeys = input.collapsedThreadKeys;
    if (collapsedThreadKeys === undefined || collapsedThreadKeys.size === 0) {
      return [...rows];
    }

    const visibleRows: SidebarThreadTreeRow<TThread>[] = [];
    const rowVisibleByThreadKey = new Map<string, boolean>();
    for (const row of rows) {
      const parentVisible =
        row.parentThreadKey === null || rowVisibleByThreadKey.get(row.parentThreadKey) === true;
      const parentExpanded =
        row.parentThreadKey === null ||
        !collapsedThreadKeys.has(row.parentThreadKey) ||
        activePathKeys.has(row.threadKey);
      const visible = parentVisible && parentExpanded;
      rowVisibleByThreadKey.set(row.threadKey, visible);
      if (visible) {
        visibleRows.push(row);
      }
    }
    return visibleRows;
  };

  if (input.expanded || rootThreadKeys.length <= input.previewLimit) {
    return {
      hasHiddenThreads: false,
      visibleRows: applyCollapsedThreadRows(input.rows),
      hiddenRows: [],
    };
  }

  const visibleRootKeys = new Set(rootThreadKeys.slice(0, Math.max(0, input.previewLimit)));
  if (selectedActiveRow !== null) {
    visibleRootKeys.add(selectedActiveRow.rootThreadKey);
  }

  const visibleRows = applyCollapsedThreadRows(
    input.rows.filter((row) => visibleRootKeys.has(row.rootThreadKey)),
  );
  const hiddenRows = input.rows.filter((row) => !visibleRootKeys.has(row.rootThreadKey));
  return {
    hasHiddenThreads: hiddenRows.length > 0,
    visibleRows,
    hiddenRows,
  };
}

export function resolveSidebarStageBadgeLabel(input: {
  primaryServerVersion: string | null | undefined;
  fallbackStageLabel: string;
}): string {
  return resolveServerBackedAppStageLabel(input);
}

export function createThreadJumpHintVisibilityController(input: {
  delayMs: number;
  onVisibilityChange: (visible: boolean) => void;
  setTimeoutFn?: typeof globalThis.setTimeout;
  clearTimeoutFn?: typeof globalThis.clearTimeout;
}): ThreadJumpHintVisibilityController {
  const setTimeoutFn = input.setTimeoutFn ?? globalThis.setTimeout;
  const clearTimeoutFn = input.clearTimeoutFn ?? globalThis.clearTimeout;
  let isVisible = false;
  let timeoutId: NodeJS.Timeout | null = null;

  const clearPendingShow = () => {
    if (timeoutId === null) {
      return;
    }
    clearTimeoutFn(timeoutId);
    timeoutId = null;
  };

  return {
    sync: (shouldShow) => {
      if (!shouldShow) {
        clearPendingShow();
        if (isVisible) {
          isVisible = false;
          input.onVisibilityChange(false);
        }
        return;
      }

      if (isVisible || timeoutId !== null) {
        return;
      }

      timeoutId = setTimeoutFn(() => {
        timeoutId = null;
        isVisible = true;
        input.onVisibilityChange(true);
      }, input.delayMs);
    },
    dispose: () => {
      clearPendingShow();
    },
  };
}

export function useThreadJumpHintVisibility(): {
  showThreadJumpHints: boolean;
  updateThreadJumpHintsVisibility: (shouldShow: boolean) => void;
} {
  const [showThreadJumpHints, setShowThreadJumpHints] = React.useState(false);
  const controllerRef = React.useRef<ThreadJumpHintVisibilityController | null>(null);

  React.useEffect(() => {
    const controller = createThreadJumpHintVisibilityController({
      delayMs: THREAD_JUMP_HINT_SHOW_DELAY_MS,
      onVisibilityChange: (visible) => {
        setShowThreadJumpHints(visible);
      },
      setTimeoutFn: window.setTimeout.bind(window),
      clearTimeoutFn: window.clearTimeout.bind(window),
    });
    controllerRef.current = controller;

    return () => {
      controller.dispose();
      controllerRef.current = null;
    };
  }, []);

  const updateThreadJumpHintsVisibility = React.useCallback((shouldShow: boolean) => {
    controllerRef.current?.sync(shouldShow);
  }, []);

  return {
    showThreadJumpHints,
    updateThreadJumpHintsVisibility,
  };
}

export function hasUnseenCompletion(thread: ThreadStatusInput): boolean {
  if (!thread.latestTurn?.completedAt) return false;
  const completedAt = Date.parse(thread.latestTurn.completedAt);
  if (Number.isNaN(completedAt)) return false;
  if (!thread.lastVisitedAt) return false;

  const lastVisitedAt = Date.parse(thread.lastVisitedAt);
  if (Number.isNaN(lastVisitedAt)) return true;
  return completedAt > lastVisitedAt;
}

export function shouldClearThreadSelectionOnMouseDown(target: HTMLElement | null): boolean {
  if (target === null) return true;
  return !target.closest(THREAD_SELECTION_SAFE_SELECTOR);
}

// A double-click dispatches two `click` events before `dblclick`: the first has
// `detail === 1`, the second `detail === 2`. The second click must not run the
// row's single-click navigation, otherwise double-click-to-rename would also
// navigate. `MouseEvent.detail` is 0 for synthetic/keyboard activations, which
// still count as a normal single activation.
export function isTrailingDoubleClick(detail: number): boolean {
  return detail > 1;
}

export function resolveSidebarNewThreadEnvMode(input: {
  requestedEnvMode?: SidebarNewThreadEnvMode;
  defaultEnvMode: SidebarNewThreadEnvMode;
}): SidebarNewThreadEnvMode {
  return input.requestedEnvMode ?? input.defaultEnvMode;
}

export function resolveSidebarNewThreadSeedContext(input: {
  projectId: string;
  defaultEnvMode: SidebarNewThreadEnvMode;
  activeThread?: {
    projectId: string;
    branch: string | null;
    worktreePath: string | null;
  } | null;
  activeDraftThread?: {
    projectId: string;
    branch: string | null;
    worktreePath: string | null;
    envMode: SidebarNewThreadEnvMode;
    startFromOrigin: boolean;
  } | null;
}): {
  branch?: string | null;
  worktreePath?: string | null;
  envMode: SidebarNewThreadEnvMode;
  startFromOrigin?: boolean;
} {
  if (input.defaultEnvMode === "worktree") {
    return {
      envMode: "worktree",
    };
  }

  if (input.activeDraftThread?.projectId === input.projectId) {
    return {
      branch: input.activeDraftThread.branch,
      worktreePath: input.activeDraftThread.worktreePath,
      envMode: input.activeDraftThread.envMode,
      startFromOrigin: input.activeDraftThread.startFromOrigin,
    };
  }

  if (input.activeThread?.projectId === input.projectId) {
    return {
      branch: input.activeThread.branch,
      worktreePath: input.activeThread.worktreePath,
      envMode: input.activeThread.worktreePath ? "worktree" : "local",
    };
  }

  return {
    envMode: input.defaultEnvMode,
  };
}

export function orderItemsByPreferredIds<TItem, TId>(input: {
  items: readonly TItem[];
  preferredIds: readonly TId[];
  getId: (item: TItem) => TId;
  getPreferenceIds?: (item: TItem) => readonly TId[];
}): TItem[] {
  const { getId, getPreferenceIds, items, preferredIds } = input;
  if (preferredIds.length === 0) {
    return [...items];
  }

  const indexesByPreferenceId = new Map<TId, number[]>();
  for (const [index, item] of items.entries()) {
    const preferenceIds = getPreferenceIds?.(item) ?? [getId(item)];
    for (const preferenceId of new Set(preferenceIds)) {
      const indexes = indexesByPreferenceId.get(preferenceId);
      if (indexes) {
        indexes.push(index);
      } else {
        indexesByPreferenceId.set(preferenceId, [index]);
      }
    }
  }

  const emittedIndexes = new Set<number>();
  const ordered = preferredIds.flatMap((id) => {
    const index = indexesByPreferenceId
      .get(id)
      ?.find((candidate) => !emittedIndexes.has(candidate));
    if (index === undefined) {
      return [];
    }
    emittedIndexes.add(index);
    return [items[index]!];
  });
  const remaining = items.filter((_, index) => !emittedIndexes.has(index));
  return [...ordered, ...remaining];
}

export function getVisibleSidebarThreadIds<TThreadId>(
  renderedProjects: readonly {
    shouldShowThreadPanel?: boolean;
    renderedThreadIds: readonly TThreadId[];
  }[],
): TThreadId[] {
  return renderedProjects.flatMap((renderedProject) =>
    renderedProject.shouldShowThreadPanel === false ? [] : renderedProject.renderedThreadIds,
  );
}

export function getSidebarThreadIdsToPrewarm<TThreadId>(
  visibleThreadIds: readonly TThreadId[],
  limit = SIDEBAR_THREAD_PREWARM_LIMIT,
): TThreadId[] {
  return visibleThreadIds.slice(0, Math.max(0, limit));
}

export function resolveAdjacentThreadId<T>(input: {
  threadIds: readonly T[];
  currentThreadId: T | null;
  direction: ThreadTraversalDirection;
}): T | null {
  const { currentThreadId, direction, threadIds } = input;

  if (threadIds.length === 0) {
    return null;
  }

  if (currentThreadId === null) {
    return direction === "previous" ? (threadIds.at(-1) ?? null) : (threadIds[0] ?? null);
  }

  const currentIndex = threadIds.indexOf(currentThreadId);
  if (currentIndex === -1) {
    return null;
  }

  if (direction === "previous") {
    return currentIndex > 0 ? (threadIds[currentIndex - 1] ?? null) : null;
  }

  return currentIndex < threadIds.length - 1 ? (threadIds[currentIndex + 1] ?? null) : null;
}

export function isContextMenuPointerDown(input: {
  button: number;
  ctrlKey: boolean;
  isMac: boolean;
}): boolean {
  if (input.button === 2) return true;
  return input.isMac && input.button === 0 && input.ctrlKey;
}

export function resolveThreadRowClassName(input: {
  isActive: boolean;
  isSelected: boolean;
}): string {
  const baseClassName =
    "h-6 w-full translate-x-0 cursor-pointer justify-start px-2 text-left select-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring sm:h-7";

  if (input.isSelected && input.isActive) {
    return cn(
      baseClassName,
      "bg-primary/22 text-foreground font-medium hover:bg-primary/26 hover:text-foreground dark:bg-primary/30 dark:hover:bg-primary/36",
    );
  }

  if (input.isSelected) {
    return cn(
      baseClassName,
      "bg-primary/15 text-foreground hover:bg-primary/19 hover:text-foreground dark:bg-primary/22 dark:hover:bg-primary/28",
    );
  }

  if (input.isActive) {
    return cn(
      baseClassName,
      "bg-accent/85 text-foreground font-medium hover:bg-accent hover:text-foreground dark:bg-accent/55 dark:hover:bg-accent/70",
    );
  }

  return cn(baseClassName, "text-muted-foreground hover:bg-accent hover:text-foreground");
}

export function resolveThreadStatusPill(input: {
  thread: ThreadStatusInput;
}): ThreadStatusPill | null {
  const { thread } = input;

  if (thread.hasPendingApprovals) {
    return {
      label: "Pending Approval",
      colorClass: "text-amber-600 dark:text-amber-300/90",
      dotClass: "bg-amber-500 dark:bg-amber-300/90",
      pulse: false,
    };
  }

  if (thread.hasPendingUserInput) {
    return {
      label: "Awaiting Input",
      colorClass: "text-indigo-600 dark:text-indigo-300/90",
      dotClass: "bg-indigo-500 dark:bg-indigo-300/90",
      pulse: false,
    };
  }

  if (thread.session?.status === "running") {
    return {
      label: "Working",
      colorClass: "text-sky-600 dark:text-sky-300/80",
      dotClass: "bg-sky-500 dark:bg-sky-300/80",
      pulse: true,
    };
  }

  if (thread.session?.status === "starting") {
    return {
      label: "Connecting",
      colorClass: "text-sky-600 dark:text-sky-300/80",
      dotClass: "bg-sky-500 dark:bg-sky-300/80",
      pulse: true,
    };
  }

  const hasPlanReadyPrompt =
    !thread.hasPendingUserInput &&
    thread.interactionMode === "plan" &&
    isLatestTurnSettled(thread.latestTurn, thread.session) &&
    thread.hasActionableProposedPlan;
  if (hasPlanReadyPrompt) {
    return {
      label: "Plan Ready",
      colorClass: "text-violet-600 dark:text-violet-300/90",
      dotClass: "bg-violet-500 dark:bg-violet-300/90",
      pulse: false,
    };
  }

  if (hasUnseenCompletion(thread)) {
    return {
      label: "Completed",
      colorClass: "text-emerald-600 dark:text-emerald-300/90",
      dotClass: "bg-emerald-500 dark:bg-emerald-300/90",
      pulse: false,
    };
  }

  return null;
}

export function resolveProjectStatusIndicator(
  statuses: ReadonlyArray<ThreadStatusPill | null>,
): ThreadStatusPill | null {
  let highestPriorityStatus: ThreadStatusPill | null = null;

  for (const status of statuses) {
    if (status === null) continue;
    if (
      highestPriorityStatus === null ||
      THREAD_STATUS_PRIORITY[status.label] > THREAD_STATUS_PRIORITY[highestPriorityStatus.label]
    ) {
      highestPriorityStatus = status;
    }
  }

  return highestPriorityStatus;
}

export function getVisibleThreadsForProject<T extends Pick<Thread, "id">>(input: {
  threads: readonly T[];
  activeThreadId: T["id"] | undefined;
  isThreadListExpanded: boolean;
  previewLimit: number;
}): {
  hasHiddenThreads: boolean;
  visibleThreads: T[];
  hiddenThreads: T[];
} {
  const { activeThreadId, isThreadListExpanded, previewLimit, threads } = input;
  const hasHiddenThreads = threads.length > previewLimit;

  if (!hasHiddenThreads || isThreadListExpanded) {
    return {
      hasHiddenThreads,
      hiddenThreads: [],
      visibleThreads: [...threads],
    };
  }

  const previewThreads = threads.slice(0, previewLimit);
  if (!activeThreadId || previewThreads.some((thread) => thread.id === activeThreadId)) {
    return {
      hasHiddenThreads: true,
      hiddenThreads: threads.slice(previewLimit),
      visibleThreads: previewThreads,
    };
  }

  const activeThread = threads.find((thread) => thread.id === activeThreadId);
  if (!activeThread) {
    return {
      hasHiddenThreads: true,
      hiddenThreads: threads.slice(previewLimit),
      visibleThreads: previewThreads,
    };
  }

  const visibleThreadIds = new Set([...previewThreads, activeThread].map((thread) => thread.id));

  return {
    hasHiddenThreads: true,
    hiddenThreads: threads.filter((thread) => !visibleThreadIds.has(thread.id)),
    visibleThreads: threads.filter((thread) => visibleThreadIds.has(thread.id)),
  };
}

export function getFallbackThreadIdAfterDelete<
  T extends Pick<Thread, "id" | "projectId" | "createdAt" | "updatedAt"> & ThreadSortInput,
>(input: {
  threads: readonly T[];
  deletedThreadId: T["id"];
  sortOrder: SidebarThreadSortOrder;
  deletedThreadIds?: ReadonlySet<T["id"]>;
}): T["id"] | null {
  const { deletedThreadId, deletedThreadIds, sortOrder, threads } = input;
  const deletedThread = threads.find((thread) => thread.id === deletedThreadId);
  if (!deletedThread) {
    return null;
  }

  return (
    sortThreads(
      threads.filter(
        (thread) =>
          thread.projectId === deletedThread.projectId &&
          thread.id !== deletedThreadId &&
          !deletedThreadIds?.has(thread.id),
      ),
      sortOrder,
    )[0]?.id ?? null
  );
}
export function getProjectSortTimestamp(
  project: SidebarProject,
  projectThreads: readonly ThreadSortInput[],
  sortOrder: Exclude<SidebarProjectSortOrder, "manual">,
): number {
  if (projectThreads.length > 0) {
    return projectThreads.reduce(
      (latest, thread) => Math.max(latest, getThreadSortTimestamp(thread, sortOrder)),
      Number.NEGATIVE_INFINITY,
    );
  }

  if (sortOrder === "created_at") {
    return toSortableTimestamp(project.createdAt) ?? Number.NEGATIVE_INFINITY;
  }
  return toSortableTimestamp(project.updatedAt ?? project.createdAt) ?? Number.NEGATIVE_INFINITY;
}

export function sortProjectsForSidebar<
  TProject extends SidebarProject,
  TThread extends Pick<Thread, "projectId" | "createdAt" | "updatedAt"> & ThreadSortInput,
>(
  projects: readonly TProject[],
  threads: readonly TThread[],
  sortOrder: SidebarProjectSortOrder,
): TProject[] {
  if (sortOrder === "manual") {
    return [...projects];
  }

  const threadsByProjectId = new Map<string, TThread[]>();
  for (const thread of threads) {
    const existing = threadsByProjectId.get(thread.projectId) ?? [];
    existing.push(thread);
    threadsByProjectId.set(thread.projectId, existing);
  }

  return [...projects].toSorted((left, right) => {
    const rightTimestamp = getProjectSortTimestamp(
      right,
      threadsByProjectId.get(right.id) ?? [],
      sortOrder,
    );
    const leftTimestamp = getProjectSortTimestamp(
      left,
      threadsByProjectId.get(left.id) ?? [],
      sortOrder,
    );
    const byTimestamp =
      rightTimestamp === leftTimestamp ? 0 : rightTimestamp > leftTimestamp ? 1 : -1;
    if (byTimestamp !== 0) return byTimestamp;
    return left.title.localeCompare(right.title) || left.id.localeCompare(right.id);
  });
}
