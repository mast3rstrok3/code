import { AtomRegistry } from "effect/unstable/reactivity";
import { afterEach, describe, expect, it } from "vitest";

import type { TerminalSessionSnapshot } from "@t3tools/contracts";

import { createTerminalSessionManager } from "./terminalSessionState";

let atomRegistry = AtomRegistry.make();

function resetAtomRegistry() {
  atomRegistry.dispose();
  atomRegistry = AtomRegistry.make();
}

const TARGET = {
  environmentId: "env-local",
  threadId: "thread-1",
  terminalId: "default",
} as const;

const BASE_SNAPSHOT: TerminalSessionSnapshot = {
  threadId: TARGET.threadId,
  terminalId: TARGET.terminalId,
  cwd: "/repo",
  worktreePath: null,
  status: "running",
  pid: 123,
  history: "hello",
  exitCode: null,
  exitSignal: null,
  updatedAt: "2026-04-01T00:00:00.000Z",
};

describe("createTerminalSessionManager", () => {
  afterEach(() => {
    resetAtomRegistry();
  });

  it("hydrates from started snapshots and appends output events", () => {
    const manager = createTerminalSessionManager({
      getRegistry: () => atomRegistry,
    });

    manager.applyEvent(TARGET, {
      type: "started",
      threadId: TARGET.threadId,
      terminalId: TARGET.terminalId,
      createdAt: BASE_SNAPSHOT.updatedAt,
      snapshot: BASE_SNAPSHOT,
    });
    manager.applyEvent(TARGET, {
      type: "output",
      threadId: TARGET.threadId,
      terminalId: TARGET.terminalId,
      createdAt: "2026-04-01T00:00:01.000Z",
      data: " world",
    });

    expect(manager.getSnapshot(TARGET)).toMatchObject({
      snapshot: BASE_SNAPSHOT,
      buffer: "hello world",
      status: "running",
      error: null,
      updatedAt: "2026-04-01T00:00:01.000Z",
    });
  });

  it("caps retained output", () => {
    const manager = createTerminalSessionManager({
      getRegistry: () => atomRegistry,
      maxBufferBytes: 5,
    });

    manager.applyEvent(TARGET, {
      type: "output",
      threadId: TARGET.threadId,
      terminalId: TARGET.terminalId,
      createdAt: "2026-04-01T00:00:01.000Z",
      data: "abcdef",
    });

    expect(manager.getSnapshot(TARGET).buffer).toBe("bcdef");
  });

  it("caps retained output by utf-8 byte length", () => {
    const manager = createTerminalSessionManager({
      getRegistry: () => atomRegistry,
      maxBufferBytes: 4,
    });

    manager.applyEvent(TARGET, {
      type: "output",
      threadId: TARGET.threadId,
      terminalId: TARGET.terminalId,
      createdAt: "2026-04-01T00:00:01.000Z",
      data: "🙂🙂",
    });

    expect(manager.getSnapshot(TARGET).buffer).toBe("🙂");
  });

  it("invalidates one environment without clearing others", () => {
    const manager = createTerminalSessionManager({
      getRegistry: () => atomRegistry,
    });
    const otherTarget = {
      environmentId: "env-remote",
      threadId: "thread-1",
      terminalId: "default",
    } as const;

    for (const target of [TARGET, otherTarget]) {
      manager.applyEvent(target, {
        type: "output",
        threadId: target.threadId,
        terminalId: target.terminalId,
        createdAt: "2026-04-01T00:00:01.000Z",
        data: target.environmentId,
      });
    }

    manager.invalidateEnvironment(TARGET.environmentId);

    expect(manager.getSnapshot(TARGET).buffer).toBe("");
    expect(manager.getSnapshot(otherTarget).buffer).toBe("env-remote");
  });

  it("lists known sessions for a thread ordered by recency", () => {
    const manager = createTerminalSessionManager({
      getRegistry: () => atomRegistry,
    });

    manager.applyEvent(TARGET, {
      type: "started",
      threadId: TARGET.threadId,
      terminalId: TARGET.terminalId,
      createdAt: "2026-04-01T00:00:00.000Z",
      snapshot: BASE_SNAPSHOT,
    });
    manager.applyEvent(
      {
        environmentId: TARGET.environmentId,
      },
      {
        type: "started",
        threadId: TARGET.threadId,
        terminalId: "term-2",
        createdAt: "2026-04-01T00:00:02.000Z",
        snapshot: {
          ...BASE_SNAPSHOT,
          terminalId: "term-2",
          updatedAt: "2026-04-01T00:00:02.000Z",
        },
      },
    );

    expect(
      manager
        .listSessions({
          environmentId: TARGET.environmentId,
          threadId: TARGET.threadId,
        })
        .map((session) => session.target.terminalId),
    ).toEqual(["term-2", "default"]);
  });

  it("drops known sessions when an environment is invalidated", () => {
    const manager = createTerminalSessionManager({
      getRegistry: () => atomRegistry,
    });

    manager.applyEvent(TARGET, {
      type: "output",
      threadId: TARGET.threadId,
      terminalId: TARGET.terminalId,
      createdAt: "2026-04-01T00:00:01.000Z",
      data: "hello",
    });

    manager.invalidateEnvironment(TARGET.environmentId);

    expect(
      manager.listSessions({
        environmentId: TARGET.environmentId,
        threadId: TARGET.threadId,
      }),
    ).toEqual([]);
  });

  it("removes closed sessions from the known-session index while keeping local closed state", () => {
    const manager = createTerminalSessionManager({
      getRegistry: () => atomRegistry,
    });

    manager.applyEvent(TARGET, {
      type: "started",
      threadId: TARGET.threadId,
      terminalId: TARGET.terminalId,
      createdAt: BASE_SNAPSHOT.updatedAt,
      snapshot: BASE_SNAPSHOT,
    });

    manager.applyEvent(TARGET, {
      type: "closed",
      threadId: TARGET.threadId,
      terminalId: TARGET.terminalId,
      createdAt: "2026-04-01T00:00:04.000Z",
    });

    expect(
      manager.listSessions({
        environmentId: TARGET.environmentId,
        threadId: TARGET.threadId,
      }),
    ).toEqual([]);
    expect(manager.getSnapshot(TARGET)).toMatchObject({
      buffer: "hello",
      status: "closed",
      snapshot: null,
      updatedAt: "2026-04-01T00:00:04.000Z",
    });
  });

  it("clears locally retained closed state on reset", () => {
    const manager = createTerminalSessionManager({
      getRegistry: () => atomRegistry,
    });

    manager.applyEvent(TARGET, {
      type: "started",
      threadId: TARGET.threadId,
      terminalId: TARGET.terminalId,
      createdAt: BASE_SNAPSHOT.updatedAt,
      snapshot: BASE_SNAPSHOT,
    });
    manager.applyEvent(TARGET, {
      type: "closed",
      threadId: TARGET.threadId,
      terminalId: TARGET.terminalId,
      createdAt: "2026-04-01T00:00:04.000Z",
    });

    manager.reset();

    expect(manager.getSnapshot(TARGET)).toEqual({
      snapshot: null,
      buffer: "",
      status: "closed",
      error: null,
      hasRunningSubprocess: false,
      updatedAt: null,
      version: 0,
    });
  });

  it("syncs snapshots returned from open calls immediately", () => {
    const manager = createTerminalSessionManager({
      getRegistry: () => atomRegistry,
    });

    manager.syncSnapshot(
      { environmentId: TARGET.environmentId },
      {
        ...BASE_SNAPSHOT,
        history: "prompt$ ",
        updatedAt: "2026-04-01T00:00:03.000Z",
      },
    );

    expect(manager.getSnapshot(TARGET)).toMatchObject({
      buffer: "prompt$ ",
      status: "running",
      updatedAt: "2026-04-01T00:00:03.000Z",
    });
  });
});
