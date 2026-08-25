import {
  AppReviewId,
  AppReviewWorkflowRunId,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type AppReviewWorkflowRun,
} from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import type { WorkflowCurrentPath } from "../workflowModel";
import { TicketAppReviewCycles, workflowDisclosureIdsForCurrentPath } from "./WorkflowsPanel";

describe("TicketAppReviewCycles", () => {
  it("collapses cycle details, repair tickets, and gaps by default", () => {
    const markup = renderCycles();

    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain("Cycle 1 of 3");
    expect(markup).not.toContain("Gap analysis &amp; repair tickets");
    expect(markup).not.toContain("TICKET-1 · Fix the workflow panel");
    expect(markup).not.toContain("Gaps to fix");
  });

  it("keeps repair tickets and gaps collapsed when only the cycle opens", () => {
    const markup = renderCycles({
      "app-review-cycle:group-1:app-review-run-1:1": true,
    });

    expect(markup).toContain("E2E and browser review");
    expect(markup).toContain("Gap analysis &amp; repair tickets");
    expect(markup).toContain("TDD repair");
    expect(markup).not.toContain("TICKET-1 · Fix the workflow panel");
    expect(markup).not.toContain("TICKET-2 · Keep reports independent");
    expect(markup).not.toContain("Gaps to fix");
    expect(markup).not.toContain("FIRST REPAIR BODY");
    expect(markup).not.toContain("SECOND REPAIR BODY");
    expect(markup).not.toContain("FULL FINDINGS BODY");
  });

  it("reveals repair ticket and gap headers when gap analysis opens", () => {
    const markup = renderCycles({
      "app-review-cycle:group-1:app-review-run-1:1": true,
      "app-review-phase:group-1:app-review-run-1:1:planning": true,
    });

    expect(markup).toContain("TICKET-1 · Fix the workflow panel");
    expect(markup).toContain("TICKET-2 · Keep reports independent");
    expect(markup).toContain("Gaps to fix");
    expect(markup).not.toContain("FIRST REPAIR BODY");
    expect(markup).not.toContain("SECOND REPAIR BODY");
    expect(markup).not.toContain("FULL FINDINGS BODY");
  });

  it("opens one repair ticket without opening its sibling or the gaps", () => {
    const markup = renderCycles({
      "app-review-cycle:group-1:app-review-run-1:1": true,
      "app-review-phase:group-1:app-review-run-1:1:planning": true,
      "repair-ticket:group-1:app-review-run-1:1:TICKET-1": true,
    });

    expect(markup).toContain("FIRST REPAIR BODY");
    expect(markup).not.toContain("SECOND REPAIR BODY");
    expect(markup).not.toContain("FULL FINDINGS BODY");
  });

  it("opens gaps without opening repair tickets", () => {
    const markup = renderCycles({
      "app-review-cycle:group-1:app-review-run-1:1": true,
      "app-review-phase:group-1:app-review-run-1:1:planning": true,
      "gaps:group-1:app-review-run-1:1": true,
    });

    expect(markup).toContain("FULL FINDINGS BODY");
    expect(markup).not.toContain("FIRST REPAIR BODY");
    expect(markup).not.toContain("SECOND REPAIR BODY");
    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain('aria-expanded="false"');
  });
});

describe("workflowDisclosureIdsForCurrentPath", () => {
  it("reveals the full App Review ticket path", () => {
    expect(
      workflowDisclosureIdsForCurrentPath(
        currentPath({
          ticketId: "ticket-1",
          ticketStage: "app-review",
          appReviewRunId: "review-1",
          cycleNumber: 2,
          appReviewPhase: "planning",
        }),
      ),
    ).toEqual([
      "group:group-1",
      "phase:group-1:Implementation",
      "step:group-1:step-1",
      "ticket:group-1:ticket-1",
      "ticket-stage:group-1:ticket-1:app-review",
      "app-review-cycle:group-1:review-1:2",
      "app-review-phase:group-1:review-1:2:planning",
    ]);
  });

  it("reveals a targeted ticket code-review cycle", () => {
    expect(
      workflowDisclosureIdsForCurrentPath(
        currentPath({
          ticketId: "ticket-1",
          ticketStage: "code-review",
          cycleNumber: 3,
        }),
      ),
    ).toEqual([
      "group:group-1",
      "phase:group-1:Implementation",
      "step:group-1:step-1",
      "ticket:group-1:ticket-1",
      "ticket-stage:group-1:ticket-1:code-review",
      "code-review-cycle:group-1:ticket-1:3",
    ]);
  });

  it("stops at the workflow step when there is no ticket", () => {
    expect(workflowDisclosureIdsForCurrentPath(currentPath())).toEqual([
      "group:group-1",
      "phase:group-1:Implementation",
      "step:group-1:step-1",
    ]);
  });
});

function renderCycles(expanded: Readonly<Record<string, boolean>> = {}): string {
  return renderToStaticMarkup(
    <TicketAppReviewCycles
      groupId="group-1"
      run={appReviewRun()}
      callerBusyReason={null}
      environmentId={EnvironmentId.make("environment-1")}
      rootModelSelection={{
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4",
      }}
      pinFor={() => null}
      onSetStepModel={undefined}
      onRerunPhase={undefined}
      onStopThreads={undefined}
      onResumeThreads={undefined}
      threads={[]}
      onOpenThread={() => {}}
      activeThreadKey={null}
      timestampFormat="24-hour"
      disclosures={{ expanded, toggle: () => {} }}
    />,
  );
}

function currentPath(overrides: Partial<WorkflowCurrentPath> = {}): WorkflowCurrentPath {
  return {
    groupId: "group-1",
    status: "running",
    phase: "Implementation",
    stepId: "step-1",
    stepLabel: "Execute ticket waves",
    waveIndex: null,
    ticketId: null,
    ticketLabel: null,
    ticketStage: null,
    appReviewRunId: null,
    cycleNumber: null,
    cycleBudget: null,
    appReviewPhase: null,
    threadId: null,
    activeTicketCount: 0,
    subtitle: "Implementation",
    ...overrides,
  };
}

function appReviewRun(): AppReviewWorkflowRun {
  const workspaceRevision = {
    headSha: "abc123",
    workingTreeDiffHash: "worktree-hash",
    branchDiffHash: "branch-hash",
    fingerprint: "fingerprint",
  };
  return {
    id: AppReviewWorkflowRunId.make("app-review-run-1"),
    targetThreadId: ThreadId.make("thread-controller"),
    controllerThreadId: ThreadId.make("thread-controller"),
    caller: { type: "standalone", sourceThreadId: ThreadId.make("thread-controller") },
    briefMarkdown: "Review the workflow panel",
    supportingContextMarkdown: null,
    previewTargets: ["https://preview.example.test"],
    cycleBudget: 3,
    cyclesUsed: 1,
    status: "running",
    cycles: [
      {
        cycleNumber: 1,
        status: "planning",
        reviewId: AppReviewId.make("app-review-1"),
        reviewerThreadId: ThreadId.make("thread-reviewer"),
        reviewVerdict: "failed",
        actionableFindingsMarkdown: "FULL FINDINGS BODY",
        planId: null,
        plannerThreadId: ThreadId.make("thread-planner"),
        plannerTurnId: null,
        fixerThreadId: null,
        repairTickets: [
          {
            key: "TICKET-1",
            parentTicketKey: null,
            title: "Fix the workflow panel",
            bodyMarkdown: "FIRST REPAIR BODY",
            dependencyKeys: [],
          },
          {
            key: "TICKET-2",
            parentTicketKey: null,
            title: "Keep reports independent",
            bodyMarkdown: "SECOND REPAIR BODY",
            dependencyKeys: [],
          },
        ],
        fixResult: null,
        workspaceRevision,
        startedAt: "2026-08-25T00:00:00.000Z",
        completedAt: null,
      },
    ],
    activePhase: "planning",
    activeThreadId: ThreadId.make("thread-planner"),
    phaseExecution: null,
    workspaceRevision,
    finalHeadSha: null,
    outcome: null,
    failure: null,
    createdAt: "2026-08-25T00:00:00.000Z",
    updatedAt: "2026-08-25T00:01:00.000Z",
    completedAt: null,
  };
}
