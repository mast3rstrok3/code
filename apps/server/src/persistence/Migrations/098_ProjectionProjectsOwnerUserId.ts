import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Projects created before ownership existed belong to the default workspace user,
// matching the decoding default on `ProjectCreatedPayload.ownerUserId`.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_projects)
  `;

  if (!columns.some((column) => column.name === "owner_user_id")) {
    yield* sql`
      ALTER TABLE projection_projects
      ADD COLUMN owner_user_id TEXT NOT NULL DEFAULT 'nils'
    `;
  }
});
