import {
  CommandId,
  EventId,
  type OrchestrationThreadShell,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ServerCommand,
  type PlanId,
  type ServerSettings,
  ThreadId,
  WORKFLOW_AUTOMATION_RUNTIME_MODE,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { visibleThreadPullRequests } from "@t3tools/shared/threadPullRequests";
import { resolveWorkflowStepCycleBudget } from "@t3tools/shared/workflowStepCycles";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { AppStackManager } from "../appStack/AppStackManager.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import {
  appendWorkflowSkillCommandSection,
  appendWorkflowStepInstructions,
  WORKFLOW_PROMPT_IDS,
} from "../provider/WorkflowPromptRegistry.ts";
import { forkParked } from "../serverActivation.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { resolveProjectDevelopmentBranch } from "../vcs/developmentBranch.ts";
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import {
  buildFeatureFixMessage,
  buildFeatureImplementMessage,
  buildFeaturePullRequestMessage,
  buildFeatureReviewMessage,
  currentFeaturePlanId,
  featureFixMessageId,
  featureImplementMessageId,
  featurePullRequestMessageId,
  featureReviewMessageId,
  featureReviewThreadId,
  featureRootOfReviewThread,
  type FeatureReviewState,
  type FeatureWorkflowAction,
  latestRun,
  nextFeatureWorkflowActions,
} from "./featureWorkflow.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import { resolveWorkflowStepModelSelection } from "./workflowSubagents.ts";

export const FEATURE_WORKFLOW_COMPLETED_ACTIVITY_KIND = "feature-workflow.completed";

const CODE_REVIEW_PROMPT_ID = WORKFLOW_PROMPT_IDS.implementationCodeReviewCodex;

/** Native events that can move a Feature to its next step. */
const TRIGGER_EVENT_TYPES = new Set<OrchestrationV2DomainEvent["type"]>([
  "run.updated",
  "plan.updated",
  "runtime-request.updated",
  "thread.metadata-updated",
]);

/**
 * Drives the Feature workflow on the native runtime: answers its planning
 * questions, starts the implement turn on the proposed plan, runs Code Review
 * cycles, hands their findings back to the Feature thread, opens the pull
 * request, and stops the workflow's App Stacks once the pull request is
 * linked. The steps themselves are decided by `nextFeatureWorkflowActions`.
 */
export class FeatureWorkflowReactor extends Context.Service<
  FeatureWorkflowReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    /** Re-reads one Feature thread and starts whatever step is due. */
    readonly evaluate: (threadId: ThreadId) => Effect.Effect<void>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/orchestration/FeatureWorkflowReactor") {}

const commandId = (...parts: ReadonlyArray<string | number>) =>
  CommandId.make(["feature", ...parts].join(":"));

export const make = Effect.gen(function* () {
  const native = yield* OrchestratorV2;
  const workflowEngine = yield* OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery;
  const settingsService = yield* ServerSettingsService;
  const appStacks = yield* AppStackManager;
  const git = yield* GitVcsDriver;

  const readSettings = settingsService.getSettings.pipe(
    Effect.map((settings): ServerSettings | null => settings),
    Effect.orElseSucceed(() => null),
  );

  const dispatch = (command: OrchestrationV2ServerCommand) =>
    native.dispatch(command).pipe(Effect.asVoid);

  const isFeatureRoot = (thread: {
    readonly workflowPreset?: string | null | undefined;
    readonly workflowRole?: string | null | undefined;
    readonly archivedAt: unknown;
  }) =>
    thread.workflowPreset === "fast-plan" &&
    (thread.workflowRole ?? null) === null &&
    thread.archivedAt === null;

  const readReviews = Effect.fn("FeatureWorkflowReactor.readReviews")(function* (
    threadId: ThreadId,
    planId: PlanId,
    cycleBudget: number,
  ) {
    const reviews: FeatureReviewState[] = [];
    for (let cycle = 1; cycle <= cycleBudget; cycle += 1) {
      const records = yield* native
        .getThreadRecords(featureReviewThreadId(threadId, planId, cycle), ["runs", "messages"], {
          messageRoles: ["assistant"],
        })
        .pipe(Effect.option);
      if (Option.isNone(records)) break;
      const run = latestRun(records.value.runs);
      const finalMessage = records.value.messages.findLast(
        (message) => message.runId === run?.id && !message.streaming,
      );
      reviews.push({ runStatus: run?.status ?? null, finalText: finalMessage?.text ?? null });
      if (run?.status !== "completed") break;
    }
    return reviews;
  });

  const resolveBaseBranch = Effect.fn("FeatureWorkflowReactor.resolveBaseBranch")(function* (
    thread: Pick<OrchestrationV2AppThread, "projectId" | "branch" | "worktreePath">,
    settings: ServerSettings | null,
  ) {
    if (thread.worktreePath === null) return null;
    // New worktrees record their base the way `gh` reads it; a branch rename keeps it.
    const recorded =
      thread.branch === null
        ? null
        : yield* git
            .readConfigValue(thread.worktreePath, `branch.${thread.branch}.gh-merge-base`)
            .pipe(Effect.orElseSucceed(() => null));
    if (recorded !== null && recorded.trim().length > 0) return recorded.trim();
    const development = yield* resolveProjectDevelopmentBranch({
      git,
      settings,
      cwd: thread.worktreePath,
      projectId: thread.projectId,
    });
    return development?.branch ?? null;
  });

  const runAction = Effect.fn("FeatureWorkflowReactor.runAction")(function* (input: {
    readonly action: FeatureWorkflowAction;
    readonly thread: OrchestrationV2AppThread;
    readonly settings: ServerSettings | null;
    readonly cycleBudget: number;
    /** The workflow engine's copy of the thread, which carries the run-local step settings. */
    readonly workflowShell: Option.Option<OrchestrationThreadShell>;
    readonly planMarkdown: (planId: PlanId) => string | null;
  }) {
    const { action, thread, settings } = input;
    const instructions = settings?.workflowStepInstructions ?? {};
    const withSkill = (text: string, workflowPromptId: string) =>
      appendWorkflowStepInstructions(
        appendWorkflowSkillCommandSection(text, workflowPromptId),
        workflowPromptId,
        instructions,
      );
    const send = (messageId: ReturnType<typeof featureFixMessageId>, text: string) =>
      dispatch({
        type: "message.dispatch",
        commandId: commandId("message", messageId),
        threadId: thread.id,
        messageId,
        text,
        attachments: [],
        createdBy: "system",
        creationSource: "server",
        dispatchMode: { type: "start_immediately" },
      });
    switch (action.type) {
      case "answer-questions":
        return yield* dispatch({
          type: "runtime-request.respond",
          commandId: commandId("answer", thread.id, action.requestId),
          threadId: thread.id,
          requestId: action.requestId,
          answers: action.answers,
        });
      case "implement": {
        yield* dispatch({
          type: "thread.interaction-mode.set",
          commandId: commandId("implement-mode", thread.id, action.planId),
          threadId: thread.id,
          interactionMode: "default",
        });
        yield* dispatch({
          type: "thread.runtime-mode.set",
          commandId: commandId("implement-runtime", thread.id, action.planId),
          threadId: thread.id,
          runtimeMode: WORKFLOW_AUTOMATION_RUNTIME_MODE,
        });
        const messageId = featureImplementMessageId(thread.id, action.planId);
        return yield* dispatch({
          type: "message.dispatch",
          commandId: commandId("message", messageId),
          threadId: thread.id,
          messageId,
          text: withSkill(
            buildFeatureImplementMessage(),
            WORKFLOW_PROMPT_IDS.implementationFeatureCodex,
          ),
          attachments: [],
          sourcePlanRef: { threadId: thread.id, planId: action.planId },
          createdBy: "system",
          creationSource: "server",
          dispatchMode: { type: "start_immediately" },
        });
      }
      case "review": {
        const reviewThreadId = featureReviewThreadId(thread.id, action.planId, action.cycle);
        const existing = yield* native
          .getThreadShell(reviewThreadId)
          .pipe(Effect.orElseSucceed(() => null));
        if (existing === null) {
          const stepModels = Option.getOrUndefined(input.workflowShell)?.workflowStepModels;
          const model = resolveWorkflowStepModelSelection({
            workflowPromptId: CODE_REVIEW_PROMPT_ID,
            definition: undefined,
            stepModels,
            parentModelSelection: thread.modelSelection,
            settings: settings ?? undefined,
          });
          yield* dispatch({
            type: "thread.create",
            commandId: commandId("review-thread", reviewThreadId),
            threadId: reviewThreadId,
            projectId: thread.projectId,
            title: `Code Review · Cycle ${action.cycle} of ${input.cycleBudget}`,
            modelSelection: model.modelSelection,
            runtimeMode: WORKFLOW_AUTOMATION_RUNTIME_MODE,
            interactionMode: "default",
            branch: thread.branch,
            worktreePath: thread.worktreePath,
            ...(thread.ownerUserId === undefined ? {} : { ownerUserId: thread.ownerUserId }),
            parentThreadId: thread.id,
            workflowContext: thread.workflowContext ?? null,
            createdBy: "system",
            creationSource: "server",
          });
        }
        const messageId = featureReviewMessageId(reviewThreadId);
        return yield* dispatch({
          type: "message.dispatch",
          commandId: commandId("message", messageId),
          threadId: reviewThreadId,
          messageId,
          text: appendWorkflowStepInstructions(
            appendWorkflowSkillCommandSection(
              buildFeatureReviewMessage({
                cycle: action.cycle,
                cycleBudget: input.cycleBudget,
                worktreePath: thread.worktreePath,
                branch: thread.branch,
                baseBranch: yield* resolveBaseBranch(thread, settings),
                planMarkdown: input.planMarkdown(action.planId),
              }),
              "matt-pocock.code-review",
            ),
            CODE_REVIEW_PROMPT_ID,
            instructions,
          ),
          attachments: [],
          createdBy: "system",
          creationSource: "server",
          dispatchMode: { type: "start_immediately" },
        });
      }
      case "fix":
        return yield* send(
          featureFixMessageId(thread.id, action.planId, action.cycle),
          buildFeatureFixMessage({
            cycle: action.cycle,
            cycleBudget: input.cycleBudget,
            reportMarkdown: action.reportMarkdown,
          }),
        );
      case "open-pull-request":
        return yield* send(
          featurePullRequestMessageId(thread.id, action.planId),
          withSkill(
            buildFeaturePullRequestMessage({
              baseBranch: yield* resolveBaseBranch(thread, settings),
              unresolvedFindingsMarkdown: action.unresolvedFindingsMarkdown,
            }),
            WORKFLOW_PROMPT_IDS.implementationFeaturePullRequestCodex,
          ),
        );
      case "complete": {
        const completed = yield* snapshots
          .listActivitiesByKind(FEATURE_WORKFLOW_COMPLETED_ACTIVITY_KIND)
          .pipe(Effect.orElseSucceed(() => []));
        if (
          completed.some((activity) => {
            const payload = activity.payload as { threadId?: unknown; planId?: unknown } | null;
            return payload?.threadId === thread.id && payload.planId === action.planId;
          })
        ) {
          return;
        }
        const workflowId =
          Option.getOrUndefined(input.workflowShell)?.workflowContext?.workflowId ??
          thread.workflowContext?.workflowId ??
          null;
        const teardown =
          workflowId === null
            ? null
            : yield* appStacks.workflowTeardown({ workflowId }).pipe(
                Effect.tapError((error) =>
                  Effect.logWarning("Feature App Stack teardown failed", {
                    threadId: thread.id,
                    workflowId,
                    error,
                  }),
                ),
                Effect.orElseSucceed(() => null),
              );
        yield* dispatch({
          type: "thread.settle",
          commandId: commandId("settle", thread.id, action.planId),
          threadId: thread.id,
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Feature thread could not be settled", {
              threadId: thread.id,
              cause: Cause.pretty(cause),
            }),
          ),
        );
        const createdAt = DateTime.formatIso(yield* DateTime.now);
        return yield* workflowEngine
          .dispatch({
            type: "thread.activity.append",
            commandId: commandId("completed", thread.id, action.planId),
            threadId: thread.id,
            activity: {
              id: EventId.make(`feature-completed:${thread.id}:${action.planId}`),
              tone: "info",
              kind: FEATURE_WORKFLOW_COMPLETED_ACTIVITY_KIND,
              summary:
                teardown === null || teardown.stoppedStackIds.length === 0
                  ? "Feature finished: pull request linked"
                  : `Feature finished: pull request linked, ${teardown.stoppedStackIds.length} App Stack(s) stopped`,
              payload: {
                threadId: thread.id,
                planId: action.planId,
                workflowId,
                stoppedStackIds: teardown?.stoppedStackIds ?? [],
                skippedProtectedStackIds: teardown?.skippedProtectedStackIds ?? [],
                failedStackIds: teardown?.failedStackIds ?? [],
              },
              turnId: null,
              createdAt,
            },
            createdAt,
          })
          .pipe(Effect.asVoid);
      }
    }
  });

  const evaluateUnsafe = Effect.fn("FeatureWorkflowReactor.evaluate")(function* (
    threadId: ThreadId,
  ) {
    const shell = yield* native.getThreadShell(threadId);
    if (shell === null || shell.deletedAt !== null || !isFeatureRoot(shell)) return;
    const records = yield* native.getThreadRecords(
      threadId,
      ["runs", "plans", "runtimeRequests", "turnItems"],
      { turnItemTypes: ["user_input_request", "proposed_plan"] },
    );
    const settings = yield* readSettings;
    const workflowShell = yield* snapshots
      .getThreadShellById(threadId)
      .pipe(Effect.orElseSucceed(() => Option.none()));
    const cycleBudget = resolveWorkflowStepCycleBudget({
      key: { workflowPromptId: CODE_REVIEW_PROMPT_ID },
      threadOverrides: Option.getOrUndefined(workflowShell)?.workflowStepCycles,
      settingsOverrides: settings?.workflowStepCycles,
    });
    const runs = records.runs;
    const planId = currentFeaturePlanId({ threadId, runs });
    const pendingQuestions = records.runtimeRequests
      .filter((request) => request.kind === "user_input" && request.status === "pending")
      .flatMap((request) => {
        const item = records.turnItems.find(
          (candidate) =>
            candidate.type === "user_input_request" && candidate.requestId === request.id,
        );
        return item?.type === "user_input_request"
          ? [{ requestId: request.id, questions: item.questions }]
          : [];
      });
    const actions = nextFeatureWorkflowActions({
      threadId,
      interactionMode: records.thread.interactionMode,
      runs,
      plans: records.plans.map((plan) => ({
        id: plan.id,
        kind: plan.kind,
        status: plan.status,
        runId: plan.runId,
      })),
      pendingQuestions,
      reviews: planId === null ? [] : yield* readReviews(threadId, planId, cycleBudget),
      cycleBudget,
      pullRequestLinked: visibleThreadPullRequests(records.thread.pullRequests ?? []).length > 0,
      completed: false,
    });
    const planMarkdown = (id: PlanId) => {
      const fromItem = records.turnItems.find(
        (item) => item.type === "proposed_plan" && item.planId === id,
      );
      if (fromItem?.type === "proposed_plan" && fromItem.markdown.trim()) return fromItem.markdown;
      const plan = records.plans.find((candidate) => candidate.id === id);
      return plan?.kind === "proposed_plan" && plan.markdown.trim() ? plan.markdown : null;
    };
    for (const action of actions) {
      yield* runAction({
        action,
        thread: records.thread,
        settings,
        cycleBudget,
        workflowShell,
        planMarkdown,
      });
    }
  });

  const evaluate = (threadId: ThreadId) =>
    evaluateUnsafe(threadId).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("Feature workflow step failed", {
              threadId,
              cause: Cause.pretty(cause),
            }),
      ),
    );

  const worker = yield* makeDrainableWorker(evaluate);

  const onEvent = (event: OrchestrationV2DomainEvent) => {
    if (!TRIGGER_EVENT_TYPES.has(event.type)) return Effect.void;
    const rootThreadId = featureRootOfReviewThread(event.threadId) ?? event.threadId;
    return worker.enqueue(rootThreadId);
  };

  const reconcile = Effect.gen(function* () {
    const snapshot = yield* native.getShellSnapshot({ unsettledOnly: true });
    for (const thread of snapshot.threads) {
      if (thread.deletedAt === null && isFeatureRoot(thread)) yield* worker.enqueue(thread.id);
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Feature workflow startup reconciliation failed", {
        cause: Cause.pretty(cause),
      }),
    ),
  );

  return {
    start: Effect.fn("FeatureWorkflowReactor.start")(function* () {
      yield* forkParked(
        Stream.runForEach(native.streamDomainEvents, onEvent).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Feature workflow event stream stopped", {
              cause: Cause.pretty(cause),
            }),
          ),
        ),
      );
      yield* forkParked(reconcile);
    }),
    evaluate: (threadId) => worker.enqueue(ThreadId.make(threadId)),
    drain: worker.drain,
  } satisfies FeatureWorkflowReactor["Service"];
});

export const layer = Layer.effect(FeatureWorkflowReactor, make);
