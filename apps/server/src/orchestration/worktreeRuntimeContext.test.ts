import { describe, expect, it } from "vite-plus/test";

import { buildWorktreeRuntimeContext } from "./worktreeRuntimeContext.ts";

describe("buildWorktreeRuntimeContext", () => {
  it("marks workflow stacks as pending until workspace dependencies are ready", () => {
    const context = buildWorktreeRuntimeContext({
      worktreePath: "/worktrees/rudi/worktree-deadbeef",
      branch: "verify-email-capabilities",
      workflowPreset: "quick-plan",
      stackLookup: { stack: null, frontendUrl: null, frontendServiceName: null },
    });

    expect(context).toContain("Worktree path: /worktrees/rudi/worktree-deadbeef");
    expect(context).toContain("Git branch: verify-email-capabilities");
    expect(context).toContain("pending workspace dependency readiness");
    expect(context).toContain("do not substitute another runtime");
  });

  it("reports dependency setup failure instead of claiming the stack is merely pending", () => {
    const context = buildWorktreeRuntimeContext({
      worktreePath: "/worktrees/rudi/worktree-deadbeef",
      branch: "verify-email-capabilities",
      workflowPreset: "full-feature",
      stackLookup: { stack: null, frontendUrl: null, frontendServiceName: null },
      setupFailureDetail: "install exited with code 1",
    });

    expect(context).toContain("blocked because workspace dependency setup failed");
    expect(context).toContain("install exited with code 1");
    expect(context).not.toContain("pending workspace dependency readiness");
  });

  it("reports an early stack startup failure for the exact worktree", () => {
    const context = buildWorktreeRuntimeContext({
      worktreePath: "/worktrees/rudi/worktree-deadbeef",
      branch: "verify-email-capabilities",
      workflowPreset: "fast-feature",
      stackLookup: { stack: null, frontendUrl: null, frontendServiceName: null },
      stackFailureDetail: "compose contract missing",
    });

    expect(context).toContain("startup failed for this worktree");
    expect(context).toContain("compose contract missing");
    expect(context).not.toContain("pending workspace dependency readiness");
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

    expect(context).toContain("App Stack id: stack-123");
    expect(context).toContain("App Stack name: Verify email capabilities");
    expect(context).toContain("App Stack status: running");
    expect(context).toContain("App Stack URL: https://verify-email.example.test");
    expect(context).toContain("only authoritative runtime and browser target");
  });

  it("does not authorize runtime evidence from a stack that is still starting", () => {
    const context = buildWorktreeRuntimeContext({
      worktreePath: "/worktrees/rudi/worktree-deadbeef",
      branch: "verify-email-capabilities",
      workflowPreset: "planning",
      stackLookup: {
        stack: {
          id: "stack-123",
          uuid: "stack-123",
          userId: "user-1",
          worktreePath: "/worktrees/rudi/worktree-deadbeef",
          composePath: "compose.app-dev.yml",
          displayName: "Verify email capabilities",
          description: null,
          status: "starting",
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

    expect(context).toContain("App Stack status: starting");
    expect(context).toContain("Until this worktree's App Stack is healthy");
    expect(context).not.toContain("only authoritative runtime and browser target");
  });
});
