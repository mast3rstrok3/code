import * as React from "react";
import type { ContextMenuItem, OrchestrationThreadWorkflowRole } from "@t3tools/contracts";
import type { SidebarProjectSortOrder, SidebarThreadSortOrder } from "@t3tools/contracts/settings";
import {
  collectHierarchyPostOrder,
  orderHierarchyPostOrder,
  type HierarchyAccessors,
} from "@t3tools/shared/threadHierarchy";
import {
  getThreadSortTimestamp,
  sortThreads,
  toSortableTimestamp,
  type ThreadSortInput,
} from "../lib/threadSort";
import type { SidebarThreadSummary, Thread } from "../types";
import type { ThreadRouteTarget } from "../threadRoutes";
import { cn } from "../lib/utils";
import { isLatestTurnSettled } from "../session-logic";
import { resolveServerBackedAppStageLabel } from "../branding.logic";

export const THREAD_SELECTION_SAFE_SELECTOR = "[data-thread-item], [data-thread-selection-safe]";
export const THREAD_JUMP_HINT_SHOW_DELAY_MS = 100;
// Visible sidebar rows are prewarmed into the thread-detail cache so opening a
// nearby thread usually reuses an already-hot subscription. Each prewarmed
// thread holds a live, fully hydrated detail subscription (all messages and
// activities, growing as agents work) for as long as the row stays visible,
// so this limit is a direct renderer-heap and server-load multiplier — keep
// it small; cold opens still render instantly from the cached snapshot.
export const SIDEBAR_THREAD_PREWARM_LIMIT = 3;
export type SidebarNewThreadEnvMode = "local" | "worktree";
export const SIDEBAR_THREAD_TREE_MAX_VISUAL_DEPTH = 3;

type SidebarProject = {
  id: string;
  title: string;
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
};

type ScopedSidebarProject = SidebarProject & {
  environmentId: string;
};

type ScopedSidebarThread = ThreadSortInput & {
  environmentId: string;
  projectId: string;
  archivedAt: string | null;
};

type LogicalSidebarProject = SidebarProject & {
  projectKey: string;
  memberProjectRefs: readonly {
    environmentId: string;
    projectId: string;
  }[];
};

export type ThreadTraversalDirection = "previous" | "next";

export async function archiveSelectedThreadEntries<
  TEntry extends { readonly threadKey: string },
  TResult extends { readonly _tag: "Success" | "Failure" },
>(input: {
  entries: readonly TEntry[];
  archive: (entry: TEntry, onArchived: () => void) => Promise<TResult>;
}): Promise<{
  archivedThreadKeys: readonly string[];
  mutationFailure: Extract<TResult, { readonly _tag: "Failure" }> | null;
  followupFailures: readonly Extract<TResult, { readonly _tag: "Failure" }>[];
}> {
  const archivedThreadKeys: string[] = [];
  const followupFailures: Extract<TResult, { readonly _tag: "Failure" }>[] = [];

  for (const entry of input.entries) {
    let didArchive = false;
    const result = await input.archive(entry, () => {
      didArchive = true;
    });
    if (didArchive || result._tag === "Success") {
      archivedThreadKeys.push(entry.threadKey);
    }
    if (result._tag === "Success") continue;
    const failure = result as Extract<TResult, { readonly _tag: "Failure" }>;
    if (didArchive) {
      followupFailures.push(failure);
      continue;
    }
    return { archivedThreadKeys, mutationFailure: failure, followupFailures };
  }

  return { archivedThreadKeys, mutationFailure: null, followupFailures };
}

export function buildMultiSelectThreadContextMenuItems(input: {
  count: number;
  hasRunningThread: boolean;
}): readonly ContextMenuItem<"mark-unread" | "archive" | "delete">[] {
  return [
    { id: "mark-unread", label: `Mark unread (${input.count})` },
    {
      id: "archive",
      label: `Archive (${input.count})`,
      disabled: input.hasRunningThread,
    },
    { id: "delete", label: `Delete (${input.count})`, destructive: true },
  ];
}

export function buildBulkTitleRegenerationContextMenuItem(input: {
  supportedCount: number;
  actionableCount: number;
}): ContextMenuItem<"regenerate-title"> | null {
  if (input.supportedCount === 0) return null;
  if (input.actionableCount === 0) {
    return {
      id: "regenerate-title",
      label: `Regenerating… (${input.supportedCount})`,
      disabled: true,
    };
  }
  return {
    id: "regenerate-title",
    label: `Regenerate titles (${input.actionableCount})`,
  };
}

export interface ThreadStatusPill {
  label:
    | "Working"
    | "Monitoring"
    | "Connecting"
    | "Completed"
    | "Pending Approval"
    | "Awaiting Input"
    | "Plan Ready";
  colorClass: string;
  dotClass: string;
  pulse: boolean;
}

// Rollup order mirrors the per-thread resolver exactly: attention states,
// then active work, then the actionable plan prompt, then passive
// monitoring. A Monitoring sibling must never hide a Plan Ready thread.
const THREAD_STATUS_PRIORITY: Record<ThreadStatusPill["label"], number> = {
  "Pending Approval": 6,
  "Awaiting Input": 5,
  Working: 4,
  Connecting: 4,
  "Plan Ready": 3,
  Monitoring: 2,
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
  | "backgroundLiveness"
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

interface ThreadTreeRowsCoreOptions<TThread> {
  readonly getThreadKey: (thread: TThread) => string;
  readonly getParentThreadKey: (thread: TThread) => string | null;
  /** Global pre-sort. Also fixes the order siblings are emitted in. */
  readonly orderThreads: (threads: readonly TThread[]) => TThread[];
  /** Root ordering, which each sidebar defines differently (v1 rolls the sort
      key up from descendants, v2 deliberately does not — see the wrappers). */
  readonly orderRoots: (
    roots: readonly TThread[],
    context: { readonly childrenByParentKey: ReadonlyMap<string, TThread[]> },
  ) => TThread[];
}

function buildThreadTreeRowsCore<TThread>(
  threads: readonly TThread[],
  options: ThreadTreeRowsCoreOptions<TThread>,
): SidebarThreadTreeRow<TThread>[] {
  const { getParentThreadKey, getThreadKey } = options;
  const sortedThreads = options.orderThreads(threads);
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

  const sortRootThreads = (rootThreads: readonly TThread[]): TThread[] =>
    options.orderRoots(rootThreads, { childrenByParentKey });

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

function resolveDefaultThreadKey(thread: Pick<Thread, "id">): string {
  return String(thread.id);
}

function resolveDefaultParentThreadKey(thread: Pick<Thread, "parentThreadId">): string | null {
  return thread.parentThreadId === null ? null : String(thread.parentThreadId);
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
  const getThreadKey = options?.getThreadKey ?? resolveDefaultThreadKey;
  const getParentThreadKey = options?.getParentThreadKey ?? resolveDefaultParentThreadKey;
  // Memoized across both orderRoots calls (roots pass, then the orphan sweep)
  // so a deep tree resolves each subtree once.
  const treeSortTimestampByThreadKey = new Map<string, number>();

  return buildThreadTreeRowsCore(threads, {
    getThreadKey,
    getParentThreadKey,
    orderThreads: (input) => sortThreads(input, sortOrder),
    // v1 rolls a parent's sort key up to the max of its subtree, so a root
    // rises when any descendant is active.
    orderRoots: (roots, { childrenByParentKey }) => {
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

      return [...roots].sort((left, right) => {
        const timestampDiff =
          resolveTreeSortTimestamp(right, new Set()) - resolveTreeSortTimestamp(left, new Set());
        if (timestampDiff !== 0) {
          return timestampDiff;
        }
        return getThreadKey(right).localeCompare(getThreadKey(left));
      });
    },
  });
}

/** v2's tree: same structure as v1, opposite ordering philosophy.
    Roots keep sortThreadsForSidebarV2's static creation order — deliberately
    NO roll-up, because spawning a sub-thread is activity, and activity must
    never reorder the list. Siblings run ascending instead, so a workflow reads
    in execution order (planning → workers → review) top to bottom.
    With no parent links this reduces exactly to sortThreadsForSidebarV2. */
export function buildSidebarV2ThreadTreeRows<
  TThread extends Pick<Thread, "id" | "parentThreadId"> & { readonly createdAt: string },
>(
  threads: readonly TThread[],
  options?: {
    readonly getThreadKey?: (thread: TThread) => string;
    readonly getParentThreadKey?: (thread: TThread) => string | null;
  },
): SidebarThreadTreeRow<TThread>[] {
  return buildThreadTreeRowsCore(threads, {
    getThreadKey: options?.getThreadKey ?? resolveDefaultThreadKey,
    getParentThreadKey: options?.getParentThreadKey ?? resolveDefaultParentThreadKey,
    orderThreads: (input) =>
      [...input].toSorted(
        (left, right) =>
          parseTimestampMs(left.createdAt) - parseTimestampMs(right.createdAt) ||
          String(left.id).localeCompare(String(right.id)),
      ),
    orderRoots: (roots) => sortThreadsForSidebarV2(roots),
  });
}

/** v2 defaults sub-threads to COLLAPSED, so this takes an expanded set rather
    than v1's collapsed set. Same active-path exception: the open thread and
    every ancestor stay visible regardless, so navigating to a deep child never
    leaves the highlighted row hidden. */
export function selectVisibleSidebarV2TreeRows<TThread>(input: {
  rows: readonly SidebarThreadTreeRow<TThread>[];
  expandedThreadKeys: ReadonlySet<string>;
  activeThreadKey: string | null | undefined;
}): SidebarThreadTreeRow<TThread>[] {
  const rowByKey = new Map(input.rows.map((row) => [row.threadKey, row] as const));
  const activeThreadKey = input.activeThreadKey ?? null;
  const activePathKeys = new Set<string>();
  const activePathGuard = new Set<string>();
  let activeRow = activeThreadKey === null ? null : (rowByKey.get(activeThreadKey) ?? null);
  while (activeRow !== null && !activePathGuard.has(activeRow.threadKey)) {
    activePathGuard.add(activeRow.threadKey);
    activePathKeys.add(activeRow.threadKey);
    activeRow =
      activeRow.parentThreadKey === null ? null : (rowByKey.get(activeRow.parentThreadKey) ?? null);
  }

  const visibleRows: SidebarThreadTreeRow<TThread>[] = [];
  const rowVisibleByThreadKey = new Map<string, boolean>();
  for (const row of input.rows) {
    const parentVisible =
      row.parentThreadKey === null || rowVisibleByThreadKey.get(row.parentThreadKey) === true;
    const parentExpanded =
      row.parentThreadKey === null ||
      input.expandedThreadKeys.has(row.parentThreadKey) ||
      activePathKeys.has(row.threadKey);
    const visible = parentVisible && parentExpanded;
    rowVisibleByThreadKey.set(row.threadKey, visible);
    if (visible) {
      visibleRows.push(row);
    }
  }
  return visibleRows;
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

export function shouldNavigateAfterProjectRemoval(input: {
  routeTarget: ThreadRouteTarget | null;
  projectThreads: readonly {
    environmentId: string;
    id: string;
  }[];
  projectDraftId: string | null;
}): boolean {
  const { projectDraftId, projectThreads, routeTarget } = input;
  if (routeTarget?.kind === "draft") {
    return projectDraftId === routeTarget.draftId;
  }
  if (routeTarget?.kind !== "server") {
    return false;
  }
  return projectThreads.some(
    (thread) =>
      thread.environmentId === routeTarget.threadRef.environmentId &&
      thread.id === routeTarget.threadRef.threadId,
  );
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
    "h-8 w-full translate-x-0 cursor-pointer justify-start rounded-md px-2 text-left text-sm select-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring";

  if (input.isSelected && input.isActive) {
    return cn(
      baseClassName,
      "bg-sidebar-row-active text-sidebar-foreground font-medium hover:bg-sidebar-row-active hover:text-sidebar-foreground",
    );
  }

  if (input.isSelected) {
    return cn(
      baseClassName,
      "bg-sidebar-row-selected text-sidebar-foreground hover:bg-sidebar-row-active hover:text-sidebar-foreground",
    );
  }

  if (input.isActive) {
    return cn(
      baseClassName,
      "bg-sidebar-row-active text-sidebar-foreground font-medium hover:bg-sidebar-row-active hover:text-sidebar-foreground",
    );
  }

  return cn(
    baseClassName,
    "text-sidebar-muted-foreground/80 hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
  );
}

// ── Sidebar thread status model ─────────────────────────────────────
// Five visual states, three colors: color is reserved for "act now"
// (approval), "in motion" (working), and "broken" (failed). Ready is the
// unlabeled resting state — the agent stopped and is waiting on the user,
// whether it finished, asked a question, or proposed a plan.
// Unread completion is tracked separately: it describes whether a ready
// thread needs attention, not what the thread is currently doing.
export type SidebarThreadStatus =
  | "approval"
  | "input"
  | "working"
  | "monitoring"
  | "failed"
  | "ready";

type SidebarThreadStatusInput = Pick<
  SidebarThreadSummary,
  "hasPendingApprovals" | "hasPendingUserInput" | "session" | "backgroundLiveness"
>;
export type SidebarV2StatusInput = SidebarThreadStatusInput;
export type SidebarV2Status = SidebarThreadStatus;

export function resolveSidebarThreadStatus(thread: SidebarThreadStatusInput): SidebarThreadStatus {
  if (thread.hasPendingApprovals) {
    return "approval";
  }
  if (thread.hasPendingUserInput) {
    return "input";
  }
  if (thread.session?.status === "running" || thread.session?.status === "starting") {
    return "working";
  }
  // A failed session outranks lingering background liveness: the user must
  // see the failure, not a stale Working (review finding).
  if (thread.session?.status === "error") {
    return "failed";
  }
  // Background work outlives the turn: fleets read as working; monitoring
  // only when watch loops are the sole live work.
  if (thread.backgroundLiveness === "working") {
    return "working";
  }
  if (thread.backgroundLiveness === "monitoring") {
    return "monitoring";
  }
  return "ready";
}

export const resolveSidebarV2Status = resolveSidebarThreadStatus;

/** NaN-safe Date.parse for sort comparators: a malformed timestamp must not
    poison the whole ordering, so it sinks to the epoch instead. */
export function parseTimestampMs(isoDate: string): number {
  const parsed = Date.parse(isoDate);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** First VALID timestamp wins: `a ?? b` falls through on null, but a present-
    yet-malformed string must also fall through to the next candidate rather
    than sink the row to the epoch. */
export function firstValidTimestampMs(
  ...candidates: ReadonlyArray<string | null | undefined>
): number {
  for (const candidate of candidates) {
    if (candidate == null) continue;
    const parsed = Date.parse(candidate);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return 0;
}

/** String twin of firstValidTimestampMs for callers that need the ISO string
    (display labels, tick anchors) rather than epoch ms. */
export function firstValidTimestamp(
  ...candidates: ReadonlyArray<string | null | undefined>
): string | null {
  for (const candidate of candidates) {
    if (candidate == null) continue;
    if (!Number.isNaN(Date.parse(candidate))) return candidate;
  }
  return null;
}

// Sidebar sort: static creation order, newest thread on top. Activity NEVER
// reorders the list — a row holds its position from open until settled, so
// the screen only moves at lifecycle transitions. Status (including pending
// approval) is carried by each card's edge strip, not by position.
export function sortThreadsForSidebar<
  T extends { readonly id: string; readonly createdAt: string },
>(threads: readonly T[]): T[] {
  return [...threads].toSorted(
    (left, right) =>
      parseTimestampMs(right.createdAt) - parseTimestampMs(left.createdAt) ||
      left.id.localeCompare(right.id),
  );
}

export const sortThreadsForSidebarV2 = sortThreadsForSidebar;

// Pinned-reorder key math and the keyed sort live in client-runtime
// (state/thread-sort) so web and mobile compute identical pinned orders.
export {
  generateSpreadPinOrderKeys,
  pinOrderKeyBetween,
  planPinnedReorder,
} from "@t3tools/client-runtime/state/thread-sort";
export { sortPinnedThreadsByOrderKey as sortPinnedThreadsForSidebar } from "@t3tools/client-runtime/state/thread-sort";

/**
 * Search the already-ordered sidebar thread collection by title only.
 * Keeping the input order means lifecycle ordering (active, snoozed, settled)
 * remains stable while the user narrows the list.
 */
export function searchSidebarThreadsByTitle<T extends { readonly title: string }>(
  threads: readonly T[],
  query: string,
): T[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery.length === 0) return [];
  return threads.filter((thread) => thread.title.toLowerCase().includes(normalizedQuery));
}

type SettledTimestampInput = Pick<
  SidebarThreadSummary,
  "settledAt" | "latestUserMessageAt" | "latestTurn" | "updatedAt"
>;

/** The timestamp a settled row sorts and labels by: settledAt when stamped
    (explicit settles), otherwise last activity — the same candidates
    threadLastActivityAt feeds the auto-settle window (user message plus all
    latestTurn stamps), so a thread whose last activity was a turn completion
    doesn't sort by an older message time. updatedAt is the final net. */
export function resolveSettledTimestamp(thread: SettledTimestampInput): string | null {
  const settledAt = firstValidTimestamp(thread.settledAt);
  if (settledAt !== null) return settledAt;
  let latest: string | null = null;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const candidate of [
    thread.latestUserMessageAt,
    thread.latestTurn?.requestedAt,
    thread.latestTurn?.startedAt,
    thread.latestTurn?.completedAt,
  ]) {
    if (candidate == null) continue;
    const parsed = Date.parse(candidate);
    if (!Number.isNaN(parsed) && parsed > latestMs) {
      latest = candidate;
      latestMs = parsed;
    }
  }
  return latest ?? firstValidTimestamp(thread.updatedAt);
}

// Settled rows are history, so they order by when the work ENDED, not when
// the thread was created or last touched.
export function sortSettledThreadsForSidebar<
  T extends SettledTimestampInput & { readonly id: string },
>(threads: readonly T[]): T[] {
  const timestampMs = (thread: T) => {
    const timestamp = resolveSettledTimestamp(thread);
    return timestamp === null ? 0 : Date.parse(timestamp);
  };
  return [...threads].toSorted(
    (left, right) => timestampMs(right) - timestampMs(left) || left.id.localeCompare(right.id),
  );
}

export type SidebarV2Section = "active" | "snoozed" | "settled";

export interface SidebarV2ThreadGroup<TThread> {
  /** The tree row whose subtree this group is; also its identity. */
  readonly rootThreadKey: string;
  readonly section: SidebarV2Section;
  /** Depth-first, root first. Never split across sections or pages. */
  readonly rows: readonly SidebarThreadTreeRow<TThread>[];
}

/** A workflow is one item, not N rows: the whole subtree lands in a single
    section so its children don't scatter across Active/Snoozed/Settled as they
    finish. A group is active while ANY member is active — a completed root with
    workers still running belongs in the inbox.

    Each thread's OWN classification is returned separately: a settled child
    inside an active group still renders dimmed and still offers un-settle. */
export function partitionSidebarV2ThreadGroups<TThread>(input: {
  rows: readonly SidebarThreadTreeRow<TThread>[];
  classifyThread: (thread: TThread) => SidebarV2Section;
  /** Wake time; the soonest across members orders the snoozed shelf. */
  resolveSnoozeSortMs: (thread: TThread) => number;
  /** When work ended; the latest across members orders the settled tail. */
  resolveSettledSortMs: (thread: TThread) => number;
}): {
  groupsBySection: Record<SidebarV2Section, SidebarV2ThreadGroup<TThread>[]>;
  sectionByThreadKey: ReadonlyMap<string, SidebarV2Section>;
  groupCountBySection: Record<SidebarV2Section, number>;
} {
  const sectionByThreadKey = new Map<string, SidebarV2Section>();
  const rootKeyOrder: string[] = [];
  const rowsByRootKey = new Map<string, SidebarThreadTreeRow<TThread>[]>();
  for (const row of input.rows) {
    sectionByThreadKey.set(row.threadKey, input.classifyThread(row.thread));
    const existing = rowsByRootKey.get(row.rootThreadKey);
    if (existing === undefined) {
      rootKeyOrder.push(row.rootThreadKey);
      rowsByRootKey.set(row.rootThreadKey, [row]);
    } else {
      existing.push(row);
    }
  }

  const groups = rootKeyOrder.map((rootThreadKey) => {
    const rows = rowsByRootKey.get(rootThreadKey) ?? [];
    let hasActive = false;
    let hasSnoozed = false;
    let snoozeSortMs = Number.POSITIVE_INFINITY;
    let settledSortMs = Number.NEGATIVE_INFINITY;
    for (const row of rows) {
      const section = sectionByThreadKey.get(row.threadKey);
      if (section === "active") {
        hasActive = true;
      } else if (section === "snoozed") {
        hasSnoozed = true;
        snoozeSortMs = Math.min(snoozeSortMs, input.resolveSnoozeSortMs(row.thread));
      }
      settledSortMs = Math.max(settledSortMs, input.resolveSettledSortMs(row.thread));
    }
    const section: SidebarV2Section = hasActive ? "active" : hasSnoozed ? "snoozed" : "settled";
    return { group: { rootThreadKey, section, rows }, snoozeSortMs, settledSortMs };
  });

  const groupsBySection: Record<SidebarV2Section, SidebarV2ThreadGroup<TThread>[]> = {
    // Active preserves the tree builder's root order, which is v2's static
    // creation order. Re-sorting here would reintroduce the movement the v2
    // sort exists to prevent.
    active: groups.filter((entry) => entry.group.section === "active").map((entry) => entry.group),
    snoozed: groups
      .filter((entry) => entry.group.section === "snoozed")
      .toSorted(
        (left, right) =>
          left.snoozeSortMs - right.snoozeSortMs ||
          left.group.rootThreadKey.localeCompare(right.group.rootThreadKey),
      )
      .map((entry) => entry.group),
    settled: groups
      .filter((entry) => entry.group.section === "settled")
      .toSorted(
        (left, right) =>
          right.settledSortMs - left.settledSortMs ||
          left.group.rootThreadKey.localeCompare(right.group.rootThreadKey),
      )
      .map((entry) => entry.group),
  };

  return {
    groupsBySection,
    sectionByThreadKey,
    groupCountBySection: {
      active: groupsBySection.active.length,
      snoozed: groupsBySection.snoozed.length,
      settled: groupsBySection.settled.length,
    },
  };
}

export function flattenSidebarV2ThreadGroups<TThread>(
  groups: readonly SidebarV2ThreadGroup<TThread>[],
): SidebarThreadTreeRow<TThread>[] {
  return groups.flatMap((group) => [...group.rows]);
}

export function findSidebarV2ThreadGroupIndex<TThread>(
  groups: readonly SidebarV2ThreadGroup<TThread>[],
  threadKey: string,
): number {
  return groups.findIndex((group) => group.rows.some((row) => row.threadKey === threadKey));
}

export function resolveSidebarV2GroupSettlePlan<TThread>(input: {
  groups: readonly SidebarV2ThreadGroup<TThread>[];
  rootThreadKey: string;
  isSettled: (threadKey: string, thread: TThread) => boolean;
  canSettle: (thread: TThread) => boolean;
}): {
  readonly rows: readonly SidebarThreadTreeRow<TThread>[];
  readonly targetRows: readonly SidebarThreadTreeRow<TThread>[];
  readonly canSettle: boolean;
} | null {
  const group = input.groups.find((entry) => entry.rootThreadKey === input.rootThreadKey);
  if (group === undefined) return null;
  const targetRows = group.rows.filter((row) => !input.isSettled(row.threadKey, row.thread));
  return {
    rows: group.rows,
    targetRows,
    canSettle: targetRows.every((row) => input.canSettle(row.thread)),
  };
}

const SIDEBAR_V2_STATUS_PRIORITY: Record<SidebarV2Status, number> = {
  approval: 5,
  input: 4,
  working: 3,
  monitoring: 3,
  failed: 2,
  ready: 1,
};

/** The status a COLLAPSED group has to surface on its root card. Without this,
    collapsed-by-default would silently bury a child's pending approval. */
export function resolveHighestPrioritySidebarV2Status(
  threads: readonly SidebarV2StatusInput[],
): SidebarV2Status | null {
  let highest: SidebarV2Status | null = null;
  for (const thread of threads) {
    const status = resolveSidebarV2Status(thread);
    if (
      highest === null ||
      SIDEBAR_V2_STATUS_PRIORITY[status] > SIDEBAR_V2_STATUS_PRIORITY[highest]
    ) {
      highest = status;
    }
  }
  return highest;
}

/** Short role label for a nested row, in place of the project title (redundant
    inside a group). Shell-only by design: workflowProgressLabel needs
    planningWorkflow/implementationRuns, which live on the thread DETAIL and are
    not part of OrchestrationThreadShell. Wording mirrors its role arms. */
export function workflowRoleShortLabel(
  role: OrchestrationThreadWorkflowRole | null | undefined,
): string | null {
  switch (role) {
    case "planning-orchestrator":
      return "Planning";
    case "planning-reviewer":
      return "Ticket review";
    case "implementation-orchestrator":
      return "Build";
    case "implementation-worker":
      return "Worker";
    case "implementation-validator":
      return "Merge gate";
    case "implementation-qa-reviewer":
      return "App review";
    case "app-review-orchestrator":
      return "App Review";
    case "app-review-reviewer":
      return "Browser review";
    case "app-review-fixer":
      return "Implement";
    case "implementation-fixer":
    case "product-fix-implementer":
      return "Fix";
    case "implementation-code-reviewer":
      return "Code review";
    case "fast-feature-implementer":
      return "Build";
    default:
      return null;
  }
}

/** The timestamp a working thread's elapsed label counts from: the running
    turn's start (request time until adoption), falling back to the session's
    last transition when the turn projection lags behind. Malformed
    timestamps fall through to the next candidate, not just missing ones. */
export function resolveWorkingStartedAt(
  thread: Pick<SidebarThreadSummary, "latestTurn" | "session">,
): string | null {
  const turn = thread.latestTurn;
  if (turn && turn.completedAt === null) {
    return firstValidTimestamp(turn.startedAt, turn.requestedAt, thread.session?.updatedAt);
  }
  return firstValidTimestamp(thread.session?.updatedAt);
}

export function formatWorkingDurationLabel(elapsedMs: number): string {
  const seconds = Number.isFinite(elapsedMs) ? Math.max(0, Math.floor(elapsedMs / 1000)) : 0;
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
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

  // An actionable plan prompt outranks lingering background work: it needs
  // the user's decision, while liveness merely reports (review finding).
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

  // The turn can settle while native background work runs on. Subagent and
  // workflow fleets read as plain Working; Monitoring is reserved for watch
  // loops (a parent agent babysitting a PR, tailing checks) with no other
  // live work. Same recede treatment as Working per inbox-zero.
  if (thread.backgroundLiveness === "working") {
    return {
      label: "Working",
      colorClass: "text-sky-600 dark:text-sky-300/80",
      dotClass: "bg-sky-500 dark:bg-sky-300/80",
      pulse: true,
    };
  }

  if (thread.backgroundLiveness === "monitoring") {
    return {
      label: "Monitoring",
      colorClass: "text-sky-600 dark:text-sky-300/80",
      dotClass: "bg-sky-500 dark:bg-sky-300/80",
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

export function expandHierarchySelectionIds<TNode, TId>(input: {
  readonly nodes: ReadonlyArray<TNode>;
  readonly selectedIds: ReadonlySet<TId>;
  readonly accessors: HierarchyAccessors<TNode, TId>;
}): Set<TId> {
  const expanded = new Set<TId>();
  for (const selectedId of input.selectedIds) {
    for (const node of collectHierarchyPostOrder(input.nodes, selectedId, input.accessors)) {
      expanded.add(input.accessors.getId(node));
    }
  }
  return expanded;
}

export function getSelectedHierarchyRootIds<TNode, TId>(input: {
  readonly nodes: ReadonlyArray<TNode>;
  readonly selectedIds: ReadonlySet<TId>;
  readonly accessors: HierarchyAccessors<TNode, TId>;
}): TId[] {
  const coveredSelectedIds = new Set<TId>();
  const rootIds = new Set<TId>();
  const parentFirst = orderHierarchyPostOrder(input.nodes, input.accessors).toReversed();

  for (const node of parentFirst) {
    const id = input.accessors.getId(node);
    if (!input.selectedIds.has(id) || coveredSelectedIds.has(id)) continue;
    rootIds.add(id);
    for (const descendant of collectHierarchyPostOrder(input.nodes, id, input.accessors)) {
      const descendantId = input.accessors.getId(descendant);
      if (input.selectedIds.has(descendantId)) coveredSelectedIds.add(descendantId);
    }
  }

  // Preserve selection order between independent roots.
  return [...input.selectedIds].filter((id) => rootIds.has(id));
}

export function getThreadDeleteConfirmationText(title: string): string {
  return [
    `Delete thread "${title}"?`,
    "Any running work in this thread or its sub-threads is canceled.",
    "This permanently clears this thread, all sub-threads, and their conversation history.",
  ].join("\n");
}

export function getMultiThreadDeleteConfirmationText(count: number): string {
  return [
    `Delete ${count} thread${count === 1 ? "" : "s"}?`,
    "Any running work in the selected threads or their descendants is canceled.",
    "This permanently clears the selected threads, all their descendants, and their conversation history.",
  ].join("\n");
}

export function getArchiveConfirmationCopy(hasChildren: boolean): {
  readonly label: string;
  readonly accessibleLabel: string;
  readonly tooltip: string | null;
} {
  return hasChildren
    ? {
        label: "Archive all",
        accessibleLabel: "Archive this thread and all sub-threads",
        tooltip: "Includes all sub-threads",
      }
    : {
        label: "Confirm",
        accessibleLabel: "Confirm archive",
        tooltip: null,
      };
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

function sortProjectsByActivity<TProject extends SidebarProject>(
  projects: readonly TProject[],
  sortOrder: SidebarProjectSortOrder,
  getProjectThreads: (project: TProject) => readonly ThreadSortInput[],
  compareTies: (left: TProject, right: TProject) => number,
): TProject[] {
  if (sortOrder === "manual") {
    return [...projects];
  }

  return [...projects].toSorted((left, right) => {
    const rightTimestamp = getProjectSortTimestamp(right, getProjectThreads(right), sortOrder);
    const leftTimestamp = getProjectSortTimestamp(left, getProjectThreads(left), sortOrder);
    const byTimestamp =
      rightTimestamp === leftTimestamp ? 0 : rightTimestamp > leftTimestamp ? 1 : -1;
    return byTimestamp || compareTies(left, right);
  });
}

export function sortProjectsForSidebar<
  TProject extends SidebarProject,
  TThread extends Pick<Thread, "projectId" | "createdAt" | "updatedAt"> & ThreadSortInput,
>(
  projects: readonly TProject[],
  threads: readonly TThread[],
  sortOrder: SidebarProjectSortOrder,
): TProject[] {
  const threadsByProjectId = new Map<string, TThread[]>();
  for (const thread of threads) {
    const existing = threadsByProjectId.get(thread.projectId) ?? [];
    existing.push(thread);
    threadsByProjectId.set(thread.projectId, existing);
  }

  return sortProjectsByActivity(
    projects,
    sortOrder,
    (project) => threadsByProjectId.get(project.id) ?? [],
    (left, right) => left.title.localeCompare(right.title) || left.id.localeCompare(right.id),
  );
}

export function sortLogicalProjectsForSidebar<
  TProject extends LogicalSidebarProject,
  TThread extends ScopedSidebarThread,
>(
  projects: readonly TProject[],
  threads: readonly TThread[],
  sortOrder: SidebarProjectSortOrder,
): TProject[] {
  const groupKeyByProjectRef = new Map(
    projects.flatMap((project) =>
      project.memberProjectRefs.map(
        (projectRef) =>
          [`${projectRef.environmentId}\0${projectRef.projectId}`, project.projectKey] as const,
      ),
    ),
  );
  const threadsByProjectKey = new Map<string, TThread[]>();
  for (const thread of threads) {
    if (thread.archivedAt !== null) continue;
    const projectKey = groupKeyByProjectRef.get(`${thread.environmentId}\0${thread.projectId}`);
    if (!projectKey) continue;
    const existing = threadsByProjectKey.get(projectKey);
    if (existing) {
      existing.push(thread);
    } else {
      threadsByProjectKey.set(projectKey, [thread]);
    }
  }

  return sortProjectsByActivity(
    projects,
    sortOrder,
    (project) => threadsByProjectKey.get(project.projectKey) ?? [],
    (left, right) =>
      left.title.localeCompare(right.title) || left.projectKey.localeCompare(right.projectKey),
  );
}

/**
 * Sorts the cross-environment project collection used by landing surfaces.
 * Project ids are only unique within an environment, and archived threads
 * must not make a project appear recently active.
 */
export function sortScopedProjectsForSidebar<
  TProject extends ScopedSidebarProject,
  TThread extends ScopedSidebarThread,
>(
  projects: readonly TProject[],
  threads: readonly TThread[],
  sortOrder: SidebarProjectSortOrder,
): TProject[] {
  const scopedKey = (environmentId: string, projectId: string) =>
    `${environmentId}\u0000${projectId}`;
  const threadsByProject = new Map<string, TThread[]>();
  for (const thread of threads) {
    if (thread.archivedAt !== null) {
      continue;
    }
    const key = scopedKey(thread.environmentId, thread.projectId);
    const existing = threadsByProject.get(key) ?? [];
    existing.push(thread);
    threadsByProject.set(key, existing);
  }

  return sortProjectsByActivity(
    projects,
    sortOrder,
    (project) => threadsByProject.get(scopedKey(project.environmentId, project.id)) ?? [],
    (left, right) =>
      left.title.localeCompare(right.title) ||
      left.environmentId.localeCompare(right.environmentId) ||
      left.id.localeCompare(right.id),
  );
}
