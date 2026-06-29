import {
  CommandId,
  EventId,
  MessageId,
  type OrchestrationEvent,
  type OrchestrationThread,
  type OrchestrationPlanningReviewCycle,
  type ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { resolveImplementationBranchIdentity } from "@t3tools/shared/orchestrationImplementation";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
import { WORKFLOW_PROMPT_IDS } from "../../provider/WorkflowPromptRegistry.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  ProductWorkflowReactor,
  type ProductWorkflowReactorShape,
} from "../Services/ProductWorkflowReactor.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";

export const MAX_PLANNING_REVIEW_CYCLE_NUMBER = 5;

type ProductWorkflowEvent = Extract<
  OrchestrationEvent,
  {
    type:
      | "thread.activity-appended"
      | "thread.planning-issues-created"
      | "thread.planning-issues-revised";
  }
>;

const isProductWorkflowThread = (thread: {
  readonly interactionMode: string;
  readonly workflowRole: string | null;
}) => thread.interactionMode === "product-workflow" && thread.workflowRole === null;

const isProductPlanningOrchestratorThread = (thread: {
  readonly interactionMode: string;
  readonly workflowRole: string | null;
  readonly parentThreadId: ThreadId | null;
}) =>
  thread.interactionMode === "planning-workflow" &&
  thread.workflowRole === "planning-orchestrator" &&
  thread.parentThreadId !== null;

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const gitWorkflow = yield* GitWorkflowService;

  const serverCommandId = (tag: string) =>
    crypto.randomUUIDv4.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));
  const serverEventId = () => crypto.randomUUIDv4.pipe(Effect.map(EventId.make));
  const serverMessageId = (tag: string) =>
    crypto.randomUUIDv4.pipe(Effect.map((uuid) => MessageId.make(`message-${tag}-${uuid}`)));

  const resolveThread = (threadId: ThreadId) =>
    projectionSnapshotQuery.getThreadDetailById(threadId).pipe(Effect.map(Option.getOrUndefined));

  const resolveProject = (projectId: ProjectId) =>
    projectionSnapshotQuery.getProjectShellById(projectId).pipe(Effect.map(Option.getOrUndefined));

  const resolveProductPlanningContext = Effect.fn(
    "ProductWorkflowReactor.resolveProductPlanningContext",
  )(function* (thread: OrchestrationThread) {
    if (!isProductPlanningOrchestratorThread(thread)) {
      return null;
    }
    const parentThreadId = thread.parentThreadId;
    if (parentThreadId === null) {
      return null;
    }
    const rootThread = yield* resolveThread(parentThreadId);
    if (!rootThread || !isProductWorkflowThread(rootThread)) {
      return null;
    }
    return {
      planningThread: thread,
      productRootThread: rootThread,
    };
  });

  const hasActivePlanningOrchestratorChild = Effect.fn(
    "ProductWorkflowReactor.hasActivePlanningOrchestratorChild",
  )(function* (rootThreadId: ThreadId) {
    const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
    return readModel.threads.some(
      (thread) =>
        thread.parentThreadId === rootThreadId &&
        thread.workflowRole === "planning-orchestrator" &&
        thread.deletedAt === null,
    );
  });

  const appendActivity = Effect.fn("ProductWorkflowReactor.appendActivity")(function* (input: {
    readonly threadId: ThreadId;
    readonly tone: "info" | "error";
    readonly kind: string;
    readonly summary: string;
    readonly payload: unknown;
    readonly createdAt: string;
  }) {
    yield* orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: yield* serverCommandId("product-workflow-activity"),
      threadId: input.threadId,
      activity: {
        id: yield* serverEventId(),
        tone: input.tone,
        kind: input.kind,
        summary: input.summary,
        payload: input.payload,
        turnId: null,
        createdAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });
  });

  const requestIssueReview = Effect.fn("ProductWorkflowReactor.requestIssueReview")(function* (
    event: Extract<
      ProductWorkflowEvent,
      { type: "thread.planning-issues-created" | "thread.planning-issues-revised" }
    >,
  ) {
    if (event.payload.stage !== "issue-review") return;
    if (
      event.type === "thread.planning-issues-revised" &&
      event.payload.reviewCycle !== undefined
    ) {
      return;
    }
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) return;
    const context = yield* resolveProductPlanningContext(thread);
    if (context === null) return;
    const prd = context.planningThread.planningWorkflow?.prd;
    if (!prd || prd.id !== event.payload.prdId) return;

    yield* orchestrationEngine.dispatch({
      type: "thread.planning-issue-review.request",
      commandId: yield* serverCommandId("product-issue-review-request"),
      threadId: context.planningThread.id,
      prdId: prd.id,
      createdAt: event.occurredAt,
    });
  });

  const reviseIssues = Effect.fn("ProductWorkflowReactor.reviseIssues")(function* (input: {
    readonly threadId: ThreadId;
    readonly prdId: string;
    readonly cycle: OrchestrationPlanningReviewCycle;
    readonly createdAt: string;
  }) {
    const thread = yield* resolveThread(input.threadId);
    if (!thread) return;
    const context = yield* resolveProductPlanningContext(thread);
    if (context === null) return;
    const prd = context.planningThread.planningWorkflow?.prd;
    if (!prd || prd.id !== input.prdId) return;

    const messageId = yield* serverMessageId("product-issues-revision");
    const feedback = [
      `Revise planning issues for PRD "${prd.title}" after failed review cycle ${input.cycle.cycleNumber}.`,
      "",
      "Do not ask the user questions. Apply the concrete reviewer feedback and finish with a planning-issues-artifact JSON directive.",
      "",
      "Reviewer verdict:",
      input.cycle.verdictMarkdown,
      "",
      "Failing issue ids:",
      input.cycle.failingPlanningIssueIds.length > 0
        ? input.cycle.failingPlanningIssueIds.map((id) => `- ${id}`).join("\n")
        : "- None specified",
    ].join("\n");

    yield* orchestrationEngine.dispatch({
      type: "thread.turn.start",
      commandId: yield* serverCommandId("product-issues-revision-turn"),
      threadId: context.planningThread.id,
      message: {
        messageId,
        role: "user",
        text: feedback,
        attachments: [],
      },
      workflowPromptId: WORKFLOW_PROMPT_IDS.planningIssuesCodex,
      runtimeMode: context.planningThread.runtimeMode,
      interactionMode: context.planningThread.interactionMode,
      createdAt: input.createdAt,
    });
  });

  const blockPlanning = Effect.fn("ProductWorkflowReactor.blockPlanning")(function* (input: {
    readonly planningThreadId: ThreadId;
    readonly productRootThreadId: ThreadId;
    readonly reasonMarkdown: string;
    readonly createdAt: string;
  }) {
    yield* orchestrationEngine.dispatch({
      type: "thread.planning-workflow.stage.set",
      commandId: yield* serverCommandId("product-planning-stage-blocked"),
      threadId: input.planningThreadId,
      stage: "needs-human-attention",
      reasonMarkdown: input.reasonMarkdown,
      createdAt: input.createdAt,
    });
    yield* appendActivity({
      threadId: input.productRootThreadId,
      tone: "error",
      kind: "product-workflow.needs-human-attention",
      summary: "Product Grill needs human attention",
      payload: { reasonMarkdown: input.reasonMarkdown },
      createdAt: input.createdAt,
    });
  });

  const launchImplementation = Effect.fn("ProductWorkflowReactor.launchImplementation")(function* (
    event: Extract<ProductWorkflowEvent, { type: "thread.planning-issues-revised" }>,
  ) {
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) return;
    const context = yield* resolveProductPlanningContext(thread);
    if (context === null) return;
    const workflow = context.planningThread.planningWorkflow;
    const prd = workflow?.prd ?? null;
    if (!workflow) return;
    if (!prd || prd.id !== event.payload.prdId || workflow.issues.length === 0) return;

    const existingRun =
      (yield* projectionSnapshotQuery.getCommandReadModel()).implementationRuns.find(
        (run) => run.prdId === prd.id && run.status !== "canceled",
      );
    if (existingRun !== undefined) return;

    const project = yield* resolveProject(context.productRootThread.projectId);
    if (!project) return;
    const sourceCwd = context.productRootThread.worktreePath ?? project.workspaceRoot;
    const pinnedCommit = yield* gitWorkflow
      .resolveCommit({ cwd: sourceCwd, ref: "HEAD" })
      .pipe(Effect.map((result) => result.commitSha));
    const identity = resolveImplementationBranchIdentity({
      prdId: prd.id,
      prdTitle: prd.title,
      baseBranch: context.productRootThread.branch ?? "main",
      workspaceRoot: sourceCwd,
      implementationRuns: (yield* projectionSnapshotQuery.getCommandReadModel()).implementationRuns,
    });

    yield* orchestrationEngine.dispatch({
      type: "thread.implementation-run.launch",
      commandId: yield* serverCommandId("product-implementation-launch"),
      threadId: context.productRootThread.id,
      prdId: prd.id,
      baseBranch: identity.baseBranch,
      pinnedCommit,
      orchestratorBranch: identity.orchestratorBranch,
      orchestratorWorktreePath: identity.orchestratorWorktreePath,
      validationCommands: ["vp check", "vp run typecheck"],
      createdAt: event.occurredAt,
    });
  });

  const handleReviewCycle = Effect.fn("ProductWorkflowReactor.handleReviewCycle")(function* (
    event: Extract<ProductWorkflowEvent, { type: "thread.planning-issues-revised" }>,
  ) {
    const cycle = event.payload.reviewCycle;
    if (cycle === undefined) return;
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) return;
    const context = yield* resolveProductPlanningContext(thread);
    if (context === null) return;

    if (cycle.status === "failed") {
      if (cycle.cycleNumber < MAX_PLANNING_REVIEW_CYCLE_NUMBER) {
        yield* reviseIssues({
          threadId: context.planningThread.id,
          prdId: event.payload.prdId,
          cycle,
          createdAt: event.payload.revisedAt,
        });
        return;
      }
      yield* blockPlanning({
        planningThreadId: context.planningThread.id,
        productRootThreadId: context.productRootThread.id,
        reasonMarkdown: `Planning issue review failed ${cycle.cycleNumber} times. Latest verdict:\n\n${cycle.verdictMarkdown}`,
        createdAt: event.payload.revisedAt,
      });
      return;
    }

    yield* launchImplementation(event);
  });

  const handleProductIntentLocked = Effect.fn("ProductWorkflowReactor.handleProductIntentLocked")(
    function* (event: Extract<ProductWorkflowEvent, { type: "thread.activity-appended" }>) {
      if (event.payload.activity.kind !== "product-intent-locked") return;
      const thread = yield* resolveThread(event.payload.threadId);
      if (!thread || !isProductWorkflowThread(thread)) return;
      const payload =
        event.payload.activity.payload !== null &&
        typeof event.payload.activity.payload === "object"
          ? (event.payload.activity.payload as Record<string, unknown>)
          : {};
      const payloadTitle = typeof payload.title === "string" ? payload.title.trim() : "";
      const payloadSummary =
        typeof payload.summaryMarkdown === "string" ? payload.summaryMarkdown.trim() : "";
      const intentTitle = payloadTitle.length > 0 ? payloadTitle : event.payload.activity.summary;
      const intentSummaryMarkdown = payloadSummary.length > 0 ? payloadSummary : intentTitle;
      if (intentTitle.trim().length === 0 || intentSummaryMarkdown.trim().length === 0) return;
      if (yield* hasActivePlanningOrchestratorChild(thread.id)) return;

      yield* orchestrationEngine.dispatch({
        type: "thread.planning-workflow.launch",
        commandId: yield* serverCommandId("product-planning-launch"),
        threadId: thread.id,
        intentTitle,
        intentSummaryMarkdown,
        createdAt: event.payload.activity.createdAt,
      });
    },
  );

  const processEvent = Effect.fn("ProductWorkflowReactor.processEvent")(function* (
    event: ProductWorkflowEvent,
  ) {
    switch (event.type) {
      case "thread.activity-appended":
        yield* handleProductIntentLocked(event);
        return;
      case "thread.planning-issues-created":
        yield* requestIssueReview(event);
        return;
      case "thread.planning-issues-revised":
        yield* handleReviewCycle(event);
        yield* requestIssueReview(event);
        return;
    }
  });

  const processEventSafely = (event: ProductWorkflowEvent) =>
    processEvent(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("product workflow reactor failed to process event", {
          eventType: event.type,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processEventSafely);

  const start: ProductWorkflowReactorShape["start"] = Effect.fn("start")(function* () {
    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (
          event.type !== "thread.activity-appended" &&
          event.type !== "thread.planning-issues-created" &&
          event.type !== "thread.planning-issues-revised"
        ) {
          return Effect.void;
        }
        return worker.enqueue(event);
      }),
    );
  });

  return {
    start,
    drain: worker.drain,
  } satisfies ProductWorkflowReactorShape;
});

export const ProductWorkflowReactorLive = Layer.effect(ProductWorkflowReactor, make);
