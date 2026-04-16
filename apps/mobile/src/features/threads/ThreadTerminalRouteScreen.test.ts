import { describe, expect, it } from "vitest";

import { resolveTerminalRouteBootstrap } from "./terminalRouteBootstrap";

describe("resolveTerminalRouteBootstrap", () => {
  it("redirects bare terminal routes to another already-running terminal for the thread", () => {
    expect(
      resolveTerminalRouteBootstrap({
        hasThread: true,
        hasWorkspaceRoot: true,
        hasOpened: false,
        requestedTerminalId: null,
        currentTerminalId: "default",
        runningTerminalId: "term-2",
      }),
    ).toEqual({
      kind: "redirect",
      terminalId: "term-2",
    });
  });

  it("hydrates the current running terminal instead of skipping open", () => {
    expect(
      resolveTerminalRouteBootstrap({
        hasThread: true,
        hasWorkspaceRoot: true,
        hasOpened: false,
        requestedTerminalId: null,
        currentTerminalId: "default",
        runningTerminalId: "default",
      }),
    ).toEqual({
      kind: "open",
    });
  });

  it("opens explicit terminal routes once so they replay existing history", () => {
    expect(
      resolveTerminalRouteBootstrap({
        hasThread: true,
        hasWorkspaceRoot: true,
        hasOpened: false,
        requestedTerminalId: "term-2",
        currentTerminalId: "term-2",
        runningTerminalId: "term-2",
      }),
    ).toEqual({
      kind: "open",
    });
  });

  it("stays idle after the route already bootstrapped once", () => {
    expect(
      resolveTerminalRouteBootstrap({
        hasThread: true,
        hasWorkspaceRoot: true,
        hasOpened: true,
        requestedTerminalId: null,
        currentTerminalId: "default",
        runningTerminalId: "default",
      }),
    ).toEqual({
      kind: "idle",
    });
  });
});
