import {
  DEFAULT_WORKSPACE_USER_ID,
  type OrchestrationThreadShell,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  WorkflowId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  activeThreadsSharingWorkspace,
  buildWorktreeRuntimeContext,
} from "./worktreeRuntimeContext.ts";

const now = "2026-10-06T12:00:00.000Z";
const projectId = ProjectId.make("project-rudi");
const projects = [{ id: projectId, workspaceRoot: "/repos/rudi" }];

const threadShell = (
  id: string,
  overrides: Partial<OrchestrationThreadShell> = {},
): OrchestrationThreadShell => ({
  id: ThreadId.make(id),
  projectId,
  ownerUserId: DEFAULT_WORKSPACE_USER_ID,
  parentThreadId: null,
  workflowRole: null,
  title: id,
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  pullRequests: [],
  latestTurn: null,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  session: null,
  latestUserMessageAt: now,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
  ...overrides,
});

const sharing = (
  thread: OrchestrationThreadShell,
  others: ReadonlyArray<OrchestrationThreadShell>,
  workspacePath = "/repos/rudi",
) =>
  activeThreadsSharingWorkspace({
    thread,
    workspacePath,
    threads: [thread, ...others],
    projects,
    nowMs: Date.parse(now),
  });

describe("activeThreadsSharingWorkspace", () => {
  it("finds another active local thread in the project root", () => {
    expect(sharing(threadShell("me"), [threadShell("approvals")])).toEqual(["approvals"]);
  });

  it("matches worktree paths and ignores threads in other worktrees", () => {
    const me = threadShell("me", { worktreePath: "/worktrees/rudi/a" });
    expect(
      sharing(
        me,
        [
          threadShell("same", { worktreePath: "/worktrees/rudi/a/" }),
          threadShell("other", { worktreePath: "/worktrees/rudi/b" }),
          threadShell("root"),
        ],
        "/worktrees/rudi/a",
      ),
    ).toEqual(["same"]);
  });

  it("ignores archived, settled, and idle threads but keeps a running one", () => {
    const dayAgo = "2026-10-05T11:00:00.000Z";
    const idleTurn = {
      turnId: TurnId.make("turn-1"),
      state: "completed" as const,
      requestedAt: dayAgo,
      startedAt: dayAgo,
      completedAt: dayAgo,
      assistantMessageId: null,
    };
    expect(
      sharing(threadShell("me"), [
        threadShell("archived", { archivedAt: now }),
        threadShell("settled", { settledAt: now }),
        threadShell("idle", { latestUserMessageAt: dayAgo, latestTurn: idleTurn }),
        threadShell("running", {
          latestUserMessageAt: dayAgo,
          latestTurn: { ...idleTurn, state: "running", completedAt: null },
        }),
      ]),
    ).toEqual(["running"]);
  });

  it("lets threads of workflows share a worktree with each other", () => {
    const workflowContext = {
      workflowId: WorkflowId.make("workflow-1"),
      rootThreadId: ThreadId.make("root"),
      ticketScope: [],
    };
    const worker = threadShell("worker", { worktreePath: "/w", workflowContext });
    const reviewer = threadShell("reviewer", { worktreePath: "/w", workflowContext });
    const user = threadShell("user", { worktreePath: "/w" });
    expect(sharing(worker, [reviewer, user], "/w")).toEqual(["user"]);
  });
});

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
          namespace: "dev-123",
          displayName: "Verify email capabilities",
          description: null,
          status: "running",
          services: [
            {
              name: "cortex",
              status: "running",
              health: "unknown",
              error: null,
              previewUrl: "https://cortex.example.test",
            },
            { name: "android-emulator", status: "stopped", health: "unknown" },
            { name: "windows", status: "queued", health: "unknown" },
          ],
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
    expect(context).toContain("App Stack variant: dev");
    expect(context).toContain("App Stack namespace: dev-123");
    expect(context).toContain("Reuse the running stack");
    expect(context).toContain("App Stack URL: https://verify-email.example.test");
    expect(context).toContain("authoritative runtime and browser targets");
    expect(context).toContain("cortex: https://cortex.example.test");
    expect(context).toContain("Use app_stack_device_start/status/stop");
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

  it("reports the checked-out branch and the branch the thread started on", () => {
    const base = {
      worktreePath: "/repos/rudi",
      workflowPreset: null,
      stackLookup: { stack: null, frontendUrl: null, frontendServiceName: null },
    };
    expect(
      buildWorktreeRuntimeContext({
        ...base,
        branch: "dev",
        checkout: { isRepo: true, branch: "plain-language-approvals" },
      }),
    ).toContain("- Git branch: plain-language-approvals (this thread was started on 'dev')");
    expect(
      buildWorktreeRuntimeContext({
        ...base,
        branch: null,
        checkout: { isRepo: false, branch: null },
      }),
    ).toContain("- Git branch: none (not a Git repository)");
    expect(
      buildWorktreeRuntimeContext({
        ...base,
        branch: null,
        checkout: { isRepo: true, branch: null },
      }),
    ).toContain("- Git branch: detached HEAD");
    expect(buildWorktreeRuntimeContext({ ...base, branch: null, checkout: null })).toContain(
      "- Git branch: unknown",
    );
  });

  it("warns against branch changes in a checkout another thread is using", () => {
    const context = buildWorktreeRuntimeContext({
      worktreePath: "/repos/rudi",
      branch: "dev",
      workflowPreset: null,
      stackLookup: { stack: null, frontendUrl: null, frontendServiceName: null },
      sharedWithThreadTitles: ["Plain-language approvals"],
    });

    expect(context).toContain(
      '- Shared checkout: 1 other active thread(s) also work here: "Plain-language approvals"',
    );
    expect(context).toContain("Do not create, switch, or reset branches here");
    expect(context).toContain("create a separate git worktree");
  });
});
