import { AppStackError, type AppStack, type AppStackVariant } from "@t3tools/contracts";
import { appStackDisplayName, appStackVariantForComposePath } from "@t3tools/shared/appStack";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { AppStackManager } from "../../../appStack/AppStackManager.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import {
  AppStackToolkit,
  type PodLogsInput,
  type StartInput,
  type WorkspaceInput,
  type DeviceInput,
  type DeviceStartInput,
  type DeviceStopInput,
} from "./tools.ts";

const resolveWorkspace = Effect.fn("AppStackToolkit.resolveWorkspace")(function* (
  operation: string,
) {
  const scope = yield* McpInvocationContext;
  const query = yield* ProjectionSnapshotQuery;
  const workspace = yield* Effect.gen(function* () {
    const thread = yield* query.getThreadShellById(scope.threadId);
    if (Option.isNone(thread)) return undefined;
    const branch = thread.value.branch;
    if (thread.value.worktreePath?.trim()) {
      return { worktreePath: thread.value.worktreePath.trim(), branch };
    }
    const project = yield* query.getProjectShellById(thread.value.projectId);
    const worktreePath = Option.getOrUndefined(project)?.workspaceRoot.trim();
    return worktreePath ? { worktreePath, branch } : undefined;
  }).pipe(
    Effect.mapError(
      (cause) =>
        new AppStackError({
          operation,
          message: "Could not resolve this thread's workspace.",
          cause,
        }),
    ),
  );
  if (!workspace) {
    return yield* new AppStackError({
      operation,
      message: "This thread's workspace was not found.",
    });
  }
  return workspace;
});

// Controllers can return another variant from a worktree lookup. Check identity
// before passing its id to an operation that changes a stack or reads its logs.
const checkStackScope = Effect.fn("AppStackToolkit.checkStackScope")(function* (
  stack: AppStack | null,
  worktreePath: string,
  variant: AppStackVariant,
  operation: string,
) {
  const normalizePath = (path: string) => path.trim().replace(/[\\/]+$/u, "");
  if (
    stack &&
    (normalizePath(stack.worktreePath) !== normalizePath(worktreePath) ||
      (stack.variant ?? appStackVariantForComposePath(stack.composePath)) !== variant)
  ) {
    return yield* new AppStackError({
      operation,
      reason: "invalid_response",
      message:
        "The returned App Stack does not match this thread's workspace and requested variant.",
    });
  }
});

const lookupStack = Effect.fn("AppStackToolkit.lookupStack")(function* (
  worktreePath: string,
  variant: AppStackVariant,
  operation: string,
) {
  const manager = yield* AppStackManager;
  const result = yield* manager.getByWorktree({ worktreePath, variant }).pipe(
    Effect.timeout("5 seconds"),
    Effect.mapError(
      (cause) =>
        new AppStackError({
          operation,
          message: "Could not refresh this workspace's App Stack status.",
          cause,
        }),
    ),
  );
  yield* checkStackScope(result.stack, worktreePath, variant, operation);
  return result;
});

const requireEnabled = Effect.fn("AppStackToolkit.requireEnabled")(function* (operation: string) {
  const manager = yield* AppStackManager;
  if (!(yield* manager.status).enabled) {
    return yield* new AppStackError({
      operation,
      reason: "disabled",
      message: "App Stack integration is disabled.",
    });
  }
  return manager;
});

const requireStack = Effect.fn("AppStackToolkit.requireStack")(function* (
  input: WorkspaceInput,
  operation: string,
) {
  const workspace = yield* resolveWorkspace(operation);
  const manager = yield* requireEnabled(operation);
  const result = yield* lookupStack(workspace.worktreePath, input.variant ?? "dev", operation);
  if (!result.stack) {
    return yield* new AppStackError({
      operation,
      message:
        "No managed App Stack exists for this workspace and variant. Use app_stack_start to start one; standing deployments cannot be managed by these tools.",
    });
  }
  return { manager, stack: result.stack };
});

const deviceAccess = Effect.fn("AppStackToolkit.deviceAccess")(function* (
  stack: AppStack,
  platform: DeviceInput["platform"],
) {
  const manager = yield* AppStackManager;
  const namespace = stack.namespace ?? (yield* manager.listPods({ stackId: stack.id })).namespace;
  const deployment = platform === "android" ? "android-emulator" : "windows-runner";
  return {
    stackId: stack.id,
    namespace,
    execPrefix: [
      "kubectl",
      "-n",
      namespace,
      "exec",
      `deployment/${deployment}`,
      "--",
      platform === "android" ? "adb" : "windows",
    ],
    podSelector: `app=${deployment}`,
    instructions: [
      "Use these command arguments on the Code execution host with its configured KUBECONFIG. Scope every kubectl command to the returned namespace. Do not install a local emulator or VM.",
      "Wait for the lease to be running and the guest to be ready. Renew with the same leaseId before expiresAt. Save artifacts and release that lease in cleanup, including after a failed test.",
      "Transfer the exact worktree artifact, including uncommitted changes. The guest does not contain the worktree automatically. Use this App Stack's service URLs for the application backend.",
      ...(platform === "android"
        ? [
            "Append ADB arguments to execPrefix. Examples: shell getprop sys.boot_completed; shell input tap 100 200; shell am start -a android.intent.action.VIEW -d <url>; logcat -d -t 200. For screenshots append exec-out screencap -p and redirect stdout to a local PNG without allocating a TTY.",
            "Find the emulator pod with kubectl -n <namespace> get pods -l <podSelector>. Use kubectl cp to copy your APK into that pod, then append install -r /tmp/app.apk to execPrefix.",
          ]
        : [
            "Append runner arguments to execPrefix. Examples: exec 'node --version'; screenshot /tmp/desktop.png; desktop /tmp/test.ps1. The desktop command waits for an interactive PowerShell job and returns its exit code. Propagate native test failures with exit $LASTEXITCODE in the script.",
            "Find the runner pod with kubectl -n <namespace> get pods -l <podSelector>. Use kubectl cp to transfer artifacts to/from the runner. Append put /tmp/app.zip C:/Stacks/app.zip or get C:/Stacks/results.zip /tmp/results.zip to execPrefix for guest transfer. Build with Windows dependencies inside the guest. Copy screenshots and results out of the runner before release.",
          ]),
    ],
  };
});

export const handlers = {
  app_stack_device_start: Effect.fn("AppStackToolkit.deviceStart")(function* (
    input: DeviceStartInput,
  ) {
    const { manager, stack } = yield* requireStack(input, "app_stack_device_start");
    const access = yield* deviceAccess(stack, input.platform);
    const lease = yield* manager.startDevice({
      stackId: stack.id,
      platform: input.platform,
      leaseId: input.leaseId,
      ...(input.ttlSeconds === undefined ? {} : { ttlSeconds: input.ttlSeconds }),
    });
    return { lease, access };
  }),
  app_stack_device_status: Effect.fn("AppStackToolkit.deviceStatus")(function* (
    input: DeviceInput,
  ) {
    const { manager, stack } = yield* requireStack(input, "app_stack_device_status");
    const request = { stackId: stack.id, platform: input.platform };
    const lease = yield* manager.getDeviceLease(request);
    const readiness = yield* manager.getDeviceStatus(request);
    const access = yield* deviceAccess(stack, input.platform);
    return { lease, readiness, access };
  }),
  app_stack_device_stop: Effect.fn("AppStackToolkit.deviceStop")(function* (
    input: DeviceStopInput,
  ) {
    const { manager, stack } = yield* requireStack(input, "app_stack_device_stop");
    return yield* manager.stopDevice({
      stackId: stack.id,
      platform: input.platform,
      leaseId: input.leaseId,
    });
  }),
  app_stack_get: Effect.fn("AppStackToolkit.get")(function* (input: WorkspaceInput) {
    const workspace = yield* resolveWorkspace("app_stack_get");
    const manager = yield* AppStackManager;
    const variant = input.variant ?? "dev";
    const status = yield* manager.status;
    const result = status.enabled
      ? yield* lookupStack(workspace.worktreePath, variant, "app_stack_get")
      : { stack: null, frontendUrl: null, frontendServiceName: null };
    return {
      ...result,
      worktreePath: workspace.worktreePath,
      variant,
      enabled: status.enabled,
      checkedAt: DateTime.formatIso(yield* DateTime.now),
    };
  }),
  app_stack_start: Effect.fn("AppStackToolkit.start")(function* (input: StartInput) {
    const operation = "app_stack_start";
    const workspace = yield* resolveWorkspace(operation);
    const manager = yield* requireEnabled(operation);
    const variant = input.variant ?? "dev";
    const existing = yield* lookupStack(workspace.worktreePath, variant, operation);
    if (existing.stack) {
      if (existing.stack.status === "stopping") {
        return yield* new AppStackError({
          operation,
          message:
            "This App Stack is still stopping. Check app_stack_get before starting it again.",
        });
      }
      if (existing.stack.status === "stopped" || existing.stack.status === "error") {
        yield* manager.restart({ stackId: existing.stack.id });
        const result = yield* lookupStack(workspace.worktreePath, variant, operation);
        return { ...result, created: false, alreadyRunning: false };
      }
      return { ...existing, created: false, alreadyRunning: true };
    }
    const result = yield* manager.autoCreate({
      worktreePath: workspace.worktreePath,
      gitBranch: workspace.branch,
      displayName:
        input.displayName ?? appStackDisplayName(workspace.worktreePath, workspace.branch),
      variant,
    });
    yield* checkStackScope(result.stack, workspace.worktreePath, variant, operation);
    return result;
  }),
  app_stack_stop: Effect.fn("AppStackToolkit.stop")(function* (input: WorkspaceInput) {
    const { manager, stack } = yield* requireStack(input, "app_stack_stop");
    return yield* manager.stop({ stackId: stack.id });
  }),
  app_stack_restart: Effect.fn("AppStackToolkit.restart")(function* (input: WorkspaceInput) {
    const { manager, stack } = yield* requireStack(input, "app_stack_restart");
    return yield* manager.restart({ stackId: stack.id });
  }),
  app_stack_delete: Effect.fn("AppStackToolkit.delete")(function* (input: WorkspaceInput) {
    const { manager, stack } = yield* requireStack(input, "app_stack_delete");
    return yield* manager.delete({ stackId: stack.id });
  }),
  app_stack_list_pods: Effect.fn("AppStackToolkit.listPods")(function* (input: WorkspaceInput) {
    const { manager, stack } = yield* requireStack(input, "app_stack_list_pods");
    return yield* manager.listPods({ stackId: stack.id });
  }),
  app_stack_logs: Effect.fn("AppStackToolkit.logs")(function* (input: PodLogsInput) {
    const { manager, stack } = yield* requireStack(input, "app_stack_logs");
    return yield* manager.getPodLogs({
      stackId: stack.id,
      podName: input.podName,
      ...(input.containerName === undefined ? {} : { containerName: input.containerName }),
      tailLines: input.tailLines ?? 200,
    });
  }),
} satisfies Parameters<typeof AppStackToolkit.toLayer>[0];

export const AppStackToolkitHandlersLive = AppStackToolkit.toLayer(handlers);
