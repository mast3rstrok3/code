import type { AppStack } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  AppStackWorkflowConflictWarning,
  AppStackWorkflowOwnershipBadge,
} from "./AppStackWorkflowOwnership";

const stack = {
  id: "stack-1",
  uuid: "stack-1",
  userId: "user-1",
  worktreePath: "/tmp/repo.worktrees/feature",
  composePath: "compose.app-dev.yml",
  displayName: "Feature",
  description: null,
  status: "running",
  services: null,
  serviceCount: 0,
  lastError: null,
  errorCount: 0,
  createdAt: "2026-08-11T00:00:00.000Z",
  updatedAt: "2026-08-11T00:00:00.000Z",
} satisfies AppStack;

describe("AppStackWorkflowOwnershipBadge", () => {
  it("renders ownership only for workflow-owned stacks", () => {
    expect(
      renderToStaticMarkup(
        <AppStackWorkflowOwnershipBadge stack={{ ...stack, workflowId: "workflow-calendar" }} />,
      ),
    ).toContain("Workflow-owned");
    expect(renderToStaticMarkup(<AppStackWorkflowOwnershipBadge stack={stack} />)).toBe("");
  });
});

describe("AppStackWorkflowConflictWarning", () => {
  it("renders the affected workflow and makes non-destructive behavior explicit", () => {
    const markup = renderToStaticMarkup(
      <AppStackWorkflowConflictWarning
        conflicts={[
          {
            workflowId: "workflow-calendar",
            stackIds: ["stack-1", "stack-2"],
            runIds: ["run-1", "run-2"],
            worktreePaths: ["/tmp/one", "/tmp/two"],
          },
        ]}
      />,
    );

    expect(markup).toContain("Multiple stacks map to one workflow");
    expect(markup).toContain("2 stacks · workflow-calendar");
    expect(markup).toContain("No stacks were stopped or deleted automatically.");
  });

  it("renders nothing when there are no conflicts", () => {
    expect(renderToStaticMarkup(<AppStackWorkflowConflictWarning conflicts={[]} />)).toBe("");
  });
});
