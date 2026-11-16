import { StackActions, useNavigation } from "@react-navigation/native";
import { displayStackName } from "@t3tools/client-runtime/app-stack-logs";
import {
  appStackBulkDeleteConfirmation,
  appStackBulkDeleteFailureMessage,
  appStackProtectionAction,
  appStackStartShape,
  autoCreateNotice,
  defaultAppStackBundleSelection,
  type AutoCreateNotice,
} from "@t3tools/client-runtime/app-stack-panel";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthEnvironmentMaintainScope,
  type AppStack,
  type AppStackBundlePlan,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import {
  appStackDisplayName,
  appStackVariantForComposePath,
  deriveAppStackNamespaceFromPath,
} from "@t3tools/shared/appStack";
import { useState } from "react";

import * as Dialog from "../../components/ui/Dialog";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { appStackEnvironment } from "../../state/appStacks";
import { previewEnvironment } from "../../state/preview";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";

export type AppStackPendingAction = "start" | "stop" | "restart" | "delete" | "protect";

const MANAGE_DENIED_MESSAGE = "This connection cannot manage App Stacks.";

function failureMessage(result: AtomCommandResult<unknown, unknown>): string | null {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return null;
  const error = squashAtomCommandFailure(result);
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "The App Stack action failed.";
}

/**
 * Lifecycle commands for one environment's App Stacks. Every mutation needs
 * the maintain scope; a connection without it sees the controls disabled
 * rather than a server rejection.
 */
export function useAppStackActions(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | null;
  readonly branch: string | null;
  readonly serverBrowser: boolean;
  readonly onChanged: () => void;
}) {
  const navigation = useNavigation();
  const canManage = useEnvironmentScope(input.environmentId, AuthEnvironmentMaintainScope);
  const [pending, setPending] = useState<ReadonlyMap<string, AppStackPendingAction>>(
    () => new Map(),
  );
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<AutoCreateNotice | null>(null);
  const autoCreate = useAtomCommand(appStackEnvironment.autoCreate, { reportFailure: false });
  const stop = useAtomCommand(appStackEnvironment.stop, { reportFailure: false });
  const restart = useAtomCommand(appStackEnvironment.restart, { reportFailure: false });
  const setProtected = useAtomCommand(appStackEnvironment.setProtected, { reportFailure: false });
  const deleteStack = useAtomCommand(appStackEnvironment.delete, { reportFailure: false });
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });

  const mark = (key: string, action: AppStackPendingAction | null) =>
    setPending((current) => {
      const next = new Map(current);
      if (action === null) next.delete(key);
      else next.set(key, action);
      return next;
    });

  const run = async <A, E>(
    key: string,
    action: AppStackPendingAction,
    execute: () => Promise<AtomCommandResult<A, E>>,
  ): Promise<AtomCommandResult<A, E> | null> => {
    if (!canManage) {
      setError(MANAGE_DENIED_MESSAGE);
      return null;
    }
    mark(key, action);
    setError(null);
    // Atom commands settle instead of throwing; finally() still clears the
    // pending mark if one ever rejects.
    const result = await execute().finally(() => mark(key, null));
    const message = failureMessage(result);
    if (message !== null) setError(message);
    if (result._tag === "Success") input.onChanged();
    return result;
  };

  /**
   * Starts a new stack for a worktree in the plan's default shape: every app
   * for a platform worktree, the worktree's own app otherwise. The web's
   * bundle checklist is not offered on mobile.
   */
  const startNew = async (worktreePath: string, plan: AppStackBundlePlan | null) => {
    const shape = appStackStartShape(plan, defaultAppStackBundleSelection(plan), {});
    if (shape === null) {
      setError("This platform worktree has no apps to start.");
      return;
    }
    setNotice(null);
    const result = await run(`create:${worktreePath}`, "start", () =>
      autoCreate({
        environmentId: input.environmentId,
        input: {
          worktreePath,
          displayName: appStackDisplayName(worktreePath, input.branch),
          gitBranch: input.branch,
          namespace: deriveAppStackNamespaceFromPath(worktreePath, "dev"),
          variant: "dev",
          ...(shape.bundle.length > 0 ? { bundle: [...shape.bundle] } : {}),
          ...(shape.omitServices === undefined ? {} : { omitServices: shape.omitServices }),
        },
      }),
    );
    if (result?._tag === "Success") setNotice(autoCreateNotice(result.value));
  };

  const start = async (stack: AppStack) => {
    // A stopped bundle starts again in its shape; a plain start would drop
    // the other apps and the services it left out.
    if (stack.bundleId != null && (stack.status === "stopped" || stack.status === "error")) {
      await run(stack.id, "start", () =>
        restart({ environmentId: input.environmentId, input: { stackId: stack.id } }),
      );
      return;
    }
    setNotice(null);
    const result = await run(stack.id, "start", () =>
      autoCreate({
        environmentId: input.environmentId,
        input: {
          worktreePath: stack.worktreePath,
          displayName: stack.displayName ?? appStackDisplayName(stack.worktreePath, input.branch),
          gitBranch: stack.branchName ?? input.branch,
          namespace: stack.namespace ?? null,
          workflowId: stack.workflowId ?? undefined,
          variant: stack.variant ?? appStackVariantForComposePath(stack.composePath),
        },
      }),
    );
    if (result?._tag === "Success") setNotice(autoCreateNotice(result.value));
  };

  const confirmStop = (stack: AppStack) =>
    Dialog.confirm({
      title: `Stop ${displayStackName(stack)}?`,
      message: "Its services shut down until you start the stack again.",
      confirmText: "Stop",
      destructive: true,
      onConfirm: () =>
        void run(stack.id, "stop", () =>
          stop({ environmentId: input.environmentId, input: { stackId: stack.id } }),
        ),
    });

  const restartStack = (stack: AppStack) =>
    void run(stack.id, "restart", () =>
      restart({ environmentId: input.environmentId, input: { stackId: stack.id } }),
    );

  const toggleProtection = (stack: AppStack) =>
    void run(stack.id, "protect", () =>
      setProtected({
        environmentId: input.environmentId,
        input: { stackId: stack.id, protected: appStackProtectionAction(stack).nextProtected },
      }),
    );

  const executeDelete = async (stack: AppStack): Promise<string | null> => {
    mark(stack.id, "delete");
    const result = await deleteStack({
      environmentId: input.environmentId,
      input: { stackId: stack.id },
    }).finally(() => mark(stack.id, null));
    if (result._tag === "Success") return null;
    return failureMessage(result) ?? "The delete action was interrupted.";
  };

  const confirmDelete = (stack: AppStack, onDeleted?: () => void) => {
    if (!canManage) {
      setError(MANAGE_DENIED_MESSAGE);
      return;
    }
    Dialog.confirm({
      title: `Delete ${displayStackName(stack)}?`,
      message: "This removes its Kubernetes namespace.",
      confirmText: "Delete",
      destructive: true,
      onConfirm: () => {
        setError(null);
        void executeDelete(stack).then((message) => {
          setError(message);
          input.onChanged();
          if (message === null) onDeleted?.();
        });
      },
    });
  };

  /** Resolves with the ids that failed, so the list keeps them selected. */
  const confirmBulkDelete = (
    stacks: ReadonlyArray<AppStack>,
    onDone: (failed: Set<string>) => void,
  ) => {
    if (stacks.length === 0) return;
    if (!canManage) {
      setError(MANAGE_DENIED_MESSAGE);
      return;
    }
    const [title = "", ...rest] = appStackBulkDeleteConfirmation(stacks.length).split("\n");
    Dialog.confirm({
      title,
      message: rest.join("\n"),
      confirmText: "Delete",
      destructive: true,
      onConfirm: () => {
        setError(null);
        void Promise.all(
          stacks.map(async (stack) => ({ stack, message: await executeDelete(stack) })),
        ).then((results) => {
          const failures = results.flatMap((result) =>
            result.message === null ? [] : [{ stack: result.stack, message: result.message }],
          );
          setError(appStackBulkDeleteFailureMessage(failures, stacks.length));
          input.onChanged();
          onDone(new Set(failures.map(({ stack }) => stack.id)));
        });
      },
    });
  };

  /**
   * Opens a stack URL in the thread's server browser when the environment has
   * one, so the preview runs next to the agent; otherwise in the system browser.
   */
  const openUrl = async (url: string) => {
    if (input.serverBrowser && input.threadId !== null) {
      const result = await openPreview({
        environmentId: input.environmentId,
        input: { threadId: input.threadId, url, runtime: "server" },
      });
      if (result._tag === "Success") {
        navigation.dispatch(
          StackActions.replace("ThreadBrowserPreview", {
            environmentId: input.environmentId,
            threadId: input.threadId,
            tabId: result.value.tabId,
          }),
        );
        return;
      }
    }
    if (!(await tryOpenExternalUrl(url, "app-stack"))) {
      Dialog.alert("Unable to open preview", "The preview URL could not be opened.");
    }
  };

  const openExternal = (url: string) =>
    void tryOpenExternalUrl(url, "app-stack").then((opened) => {
      if (!opened) Dialog.alert("Unable to open preview", "The preview URL could not be opened.");
    });

  return {
    canManage,
    pending,
    error,
    notice,
    dismissError: () => setError(null),
    dismissNotice: () => setNotice(null),
    startNew,
    start,
    confirmStop,
    restart: restartStack,
    toggleProtection,
    confirmDelete,
    confirmBulkDelete,
    openUrl,
    openExternal,
  };
}

export type AppStackActions = ReturnType<typeof useAppStackActions>;
