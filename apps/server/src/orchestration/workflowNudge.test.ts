import { expect, it } from "@effect/vitest";

import {
  isAwaitingWorkflowNudge,
  isBlockedAfterFailedTurn,
  isWorkflowNudgeCandidate,
  workflowNudgeDelayMs,
  WORKFLOW_NUDGE_DEFERRAL_WINDOW_MS,
  WORKFLOW_NUDGE_EXHAUSTED_MESSAGE,
  WORKFLOW_NUDGE_FIRST_DELAY_MS,
  WORKFLOW_NUDGE_INTERVAL_MS,
  type WorkflowNudgeThread,
} from "./workflowNudge.ts";

const blockedAt = "2026-01-01T00:00:00.000Z";
const nowMs = Date.parse(blockedAt) + 60_000;

function thread(overrides: Partial<WorkflowNudgeThread> = {}): WorkflowNudgeThread {
  return {
    id: "worker",
    parentThreadId: "orchestrator",
    settledOverride: null,
    workflowRole: "implementation-worker",
    deletedAt: null,
    session: {
      status: "stopped",
      activeTurnId: null,
      lastError: "Claude AI usage limit reached",
      updatedAt: blockedAt,
    },
    latestTurn: { state: "error" },
    ...overrides,
  };
}

const withThread = (entry: WorkflowNudgeThread) => ({
  threads: [{ id: "orchestrator", parentThreadId: null, settledOverride: null }, entry].map(
    (candidate) => candidate as WorkflowNudgeThread,
  ),
  thread: entry,
});

it("reads a terminated failed turn as blocked, whatever the provider did with its session", () => {
  // Claude tears the session down after an API failure; others leave it errored.
  expect(isBlockedAfterFailedTurn(thread({ session: null }))).toBe(false);
  expect(isBlockedAfterFailedTurn(thread())).toBe(true);
  expect(
    isBlockedAfterFailedTurn(
      thread({
        session: { status: "error", activeTurnId: null, lastError: "boom", updatedAt: blockedAt },
      }),
    ),
  ).toBe(true);
});

it("claims a failed session that still names the turn it gave up on", () => {
  // The provider reports the failure, then clears the active turn. A stage
  // owner reconciling between the two used to see a thread nobody would nudge.
  expect(
    isBlockedAfterFailedTurn(
      thread({
        session: {
          status: "error",
          activeTurnId: "turn-1",
          lastError: "You've hit your usage limit.",
          updatedAt: blockedAt,
        },
      }),
    ),
  ).toBe(true);
  expect(
    isBlockedAfterFailedTurn(
      thread({
        session: {
          status: "stopped",
          activeTurnId: "turn-1",
          lastError: "boom",
          updatedAt: blockedAt,
        },
      }),
    ),
  ).toBe(true);
});

it("leaves running, interrupted and never-started threads alone", () => {
  const running = thread({
    session: { status: "running", activeTurnId: "turn-1", lastError: null, updatedAt: blockedAt },
    latestTurn: { state: "running" },
  });
  const interrupted = thread({ latestTurn: { state: "interrupted" } });
  const completed = thread({ latestTurn: { state: "completed" } });
  const neverStarted = thread({ latestTurn: null });

  for (const entry of [running, interrupted, completed, neverStarted]) {
    expect(isBlockedAfterFailedTurn(entry)).toBe(false);
    expect(isWorkflowNudgeCandidate(withThread(entry))).toBe(false);
  }
});

it("only nudges the roles a workflow drives on its own", () => {
  expect(isWorkflowNudgeCandidate(withThread(thread()))).toBe(true);
  expect(isWorkflowNudgeCandidate(withThread(thread({ workflowRole: null })))).toBe(false);
  // A human may be mid-conversation in the orchestrator thread.
  expect(
    isWorkflowNudgeCandidate(withThread(thread({ workflowRole: "implementation-orchestrator" }))),
  ).toBe(false);
});

it("does not nudge inside a paused subtree", () => {
  const worker = thread();
  const threads: ReadonlyArray<WorkflowNudgeThread> = [
    { ...thread({ id: "orchestrator", parentThreadId: null }), settledOverride: "settled" },
    worker,
  ];

  expect(isWorkflowNudgeCandidate({ threads, thread: worker })).toBe(false);
});

it("stops once the nudge path has given up", () => {
  const exhausted = thread({
    session: {
      status: "error",
      activeTurnId: null,
      lastError: WORKFLOW_NUDGE_EXHAUSTED_MESSAGE,
      updatedAt: blockedAt,
    },
  });

  expect(isWorkflowNudgeCandidate(withThread(exhausted))).toBe(false);
  expect(isAwaitingWorkflowNudge({ ...withThread(exhausted), nowMs })).toBe(false);
});

it("hands a thread back to its stage owner once nudging stops refreshing it", () => {
  const worker = thread();

  expect(isAwaitingWorkflowNudge({ ...withThread(worker), nowMs })).toBe(true);
  expect(
    isAwaitingWorkflowNudge({
      ...withThread(worker),
      nowMs: Date.parse(blockedAt) + WORKFLOW_NUDGE_DEFERRAL_WINDOW_MS,
    }),
  ).toBe(false);
});

it("retries fast once, then slowly", () => {
  expect(workflowNudgeDelayMs(0)).toBe(WORKFLOW_NUDGE_FIRST_DELAY_MS);
  expect(workflowNudgeDelayMs(1)).toBe(WORKFLOW_NUDGE_INTERVAL_MS);
  // The window has to outlast the cadence, or an owner would stop deferring
  // between two nudges.
  expect(WORKFLOW_NUDGE_DEFERRAL_WINDOW_MS).toBeGreaterThan(WORKFLOW_NUDGE_INTERVAL_MS);
});
