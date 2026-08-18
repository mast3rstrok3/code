import { expect, it } from "@effect/vitest";

import { isWorkflowThreadPaused, type WorkflowPauseThread } from "./workflowPause.ts";

const thread = (
  id: string,
  parentThreadId: string | null,
  settledOverride: WorkflowPauseThread["settledOverride"] = null,
): WorkflowPauseThread => ({ id, parentThreadId, settledOverride });

it("reports a thread paused when it or any ancestor is settled", () => {
  const threads = [
    thread("root", null, "settled"),
    thread("orchestrator", "root"),
    thread("worker", "orchestrator"),
  ];

  expect(isWorkflowThreadPaused(threads, "root")).toBe(true);
  expect(isWorkflowThreadPaused(threads, "orchestrator")).toBe(true);
  expect(isWorkflowThreadPaused(threads, "worker")).toBe(true);
});

it("keeps siblings of a paused subtree runnable", () => {
  // Stop step pauses one branch of the run; the rest of the workflow keeps going.
  const threads = [
    thread("root", null),
    thread("orchestrator", "root"),
    thread("paused-worker", "orchestrator", "settled"),
    thread("paused-reviewer", "paused-worker"),
    thread("other-worker", "orchestrator"),
  ];

  expect(isWorkflowThreadPaused(threads, "paused-reviewer")).toBe(true);
  expect(isWorkflowThreadPaused(threads, "other-worker")).toBe(false);
  expect(isWorkflowThreadPaused(threads, "orchestrator")).toBe(false);
});

it("treats a thread pinned active as running, not paused", () => {
  const threads = [thread("root", null, "active"), thread("child", "root")];

  expect(isWorkflowThreadPaused(threads, "child")).toBe(false);
});

it("does not pause on unknown ids or cycles", () => {
  expect(isWorkflowThreadPaused([thread("root", null, "settled")], "missing")).toBe(false);
  // A parent cycle must terminate rather than hang the sweep that calls this.
  const cyclic = [thread("a", "b"), thread("b", "a")];
  expect(isWorkflowThreadPaused(cyclic, "a")).toBe(false);
});
