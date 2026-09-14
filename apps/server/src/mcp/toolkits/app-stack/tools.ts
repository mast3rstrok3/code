import {
  AppStack,
  AppStackAutoCreateResult,
  AppStackByWorktreeResult,
  AppStackDeleteResult,
  AppStackDevicePlatform,
  AppStackDeviceStartInput,
  AppStackDeviceStopInput,
  AppStackDeviceLease,
  AppStackDeviceStatus,
  AppStackError,
  AppStackGetPodLogsInput,
  AppStackGetPodLogsResult,
  AppStackListPodsResult,
  AppStackVariant,
  IsoDateTime,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import { AppStackManager } from "../../../appStack/AppStackManager.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";

const dependencies = [McpInvocationContext, ProjectionSnapshotQuery, AppStackManager];
const WorkspaceInput = Schema.Struct({ variant: Schema.optionalKey(AppStackVariant) });
export type WorkspaceInput = typeof WorkspaceInput.Type;
const StartInput = Schema.Struct({
  ...WorkspaceInput.fields,
  displayName: Schema.optionalKey(TrimmedNonEmptyString),
});
export type StartInput = typeof StartInput.Type;
const PodLogsInput = Schema.Struct({
  ...WorkspaceInput.fields,
  podName: AppStackGetPodLogsInput.fields.podName,
  containerName: AppStackGetPodLogsInput.fields.containerName,
  tailLines: AppStackGetPodLogsInput.fields.tailLines,
});
export type PodLogsInput = typeof PodLogsInput.Type;

const DeviceInput = Schema.Struct({
  ...WorkspaceInput.fields,
  platform: AppStackDevicePlatform,
});
export type DeviceInput = typeof DeviceInput.Type;
const DeviceStopInput = Schema.Struct({
  ...DeviceInput.fields,
  leaseId: AppStackDeviceStopInput.fields.leaseId,
});
export type DeviceStopInput = typeof DeviceStopInput.Type;
const DeviceStartInput = Schema.Struct({
  ...DeviceStopInput.fields,
  ttlSeconds: AppStackDeviceStartInput.fields.ttlSeconds,
});
export type DeviceStartInput = typeof DeviceStartInput.Type;
const DeviceAccess = Schema.Struct({
  stackId: TrimmedNonEmptyString,
  namespace: TrimmedNonEmptyString,
  execPrefix: Schema.Array(Schema.String),
  podSelector: Schema.String,
  instructions: Schema.Array(Schema.String),
});

const AppStackDeviceStartTool = Tool.make("app_stack_device_start", {
  description:
    "Acquire or renew a cluster Android emulator or Windows VM for this thread's App Stack. Requires a running Stacks controller stack with androidEmulator or windowsVm in its compose contract. Generate a UUID leaseId before calling; reuse it for retries, renewal, and stop. Guests may queue for capacity. Poll app_stack_device_status at retryAfterSeconds until ready, and release with app_stack_device_stop after saving artifacts. Returns commands for the cluster's ADB or Windows runner; no host Android SDK or local VM is needed. Defaults to dev.",
  parameters: DeviceStartInput,
  success: Schema.Struct({ lease: AppStackDeviceLease, access: DeviceAccess }),
  failure: AppStackError,
  dependencies,
})
  .annotate(Tool.Title, "Lease this workspace's Android or Windows guest")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

const AppStackDeviceStatusTool = Tool.make("app_stack_device_status", {
  description:
    "Read this workspace's cluster device lease, queue position, readiness, and access commands. Android must be booted; Windows must be ready with its guest agent connected before running checks. Guest readiness does not verify the application. Resolves the stack from the authenticated thread; defaults to dev.",
  parameters: DeviceInput,
  success: Schema.Struct({
    lease: AppStackDeviceLease,
    readiness: AppStackDeviceStatus,
    access: DeviceAccess,
  }),
  failure: AppStackError,
  dependencies,
})
  .annotate(Tool.Title, "Check this workspace's cluster device")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const AppStackDeviceStopTool = Tool.make("app_stack_device_stop", {
  description:
    "Release this workspace's Android or Windows lease and delete its disposable guest. Supply the leaseId used for start; a different lease cannot be stopped. Save screenshots, logs, and other artifacts first. Keeps the app backend running. Defaults to dev.",
  parameters: DeviceStopInput,
  success: AppStackDeviceLease,
  failure: AppStackError,
  dependencies,
})
  .annotate(Tool.Title, "Release this workspace's cluster device")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

export const AppStackGetTool = Tool.make("app_stack_get", {
  description:
    "Read current App Stack status and service URLs for this thread's workspace. Defaults to the dev variant; request prod to inspect its production build. Resolves the workspace from the authenticated thread. Does not start, stop, or change a stack.",
  parameters: WorkspaceInput,
  success: Schema.Struct({
    ...AppStackByWorktreeResult.fields,
    worktreePath: TrimmedNonEmptyString,
    variant: AppStackVariant,
    enabled: Schema.Boolean,
    checkedAt: IsoDateTime,
  }),
  failure: AppStackError,
  dependencies,
})
  .annotate(Tool.Title, "Check this workspace's App Stack")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const AppStackStartTool = Tool.make("app_stack_start", {
  description:
    "Start or reuse this thread's workspace App Stack. Defaults to dev; prod must be explicit and needs a prod compose contract. Uses the workspace and branch from the authenticated thread. Preserves existing workflow ownership; new stacks are manually owned. Returns current status and URLs, which may not be ready yet; use app_stack_get to check readiness.",
  parameters: StartInput,
  success: AppStackAutoCreateResult,
  failure: AppStackError,
  dependencies,
})
  .annotate(Tool.Title, "Start this workspace's App Stack")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

const AppStackStopTool = Tool.make("app_stack_stop", {
  description:
    "Stop this thread's workspace App Stack, keeping its namespace for restart. Defaults to dev. Explicit stops also stop protected stacks. Resolves the stack from the authenticated thread; cannot target another workspace.",
  parameters: WorkspaceInput,
  success: AppStack,
  failure: AppStackError,
  dependencies,
})
  .annotate(Tool.Title, "Stop this workspace's App Stack")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

const AppStackRestartTool = Tool.make("app_stack_restart", {
  description:
    "Restart this thread's workspace App Stack using its existing configuration and workflow ownership. Defaults to dev. Interrupts running services, including protected stacks. Use app_stack_get afterwards to check readiness.",
  parameters: WorkspaceInput,
  success: AppStack,
  failure: AppStackError,
  dependencies,
})
  .annotate(Tool.Title, "Restart this workspace's App Stack")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

const AppStackDeleteTool = Tool.make("app_stack_delete", {
  description:
    "Delete this thread's workspace App Stack and its Kubernetes namespace, including resources and data stored in that namespace. Defaults to dev. Explicit deletion also deletes protected stacks. Use app_stack_stop instead when the namespace should be kept.",
  parameters: WorkspaceInput,
  success: AppStackDeleteResult,
  failure: AppStackError,
  dependencies,
})
  .annotate(Tool.Title, "Delete this workspace's App Stack")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

const AppStackListPodsTool = Tool.make("app_stack_list_pods", {
  description:
    "List pods, containers, readiness, and restart counts for this thread's workspace App Stack. Defaults to dev. Use the returned pod and container names with app_stack_logs.",
  parameters: WorkspaceInput,
  success: AppStackListPodsResult,
  failure: AppStackError,
  dependencies,
})
  .annotate(Tool.Title, "List this workspace's App Stack pods")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const AppStackLogsTool = Tool.make("app_stack_logs", {
  description:
    "Read recent logs from a pod in this thread's workspace App Stack. Defaults to dev and the last 200 lines; tailLines accepts 1 to 5000. Use app_stack_list_pods to find pod and container names. Cannot read another workspace's logs.",
  parameters: PodLogsInput,
  success: AppStackGetPodLogsResult,
  failure: AppStackError,
  dependencies,
})
  .annotate(Tool.Title, "Read this workspace's App Stack logs")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const AppStackToolkit = Toolkit.make(
  AppStackGetTool,
  AppStackStartTool,
  AppStackStopTool,
  AppStackRestartTool,
  AppStackDeleteTool,
  AppStackListPodsTool,
  AppStackLogsTool,
  AppStackDeviceStartTool,
  AppStackDeviceStatusTool,
  AppStackDeviceStopTool,
);
