import { resolveCurrentStackPath } from "@t3tools/client-runtime/app-stack-logs";
import { isTransitioningAppStackStatus } from "@t3tools/client-runtime/app-stack-panel";
import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback, useEffect } from "react";
import { AppState } from "react-native";

import { appStackEnvironment } from "../../state/appStacks";
import { useEnvironmentQuery } from "../../state/query";

const TRANSITION_POLL_INTERVAL_MS = 2_500;

/**
 * Refreshes when the app returns to the foreground, and polls only while a
 * stack is transitioning. An idle stack is never polled.
 */
export function useAppStackRefresh(refresh: () => void, poll: boolean) {
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") refresh();
    });
    return () => subscription.remove();
  }, [refresh]);
  useEffect(() => {
    if (!poll) return;
    const interval = setInterval(() => {
      if (AppState.currentState === "active") refresh();
    }, TRANSITION_POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [poll, refresh]);
}

/** The path the web panel resolves for a thread, so both clients act on the same stack. */
export function threadAppStackPath(input: {
  readonly worktreePath: string | null | undefined;
  readonly workspaceRoot: string | null | undefined;
}): string | null {
  return resolveCurrentStackPath({
    activeThreadWorktreePath: input.worktreePath,
    workspaceRoot: input.workspaceRoot,
    gitCwd: null,
  });
}

export function useAppStackBackend(environmentId: EnvironmentId | null) {
  const status = useEnvironmentQuery(
    environmentId === null ? null : appStackEnvironment.status({ environmentId, input: {} }),
  );
  return { ...status, enabled: status.data?.enabled === true };
}

export function useAppStackForWorktree(input: {
  readonly environmentId: EnvironmentId | null;
  readonly worktreePath: string | null;
  readonly enabled: boolean;
}) {
  return useEnvironmentQuery(
    input.enabled && input.environmentId !== null && input.worktreePath !== null
      ? appStackEnvironment.byWorktree({
          environmentId: input.environmentId,
          input: { worktreePath: input.worktreePath },
        })
      : null,
  );
}

/**
 * The thread's stack for the floating chip and the Git sheet row. Both stay
 * hidden until the environment reports App Stacks as enabled.
 */
export function useThreadAppStack(input: {
  readonly environmentId: EnvironmentId | null;
  readonly worktreePath: string | null;
}) {
  const backend = useAppStackBackend(input.environmentId);
  const lookup = useAppStackForWorktree({ ...input, enabled: backend.enabled });
  const stack = lookup.data?.stack ?? null;
  const refreshBackend = backend.refresh;
  const refreshLookup = lookup.refresh;
  const refresh = useCallback(() => {
    refreshBackend();
    refreshLookup();
  }, [refreshBackend, refreshLookup]);
  useAppStackRefresh(refresh, stack !== null && isTransitioningAppStackStatus(stack.status));
  return { enabled: backend.enabled, stack, lookup };
}
