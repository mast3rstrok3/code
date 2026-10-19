import { IsoDateTime, OrchestratorMcpFailure, TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as BuildBatchService from "../../../buildBatch/BuildBatchService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  BuildBatchService.BuildBatchService,
];

const RouteInput = Schema.Struct({
  app: BuildBatchService.BuildBatchApp,
  branch: Schema.optionalKey(BuildBatchService.BuildBatchBranch),
});

const BuildBatchStartTool = Tool.make("build_batch_start", {
  description:
    "Hold the home cluster's builds of one app branch while you merge several pull requests into it, so the branch builds once. Call it before the first merge and build_batch_finish after the last. While the batch is open, builds of that branch from pushes and the 10-minute poll skip. Calling it again moves the end to hours from now. A batch nobody finishes ends after hours and the next poll builds the branch tip. Not needed for a single merge.",
  parameters: Schema.Struct({
    ...RouteInput.fields,
    hours: Schema.optionalKey(BuildBatchService.BuildBatchHours),
    reason: Schema.optionalKey(
      TrimmedNonEmptyString.annotate({
        description: 'Why builds wait. Defaults to "merging several pull requests".',
      }),
    ),
  }),
  success: Schema.Struct({ key: Schema.String, reason: Schema.String, until: IsoDateTime }),
  failure: OrchestratorMcpFailure,
  dependencies,
})
  .annotate(Tool.Title, "Open a merge batch on an app branch's builds")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

const BuildBatchFinishTool = Tool.make("build_batch_finish", {
  description:
    "Finish an app branch's merge batch after its last merge. The branch tip builds at the next poll, at most 10 minutes later; buildsAt is that poll. wasOpen is false when no batch was open. Without a batch every push builds as before.",
  parameters: RouteInput,
  success: Schema.Struct({ key: Schema.String, wasOpen: Schema.Boolean, buildsAt: IsoDateTime }),
  failure: OrchestratorMcpFailure,
  dependencies,
})
  .annotate(Tool.Title, "Finish a merge batch on an app branch's builds")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

const BuildBatchListTool = Tool.make("build_batch_list", {
  description:
    "List the merge batches on the home cluster's app builds, keyed <app>.<branch>, with reason and end. An expired batch no longer holds builds.",
  parameters: Tool.EmptyParams,
  success: Schema.Struct({
    batches: Schema.Array(
      Schema.Struct({
        key: Schema.String,
        reason: Schema.String,
        until: IsoDateTime,
        expired: Schema.Boolean,
      }),
    ),
  }),
  failure: OrchestratorMcpFailure,
  dependencies,
})
  .annotate(Tool.Title, "List merge batches on app builds")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const BuildBatchToolkit = Toolkit.make(
  BuildBatchStartTool,
  BuildBatchFinishTool,
  BuildBatchListTool,
);
