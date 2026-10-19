import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as BuildBatchService from "../../../buildBatch/BuildBatchService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { BuildBatchToolkit } from "./tools.ts";

// Every build batch error message is built on the server and says what to do next.
const toFailure = (error: BuildBatchService.BuildBatchError) =>
  new OrchestratorMcpFailure({
    code: "orchestration_error",
    message: error.message,
  });

export const layer = McpToolAccess.toLayer(BuildBatchToolkit, {
  build_batch_start: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const { thread } = yield* McpInvocationContext.requireThreadScope(scope, "build_batch_start");
      const batches = yield* BuildBatchService.BuildBatchService;
      return yield* batches
        .start({ ...input, threadId: thread.threadId })
        .pipe(Effect.mapError(toFailure));
    }),
  ),
  build_batch_finish: McpToolAccess.actsAsCaller((input) =>
    BuildBatchService.BuildBatchService.pipe(
      Effect.flatMap((batches) => batches.finish(input)),
      Effect.mapError(toFailure),
    ),
  ),
  build_batch_list: McpToolAccess.readsAsCaller(() =>
    BuildBatchService.BuildBatchService.pipe(
      Effect.flatMap((batches) => batches.list),
      Effect.map((batches) => ({ batches })),
      Effect.mapError(toFailure),
    ),
  ),
});
