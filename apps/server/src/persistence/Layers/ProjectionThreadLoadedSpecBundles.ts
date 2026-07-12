import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  DeleteProjectionThreadLoadedSpecBundlesInput,
  ProjectionThreadLoadedSpecBundle,
  ProjectionThreadLoadedSpecBundleRepository,
  type ProjectionThreadLoadedSpecBundleRepositoryShape,
} from "../Services/ProjectionThreadLoadedSpecBundles.ts";

const makeProjectionThreadLoadedSpecBundleRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionThreadLoadedSpecBundleRow = SqlSchema.void({
    Request: ProjectionThreadLoadedSpecBundle,
    execute: (row) => sql`
      INSERT INTO projection_thread_loaded_spec_bundles (
        thread_id, spec_id, source_thread_id, loaded_at
      )
      VALUES (${row.threadId}, ${row.specId}, ${row.sourceThreadId}, ${row.loadedAt})
      ON CONFLICT (thread_id, spec_id)
      DO UPDATE SET
        source_thread_id = excluded.source_thread_id,
        loaded_at = excluded.loaded_at
    `,
  });

  const deleteProjectionThreadLoadedSpecBundleRows = SqlSchema.void({
    Request: DeleteProjectionThreadLoadedSpecBundlesInput,
    execute: ({ threadId }) => sql`
      DELETE FROM projection_thread_loaded_spec_bundles
      WHERE thread_id = ${threadId}
    `,
  });

  return {
    upsert: (row) =>
      upsertProjectionThreadLoadedSpecBundleRow(row).pipe(
        Effect.mapError(
          toPersistenceSqlError("ProjectionThreadLoadedSpecBundleRepository.upsert:query"),
        ),
      ),
    deleteByThreadId: (input) =>
      deleteProjectionThreadLoadedSpecBundleRows(input).pipe(
        Effect.mapError(
          toPersistenceSqlError(
            "ProjectionThreadLoadedSpecBundleRepository.deleteByThreadId:query",
          ),
        ),
      ),
  } satisfies ProjectionThreadLoadedSpecBundleRepositoryShape;
});

export const ProjectionThreadLoadedSpecBundleRepositoryLive = Layer.effect(
  ProjectionThreadLoadedSpecBundleRepository,
  makeProjectionThreadLoadedSpecBundleRepository,
);
