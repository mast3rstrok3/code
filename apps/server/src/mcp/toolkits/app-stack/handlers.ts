import { AppStackError, type AppStackVariant } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { AppStackManager } from "../../../appStack/AppStackManager.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import { AppStackToolkit } from "./tools.ts";

export const handlers = {
  app_stack_get: Effect.fn("AppStackToolkit.get")(function* (input: {
    readonly variant?: AppStackVariant;
  }) {
    const scope = yield* McpInvocationContext;
    const query = yield* ProjectionSnapshotQuery;
    const manager = yield* AppStackManager;
    const workspace = yield* Effect.gen(function* () {
      const thread = yield* query.getThreadShellById(scope.threadId);
      if (Option.isNone(thread)) return undefined;
      if (thread.value.worktreePath?.trim()) return thread.value.worktreePath.trim();
      const project = yield* query.getProjectShellById(thread.value.projectId);
      return Option.getOrUndefined(project)?.workspaceRoot;
    }).pipe(
      Effect.mapError(
        (cause) =>
          new AppStackError({
            operation: "app_stack_get",
            message: "Could not resolve this thread's workspace.",
            cause,
          }),
      ),
    );
    if (!workspace) {
      return yield* new AppStackError({
        operation: "app_stack_get",
        message: "This thread's workspace was not found.",
      });
    }
    const variant = input.variant ?? "dev";
    const status = yield* manager.status;
    const result = status.enabled
      ? yield* manager.getByWorktree({ worktreePath: workspace, variant }).pipe(
          Effect.timeout("5 seconds"),
          Effect.mapError(
            (cause) =>
              new AppStackError({
                operation: "app_stack_get",
                message: "Could not refresh this workspace's App Stack status.",
                cause,
              }),
          ),
        )
      : { stack: null, frontendUrl: null, frontendServiceName: null };
    return {
      ...result,
      worktreePath: workspace,
      variant,
      enabled: status.enabled,
      checkedAt: DateTime.formatIso(yield* DateTime.now),
    };
  }),
} satisfies Parameters<typeof AppStackToolkit.toLayer>[0];

export const AppStackToolkitHandlersLive = AppStackToolkit.toLayer(handlers);
