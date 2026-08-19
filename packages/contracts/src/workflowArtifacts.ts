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

export const WorkflowUserInputResult = Schema.Struct({
  answers: Schema.Array(WorkflowUserInputAnswer),
});
export type WorkflowUserInputResult = typeof WorkflowUserInputResult.Type;

export class WorkflowUserInputError extends Schema.TaggedErrorClass<WorkflowUserInputError>()(
  "WorkflowUserInputError",
  {
    threadId: ThreadId,
    message: TrimmedNonEmptyString,
  },
) {}
