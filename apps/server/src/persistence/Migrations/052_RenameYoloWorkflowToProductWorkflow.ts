import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    UPDATE projection_threads
    SET interaction_mode = 'product-workflow'
    WHERE interaction_mode = 'yolo-workflow'
  `;
});
