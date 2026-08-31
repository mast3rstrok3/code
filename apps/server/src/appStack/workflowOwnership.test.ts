import type { AppStack, OrchestrationReadModel } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { appStackWorkflowConflicts } from "./workflowOwnership.ts";

const stack = (id: string, worktreePath: string, workflowId?: string): AppStack => ({
  id,
  uuid: id,
  userId: "user-1",
  worktreePath,
  composePath: "compose.app-dev.yml",
  displayName: id,
  description: null,
  ...(workflowId === undefined ? {} : { workflowId }),
  status: "running",
  services: null,
  serviceCount: 0,
  lastError: null,
  errorCount: 0,
  createdAt: "2026-08-11T00:00:00.000Z",
  updatedAt: "2026-08-11T00:00:00.000Z",
});

describe("appStackWorkflowConflicts", () => {
  it("accepts a stack inherited from the parent workflow", () => {
    const readModel = {
      threads: [
        {
          id: "orchestrator-1",
          workflowContext: {
            workflowId: "implementation-run-1",
            parentWorkflowId: "workflow-root-1",
            rootThreadId: "root-1",
          },
        },
      ],
      implementationRuns: [
        {
          id: "run-1",
          orchestratorThreadId: "orchestrator-1",
          orchestratorWorktreePath: "/repo/worktrees/feature",
          ticketStates: [{ worktreePath: "/repo/worktrees/ticket-1" }],
        },
      ],
    } as unknown as OrchestrationReadModel;

    expect(
      appStackWorkflowConflicts(
        [stack("stack-1", "/repo/worktrees/ticket-1", "workflow-root-1")],
        readModel,
      ),
    ).toEqual([]);
  });

  it("accepts shared and ticket stacks on distinct worktrees in one workflow", () => {
    const readModel = {
      threads: [
        {
          id: "orchestrator-1",
          workflowContext: { workflowId: "workflow-1", rootThreadId: "root-1" },
        },
        {
          id: "orchestrator-2",
          workflowContext: { workflowId: "workflow-1", rootThreadId: "root-1" },
        },
      ],
      implementationRuns: [
        {
          id: "run-1",
          orchestratorThreadId: "orchestrator-1",
          orchestratorWorktreePath: "/repo/worktrees/feature",
          ticketStates: [{ worktreePath: "/repo/worktrees/ticket-1" }],
        },
        {
          id: "run-2",
          orchestratorThreadId: "orchestrator-2",
          orchestratorWorktreePath: "/repo/worktrees/feature-2/",
        },
      ],
    } as unknown as OrchestrationReadModel;

    expect(
      appStackWorkflowConflicts(
        [
          stack("stack-1", "/repo/worktrees/feature/", "workflow-1"),
          stack("stack-2", "/repo/worktrees/ticket-1", "workflow-1"),
          stack("stack-3", "/repo/worktrees/feature-2", "workflow-1"),
        ],
        readModel,
      ),
    ).toEqual([]);
  });

  it("accepts distinct explicit worktrees without run history", () => {
    expect(
      appStackWorkflowConflicts(
        [stack("stack-1", "/repo/one", "workflow-1"), stack("stack-2", "/repo/two", "workflow-1")],
        { threads: [], implementationRuns: [] } as unknown as OrchestrationReadModel,
      ),
    ).toEqual([]);
  });

  it("reports duplicate stacks for one normalized worktree", () => {
    expect(
      appStackWorkflowConflicts(
        [
          stack("stack-1", "/repo/one/", "workflow-1"),
          stack("stack-2", "/repo//one", "workflow-1"),
        ],
        { threads: [], implementationRuns: [] } as unknown as OrchestrationReadModel,
      ),
    ).toEqual([
      {
        kind: "duplicate-worktree",
        workflowId: "workflow-1",
        stackIds: ["stack-1", "stack-2"],
        runIds: [],
        worktreePaths: ["/repo/one"],
      },
    ]);
  });

  it("reports explicit workflow ownership on the wrong worktree", () => {
    const readModel = {
      threads: [
        {
          id: "orchestrator-1",
          workflowContext: { workflowId: "workflow-1", rootThreadId: "root-1" },
        },
      ],
      implementationRuns: [
        {
          id: "run-1",
          orchestratorThreadId: "orchestrator-1",
          orchestratorWorktreePath: "/repo/expected",
          ticketStates: [],
        },
      ],
    } as unknown as OrchestrationReadModel;
    expect(
      appStackWorkflowConflicts([stack("stack-1", "/repo/wrong", "workflow-1")], readModel),
    ).toEqual([
      {
        kind: "ownership-mismatch",
        workflowId: "workflow-1",
        stackIds: ["stack-1"],
        runIds: [],
        worktreePaths: ["/repo/wrong"],
      },
    ]);
  });
});
