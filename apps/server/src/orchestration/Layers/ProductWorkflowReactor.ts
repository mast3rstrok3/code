import {
  CommandId,
  EventId,
  MessageId,
  type OrchestrationEvent,
  type OrchestrationThread,
  type OrchestrationPlanningReviewCycle,
  type OrchestrationProposedPlan,
  PLANNING_REVIEW_MAX_CYCLES,
  type ProjectId,
  ThreadId,
  type TurnId,
  WORKFLOW_AUTOMATION_RUNTIME_MODE,
} from "@t3tools/contracts";
import {
  resolveImplementationBranchIdentity,
  resolveWorkflowWorkspaceIdentity,
} from "@t3tools/shared/orchestrationImplementation";
import { resolveImplementationValidationCommands } from "@t3tools/shared/t3ProjectFile";
import {
  buildPlanImplementationPrompt,
  buildPlanImplementationThreadTitle,
} from "@t3tools/shared/orchestrationPlanning";
import { isTemporaryWorktreeBranch } from "@t3tools/shared/git";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import {
  expectedIntentKindForWorkflowPreset,
  isProductWorkflowRoot,
  workflowPromptIdForPreset,
} from "@t3tools/shared/workflowPresets";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
import { T3ProjectFileLoader } from "../../project/T3ProjectFileLoader.ts";
import { WORKFLOW_PROMPT_IDS } from "../../provider/WorkflowPromptRegistry.ts";
import { forkParked, ServerActivation } from "../../serverActivation.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  ProductWorkflowReactor,
  type ProductWorkflowReactorShape,
} from "../Services/ProductWorkflowReactor.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";

type ProductWorkflowEvent = Extract<
  OrchestrationEvent,
  {
    type:
      | "thread.activity-appended"
      | "thread.planning-tickets-created"
      | "thread.planning-tickets-revised"
      | "thread.proposed-plan-upserted"
      | "thread.meta-updated"
      | "thread.session-set";
  }
>;

const PRODUCT_GRILL_RECOVERY_MAX_ATTEMPTS = 2;
const ENGINEERING_GRILL_RECOVERY_MAX_ATTEMPTS = 2;
const ENGINEERING_GRILL_RECOVERY_PROMPT_PREFIX =
  "The previous automatic Engineering Grill turn completed without its required workflow directive.";
const PRODUCT_CONTEXT_RECOVERY_PROMPT_PREFIX =
  "The previous automatic Product Context turn completed without its required workflow directive.";

const isProductWorkflowThread = isProductWorkflowRoot;
const isRecoverablePlanningGrillThread = (thread: OrchestrationThread) =>
  isProductWorkflowThread(thread) ||
  (thread.workflowRole === null && thread.workflowPreset === "planning");

const isProductPlanningOrchestratorThread = (thread: {
  readonly interactionMode: string;
  readonly workflowRole: string | null;
  readonly parentThreadId: ThreadId | null;
}) =>
  thread.interactionMode === "planning-workflow" &&
  thread.workflowRole === "planning-orchestrator" &&
  thread.parentThreadId !== null;

const hasFixIntentLockedActivity = (thread: OrchestrationThread) =>
  thread.activities.some((activity) => {
    if (activity.kind !== "product-intent-locked") return false;
    const payload =
      activity.payload !== null && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : {};
    return payload.intentKind === "fix";
  });

const hasProductIntentLockedActivity = (thread: OrchestrationThread) =>
  thread.activities.some((activity) => activity.kind === "product-intent-locked");

const hasOpenUserInputRequest = (thread: OrchestrationThread) => {
  const openRequestIds = new Set<string>();
  for (const activity of thread.activities) {
    const payload =
      activity.payload !== null && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : {};
    const requestId = typeof payload.requestId === "string" ? payload.requestId : null;
    if (requestId === null) continue;
    if (activity.kind === "user-input.requested") {
      openRequestIds.add(requestId);
      continue;
    }
    if (
      activity.kind === "user-input.resolved" ||
      activity.kind === "provider.user-input.respond.failed"
    ) {
      openRequestIds.delete(requestId);
    }
  }
  return openRequestIds.size > 0;
};

const buildProductGrillRecoveryPrompt = (thread: OrchestrationThread) => {
  const settledAnswers = new Map<string, unknown>();
  for (const activity of thread.activities) {
    if (activity.kind !== "user-input.resolved") continue;
    const payload =
      activity.payload !== null && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : {};
    const answers =
      payload.answers !== null && typeof payload.answers === "object"
        ? (payload.answers as Record<string, unknown>)
        : {};
    for (const [questionId, answer] of Object.entries(answers)) {
      settledAnswers.set(questionId, answer);
    }
  }

  const settledAnswerState = Object.fromEntries(settledAnswers);
  return [
    "The previous turn ended before completing the selected Product Grill.",
    "",
    "The following structured Product Grill answers are already settled and authoritative. Do not repeat these questions or ask the user to submit these answers again unless the user explicitly reopens or contradicts one:",
    "",
    "```json",
    JSON.stringify(settledAnswerState, null, 2),
    "```",
    "",
    "Do not implement, investigate, or verify the requested work yet. Continue only from the unresolved product-decision frontier with workflow_request_user_input. If the settled answers complete the frontier, ask only for the explicit final lock-in confirmation. If that confirmation is already settled as affirmative, emit product-intent-locked immediately. Only then may the selected workflow continue automatically into Planning, Build, App Review, Code Review, and change-request publication.",
  ].join("\n");
};

const buildEngineeringGrillRecoveryPrompt = (productContextOnly = false) =>
  [
    productContextOnly
      ? PRODUCT_CONTEXT_RECOVERY_PROMPT_PREFIX
      : ENGINEERING_GRILL_RECOVERY_PROMPT_PREFIX,
    "",
    "Keep the locked Product Grill intent and the engineering decisions already resolved in the conversation authoritative. Do not repeat the Product Grill, ask the user questions, or wait for confirmation.",
    "",
    "If the engineering frontier is already complete, preserve the plan and conclusions you just produced. Otherwise resolve only the remaining engineering and domain decisions autonomously.",
    "",
    'Finish this turn with exactly one fenced JSON block containing { "type": "planning-grill-complete" }. Do not write the Spec in this stage.',
  ].join("\n");

const buildPlanningGrillRecoveryPrompt = () =>
  [
    ENGINEERING_GRILL_RECOVERY_PROMPT_PREFIX,
    "",
    "Preserve every decision already settled in the Grill with Docs conversation and every scope or question-limit instruction from the user's original prompt. Do not ask the user to choose a grill type.",
    "",
    "Continue only the unresolved frontier allowed by the user's scope. Resolve discoverable facts from the repository and record assumptions when the user's question limit prevents another interview round.",
    "",
    'When that frontier is complete and confirmed, finish with exactly one fenced JSON block containing { "type": "planning-grill-complete" }. Do not write the Spec in this stage.',
  ].join("\n");

const buildProductLightweightPlanPrompt = (input: {
  readonly intentKind: "fix" | "feature";
  readonly intentTitle: string;
  readonly intentSummaryMarkdown: string;
}) =>
  [
    `Create an implementation plan for the locked ${input.intentKind} intent "${input.intentTitle}".`,
    "",
    "The intent is locked. Do not ask the user questions or reopen the intent.",
    "",
    "Locked intent summary:",
    input.intentSummaryMarkdown,
    "",
    "Explore the codebase, find the root cause, and produce a concrete, minimal implementation plan: the exact files to change, the changes to make, and the tests that prove the fix. Finish by exiting plan mode with the final plan — implementation starts automatically from your proposed plan.",
  ].join("\n");

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const gitWorkflow = yield* GitWorkflowService;
  const projectFileLoader = yield* T3ProjectFileLoader;

  const serverCommandId = (tag: string) =>
    crypto.randomUUIDv4.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));
  const serverEventId = () => crypto.randomUUIDv4.pipe(Effect.map(EventId.make));
  const serverMessageId = (tag: string) =>
    crypto.randomUUIDv4.pipe(Effect.map((uuid) => MessageId.make(`message-${tag}-${uuid}`)));
  const serverThreadId = (tag: string) =>
    crypto.randomUUIDv4.pipe(Effect.map((uuid) => ThreadId.make(`thread-${tag}-${uuid}`)));

  const resolveThread = (threadId: ThreadId) =>
    projectionSnapshotQuery.getThreadDetailById(threadId).pipe(Effect.map(Option.getOrUndefined));

  const resolveProject = (projectId: ProjectId) =>
    projectionSnapshotQuery.getProjectShellById(projectId).pipe(Effect.map(Option.getOrUndefined));

  const resolveProductPlanningContext = Effect.fn(
    "ProductWorkflowReactor.resolveProductPlanningContext",
  )(function* (thread: OrchestrationThread) {
    // Planning runs in the product root thread itself; the child-thread shape
    // below only remains for planning-orchestrator threads created before that.
    if (isProductWorkflowThread(thread) && thread.planningWorkflow != null) {
      return {
        planningThread: thread,
        productRootThread: thread,
      };
    }
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

  const findFixImplementerChild = Effect.fn("ProductWorkflowReactor.findFixImplementerChild")(
    function* (rootThreadId: ThreadId) {
      const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
      return (
        readModel.threads.find(
          (thread) =>
            thread.parentThreadId === rootThreadId &&
            thread.workflowRole === "product-fix-implementer" &&
            thread.deletedAt === null,
        ) ?? null
      );
    },
  );

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

  const requestTicketReview = Effect.fn("ProductWorkflowReactor.requestTicketReview")(function* (
    event: Extract<
      ProductWorkflowEvent,
      { type: "thread.planning-tickets-created" | "thread.planning-tickets-revised" }
    >,
  ) {
    if (event.payload.stage !== "ticket-review") return;
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) return;
    const planningWorkflow = thread.planningWorkflow;
    const spec = planningWorkflow?.spec;
    if (!spec || spec.id !== event.payload.specId) return;
    if (
      planningWorkflow.stage !== "ticket-review" ||
      planningWorkflow.reviewCycles.length >= PLANNING_REVIEW_MAX_CYCLES
    ) {
      return;
    }

    yield* orchestrationEngine.dispatch({
      type: "thread.planning-ticket-review.request",
      commandId: yield* serverCommandId("product-ticket-review-request"),
      threadId: thread.id,
      specId: spec.id,
      createdAt: event.occurredAt,
    });
  });

  const completePlanningWithWarnings = Effect.fn(
    "ProductWorkflowReactor.completePlanningWithWarnings",
  )(function* (input: {
    readonly planningThreadId: ThreadId;
    readonly activityThreadId: ThreadId;
    readonly cycle: OrchestrationPlanningReviewCycle;
    readonly createdAt: string;
  }) {
    const reasonMarkdown = `Planning ticket review reached cycle ${input.cycle.cycleNumber} without a clean full pass. Latest verdict:\n\n${input.cycle.verdictMarkdown}`;
    yield* orchestrationEngine.dispatch({
      type: "thread.planning-workflow.stage.set",
      commandId: yield* serverCommandId("product-planning-stage-warnings"),
      threadId: input.planningThreadId,
      stage: "completed-with-warnings",
      reasonMarkdown,
      createdAt: input.createdAt,
    });
    yield* appendActivity({
      threadId: input.activityThreadId,
      tone: "error",
      kind: "planning-workflow.completed-with-warnings",
      summary: "Planning completed with unresolved ticket review warnings",
      payload: {
        reasonMarkdown,
        cycleNumber: input.cycle.cycleNumber,
        unresolvedTicketIds: input.cycle.failingPlanningTicketIds,
      },
      createdAt: input.createdAt,
    });
  });

  const launchImplementationForContext = Effect.fn(
    "ProductWorkflowReactor.launchImplementationForContext",
  )(function* (input: {
    readonly context: {
      readonly planningThread: OrchestrationThread;
      readonly productRootThread: OrchestrationThread;
    };
    readonly specId: string;
    readonly occurredAt: string;
  }) {
    const context = input.context;
    const workflow = context.planningThread.planningWorkflow;
    const spec = workflow?.spec ?? null;
    if (!workflow) return;
    if (!spec || spec.id !== input.specId || workflow.tickets.length === 0) return;

    const existingRun =
      (yield* projectionSnapshotQuery.getCommandReadModel()).implementationRuns.find(
        (run) => run.specId === spec.id && run.status !== "canceled",
      );
    if (existingRun !== undefined) return;

    const project = yield* resolveProject(context.productRootThread.projectId);
    if (!project) return;
    const sourceCwd = context.productRootThread.worktreePath ?? project.workspaceRoot;
    const projectFile = Option.getOrUndefined(yield* projectFileLoader.load(sourceCwd));
    const pinnedCommit = yield* gitWorkflow
      .resolveCommit({ cwd: sourceCwd, ref: "HEAD" })
      .pipe(Effect.map((result) => result.commitSha));
    const workflowWorkspace = resolveWorkflowWorkspaceIdentity(
      context.productRootThread.activities,
    );
    if (
      workflowWorkspace !== null &&
      (context.productRootThread.branch === null ||
        isTemporaryWorktreeBranch(context.productRootThread.branch))
    ) {
      return;
    }
    const identity =
      workflowWorkspace === null
        ? resolveImplementationBranchIdentity({
            specId: spec.id,
            specTitle: spec.title,
            baseBranch: context.productRootThread.branch ?? "main",
            workspaceRoot: sourceCwd,
            implementationRuns: (yield* projectionSnapshotQuery.getCommandReadModel())
              .implementationRuns,
          })
        : {
            baseBranch: workflowWorkspace.baseBranch,
            // The first-turn branch naming reactor may replace the temporary bootstrap ref with a
            // semantic name. The thread projection is authoritative after that rename; the
            // workspace activity remains the durable source for the original base and path.
            orchestratorBranch: context.productRootThread.branch ?? workflowWorkspace.branch,
            orchestratorWorktreePath: workflowWorkspace.worktreePath,
          };

    yield* orchestrationEngine.dispatch({
      type: "thread.implementation-run.launch",
      commandId: yield* serverCommandId("product-implementation-launch"),
      threadId: context.productRootThread.id,
      specId: spec.id,
      baseBranch: identity.baseBranch,
      pinnedCommit,
      orchestratorBranch: identity.orchestratorBranch,
      orchestratorWorktreePath: identity.orchestratorWorktreePath,
      validationCommands: [...resolveImplementationValidationCommands({ projectFile })],
      createdAt: input.occurredAt,
    });
  });

  const launchImplementation = Effect.fn("ProductWorkflowReactor.launchImplementation")(function* (
    event: Extract<ProductWorkflowEvent, { type: "thread.planning-tickets-revised" }>,
  ) {
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) return;
    const productContext = yield* resolveProductPlanningContext(thread);
    const context =
      productContext ??
      (thread.workflowRole === null && thread.workflowPreset === "planning"
        ? { planningThread: thread, productRootThread: thread }
        : null);
    if (context === null) return;
    yield* launchImplementationForContext({
      context,
      specId: event.payload.specId,
      occurredAt: event.payload.revisedAt,
    });
  });

  const reconcileImplementationLaunches = Effect.fn(
    "ProductWorkflowReactor.reconcileImplementationLaunches",
  )(function* () {
    const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
    for (const planningThread of readModel.threads) {
      const plansInOwnThread =
        isProductWorkflowThread(planningThread) && planningThread.planningWorkflow != null;
      if (!plansInOwnThread && !isProductPlanningOrchestratorThread(planningThread)) continue;
      const workflow = planningThread.planningWorkflow;
      if (
        workflow?.spec === null ||
        workflow?.spec === undefined ||
        (workflow.stage !== "completed" && workflow.stage !== "completed-with-warnings")
      ) {
        continue;
      }
      const productContext = yield* resolveProductPlanningContext(planningThread);
      const context =
        productContext ??
        (planningThread.workflowRole === null && planningThread.workflowPreset === "planning"
          ? { planningThread, productRootThread: planningThread }
          : null);
      if (context === null) continue;
      yield* launchImplementationForContext({
        context,
        specId: workflow.spec.id,
        occurredAt: planningThread.updatedAt,
      });
    }
  });

  const handleReviewCycle = Effect.fn("ProductWorkflowReactor.handleReviewCycle")(function* (
    event: Extract<ProductWorkflowEvent, { type: "thread.planning-tickets-revised" }>,
  ) {
    const cycle = event.payload.reviewCycle;
    if (cycle === undefined) return;
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) return;
    const context = yield* resolveProductPlanningContext(thread);

    const startsImplementation =
      context !== null || (thread.workflowRole === null && thread.workflowPreset === "planning");

    // The decider owns "is ticket review over" — a cycle that fixed its own findings completes the
    // stage with status `revised`, so reading the stage is what keeps that cycle from being the
    // last one before an idle workflow.
    if (event.payload.stage === "completed" && startsImplementation) {
      yield* launchImplementation(event);
      return;
    }

    if (cycle.cycleNumber >= PLANNING_REVIEW_MAX_CYCLES) {
      yield* completePlanningWithWarnings({
        planningThreadId: thread.id,
        activityThreadId: context?.productRootThread.id ?? thread.id,
        cycle,
        createdAt: event.payload.revisedAt,
      });
      if (startsImplementation) {
        yield* launchImplementation(event);
      }
      return;
    }
  });

  const launchLightweightPlanning = Effect.fn("ProductWorkflowReactor.launchLightweightPlanning")(
    function* (input: {
      readonly thread: OrchestrationThread;
      readonly intentKind: "fix" | "feature";
      readonly intentTitle: string;
      readonly intentSummaryMarkdown: string;
      readonly createdAt: string;
    }) {
      yield* orchestrationEngine.dispatch({
        type: "thread.interaction-mode.set",
        commandId: yield* serverCommandId("product-fix-plan-mode"),
        threadId: input.thread.id,
        interactionMode: "plan",
        createdAt: input.createdAt,
      });
      // Intent lock ends the human gate; planning and everything after it run
      // unattended.
      yield* orchestrationEngine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: yield* serverCommandId("product-fix-plan-runtime-mode"),
        threadId: input.thread.id,
        runtimeMode: WORKFLOW_AUTOMATION_RUNTIME_MODE,
        createdAt: input.createdAt,
      });
      yield* orchestrationEngine.dispatch({
        type: "thread.turn.start",
        commandId: yield* serverCommandId("product-fix-plan-turn"),
        threadId: input.thread.id,
        message: {
          messageId: yield* serverMessageId("product-fix-plan"),
          role: "user",
          text: buildProductLightweightPlanPrompt({
            intentKind: input.intentKind,
            intentTitle: input.intentTitle,
            intentSummaryMarkdown: input.intentSummaryMarkdown,
          }),
          attachments: [],
        },
        runtimeMode: WORKFLOW_AUTOMATION_RUNTIME_MODE,
        interactionMode: "plan",
        createdAt: input.createdAt,
      });
      yield* appendActivity({
        threadId: input.thread.id,
        tone: "info",
        kind: input.intentKind === "fix" ? "product-fix-plan-started" : "product-fast-plan-started",
        summary:
          input.intentKind === "fix" ? "Fix planning started" : "Fast feature planning started",
        payload: { intentTitle: input.intentTitle },
        createdAt: input.createdAt,
      });
    },
  );

  const hasActiveFastFeatureRun = Effect.fn("ProductWorkflowReactor.hasActiveFastFeatureRun")(
    function* (threadId: ThreadId, planId: string) {
      const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
      return readModel.implementationRuns.some(
        (run) =>
          run.artifactSource === "proposed-plan" &&
          run.sourceProposedPlan?.threadId === threadId &&
          run.sourceProposedPlan.planId === planId &&
          run.status !== "canceled",
      );
    },
  );

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

      const presetIntentKind = expectedIntentKindForWorkflowPreset(thread.workflowPreset);
      const intentKind = presetIntentKind ?? payload.intentKind;
      if (
        thread.workflowPreset === "fix" ||
        thread.workflowPreset === "fast-feature" ||
        intentKind === "fix"
      ) {
        if (
          thread.activities.some(
            (activity) =>
              activity.kind === "product-fix-plan-started" ||
              activity.kind === "product-fast-plan-started",
          )
        ) {
          return;
        }
        yield* launchLightweightPlanning({
          thread,
          intentKind: intentKind === "fix" ? "fix" : "feature",
          intentTitle,
          intentSummaryMarkdown,
          createdAt: event.payload.activity.createdAt,
        });
        return;
      }

      if (thread.planningWorkflow != null) return;
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

  /**
   * Whether the plan handover already reached this thread. Threads in the command read model carry
   * no messages, so this needs the thread detail; `latestTurn` is no substitute, as it only appears
   * once a provider session exists.
   */
  const hasHandoverMessage = Effect.fn("ProductWorkflowReactor.hasHandoverMessage")(function* (
    threadId: ThreadId,
  ) {
    const detail = yield* projectionSnapshotQuery.getThreadDetailById(threadId);
    return Option.match(detail, {
      onNone: () => false,
      onSome: (thread) => thread.messages.some((message) => message.role === "user"),
    });
  });

  /**
   * Hands a fix plan to a Build-mode child thread. The thread and its seeding turn are two
   * dispatches, so a restart between them leaves a child with no message at all — re-seed that
   * child instead of treating its mere existence as "already handed over".
   */
  const ensureFixImplementation = Effect.fn("ProductWorkflowReactor.ensureFixImplementation")(
    function* (input: {
      readonly thread: OrchestrationThread;
      readonly plan: OrchestrationProposedPlan;
      readonly occurredAt: string;
    }) {
      const { thread, plan } = input;
      const existingChild = yield* findFixImplementerChild(thread.id);
      if (existingChild !== null && (yield* hasHandoverMessage(existingChild.id))) return;

      const title = buildPlanImplementationThreadTitle(plan.planMarkdown);
      const implementationThreadId =
        existingChild?.id ?? (yield* serverThreadId("product-fix-implementer"));
      if (existingChild === null) {
        yield* orchestrationEngine.dispatch({
          type: "thread.create",
          commandId: yield* serverCommandId("product-fix-implementer-create"),
          threadId: implementationThreadId,
          projectId: thread.projectId,
          ownerUserId: thread.ownerUserId,
          parentThreadId: thread.id,
          workflowRole: "product-fix-implementer",
          title,
          modelSelection: thread.modelSelection,
          runtimeMode: WORKFLOW_AUTOMATION_RUNTIME_MODE,
          interactionMode: "default",
          branch: thread.branch,
          worktreePath: thread.worktreePath,
          createdAt: input.occurredAt,
        });
      }
      yield* orchestrationEngine.dispatch({
        type: "thread.turn.start",
        commandId: yield* serverCommandId("product-fix-implementer-turn"),
        threadId: implementationThreadId,
        message: {
          messageId: yield* serverMessageId("product-fix-implementer"),
          role: "user",
          text: buildPlanImplementationPrompt(plan.planMarkdown),
          attachments: [],
        },
        titleSeed: title,
        runtimeMode: WORKFLOW_AUTOMATION_RUNTIME_MODE,
        interactionMode: "default",
        sourceProposedPlan: { threadId: thread.id, planId: plan.id },
        createdAt: input.occurredAt,
      });
      if (existingChild !== null) return;
      yield* appendActivity({
        threadId: thread.id,
        tone: "info",
        kind: "product-fix-implementation-started",
        summary: "Fix implementation started",
        payload: { implementationThreadId, planId: plan.id },
        createdAt: input.occurredAt,
      });
    },
  );

  /**
   * Re-seeds fix handovers stranded by a restart between `thread.create` and `thread.turn.start`.
   * `processEventSafely` only logs such a failure, and the upsert event never fires again.
   */
  const reconcileFixImplementations = Effect.fn(
    "ProductWorkflowReactor.reconcileFixImplementations",
  )(function* () {
    const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
    // Narrow on the command read model — which does carry `proposedPlans` — then resolve the
    // detail, because the fix intent lives in an activity and the command read model has none.
    const candidates = readModel.threads.filter(
      (thread) =>
        thread.deletedAt === null &&
        thread.workflowRole === null &&
        thread.proposedPlans.some((plan) => plan.implementedAt === null),
    );
    for (const candidate of candidates) {
      const thread = yield* resolveThread(candidate.id);
      if (!thread) continue;
      if (thread.workflowPreset !== "fix" && !hasFixIntentLockedActivity(thread)) continue;
      for (const plan of thread.proposedPlans) {
        if (plan.implementedAt !== null) continue;
        yield* ensureFixImplementation({ thread, plan, occurredAt: thread.updatedAt });
      }
    }
  });

  const ensurePlanImplementation = Effect.fn("ProductWorkflowReactor.ensurePlanImplementation")(
    function* (input: {
      readonly threadId: ThreadId;
      readonly plan: OrchestrationThread["proposedPlans"][number];
      readonly occurredAt: string;
    }) {
      const plan = input.plan;
      if (plan.implementedAt !== null) return;
      const thread = yield* resolveThread(input.threadId);
      if (!thread) return;
      if (thread.workflowRole !== null) return;
      const isFastFeature = thread.workflowPreset === "fast-feature";
      const isFix = thread.workflowPreset === "fix" || hasFixIntentLockedActivity(thread);
      if (!isFastFeature && !isFix) return;
      if (isFastFeature) {
        if (yield* hasActiveFastFeatureRun(thread.id, plan.id)) return;
        const workflowWorkspace = resolveWorkflowWorkspaceIdentity(thread.activities);
        if (thread.branch === null || thread.branch.trim().length === 0) {
          yield* appendActivity({
            threadId: thread.id,
            tone: "error",
            kind: "fast-feature.needs-human-attention",
            summary: "Fast feature needs a named source branch",
            payload: { planId: plan.id },
            createdAt: input.occurredAt,
          });
          return;
        }
        if (workflowWorkspace !== null && isTemporaryWorktreeBranch(thread.branch)) return;
        const project = yield* resolveProject(thread.projectId);
        if (!project) return;
        const sourceCwd = thread.worktreePath ?? project.workspaceRoot;
        const projectFile = Option.getOrUndefined(yield* projectFileLoader.load(sourceCwd));
        const pinnedCommit = (yield* gitWorkflow.resolveCommit({ cwd: sourceCwd, ref: "HEAD" }))
          .commitSha;
        const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
        const identity =
          workflowWorkspace === null
            ? resolveImplementationBranchIdentity({
                specId: plan.id,
                specTitle: buildPlanImplementationThreadTitle(plan.planMarkdown),
                baseBranch: thread.branch,
                workspaceRoot: sourceCwd,
                implementationRuns: readModel.implementationRuns,
                branchPrefix: "fast-feature",
              })
            : {
                baseBranch: workflowWorkspace.baseBranch,
                orchestratorBranch: thread.branch ?? workflowWorkspace.branch,
                orchestratorWorktreePath: workflowWorkspace.worktreePath,
              };
        yield* orchestrationEngine.dispatch({
          type: "thread.fast-feature-run.launch",
          commandId: yield* serverCommandId("fast-feature-launch"),
          threadId: thread.id,
          proposedPlanId: plan.id,
          baseBranch: identity.baseBranch,
          pinnedCommit,
          orchestratorBranch: identity.orchestratorBranch,
          orchestratorWorktreePath: identity.orchestratorWorktreePath,
          validationCommands: [...resolveImplementationValidationCommands({ projectFile })],
          createdAt: input.occurredAt,
        });
        return;
      }
      yield* ensureFixImplementation({ thread, plan, occurredAt: input.occurredAt });
    },
  );

  const handlePlanReady = Effect.fn("ProductWorkflowReactor.handlePlanReady")(function* (
    event: Extract<ProductWorkflowEvent, { type: "thread.proposed-plan-upserted" }>,
  ) {
    yield* ensurePlanImplementation({
      threadId: event.payload.threadId,
      plan: event.payload.proposedPlan,
      occurredAt: event.occurredAt,
    });
  });

  const handleWorkspaceRenamed = Effect.fn("ProductWorkflowReactor.handleWorkspaceRenamed")(
    function* (event: Extract<ProductWorkflowEvent, { type: "thread.meta-updated" }>) {
      if (
        event.payload.branch === undefined ||
        event.payload.branch === null ||
        isTemporaryWorktreeBranch(event.payload.branch)
      ) {
        return;
      }
      const thread = yield* resolveThread(event.payload.threadId);
      if (!thread) return;
      for (const plan of thread.proposedPlans) {
        yield* ensurePlanImplementation({
          threadId: thread.id,
          plan,
          occurredAt: event.payload.updatedAt,
        });
      }
      yield* reconcileImplementationLaunches();
    },
  );

  const reconcileFastFeatureImplementations = Effect.fn(
    "ProductWorkflowReactor.reconcileFastFeatureImplementations",
  )(function* () {
    const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
    for (const candidate of readModel.threads) {
      if (
        candidate.deletedAt !== null ||
        candidate.workflowPreset !== "fast-feature" ||
        candidate.workflowRole !== null ||
        candidate.proposedPlans.every((plan) => plan.implementedAt !== null)
      ) {
        continue;
      }
      const thread = yield* resolveThread(candidate.id);
      if (!thread) continue;
      for (const plan of thread.proposedPlans) {
        yield* ensurePlanImplementation({
          threadId: thread.id,
          plan,
          occurredAt: thread.updatedAt,
        });
      }
    }
  });

  const recoverIncompleteProductGrill = Effect.fn(
    "ProductWorkflowReactor.recoverIncompleteProductGrill",
  )(function* (event: Extract<ProductWorkflowEvent, { type: "thread.activity-appended" }>) {
    if (event.payload.activity.kind !== "checkpoint.captured") return;
    const sourceTurnId = event.payload.activity.turnId;
    if (sourceTurnId === null) return;
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread || !isProductWorkflowThread(thread)) return;
    // Fast Feature starts directly in Plan mode. Its completed turn is a plan handoff,
    // not an interrupted Product Grill that needs recovery.
    if (thread.workflowPreset === "fast-feature") return;
    if (hasProductIntentLockedActivity(thread) || hasOpenUserInputRequest(thread)) return;
    if (
      thread.activities.some(
        (activity) =>
          activity.kind === "product-grill-recovery-requested" &&
          activity.payload !== null &&
          typeof activity.payload === "object" &&
          (activity.payload as Record<string, unknown>).sourceTurnId === sourceTurnId,
      )
    ) {
      return;
    }

    const recoveryCount = thread.activities.filter(
      (activity) => activity.kind === "product-grill-recovery-requested",
    ).length;
    if (recoveryCount >= PRODUCT_GRILL_RECOVERY_MAX_ATTEMPTS) {
      if (
        !thread.activities.some((activity) => activity.kind === "product-grill-recovery-blocked")
      ) {
        yield* appendActivity({
          threadId: thread.id,
          tone: "error",
          kind: "product-grill-recovery-blocked",
          summary: "Product Grill stopped before intent lock",
          payload: {
            sourceTurnId,
            attempts: recoveryCount,
            detail:
              "The selected product workflow repeatedly completed without structured Product Grill input or a product-intent-locked directive.",
          },
          createdAt: event.payload.activity.createdAt,
        });
      }
      return;
    }

    if (thread.workflowPreset === null || thread.workflowPreset === undefined) return;
    const workflowPromptId = workflowPromptIdForPreset(thread.workflowPreset);
    if (workflowPromptId === undefined) return;
    yield* appendActivity({
      threadId: thread.id,
      tone: "info",
      kind: "product-grill-recovery-requested",
      summary: "Resuming incomplete Product Grill",
      payload: {
        sourceTurnId,
        attempt: recoveryCount + 1,
      },
      createdAt: event.payload.activity.createdAt,
    });
    yield* orchestrationEngine.dispatch({
      type: "thread.turn.start",
      commandId: yield* serverCommandId("product-grill-recovery-turn"),
      threadId: thread.id,
      message: {
        messageId: yield* serverMessageId("product-grill-recovery"),
        role: "user",
        text: buildProductGrillRecoveryPrompt(thread),
        attachments: [],
      },
      runtimeMode: thread.runtimeMode,
      interactionMode: "product-workflow",
      workflowPromptId,
      createdAt: event.payload.activity.createdAt,
    });
  });

  const recoverIncompleteEngineeringGrill = Effect.fn(
    "ProductWorkflowReactor.recoverIncompleteEngineeringGrill",
  )(function* (input: {
    readonly thread: OrchestrationThread;
    readonly sourceTurnId: TurnId;
    readonly createdAt: string;
    readonly relaunchPendingRecovery?: boolean;
  }) {
    const { thread } = input;
    if (
      !isRecoverablePlanningGrillThread(thread) ||
      (thread.workflowPreset !== "full-feature" &&
        thread.workflowPreset !== "product-planning" &&
        thread.workflowPreset !== "planning")
    )
      return;
    if (thread.planningWorkflow?.stage !== "grill") return;
    const productContextOnly = thread.workflowPreset === "product-planning";
    const recoveryPrefix = productContextOnly
      ? PRODUCT_CONTEXT_RECOVERY_PROMPT_PREFIX
      : ENGINEERING_GRILL_RECOVERY_PROMPT_PREFIX;
    const latestUserMessageAt = thread.messages.reduce<string | null>(
      (latest, message) =>
        message.role === "user" &&
        !message.text.startsWith(recoveryPrefix) &&
        (latest === null || message.createdAt > latest)
          ? message.createdAt
          : latest,
      null,
    );
    if (
      thread.latestTurn?.turnId !== input.sourceTurnId ||
      thread.latestTurn.state !== "completed" ||
      thread.latestTurn.completedAt === null ||
      latestUserMessageAt === null ||
      thread.latestTurn.requestedAt < latestUserMessageAt
    ) {
      return;
    }

    const recoveryMessages = thread.messages.filter(
      (message) => message.role === "user" && message.text.startsWith(recoveryPrefix),
    );
    const recoveryAlreadyLaunched = recoveryMessages.some(
      (message) => message.createdAt >= (thread.latestTurn?.completedAt ?? input.createdAt),
    );
    if (recoveryAlreadyLaunched && input.relaunchPendingRecovery !== true) {
      return;
    }

    if (recoveryMessages.length >= ENGINEERING_GRILL_RECOVERY_MAX_ATTEMPTS) {
      if (
        !thread.activities.some(
          (activity) => activity.kind === "engineering-grill-recovery-blocked",
        )
      ) {
        yield* appendActivity({
          threadId: thread.id,
          tone: "error",
          kind: "engineering-grill-recovery-blocked",
          summary: "Engineering Grill stopped before Spec authoring",
          payload: {
            sourceTurnId: input.sourceTurnId,
            attempts: recoveryMessages.length,
            detail:
              "The automatic Engineering Grill repeatedly completed without a planning-grill-complete directive.",
          },
          createdAt: input.createdAt,
        });
      }
      return;
    }

    yield* orchestrationEngine.dispatch({
      type: "thread.turn.start",
      commandId: yield* serverCommandId("engineering-grill-recovery-turn"),
      threadId: thread.id,
      message: {
        messageId: yield* serverMessageId("engineering-grill-recovery"),
        role: "user",
        text:
          thread.workflowPreset === "planning"
            ? buildPlanningGrillRecoveryPrompt()
            : buildEngineeringGrillRecoveryPrompt(productContextOnly),
        attachments: [],
      },
      runtimeMode: WORKFLOW_AUTOMATION_RUNTIME_MODE,
      interactionMode: "planning-workflow",
      workflowPromptId:
        thread.workflowPreset === "product-planning"
          ? WORKFLOW_PROMPT_IDS.planningProductContextCodex
          : WORKFLOW_PROMPT_IDS.planningAutomaticEngineeringGrillCodex,
      createdAt: input.createdAt,
    });
    yield* appendActivity({
      threadId: thread.id,
      tone: "info",
      kind: "engineering-grill-recovery-requested",
      summary: "Resuming incomplete Engineering Grill",
      payload: {
        sourceTurnId: input.sourceTurnId,
        attempt: recoveryMessages.length + 1,
      },
      createdAt: input.createdAt,
    });
  });

  const recoverIncompleteEngineeringGrillFromCheckpoint = Effect.fn(
    "ProductWorkflowReactor.recoverIncompleteEngineeringGrillFromCheckpoint",
  )(function* (event: Extract<ProductWorkflowEvent, { type: "thread.activity-appended" }>) {
    if (event.payload.activity.kind !== "checkpoint.captured") return;
    const sourceTurnId = event.payload.activity.turnId;
    if (sourceTurnId === null) return;
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) return;
    yield* recoverIncompleteEngineeringGrill({
      thread,
      sourceTurnId,
      createdAt: event.payload.activity.createdAt,
    });
  });

  const recoverIncompleteEngineeringGrillFromReadySession = Effect.fn(
    "ProductWorkflowReactor.recoverIncompleteEngineeringGrillFromReadySession",
  )(function* (event: Extract<ProductWorkflowEvent, { type: "thread.session-set" }>) {
    if (event.payload.session.status !== "ready") return;
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread || thread.latestTurn === null) return;
    yield* recoverIncompleteEngineeringGrill({
      thread,
      sourceTurnId: thread.latestTurn.turnId,
      createdAt: event.payload.session.updatedAt,
    });
  });

  const reconcileIncompleteEngineeringGrills = Effect.fn(
    "ProductWorkflowReactor.reconcileIncompleteEngineeringGrills",
  )(function* () {
    const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
    for (const candidate of readModel.threads) {
      if (
        !isRecoverablePlanningGrillThread(candidate) ||
        (candidate.workflowPreset !== "full-feature" &&
          candidate.workflowPreset !== "product-planning" &&
          candidate.workflowPreset !== "planning") ||
        candidate.planningWorkflow?.stage !== "grill" ||
        candidate.latestTurn?.state !== "completed"
      ) {
        continue;
      }
      const thread = yield* resolveThread(candidate.id);
      if (!thread || thread.latestTurn === null) continue;
      yield* recoverIncompleteEngineeringGrill({
        thread,
        sourceTurnId: thread.latestTurn.turnId,
        createdAt: thread.latestTurn.completedAt ?? thread.updatedAt,
        relaunchPendingRecovery: true,
      });
    }
  });

  const processEvent = Effect.fn("ProductWorkflowReactor.processEvent")(function* (
    event: ProductWorkflowEvent,
  ) {
    switch (event.type) {
      case "thread.activity-appended":
        yield* handleProductIntentLocked(event);
        yield* recoverIncompleteProductGrill(event);
        yield* recoverIncompleteEngineeringGrillFromCheckpoint(event);
        return;
      case "thread.planning-tickets-created":
        yield* requestTicketReview(event);
        return;
      case "thread.planning-tickets-revised":
        yield* handleReviewCycle(event);
        yield* requestTicketReview(event);
        return;
      case "thread.proposed-plan-upserted":
        yield* handlePlanReady(event);
        return;
      case "thread.meta-updated":
        yield* handleWorkspaceRenamed(event);
        return;
      case "thread.session-set":
        yield* recoverIncompleteEngineeringGrillFromReadySession(event);
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
          event.type !== "thread.planning-tickets-created" &&
          event.type !== "thread.planning-tickets-revised" &&
          event.type !== "thread.proposed-plan-upserted" &&
          event.type !== "thread.meta-updated" &&
          event.type !== "thread.session-set"
        ) {
          return Effect.void;
        }
        return worker.enqueue(event);
      }),
    );

    const reconcileStartup = Effect.gen(function* () {
      yield* reconcileIncompleteEngineeringGrills().pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("product workflow Engineering Grill reconciliation failed", {
            cause: Cause.pretty(cause),
          }),
        ),
      );
      yield* reconcileImplementationLaunches().pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("product workflow implementation reconciliation failed", {
            cause: Cause.pretty(cause),
          }),
        ),
      );
      yield* reconcileFastFeatureImplementations().pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("product workflow Fast Build reconciliation failed", {
            cause: Cause.pretty(cause),
          }),
        ),
      );
      yield* reconcileFixImplementations().pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("product workflow fix handover reconciliation failed", {
            cause: Cause.pretty(cause),
          }),
        ),
      );
    });
    const activation = yield* ServerActivation;
    if (activation === undefined) {
      yield* reconcileStartup;
    } else {
      // Provider command handling parks at the same activation boundary. Yield once after
      // activation so its hot-stream subscriber is live before reconciliation emits turns.
      yield* forkParked(Effect.yieldNow.pipe(Effect.andThen(reconcileStartup)));
    }
  });

  return {
    start,
    drain: worker.drain,
  } satisfies ProductWorkflowReactorShape;
});

export const ProductWorkflowReactorLive = Layer.effect(ProductWorkflowReactor, make);
