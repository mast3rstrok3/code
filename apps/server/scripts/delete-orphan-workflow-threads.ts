#!/usr/bin/env node

/**
 * Delete workflow threads that were created for a stage that never started.
 *
 * A reactor that re-entered a stage it could not start left one thread behind
 * per attempt: created, never given a provider session, never sent a message.
 * They are invisible work that still loads every client's workflow panel, and
 * because the read model is derived from events, removing the rows is not
 * enough — the deletions have to be real `thread.delete` commands so a
 * projection rebuild does not bring them back.
 *
 * The server owns its database, so it must be stopped while this runs:
 *
 *   sudo systemctl stop code-dev-t3code.service
 *   node apps/server/scripts/delete-orphan-workflow-threads.ts \
 *     --base-dir /var/lib/code/t3code-dev --workflow-role implementation-code-reviewer
 *   sudo systemctl start code-dev-t3code.service
 *
 * Defaults to a dry run; pass --apply to write. A backup is taken first.
 */

// @effect-diagnostics nodeBuiltinImport:off - node:path joins the base directory.
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodePath from "node:path";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { Command, Flag } from "effect/unstable/cli";
import { CommandId, ThreadId } from "@t3tools/contracts";

import * as ServerConfig from "../src/config.ts";
import * as NodeSqliteClient from "../src/persistence/NodeSqliteClient.ts";
import * as RepositoryIdentityResolver from "../src/project/RepositoryIdentityResolver.ts";
import { OrchestrationLayerLive } from "../src/orchestration/runtimeLayer.ts";
import { OrchestrationEngineService } from "../src/orchestration/Services/OrchestrationEngine.ts";

const OrphanRow = Schema.Struct({ threadId: Schema.String });

export class OrphanCleanupDatabaseMissingError extends Schema.TaggedErrorClass<OrphanCleanupDatabaseMissingError>()(
  "OrphanCleanupDatabaseMissingError",
  { databasePath: Schema.String },
) {
  override get message(): string {
    return `Database does not exist at '${this.databasePath}'.`;
  }
}

/**
 * Threads of `workflowRole` that carry nothing at all.
 *
 * Every clause is a way a thread could hold something a user would miss: a
 * provider session, a message, an activity, a checkpoint, or a child. A thread
 * that has none of them, and is not itself referenced as a run's live stage
 * thread, only ever existed as a failed attempt.
 */
const selectOrphans = (workflowRole: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql`
      SELECT t.thread_id AS "threadId"
      FROM projection_threads t
      WHERE t.workflow_role = ${workflowRole}
        AND t.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM projection_thread_sessions s WHERE s.thread_id = t.thread_id)
        AND NOT EXISTS (SELECT 1 FROM projection_thread_messages m WHERE m.thread_id = t.thread_id)
        AND NOT EXISTS (SELECT 1 FROM projection_thread_activities a WHERE a.thread_id = t.thread_id)
        AND NOT EXISTS (SELECT 1 FROM projection_threads c WHERE c.parent_thread_id = t.thread_id AND c.deleted_at IS NULL)
        AND NOT EXISTS (
          SELECT 1 FROM projection_implementation_runs r
          WHERE r.status NOT IN ('completed', 'canceled')
            AND r.ticket_states_json LIKE '%' || t.thread_id || '%'
        )
      ORDER BY t.created_at ASC
    `.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(OrphanRow))));
  });

const run = (input: {
  readonly baseDir: string;
  readonly workflowRole: string;
  readonly apply: boolean;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const databasePath = NodePath.join(input.baseDir, "userdata", "state.sqlite");
    if (!(yield* fs.exists(databasePath))) {
      return yield* new OrphanCleanupDatabaseMissingError({ databasePath });
    }

    const sqlLayer = NodeSqliteClient.layer({ filename: databasePath, readonly: false });

    const orphans = yield* selectOrphans(input.workflowRole).pipe(Effect.provide(sqlLayer));
    yield* Console.log(
      `${String(orphans.length)} orphan '${input.workflowRole}' thread(s) in ${databasePath}`,
    );
    if (orphans.length === 0 || !input.apply) {
      yield* Console.log(input.apply ? "Nothing to delete." : "Dry run — pass --apply to delete.");
      return;
    }

    const timestamp = DateTime.formatIso(yield* DateTime.now).replaceAll(":", "-");
    const backupPath = `${databasePath}.backup-${timestamp}`;
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`VACUUM INTO ${backupPath}`;
    }).pipe(Effect.provide(sqlLayer));
    yield* fs.chmod(backupPath, 0o600);
    yield* Console.log(`Backup written to ${backupPath}`);

    yield* Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      let deleted = 0;
      for (const orphan of orphans) {
        yield* engine.dispatch({
          type: "thread.delete",
          commandId: CommandId.make(`server:orphan-cleanup-${orphan.threadId}`),
          threadId: ThreadId.make(orphan.threadId),
        });
        deleted += 1;
        if (deleted % 250 === 0) {
          yield* Console.log(`  deleted ${String(deleted)}/${String(orphans.length)}`);
        }
      }
      yield* Console.log(`Deleted ${String(deleted)} thread(s).`);
    }).pipe(
      Effect.provide(
        OrchestrationLayerLive.pipe(
          Layer.provide(RepositoryIdentityResolver.layer),
          Layer.provide(sqlLayer),
          Layer.provide(ServerConfig.layerTest(process.cwd(), input.baseDir)),
        ),
      ),
    );
  });

export const deleteOrphanWorkflowThreadsCommand = Command.make(
  "delete-orphan-workflow-threads",
  {
    baseDir: Flag.string("base-dir").pipe(
      Flag.withDescription("T3 base directory containing userdata/state.sqlite."),
    ),
    workflowRole: Flag.string("workflow-role").pipe(
      Flag.withDescription("Workflow role to sweep, e.g. implementation-code-reviewer."),
    ),
    apply: Flag.boolean("apply").pipe(
      Flag.withDescription("Delete for real. Without it the command only reports what it found."),
    ),
  },
  (flags) => run(flags),
);

if (import.meta.main) {
  Command.run(deleteOrphanWorkflowThreadsCommand, { version: "1.0.0" }).pipe(
    Effect.scoped,
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
