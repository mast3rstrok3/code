import {
  DEFAULT_WORKSPACE_USER_ID,
  EnvironmentId,
  MessageId,
  ProjectId,
  type OrchestrationImplementationRun,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  WorkspaceUserId,
} from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { Thread, ThreadShell } from "../types";
import {
  MAX_HIDDEN_MOUNTED_PREVIEW_THREADS,
  MAX_HIDDEN_MOUNTED_TERMINAL_THREADS,
  buildLocalDraftThread,
  branchMismatchKey,
  buildExpiredTerminalContextToastCopy,
  buildLoadingThreadFromShell,
  buildThreadTurnInterruptInput,
  buildAppReviewLaunchTargets,
  collectAppReviewLaunchPreviewTargets,
  createLocalDispatchSnapshot,
  deriveComposerSendState,
  dismissBranchMismatchForSession,
  findCancelableImplementationRunForThread,
  ENVIRONMENT_RECONNECT_WARNING_GRACE_MS,
  getStartedThreadModelChangeBlockReason,
  hasEnvironmentReconnectWarningGraceElapsed,
  hasServerAcknowledgedLocalDispatch,
  isBranchMismatchDismissedForSession,
  normalizeAppReviewCycleBudget,
  normalizeAppReviewPreviewTarget,
  reconcileMountedTerminalThreadIds,
  reconcileRetainedMountedThreadIds,
  resolveProductWorkflowPlanningThreadId,
  resolveSendEnvMode,
  selectBrowserAppReviewAutoContext,
  resolveThreadMetadataUpdateForNextTurn,
  scheduleEnvironmentReconnectWarning,
  startNewThreadForProject,
  shouldShowBranchMismatchBanner,
  shouldWriteThreadErrorToCurrentServerThread,
} from "./ChatView.logic";

const environmentId = EnvironmentId.make("environment-local");
const projectId = ProjectId.make("project-1");
const threadId = ThreadId.make("thread-1");
const now = "2026-03-29T00:00:00.000Z";

describe("environment reconnect warning grace", () => {
  afterEach(() => vi.useRealTimers());

  it("shows a persistent reconnect after the grace period", () => {
    vi.useFakeTimers();
    const showWarning = vi.fn();

    scheduleEnvironmentReconnectWarning(showWarning);
    vi.advanceTimersByTime(ENVIRONMENT_RECONNECT_WARNING_GRACE_MS - 1);
    expect(showWarning).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(showWarning).toHaveBeenCalledOnce();
  });

  it("cancels the warning when the connection recovers during the grace period", () => {
    vi.useFakeTimers();
    const showWarning = vi.fn();

    const cancel = scheduleEnvironmentReconnectWarning(showWarning);
    cancel();
    vi.advanceTimersByTime(ENVIRONMENT_RECONNECT_WARNING_GRACE_MS);

    expect(showWarning).not.toHaveBeenCalled();
  });

  it("does not reuse elapsed grace from another environment", () => {
    const anotherEnvironmentId = EnvironmentId.make("environment-remote");

    expect(hasEnvironmentReconnectWarningGraceElapsed(environmentId, environmentId)).toBe(true);
    expect(hasEnvironmentReconnectWarningGraceElapsed(anotherEnvironmentId, environmentId)).toBe(
      false,
    );
  });
});

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: threadId,
    environmentId,
    projectId,
    ownerUserId: DEFAULT_WORKSPACE_USER_ID,
    parentThreadId: null,
    workflowRole: null,
    title: "Thread",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    workflowPreset: null,
    session: null,
    messages: [],
    proposedPlans: [],
    planningWorkflow: null,
    appReviews: [],
    activities: [],
    checkpoints: [],
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    ...overrides,
  };
}

const completedTurn = {
  turnId: TurnId.make("turn-1"),
  state: "completed" as const,
  requestedAt: now,
  startedAt: "2026-03-29T00:00:01.000Z",
  completedAt: "2026-03-29T00:00:10.000Z",
  assistantMessageId: null,
};

const readySession = {
  threadId,
  status: "ready" as const,
  providerName: "codex",
  providerInstanceId: ProviderInstanceId.make("codex"),
  runtimeMode: "full-access" as const,
  activeTurnId: null,
  lastError: null,
  updatedAt: "2026-03-29T00:00:10.000Z",
};

function makeMessage(input: {
  id: string;
  role: Thread["messages"][number]["role"];
  text: string;
  turnId?: Thread["messages"][number]["turnId"];
  streaming?: boolean;
  createdAt?: string;
  updatedAt?: string;
}): Thread["messages"][number] {
  return {
    id: MessageId.make(input.id),
    role: input.role,
    text: input.text,
    attachments: [],
    turnId: input.turnId ?? null,
    streaming: input.streaming ?? false,
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now,
  };
}

describe("buildLocalDraftThread", () => {
  it("uses the stored draft owner", () => {
    const ownerUserId = WorkspaceUserId.make("ada");

    expect(
      buildLocalDraftThread(
        threadId,
        {
          threadId,
          environmentId,
          projectId,
          ownerUserId,
          logicalProjectKey: "project",
          createdAt: now,
          runtimeMode: "full-access",
          interactionMode: "default",
          workflowPreset: null,
          branch: null,
          worktreePath: null,
          envMode: "local",
          startFromOrigin: false,
          promotedTo: null,
        },
        {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        },
      ).ownerUserId,
    ).toBe(ownerUserId);
  });
});

describe("normalizeAppReviewCycleBudget", () => {
  it("persists an integer cycle budget constrained to 1 through 50", () => {
    expect(normalizeAppReviewCycleBudget(10)).toBe(10);
    expect(normalizeAppReviewCycleBudget(2.6)).toBe(3);
    expect(normalizeAppReviewCycleBudget(0)).toBe(1);
    expect(normalizeAppReviewCycleBudget(51)).toBe(50);
    expect(normalizeAppReviewCycleBudget(Number.NaN)).toBe(10);
  });
});

describe("collectAppReviewLaunchPreviewTargets", () => {
  it("uses URLs from this review brief before the current thread browser", () => {
    expect(
      collectAppReviewLaunchPreviewTargets({
        brief: "Review https://feature.example.test/login.",
        activeBrowserUrl: "https://older.example.test/",
      }),
    ).toEqual(["https://feature.example.test/login", "https://older.example.test/"]);
  });

  it("has no project-scoped preview input", () => {
    expect(
      collectAppReviewLaunchPreviewTargets({
        brief: "Review checkout.",
        activeBrowserUrl: null,
      }),
    ).toEqual([]);
  });
});

describe("normalizeAppReviewPreviewTarget", () => {
  it("completes a host the way the preview surfaces do", () => {
    expect(normalizeAppReviewPreviewTarget("localhost:5173")).toBe("http://localhost:5173/");
    expect(normalizeAppReviewPreviewTarget(" staging.example.test/app ")).toBe(
      "https://staging.example.test/app",
    );
  });

  it("treats an empty or unusable target as no target", () => {
    expect(normalizeAppReviewPreviewTarget("   ")).toBeNull();
    expect(normalizeAppReviewPreviewTarget("ftp://example.test")).toBeNull();
  });
});

describe("buildAppReviewLaunchTargets", () => {
  it("pins the URL the user named over anything in the brief", () => {
    expect(
      buildAppReviewLaunchTargets({
        reviewUrl: "staging.example.test",
        brief: "Review https://feature.example.test/login.",
        activeBrowserUrl: "https://older.example.test/",
      }),
    ).toEqual({
      previewTargets: ["https://staging.example.test/"],
      previewTargetsPinned: true,
    });
  });

  it("falls back to brief and browser targets when no URL is named", () => {
    expect(
      buildAppReviewLaunchTargets({
        reviewUrl: "",
        brief: "Review https://feature.example.test/login.",
        activeBrowserUrl: null,
      }),
    ).toEqual({
      previewTargets: ["https://feature.example.test/login"],
      previewTargetsPinned: false,
    });
  });
});

describe("selectBrowserAppReviewAutoContext", () => {
  it("selects the latest settled user turn and following assistant output", () => {
    const turn1 = TurnId.make("turn-1");
    const turn2 = TurnId.make("turn-2");
    const context = selectBrowserAppReviewAutoContext({
      latestTurn: { ...completedTurn, turnId: turn2 },
      messages: [
        makeMessage({ id: "user-1", role: "user", text: "First request", turnId: turn1 }),
        makeMessage({
          id: "assistant-1",
          role: "assistant",
          text: "First answer",
          turnId: turn1,
        }),
        makeMessage({ id: "user-2", role: "user", text: "Review this login flow", turnId: turn2 }),
        makeMessage({
          id: "assistant-2",
          role: "assistant",
          text: "Login flow implemented",
          turnId: turn2,
        }),
      ],
    });

    expect(context?.turnId).toBe(turn2);
    expect(context?.messages.map((message) => message.text)).toEqual([
      "Review this login flow",
      "Login flow implemented",
    ]);
  });

  it("skips a running latest turn and falls back to the previous settled turn", () => {
    const settledTurn = TurnId.make("turn-settled");
    const runningTurn = TurnId.make("turn-running");
    const context = selectBrowserAppReviewAutoContext({
      latestTurn: {
        ...completedTurn,
        turnId: runningTurn,
        state: "running",
        completedAt: null,
      },
      messages: [
        makeMessage({
          id: "user-settled",
          role: "user",
          text: "Settled request",
          turnId: settledTurn,
        }),
        makeMessage({
          id: "assistant-settled",
          role: "assistant",
          text: "Settled answer",
          turnId: settledTurn,
        }),
        makeMessage({
          id: "user-running",
          role: "user",
          text: "Still running request",
          turnId: runningTurn,
        }),
        makeMessage({
          id: "assistant-running",
          role: "assistant",
          text: "Partial answer",
          turnId: runningTurn,
          streaming: true,
        }),
      ],
    });

    expect(context?.turnId).toBe(settledTurn);
    expect(context?.messages.map((message) => message.text)).toEqual([
      "Settled request",
      "Settled answer",
    ]);
  });

  it("returns null when there is no settled user turn", () => {
    expect(
      selectBrowserAppReviewAutoContext({
        latestTurn: null,
        messages: [makeMessage({ id: "assistant-only", role: "assistant", text: "No user turn" })],
      }),
    ).toBeNull();
  });
});

describe("buildLoadingThreadFromShell", () => {
  it("preserves shell metadata and supplies empty detail collections", () => {
    const shell = {
      environmentId,
      id: threadId,
      projectId,
      ownerUserId: WorkspaceUserId.make("ada"),
      parentThreadId: null,
      workflowRole: null,
      title: "Loading thread",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4",
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "main",
      worktreePath: null,
      latestTurn: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      snoozedUntil: null,
      snoozedAt: null,
      session: null,
      latestUserMessageAt: now,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
    } satisfies ThreadShell;

    expect(buildLoadingThreadFromShell(shell)).toMatchObject({
      environmentId,
      id: threadId,
      projectId,
      title: "Loading thread",
      branch: "main",
      deletedAt: null,
      messages: [],
      proposedPlans: [],
      activities: [],
      checkpoints: [],
    });
  });
});

describe("resolveThreadMetadataUpdateForNextTurn", () => {
  const modelSelection = {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5.4",
  };

  it("updates a stale local thread branch to the active checkout", () => {
    expect(
      resolveThreadMetadataUpdateForNextTurn({
        currentModelSelection: modelSelection,
        currentBranch: "feature/thread",
        nextBranch: "feature/checkout",
      }),
    ).toEqual({ branch: "feature/checkout", worktreePath: null });
  });

  it("does not write metadata when the model and branch are unchanged", () => {
    expect(
      resolveThreadMetadataUpdateForNextTurn({
        currentModelSelection: modelSelection,
        nextModelSelection: modelSelection,
        currentBranch: "feature/current",
        nextBranch: "feature/current",
      }),
    ).toBeNull();
  });
});

describe("buildThreadTurnInterruptInput", () => {
  it("targets the session's active running turn", () => {
    const activeTurnId = TurnId.make("turn-running");

    expect(
      buildThreadTurnInterruptInput(
        makeThread({
          session: {
            ...readySession,
            status: "running",
            activeTurnId,
          },
        }),
      ),
    ).toEqual({ threadId, turnId: activeTurnId });
  });

  it("omits a turn id when the session is not running", () => {
    expect(buildThreadTurnInterruptInput(makeThread({ session: readySession }))).toEqual({
      threadId,
    });
  });
});

describe("findCancelableImplementationRunForThread", () => {
  const run = (
    overrides: Partial<OrchestrationImplementationRun>,
  ): OrchestrationImplementationRun =>
    ({
      id: "run-1",
      status: "running",
      orchestratorThreadId: ThreadId.make("thread-implementer"),
      sourceProposedPlan: null,
      updatedAt: now,
      ...overrides,
    }) as OrchestrationImplementationRun;

  it("matches the run this thread orchestrates", () => {
    const found = findCancelableImplementationRunForThread({
      threadId: ThreadId.make("thread-implementer"),
      implementationRuns: [run({})],
    });
    expect(found?.id).toBe("run-1");
  });

  it("matches the run launched from this thread's proposed plan", () => {
    const found = findCancelableImplementationRunForThread({
      threadId,
      implementationRuns: [run({ sourceProposedPlan: { threadId, planId: "plan-1" } as never })],
    });
    expect(found?.id).toBe("run-1");
  });

  it("ignores terminal runs and unrelated threads", () => {
    expect(
      findCancelableImplementationRunForThread({
        threadId: ThreadId.make("thread-implementer"),
        implementationRuns: [
          run({ status: "completed" }),
          run({ id: "run-2", status: "canceled" }),
        ],
      }),
    ).toBeNull();
    expect(
      findCancelableImplementationRunForThread({
        threadId: ThreadId.make("thread-unrelated"),
        implementationRuns: [run({})],
      }),
    ).toBeNull();
  });

  it("prefers the most recently updated candidate", () => {
    const found = findCancelableImplementationRunForThread({
      threadId: ThreadId.make("thread-implementer"),
      implementationRuns: [
        run({ id: "run-old", updatedAt: "2026-03-28T00:00:00.000Z" }),
        run({ id: "run-new", updatedAt: "2026-03-30T00:00:00.000Z" }),
      ],
    });
    expect(found?.id).toBe("run-new");
  });
});

describe("resolveProductWorkflowPlanningThreadId", () => {
  it("selects the planning-orchestrator child for a Product Workflow root", () => {
    const planningThreadId = ThreadId.make("thread-product-planning");

    expect(
      resolveProductWorkflowPlanningThreadId({
        activeThread: makeThread({
          interactionMode: "product-workflow",
          workflowRole: null,
        }),
        workflowThreadShells: [
          {
            id: planningThreadId,
            parentThreadId: threadId,
            workflowRole: "planning-orchestrator",
          },
          {
            id: ThreadId.make("thread-product-reviewer"),
            parentThreadId: planningThreadId,
            workflowRole: "planning-reviewer",
          },
        ],
      }),
    ).toBe(planningThreadId);
  });

  it("does not select a child for non-root product threads", () => {
    expect(
      resolveProductWorkflowPlanningThreadId({
        activeThread: makeThread({
          interactionMode: "product-workflow",
          workflowRole: "planning-orchestrator",
          parentThreadId: threadId,
        }),
        workflowThreadShells: [
          {
            id: ThreadId.make("thread-nested-planning"),
            parentThreadId: threadId,
            workflowRole: "planning-orchestrator",
          },
        ],
      }),
    ).toBeNull();
  });
});

describe("deriveComposerSendState", () => {
  it("treats expired terminal pills as non-sendable content", () => {
    const state = deriveComposerSendState({
      prompt: "\uFFFC",
      imageCount: 0,
      terminalContexts: [
        {
          id: "ctx-expired",
          threadId,
          terminalId: "default",
          terminalLabel: "Terminal 1",
          lineStart: 4,
          lineEnd: 4,
          text: "",
          createdAt: now,
        },
      ],
    });

    expect(state.trimmedPrompt).toBe("");
    expect(state.sendableTerminalContexts).toEqual([]);
    expect(state.expiredTerminalContextCount).toBe(1);
    expect(state.hasSendableContent).toBe(false);
  });

  it("keeps text sendable while excluding expired terminal pills", () => {
    const state = deriveComposerSendState({
      prompt: `yoo \uFFFC waddup`,
      imageCount: 0,
      terminalContexts: [
        {
          id: "ctx-expired",
          threadId,
          terminalId: "default",
          terminalLabel: "Terminal 1",
          lineStart: 4,
          lineEnd: 4,
          text: "",
          createdAt: now,
        },
      ],
    });

    expect(state.trimmedPrompt).toBe("yoo  waddup");
    expect(state.expiredTerminalContextCount).toBe(1);
    expect(state.hasSendableContent).toBe(true);
  });

  it("treats element contexts as sendable content (no text, no images, no terminals)", () => {
    const state = deriveComposerSendState({
      prompt: "",
      imageCount: 0,
      terminalContexts: [],
      elementContextCount: 1,
    });

    expect(state.trimmedPrompt).toBe("");
    expect(state.expiredTerminalContextCount).toBe(0);
    expect(state.hasSendableContent).toBe(true);
  });

  it("does NOT treat zero element contexts as sendable", () => {
    expect(
      deriveComposerSendState({
        prompt: "",
        imageCount: 0,
        terminalContexts: [],
        elementContextCount: 0,
      }).hasSendableContent,
    ).toBe(false);
  });
});

describe("buildExpiredTerminalContextToastCopy", () => {
  it("formats empty and omission guidance", () => {
    expect(buildExpiredTerminalContextToastCopy(1, "empty")).toEqual({
      title: "Expired terminal context won't be sent",
      description: "Remove it or re-add it to include terminal output.",
    });
    expect(buildExpiredTerminalContextToastCopy(2, "omitted")).toEqual({
      title: "Expired terminal contexts omitted from message",
      description: "Re-add it if you want that terminal output included.",
    });
  });
});

describe("getStartedThreadModelChangeBlockReason", () => {
  const providers = [
    {
      instanceId: ProviderInstanceId.make("codex"),
    },
    {
      instanceId: ProviderInstanceId.make("grok"),
      requiresNewThreadForModelChange: true,
    },
  ];

  it("allows model changes before a provider session has started", () => {
    expect(
      getStartedThreadModelChangeBlockReason({
        providers,
        hasStartedSession: false,
        currentModelSelection: {
          instanceId: ProviderInstanceId.make("grok"),
          model: "grok-build",
        },
        nextModelSelection: {
          instanceId: ProviderInstanceId.make("grok"),
          model: "grok-other",
        },
      }),
    ).toBeNull();
  });

  it("allows unchanged model selections for restricted providers", () => {
    expect(
      getStartedThreadModelChangeBlockReason({
        providers,
        hasStartedSession: true,
        currentModelSelection: {
          instanceId: ProviderInstanceId.make("grok"),
          model: "grok-build",
        },
        nextModelSelection: {
          instanceId: ProviderInstanceId.make("grok"),
          model: "grok-build",
        },
      }),
    ).toBeNull();
  });

  it("blocks started-session model changes when either provider requires a new thread", () => {
    expect(
      getStartedThreadModelChangeBlockReason({
        providers,
        hasStartedSession: true,
        currentModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        },
        nextModelSelection: {
          instanceId: ProviderInstanceId.make("grok"),
          model: "grok-build",
        },
      }),
    ).toEqual({
      title: "Start a new chat to change models",
      description:
        "This provider does not allow switching models after a conversation has started.",
    });
  });
});

describe("resolveSendEnvMode", () => {
  it("keeps worktree mode only for git repositories", () => {
    expect(resolveSendEnvMode({ requestedEnvMode: "worktree", isGitRepo: true })).toBe("worktree");
    expect(resolveSendEnvMode({ requestedEnvMode: "worktree", isGitRepo: false })).toBe("local");
  });
});

describe("branchMismatchKey", () => {
  it("builds a key from thread id and both branches", () => {
    expect(branchMismatchKey("thread-1", { threadBranch: "feat/a", currentBranch: "feat/b" })).toBe(
      "thread-1:feat/a:feat/b",
    );
  });

  it("returns null without a thread or mismatch", () => {
    expect(branchMismatchKey(null, { threadBranch: "a", currentBranch: "b" })).toBeNull();
    expect(branchMismatchKey("thread-1", null)).toBeNull();
  });
});

describe("shouldShowBranchMismatchBanner", () => {
  const base = {
    hasMismatch: true,
    isDismissed: false,
    composerHasContent: false,
    wasShownForCurrentMismatch: false,
  };

  it("stays hidden during passive browsing (even though the composer autofocuses)", () => {
    expect(shouldShowBranchMismatchBanner(base)).toBe(false);
  });

  it("shows once the composer has draft content", () => {
    expect(shouldShowBranchMismatchBanner({ ...base, composerHasContent: true })).toBe(true);
  });

  it("stays mounted after the draft clears once shown for the current mismatch", () => {
    expect(shouldShowBranchMismatchBanner({ ...base, wasShownForCurrentMismatch: true })).toBe(
      true,
    );
  });

  it("never shows when dismissed or without a mismatch", () => {
    expect(
      shouldShowBranchMismatchBanner({ ...base, composerHasContent: true, isDismissed: true }),
    ).toBe(false);
    expect(
      shouldShowBranchMismatchBanner({ ...base, composerHasContent: true, hasMismatch: false }),
    ).toBe(false);
  });
});

describe("session branch mismatch dismissal", () => {
  it("tracks dismissed keys and treats other keys as active", () => {
    expect(isBranchMismatchDismissedForSession("t1:a:b")).toBe(false);
    dismissBranchMismatchForSession("t1:a:b");
    expect(isBranchMismatchDismissedForSession("t1:a:b")).toBe(true);
    expect(isBranchMismatchDismissedForSession("t1:a:c")).toBe(false);
    expect(isBranchMismatchDismissedForSession(null)).toBe(false);
  });
});

describe("reconcileMountedTerminalThreadIds", () => {
  it("keeps open threads and makes the active thread most recent", () => {
    expect(
      reconcileMountedTerminalThreadIds({
        currentThreadIds: ["thread-a", "thread-b", "thread-c"],
        openThreadIds: ["thread-a", "thread-b", "thread-c"],
        activeThreadId: "thread-a",
        activeThreadTerminalOpen: true,
        maxHiddenThreadCount: 2,
      }),
    ).toEqual(["thread-b", "thread-c", "thread-a"]);
  });

  it("drops closed threads and enforces the hidden mounted cap", () => {
    const ids = Array.from(
      { length: MAX_HIDDEN_MOUNTED_TERMINAL_THREADS + 2 },
      (_, index) => `thread-${index}`,
    );
    expect(
      reconcileMountedTerminalThreadIds({
        currentThreadIds: ids,
        openThreadIds: ids.slice(1),
        activeThreadId: null,
        activeThreadTerminalOpen: false,
      }),
    ).toEqual(ids.slice(-MAX_HIDDEN_MOUNTED_TERMINAL_THREADS));
  });
});

describe("reconcileRetainedMountedThreadIds", () => {
  it("retains hidden open threads and adds the active open thread", () => {
    expect(
      reconcileRetainedMountedThreadIds({
        currentThreadIds: [ThreadId.make("thread-hidden")],
        openThreadIds: [ThreadId.make("thread-hidden")],
        activeThreadId: ThreadId.make("thread-active"),
        activeThreadOpen: true,
        maxHiddenThreadCount: MAX_HIDDEN_MOUNTED_PREVIEW_THREADS,
      }),
    ).toEqual([ThreadId.make("thread-hidden"), ThreadId.make("thread-active")]);
  });

  it("can retain the active thread as hidden when it is inactive", () => {
    expect(
      reconcileRetainedMountedThreadIds({
        currentThreadIds: [ThreadId.make("thread-active")],
        openThreadIds: [ThreadId.make("thread-active")],
        activeThreadId: ThreadId.make("thread-active"),
        activeThreadOpen: false,
        maxHiddenThreadCount: MAX_HIDDEN_MOUNTED_PREVIEW_THREADS,
        retainInactiveActiveThread: true,
      }),
    ).toEqual([ThreadId.make("thread-active")]);
  });

  it("evicts the oldest hidden threads beyond the configured cap", () => {
    const currentThreadIds = Array.from(
      { length: MAX_HIDDEN_MOUNTED_PREVIEW_THREADS + 2 },
      (_, index) => ThreadId.make(`thread-${index + 1}`),
    );

    expect(
      reconcileRetainedMountedThreadIds({
        currentThreadIds,
        openThreadIds: currentThreadIds,
        activeThreadId: null,
        activeThreadOpen: false,
        maxHiddenThreadCount: MAX_HIDDEN_MOUNTED_PREVIEW_THREADS,
      }),
    ).toEqual(currentThreadIds.slice(-MAX_HIDDEN_MOUNTED_PREVIEW_THREADS));
  });
});

describe("shouldWriteThreadErrorToCurrentServerThread", () => {
  it("writes errors for a shell-derived active server thread", () => {
    const routeThreadRef = { environmentId, threadId };

    expect(
      shouldWriteThreadErrorToCurrentServerThread({
        activeServerThread: { environmentId, id: threadId },
        routeThreadRef,
        targetThreadId: threadId,
      }),
    ).toBe(true);
  });

  it("requires an active server thread matching the environment, route, and target", () => {
    const routeThreadRef = { environmentId, threadId };

    expect(
      shouldWriteThreadErrorToCurrentServerThread({
        activeServerThread: null,
        routeThreadRef,
        targetThreadId: threadId,
      }),
    ).toBe(false);
  });
});

describe("startNewThreadForProject", () => {
  it("starts a thread through the supplied shared handler for the active project", () => {
    const calls: Array<{ environmentId: EnvironmentId; projectId: ProjectId }> = [];
    const projectRef = { environmentId, projectId };

    expect(
      startNewThreadForProject(projectRef, (nextProjectRef) => {
        calls.push(nextProjectRef);
        return Promise.resolve();
      }),
    ).toBe(true);
    expect(calls).toEqual([projectRef]);
  });

  it("does nothing when the active project is unavailable", () => {
    let called = false;

    expect(
      startNewThreadForProject(null, () => {
        called = true;
        return Promise.resolve();
      }),
    ).toBe(false);
    expect(called).toBe(false);
  });
});

describe("hasServerAcknowledgedLocalDispatch", () => {
  it("does not acknowledge unchanged server state", () => {
    const localDispatch = createLocalDispatchSnapshot(
      makeThread({ latestTurn: completedTurn, session: readySession }),
    );

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "ready",
        latestTurn: completedTurn,
        latestUserMessageId: localDispatch.latestUserMessageId,
        session: readySession,
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(false);
  });

  it("acknowledges a settled newer turn", () => {
    const localDispatch = createLocalDispatchSnapshot(
      makeThread({ latestTurn: completedTurn, session: readySession }),
    );
    const newerTurn = {
      ...completedTurn,
      turnId: TurnId.make("turn-2"),
      requestedAt: "2026-03-29T00:01:00.000Z",
      startedAt: "2026-03-29T00:01:01.000Z",
      completedAt: "2026-03-29T00:01:30.000Z",
    };

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "ready",
        latestTurn: newerTurn,
        latestUserMessageId: localDispatch.latestUserMessageId,
        session: { ...readySession, updatedAt: newerTurn.completedAt },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(true);
  });

  it("waits for the matching running turn before acknowledging", () => {
    const localDispatch = createLocalDispatchSnapshot(
      makeThread({ latestTurn: completedTurn, session: readySession }),
    );
    const runningTurn = {
      ...completedTurn,
      turnId: TurnId.make("turn-2"),
      state: "running" as const,
      requestedAt: "2026-03-29T00:01:00.000Z",
      startedAt: "2026-03-29T00:01:01.000Z",
      completedAt: null,
    };

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "running",
        latestTurn: runningTurn,
        latestUserMessageId: localDispatch.latestUserMessageId,
        session: {
          ...readySession,
          status: "running",
          activeTurnId: TurnId.make("turn-other"),
        },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(false);
    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "running",
        latestTurn: runningTurn,
        latestUserMessageId: localDispatch.latestUserMessageId,
        session: {
          ...readySession,
          status: "running",
          activeTurnId: runningTurn.turnId,
        },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(true);
  });

  it("acknowledges a steering message projected onto the current running turn", () => {
    const runningTurn = {
      ...completedTurn,
      state: "running" as const,
      completedAt: null,
    };
    const runningSession = {
      ...readySession,
      status: "running" as const,
      activeTurnId: runningTurn.turnId,
    };
    const localDispatch = createLocalDispatchSnapshot(
      makeThread({
        latestTurn: runningTurn,
        session: runningSession,
        messages: [
          {
            id: MessageId.make("message-before-steer"),
            role: "user",
            text: "Initial prompt",
            turnId: runningTurn.turnId,
            createdAt: runningTurn.requestedAt,
            updatedAt: runningTurn.requestedAt,
            streaming: false,
          },
        ],
      }),
    );

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "running",
        latestTurn: runningTurn,
        latestUserMessageId: MessageId.make("message-steer"),
        session: runningSession,
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(true);
  });

  it("acknowledges pending user interaction and errors immediately", () => {
    const localDispatch = createLocalDispatchSnapshot(makeThread());
    const common = {
      localDispatch,
      phase: "ready" as const,
      latestTurn: null,
      latestUserMessageId: localDispatch.latestUserMessageId,
      session: null,
      hasPendingApproval: false,
      hasPendingUserInput: false,
      threadError: null,
    };

    expect(hasServerAcknowledgedLocalDispatch({ ...common, hasPendingApproval: true })).toBe(true);
    expect(hasServerAcknowledgedLocalDispatch({ ...common, hasPendingUserInput: true })).toBe(true);
    expect(hasServerAcknowledgedLocalDispatch({ ...common, threadError: "failed" })).toBe(true);
  });
});
