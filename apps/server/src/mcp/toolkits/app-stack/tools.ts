import {
  AppStackByWorktreeResult,
  AppStackError,
  AppStackVariant,
  IsoDateTime,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import { AppStackManager } from "../../../appStack/AppStackManager.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";

export const AppStackGetTool = Tool.make("app_stack_get", {
  description:
    "Read current App Stack status and service URLs for this thread's workspace. Defaults to the dev variant; request prod to inspect its production build. Resolves the workspace from the authenticated thread. Does not start, stop, or change a stack.",
  parameters: Schema.Struct({ variant: Schema.optionalKey(AppStackVariant) }),
  success: Schema.Struct({
    ...AppStackByWorktreeResult.fields,
    worktreePath: TrimmedNonEmptyString,
    variant: AppStackVariant,
    enabled: Schema.Boolean,
    checkedAt: IsoDateTime,
  }),
  failure: AppStackError,
  dependencies: [McpInvocationContext, ProjectionSnapshotQuery, AppStackManager],
})
  .annotate(Tool.Title, "Check this workspace's App Stack")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const AppStackToolkit = Toolkit.make(AppStackGetTool);
