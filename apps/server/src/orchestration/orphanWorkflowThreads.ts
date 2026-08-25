import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const OrphanWorkflowThreadRow = Schema.Struct({ threadId: Schema.String });
export type OrphanWorkflowThreadRow = typeof OrphanWorkflowThreadRow.Type;

/**
 * Select empty workflow shells. Every durable content or ownership relation
 * disqualifies a thread from automatic cleanup.
 */
export const selectOrphanWorkflowThreads = (workflowRole?: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows =
      workflowRole === undefined
        ? yield* sql`
          SELECT t.thread_id AS "threadId"
          FROM projection_threads t
          WHERE t.workflow_role IS NOT NULL
            AND t.deleted_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM projection_thread_sessions s WHERE s.thread_id = t.thread_id)
            AND NOT EXISTS (SELECT 1 FROM projection_thread_messages m WHERE m.thread_id = t.thread_id)
            AND NOT EXISTS (SELECT 1 FROM projection_thread_activities a WHERE a.thread_id = t.thread_id)
            AND NOT EXISTS (SELECT 1 FROM projection_turns turn WHERE turn.thread_id = t.thread_id)
            AND NOT EXISTS (
              SELECT 1 FROM projection_threads c
              WHERE c.parent_thread_id = t.thread_id AND c.deleted_at IS NULL
            )
            AND NOT EXISTS (
              SELECT 1 FROM projection_implementation_runs r
              WHERE r.status NOT IN ('completed', 'canceled')
                AND (
                  r.orchestrator_thread_id = t.thread_id
                  OR r.source_thread_id = t.thread_id
                  OR r.ticket_states_json LIKE '%' || t.thread_id || '%'
                  OR r.run_json LIKE '%' || t.thread_id || '%'
                )
            )
            AND NOT EXISTS (
              SELECT 1 FROM projection_app_review_workflow_runs r
              WHERE r.status = 'running'
                AND (
                  r.target_thread_id = t.thread_id
                  OR r.controller_thread_id = t.thread_id
                  OR r.caller_thread_id = t.thread_id
                  OR r.run_json LIKE '%' || t.thread_id || '%'
                )
            )
          ORDER BY t.created_at ASC
        `
        : yield* sql`
          SELECT t.thread_id AS "threadId"
          FROM projection_threads t
          WHERE t.workflow_role = ${workflowRole}
            AND t.deleted_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM projection_thread_sessions s WHERE s.thread_id = t.thread_id)
            AND NOT EXISTS (SELECT 1 FROM projection_thread_messages m WHERE m.thread_id = t.thread_id)
            AND NOT EXISTS (SELECT 1 FROM projection_thread_activities a WHERE a.thread_id = t.thread_id)
            AND NOT EXISTS (SELECT 1 FROM projection_turns turn WHERE turn.thread_id = t.thread_id)
            AND NOT EXISTS (
              SELECT 1 FROM projection_threads c
              WHERE c.parent_thread_id = t.thread_id AND c.deleted_at IS NULL
            )
            AND NOT EXISTS (
              SELECT 1 FROM projection_implementation_runs r
              WHERE r.status NOT IN ('completed', 'canceled')
                AND (
                  r.orchestrator_thread_id = t.thread_id
                  OR r.source_thread_id = t.thread_id
                  OR r.ticket_states_json LIKE '%' || t.thread_id || '%'
                  OR r.run_json LIKE '%' || t.thread_id || '%'
                )
            )
            AND NOT EXISTS (
              SELECT 1 FROM projection_app_review_workflow_runs r
              WHERE r.status = 'running'
                AND (
                  r.target_thread_id = t.thread_id
                  OR r.controller_thread_id = t.thread_id
                  OR r.caller_thread_id = t.thread_id
                  OR r.run_json LIKE '%' || t.thread_id || '%'
                )
            )
          ORDER BY t.created_at ASC
        `;
    return yield* Schema.decodeUnknownEffect(Schema.Array(OrphanWorkflowThreadRow))(rows);
  });
