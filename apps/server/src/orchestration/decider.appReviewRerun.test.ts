import {
  AppReviewId,
  AppReviewWorkflowRunId,
  CommandId,
  DEFAULT_WORKSPACE_USER_ID,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type AppReviewWorkflowCycle,
  type AppReviewWorkflowPhase,
  type AppReviewWorkflowRun,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const RUN_ID = AppReviewWorkflowRunId.make("app-review-run-1");
const CONTROLLER = ThreadId.make("thread-controller");
const TARGET = ThreadId.make("thread-target");
const REVIEWER = ThreadId.make("thread-reviewer");
const PLANNER = ThreadId.make("thread-planner");
const ROOT = ThreadId.make("thread-root");

function thread(input: { readonly id: ThreadId; readonly session?: "running" | "ready" | null }) {
  return {
    id: input.id,
    projectId: ProjectId.make("project-1"),
    ownerUserId: DEFAULT_WORKSPACE_USER_ID,
    parentThreadId: null,
    workflowRole: null,
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-opus-5" },
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    ...(input.session == null
      ? {}
      : {
          session: {
            threadId: input.id,
            status: input.session,
            providerName: "claudeAgent",
            runtimeMode: "full-access" as const,
            activeTurnId: null,
            lastError: null,
            updatedAt: NOW,
          },
        }),
  } as unknown as OrchestrationReadModel["threads"][number];
}

function cycle(overrides: Partial<AppReviewWorkflowCycle>): AppReviewWorkflowCycle {
  return {
    cycleNumber: 1,
    status: "planning",
    reviewId: AppReviewId.make("review-1"),
    reviewerThreadId: REVIEWER,
    reviewVerdict: "failed",
    actionableFindingsMarkdown: "1. [major] Broken\n\nDetails\n\nReproduction: click",
    planId: null,
    plannerThreadId: PLANNER,
    plannerTurnId: null,
    fixerThreadId: null,
    repairTickets: [],
    fixResult: null,
    workspaceRevision: {
      headSha: "abc123",
      workingTreeDiffHash: "d1",
      branchDiffHash: "d2",
      fingerprint: "f1",
    },
    startedAt: NOW,
    completedAt: null,
    ...overrides,
  } as AppReviewWorkflowCycle;
}

const WORKER = ThreadId.make("thread-ticket-worker");

function makeReadModel(input: {
  readonly cycles: ReadonlyArray<AppReviewWorkflowCycle>;
  readonly activeThreadId?: ThreadId | null;
  readonly activeSession?: "running" | "ready";
  readonly cyclesUsed?: number;
  readonly cycleBudget?: number;
  /** The ticket worker sharing the review's worktree, when one is live. */
  readonly ticketWorkerSession?: "running" | "ready";
  readonly reviewOnly?: boolean;
}): OrchestrationReadModel {
  const run: AppReviewWorkflowRun = {
    id: RUN_ID,
    targetThreadId: TARGET,
    controllerThreadId: CONTROLLER,
    caller: {
      type: "implementation",
      implementationRunId: "implementation-run-1",
      orchestratorThreadId: TARGET,
      ticketId: "planning-ticket-1",
    },
    briefMarkdown: "Verify the flow.",
    ...(input.reviewOnly === undefined ? {} : { reviewOnly: input.reviewOnly }),
    supportingContextMarkdown: null,
    previewTargets: ["http://localhost:3000"],
    cycleBudget: input.cycleBudget ?? 10,
    cyclesUsed: input.cyclesUsed ?? input.cycles.length,
    status: "running",
    cycles: input.cycles,
    activePhase: null,
    activeThreadId: input.activeThreadId ?? null,
    workspaceRevision: {
      headSha: "abc123",
      workingTreeDiffHash: "d1",
      branchDiffHash: "d2",
      fingerprint: "f1",
    },
    finalHeadSha: null,
    outcome: null,
    failure: null,
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: null,
  } as AppReviewWorkflowRun;
  return {
    snapshotSequence: 0,
    projects: [],
    implementationRuns: [
      {
        id: "implementation-run-1",
        ticketStates: [
          {
            ticketId: "planning-ticket-1",
            status: "app-reviewing",
            workerThreadId: WORKER,
            appReviewWorkflowRunId: RUN_ID,
            codeReviewThreadId: null,
          },
        ],
        activeValidatorThreadId: null,
        activeCodeReviewThreadId: null,
        activeFixerThreadId: null,
      },
    ],
    appReviewWorkflowRuns: [run],
    threads: [
      thread({ id: ROOT }),
      thread({ id: CONTROLLER }),
      thread({ id: TARGET }),
      thread({ id: REVIEWER }),
      thread({ id: PLANNER, session: input.activeSession ?? "ready" }),
      thread({ id: WORKER, session: input.ticketWorkerSession ?? "ready" }),
    ],
  } as unknown as OrchestrationReadModel;
}

function rerun(
  phase: AppReviewWorkflowPhase,
  modelSelection?: { instanceId: string; model: string },
) {
  return {
    type: "thread.app-review-workflow.rerun" as const,
    commandId: CommandId.make(`cmd-rerun-${phase}`),
    threadId: ROOT,
    runId: RUN_ID,
    phase,
    ...(modelSelection === undefined
      ? {}
      : {
          modelSelection: {
            instanceId: ProviderInstanceId.make(modelSelection.instanceId),
            model: modelSelection.model,
          },
        }),
    createdAt: NOW,
  };
}

function rerunTicketAppReview() {
  return {
    type: "thread.implementation-run.rerun" as const,
    commandId: CommandId.make("cmd-rerun-ticket-app-review"),
    threadId: ROOT,
    runId: "implementation-run-1",
    target: {
      kind: "ticket" as const,
      ticketId: "planning-ticket-1",
      stage: "app-review" as const,
    },
    createdAt: NOW,
  };
}

function rerunRunAppReview() {
  return {
    type: "thread.implementation-run.rerun" as const,
    commandId: CommandId.make("cmd-rerun-run-app-review"),
    threadId: ROOT,
    runId: "implementation-run-1",
    target: { kind: "run" as const, stage: "app-review" as const },
    createdAt: NOW,
  };
}

it.layer(NodeServices.layer)("App Review phase re-run decider", (it) => {
  it.effect("re-runs a phase of the run's current cycle", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: rerun("planning"),
        readModel: makeReadModel({ cycles: [cycle({})] }),
      });
      const events = Array.isArray(event) ? event : [event];
      expect(events.map((entry) => entry.type)).toEqual([
        "thread.app-review-workflow-rerun-requested",
      ]);
    }),
  );

  it.effect("refuses while the phase thread is still running", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: rerun("planning"),
        readModel: makeReadModel({
          cycles: [cycle({})],
          activeThreadId: PLANNER,
          activeSession: "running",
        }),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
      expect(String(error)).toContain(PLANNER);
    }),
  );

  it.effect("refuses gap analysis when the cycle's review produced no findings", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: rerun("planning"),
        readModel: makeReadModel({
          cycles: [cycle({ actionableFindingsMarkdown: null })],
        }),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("refuses the repair when gap analysis wrote no tickets", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: rerun("fixing"),
        readModel: makeReadModel({ cycles: [cycle({ repairTickets: [] })] }),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("refuses the repair on a run launched to review only", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: rerun("fixing"),
        readModel: makeReadModel({
          reviewOnly: true,
          cycles: [
            cycle({
              repairTickets: [
                {
                  key: "TICKET-1.1",
                  parentTicketKey: "TICKET-1",
                  title: "Fix the gap",
                  bodyMarkdown: "Repair it.",
                  dependencyKeys: [],
                },
              ],
            }),
          ],
        }),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
      expect(String(error)).toContain("review only");
    }),
  );

  it.effect("pins the phase's own sub-step when the re-run names a model", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: rerun("fixing", { instanceId: "claudeAgent", model: "claude-sonnet-5" }),
        readModel: makeReadModel({
          cycles: [
            cycle({
              status: "fixing",
              repairTickets: [
                {
                  key: "TICKET-1.1",
                  parentTicketKey: "TICKET-1",
                  title: "Fix the gap",
                  bodyMarkdown: "Repair it.",
                  dependencyKeys: [],
                },
              ],
            }),
          ],
        }),
      });
      const events = Array.isArray(event) ? event : [event];
      expect(events.map((entry) => entry.type)).toEqual([
        "thread.workflow-step-model-set",
        "thread.app-review-workflow-rerun-requested",
      ]);
      const pin = events[0];
      if (pin?.type !== "thread.workflow-step-model-set") throw new Error("Pin event missing.");
      // The repair agent is a sub-step of App Review, so its pin carries both ids.
      expect(pin.payload.workflowPromptId).toBe("matt-pocock.implement");
      expect(pin.payload.stepWorkflowPromptId).toBe("implementation.browser-app-review.codex");
    }),
  );

  it.effect("refuses while the ticket that owns the review has a live agent", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: rerun("planning"),
        readModel: makeReadModel({ cycles: [cycle({})], ticketWorkerSession: "running" }),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
      expect(String(error)).toContain(WORKER);
    }),
  );

  it.effect("refuses a browser review redo once every cycle is spent", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: rerun("review"),
        readModel: makeReadModel({ cycles: [cycle({})], cyclesUsed: 10, cycleBudget: 10 }),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
      expect(String(error)).toContain("all 10");
    }),
  );

  it.effect("lets a ticket replace an orphaned App Review run", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: rerunTicketAppReview(),
        readModel: makeReadModel({
          cycles: [cycle({})],
          activeThreadId: PLANNER,
          activeSession: "ready",
        }),
      });
      const events = Array.isArray(event) ? event : [event];
      expect(events.map((entry) => entry.type)).toEqual([
        "thread.implementation-run-rerun-requested",
      ]);
    }),
  );

  it.effect("refuses to replace a ticket App Review while its phase agent is live", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: rerunTicketAppReview(),
        readModel: makeReadModel({
          cycles: [cycle({})],
          activeThreadId: PLANNER,
          activeSession: "running",
        }),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
      expect(String(error)).toContain(PLANNER);
    }),
  );

  it.effect("lets an implementation run replace its orphaned App Review", () =>
    Effect.gen(function* () {
      const readModel = makeReadModel({
        cycles: [cycle({})],
        activeThreadId: PLANNER,
        activeSession: "ready",
      });
      const reviewRun = (readModel.appReviewWorkflowRuns ?? [])[0]!;
      const event = yield* decideOrchestrationCommand({
        command: rerunRunAppReview(),
        readModel: {
          ...readModel,
          appReviewWorkflowRuns: [
            {
              ...reviewRun,
              caller: {
                type: "implementation",
                implementationRunId: "implementation-run-1",
                orchestratorThreadId: TARGET,
              },
            },
          ],
        },
      });
      const events = Array.isArray(event) ? event : [event];
      expect(events.map((entry) => entry.type)).toEqual([
        "thread.implementation-run-rerun-requested",
      ]);
    }),
  );
});
