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
