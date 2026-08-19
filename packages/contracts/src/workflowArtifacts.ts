import * as Schema from "effect/Schema";

import { ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  OrchestrationImplementationRun,
  OrchestrationPlanningReviewCycle,
  OrchestrationPlanningSpec,
  OrchestrationPlanningTicket,
  ThreadWorkflowContext,
} from "./orchestration.ts";
import { AppReviewRecord } from "./review.ts";
import { AppReviewWorkflowRun } from "./review.ts";

export const WorkflowArtifactsGetInput = Schema.Struct({
  projectId: ProjectId,
  threadId: ThreadId,
});
export type WorkflowArtifactsGetInput = typeof WorkflowArtifactsGetInput.Type;

export const WorkflowArtifactsSnapshot = Schema.Struct({
  projectId: ProjectId,
  context: ThreadWorkflowContext,
  spec: Schema.NullOr(OrchestrationPlanningSpec),
  wayfinderMap: Schema.NullOr(OrchestrationPlanningSpec),
  tickets: Schema.Array(OrchestrationPlanningTicket),
  reviewCycles: Schema.Array(OrchestrationPlanningReviewCycle),
  implementationRuns: Schema.Array(OrchestrationImplementationRun),
  appReviewWorkflowRuns: Schema.Array(AppReviewWorkflowRun),
  appReviews: Schema.Array(AppReviewRecord),
});
export type WorkflowArtifactsSnapshot = typeof WorkflowArtifactsSnapshot.Type;

export class WorkflowArtifactAccessError extends Schema.TaggedErrorClass<WorkflowArtifactAccessError>()(
  "WorkflowArtifactAccessError",
  {
    threadId: ThreadId,
    message: TrimmedNonEmptyString,
  },
) {}

/**
 * How many questions one structured grill round may carry. The frontier is
 * asked whole, so this is a guard against a runaway batch, not a target.
 */
export const WORKFLOW_USER_INPUT_MAX_QUESTIONS = 10;

export const WorkflowUserInputOption = Schema.Struct({
  label: TrimmedNonEmptyString,
  description: TrimmedNonEmptyString,
});
export type WorkflowUserInputOption = typeof WorkflowUserInputOption.Type;

export const WorkflowUserInputRecommendation = Schema.Struct({
  optionLabel: TrimmedNonEmptyString,
  rationale: TrimmedNonEmptyString,
});
export type WorkflowUserInputRecommendation = typeof WorkflowUserInputRecommendation.Type;

export const WorkflowUserInputQuestion = Schema.Struct({
  id: TrimmedNonEmptyString,
  header: TrimmedNonEmptyString,
  question: TrimmedNonEmptyString,
  options: Schema.Array(WorkflowUserInputOption).check(
    Schema.isMinLength(2),
    Schema.isMaxLength(3),
  ),
  recommendation: WorkflowUserInputRecommendation,
}).check(
  Schema.makeFilter((question) => {
    const optionLabels = question.options.map((option) => option.label);
    if (new Set(optionLabels).size !== optionLabels.length) {
      return `Question '${question.id}' must use unique option labels.`;
    }
    if (!optionLabels.includes(question.recommendation.optionLabel)) {
      return `Question '${question.id}' recommendation.optionLabel must match one of its option labels.`;
    }
    return true;
  }),
);
export type WorkflowUserInputQuestion = typeof WorkflowUserInputQuestion.Type;

export const WorkflowUserInputQuestions = Schema.Array(WorkflowUserInputQuestion)
  .check(Schema.isMinLength(1), Schema.isMaxLength(WORKFLOW_USER_INPUT_MAX_QUESTIONS))
  .check(
    Schema.makeFilter((questions) => {
      const questionIds = questions.map((question) => question.id);
      return new Set(questionIds).size === questionIds.length || "Question IDs must be unique.";
    }),
  );

export const WorkflowUserInputAnswer = Schema.Struct({
  questionId: TrimmedNonEmptyString,
  answers: Schema.Array(Schema.String),
});
export type WorkflowUserInputAnswer = typeof WorkflowUserInputAnswer.Type;

export const WorkflowUserInputAnsweredResult = Schema.Struct({
  status: Schema.Literal("answered"),
  answers: Schema.Array(WorkflowUserInputAnswer),
});
export type WorkflowUserInputAnsweredResult = typeof WorkflowUserInputAnsweredResult.Type;

export const WorkflowUserInputWaitingResult = Schema.Struct({
  status: Schema.Literal("waiting"),
  resumeRequestId: TrimmedNonEmptyString,
  instructions: TrimmedNonEmptyString,
});
export type WorkflowUserInputWaitingResult = typeof WorkflowUserInputWaitingResult.Type;

/**
 * A question outlives the tool call that asked it. Providers cut a silent MCP
 * call off after a few minutes, so a round nobody answered in time comes back
 * as `waiting` carrying the id to park on again; the card on screen and the
 * answers the user has already picked survive across those rounds.
 */
export const WorkflowUserInputResult = Schema.Union([
  WorkflowUserInputAnsweredResult,
  WorkflowUserInputWaitingResult,
]);
export type WorkflowUserInputResult = typeof WorkflowUserInputResult.Type;

/**
 * How long one parked round waits before it hands the agent a `waiting`
 * result. It has to clear the shortest provider ceiling we have measured with
 * room to spare: Claude Code aborts a silent HTTP MCP call about five minutes
 * after it arrives, and appending the card eats into that from the front.
 */
export const WORKFLOW_USER_INPUT_WAIT_WINDOW_MS = 3.5 * 60 * 1000;

/**
 * How long a question survives with no round parked on it. A model that never
 * comes back would otherwise leave a card on screen nobody can resolve. The
 * window is generous on purpose: an agent that takes a detour before parking
 * again must not have its question reaped out from under it.
 */
export const WORKFLOW_USER_INPUT_ABANDON_GRACE_MS = 3 * 60 * 1000;

export class WorkflowUserInputError extends Schema.TaggedErrorClass<WorkflowUserInputError>()(
  "WorkflowUserInputError",
  {
    threadId: ThreadId,
    message: TrimmedNonEmptyString,
  },
) {}
