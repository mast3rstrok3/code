import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  archiveSelectedThreadEntries,
  buildSidebarThreadTreeRows,
  buildSidebarV2ThreadTreeRows,
  buildBulkTitleRegenerationContextMenuItem,
  buildMultiSelectThreadContextMenuItems,
  createThreadJumpHintVisibilityController,
  expandHierarchySelectionIds,
  getArchiveConfirmationCopy,
  getMultiThreadDeleteConfirmationText,
  getSelectedHierarchyRootIds,
  getThreadDeleteConfirmationText,
  getSidebarThreadIdsToPrewarm,
  getVisibleSidebarThreadIds,
  resolveAdjacentThreadId,
  getFallbackThreadIdAfterDelete,
  getVisibleThreadsForProject,
  getProjectSortTimestamp,
  hasUnseenCompletion,
  isContextMenuPointerDown,
  isTrailingDoubleClick,
  orderItemsByPreferredIds,
  partitionSidebarV2ThreadGroups,
  resolveHighestPrioritySidebarV2Status,
  resolveSidebarV2GroupSettlePlan,
  resolveProjectStatusIndicator,
  resolveSidebarStageBadgeLabel,
  resolveThreadRowClassName,
  resolveSidebarThreadStatus,
  resolveThreadStatusPill,
  selectVisibleSidebarThreadRows,
  selectVisibleSidebarV2TreeRows,
  workflowRoleShortLabel,
  resolveWorkingStartedAt,
  searchSidebarThreadsByTitle,
  formatWorkingDurationLabel,
  shouldNavigateAfterProjectRemoval,
  shouldClearThreadSelectionOnMouseDown,
  sortLogicalProjectsForSidebar,
  sortSettledThreadsForSidebar,
  pinOrderKeyBetween,
  planPinnedReorder,
  sortPinnedThreadsForSidebar,
  sortThreadsForSidebar,
  sortThreadsForSidebarV2,
  sortProjectsForSidebar,
  sortScopedProjectsForSidebar,
  THREAD_JUMP_HINT_SHOW_DELAY_MS,
} from "./Sidebar.logic";
import {
  DEFAULT_WORKSPACE_USER_ID,
  EnvironmentId,
  OrchestrationLatestTurn,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";

import {
  DEFAULT_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  type Project,
  type Thread,
} from "../types";

const localEnvironmentId = EnvironmentId.make("environment-local");

describe("shouldNavigateAfterProjectRemoval", () => {
  const projectThreads = [{ environmentId: "environment-local", id: "thread-1" }];

  it("navigates away from a draft route owned by the removed project", () => {
    expect(
      shouldNavigateAfterProjectRemoval({
        routeTarget: { kind: "draft", draftId: "draft-1" as never },
        projectThreads,
        projectDraftId: "draft-1",
      }),
    ).toBe(true);
  });

  it("does not navigate away from a different draft route", () => {
    expect(
      shouldNavigateAfterProjectRemoval({
        routeTarget: { kind: "draft", draftId: "draft-2" as never },
        projectThreads,
        projectDraftId: "draft-1",
      }),
    ).toBe(false);
  });

  it("navigates away from a server thread owned by the removed project", () => {
    expect(
      shouldNavigateAfterProjectRemoval({
        routeTarget: {
          kind: "server",
          threadRef: {
            environmentId: EnvironmentId.make("environment-local"),
            threadId: ThreadId.make("thread-1"),
          },
        },
        projectThreads,
        projectDraftId: null,
      }),
    ).toBe(true);
  });

  it("does not navigate from an unrelated route", () => {
    expect(
      shouldNavigateAfterProjectRemoval({
        routeTarget: null,
        projectThreads,
        projectDraftId: null,
      }),
    ).toBe(false);
  });
});

describe("archiveSelectedThreadEntries", () => {
  const entries = [{ threadKey: "one" }, { threadKey: "two" }, { threadKey: "three" }] as const;
  const success = { _tag: "Success" } as const;
  const failure = { _tag: "Failure" } as const;

  it("records every entry after full success", async () => {
    const outcome = await archiveSelectedThreadEntries({
      entries,
      archive: async (_entry, onArchived) => {
        onArchived();
        return success;
      },
    });

    expect(outcome).toEqual({
      archivedThreadKeys: ["one", "two", "three"],
      mutationFailure: null,
      followupFailures: [],
    });
  });

  it("stops at a mutation failure and retains prior successes", async () => {
    const archive = vi.fn(async (entry: (typeof entries)[number], onArchived: () => void) => {
      if (entry.threadKey === "two") return failure;
      onArchived();
      return success;
    });
    const outcome = await archiveSelectedThreadEntries({ entries, archive });

    expect(archive).toHaveBeenCalledTimes(2);
    expect(outcome).toEqual({
      archivedThreadKeys: ["one"],
      mutationFailure: failure,
      followupFailures: [],
    });
  });

  it("continues after a post-archive failure", async () => {
    const archive = vi.fn(async (entry: (typeof entries)[number], onArchived: () => void) => {
      onArchived();
      return entry.threadKey === "two" ? failure : success;
    });
    const outcome = await archiveSelectedThreadEntries({ entries, archive });

    expect(archive).toHaveBeenCalledTimes(3);
    expect(outcome).toEqual({
      archivedThreadKeys: ["one", "two", "three"],
      mutationFailure: null,
      followupFailures: [failure],
    });
  });
});

describe("buildBulkTitleRegenerationContextMenuItem", () => {
  it("counts only threads that can start a new regeneration", () => {
    expect(
      buildBulkTitleRegenerationContextMenuItem({
        supportedCount: 4,
        actionableCount: 3,
      }),
    ).toEqual({
      id: "regenerate-title",
      label: "Regenerate titles (3)",
    });
  });

  it("shows a disabled progress item when every supported thread is pending", () => {
    expect(
      buildBulkTitleRegenerationContextMenuItem({
        supportedCount: 2,
        actionableCount: 0,
      }),
    ).toEqual({
      id: "regenerate-title",
      label: "Regenerating… (2)",
      disabled: true,
    });
  });

  it("omits the action when no selected environment supports it", () => {
    expect(
      buildBulkTitleRegenerationContextMenuItem({
        supportedCount: 0,
        actionableCount: 0,
      }),
    ).toBeNull();
  });
});

describe("buildMultiSelectThreadContextMenuItems", () => {
  it("offers bulk archive with the selected count", () => {
    expect(
      buildMultiSelectThreadContextMenuItems({ count: 3, hasRunningThread: false }),
    ).toContainEqual({ id: "archive", label: "Archive (3)", disabled: false });
  });

  it("disables bulk archive when a selected thread is running", () => {
    expect(
      buildMultiSelectThreadContextMenuItems({ count: 2, hasRunningThread: true }),
    ).toContainEqual({ id: "archive", label: "Archive (2)", disabled: true });
  });
});

describe("resolveSidebarStageBadgeLabel", () => {
  it("returns Nightly for nightly primary server versions", () => {
    expect(
      resolveSidebarStageBadgeLabel({
        primaryServerVersion: "0.0.28-nightly.20260616.12",
        fallbackStageLabel: "Alpha",
      }),
    ).toBe("Nightly");
  });

  it("returns the fallback label for stable primary server versions", () => {
    expect(
      resolveSidebarStageBadgeLabel({
        primaryServerVersion: "0.0.27",
        fallbackStageLabel: "Alpha",
      }),
    ).toBe("Alpha");
  });

  it("returns the fallback label when the primary server version is missing", () => {
    expect(
      resolveSidebarStageBadgeLabel({
        primaryServerVersion: null,
        fallbackStageLabel: "Dev",
      }),
    ).toBe("Dev");
  });

  it("returns the fallback label for malformed nightly prerelease versions", () => {
    expect(
      resolveSidebarStageBadgeLabel({
        primaryServerVersion: "0.0.28-nightly.20260616",
        fallbackStageLabel: "Alpha",
      }),
    ).toBe("Alpha");
  });
});

function makeLatestTurn(overrides?: {
  completedAt?: string | null;
  startedAt?: string | null;
}): OrchestrationLatestTurn {
  return {
    turnId: "turn-1" as never,
    state: "completed",
    assistantMessageId: null,
    requestedAt: "2026-03-09T10:00:00.000Z",
    startedAt:
      overrides?.startedAt !== undefined ? overrides.startedAt : "2026-03-09T10:00:00.000Z",
    completedAt:
      overrides?.completedAt !== undefined ? overrides.completedAt : "2026-03-09T10:05:00.000Z",
  };
}

describe("hasUnseenCompletion", () => {
  it("returns true when a thread completed after its last visit", () => {
    expect(
      hasUnseenCompletion({
        hasActionableProposedPlan: false,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
        interactionMode: "default",
        latestTurn: makeLatestTurn(),
        lastVisitedAt: "2026-03-09T10:04:00.000Z",
        session: null,
      }),
    ).toBe(true);
  });

  it("treats a missing client visit marker as read", () => {
    expect(
      hasUnseenCompletion({
        hasActionableProposedPlan: false,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
        interactionMode: "default",
        latestTurn: makeLatestTurn(),
        lastVisitedAt: undefined,
        session: null,
      }),
    ).toBe(false);
  });
});

describe("createThreadJumpHintVisibilityController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("delays showing jump hints until the configured delay elapses", () => {
    const visibilityChanges: boolean[] = [];
    const controller = createThreadJumpHintVisibilityController({
      delayMs: THREAD_JUMP_HINT_SHOW_DELAY_MS,
      onVisibilityChange: (visible) => {
        visibilityChanges.push(visible);
      },
    });

    controller.sync(true);
    vi.advanceTimersByTime(THREAD_JUMP_HINT_SHOW_DELAY_MS - 1);

    expect(visibilityChanges).toEqual([]);

    vi.advanceTimersByTime(1);

    expect(visibilityChanges).toEqual([true]);
  });

  it("hides immediately when the modifiers are released", () => {
    const visibilityChanges: boolean[] = [];
    const controller = createThreadJumpHintVisibilityController({
      delayMs: THREAD_JUMP_HINT_SHOW_DELAY_MS,
      onVisibilityChange: (visible) => {
        visibilityChanges.push(visible);
      },
    });

    controller.sync(true);
    vi.advanceTimersByTime(THREAD_JUMP_HINT_SHOW_DELAY_MS);
    controller.sync(false);

    expect(visibilityChanges).toEqual([true, false]);
  });

  it("cancels a pending reveal when the modifier is released early", () => {
    const visibilityChanges: boolean[] = [];
    const controller = createThreadJumpHintVisibilityController({
      delayMs: THREAD_JUMP_HINT_SHOW_DELAY_MS,
      onVisibilityChange: (visible) => {
        visibilityChanges.push(visible);
      },
    });

    controller.sync(true);
    vi.advanceTimersByTime(Math.floor(THREAD_JUMP_HINT_SHOW_DELAY_MS / 2));
    controller.sync(false);
    vi.advanceTimersByTime(THREAD_JUMP_HINT_SHOW_DELAY_MS);

    expect(visibilityChanges).toEqual([]);
  });
});

describe("getSidebarThreadIdsToPrewarm", () => {
  it("returns only the first visible thread ids up to the prewarm limit", () => {
    expect(getSidebarThreadIdsToPrewarm(["t1", "t2", "t3"], 2)).toEqual(["t1", "t2"]);
  });

  it("returns all visible thread ids when they fit within the limit", () => {
    expect(getSidebarThreadIdsToPrewarm(["t1", "t2"], 10)).toEqual(["t1", "t2"]);
  });

  it("returns no thread ids when the limit is zero", () => {
    expect(getSidebarThreadIdsToPrewarm(["t1", "t2"], 0)).toEqual([]);
  });
});

describe("shouldClearThreadSelectionOnMouseDown", () => {
  it("preserves selection for thread items", () => {
    const child = {
      closest: (selector: string) =>
        selector.includes("[data-thread-item]") ? ({} as Element) : null,
    } as unknown as HTMLElement;

    expect(shouldClearThreadSelectionOnMouseDown(child)).toBe(false);
  });

  it("preserves selection for thread list toggle controls", () => {
    const selectionSafe = {
      closest: (selector: string) =>
        selector.includes("[data-thread-selection-safe]") ? ({} as Element) : null,
    } as unknown as HTMLElement;

    expect(shouldClearThreadSelectionOnMouseDown(selectionSafe)).toBe(false);
  });

  it("clears selection for unrelated sidebar clicks", () => {
    const unrelated = {
      closest: () => null,
    } as unknown as HTMLElement;

    expect(shouldClearThreadSelectionOnMouseDown(unrelated)).toBe(true);
  });
});

describe("isTrailingDoubleClick", () => {
  it("treats a single click as a normal activation", () => {
    expect(isTrailingDoubleClick(1)).toBe(false);
  });

  it("treats synthetic/keyboard activations (detail 0) as a normal activation", () => {
    expect(isTrailingDoubleClick(0)).toBe(false);
  });

  it("ignores the second click of a double-click so it does not navigate", () => {
    expect(isTrailingDoubleClick(2)).toBe(true);
  });

  it("ignores further clicks of a triple-click", () => {
    expect(isTrailingDoubleClick(3)).toBe(true);
  });
});

describe("orderItemsByPreferredIds", () => {
  it("keeps preferred ids first, skips stale ids, and preserves the relative order of remaining items", () => {
    const ordered = orderItemsByPreferredIds({
      items: [
        { id: ProjectId.make("project-1"), name: "One" },
        { id: ProjectId.make("project-2"), name: "Two" },
        { id: ProjectId.make("project-3"), name: "Three" },
      ],
      preferredIds: [
        ProjectId.make("project-3"),
        ProjectId.make("project-missing"),
        ProjectId.make("project-1"),
      ],
      getId: (project) => project.id,
    });

    expect(ordered.map((project) => project.id)).toEqual([
      ProjectId.make("project-3"),
      ProjectId.make("project-1"),
      ProjectId.make("project-2"),
    ]);
  });

  it("does not duplicate items when preferred ids repeat", () => {
    const ordered = orderItemsByPreferredIds({
      items: [
        { id: ProjectId.make("project-1"), name: "One" },
        { id: ProjectId.make("project-2"), name: "Two" },
      ],
      preferredIds: [
        ProjectId.make("project-2"),
        ProjectId.make("project-1"),
        ProjectId.make("project-2"),
      ],
      getId: (project) => project.id,
    });

    expect(ordered.map((project) => project.id)).toEqual([
      ProjectId.make("project-2"),
      ProjectId.make("project-1"),
    ]);
  });

  it("honors projectOrder physical keys via getProjectOrderKey", async () => {
    // Regression guard for #1904 / the regression introduced by #2055:
    // `projectOrder` is populated with physical keys (envId + cwd-derived)
    // by the store and by drag-end handlers. Readers must identify projects
    // with the same key format, or manual sort silently snaps back.
    const { getProjectOrderKey } = await import("../logicalProject");
    const projects = [
      {
        environmentId: EnvironmentId.make("environment-local"),
        id: ProjectId.make("id-alpha"),
        workspaceRoot: "/work/alpha",
      },
      {
        environmentId: EnvironmentId.make("environment-local"),
        id: ProjectId.make("id-beta"),
        workspaceRoot: "/work/beta",
      },
      {
        environmentId: EnvironmentId.make("environment-local"),
        id: ProjectId.make("id-gamma"),
        workspaceRoot: "/work/gamma",
      },
    ];
    const ordered = orderItemsByPreferredIds({
      items: projects,
      preferredIds: [getProjectOrderKey(projects[2]!), getProjectOrderKey(projects[0]!)],
      getId: getProjectOrderKey,
    });

    expect(ordered.map((project) => project.workspaceRoot)).toEqual([
      "/work/gamma",
      "/work/alpha",
      "/work/beta",
    ]);
  });

  it("resolves legacy preference aliases without materializing project state", () => {
    const ordered = orderItemsByPreferredIds({
      items: [
        { id: "physical-a", cwd: "/work/a" },
        { id: "physical-b", cwd: "/work/b" },
        { id: "physical-c", cwd: "/work/c" },
      ],
      preferredIds: ["legacy:/work/c", "legacy:/work/a"],
      getId: (project) => project.id,
      getPreferenceIds: (project) => [project.id, `legacy:${project.cwd}`],
    });

    expect(ordered.map((project) => project.id)).toEqual([
      "physical-c",
      "physical-a",
      "physical-b",
    ]);
  });
});

describe("resolveAdjacentThreadId", () => {
  it("resolves adjacent thread ids in ordered sidebar traversal", () => {
    const threads = [
      ThreadId.make("thread-1"),
      ThreadId.make("thread-2"),
      ThreadId.make("thread-3"),
    ];

    expect(
      resolveAdjacentThreadId({
        threadIds: threads,
        currentThreadId: threads[1] ?? null,
        direction: "previous",
      }),
    ).toBe(threads[0]);
    expect(
      resolveAdjacentThreadId({
        threadIds: threads,
        currentThreadId: threads[1] ?? null,
        direction: "next",
      }),
    ).toBe(threads[2]);
    expect(
      resolveAdjacentThreadId({
        threadIds: threads,
        currentThreadId: null,
        direction: "next",
      }),
    ).toBe(threads[0]);
    expect(
      resolveAdjacentThreadId({
        threadIds: threads,
        currentThreadId: null,
        direction: "previous",
      }),
    ).toBe(threads[2]);
    expect(
      resolveAdjacentThreadId({
        threadIds: threads,
        currentThreadId: threads[0] ?? null,
        direction: "previous",
      }),
    ).toBeNull();
  });
});

describe("getVisibleSidebarThreadIds", () => {
  it("returns only the rendered visible thread order across projects", () => {
    expect(
      getVisibleSidebarThreadIds([
        {
          renderedThreadIds: [
            ThreadId.make("thread-12"),
            ThreadId.make("thread-11"),
            ThreadId.make("thread-10"),
          ],
        },
        {
          renderedThreadIds: [ThreadId.make("thread-8"), ThreadId.make("thread-6")],
        },
      ]),
    ).toEqual([
      ThreadId.make("thread-12"),
      ThreadId.make("thread-11"),
      ThreadId.make("thread-10"),
      ThreadId.make("thread-8"),
      ThreadId.make("thread-6"),
    ]);
  });

  it("skips threads from collapsed projects whose thread panels are not shown", () => {
    expect(
      getVisibleSidebarThreadIds([
        {
          shouldShowThreadPanel: false,
          renderedThreadIds: [ThreadId.make("thread-hidden-2"), ThreadId.make("thread-hidden-1")],
        },
        {
          shouldShowThreadPanel: true,
          renderedThreadIds: [ThreadId.make("thread-12"), ThreadId.make("thread-11")],
        },
      ]),
    ).toEqual([ThreadId.make("thread-12"), ThreadId.make("thread-11")]);
  });
});

describe("isContextMenuPointerDown", () => {
  it("treats secondary-button presses as context menu gestures on all platforms", () => {
    expect(
      isContextMenuPointerDown({
        button: 2,
        ctrlKey: false,
        isMac: false,
      }),
    ).toBe(true);
  });

  it("treats ctrl+primary-click as a context menu gesture on macOS", () => {
    expect(
      isContextMenuPointerDown({
        button: 0,
        ctrlKey: true,
        isMac: true,
      }),
    ).toBe(true);
  });

  it("does not treat ctrl+primary-click as a context menu gesture off macOS", () => {
    expect(
      isContextMenuPointerDown({
        button: 0,
        ctrlKey: true,
        isMac: false,
      }),
    ).toBe(false);
  });
});

describe("resolveSidebarThreadStatus", () => {
  const session = {
    threadId: ThreadId.make("thread-1"),
    status: "running" as const,
    providerName: "Codex",
    providerInstanceId: ProviderInstanceId.make("codex"),
    runtimeMode: DEFAULT_RUNTIME_MODE,
    activeTurnId: "turn-1" as never,
    lastError: null,
    updatedAt: "2026-03-09T10:00:00.000Z",
  };

  const idle = { hasPendingApprovals: false, hasPendingUserInput: false };

  it("prioritizes approval over a running session", () => {
    expect(resolveSidebarThreadStatus({ ...idle, hasPendingApprovals: true, session })).toBe(
      "approval",
    );
  });

  it("prioritizes awaiting input over a running session, below approval", () => {
    expect(resolveSidebarThreadStatus({ ...idle, hasPendingUserInput: true, session })).toBe(
      "input",
    );
    expect(
      resolveSidebarThreadStatus({
        ...idle,
        hasPendingApprovals: true,
        hasPendingUserInput: true,
        session,
      }),
    ).toBe("approval");
  });

  it("reports working for running and starting sessions", () => {
    expect(resolveSidebarThreadStatus({ ...idle, session })).toBe("working");
    expect(
      resolveSidebarThreadStatus({
        ...idle,
        session: { ...session, status: "starting" as const },
      }),
    ).toBe("working");
  });

  it("reports a paused workflow as idle, whatever its session row says", () => {
    // The session row can outlive the agent: the provider's last write is lost
    // when the server restarts before it lands, and a stopped workflow would
    // then sit in the sidebar with a spinner nobody can turn off.
    expect(
      resolveSidebarThreadStatus({
        ...idle,
        session,
        workflowPausedAt: "2026-08-19T21:09:10.877Z",
      }),
    ).toBe("ready");
    // A raised hand still outranks the pause: it is addressed to the user.
    expect(
      resolveSidebarThreadStatus({
        ...idle,
        hasPendingApprovals: true,
        session,
        workflowPausedAt: "2026-08-19T21:09:10.877Z",
      }),
    ).toBe("approval");
  });

  it("reports failed only while the session status is error", () => {
    expect(
      resolveSidebarThreadStatus({
        ...idle,
        session: { ...session, status: "error" as const, lastError: "boom" },
      }),
    ).toBe("failed");
    expect(
      resolveSidebarThreadStatus({
        ...idle,
        session: { ...session, status: "stopped" as const, lastError: "persisted" },
      }),
    ).toBe("ready");
    expect(
      resolveSidebarThreadStatus({
        ...idle,
        session: { ...session, status: "ready" as const, lastError: "persisted" },
      }),
    ).toBe("ready");
  });

  it("defaults to ready with no session", () => {
    expect(resolveSidebarThreadStatus({ ...idle, session: null })).toBe("ready");
  });
});

describe("searchSidebarThreadsByTitle", () => {
  const threads = [
    { id: "thread-1", title: "Fix workspace search", project: "Alpha" },
    { id: "thread-2", title: "Review providers", project: "Workspace" },
    { id: "thread-3", title: "WORKTREE cleanup", project: "Beta" },
  ];

  it("matches thread titles case-insensitively and preserves their order", () => {
    expect(searchSidebarThreadsByTitle(threads, "work")).toEqual([threads[0], threads[2]]);
  });

  it("does not match project metadata", () => {
    expect(searchSidebarThreadsByTitle(threads, "workspace")).toEqual([threads[0]]);
  });

  it("returns no results for an empty query", () => {
    expect(searchSidebarThreadsByTitle(threads, "   ")).toEqual([]);
  });
});

describe("sortThreadsForSidebar", () => {
  const sortable = (input: { id: string; createdAt: string }) => ({
    id: input.id,
    createdAt: input.createdAt,
  });

  it("orders by creation time, newest first, ignoring activity", () => {
    const sorted = sortThreadsForSidebar([
      sortable({ id: "oldest", createdAt: "2026-03-09T08:00:00.000Z" }),
      sortable({ id: "newest", createdAt: "2026-03-09T12:00:00.000Z" }),
      sortable({ id: "middle", createdAt: "2026-03-09T10:00:00.000Z" }),
    ]);

    expect(sorted.map((thread) => thread.id)).toEqual(["newest", "middle", "oldest"]);
  });

  it("breaks creation-time ties by id so the order is stable", () => {
    const sorted = sortThreadsForSidebar([
      sortable({ id: "b", createdAt: "2026-03-09T10:00:00.000Z" }),
      sortable({ id: "a", createdAt: "2026-03-09T10:00:00.000Z" }),
    ]);

    expect(sorted.map((thread) => thread.id)).toEqual(["a", "b"]);
  });
});

describe("pinOrderKeyBetween", () => {
  it("produces keys that sort between their bounds", () => {
    const middle = pinOrderKeyBetween(null, null)!;
    const top = pinOrderKeyBetween(null, middle)!;
    const bottom = pinOrderKeyBetween(middle, null)!;
    expect(top < middle).toBe(true);
    expect(middle < bottom).toBe(true);

    const between = pinOrderKeyBetween(top, middle)!;
    expect(top < between && between < middle).toBe(true);
  });

  it("extends into new digits when bounds are adjacent", () => {
    const key = pinOrderKeyBetween("g", "h")!;
    expect("g" < key && key < "h").toBe(true);
  });

  it("stays strictly ordered under repeated top insertion", () => {
    // Every new pin lands at the head of the arranged run; keys must keep
    // sorting before the previous head without ever bottoming out.
    let head: string | null = null;
    const keys: string[] = [];
    for (let i = 0; i < 100; i += 1) {
      const key: string = pinOrderKeyBetween(null, head)!;
      expect(key).not.toBeNull();
      if (head !== null) expect(key < head).toBe(true);
      keys.push(key);
      head = key;
    }
    expect(new Set(keys).size).toBe(100);
  });

  it("stays strictly ordered under repeated middle insertion", () => {
    let low = pinOrderKeyBetween(null, null)!;
    let high = pinOrderKeyBetween(low, null)!;
    for (let i = 0; i < 100; i += 1) {
      const key: string = pinOrderKeyBetween(low, high)!;
      expect(low < key && key < high).toBe(true);
      if (i % 2 === 0) low = key;
      else high = key;
    }
  });

  it("returns null for corrupt or out-of-order bounds instead of throwing", () => {
    expect(pinOrderKeyBetween("z", "a")).toBeNull();
    expect(pinOrderKeyBetween("A!", null)).toBeNull();
    expect(pinOrderKeyBetween(null, "ma")).toBeNull();
    expect(pinOrderKeyBetween("m", "m")).toBeNull();
  });
});

describe("planPinnedReorder", () => {
  it("writes only the moved thread when neighbors are keyed", () => {
    const assignments = planPinnedReorder({
      orderedIds: ["a", "c", "b"],
      keysById: new Map([
        ["a", "f"],
        ["b", "m"],
        ["c", "t"],
      ]),
      movedId: "c",
    });
    expect(assignments).toHaveLength(1);
    expect(assignments[0]!.id).toBe("c");
    expect(assignments[0]!.orderKey > "f" && assignments[0]!.orderKey < "m").toBe(true);
  });

  it("treats list edges as open bounds", () => {
    const assignments = planPinnedReorder({
      orderedIds: ["b", "a"],
      keysById: new Map([
        ["a", "m"],
        ["b", null],
      ]),
      movedId: "b",
    });
    expect(assignments).toHaveLength(1);
    expect(assignments[0]!.orderKey < "m").toBe(true);
  });

  it("materializes keys for the whole section when a neighbor is keyless", () => {
    const assignments = planPinnedReorder({
      orderedIds: ["b", "a", "c"],
      keysById: new Map([
        ["a", null],
        ["b", "m"],
        ["c", null],
      ]),
      movedId: "b",
    });
    expect(assignments.map((entry) => entry.id)).toEqual(["b", "a", "c"]);
    const keys = assignments.map((entry) => entry.orderKey);
    expect([...keys].sort()).toEqual(keys);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("sortPinnedThreadsForSidebar", () => {
  const pinnable = (input: { id: string; createdAt: string; pinOrderKey?: string | null }) => ({
    id: input.id,
    createdAt: input.createdAt,
    pinOrderKey: input.pinOrderKey ?? null,
  });

  it("sorts keyed threads by key ahead of keyless threads in creation order", () => {
    const sorted = sortPinnedThreadsForSidebar([
      pinnable({ id: "keyless-old", createdAt: "2026-03-09T08:00:00.000Z" }),
      pinnable({ id: "second", createdAt: "2026-03-09T09:00:00.000Z", pinOrderKey: "t" }),
      pinnable({ id: "keyless-new", createdAt: "2026-03-09T12:00:00.000Z" }),
      pinnable({ id: "first", createdAt: "2026-03-09T07:00:00.000Z", pinOrderKey: "g" }),
    ]);

    expect(sorted.map((thread) => thread.id)).toEqual([
      "first",
      "second",
      "keyless-new",
      "keyless-old",
    ]);
  });

  it("breaks equal keys by id so raced writes render identically everywhere", () => {
    const sorted = sortPinnedThreadsForSidebar([
      pinnable({ id: "b", createdAt: "2026-03-09T10:00:00.000Z", pinOrderKey: "m" }),
      pinnable({ id: "a", createdAt: "2026-03-09T11:00:00.000Z", pinOrderKey: "m" }),
    ]);

    expect(sorted.map((thread) => thread.id)).toEqual(["a", "b"]);
  });
});

describe("sortSettledThreadsForSidebar", () => {
  const settled = (input: {
    id: string;
    settledAt?: string | null;
    latestUserMessageAt?: string | null;
    latestTurn?: OrchestrationLatestTurn | null;
    updatedAt?: string;
  }) => ({
    id: input.id,
    settledAt: input.settledAt ?? null,
    latestUserMessageAt: input.latestUserMessageAt ?? null,
    latestTurn: input.latestTurn ?? null,
    updatedAt: input.updatedAt ?? "2026-03-09T09:00:00.000Z",
  });

  it("orders by settle time, most recently settled first", () => {
    const sorted = sortSettledThreadsForSidebar([
      settled({
        id: "settled-first",
        settledAt: "2026-03-09T10:00:00.000Z",
        // Created/active later than the other thread: settle time must win.
        latestUserMessageAt: "2026-03-09T09:59:00.000Z",
      }),
      settled({
        id: "settled-last",
        settledAt: "2026-03-09T12:00:00.000Z",
        latestUserMessageAt: "2026-03-09T08:00:00.000Z",
      }),
    ]);

    expect(sorted.map((thread) => thread.id)).toEqual(["settled-last", "settled-first"]);
  });

  it("falls back to last activity for auto-settled threads without a settledAt stamp", () => {
    const sorted = sortSettledThreadsForSidebar([
      settled({ id: "auto-old", latestUserMessageAt: "2026-03-09T08:00:00.000Z" }),
      settled({ id: "explicit", settledAt: "2026-03-09T10:00:00.000Z" }),
      settled({ id: "auto-recent", latestUserMessageAt: "2026-03-09T11:00:00.000Z" }),
    ]);

    expect(sorted.map((thread) => thread.id)).toEqual(["auto-recent", "explicit", "auto-old"]);
  });

  it("counts a turn completion as activity for auto-settled threads", () => {
    // The message came in before the other thread's, but its turn finished
    // after: completion time is the real "work ended" moment.
    const sorted = sortSettledThreadsForSidebar([
      settled({ id: "message-only", latestUserMessageAt: "2026-03-09T10:04:00.000Z" }),
      settled({
        id: "completed-later",
        latestUserMessageAt: "2026-03-09T10:00:00.000Z",
        latestTurn: makeLatestTurn({ completedAt: "2026-03-09T10:30:00.000Z" }),
      }),
    ]);

    expect(sorted.map((thread) => thread.id)).toEqual(["completed-later", "message-only"]);
  });

  it("breaks timestamp ties by id so the order is stable", () => {
    const sorted = sortSettledThreadsForSidebar([
      settled({ id: "b", settledAt: "2026-03-09T10:00:00.000Z" }),
      settled({ id: "a", settledAt: "2026-03-09T10:00:00.000Z" }),
    ]);

    expect(sorted.map((thread) => thread.id)).toEqual(["a", "b"]);
  });
});

describe("resolveWorkingStartedAt", () => {
  const session = {
    threadId: ThreadId.make("thread-1"),
    status: "running" as const,
    providerName: "Codex",
    providerInstanceId: ProviderInstanceId.make("codex"),
    runtimeMode: DEFAULT_RUNTIME_MODE,
    activeTurnId: "turn-1" as never,
    lastError: null,
    updatedAt: "2026-03-09T10:02:00.000Z",
  };

  it("uses the running turn's start time", () => {
    expect(
      resolveWorkingStartedAt({
        latestTurn: makeLatestTurn({ completedAt: null }),
        session,
      }),
    ).toBe("2026-03-09T10:00:00.000Z");
  });

  it("uses the request time while a turn awaits adoption", () => {
    expect(
      resolveWorkingStartedAt({
        latestTurn: makeLatestTurn({ startedAt: null, completedAt: null }),
        session,
      }),
    ).toBe("2026-03-09T10:00:00.000Z");
  });

  it("falls back to the session transition when the latest turn already completed", () => {
    expect(
      resolveWorkingStartedAt({
        latestTurn: makeLatestTurn(),
        session,
      }),
    ).toBe("2026-03-09T10:02:00.000Z");
  });

  it("skips a malformed startedAt instead of returning it", () => {
    expect(
      resolveWorkingStartedAt({
        latestTurn: makeLatestTurn({ startedAt: "not-a-date", completedAt: null }),
        session,
      }),
    ).toBe("2026-03-09T10:00:00.000Z");
  });

  it("returns null with neither a running turn nor a session", () => {
    expect(resolveWorkingStartedAt({ latestTurn: null, session: null })).toBeNull();
  });
});

describe("formatWorkingDurationLabel", () => {
  it("formats seconds, minutes, and hours", () => {
    expect(formatWorkingDurationLabel(0)).toBe("0s");
    expect(formatWorkingDurationLabel(42_000)).toBe("42s");
    expect(formatWorkingDurationLabel(5 * 60_000)).toBe("5m");
    expect(formatWorkingDurationLabel(90 * 60_000)).toBe("1h 30m");
  });

  it("clamps negative and non-finite elapsed values to zero", () => {
    expect(formatWorkingDurationLabel(-5_000)).toBe("0s");
    expect(formatWorkingDurationLabel(Number.NaN)).toBe("0s");
  });
});

describe("resolveThreadStatusPill", () => {
  const baseThread = {
    hasActionableProposedPlan: false,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    interactionMode: "plan" as const,
    latestTurn: null,
    lastVisitedAt: undefined,
    session: {
      threadId: ThreadId.make("thread-1"),
      status: "running" as const,
      providerName: "Codex",
      providerInstanceId: ProviderInstanceId.make("codex"),
      runtimeMode: DEFAULT_RUNTIME_MODE,
      activeTurnId: "turn-1" as never,
      lastError: null,
      updatedAt: "2026-03-09T10:00:00.000Z",
    },
  };

  it("shows pending approval before all other statuses", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          hasPendingApprovals: true,
          hasPendingUserInput: true,
        },
      }),
    ).toMatchObject({ label: "Pending Approval", pulse: false });
  });

  it("shows awaiting input when plan mode is blocked on user answers", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          hasPendingUserInput: true,
        },
      }),
    ).toMatchObject({ label: "Awaiting Input", pulse: false });
  });

  it("falls back to working when the thread is actively running without blockers", () => {
    expect(
      resolveThreadStatusPill({
        thread: baseThread,
      }),
    ).toMatchObject({ label: "Working", pulse: true });
  });

  it("shows plan ready when a settled plan turn has a proposed plan ready for follow-up", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          hasActionableProposedPlan: true,
          latestTurn: makeLatestTurn(),
          session: {
            ...baseThread.session,
            status: "ready",
            activeTurnId: null,
          },
        },
      }),
    ).toMatchObject({ label: "Plan Ready", pulse: false });
  });

  it("does not manufacture completed state without a client visit marker", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          latestTurn: makeLatestTurn(),
          session: {
            ...baseThread.session,
            status: "ready",
            activeTurnId: null,
          },
        },
      }),
    ).toBeNull();
  });

  it("shows completed when there is an unseen completion and no active blocker", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          interactionMode: "default",
          latestTurn: makeLatestTurn(),
          lastVisitedAt: "2026-03-09T10:04:00.000Z",
          session: {
            ...baseThread.session,
            status: "ready",
            activeTurnId: null,
          },
        },
      }),
    ).toMatchObject({ label: "Completed", pulse: false });
  });
});

describe("resolveThreadRowClassName", () => {
  it("uses the active sidebar surface when a thread is both selected and active", () => {
    const className = resolveThreadRowClassName({ isActive: true, isSelected: true });
    expect(className).toContain("bg-sidebar-row-active");
    expect(className).toContain("text-sidebar-foreground");
    expect(className).not.toContain("bg-primary");
  });

  it("uses selected hover colors for selected threads", () => {
    const className = resolveThreadRowClassName({ isActive: false, isSelected: true });
    expect(className).toContain("bg-sidebar-row-selected");
    expect(className).toContain("hover:bg-sidebar-row-active");
    expect(className).not.toContain("bg-primary");
  });

  it("uses the active sidebar surface for active-only threads", () => {
    const className = resolveThreadRowClassName({ isActive: true, isSelected: false });
    expect(className).toContain("bg-sidebar-row-active");
    expect(className).toContain("hover:bg-sidebar-row-active");
  });
});

describe("resolveProjectStatusIndicator", () => {
  it("returns null when no threads have a notable status", () => {
    expect(resolveProjectStatusIndicator([null, null])).toBeNull();
  });

  it("surfaces the highest-priority actionable state across project threads", () => {
    expect(
      resolveProjectStatusIndicator([
        {
          label: "Completed",
          colorClass: "text-emerald-600",
          dotClass: "bg-emerald-500",
          pulse: false,
        },
        {
          label: "Pending Approval",
          colorClass: "text-amber-600",
          dotClass: "bg-amber-500",
          pulse: false,
        },
        {
          label: "Working",
          colorClass: "text-sky-600",
          dotClass: "bg-sky-500",
          pulse: true,
        },
      ]),
    ).toMatchObject({ label: "Pending Approval", dotClass: "bg-amber-500" });
  });

  it("prefers plan-ready over completed when no stronger action is needed", () => {
    expect(
      resolveProjectStatusIndicator([
        {
          label: "Completed",
          colorClass: "text-emerald-600",
          dotClass: "bg-emerald-500",
          pulse: false,
        },
        {
          label: "Plan Ready",
          colorClass: "text-violet-600",
          dotClass: "bg-violet-500",
          pulse: false,
        },
      ]),
    ).toMatchObject({ label: "Plan Ready", dotClass: "bg-violet-500" });
  });
});

describe("getVisibleThreadsForProject", () => {
  it("includes the active thread even when it falls below the folded preview", () => {
    const threads = Array.from({ length: 8 }, (_, index) =>
      makeThread({
        id: ThreadId.make(`thread-${index + 1}`),
        title: `Thread ${index + 1}`,
      }),
    );

    const result = getVisibleThreadsForProject({
      threads,
      activeThreadId: ThreadId.make("thread-8"),
      isThreadListExpanded: false,
      previewLimit: 6,
    });

    expect(result.hasHiddenThreads).toBe(true);
    expect(result.visibleThreads.map((thread) => thread.id)).toEqual([
      ThreadId.make("thread-1"),
      ThreadId.make("thread-2"),
      ThreadId.make("thread-3"),
      ThreadId.make("thread-4"),
      ThreadId.make("thread-5"),
      ThreadId.make("thread-6"),
      ThreadId.make("thread-8"),
    ]);
    expect(result.hiddenThreads.map((thread) => thread.id)).toEqual([ThreadId.make("thread-7")]);
  });

  it("returns all threads when the list is expanded", () => {
    const threads = Array.from({ length: 8 }, (_, index) =>
      makeThread({
        id: ThreadId.make(`thread-${index + 1}`),
      }),
    );

    const result = getVisibleThreadsForProject({
      threads,
      activeThreadId: ThreadId.make("thread-8"),
      isThreadListExpanded: true,
      previewLimit: 6,
    });

    expect(result.hasHiddenThreads).toBe(true);
    expect(result.visibleThreads.map((thread) => thread.id)).toEqual(
      threads.map((thread) => thread.id),
    );
    expect(result.hiddenThreads).toEqual([]);
  });
});

describe("sidebar thread tree rows", () => {
  it("renders child threads immediately under their parent instead of global sort position", () => {
    const parent = makeThread({
      id: ThreadId.make("thread-parent"),
      title: "Parent",
      updatedAt: "2026-03-09T10:00:00.000Z",
    });
    const child = makeThread({
      id: ThreadId.make("thread-child"),
      parentThreadId: ThreadId.make("thread-parent"),
      title: "Child",
      updatedAt: "2026-03-09T12:00:00.000Z",
    });
    const sibling = makeThread({
      id: ThreadId.make("thread-sibling"),
      title: "Sibling",
      updatedAt: "2026-03-09T09:00:00.000Z",
    });

    const rows = buildSidebarThreadTreeRows([sibling, child, parent], "updated_at");

    expect(rows.map((row) => row.thread.id)).toEqual([
      ThreadId.make("thread-parent"),
      ThreadId.make("thread-child"),
      ThreadId.make("thread-sibling"),
    ]);
    expect(rows.map((row) => row.depth)).toEqual([0, 1, 0]);
  });

  it("keeps descendants visible when their root is inside the folded preview", () => {
    const rows = buildSidebarThreadTreeRows(
      [
        makeThread({
          id: ThreadId.make("thread-parent"),
          updatedAt: "2026-03-09T12:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.make("thread-child"),
          parentThreadId: ThreadId.make("thread-parent"),
          updatedAt: "2026-03-09T11:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.make("thread-other"),
          updatedAt: "2026-03-09T10:00:00.000Z",
        }),
      ],
      "updated_at",
    );

    const selected = selectVisibleSidebarThreadRows({
      rows,
      activeThreadKey: null,
      expanded: false,
      previewLimit: 1,
    });

    expect(selected.visibleRows.map((row) => row.thread.id)).toEqual([
      ThreadId.make("thread-parent"),
      ThreadId.make("thread-child"),
    ]);
    expect(selected.hiddenRows.map((row) => row.thread.id)).toEqual([
      ThreadId.make("thread-other"),
    ]);
  });

  it("uses recent descendant activity when choosing folded root groups", () => {
    const rows = buildSidebarThreadTreeRows(
      [
        makeThread({
          id: ThreadId.make("thread-old-parent"),
          updatedAt: "2026-03-09T09:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.make("thread-recent-child"),
          parentThreadId: ThreadId.make("thread-old-parent"),
          updatedAt: "2026-03-09T13:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.make("thread-newer-root"),
          updatedAt: "2026-03-09T12:00:00.000Z",
        }),
      ],
      "updated_at",
    );

    const selected = selectVisibleSidebarThreadRows({
      rows,
      activeThreadKey: null,
      expanded: false,
      previewLimit: 1,
    });

    expect(selected.visibleRows.map((row) => row.thread.id)).toEqual([
      ThreadId.make("thread-old-parent"),
      ThreadId.make("thread-recent-child"),
    ]);
    expect(selected.hiddenRows.map((row) => row.thread.id)).toEqual([
      ThreadId.make("thread-newer-root"),
    ]);
  });

  it("includes an active hidden child with its parent root group", () => {
    const rows = buildSidebarThreadTreeRows(
      [
        makeThread({
          id: ThreadId.make("thread-visible-root"),
          updatedAt: "2026-03-09T13:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.make("thread-hidden-parent"),
          updatedAt: "2026-03-09T12:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.make("thread-active-child"),
          parentThreadId: ThreadId.make("thread-hidden-parent"),
          updatedAt: "2026-03-09T11:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.make("thread-hidden-other"),
          updatedAt: "2026-03-09T10:00:00.000Z",
        }),
      ],
      "updated_at",
    );

    const selected = selectVisibleSidebarThreadRows({
      rows,
      activeThreadKey: "thread-active-child",
      expanded: false,
      previewLimit: 1,
    });

    expect(selected.visibleRows.map((row) => row.thread.id)).toEqual([
      ThreadId.make("thread-visible-root"),
      ThreadId.make("thread-hidden-parent"),
      ThreadId.make("thread-active-child"),
    ]);
    expect(selected.hiddenRows.map((row) => row.thread.id)).toEqual([
      ThreadId.make("thread-hidden-other"),
    ]);
  });

  it("hides descendants when a parent thread is collapsed", () => {
    const rows = buildSidebarThreadTreeRows(
      [
        makeThread({
          id: ThreadId.make("thread-parent"),
          updatedAt: "2026-03-09T13:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.make("thread-child"),
          parentThreadId: ThreadId.make("thread-parent"),
          updatedAt: "2026-03-09T12:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.make("thread-other"),
          updatedAt: "2026-03-09T11:00:00.000Z",
        }),
      ],
      "updated_at",
    );

    const selected = selectVisibleSidebarThreadRows({
      rows,
      activeThreadKey: null,
      expanded: true,
      previewLimit: 1,
      collapsedThreadKeys: new Set(["thread-parent"]),
    });

    expect(selected.visibleRows.map((row) => row.thread.id)).toEqual([
      ThreadId.make("thread-parent"),
      ThreadId.make("thread-other"),
    ]);
    expect(selected.hiddenRows).toEqual([]);
  });

  it("keeps the active child path visible through collapsed ancestors", () => {
    const rows = buildSidebarThreadTreeRows(
      [
        makeThread({
          id: ThreadId.make("thread-parent"),
          updatedAt: "2026-03-09T13:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.make("thread-active-child"),
          parentThreadId: ThreadId.make("thread-parent"),
          updatedAt: "2026-03-09T12:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.make("thread-active-grandchild"),
          parentThreadId: ThreadId.make("thread-active-child"),
          updatedAt: "2026-03-09T11:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.make("thread-hidden-sibling"),
          parentThreadId: ThreadId.make("thread-parent"),
          updatedAt: "2026-03-09T10:00:00.000Z",
        }),
      ],
      "updated_at",
    );

    const selected = selectVisibleSidebarThreadRows({
      rows,
      activeThreadKey: "thread-active-grandchild",
      expanded: true,
      previewLimit: 1,
      collapsedThreadKeys: new Set(["thread-parent", "thread-active-child"]),
    });

    expect(selected.visibleRows.map((row) => row.thread.id)).toEqual([
      ThreadId.make("thread-parent"),
      ThreadId.make("thread-active-child"),
      ThreadId.make("thread-active-grandchild"),
    ]);
  });

  it("renders orphaned children as root rows", () => {
    const rows = buildSidebarThreadTreeRows(
      [
        makeThread({
          id: ThreadId.make("thread-orphan"),
          parentThreadId: ThreadId.make("thread-missing-parent"),
        }),
      ],
      "updated_at",
    );

    expect(rows.map((row) => row.thread.id)).toEqual([ThreadId.make("thread-orphan")]);
    expect(rows[0]?.depth).toBe(0);
    expect(rows[0]?.parentThreadKey).toBeNull();
  });

  it("uses flattened tree order for visible row order", () => {
    const rows = buildSidebarThreadTreeRows(
      [
        makeThread({
          id: ThreadId.make("thread-root"),
          updatedAt: "2026-03-09T13:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.make("thread-child-a"),
          parentThreadId: ThreadId.make("thread-root"),
          updatedAt: "2026-03-09T12:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.make("thread-child-b"),
          parentThreadId: ThreadId.make("thread-root"),
          updatedAt: "2026-03-09T11:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.make("thread-next-root"),
          updatedAt: "2026-03-09T10:00:00.000Z",
        }),
      ],
      "updated_at",
    );

    const selected = selectVisibleSidebarThreadRows({
      rows,
      activeThreadKey: null,
      expanded: true,
      previewLimit: 1,
    });

    expect(selected.visibleRows.map((row) => row.threadKey)).toEqual([
      "thread-root",
      "thread-child-a",
      "thread-child-b",
      "thread-next-root",
    ]);
  });
});

function makeProject(overrides: Partial<Project> = {}): Project {
  const { defaultModelSelection, ...rest } = overrides;
  return {
    id: ProjectId.make("project-1"),
    environmentId: localEnvironmentId,
    title: "Project",
    workspaceRoot: "/tmp/project",
    repositoryIdentity: null,
    defaultModelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
      ...defaultModelSelection,
    },
    createdAt: "2026-03-09T10:00:00.000Z",
    updatedAt: "2026-03-09T10:00:00.000Z",
    scripts: [],
    ...rest,
  };
}

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: ThreadId.make("thread-1"),
    environmentId: localEnvironmentId,
    projectId: ProjectId.make("project-1"),
    ownerUserId: DEFAULT_WORKSPACE_USER_ID,
    parentThreadId: null,
    workflowRole: null,
    title: "Thread",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
      ...overrides?.modelSelection,
    },
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_INTERACTION_MODE,
    session: null,
    messages: [],
    proposedPlans: [],
    planningWorkflow: null,
    createdAt: "2026-03-09T10:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    updatedAt: "2026-03-09T10:00:00.000Z",
    latestTurn: null,
    branch: null,
    worktreePath: null,
    checkpoints: [],
    appReviews: [],
    activities: [],
    ...overrides,
  };
}

describe("getFallbackThreadIdAfterDelete", () => {
  it("returns the top remaining thread in the deleted thread's project sidebar order", () => {
    const fallbackThreadId = getFallbackThreadIdAfterDelete({
      threads: [
        makeThread({
          id: ThreadId.make("thread-oldest"),
          projectId: ProjectId.make("project-1"),
          createdAt: "2026-03-09T10:00:00.000Z",
          messages: [],
        }),
        makeThread({
          id: ThreadId.make("thread-active"),
          projectId: ProjectId.make("project-1"),
          createdAt: "2026-03-09T10:05:00.000Z",
          messages: [],
        }),
        makeThread({
          id: ThreadId.make("thread-newest"),
          projectId: ProjectId.make("project-1"),
          createdAt: "2026-03-09T10:10:00.000Z",
          messages: [],
        }),
        makeThread({
          id: ThreadId.make("thread-other-project"),
          projectId: ProjectId.make("project-2"),
          createdAt: "2026-03-09T10:20:00.000Z",
          messages: [],
        }),
      ],
      deletedThreadId: ThreadId.make("thread-active"),
      sortOrder: "created_at",
    });

    expect(fallbackThreadId).toBe(ThreadId.make("thread-newest"));
  });

  it("skips other threads being deleted in the same action", () => {
    const fallbackThreadId = getFallbackThreadIdAfterDelete({
      threads: [
        makeThread({
          id: ThreadId.make("thread-active"),
          projectId: ProjectId.make("project-1"),
          createdAt: "2026-03-09T10:05:00.000Z",
          messages: [],
        }),
        makeThread({
          id: ThreadId.make("thread-newest"),
          projectId: ProjectId.make("project-1"),
          createdAt: "2026-03-09T10:10:00.000Z",
          messages: [],
        }),
        makeThread({
          id: ThreadId.make("thread-next"),
          projectId: ProjectId.make("project-1"),
          createdAt: "2026-03-09T10:07:00.000Z",
          messages: [],
        }),
      ],
      deletedThreadId: ThreadId.make("thread-active"),
      deletedThreadIds: new Set([ThreadId.make("thread-active"), ThreadId.make("thread-newest")]),
      sortOrder: "created_at",
    });

    expect(fallbackThreadId).toBe(ThreadId.make("thread-next"));
  });

  it("skips every descendant included by a cascading delete", () => {
    const parent = makeThread({ id: ThreadId.make("thread-parent") });
    const child = makeThread({
      id: ThreadId.make("thread-child"),
      parentThreadId: parent.id,
      createdAt: "2026-03-09T10:20:00.000Z",
    });
    const grandchild = makeThread({
      id: ThreadId.make("thread-grandchild"),
      parentThreadId: child.id,
      createdAt: "2026-03-09T10:30:00.000Z",
    });
    const survivor = makeThread({
      id: ThreadId.make("thread-survivor"),
      createdAt: "2026-03-09T10:10:00.000Z",
    });
    const threads = [parent, child, grandchild, survivor];
    const deletedThreadIds = expandHierarchySelectionIds({
      nodes: threads,
      selectedIds: new Set([parent.id]),
      accessors: {
        getId: (thread) => thread.id,
        getParentId: (thread) => thread.parentThreadId,
      },
    });

    expect(
      getFallbackThreadIdAfterDelete({
        threads,
        deletedThreadId: parent.id,
        deletedThreadIds,
        sortOrder: "created_at",
      }),
    ).toBe(survivor.id);
  });
});

describe("thread lifecycle hierarchy actions", () => {
  const nodes = [
    { id: "parent", parentId: null },
    { id: "child", parentId: "parent" },
    { id: "grandchild", parentId: "child" },
    { id: "sibling", parentId: null },
  ] as const;
  const accessors = {
    getId: (node: (typeof nodes)[number]) => node.id,
    getParentId: (node: (typeof nodes)[number]) => node.parentId,
  };

  it("dispatches only selected hierarchy roots", () => {
    expect(
      getSelectedHierarchyRootIds({
        nodes,
        selectedIds: new Set(["child", "parent", "sibling"]),
        accessors,
      }),
    ).toEqual(["parent", "sibling"]);
  });

  it("uses explicit subtree warning and archive copy", () => {
    expect(getThreadDeleteConfirmationText("Parent")).toContain("all sub-threads");
    expect(getMultiThreadDeleteConfirmationText(2)).toContain("all their descendants");
    expect(getArchiveConfirmationCopy(true)).toEqual({
      label: "Archive all",
      accessibleLabel: "Archive this thread and all sub-threads",
      tooltip: "Includes all sub-threads",
    });
    expect(getArchiveConfirmationCopy(false).label).toBe("Confirm");
  });
});
describe("sortProjectsForSidebar", () => {
  it("sorts projects by the most recent user message across their threads", () => {
    const projects = [
      makeProject({ id: ProjectId.make("project-1"), title: "Older project" }),
      makeProject({ id: ProjectId.make("project-2"), title: "Newer project" }),
    ];
    const threads = [
      makeThread({
        projectId: ProjectId.make("project-1"),
        updatedAt: "2026-03-09T10:20:00.000Z",
        messages: [
          {
            id: "message-1" as never,
            role: "user",
            text: "older project user message",
            turnId: null,
            createdAt: "2026-03-09T10:01:00.000Z",
            updatedAt: "2026-03-09T10:01:00.000Z",
            streaming: false,
          },
        ],
      }),
      makeThread({
        id: ThreadId.make("thread-2"),
        projectId: ProjectId.make("project-2"),
        updatedAt: "2026-03-09T10:05:00.000Z",
        messages: [
          {
            id: "message-2" as never,
            role: "user",
            text: "newer project user message",
            turnId: null,
            createdAt: "2026-03-09T10:05:00.000Z",
            updatedAt: "2026-03-09T10:05:00.000Z",
            streaming: false,
          },
        ],
      }),
    ];

    const sorted = sortProjectsForSidebar(projects, threads, "updated_at");

    expect(sorted.map((project) => project.id)).toEqual([
      ProjectId.make("project-2"),
      ProjectId.make("project-1"),
    ]);
  });

  it("falls back to project timestamps when a project has no threads", () => {
    const sorted = sortProjectsForSidebar(
      [
        makeProject({
          id: ProjectId.make("project-1"),
          title: "Older project",
          updatedAt: "2026-03-09T10:01:00.000Z",
        }),
        makeProject({
          id: ProjectId.make("project-2"),
          title: "Newer project",
          updatedAt: "2026-03-09T10:05:00.000Z",
        }),
      ],
      [],
      "updated_at",
    );

    expect(sorted.map((project) => project.id)).toEqual([
      ProjectId.make("project-2"),
      ProjectId.make("project-1"),
    ]);
  });

  it("falls back to name and id ordering when projects have no sortable timestamps", () => {
    const sorted = sortProjectsForSidebar(
      [
        makeProject({
          id: ProjectId.make("project-2"),
          title: "Beta",
          createdAt: "invalid-created-at" as never,
          updatedAt: "invalid-updated-at" as never,
        }),
        makeProject({
          id: ProjectId.make("project-1"),
          title: "Alpha",
          createdAt: "invalid-created-at" as never,
          updatedAt: "invalid-updated-at" as never,
        }),
      ],
      [],
      "updated_at",
    );

    expect(sorted.map((project) => project.id)).toEqual([
      ProjectId.make("project-1"),
      ProjectId.make("project-2"),
    ]);
  });

  it("preserves manual project ordering", () => {
    const projects = [
      makeProject({ id: ProjectId.make("project-2"), title: "Second" }),
      makeProject({ id: ProjectId.make("project-1"), title: "First" }),
    ];

    const sorted = sortProjectsForSidebar(projects, [], "manual");

    expect(sorted.map((project) => project.id)).toEqual([
      ProjectId.make("project-2"),
      ProjectId.make("project-1"),
    ]);
  });

  it("ignores archived threads when sorting projects", () => {
    const sorted = sortProjectsForSidebar(
      [
        makeProject({
          id: ProjectId.make("project-1"),
          title: "Visible project",
          updatedAt: "2026-03-09T10:01:00.000Z",
        }),
        makeProject({
          id: ProjectId.make("project-2"),
          title: "Archived-only project",
          updatedAt: "2026-03-09T10:00:00.000Z",
        }),
      ],
      [
        makeThread({
          id: ThreadId.make("thread-visible"),
          projectId: ProjectId.make("project-1"),
          updatedAt: "2026-03-09T10:02:00.000Z",
          archivedAt: null,
        }),
        makeThread({
          id: ThreadId.make("thread-archived"),
          projectId: ProjectId.make("project-2"),
          updatedAt: "2026-03-09T10:10:00.000Z",
          archivedAt: "2026-03-09T10:11:00.000Z",
        }),
      ].filter((thread) => thread.archivedAt === null),
      "updated_at",
    );

    expect(sorted.map((project) => project.id)).toEqual([
      ProjectId.make("project-1"),
      ProjectId.make("project-2"),
    ]);
  });

  it("returns the project timestamp when no threads are present", () => {
    const timestamp = getProjectSortTimestamp(
      makeProject({ updatedAt: "2026-03-09T10:10:00.000Z" }),
      [],
      "updated_at",
    );

    expect(timestamp).toBe(Date.parse("2026-03-09T10:10:00.000Z"));
  });
});

describe("sortScopedProjectsForSidebar", () => {
  it("keeps identical project ids in different environments separate", () => {
    const remoteEnvironmentId = EnvironmentId.make("environment-remote");
    const sharedProjectId = ProjectId.make("shared-project");
    const projects = [
      makeProject({
        environmentId: localEnvironmentId,
        id: sharedProjectId,
        title: "Local project",
      }),
      makeProject({
        environmentId: remoteEnvironmentId,
        id: sharedProjectId,
        title: "Remote project",
      }),
    ];
    const threads = [
      makeThread({
        environmentId: localEnvironmentId,
        projectId: sharedProjectId,
        updatedAt: "2026-03-09T10:02:00.000Z",
      }),
      makeThread({
        environmentId: remoteEnvironmentId,
        projectId: sharedProjectId,
        updatedAt: "2026-03-09T10:10:00.000Z",
      }),
    ];

    const sorted = sortScopedProjectsForSidebar(projects, threads, "updated_at");

    expect(sorted.map((project) => project.title)).toEqual(["Remote project", "Local project"]);
  });

  it("does not use archived threads as project activity", () => {
    const projects = [
      makeProject({
        id: ProjectId.make("project-visible"),
        title: "Visible project",
        updatedAt: "2026-03-09T10:01:00.000Z",
      }),
      makeProject({
        id: ProjectId.make("project-archived"),
        title: "Archived-only project",
        updatedAt: "2026-03-09T10:00:00.000Z",
      }),
    ];
    const threads = [
      makeThread({
        id: ThreadId.make("thread-visible"),
        projectId: ProjectId.make("project-visible"),
        updatedAt: "2026-03-09T10:02:00.000Z",
      }),
      makeThread({
        id: ThreadId.make("thread-archived"),
        projectId: ProjectId.make("project-archived"),
        updatedAt: "2026-03-09T10:10:00.000Z",
        archivedAt: "2026-03-09T10:11:00.000Z",
      }),
    ];

    const sorted = sortScopedProjectsForSidebar(projects, threads, "updated_at");

    expect(sorted.map((project) => project.title)).toEqual([
      "Visible project",
      "Archived-only project",
    ]);
  });
});

describe("sortLogicalProjectsForSidebar", () => {
  it("uses saved order only in manual mode and activity order otherwise", () => {
    const olderProjectId = ProjectId.make("project-older");
    const newerProjectId = ProjectId.make("project-newer");
    const projects = [
      {
        ...makeProject({ id: olderProjectId, title: "Older project" }),
        projectKey: "logical-older",
        memberProjectRefs: [{ environmentId: localEnvironmentId, projectId: olderProjectId }],
      },
      {
        ...makeProject({ id: newerProjectId, title: "Newer project" }),
        projectKey: "logical-newer",
        memberProjectRefs: [{ environmentId: localEnvironmentId, projectId: newerProjectId }],
      },
    ];
    const threads = [
      makeThread({
        projectId: olderProjectId,
        updatedAt: "2026-03-09T10:01:00.000Z",
      }),
      makeThread({
        id: ThreadId.make("thread-newer"),
        projectId: newerProjectId,
        updatedAt: "2026-03-09T10:05:00.000Z",
      }),
    ];

    expect(sortLogicalProjectsForSidebar(projects, threads, "manual")).toEqual(projects);
    expect(
      sortLogicalProjectsForSidebar(projects, threads, "updated_at").map(
        (project) => project.projectKey,
      ),
    ).toEqual(["logical-newer", "logical-older"]);
  });
});

describe("buildSidebarV2ThreadTreeRows", () => {
  const node = (input: { id: string; createdAt: string; parentThreadId?: string }) => ({
    id: ThreadId.make(input.id),
    parentThreadId: input.parentThreadId === undefined ? null : ThreadId.make(input.parentThreadId),
    createdAt: input.createdAt,
  });

  it("reduces to sortThreadsForSidebarV2 order when nothing has a parent", () => {
    const threads = [
      node({ id: "oldest", createdAt: "2026-03-09T08:00:00.000Z" }),
      node({ id: "newest", createdAt: "2026-03-09T12:00:00.000Z" }),
      node({ id: "middle", createdAt: "2026-03-09T10:00:00.000Z" }),
    ];

    expect(buildSidebarV2ThreadTreeRows(threads).map((row) => row.thread.id)).toEqual(
      sortThreadsForSidebarV2(threads).map((thread) => thread.id),
    );
  });

  it("nests sub-threads under their parent in execution order", () => {
    const rows = buildSidebarV2ThreadTreeRows([
      node({ id: "worker-b", createdAt: "2026-03-09T10:30:00.000Z", parentThreadId: "planning" }),
      node({ id: "root", createdAt: "2026-03-09T10:00:00.000Z" }),
      node({ id: "worker-a", createdAt: "2026-03-09T10:20:00.000Z", parentThreadId: "planning" }),
      node({ id: "planning", createdAt: "2026-03-09T10:10:00.000Z", parentThreadId: "root" }),
    ]);

    expect(rows.map((row) => [row.thread.id, row.depth, row.hasChildren])).toEqual([
      ["root", 0, true],
      ["planning", 1, true],
      ["worker-a", 2, false],
      ["worker-b", 2, false],
    ]);
    expect(rows.every((row) => row.rootThreadKey === "root")).toBe(true);
  });

  it("caps visual depth so a deep workflow cannot indent off the sidebar", () => {
    const rows = buildSidebarV2ThreadTreeRows([
      node({ id: "d0", createdAt: "2026-03-09T10:00:00.000Z" }),
      node({ id: "d1", createdAt: "2026-03-09T10:01:00.000Z", parentThreadId: "d0" }),
      node({ id: "d2", createdAt: "2026-03-09T10:02:00.000Z", parentThreadId: "d1" }),
      node({ id: "d3", createdAt: "2026-03-09T10:03:00.000Z", parentThreadId: "d2" }),
      node({ id: "d4", createdAt: "2026-03-09T10:04:00.000Z", parentThreadId: "d3" }),
    ]);

    expect(rows.map((row) => row.visualDepth)).toEqual([0, 1, 2, 3, 3]);
  });

  it("does not let a newly spawned sub-thread reorder its root", () => {
    const withoutChild = [
      node({ id: "older-root", createdAt: "2026-03-09T08:00:00.000Z" }),
      node({ id: "newer-root", createdAt: "2026-03-09T09:00:00.000Z" }),
    ];
    const withChild = [
      ...withoutChild,
      // Spawned long after the newer root — a roll-up sort would lift
      // older-root to the top. v2 must not move.
      node({ id: "worker", createdAt: "2026-03-09T23:00:00.000Z", parentThreadId: "older-root" }),
    ];

    expect(
      buildSidebarV2ThreadTreeRows(withChild)
        .filter((row) => row.depth === 0)
        .map((row) => row.thread.id),
    ).toEqual(["newer-root", "older-root"]);
  });

  it("promotes dangling and self parents to roots and still emits cycles once", () => {
    const rows = buildSidebarV2ThreadTreeRows([
      node({ id: "orphan", createdAt: "2026-03-09T10:00:00.000Z", parentThreadId: "missing" }),
      node({ id: "self", createdAt: "2026-03-09T10:01:00.000Z", parentThreadId: "self" }),
      node({ id: "cycle-a", createdAt: "2026-03-09T10:02:00.000Z", parentThreadId: "cycle-b" }),
      node({ id: "cycle-b", createdAt: "2026-03-09T10:03:00.000Z", parentThreadId: "cycle-a" }),
    ]);

    expect(rows).toHaveLength(4);
    expect(new Set(rows.map((row) => row.thread.id))).toEqual(
      new Set(["orphan", "self", "cycle-a", "cycle-b"]),
    );
    for (const id of ["orphan", "self"]) {
      expect(rows.find((row) => row.thread.id === id)?.depth).toBe(0);
    }
  });
});

describe("selectVisibleSidebarV2TreeRows", () => {
  const rows = buildSidebarV2ThreadTreeRows([
    { id: ThreadId.make("root"), parentThreadId: null, createdAt: "2026-03-09T10:00:00.000Z" },
    {
      id: ThreadId.make("planning"),
      parentThreadId: ThreadId.make("root"),
      createdAt: "2026-03-09T10:10:00.000Z",
    },
    {
      id: ThreadId.make("worker"),
      parentThreadId: ThreadId.make("planning"),
      createdAt: "2026-03-09T10:20:00.000Z",
    },
  ]);

  it("hides every sub-thread by default", () => {
    expect(
      selectVisibleSidebarV2TreeRows({
        rows,
        expandedThreadKeys: new Set(),
        activeThreadKey: null,
      }).map((row) => row.threadKey),
    ).toEqual(["root"]);
  });

  it("reveals only the expanded node's direct children", () => {
    expect(
      selectVisibleSidebarV2TreeRows({
        rows,
        expandedThreadKeys: new Set(["root"]),
        activeThreadKey: null,
      }).map((row) => row.threadKey),
    ).toEqual(["root", "planning"]);
  });

  it("forces the open thread's whole ancestor path visible without expanding it", () => {
    const expandedThreadKeys = new Set<string>();

    expect(
      selectVisibleSidebarV2TreeRows({
        rows,
        expandedThreadKeys,
        activeThreadKey: "worker",
      }).map((row) => row.threadKey),
    ).toEqual(["root", "planning", "worker"]);
    expect(expandedThreadKeys.size).toBe(0);
  });
});

describe("partitionSidebarV2ThreadGroups", () => {
  const tree = (
    entries: readonly { id: string; parentThreadId?: string; snoozedUntil?: string }[],
  ) =>
    buildSidebarV2ThreadTreeRows(
      entries.map((entry, index) => ({
        id: ThreadId.make(entry.id),
        parentThreadId:
          entry.parentThreadId === undefined ? null : ThreadId.make(entry.parentThreadId),
        createdAt: `2026-03-09T10:${String(index).padStart(2, "0")}:00.000Z`,
        snoozedUntil: entry.snoozedUntil ?? null,
      })),
    );

  const partition = (
    rows: ReturnType<typeof tree>,
    sectionById: Record<string, "active" | "snoozed" | "settled">,
  ) =>
    partitionSidebarV2ThreadGroups({
      rows,
      classifyThread: (thread) => sectionById[thread.id] ?? "active",
      resolveSnoozeSortMs: (thread) =>
        thread.snoozedUntil === null ? 0 : Date.parse(thread.snoozedUntil),
      resolveSettledSortMs: () => 0,
    });

  it("keeps a workflow whole in Active when any member is still active", () => {
    const rows = tree([{ id: "root" }, { id: "worker-a", parentThreadId: "root" }]);
    const result = partition(rows, { root: "settled", "worker-a": "active" });

    expect(result.groupsBySection.active.map((group) => group.rootThreadKey)).toEqual(["root"]);
    expect(result.groupsBySection.settled).toHaveLength(0);
    expect(result.groupCountBySection.active).toBe(1);
  });

  it("still reports each thread's own state so its affordance stays correct", () => {
    const rows = tree([{ id: "root" }, { id: "worker-a", parentThreadId: "root" }]);
    const result = partition(rows, { root: "active", "worker-a": "settled" });

    expect(result.sectionByThreadKey.get("worker-a")).toBe("settled");
    expect(result.sectionByThreadKey.get("root")).toBe("active");
  });

  it("moves an all-settled workflow into the tail as one unit", () => {
    const rows = tree([{ id: "root" }, { id: "worker-a", parentThreadId: "root" }]);
    const result = partition(rows, { root: "settled", "worker-a": "settled" });

    expect(result.groupsBySection.active).toHaveLength(0);
    expect(result.groupsBySection.settled).toHaveLength(1);
    expect(result.groupsBySection.settled[0]?.rows.map((row) => row.threadKey)).toEqual([
      "root",
      "worker-a",
    ]);
  });

  it("orders snoozed groups by the soonest wake among their members", () => {
    const rows = tree([
      { id: "late", snoozedUntil: "2026-03-10T12:00:00.000Z" },
      { id: "soon", snoozedUntil: "2026-03-10T08:00:00.000Z" },
    ]);
    const result = partition(rows, { late: "snoozed", soon: "snoozed" });

    expect(result.groupsBySection.snoozed.map((group) => group.rootThreadKey)).toEqual([
      "soon",
      "late",
    ]);
  });
});

describe("resolveSidebarV2GroupSettlePlan", () => {
  const buildGroups = (
    entries: readonly {
      id: string;
      parentThreadId?: string;
      settled?: boolean;
      blocked?: boolean;
    }[],
  ) => {
    const rows = buildSidebarV2ThreadTreeRows(
      entries.map((entry, index) => ({
        ...entry,
        id: ThreadId.make(entry.id),
        parentThreadId:
          entry.parentThreadId === undefined ? null : ThreadId.make(entry.parentThreadId),
        createdAt: `2026-03-09T10:${String(index).padStart(2, "0")}:00.000Z`,
      })),
    );
    return partitionSidebarV2ThreadGroups({
      rows,
      classifyThread: () => "active",
      resolveSnoozeSortMs: () => 0,
      resolveSettledSortMs: () => 0,
    }).groupsBySection.active;
  };

  it("includes every nested descendant and skips members already settled", () => {
    const groups = buildGroups([
      { id: "root" },
      { id: "child", parentThreadId: "root", settled: true },
      { id: "grandchild", parentThreadId: "child" },
    ]);
    const plan = resolveSidebarV2GroupSettlePlan({
      groups,
      rootThreadKey: "root",
      isSettled: (_key, thread) => thread.settled === true,
      canSettle: (thread) => thread.blocked !== true,
    });

    expect(plan?.rows.map((row) => row.threadKey)).toEqual(["root", "child", "grandchild"]);
    expect(plan?.targetRows.map((row) => row.threadKey)).toEqual(["root", "grandchild"]);
    expect(plan?.canSettle).toBe(true);
  });

  it("blocks the whole plan when any unsettled member cannot settle", () => {
    const groups = buildGroups([
      { id: "root" },
      { id: "child", parentThreadId: "root", blocked: true },
    ]);
    const plan = resolveSidebarV2GroupSettlePlan({
      groups,
      rootThreadKey: "root",
      isSettled: (_key, thread) => thread.settled === true,
      canSettle: (thread) => thread.blocked !== true,
    });

    expect(plan?.targetRows.map((row) => row.threadKey)).toEqual(["root", "child"]);
    expect(plan?.canSettle).toBe(false);
  });

  it("keeps a plain root as a one-thread settle plan", () => {
    const plan = resolveSidebarV2GroupSettlePlan({
      groups: buildGroups([{ id: "root" }]),
      rootThreadKey: "root",
      isSettled: () => false,
      canSettle: () => true,
    });

    expect(plan?.targetRows.map((row) => row.threadKey)).toEqual(["root"]);
  });
});

describe("resolveHighestPrioritySidebarV2Status", () => {
  const idle = { hasPendingApprovals: false, hasPendingUserInput: false, session: null };

  it("surfaces the most urgent status hidden inside a collapsed group", () => {
    expect(
      resolveHighestPrioritySidebarV2Status([
        idle,
        { ...idle, hasPendingUserInput: true },
        { ...idle, hasPendingApprovals: true },
      ]),
    ).toBe("approval");
  });

  it("returns null with no descendants", () => {
    expect(resolveHighestPrioritySidebarV2Status([])).toBeNull();
  });
});

describe("workflowRoleShortLabel", () => {
  it("labels workflow sub-threads and leaves plain threads unlabeled", () => {
    expect(workflowRoleShortLabel("implementation-worker")).toBe("Worker");
    expect(workflowRoleShortLabel("implementation-qa-reviewer")).toBe("App review");
    expect(workflowRoleShortLabel("planning-orchestrator")).toBe("Planning");
    expect(workflowRoleShortLabel("app-review-orchestrator")).toBe("App Review");
    expect(workflowRoleShortLabel("app-review-reviewer")).toBe("Browser review");
    expect(workflowRoleShortLabel("app-review-fixer")).toBe("Implement");
    expect(workflowRoleShortLabel(null)).toBeNull();
  });
});
