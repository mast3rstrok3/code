import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AppReviewWorkflowCycleBudget,
  CommandId,
  DEFAULT_WORKSPACE_USER_ID,
  AppReviewWorkflowRunId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WorkflowId,
  type AppReviewWorkflowRun,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { WORKFLOW_PROMPT_IDS } from "../provider/WorkflowPromptRegistry.ts";

const now = "2026-01-01T00:00:00.000Z";
const projectId = ProjectId.make("project-step-cycles");
const rootThreadId = ThreadId.make("thread-workflow-root");
const orchestratorThreadId = ThreadId.make("thread-orchestrator");
const controllerThreadId = ThreadId.make("thread-app-review-controller");

const APP_REVIEW_PROMPT_ID = WORKFLOW_PROMPT_IDS.implementationBrowserAppReviewCodex;
const TICKET_WAVE_PROMPT_ID = WORKFLOW_PROMPT_IDS.implementationTddCodex;

function thread(id: ThreadId, overrides: Partial<OrchestrationThread> = {}): OrchestrationThread {
  return {
    id,
    projectId,
    ownerUserId: DEFAULT_WORKSPACE_USER_ID,
    parentThreadId: null,
    workflowRole: null,
    title: id,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "dev",
    worktreePath: "/tmp/step-cycles",
    latestTurn: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    planningWorkflow: null,
    appReviews: [],
    activities: [],
    checkpoints: [],
    session: null,
    ...overrides,
  };
}

function appReviewRun(input: {
  readonly ticketId?: string;
  readonly cycleBudget: number;
  readonly status?: AppReviewWorkflowRun["status"];
}): AppReviewWorkflowRun {
  return {
    id: AppReviewWorkflowRunId.make(`app-review-workflow-${controllerThreadId}`),
    controllerThreadId,
    targetThreadId: orchestratorThreadId,
    caller: {
      type: "implementation",
      implementationRunId: "run-1",
      orchestratorThreadId,
      ...(input.ticketId === undefined ? {} : { ticketId: input.ticketId }),
    },
    status: input.status ?? "running",
    outcome: null,
    activePhase: "review",
    activeThreadId: null,
    phaseExecution: null,
    briefMarkdown: "Review it.",
    supportingContextMarkdown: null,
    previewTargets: ["http://localhost:3000"],
    workspaceRevision: {
      headSha: "pending",
      workingTreeDiffHash: "pending",
      branchDiffHash: "pending",
      fingerprint: "pending",
    },
    cycleBudget: AppReviewWorkflowCycleBudget.make(input.cycleBudget),
    cyclesUsed: 2,
    cycles: [],
    failure: null,
    finalHeadSha: null,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
  };
}

function readModel(input?: {
  readonly appReviewWorkflowRuns?: ReadonlyArray<AppReviewWorkflowRun>;
}): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [
      {
        id: projectId,
        title: "Step cycles",
        workspaceRoot: "/tmp/step-cycles",
        repositoryIdentity: null,
        defaultModelSelection: null,
        defaultThreadEnvMode: null,
        scripts: [],
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      },
    ],
    threads: [
      thread(rootThreadId),
      thread(orchestratorThreadId, {
        workflowContext: {
          workflowId: WorkflowId.make("workflow-1"),
          parentWorkflowId: null,
          rootThreadId,
          ticketScope: [],
        },
      }),
    ],
    implementationRuns: [],
    appReviewWorkflowRuns: [...(input?.appReviewWorkflowRuns ?? [])],
    updatedAt: now,
  };
}

function setCyclesCommand(input: {
  readonly threadId?: ThreadId;
  readonly workflowPromptId?: string;
  readonly stepWorkflowPromptId?: string;
  readonly maxCycles: number | null;
}) {
  return {
    type: "thread.workflow.step-cycles.set" as const,
    commandId: CommandId.make("cmd-set-cycles"),
    threadId: input.threadId ?? rootThreadId,
    workflowPromptId: input.workflowPromptId ?? APP_REVIEW_PROMPT_ID,
    ...(input.stepWorkflowPromptId === undefined
      ? {}
      : { stepWorkflowPromptId: input.stepWorkflowPromptId }),
    maxCycles: input.maxCycles,
    createdAt: now,
  };
}

it.layer(NodeServices.layer)("workflow step cycles decider", (it) => {
  it.effect("records the budget on the workflow root, not the thread it was set from", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: setCyclesCommand({ threadId: orchestratorThreadId, maxCycles: 10 }),
        readModel: readModel(),
      });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events).toHaveLength(1);
      const event = events[0];
      if (event?.type !== "thread.workflow-step-cycles-set") throw new Error("Wrong event.");
      expect(event.payload.threadId).toBe(rootThreadId);
      expect(event.payload.maxCycles).toBe(10);
    }),
  );

  it.effect("moves the budget of the App Review the run is already spending", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: setCyclesCommand({ maxCycles: 20 }),
        readModel: readModel({ appReviewWorkflowRuns: [appReviewRun({ cycleBudget: 5 })] }),
      });
      const events = Array.isArray(decided) ? decided : [decided];
      const updated = events.find((event) => event.type === "thread.app-review-workflow-updated");
      if (updated?.type !== "thread.app-review-workflow-updated") {
        throw new Error("Live App Review was not updated.");
      }
      expect(updated.payload.run.cycleBudget).toBe(10);
      // Only the budget moves: an exhausted run stays exhausted until it is
      // asked to review again.
      expect(updated.payload.run.cyclesUsed).toBe(2);
    }),
  );

  it.effect("leaves a ticket App Review alone when the run's own budget changes", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: setCyclesCommand({ maxCycles: 20 }),
        readModel: readModel({
          appReviewWorkflowRuns: [appReviewRun({ ticketId: "ticket-1", cycleBudget: 10 })],
        }),
      });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events.map((event) => event.type)).toEqual(["thread.workflow-step-cycles-set"]);
    }),
  );

  it.effect("leaves a finished App Review alone", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: setCyclesCommand({ maxCycles: 20 }),
        readModel: readModel({
          appReviewWorkflowRuns: [appReviewRun({ cycleBudget: 10, status: "passed" })],
        }),
      });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events.map((event) => event.type)).toEqual(["thread.workflow-step-cycles-set"]);
    }),
  );

  it.effect("refuses a step that does not run in cycles", () =>
    Effect.gen(function* () {
      const result = yield* Effect.exit(
        decideOrchestrationCommand({
          command: setCyclesCommand({
            workflowPromptId: WORKFLOW_PROMPT_IDS.planningSpecCodex,
            maxCycles: 4,
          }),
          readModel: readModel(),
        }),
      );
      expect(result._tag).toBe("Failure");
    }),
  );

  it.effect("clamps a budget above the step's ceiling", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: setCyclesCommand({ maxCycles: 500 }),
        readModel: readModel(),
      });
      const events = Array.isArray(decided) ? decided : [decided];
      const updated = events.find((event) => event.type === "thread.workflow-step-cycles-set");
      expect(updated?.payload.maxCycles).toBe(10);
    }),
  );

  it.effect("clearing the budget returns a live App Review to the step's default", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: setCyclesCommand({
          stepWorkflowPromptId: TICKET_WAVE_PROMPT_ID,
          maxCycles: null,
        }),
        readModel: readModel({
          appReviewWorkflowRuns: [appReviewRun({ ticketId: "ticket-1", cycleBudget: 3 })],
        }),
      });
      const events = Array.isArray(decided) ? decided : [decided];
      const updated = events.find((event) => event.type === "thread.app-review-workflow-updated");
      if (updated?.type !== "thread.app-review-workflow-updated") {
        throw new Error("Live App Review was not updated.");
      }
      expect(updated.payload.run.cycleBudget).toBe(10);
    }),
  );
});
