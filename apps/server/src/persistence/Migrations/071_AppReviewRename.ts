import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Moves the persisted Dev Review model to its App Review names. Migrations
 * 45-69 intentionally retain their historical schema so databases created by
 * any released version converge through this single compatibility boundary.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`DROP INDEX IF EXISTS idx_projection_thread_dev_reviews_source_created`;
  yield* sql`DROP INDEX IF EXISTS idx_projection_thread_dev_reviews_review_created`;
  yield* sql`ALTER TABLE projection_thread_dev_reviews RENAME TO projection_thread_app_reviews`;
  yield* sql`
    CREATE INDEX idx_projection_thread_app_reviews_source_created
    ON projection_thread_app_reviews(source_thread_id, created_at)
  `;
  yield* sql`
    CREATE INDEX idx_projection_thread_app_reviews_review_created
    ON projection_thread_app_reviews(review_thread_id, created_at)
  `;

  yield* sql`DROP INDEX IF EXISTS idx_projection_dev_review_tickets_ticket`;
  yield* sql`ALTER TABLE projection_dev_review_tickets RENAME TO projection_app_review_tickets`;
  yield* sql`
    CREATE INDEX idx_projection_app_review_tickets_ticket
    ON projection_app_review_tickets(ticket_id, review_id)
  `;

  yield* sql`DROP INDEX IF EXISTS idx_projection_dev_review_workflow_runs_target`;
  yield* sql`DROP INDEX IF EXISTS idx_projection_dev_review_workflow_runs_controller`;
  yield* sql`DROP INDEX IF EXISTS idx_projection_dev_review_workflow_runs_caller`;
  yield* sql`DROP INDEX IF EXISTS idx_projection_dev_review_workflow_runs_implementation`;
  yield* sql`
    ALTER TABLE projection_dev_review_workflow_runs
    RENAME TO projection_app_review_workflow_runs
  `;
  yield* sql`
    CREATE INDEX idx_projection_app_review_workflow_runs_target
    ON projection_app_review_workflow_runs(target_thread_id, created_at)
  `;
  yield* sql`
    CREATE INDEX idx_projection_app_review_workflow_runs_controller
    ON projection_app_review_workflow_runs(controller_thread_id, created_at)
  `;
  yield* sql`
    CREATE INDEX idx_projection_app_review_workflow_runs_caller
    ON projection_app_review_workflow_runs(caller_type, caller_thread_id, created_at)
  `;
  yield* sql`
    CREATE INDEX idx_projection_app_review_workflow_runs_implementation
    ON projection_app_review_workflow_runs(implementation_run_id, created_at)
  `;

  yield* sql`
    ALTER TABLE projection_implementation_runs
    RENAME COLUMN dev_review_ids_json TO app_review_ids_json
  `;
  yield* sql`
    ALTER TABLE projection_thread_workflow_subagent_batch_children
    RENAME COLUMN dev_review_mode TO app_review_mode
  `;
  yield* sql`
    ALTER TABLE projection_thread_workflow_subagent_batch_children
    RENAME COLUMN dev_review_id TO app_review_id
  `;
  yield* sql`DROP INDEX IF EXISTS idx_projection_workflow_subagent_children_review`;
  yield* sql`
    CREATE INDEX idx_projection_workflow_subagent_children_app_review
    ON projection_thread_workflow_subagent_batch_children(app_review_id)
  `;

  yield* sql`
    UPDATE projection_threads
    SET workflow_preset = 'app-review'
    WHERE workflow_preset = 'dev-review'
  `;
  yield* sql`
    UPDATE projection_threads
    SET workflow_role = replace(workflow_role, 'dev-review', 'app-review')
    WHERE workflow_role LIKE 'dev-review-%'
  `;
  yield* sql`
    UPDATE projection_thread_workflow_subagent_batch_children
    SET workflow_prompt_id = replace(
      workflow_prompt_id,
      'implementation.browser-dev-review.codex',
      'implementation.browser-app-review.codex'
    )
    WHERE workflow_prompt_id = 'implementation.browser-dev-review.codex'
  `;

  yield* sql`
    UPDATE orchestration_events
    SET
      event_type = replace(event_type, 'thread.dev-review', 'thread.app-review'),
      payload_json = replace(
        replace(
          replace(
            replace(
              replace(
                replace(
                  replace(
                    replace(
                      replace(
                        replace(payload_json, '"devReview', '"appReview'),
                        '"dev-review"', '"app-review"'
                      ),
                      '"dev-review-orchestrator"', '"app-review-orchestrator"'
                    ),
                    '"dev-review-reviewer"', '"app-review-reviewer"'
                  ),
                  '"dev-review-fixer"', '"app-review-fixer"'
                ),
                '"dev-review-evidence"', '"app-review-evidence"'
              ),
              '"dev-review-workflow-run-upserted"', '"app-review-workflow-run-upserted"'
            ),
            '"implementation-dev-review"', '"implementation-app-review"'
          ),
          '"thread.dev-review', '"thread.app-review'
        ),
        '"implementation.browser-dev-review.codex"',
        '"implementation.browser-app-review.codex"'
      ),
      metadata_json = replace(
        replace(metadata_json, '"devReview', '"appReview'),
        '"implementation.browser-dev-review.codex"',
        '"implementation.browser-app-review.codex"'
      )
    WHERE event_type LIKE 'thread.dev-review%'
       OR payload_json LIKE '%devReview%'
       OR payload_json LIKE '%"dev-review"%'
       OR payload_json LIKE '%"dev-review-orchestrator"%'
       OR payload_json LIKE '%"dev-review-reviewer"%'
       OR payload_json LIKE '%"dev-review-fixer"%'
       OR payload_json LIKE '%"dev-review-evidence"%'
       OR payload_json LIKE '%"dev-review-workflow-run-upserted"%'
       OR payload_json LIKE '%"implementation-dev-review"%'
       OR payload_json LIKE '%"thread.dev-review%'
       OR payload_json LIKE '%"implementation.browser-dev-review.codex"%'
       OR metadata_json LIKE '%devReview%'
       OR metadata_json LIKE '%"implementation.browser-dev-review.codex"%'
  `;

  yield* sql`
    UPDATE projection_implementation_runs
    SET run_json = replace(
      replace(
        replace(
          replace(
            replace(run_json, '"devReview', '"appReview'),
            '"dev-review"', '"app-review"'
          ),
          '"implementation-dev-review"', '"implementation-app-review"'
        ),
        '"dev-review-orchestrator"', '"app-review-orchestrator"'
      ),
      '"dev-review-reviewer"', '"app-review-reviewer"'
    )
    WHERE run_json LIKE '%devReview%'
       OR run_json LIKE '%"dev-review"%'
       OR run_json LIKE '%"implementation-dev-review"%'
       OR run_json LIKE '%"dev-review-orchestrator"%'
       OR run_json LIKE '%"dev-review-reviewer"%'
  `;

  yield* sql`
    UPDATE projection_app_review_workflow_runs
    SET run_json = replace(
      replace(run_json, '"devReview', '"appReview'),
      '"attemptsUsed":',
      '"cyclesUsed":'
    )
    WHERE run_json LIKE '%devReview%'
       OR run_json LIKE '%"attemptsUsed":%'
  `;

  yield* sql`
    UPDATE orchestration_events
    SET payload_json = replace(payload_json, '"attemptsUsed":', '"cyclesUsed":')
    WHERE payload_json LIKE '%"attemptsUsed":%'
  `;

  yield* sql`
    UPDATE projection_implementation_runs
    SET run_json = replace(run_json, '"attemptsUsed":', '"cyclesUsed":')
    WHERE run_json LIKE '%"attemptsUsed":%'
  `;

  yield* sql`
    UPDATE projection_thread_activities
    SET payload_json = replace(payload_json, '"devReview', '"appReview')
    WHERE payload_json LIKE '%devReview%'
  `;
});
