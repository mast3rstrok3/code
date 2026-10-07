import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
export const WorkflowPreset = Schema.Literals([
  "fix",
  "fast-feature",
  "quick-plan",
  "fast-plan",
  "fast-engineering",
  "full-feature",
  "product-planning",
  "wayfinder",
  "implementation",
  "planning",
  "app-review",
]);
export type WorkflowPreset = typeof WorkflowPreset.Type;
export const WorkflowId = TrimmedNonEmptyString.pipe(Schema.brand("WorkflowId"));
export type WorkflowId = typeof WorkflowId.Type;
export const ThreadWorkflowContext = Schema.Struct({
  workflowId: WorkflowId,
  // Optional so snapshots and events written before nested workflow identity
  // was introduced continue to decode. New workflow controllers write it
  // explicitly (`null` for a top-level run).
  parentWorkflowId: Schema.optional(Schema.NullOr(WorkflowId)),
  rootThreadId: ThreadId,
  ticketScope: Schema.Array(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
});
export type ThreadWorkflowContext = typeof ThreadWorkflowContext.Type;
export const OrchestrationThreadWorkflowRole = Schema.Literals([
  "planning-orchestrator",
  "planning-reviewer",
  "implementation-orchestrator",
  "implementation-worker",
  "implementation-validator",
  "implementation-qa-reviewer",
  "implementation-fixer",
  "implementation-code-reviewer",
  "implementation-change-request-babysitter",
  "product-fix-implementer",
  "fast-feature-implementer",
  "app-review-orchestrator",
  "app-review-reviewer",
  "app-review-planner",
  "app-review-fixer",
]);
export type OrchestrationThreadWorkflowRole = typeof OrchestrationThreadWorkflowRole.Type;
