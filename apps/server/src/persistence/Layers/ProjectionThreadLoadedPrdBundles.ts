import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  DeleteProjectionThreadLoadedPrdBundlesInput,
  ProjectionThreadLoadedPrdBundle,
  ProjectionThreadLoadedPrdBundleRepository,
  type ProjectionThreadLoadedPrdBundleRepositoryShape,
} from "../Services/ProjectionThreadLoadedPrdBundles.ts";

const makeProjectionThreadLoadedPrdBundleRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionThreadLoadedPrdBundleRow = SqlSchema.void({
    Request: ProjectionThreadLoadedPrdBundle,
    execute: (row) => sql`
      INSERT INTO projection_thread_loaded_prd_bundles (
        thread_id, prd_id, source_thread_id, loaded_at
      )
      VALUES (${row.threadId}, ${row.prdId}, ${row.sourceThreadId}, ${row.loadedAt})
      ON CONFLICT (thread_id, prd_id)
      DO UPDATE SET
        source_thread_id = excluded.source_thread_id,
        loaded_at = excluded.loaded_at
    `,
  });

  const deleteProjectionThreadLoadedPrdBundleRows = SqlSchema.void({
    Request: DeleteProjectionThreadLoadedPrdBundlesInput,
    execute: ({ threadId }) => sql`
      DELETE FROM projection_thread_loaded_prd_bundles
      WHERE thread_id = ${threadId}
    `,
  });

  return {
    upsert: (row) =>
      upsertProjectionThreadLoadedPrdBundleRow(row).pipe(
        Effect.mapError(
          toPersistenceSqlError("ProjectionThreadLoadedPrdBundleRepository.upsert:query"),
        ),
      ),
    deleteByThreadId: (input) =>
      deleteProjectionThreadLoadedPrdBundleRows(input).pipe(
        Effect.mapError(
          toPersistenceSqlError("ProjectionThreadLoadedPrdBundleRepository.deleteByThreadId:query"),
        ),
      ),
  } satisfies ProjectionThreadLoadedPrdBundleRepositoryShape;
});

export const ProjectionThreadLoadedPrdBundleRepositoryLive = Layer.effect(
  ProjectionThreadLoadedPrdBundleRepository,
  makeProjectionThreadLoadedPrdBundleRepository,
);
