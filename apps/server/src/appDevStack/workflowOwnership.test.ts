import type { AppDevStack, OrchestrationReadModel } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { appDevStackWorkflowConflicts } from "./workflowOwnership.ts";

const stack = (id: string, worktreePath: string, workflowId?: string): AppDevStack => ({
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

describe("appDevStackWorkflowConflicts", () => {
  it("reports legacy stacks mapped to separate runs in one workflow", () => {
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
        },
        {
          id: "run-2",
          orchestratorThreadId: "orchestrator-2",
          orchestratorWorktreePath: "/repo/worktrees/feature-2/",
        },
      ],
    } as unknown as OrchestrationReadModel;

    expect(
      appDevStackWorkflowConflicts(
        [
          stack("stack-1", "/repo/worktrees/feature/"),
          stack("stack-2", "/repo/worktrees/feature-2"),
        ],
        readModel,
      ),
    ).toEqual([
      {
        workflowId: "workflow-1",
        stackIds: ["stack-1", "stack-2"],
        runIds: ["run-1", "run-2"],
        worktreePaths: ["/repo/worktrees/feature", "/repo/worktrees/feature-2"],
      },
    ]);
  });

  it("reports duplicate explicit ownership without run history", () => {
    expect(
      appDevStackWorkflowConflicts(
        [stack("stack-1", "/repo/one", "workflow-1"), stack("stack-2", "/repo/two", "workflow-1")],
        { threads: [], implementationRuns: [] } as unknown as OrchestrationReadModel,
      ),
    ).toEqual([
      {
        workflowId: "workflow-1",
        stackIds: ["stack-1", "stack-2"],
        runIds: [],
        worktreePaths: ["/repo/one", "/repo/two"],
      },
    ]);
  });
});
