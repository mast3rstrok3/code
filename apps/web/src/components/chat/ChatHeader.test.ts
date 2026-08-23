import {
  EnvironmentId,
  type OrchestrationImplementationRun,
  ThreadId,
  WorkflowId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveRenameCommit, shouldShowOpenInPicker, workflowProgressLabel } from "./ChatHeader";

describe("shouldShowOpenInPicker", () => {
  const primaryEnvironmentId = EnvironmentId.make("environment-primary");

  it("shows the picker for projects in the primary environment", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: "codething-mvp",
        activeThreadEnvironmentId: primaryEnvironmentId,
        primaryEnvironmentId,
        remoteOpenMode: "local-exec",
      }),
    ).toBe(true);
  });

  it("shows the picker for remote environments in deep-link mode", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: "codething-mvp",
        activeThreadEnvironmentId: EnvironmentId.make("environment-remote"),
        primaryEnvironmentId,
        remoteOpenMode: "remote-links",
      }),
    ).toBe(true);
  });

  it("shows the picker's unavailable state for remote environments without an SSH route", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: "codething-mvp",
        activeThreadEnvironmentId: EnvironmentId.make("environment-remote"),
        primaryEnvironmentId: null,
        remoteOpenMode: "remote-unavailable",
      }),
    ).toBe(true);
  });

  it("hides the picker for non-primary local backends", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: "codething-mvp",
        activeThreadEnvironmentId: EnvironmentId.make("environment-remote"),
        primaryEnvironmentId,
        remoteOpenMode: "local-exec",
      }),
    ).toBe(false);
  });

  it("hides the picker when there is no active project", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: undefined,
        activeThreadEnvironmentId: primaryEnvironmentId,
        primaryEnvironmentId,
        remoteOpenMode: "remote-links",
      }),
    ).toBe(false);
  });
});

describe("workflowProgressLabel", () => {
  const workflowContext = {
    workflowId: WorkflowId.make("workflow-1"),
    rootThreadId: ThreadId.make("thread-root"),
    ticketScope: [],
  };

  it("labels Product intent and every implementation child role", () => {
    expect(
      workflowProgressLabel({
        interactionMode: "product-workflow",
        workflowRole: null,
        workflowContext,
        planningWorkflow: null,
        implementationRuns: [],
      }),
    ).toBe("Product · Intent");

    const labels = [
      ["implementation-worker", "Implementation · TDD"],
      ["implementation-validator", "Implementation · Merge gate"],
      ["implementation-qa-reviewer", "Implementation · Browser App Review"],
      ["implementation-fixer", "Implementation · Fix"],
      ["implementation-code-reviewer", "Implementation · Code review"],
      ["app-review-orchestrator", "App Review · Controller"],
      ["app-review-reviewer", "App Review · Browser review"],
      ["app-review-fixer", "App Review · Implement plan"],
    ] as const;
    for (const [workflowRole, expected] of labels) {
      expect(
        workflowProgressLabel({
          interactionMode: "implementation-workflow",
          workflowRole,
          workflowContext,
          planningWorkflow: null,
          implementationRuns: [],
        }),
      ).toBe(expected);
    }
  });

  it("shows full and targeted review progress out of ten", () => {
    const baseWorkflow = {
      stage: "ticket-review" as const,
      createTicketsAvailable: false,
      spec: null,
      tickets: [],
      reviewCycles: [],
    };
    for (const [mode, expected] of [
      ["full", "Planning · Full ticket review · 3/10"],
      ["targeted", "Planning · Ticket fixes · 3/10"],
    ] as const) {
      expect(
        workflowProgressLabel({
          interactionMode: "planning-workflow",
          workflowRole: "planning-reviewer",
          workflowContext,
          planningWorkflow: {
            ...baseWorkflow,
            activeReview: {
              cycleNumber: 3,
              mode,
              reviewerThreadId: ThreadId.make("thread-reviewer"),
              targetPlanningTicketIds: [],
              requestedAt: "2026-01-01T00:00:00.000Z",
            },
          },
          implementationRuns: [],
        }),
      ).toBe(expected);
    }
  });

  it("labels fresh QA repair threads with their shared cycle", () => {
    expect(
      workflowProgressLabel({
        interactionMode: "implementation-workflow",
        workflowRole: "fast-feature-implementer",
        workflowContext,
        planningWorkflow: null,
        implementationRuns: [
          {
            artifactSource: "proposed-plan",
            status: "fixing",
            fixOrigin: "app-review",
            qaCycleCount: 3,
            updatedAt: "2026-01-01T00:00:00.000Z",
          } as OrchestrationImplementationRun,
        ],
      }),
    ).toBe("Fast feature · TDD repair · 3/10");
  });
});

describe("resolveRenameCommit", () => {
  it("commits a trimmed changed title", () => {
    expect(resolveRenameCommit({ title: "  New title ", originalTitle: "Old" })).toEqual({
      action: "commit",
      title: "New title",
    });
  });

  it("rejects empty and whitespace-only titles", () => {
    expect(resolveRenameCommit({ title: "   ", originalTitle: "Old" })).toEqual({
      action: "reject-empty",
    });
  });

  it("no-ops when the trimmed title is unchanged", () => {
    expect(resolveRenameCommit({ title: " Old ", originalTitle: "Old" })).toEqual({
      action: "noop",
    });
  });
});
