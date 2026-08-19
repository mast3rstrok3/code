import {
  CommandId,
  EventId,
  OrchestrationDispatchCommandError,
  OrchestrationGetSnapshotError,
  WorkflowUserInputError,
  type ProviderUserInputAnswers,
  type ThreadId,
  type WorkflowUserInputAnswer,
  type WorkflowUserInputQuestion,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as WorkflowUserInputBroker from "../../WorkflowUserInputBroker.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { WorkflowUserInputToolkit } from "./tools.ts";

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

/**
 * Ids are scoped to the calling MCP session, whose id is a fresh UUID per
 * provider session. A pending card left behind by an earlier process can
 * therefore never be mistaken for one this session is waiting on.
 */
let idSequence = 0;
const nextId = (providerSessionId: string) => {
  idSequence += 1;
  return `${providerSessionId}-${idSequence.toString(36)}`;
};

const inputError = (threadId: ThreadId, message: string) =>
  new WorkflowUserInputError({ threadId, message });

const dispatchError = (message: string, cause: unknown) =>
  new OrchestrationDispatchCommandError({ message, cause });

/**
 * The clients key their draft answers by question id, so an answer map reads
 * back the same way whatever shape the client submitted: one label, several
 * labels, or free text typed into the composer.
 */
const toWorkflowUserInputAnswers = (
  questions: ReadonlyArray<WorkflowUserInputQuestion>,
  answers: ProviderUserInputAnswers,
): ReadonlyArray<WorkflowUserInputAnswer> =>
  questions.map((question) => {
    const value = answers[question.id];
    if (typeof value === "string") {
      return { questionId: question.id, answers: [value] };
    }
    if (Array.isArray(value)) {
      return {
        questionId: question.id,
        answers: value.filter((entry): entry is string => typeof entry === "string"),
      };
    }
    if (
      typeof value === "object" &&
      value !== null &&
      Array.isArray((value as { answers?: unknown }).answers)
    ) {
      return {
        questionId: question.id,
        answers: (value as { answers: ReadonlyArray<unknown> }).answers.filter(
          (entry): entry is string => typeof entry === "string",
        ),
      };
    }
    return { questionId: question.id, answers: [] };
  });

export const handlers = {
  workflow_request_user_input: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireMcpCapability("user-input");
      const threadId = scope.threadId;
      const engine = yield* OrchestrationEngineService;
      const broker = yield* WorkflowUserInputBroker.WorkflowUserInputBroker;
      const snapshotQuery = yield* ProjectionSnapshotQuery;

      const thread = yield* snapshotQuery.getThreadDetailById(threadId).pipe(
        Effect.mapError(
          (cause) =>
            new OrchestrationGetSnapshotError({
              message: `Failed to load thread ${threadId}.`,
              cause,
            }),
        ),
      );
      if (Option.isNone(thread)) {
        return yield* inputError(threadId, `Thread ${threadId} was not found.`);
      }
      // Attaching the card to the live turn keeps it inside the turn the agent
      // is blocked in, where a provider-native question would have landed.
      const turnId = thread.value.latestTurn?.turnId ?? null;

      const requestId = `workflow-user-input-${nextId(scope.providerSessionId)}`;
      const questions = input.questions.map((question) => ({ ...question, multiSelect: false }));

      const appendActivity = (activity: {
        readonly kind: "user-input.requested" | "user-input.resolved";
        readonly summary: string;
        readonly payload: Record<string, unknown>;
      }) =>
        Effect.gen(function* () {
          const createdAt = yield* nowIso;
          const activityId = nextId(scope.providerSessionId);
          yield* engine
            .dispatch({
              type: "thread.activity.append",
              commandId: CommandId.make(`server:workflow-user-input:${activityId}`),
              threadId,
              activity: {
                id: EventId.make(`workflow-user-input-activity-${activityId}`),
                tone: "info",
                kind: activity.kind,
                summary: activity.summary,
                payload: { requestId, ...activity.payload },
                turnId,
                createdAt,
              },
              createdAt,
            })
            .pipe(
              Effect.mapError((cause) =>
                dispatchError(`Failed to append ${activity.kind} activity.`, cause),
              ),
            );
        });

      const resolveCard = (summary: string, answers: ProviderUserInputAnswers) =>
        appendActivity({ kind: "user-input.resolved", summary, payload: { answers } });

      yield* appendActivity({
        kind: "user-input.requested",
        summary: "User input requested",
        payload: { questions },
      });

      const outcome = yield* broker.awaitAnswers({ threadId, requestId }).pipe(
        // An interrupted tool call (turn stopped, client gone) must still clear
        // the card, or the thread keeps showing a question nobody is waiting on.
        Effect.onInterrupt(() => resolveCard("User input cancelled", {}).pipe(Effect.ignore)),
      );

      if (outcome._tag === "cancelled") {
        yield* resolveCard("User input cancelled", {});
        return yield* inputError(
          threadId,
          `The user-input request was cancelled (${outcome.reason}). Do not answer it on the user's behalf.`,
        );
      }

      yield* resolveCard("User input submitted", outcome.answers);

      return { answers: toWorkflowUserInputAnswers(questions, outcome.answers) };
    }),
} satisfies Parameters<typeof WorkflowUserInputToolkit.toLayer>[0];

export const WorkflowUserInputToolkitHandlersLive = WorkflowUserInputToolkit.toLayer(handlers);
