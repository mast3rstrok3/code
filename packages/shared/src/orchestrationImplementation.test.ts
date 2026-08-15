import { describe, expect, it } from "vite-plus/test";

import {
  resolveWorkflowWorkspaceIdentity,
  workflowPresetStartsInDedicatedWorkspace,
} from "./orchestrationImplementation.ts";

describe("workflow workspace identity", () => {
  it("starts Planning, Full Feature, and Fast Feature in dedicated workspaces", () => {
    expect(workflowPresetStartsInDedicatedWorkspace("planning")).toBe(true);
    expect(workflowPresetStartsInDedicatedWorkspace("full-feature")).toBe(true);
    expect(workflowPresetStartsInDedicatedWorkspace("fast-feature")).toBe(true);
    expect(workflowPresetStartsInDedicatedWorkspace("implementation")).toBe(false);
    expect(workflowPresetStartsInDedicatedWorkspace("wayfinder")).toBe(false);
  });

  it("resolves the latest valid prepared workspace activity", () => {
    expect(
      resolveWorkflowWorkspaceIdentity([
        { kind: "workflow-workspace-prepared", payload: { baseBranch: "main" } },
        {
          kind: "workflow-workspace-prepared",
          payload: {
            baseBranch: "dev",
            branch: "t3code/feature",
            worktreePath: "/repo.worktrees/feature",
          },
        },
      ]),
    ).toEqual({
      baseBranch: "dev",
      branch: "t3code/feature",
      worktreePath: "/repo.worktrees/feature",
    });
  });
});
