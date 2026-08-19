import { expect, it } from "@effect/vitest";

import {
  findWorkflowPauseScope,
  isWorkflowThreadPaused,
  type WorkflowPauseThread,
} from "./orchestration.ts";

const PAUSED_AT = "2026-08-19T20:07:42.541Z";

const thread = (
  id: string,
  parentThreadId: string | null,
  workflowPausedAt: string | null = null,
): WorkflowPauseThread => ({ id, parentThreadId, workflowPausedAt });

it("reports a thread paused when it or any ancestor is paused", () => {
  const threads = [
    thread("root", null, PAUSED_AT),
    thread("orchestrator", "root"),
    thread("worker", "orchestrator"),
  ];

  expect(isWorkflowThreadPaused(threads, "root")).toBe(true);
  expect(isWorkflowThreadPaused(threads, "orchestrator")).toBe(true);
  expect(isWorkflowThreadPaused(threads, "worker")).toBe(true);
});

it("keeps siblings of a paused subtree runnable", () => {
  // Stop on a ticket pauses one branch of the run; the rest keeps going.
  const threads = [
    thread("root", null),
    thread("orchestrator", "root"),
    thread("paused-worker", "orchestrator", PAUSED_AT),
    thread("paused-reviewer", "paused-worker"),
    thread("other-worker", "orchestrator"),
  ];

  expect(isWorkflowThreadPaused(threads, "paused-reviewer")).toBe(true);
  expect(isWorkflowThreadPaused(threads, "other-worker")).toBe(false);
  expect(isWorkflowThreadPaused(threads, "orchestrator")).toBe(false);
});

it("names the scope a pause came from, so a client can offer Resume there", () => {
  const threads = [
    thread("root", null),
    thread("orchestrator", "root"),
    thread("paused-worker", "orchestrator", PAUSED_AT),
    thread("reviewer", "paused-worker"),
  ];

  expect(findWorkflowPauseScope(threads, "reviewer")?.id).toBe("paused-worker");
  expect(findWorkflowPauseScope(threads, "orchestrator")).toBe(null);
});

it("reads the pause mark, not a settle that any activity clears", () => {
  // The bug this field exists for: a stopped agent's trailing session write
  // un-settles its thread, and the run used to read that as a resume.
  const threads = [thread("root", null, PAUSED_AT), thread("worker", "root")];

  expect(isWorkflowThreadPaused(threads, "worker")).toBe(true);
});

it("treats a thread with no mark anywhere above it as running", () => {
  const threads = [thread("root", null), thread("worker", "root")];

  expect(isWorkflowThreadPaused(threads, "worker")).toBe(false);
});

it("does not pause on unknown ids or cycles", () => {
  expect(isWorkflowThreadPaused([thread("root", null, PAUSED_AT)], "missing")).toBe(false);
  // A parent cycle must terminate rather than hang the sweep that calls this.
  const cyclic = [thread("a", "b"), thread("b", "a")];
  expect(isWorkflowThreadPaused(cyclic, "a")).toBe(false);
});
