import { describe, expect, it } from "vite-plus/test";

import { buildWorktreeRuntimeContext } from "./worktreeRuntimeContext.ts";

describe("buildWorktreeRuntimeContext", () => {
  it("marks workflow stacks as pending until Build succeeds", () => {
    const context = buildWorktreeRuntimeContext({
      worktreePath: "/worktrees/rudi/worktree-deadbeef",
      branch: "verify-email-capabilities",
      workflowPreset: "fast-feature",
      stackLookup: { stack: null, frontendUrl: null, frontendServiceName: null },
    });

    expect(context).toContain("Worktree path: /worktrees/rudi/worktree-deadbeef");
    expect(context).toContain("Git branch: verify-email-capabilities");
    expect(context).toContain("pending Build");
    expect(context).toContain("do not substitute another runtime");
  });

  it("injects the exact running stack identity and frontend URL", () => {
    const context = buildWorktreeRuntimeContext({
      worktreePath: "/worktrees/rudi/worktree-deadbeef",
      branch: "verify-email-capabilities",
      workflowPreset: "fast-feature",
      stackLookup: {
        stack: {
          id: "stack-123",
          uuid: "stack-123",
          userId: "user-1",
          worktreePath: "/worktrees/rudi/worktree-deadbeef",
          composePath: "compose.app-dev.yml",
          displayName: "Verify email capabilities",
          description: null,
          status: "running",
          services: [],
          serviceCount: 0,
          lastError: null,
          errorCount: 0,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:01:00.000Z",
        },
        frontendUrl: "https://verify-email.example.test",
        frontendServiceName: "frontend",
      },
    });

    expect(context).toContain("App Dev Stack id: stack-123");
    expect(context).toContain("App Dev Stack name: Verify email capabilities");
    expect(context).toContain("App Dev Stack status: running");
    expect(context).toContain("App Dev Stack URL: https://verify-email.example.test");
    expect(context).toContain("only authoritative runtime and browser target");
  });
});
