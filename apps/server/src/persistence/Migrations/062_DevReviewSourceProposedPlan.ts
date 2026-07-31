import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_thread_dev_reviews)
  `;
  if (!columns.some((column) => column.name === "source_proposed_plan_json")) {
    yield* sql`
      ALTER TABLE projection_thread_dev_reviews
      ADD COLUMN source_proposed_plan_json TEXT
    `;
  }
});
