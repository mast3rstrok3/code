import {
  MessageId,
  ThreadId,
  type OrchestrationThreadActivity,
  type OrchestrationV2Run,
  type ProviderUserInputAnswers,
  type UserInputQuestion,
} from "@t3tools/contracts";

import { resolvePlanQuestionAnswers } from "./featureWorkflow.ts";
import { extractJsonFenceBlocks } from "./workflowDirectives.ts";

/**
 * An Engineering run whose Grill is set to the LLM judge hands each open Grill
 * question card to one judge thread under the root, and answers the card with
 * the judge's reply. Every message and the thread itself derive their IDs from
 * the root and the card, so a round starts once, including after a restart.
 */

export const GRILL_JUDGE_ANSWERS_TYPE = "grill-judge-answers";

const JUDGE_THREAD_SUFFIX = "::grill-judge";
/** How much of the Grill's last message a round quotes. */
const GRILL_CONTEXT_MAX_CHARS = 6000;

export function grillJudgeThreadId(rootThreadId: ThreadId): ThreadId {
  return ThreadId.make(`${rootThreadId}${JUDGE_THREAD_SUFFIX}`);
}

export function grillRootOfJudgeThread(threadId: ThreadId): ThreadId | null {
  return threadId.endsWith(JUDGE_THREAD_SUFFIX)
    ? ThreadId.make(threadId.slice(0, -JUDGE_THREAD_SUFFIX.length))
    : null;
}

/** The judge gets one retry when its first reply carries no usable answers. */
export type GrillJudgeAttempt = 1 | 2;

export function grillJudgeMessageId(requestId: string, attempt: GrillJudgeAttempt): MessageId {
  return MessageId.make(`grill-judge:${requestId}${attempt === 1 ? "" : ":retry"}`);
}

export interface OpenGrillQuestion {
  readonly requestId: string;
  readonly questions: ReadonlyArray<UserInputQuestion>;
}

const payloadOf = (activity: OrchestrationThreadActivity): Record<string, unknown> =>
  activity.payload !== null && typeof activity.payload === "object"
    ? (activity.payload as Record<string, unknown>)
    : {};

/**
 * The question cards still waiting for an answer, oldest first. Both question
 * channels land here: provider-native questions and the T3 MCP question tool
 * each record a `user-input.requested` activity, and its answer or failure
 * records the matching resolution.
 */
export function openGrillQuestions(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyArray<OpenGrillQuestion> {
  const open = new Map<string, OpenGrillQuestion>();
  for (const activity of activities) {
    const payload = payloadOf(activity);
    const requestId = typeof payload.requestId === "string" ? payload.requestId : null;
    if (requestId === null) continue;
    if (activity.kind === "user-input.requested") {
      // A card answered as a chat message is not a question a provider is blocked on.
      if (payload.responseMode === "message" || !Array.isArray(payload.questions)) continue;
      open.set(requestId, {
        requestId,
        questions: payload.questions as ReadonlyArray<UserInputQuestion>,
      });
    } else if (
      activity.kind === "user-input.resolved" ||
      activity.kind === "provider.user-input.respond.failed"
    ) {
      open.delete(requestId);
    }
  }
  return [...open.values()];
}

/** The task the workflow was started with: the root's first message without its skill text. */
export function grillTask(
  messages: ReadonlyArray<{ readonly role: string; readonly text: string }>,
): string | null {
  const first = messages.find((message) => message.role === "user");
  if (first === undefined) return null;
  const skillStart = first.text.indexOf("\n\n<workflow-skill ");
  const task = (skillStart === -1 ? first.text : first.text.slice(0, skillStart)).trim();
  return task.length === 0 ? null : task;
}

function formatQuestion(question: UserInputQuestion): string {
  return [
    `### ${question.header} (\`${question.id}\`)`,
    question.question,
    ...(question.options.length === 0
      ? ["No choices: write a custom answer."]
      : [
          question.multiSelect === true ? "Choices (several allowed):" : "Choices:",
          ...question.options.map((option) =>
            option.description.trim().length === 0
              ? `- **${option.label}**`
              : `- **${option.label}**: ${option.description}`,
          ),
        ]),
    ...(question.recommendation === undefined
      ? []
      : [
          `The Grill recommends **${question.recommendation.optionLabel}**: ${question.recommendation.rationale}`,
        ]),
  ].join("\n");
}

export function buildGrillJudgeRoundMessage(input: {
  readonly task: string | null;
  readonly grillSaid: string | null;
  readonly questions: ReadonlyArray<UserInputQuestion>;
}): string {
  const grillSaid = input.grillSaid?.trim() ?? "";
  return [
    "## Task",
    input.task ?? "(The workflow's task message could not be read; decide from the questions.)",
    ...(grillSaid.length === 0
      ? []
      : [
          "## What the Grill said before asking",
          grillSaid.length > GRILL_CONTEXT_MAX_CHARS
            ? `…${grillSaid.slice(-GRILL_CONTEXT_MAX_CHARS)}`
            : grillSaid,
        ]),
    "## Questions",
    ...input.questions.map(formatQuestion),
    `Answer every question above and end with one \`${GRILL_JUDGE_ANSWERS_TYPE}\` JSON block.`,
  ].join("\n\n");
}

export function buildGrillJudgeRetryMessage(problem: string): string {
  return [
    `Your last reply could not be used: ${problem}`,
    "Answer the same questions again. End with exactly one fenced JSON block and nothing after it:",
    "```json",
    `{ "type": "${GRILL_JUDGE_ANSWERS_TYPE}", "answers": { "<question id>": "<option label or custom answer>" } }`,
    "```",
  ].join("\n");
}

export type GrillJudgeAnswersResult =
  | { readonly ok: true; readonly answers: ProviderUserInputAnswers }
  | { readonly ok: false; readonly problem: string };

const nonEmpty = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

/** The judge's answers from its reply, keyed by the card's question ids. */
export function parseGrillJudgeAnswers(
  text: string | null,
  questions: ReadonlyArray<UserInputQuestion>,
): GrillJudgeAnswersResult {
  for (const block of [...extractJsonFenceBlocks(text ?? "")].toReversed()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(block);
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== "object") continue;
    const record = parsed as Record<string, unknown>;
    if (record["type"] !== GRILL_JUDGE_ANSWERS_TYPE) continue;
    const raw = record["answers"];
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      return { ok: false, problem: "`answers` must be an object keyed by question id." };
    }
    const given = raw as Record<string, unknown>;
    const answers: Record<string, string | string[]> = {};
    const missing: string[] = [];
    for (const question of questions) {
      const value = given[question.id];
      if (nonEmpty(value)) {
        answers[question.id] = value.trim();
      } else if (
        question.multiSelect === true &&
        Array.isArray(value) &&
        value.length > 0 &&
        value.every(nonEmpty)
      ) {
        answers[question.id] = value.map((entry) => entry.trim());
      } else {
        missing.push(question.id);
      }
    }
    if (missing.length > 0) {
      return { ok: false, problem: `no usable answer for ${missing.join(", ")}.` };
    }
    return { ok: true, answers };
  }
  return { ok: false, problem: `it did not end with a \`${GRILL_JUDGE_ANSWERS_TYPE}\` block.` };
}

export interface GrillJudgeRound {
  readonly run: Pick<OrchestrationV2Run, "status"> | null;
  /** The judge's last finished message in that run, once the run completed. */
  readonly finalText: string | null;
}

export type GrillJudgeAction =
  | { readonly type: "ask"; readonly attempt: GrillJudgeAttempt; readonly problem: string | null }
  | {
      readonly type: "answer";
      readonly answers: ProviderUserInputAnswers;
      /** Set when the judge gave no usable answer and the Grill's recommendations stand in. */
      readonly fallbackReason: string | null;
    }
  | null;

const ACTIVE_RUN_STATUSES = new Set<OrchestrationV2Run["status"]>([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
]);

/**
 * What to do for one open card, given the judge rounds already started for it.
 * Null means a judge run is still working. A judge that fails twice never
 * strands the workflow: the Grill's own recommendations answer the card.
 */
export function nextGrillJudgeAction(input: {
  readonly question: OpenGrillQuestion;
  readonly first: GrillJudgeRound | null;
  readonly retry: GrillJudgeRound | null;
}): GrillJudgeAction {
  const evaluate = (round: GrillJudgeRound): GrillJudgeAnswersResult | null => {
    if (round.run === null || ACTIVE_RUN_STATUSES.has(round.run.status)) return null;
    if (round.run.status !== "completed") {
      return { ok: false, problem: `the judge's turn ended as ${round.run.status}.` };
    }
    return parseGrillJudgeAnswers(round.finalText, input.question.questions);
  };
  if (input.first === null) return { type: "ask", attempt: 1, problem: null };
  const first = evaluate(input.first);
  if (first === null) return null;
  if (first.ok) return { type: "answer", answers: first.answers, fallbackReason: null };
  if (input.retry === null) return { type: "ask", attempt: 2, problem: first.problem };
  const retry = evaluate(input.retry);
  if (retry === null) return null;
  if (retry.ok) return { type: "answer", answers: retry.answers, fallbackReason: null };
  return {
    type: "answer",
    answers: resolvePlanQuestionAnswers({ questions: input.question.questions }),
    fallbackReason: retry.problem,
  };
}
