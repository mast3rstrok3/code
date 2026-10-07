import {
  AppReviewId,
  AppReviewWorkflowRunId,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type AppReviewWorkflowRun,
  type OrchestrationImplementationRun,
  type OrchestrationPlanningTicket,
} from "@t3tools/contracts";
import type { EnvironmentWorkflowThreadShell } from "@t3tools/client-runtime/state/models";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import type { WorkflowCurrentPath } from "../workflowModel";
import {
  TicketAppReviewCycles,
  workflowDisclosureIdsForCurrentPath,
  workflowTicketStatuses,
} from "./WorkflowsPanel";

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

    expect(markup).toContain("End-to-end test");
    expect(markup).toContain("Browser review");
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

describe("workflowTicketStatuses", () => {
  const ticket = (id: string) => ({ id }) as unknown as OrchestrationPlanningTicket;
  const run = (
    id: string,
    createdAt: string,
    ticketStates: readonly { readonly ticketId: string; readonly status: string }[],
    skippedTicketIds: readonly string[] = [],
  ) =>
    ({
      id,
      createdAt,
      planningTicketIds: ticketStates.map((state) => state.ticketId),
      ticketStates,
      skips: skippedTicketIds.map((ticketId) => ({ kind: "ticket", ticketId })),
      appReviewWorkflowRunIds: [],
    }) as unknown as OrchestrationImplementationRun;
  const waitingThread = (id: string, workflowId: string, ticketId: string) =>
    ({
      id,
      parentThreadId: null,
      workflowPausedAt: null,
      archivedAt: null,
      hasPendingApprovals: false,
      hasPendingUserInput: true,
      session: null,
      latestTurn: null,
      workflowContext: { workflowId, ticketScope: [ticketId] },
    }) as unknown as EnvironmentWorkflowThreadShell;

  it("counts a ticket once, under the newest run that holds it", () => {
    expect(
      workflowTicketStatuses({
        runs: [
          run("run-old", "2026-09-01T00:00:00.000Z", [
            { ticketId: "ticket-1", status: "failed" },
            { ticketId: "ticket-2", status: "succeeded" },
          ]),
          run("run-new", "2026-09-02T00:00:00.000Z", [{ ticketId: "ticket-1", status: "ready" }]),
        ],
        tickets: [ticket("ticket-1"), ticket("ticket-2"), ticket("ticket-3")],
        threads: [],
        appReviewWorkflowRuns: [],
      }),
    ).toEqual(["pending", "done"]);
  });

  it("reads waiting threads from the ticket's own run only", () => {
    expect(
      workflowTicketStatuses({
        runs: [
          run(
            "run-1",
            "2026-09-01T00:00:00.000Z",
            [
              { ticketId: "ticket-1", status: "running" },
              { ticketId: "ticket-2", status: "blocked" },
              { ticketId: "ticket-3", status: "ready" },
            ],
            ["ticket-3"],
          ),
        ],
        tickets: [ticket("ticket-1"), ticket("ticket-2"), ticket("ticket-3")],
        threads: [
          waitingThread("worker-1", "run-1", "ticket-1"),
          waitingThread("stray", "other-run", "ticket-2"),
        ],
        appReviewWorkflowRuns: [],
      }),
    ).toEqual(["awaiting", "queued", "skipped"]);
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
