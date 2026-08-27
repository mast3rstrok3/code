import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import {
  STAGE_CLAIM_GRACE_MS,
  stageClaimBlocksRestart,
  stageClaimIsReleased,
  stageClaimState,
  type StageClaimThread,
} from "./stageClaim.ts";

const nowMs = Date.parse("2026-01-01T12:00:00.000Z");
const at = (offsetMs: number) => DateTime.formatIso(DateTime.makeUnsafe(nowMs + offsetMs));

const thread = (overrides: Partial<StageClaimThread> = {}): StageClaimThread => ({
  id: "thread-stage-owner",
  parentThreadId: "thread-orchestrator",
  workflowRole: "implementation-validator",
  deletedAt: null,
  createdAt: at(-STAGE_CLAIM_GRACE_MS * 2),
  session: null,
  latestTurn: null,
  ...overrides,
});

const session = (overrides: Partial<NonNullable<StageClaimThread["session"]>> = {}) => ({
  status: "ready",
  activeTurnId: null,
  lastError: null,
  updatedAt: at(0),
  ...overrides,
});

const stateOf = (candidate: StageClaimThread | undefined) =>
  stageClaimState({ thread: candidate, threads: candidate ? [candidate] : [], nowMs });

it("reports a stage nothing owns as unclaimed", () => {
  expect(stateOf(undefined)).toBe("unclaimed");
});

it("reports a working owner while its session or turn is live", () => {
  expect(stateOf(thread({ session: session({ status: "starting" }) }))).toBe("starting");
  expect(stateOf(thread({ session: session({ status: "running" }) }))).toBe("working");
  expect(
    stateOf(thread({ session: session({ status: "ready" }), latestTurn: { state: "running" } })),
  ).toBe("working");
});

it("gives an idle owner the grace window before releasing it", () => {
  const resting = thread({ session: session({ status: "ready", updatedAt: at(-1_000) }) });
  expect(stateOf(resting)).toBe("settling");

  const quiet = thread({
    session: session({ status: "ready", updatedAt: at(-STAGE_CLAIM_GRACE_MS) }),
  });
  expect(stateOf(quiet)).toBe("released");
});

it("gives an owner that never reported the same window, then releases it", () => {
  const queued = thread({ createdAt: at(-1_000) });
  expect(stateOf(queued)).toBe("settling");
  expect(stateOf(thread({ createdAt: at(-STAGE_CLAIM_GRACE_MS) }))).toBe("released");
});

it("releases an owner whose session actually ended, without waiting", () => {
  for (const status of ["stopped", "error", "interrupted"]) {
    expect(stateOf(thread({ session: session({ status, updatedAt: at(0) }) }))).toBe("released");
  }
  expect(stateOf(thread({ deletedAt: at(0) }))).toBe("released");
});

/**
 * The two policies exist because the questions differ, but they must not
 * disagree about direction: anything a sweep is allowed to relaunch on, a user
 * is allowed to re-run. This is the property that broke when each guard derived
 * its own answer.
 */
it("never lets automatic recovery act where a user's re-run would be refused", () => {
  const states = [
    "unclaimed",
    "starting",
    "working",
    "awaiting-nudge",
    "settling",
    "released",
  ] as const;
  for (const state of states) {
    if (stageClaimIsReleased(state)) {
      expect(stageClaimBlocksRestart(state)).toBe(false);
    }
  }
});

it("keeps a re-run available on an owner recovery still has to wait out", () => {
  // The gap is deliberate: a stage resting between turns is one the user may
  // take over, and refusing there removes the main lever for unsticking a run.
  expect(stageClaimBlocksRestart("settling")).toBe(false);
  expect(stageClaimIsReleased("settling")).toBe(false);
  expect(stageClaimBlocksRestart("awaiting-nudge")).toBe(false);
  expect(stageClaimIsReleased("awaiting-nudge")).toBe(false);
});
