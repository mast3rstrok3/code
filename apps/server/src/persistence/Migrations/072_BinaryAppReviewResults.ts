import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Canonicalizes terminal App Review workflow results. Review attempts are
 * pass/fail; reaching the configured budget remains exhausted. Historical
 * blocked and canceled runs retain their failure detail but decode as failed.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    UPDATE projection_app_review_workflow_runs
    SET
      status = CASE WHEN status IN ('blocked', 'canceled') THEN 'failed' ELSE status END,
      run_json = json_set(
        json_set(run_json, '$.status', 'failed'),
        '$.outcome',
        'failed'
      )
    WHERE json_extract(run_json, '$.status') IN ('blocked', 'canceled')
       OR json_extract(run_json, '$.outcome') IN ('blocked', 'canceled')
  `;

  yield* sql`
    UPDATE projection_thread_app_reviews
    SET
      status = CASE WHEN status = 'blocked' THEN 'failed' ELSE status END,
      document_json = CASE
        WHEN json_extract(document_json, '$.verdict') = 'blocked'
        THEN json_set(document_json, '$.verdict', 'failed')
        ELSE document_json
      END
    WHERE status = 'blocked'
       OR json_extract(document_json, '$.verdict') = 'blocked'
  `;
  yield* sql`
    UPDATE orchestration_events
    SET payload_json = replace(
      replace(payload_json, '"status":"blocked"', '"status":"failed"'),
      '"verdict":"blocked"',
      '"verdict":"failed"'
    )
    WHERE event_type = 'thread.app-review-updated'
      AND (
        json_extract(payload_json, '$.status') = 'blocked'
        OR json_extract(payload_json, '$.document.verdict') = 'blocked'
      )
  `;
  yield* sql`
    UPDATE projection_app_review_workflow_runs
    SET run_json = json_set(run_json, '$.cycles[#-1].status', 'completed')
    WHERE json_extract(run_json, '$.cycles[#-1].status') = 'blocked'
  `;
  yield* sql`
    UPDATE projection_app_review_workflow_runs
    SET run_json = json_set(run_json, '$.cycles[#-1].reviewVerdict', 'failed')
    WHERE json_extract(run_json, '$.cycles[#-1].reviewVerdict') = 'blocked'
  `;

  yield* sql`
    UPDATE orchestration_events
    SET payload_json = json_set(
      json_set(payload_json, '$.run.status', 'failed'),
      '$.run.outcome',
      'failed'
    )
    WHERE event_type LIKE 'thread.app-review-workflow-%'
      AND (
        json_extract(payload_json, '$.run.status') IN ('blocked', 'canceled')
        OR json_extract(payload_json, '$.run.outcome') IN ('blocked', 'canceled')
      )
  `;
  yield* sql`
    UPDATE orchestration_events
    SET payload_json = json_set(payload_json, '$.run.cycles[#-1].status', 'completed')
    WHERE event_type LIKE 'thread.app-review-workflow-%'
      AND json_extract(payload_json, '$.run.cycles[#-1].status') = 'blocked'
  `;
  yield* sql`
    UPDATE orchestration_events
    SET payload_json = json_set(payload_json, '$.run.cycles[#-1].reviewVerdict', 'failed')
    WHERE event_type LIKE 'thread.app-review-workflow-%'
      AND json_extract(payload_json, '$.run.cycles[#-1].reviewVerdict') = 'blocked'
  `;

  yield* sql`
    UPDATE projection_implementation_runs
    SET run_json = replace(
      replace(
        replace(
          replace(run_json, '"appReviewOutcome":"blocked"', '"appReviewOutcome":"failed"'),
          '"appReviewOutcome":"canceled"', '"appReviewOutcome":"failed"'
        ),
        '"latestAppReviewWorkflowOutcome":"blocked"',
        '"latestAppReviewWorkflowOutcome":"failed"'
      ),
      '"latestAppReviewWorkflowOutcome":"canceled"',
      '"latestAppReviewWorkflowOutcome":"failed"'
    )
    WHERE run_json LIKE '%"appReviewOutcome":"blocked"%'
       OR run_json LIKE '%"appReviewOutcome":"canceled"%'
       OR run_json LIKE '%"latestAppReviewWorkflowOutcome":"blocked"%'
       OR run_json LIKE '%"latestAppReviewWorkflowOutcome":"canceled"%'
  `;
});
