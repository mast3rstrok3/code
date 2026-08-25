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

import { TicketAppReviewCycles } from "./WorkflowsPanel";

describe("TicketAppReviewCycles", () => {
  it("collapses cycle details, repair tickets, and gaps by default", () => {
    const markup = renderToStaticMarkup(
      <TicketAppReviewCycles
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
      />,
    );

    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain("Cycle 1 of 3");
    expect(markup).not.toContain("Gap analysis &amp; repair tickets");
    expect(markup).not.toContain("TICKET-1 · Fix the workflow panel");
    expect(markup).not.toContain("Gaps to fix");
  });
});

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
        actionableFindingsMarkdown: "The current ticket opens again after it is collapsed.",
        planId: null,
        plannerThreadId: ThreadId.make("thread-planner"),
        plannerTurnId: null,
        fixerThreadId: null,
        repairTickets: [
          {
            key: "TICKET-1",
            parentTicketKey: null,
            title: "Fix the workflow panel",
            bodyMarkdown: "Make navigation a one-shot request.",
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
    workspaceRevision,
    finalHeadSha: null,
    outcome: null,
    failure: null,
    createdAt: "2026-08-25T00:00:00.000Z",
    updatedAt: "2026-08-25T00:01:00.000Z",
    completedAt: null,
  };
}
