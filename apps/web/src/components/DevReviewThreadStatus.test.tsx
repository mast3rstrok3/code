import { DevReviewWorkflowRunId, ThreadId, type DevReviewWorkflowRun } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { DevReviewThreadStatus } from "./DevReviewThreadStatus";

describe("DevReviewThreadStatus", () => {
  it("shows a blocked launch, its brief, and a concise failure without the stack trace", () => {
    const markup = renderToStaticMarkup(
      <DevReviewThreadStatus run={blockedRun()} onOpenDetails={() => {}} />,
    );

    expect(markup).toContain("Dev Review is blocked");
    expect(markup).toContain("Review the email test seams");
    expect(markup).toContain("VcsRepositoryDetectionError: Workspace rejected.");
    expect(markup).not.toContain("internal.ts:10:2");
    expect(markup).toContain("Open Dev Review details");
  });
});

function blockedRun(): DevReviewWorkflowRun {
  return {
    id: DevReviewWorkflowRunId.make("dev-review-workflow-controller"),
    targetThreadId: ThreadId.make("thread-controller"),
    controllerThreadId: ThreadId.make("thread-controller"),
    caller: { type: "standalone", sourceThreadId: ThreadId.make("thread-controller") },
    briefMarkdown: "Review the email test seams",
    supportingContextMarkdown: null,
    previewTargets: ["https://preview.example.test"],
    cycleBudget: 10,
    attemptsUsed: 0,
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
        "Dev Review automation failed.\n\nVcsRepositoryDetectionError: Workspace rejected.\n    at internal.ts:10:2",
      failedAt: "2026-08-13T00:00:00.000Z",
    },
    createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:00.000Z",
    completedAt: "2026-08-13T00:00:00.000Z",
  };
}
