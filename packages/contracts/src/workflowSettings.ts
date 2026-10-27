import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

// Kept apart from orchestration.ts so the native (V2) contracts, which that
// module imports, can carry the same per-run stage settings without a cycle.

export const DEFAULT_MAX_PARALLEL_TICKETS = 10;
export const DEFAULT_MAX_PARALLEL_APP_REVIEWS = 2;
export const MAX_PARALLEL_TICKETS = 32;
export const MaxParallelTickets = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: MAX_PARALLEL_TICKETS }),
);

/**
 * The workflows a thread can start as without the composer, by the names
 * `t3_thread_launch` and scheduled tasks accept. Also the scope of a standing
 * step model, so Feature's and Engineering's Code Review keep separate defaults.
 */
export const LaunchableWorkflow = Schema.Literals(["feature", "engineering"]);
export type LaunchableWorkflow = typeof LaunchableWorkflow.Type;

/**
 * Who answers Grill with Docs questions: the person who started the workflow,
 * or a separate LLM judge thread that answers them from the task and the
 * Grill's recommendations so the workflow can run unattended.
 */
export const GrillAnswerer = Schema.Literals(["human", "judge"]);
export type GrillAnswerer = typeof GrillAnswerer.Type;

export const ImplementationWorkflowSettings = Schema.Struct({
  /** Absent means a human answers. */
  grillAnswerer: Schema.optionalKey(GrillAnswerer),
  maxParallelTickets: Schema.optionalKey(MaxParallelTickets),
  maxParallelAppReviews: Schema.optionalKey(MaxParallelTickets),
  ticketAppReviewEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  appReviewEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  finalCodeReviewEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  pullRequestCreationEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  pullRequestBabysittingEnabled: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(true)),
  ),
});
export type ImplementationWorkflowSettings = typeof ImplementationWorkflowSettings.Type;
