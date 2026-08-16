import { AppReviewWorkflowRunId, ThreadId, type AppReviewWorkflowRun } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { AppReviewThreadStatus } from "./AppReviewThreadStatus";

describe("AppReviewThreadStatus", () => {
  it("shows a blocked launch, its brief, and a concise failure without the stack trace", () => {
    const markup = renderToStaticMarkup(
      <AppReviewThreadStatus run={blockedRun()} onOpenDetails={() => {}} />,
    );

    expect(markup).toContain("App Review is blocked");
    expect(markup).toContain("Review the email test seams");
    expect(markup).toContain("VcsRepositoryDetectionError: Workspace rejected.");
    expect(markup).not.toContain("internal.ts:10:2");
    expect(markup).toContain("Open App Review details");
  });
});

function blockedRun(): AppReviewWorkflowRun {
  return {
    id: AppReviewWorkflowRunId.make("app-review-workflow-controller"),
    targetThreadId: ThreadId.make("thread-controller"),
    controllerThreadId: ThreadId.make("thread-controller"),
    caller: { type: "standalone", sourceThreadId: ThreadId.make("thread-controller") },
    briefMarkdown: "Review the email test seams",
    supportingContextMarkdown: null,
    previewTargets: ["https://preview.example.test"],
    cycleBudget: 10,
    cyclesUsed: 0,
    status: "blocked",
    cycles: [],
    activePhase: null,
    activeThreadId: null,
    workspaceRevision: {
      headSha: "pending",
      workingTreeDiffHash: "pending",
      branchDiffHash: "pending",
      fingerprint: "pending",
    },
    finalHeadSha: null,
    outcome: "blocked",
    failure: {
      reason: "automation-unavailable",
      phase: null,
      cycleNumber: null,
      detailMarkdown:
        "App Review automation failed.\n\nVcsRepositoryDetectionError: Workspace rejected.\n    at internal.ts:10:2",
      failedAt: "2026-08-13T00:00:00.000Z",
    },
    createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:00.000Z",
    completedAt: "2026-08-13T00:00:00.000Z",
  };
}
