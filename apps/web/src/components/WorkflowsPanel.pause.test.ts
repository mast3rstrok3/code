import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { describe, expect, it } from "vite-plus/test";

import { runningThreadIdsOf, workflowPauseOf } from "./WorkflowsPanel";

const PAUSED_AT = "2026-08-19T20:07:42.541Z";

const thread = (
  id: string,
  parentThreadId: string | null,
  workflowPausedAt: string | null = null,
): EnvironmentThreadShell =>
  ({ id, parentThreadId, workflowPausedAt }) as unknown as EnvironmentThreadShell;

describe("workflowPauseOf", () => {
  const all = [
    thread("root", null),
    thread("orchestrator", "root"),
    thread("worker-1", "orchestrator", PAUSED_AT),
    thread("reviewer-1", "worker-1"),
    thread("worker-2", "orchestrator"),
  ];

  it("reads a row as paused only when everything in it is stopped", () => {
    expect(workflowPauseOf(all, [thread("worker-1", "orchestrator", PAUSED_AT)]).paused).toBe(true);
    // A wave with one stopped ticket is still a running wave.
    expect(
      workflowPauseOf(all, [
        thread("worker-1", "orchestrator", PAUSED_AT),
        thread("worker-2", "orchestrator"),
      ]).paused,
    ).toBe(false);
  });

  it("resolves Resume to the scope the user stopped, not the row that shows it", () => {
    const pause = workflowPauseOf(all, [thread("reviewer-1", "worker-1")]);

    expect(pause.paused).toBe(true);
    expect(pause.scopeThreadIds).toEqual(["worker-1"]);
  });

  it("collects each scope once when a row spans more than one", () => {
    const threads = [
      thread("root", null, PAUSED_AT),
      thread("orchestrator", "root"),
      thread("worker-a", "orchestrator", PAUSED_AT),
      thread("worker-b", "orchestrator"),
    ];
    const pause = workflowPauseOf(threads, [
      thread("worker-a", "orchestrator", PAUSED_AT),
      thread("worker-b", "orchestrator"),
    ]);

    expect(pause.paused).toBe(true);
    expect([...pause.scopeThreadIds].toSorted()).toEqual(["root", "worker-a"]);
  });

  it("leaves an empty row alone rather than calling it paused", () => {
    expect(workflowPauseOf(all, [])).toEqual({ scopeThreadIds: [], paused: false });
  });
});

describe("runningThreadIdsOf", () => {
  const running = (id: string, parentThreadId: string | null, workflowPausedAt: string | null) =>
    ({
      id,
      parentThreadId,
      workflowPausedAt,
      session: { status: "running" },
    }) as unknown as EnvironmentThreadShell;

  it("ignores a thread under a pause, so a stopped scope never reads as busy", () => {
    // The session row can outlive the agent: the provider's last write is lost
    // when the server restarts before it lands. Counting it would leave a
    // stopped wave looking busy, with Clear and Start refusing to touch it.
    const all = [
      running("root", null, PAUSED_AT),
      running("orchestrator", "root", null),
      running("worker", "orchestrator", null),
    ];

    expect(runningThreadIdsOf(all, [all[2]!])).toEqual([]);
  });

  it("still reports work outside the paused scope", () => {
    const all = [
      running("root", null, null),
      running("paused-worker", "root", PAUSED_AT),
      running("other-worker", "root", null),
    ];

    expect(runningThreadIdsOf(all, [all[1]!, all[2]!])).toEqual(["other-worker"]);
  });
});
