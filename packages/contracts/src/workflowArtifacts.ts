import * as Schema from "effect/Schema";

import { ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  OrchestrationImplementationRun,
  OrchestrationPlanningReviewCycle,
  OrchestrationPlanningSpec,
  OrchestrationPlanningTicket,
  ThreadWorkflowContext,
} from "./orchestration.ts";
import { DevReviewRecord } from "./review.ts";
import { DevReviewWorkflowRun } from "./review.ts";

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
  devReviewWorkflowRuns: Schema.Array(DevReviewWorkflowRun),
  devReviews: Schema.Array(DevReviewRecord),
});
export type WorkflowArtifactsSnapshot = typeof WorkflowArtifactsSnapshot.Type;

export class WorkflowArtifactAccessError extends Schema.TaggedErrorClass<WorkflowArtifactAccessError>()(
  "WorkflowArtifactAccessError",
  {
    threadId: ThreadId,
    message: TrimmedNonEmptyString,
  },
) {}
