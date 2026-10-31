import {
  ApprovalRequestId,
  CommandId,
  EventId,
  type OrchestrationEvent,
  type OrchestrationThread,
  type OrchestrationV2DomainEvent,
  type ServerSettings,
  ThreadId,
  WORKFLOW_AUTOMATION_RUNTIME_MODE,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { WorkflowUserInputBroker } from "../mcp/WorkflowUserInputBroker.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import {
  appendWorkflowSkillCommandSection,
  appendWorkflowStepInstructions,
  WORKFLOW_PROMPT_IDS,
} from "../provider/WorkflowPromptRegistry.ts";
import { forkParked } from "../serverActivation.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  buildGrillJudgeRetryMessage,
  buildGrillJudgeRoundMessage,
  type GrillJudgeAttempt,
  grillJudgeMessageId,
  grillJudgeThreadId,
  grillRootOfJudgeThread,
  grillTask,
  nextGrillJudgeAction,
  openGrillQuestions,
} from "./grillJudge.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import { resolveWorkflowStepModelSelection } from "./workflowSubagents.ts";

export const GRILL_JUDGE_FALLBACK_ACTIVITY_KIND = "grill-judge.fallback";

const JUDGE_PROMPT_ID = WORKFLOW_PROMPT_IDS.planningGrillJudgeCodex;
const GRILL_PROMPT_ID = WORKFLOW_PROMPT_IDS.planningGrillStageCodex;

const QUESTION_ACTIVITY_KINDS = [
  "user-input.requested",
  "user-input.resolved",
  "provider.user-input.respond.failed",
];

/**
 * Answers an Engineering run's Grill with Docs questions with an LLM judge when the run's
 * `grillAnswerer` is `judge`. Each open question card goes to one judge thread under the
 * root; the judge's reply answers the card through the same command a person's answer
 * uses, so both question channels (provider-native and the T3 MCP tool) are covered.
 * A human can still answer a card first, and switching the run back to `human` stops the
 * judge before its next round.
 */
export class GrillJudgeReactor extends Context.Service<
  GrillJudgeReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    /** Re-reads one Engineering root and starts or settles its due judge round. */
    readonly evaluate: (threadId: ThreadId) => Effect.Effect<void>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/orchestration/GrillJudgeReactor") {}

const commandId = (...parts: ReadonlyArray<string>) =>
  CommandId.make(["grill-judge", ...parts].join(":"));

export const make = Effect.gen(function* () {
  const native = yield* OrchestratorV2;
  const workflowEngine = yield* OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery;
  const settingsService = yield* ServerSettingsService;
  const userInput = yield* WorkflowUserInputBroker;

  const readSettings = settingsService.getSettings.pipe(
    Effect.map((settings): ServerSettings | null => settings),
    Effect.orElseSucceed(() => null),
  );

  const isJudgedGrill = (root: OrchestrationThread, settings: ServerSettings | null) => {
    if (root.workflowPreset !== "planning" || root.workflowRole !== null) return false;
    if (root.deletedAt !== null || root.archivedAt !== null) return false;
    // The grill is the first stage; later stages never ask, so a card there is not the judge's.
    if (root.planningWorkflow !== null && root.planningWorkflow.stage !== "grill") return false;
    const answerer =
      root.workflowImplementationSettings?.grillAnswerer ??
      settings?.implementation.grillAnswerer ??
      "human";
    return answerer === "judge";
  };

  const readRound = Effect.fn("GrillJudgeReactor.readRound")(function* (
    judgeThreadId: ThreadId,
    requestId: string,
    attempt: GrillJudgeAttempt,
  ) {
    const records = yield* native
      .getThreadRecords(judgeThreadId, ["runs", "messages"], { messageRoles: ["assistant"] })
      .pipe(Effect.option);
    if (Option.isNone(records)) return null;
    const messageId = grillJudgeMessageId(requestId, attempt);
    const run = records.value.runs.find((candidate) => candidate.userMessageId === messageId);
    if (run === undefined) return null;
    const finalMessage = records.value.messages.findLast(
      (message) => message.runId === run.id && !message.streaming,
    );
    return { run, finalText: finalMessage?.text ?? null };
  });

  /**
   * Whether the agent is still waiting on this card. A person's answer only closes the card
   * once the agent collects it, and a second answer to a closed native request is refused,
   * so the judge asks the card's owner first: the native runtime request for a provider's own
   * question, or the MCP broker for a `workflow_request_user_input` round.
   */
  const stillWaiting = Effect.fn("GrillJudgeReactor.stillWaiting")(function* (
    rootId: ThreadId,
    requestId: string,
  ) {
    const records = yield* native.getThreadRecords(rootId, ["runtimeRequests"]).pipe(Effect.option);
    const request = Option.isNone(records)
      ? undefined
      : records.value.runtimeRequests.find((candidate) => candidate.id === requestId);
    if (request !== undefined) return request.status === "pending";
    return Option.isSome(yield* userInput.pendingQuestions({ threadId: rootId, requestId }));
  });

  const ensureJudgeThread = Effect.fn("GrillJudgeReactor.ensureJudgeThread")(function* (
    root: OrchestrationThread,
    settings: ServerSettings | null,
  ) {
    const judgeThreadId = grillJudgeThreadId(root.id);
    const existing = yield* native
      .getThreadShell(judgeThreadId)
      .pipe(Effect.orElseSucceed(() => null));
    if (existing !== null) return judgeThreadId;
    const model = resolveWorkflowStepModelSelection({
      workflowPromptId: JUDGE_PROMPT_ID,
      stepWorkflowPromptId: GRILL_PROMPT_ID,
      definition: undefined,
      stepModels: root.workflowStepModels,
      workflow: "engineering",
      parentModelSelection: root.modelSelection,
      settings: settings ?? undefined,
    });
    yield* native.dispatch({
      type: "thread.create",
      commandId: commandId("thread", judgeThreadId),
      threadId: judgeThreadId,
      projectId: root.projectId,
      title: "Grill Judge",
      modelSelection: model.modelSelection,
      runtimeMode: WORKFLOW_AUTOMATION_RUNTIME_MODE,
      interactionMode: "default",
      // The judge may read the Grill's worktree to check a claim; its prompt forbids edits.
      branch: root.branch,
      worktreePath: root.worktreePath,
      ownerUserId: root.ownerUserId,
      parentThreadId: root.id,
      workflowRole: "planning-grill-judge",
      workflowContext: root.workflowContext ?? null,
      createdBy: "system",
      creationSource: "server",
    });
    return judgeThreadId;
  });

  const evaluateUnsafe = Effect.fn("GrillJudgeReactor.evaluate")(function* (rootId: ThreadId) {
    const root = Option.getOrUndefined(
      yield* snapshots.getThreadDetailById(rootId, { activityKinds: QUESTION_ACTIVITY_KINDS }),
    );
    if (root === undefined) return;
    const settings = yield* readSettings;
    if (!isJudgedGrill(root, settings)) return;
    // The Grill blocks on one card at a time; answer the oldest first.
    const question = openGrillQuestions(root.activities)[0];
    if (question === undefined) return;

    const judgeThreadId = grillJudgeThreadId(root.id);
    const action = nextGrillJudgeAction({
      question,
      first: yield* readRound(judgeThreadId, question.requestId, 1),
      retry: yield* readRound(judgeThreadId, question.requestId, 2),
    });
    if (action === null) return;

    if (action.type === "ask") {
      yield* ensureJudgeThread(root, settings);
      const messageId = grillJudgeMessageId(question.requestId, action.attempt);
      const grillSaid =
        root.messages.findLast((message) => message.role === "assistant" && !message.streaming)
          ?.text ?? null;
      const text =
        action.attempt === 1
          ? appendWorkflowStepInstructions(
              appendWorkflowSkillCommandSection(
                buildGrillJudgeRoundMessage({
                  task: grillTask(root.messages),
                  grillSaid,
                  questions: question.questions,
                }),
                JUDGE_PROMPT_ID,
              ),
              JUDGE_PROMPT_ID,
              settings?.workflowStepInstructions ?? {},
            )
          : buildGrillJudgeRetryMessage(action.problem ?? "it had no usable answers.");
      yield* native.dispatch({
        type: "message.dispatch",
        commandId: commandId("message", messageId),
        threadId: judgeThreadId,
        messageId,
        text,
        attachments: [],
        createdBy: "system",
        creationSource: "server",
        dispatchMode: { type: "start_immediately" },
      });
      return;
    }

    if (!(yield* stillWaiting(root.id, question.requestId))) return;
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    yield* workflowEngine.dispatch({
      type: "thread.user-input.respond",
      commandId: commandId("answer", root.id, question.requestId),
      threadId: root.id,
      requestId: ApprovalRequestId.make(question.requestId),
      answers: action.answers,
      createdAt,
    });
    if (action.fallbackReason !== null) {
      yield* workflowEngine.dispatch({
        type: "thread.activity.append",
        commandId: commandId("fallback", root.id, question.requestId),
        threadId: root.id,
        activity: {
          id: EventId.make(`grill-judge-fallback:${root.id}:${question.requestId}`),
          tone: "error",
          kind: GRILL_JUDGE_FALLBACK_ACTIVITY_KIND,
          summary:
            "The Grill judge gave no usable answer, so the Grill's recommendations were used",
          payload: {
            requestId: question.requestId,
            judgeThreadId,
            reason: action.fallbackReason,
          },
          turnId: null,
          createdAt,
        },
        createdAt,
      });
    }
  });

  const evaluate = (threadId: ThreadId) =>
    evaluateUnsafe(threadId).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("Grill judge step failed", {
              threadId,
              cause: Cause.pretty(cause),
            }),
      ),
    );

  const worker = yield* makeDrainableWorker(evaluate);

  /** A new card on a root, or its Grill switched between the judge and a person. */
  const onWorkflowEvent = (event: OrchestrationEvent) => {
    if (event.type === "thread.activity-appended") {
      return event.payload.activity.kind === "user-input.requested"
        ? worker.enqueue(event.payload.threadId)
        : Effect.void;
    }
    return event.type === "thread.composer-mode-set"
      ? worker.enqueue(event.payload.threadId)
      : Effect.void;
  };

  /** A judge turn that started or finished. */
  const onNativeEvent = (event: OrchestrationV2DomainEvent) => {
    if (event.type !== "run.updated") return Effect.void;
    const rootThreadId = grillRootOfJudgeThread(event.threadId);
    return rootThreadId === null ? Effect.void : worker.enqueue(rootThreadId);
  };

  const reconcile = Effect.gen(function* () {
    const snapshot = yield* native.getShellSnapshot({ unsettledOnly: true });
    for (const thread of snapshot.threads) {
      if (
        thread.deletedAt === null &&
        thread.workflowPreset === "planning" &&
        (thread.workflowRole ?? null) === null
      ) {
        yield* worker.enqueue(thread.id);
      }
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Grill judge startup reconciliation failed", {
        cause: Cause.pretty(cause),
      }),
    ),
  );

  const logStopped = (stream: string) => (cause: Cause.Cause<unknown>) =>
    Effect.logWarning(`Grill judge ${stream} event stream stopped`, {
      cause: Cause.pretty(cause),
    });

  return {
    start: Effect.fn("GrillJudgeReactor.start")(function* () {
      yield* forkParked(
        Stream.runForEach(workflowEngine.streamDomainEvents, onWorkflowEvent).pipe(
          Effect.catchCause(logStopped("workflow")),
        ),
      );
      yield* forkParked(
        Stream.runForEach(native.streamDomainEvents, onNativeEvent).pipe(
          Effect.catchCause(logStopped("native")),
        ),
      );
      yield* forkParked(reconcile);
    }),
    evaluate: (threadId) => worker.enqueue(ThreadId.make(threadId)),
    drain: worker.drain,
  } satisfies GrillJudgeReactor["Service"];
});

export const layer = Layer.effect(GrillJudgeReactor, make);
