import type {
  AppStack,
  OrchestrationShellSnapshot,
  OrchestrationThreadShell,
  ThreadId,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { AppStackManager } from "../appStack/AppStackManager.ts";
import { normalizeWorkflowWorktreePath } from "../appStack/workflowOwnership.ts";
import { forkParked } from "../serverActivation.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import { threadHasQueuedTurnStart } from "./ThreadSettlementPolicy.ts";

export class AppStackLifecycleReactor extends Context.Service<
  AppStackLifecycleReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/orchestration/AppStackLifecycleReactor") {}

function isSettled(thread: OrchestrationThreadShell, now: string): boolean {
  return (
    thread.settledOverride === "settled" &&
    thread.session?.status !== "starting" &&
    thread.session?.status !== "running" &&
    !thread.hasPendingApprovals &&
    !thread.hasPendingUserInput &&
    !threadHasQueuedTurnStart(thread, now)
  );
}

function canStopStacks(
  stacks: ReadonlyArray<AppStack>,
  snapshot: OrchestrationShellSnapshot,
  now: string,
  threadId: ThreadId | undefined,
): boolean {
  if (
    stacks.some(
      (stack) =>
        stack.protected === true || stack.branchName === "dev" || stack.branchName === "main",
    )
  ) {
    return false;
  }
  const paths = new Set(stacks.map((stack) => normalizeWorkflowWorktreePath(stack.worktreePath)));
  const workflowIds = new Set(
    stacks.flatMap((stack) => (stack.workflowId ? [stack.workflowId] : [])),
  );
  const projects = new Map(snapshot.projects.map((project) => [project.id, project.workspaceRoot]));
  let hasSettledThread = false;
  let matchesEvent = threadId === undefined;
  for (const thread of snapshot.threads) {
    if (thread.archivedAt !== null) continue;
    const worktreePath = thread.worktreePath ?? projects.get(thread.projectId);
    const usesPath =
      worktreePath !== undefined && paths.has(normalizeWorkflowWorktreePath(worktreePath));
    const usesWorkflow =
      thread.workflowContext != null &&
      (workflowIds.has(thread.workflowContext.workflowId) ||
        (thread.workflowContext.parentWorkflowId != null &&
          workflowIds.has(thread.workflowContext.parentWorkflowId)));
    if (!usesPath && !usesWorkflow) continue;
    if (!isSettled(thread, now)) return false;
    if (usesPath) hasSettledThread = true;
    if (thread.id === threadId) matchesEvent = true;
  }
  return hasSettledThread && matchesEvent;
}

export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery;
  const manager = yield* AppStackManager;

  const cleanup = Effect.fn("AppStackLifecycleReactor.cleanup")(function* (
    threadId: ThreadId | undefined,
  ) {
    if (!(yield* manager.status).enabled) return;
    const snapshot = yield* snapshots.getShellSnapshot();
    const now = DateTime.formatIso(yield* DateTime.now);
    if (
      !snapshot.threads.some(
        (thread) =>
          thread.archivedAt === null &&
          (threadId === undefined || thread.id === threadId) &&
          isSettled(thread, now),
      )
    ) {
      return;
    }
    const { stacks } = yield* manager.list({});
    // Stopping one bundle member stops all of them, including members whose
    // worktrees belong to another project or whose protection differs.
    const groups = Map.groupBy(stacks, (stack) =>
      stack.bundleId == null ? `stack:${stack.id}` : `bundle:${stack.bundleId}`,
    );
    for (const members of groups.values()) {
      if (members.every((stack) => stack.status === "stopped" || stack.status === "stopping"))
        continue;
      if (!canStopStacks(members, snapshot, now, threadId)) continue;
      yield* Effect.gen(function* () {
        const currentMembers = yield* Effect.forEach(members, (stack) =>
          manager.get({ stackId: stack.id }),
        );
        // Controller reads can take time. Recheck settlement and protection
        // just before stopping so resumed threads keep their stacks.
        const currentSnapshot = yield* snapshots.getShellSnapshot();
        if (
          !canStopStacks(
            currentMembers,
            currentSnapshot,
            DateTime.formatIso(yield* DateTime.now),
            threadId,
          )
        ) {
          return;
        }
        const stack = currentMembers.find(
          (member) => member.status !== "stopped" && member.status !== "stopping",
        );
        if (stack === undefined) return;
        yield* manager.stop({ stackId: stack.id });
      }).pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) =>
            Effect.logWarning("failed to stop settled thread app stack", {
              stackIds: members.map((stack) => stack.id),
              cause: Cause.pretty(cause),
            }),
        ),
      );
    }
  });

  const worker = yield* makeDrainableWorker((threadId: ThreadId | undefined) =>
    cleanup(threadId).pipe(
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) =>
          Effect.logWarning("settled thread app stack cleanup failed", {
            threadId,
            cause: Cause.pretty(cause),
          }),
      ),
    ),
  );

  const start = Effect.fn("AppStackLifecycleReactor.start")(function* () {
    const events = yield* engine.subscribeDomainEvents;
    yield* forkParked(
      Stream.runForEach(events, (event) =>
        event.type === "thread.settled" ? worker.enqueue(event.payload.threadId) : Effect.void,
      ),
    );
    yield* forkParked(worker.enqueue(undefined));
  });

  return { start, drain: worker.drain } satisfies AppStackLifecycleReactor["Service"];
});

export const layer = Layer.effect(AppStackLifecycleReactor, make);
