import type { AppStack, OrchestrationV2ThreadShell, ProjectId, ThreadId } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { forkParked } from "../serverActivation.ts";
import { AppStackManager } from "./AppStackManager.ts";

type StackUser = Pick<
  OrchestrationV2ThreadShell,
  | "id"
  | "projectId"
  | "worktreePath"
  | "status"
  | "pendingRuntimeRequest"
  | "settledAt"
  | "settledOverride"
>;

const BUSY_STATUSES = new Set<StackUser["status"]>([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
]);

const normalizePath = (path: string) => path.trim().replace(/[\\/]+$/u, "");

const isSettled = (thread: StackUser) =>
  (thread.settledOverride === "settled" || thread.settledAt !== null) &&
  !BUSY_STATUSES.has(thread.status) &&
  thread.pendingRuntimeRequest === null;

/**
 * The running stack groups (a bundle, or one stack alone) whose every active thread on a member
 * worktree has settled, `threadId` among them when given. Protected stacks and the standing
 * `dev` and `main` deployments keep running.
 */
export function settledStackGroups(input: {
  readonly stacks: ReadonlyArray<AppStack>;
  readonly threads: ReadonlyArray<StackUser>;
  readonly workspaceRoots: ReadonlyMap<ProjectId, string>;
  readonly threadId?: ThreadId | undefined;
}): ReadonlyArray<ReadonlyArray<AppStack>> {
  const groups = Map.groupBy(input.stacks, (stack) =>
    stack.bundleId == null ? `stack:${stack.id}` : `bundle:${stack.bundleId}`,
  );
  return [...groups.values()].filter((members) => {
    if (members.every((stack) => stack.status === "stopped" || stack.status === "stopping"))
      return false;
    if (
      members.some(
        (stack) =>
          stack.protected === true || stack.branchName === "dev" || stack.branchName === "main",
      )
    )
      return false;
    const paths = new Set(members.map((stack) => normalizePath(stack.worktreePath)));
    const users = input.threads.filter((thread) => {
      const path = thread.worktreePath ?? input.workspaceRoots.get(thread.projectId);
      return path !== undefined && paths.has(normalizePath(path));
    });
    return (
      users.length > 0 &&
      users.every(isSettled) &&
      (input.threadId === undefined || users.some((thread) => thread.id === input.threadId))
    );
  });
}

/** Stops a settled thread's App Stacks to free the host, once nothing else uses them. */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projects = yield* ProjectStore.ProjectStoreV2;
    const manager = yield* AppStackManager;

    const readUsers = Effect.gen(function* () {
      const snapshot = yield* orchestrator.getShellSnapshot();
      const rows = yield* projects.list();
      return {
        threads: snapshot.threads,
        workspaceRoots: new Map(rows.map((row) => [row.projectId, row.workspaceRoot] as const)),
      };
    });

    const cleanup = Effect.fn("AppStackLifecycleReactor.cleanup")(function* (
      threadId: ThreadId | undefined,
    ) {
      if (!(yield* manager.status).enabled) return;
      const { stacks } = yield* manager.list({});
      const groups = settledStackGroups({ stacks, ...(yield* readUsers), threadId });
      for (const members of groups) {
        yield* Effect.gen(function* () {
          const current = yield* Effect.forEach(members, (stack) =>
            manager.get({ stackId: stack.id }),
          );
          // Controller reads take time; a thread resumed meanwhile keeps its stacks.
          const [still] = settledStackGroups({ stacks: current, ...(yield* readUsers), threadId });
          const running = still?.find(
            (stack) => stack.status !== "stopped" && stack.status !== "stopping",
          );
          // Stopping one member stops its whole bundle.
          if (running !== undefined) yield* manager.stop({ stackId: running.id });
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
    yield* forkParked(
      worker.enqueue(undefined).pipe(
        Effect.andThen(
          Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
            event.type === "thread.settled" ? worker.enqueue(event.threadId) : Effect.void,
          ),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("app stack settlement stream failed", { cause: Cause.pretty(cause) }),
        ),
      ),
    );
  }),
);
