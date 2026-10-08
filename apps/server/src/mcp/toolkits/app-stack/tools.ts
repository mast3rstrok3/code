import { OrchestratorMcpFailure } from "@t3tools/contracts";
import { ThreadManagementService } from "../../../orchestration-v2/ThreadManagementService.ts";
import {
  AppStack,
  AppStackAppName,
  AppStackAutoCreateResult,
  AppStackBundlePlan,
  AppStackBundleSelection,
  AppStackByWorktreeResult,
  AppStackCreateBundleWorktreesResult,
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
  AppStackOmittedServices,
  AppStackVariant,
  IsoDateTime,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import { AppStackManager } from "../../../appStack/AppStackManager.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";

const dependencies = [
  ThreadManagementService,
  McpInvocationContext,
  ProjectionSnapshotQuery,
  AppStackManager,
];
const WorkspaceInput = Schema.Struct({ variant: Schema.optionalKey(AppStackVariant) });
export type WorkspaceInput = typeof WorkspaceInput.Type;
const StartInput = Schema.Struct({
  ...WorkspaceInput.fields,
  displayName: Schema.optionalKey(TrimmedNonEmptyString),
  bundle: Schema.optionalKey(AppStackBundleSelection),
  omitServices: Schema.optionalKey(AppStackOmittedServices),
});
export type StartInput = typeof StartInput.Type;
const CreateWorktreesInput = Schema.Struct({
  ...WorkspaceInput.fields,
  bundle: Schema.optionalKey(AppStackBundleSelection),
});
export type CreateWorktreesInput = typeof CreateWorktreesInput.Type;
// A platform workspace's stack runs no pods; its apps do, so pod tools name one.
const MemberInput = Schema.Struct({
  ...WorkspaceInput.fields,
  app: Schema.optionalKey(AppStackAppName),
});
export type MemberInput = typeof MemberInput.Type;
const PodLogsInput = Schema.Struct({
  ...MemberInput.fields,
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
  failure: Schema.Union([AppStackError, OrchestratorMcpFailure]),
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
  failure: Schema.Union([AppStackError, OrchestratorMcpFailure]),
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
  failure: Schema.Union([AppStackError, OrchestratorMcpFailure]),
  dependencies,
})
  .annotate(Tool.Title, "Release this workspace's cluster device")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

const AppStackGetTool = Tool.make("app_stack_get", {
  description:
    "Read current App Stack status and service URLs for this thread's workspace. Defaults to the dev variant; request prod to inspect its production build. Resolves the workspace from the authenticated thread. A bundled stack also returns bundle, every stack of the bundle with its status and URLs. A platform workspace (healthcare-infra) has a stack with platform: true that runs no pods; its apps, their namespaces and URLs are in bundle. Does not start, stop, or change a stack.",
  parameters: WorkspaceInput,
  success: Schema.Struct({
    ...AppStackByWorktreeResult.fields,
    bundle: Schema.NullOr(Schema.Array(AppStack)),
    worktreePath: TrimmedNonEmptyString,
    variant: AppStackVariant,
    enabled: Schema.Boolean,
    checkedAt: IsoDateTime,
  }),
  failure: Schema.Union([AppStackError, OrchestratorMcpFailure]),
  dependencies,
})
  .annotate(Tool.Title, "Check this workspace's App Stack")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const AppStackStartTool = Tool.make("app_stack_start", {
  description:
    'Start or reuse this thread\'s workspace App Stack. Defaults to dev; prod must be explicit and needs a prod compose contract. Uses the workspace and branch from the authenticated thread. Preserves existing workflow ownership; new stacks are manually owned. Pass bundle, a list of other platform apps such as ["cortex", "medical-repository"] or "all", to run those apps from their worktrees on the same branch next to this one; missing worktrees are created from origin where app_stack_bundle_plan shows, and every app left out keeps using its standing dev copy. From a platform workspace (healthcare-infra) the stack always runs apps from this branch: every app by default, or the bundle list; its stack record runs no pods and stop, restart and delete act on all of its apps. Pass omitServices, such as {"rudi": ["codex-runner"]}, to leave compose services of this app or a bundled one out; services that depend on them start without them. With either set, a running stack of this workspace that bundles or omits differently is replaced. app_stack_bundle_plan lists the app and service names. Returns current status and URLs, which may not be ready yet; use app_stack_get to check readiness.',
  parameters: StartInput,
  success: AppStackAutoCreateResult,
  failure: Schema.Union([AppStackError, OrchestratorMcpFailure]),
  dependencies,
})
  .annotate(Tool.Title, "Start this workspace's App Stack")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

const AppStackBundlePlanTool = Tool.make("app_stack_bundle_plan", {
  description:
    "List the platform apps this workspace's App Stack can bundle, with each app's compose services and the worktree on this branch that would run it (found: false means app_stack_start or app_stack_create_worktrees would create it there). The first member is this workspace's own app. For a platform workspace (healthcare-infra) the plan has platform: true and app: null, and every member is an app it starts. Defaults to dev. Changes nothing. Use the names for app_stack_start's bundle and omitServices, or for a ticket's appStack.",
  parameters: WorkspaceInput,
  success: AppStackBundlePlan,
  failure: Schema.Union([AppStackError, OrchestratorMcpFailure]),
  dependencies,
})
  .annotate(Tool.Title, "Plan this workspace's App Stack bundle")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const AppStackCreateWorktreesTool = Tool.make("app_stack_create_worktrees", {
  description:
    "Create the worktrees app_stack_bundle_plan reports as missing (found: false), on this thread's branch and at the paths the plan gives, without starting any pods. From a platform workspace (healthcare-infra) this puts every chosen repository's worktree in the feature folder next to this one, so an agent can work across them. Pass bundle, \"all\" (the default) or a list of apps. A branch already on origin is tracked; otherwise it starts from the plan's base branch. Returns the plan and the created worktrees; existing worktrees are left alone.",
  parameters: CreateWorktreesInput,
  success: AppStackCreateBundleWorktreesResult,
  failure: Schema.Union([AppStackError, OrchestratorMcpFailure]),
  dependencies,
})
  .annotate(Tool.Title, "Create this branch's worktrees for other platform apps")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

const AppStackStopTool = Tool.make("app_stack_stop", {
  description:
    "Stop this thread's workspace App Stack, keeping its namespace for restart. Defaults to dev. Explicit stops also stop protected stacks. A bundled stack stops with every stack of its bundle. Resolves the stack from the authenticated thread; cannot target another workspace.",
  parameters: WorkspaceInput,
  success: AppStack,
  failure: Schema.Union([AppStackError, OrchestratorMcpFailure]),
  dependencies,
})
  .annotate(Tool.Title, "Stop this workspace's App Stack")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

const AppStackRestartTool = Tool.make("app_stack_restart", {
  description:
    "Restart this thread's workspace App Stack using its existing configuration and workflow ownership. Defaults to dev. Interrupts running services, including protected stacks. A bundle restarts whole, with the same apps and left-out services; a platform bundle always restarts from its platform record. Use app_stack_get afterwards to check readiness.",
  parameters: WorkspaceInput,
  success: AppStack,
  failure: Schema.Union([AppStackError, OrchestratorMcpFailure]),
  dependencies,
})
  .annotate(Tool.Title, "Restart this workspace's App Stack")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

const AppStackDeleteTool = Tool.make("app_stack_delete", {
  description:
    "Delete this thread's workspace App Stack and its Kubernetes namespace, including resources and data stored in that namespace. Defaults to dev. Explicit deletion also deletes protected stacks. A bundled stack is deleted with every stack of its bundle. Use app_stack_stop instead when the namespace should be kept.",
  parameters: WorkspaceInput,
  success: AppStackDeleteResult,
  failure: Schema.Union([AppStackError, OrchestratorMcpFailure]),
  dependencies,
})
  .annotate(Tool.Title, "Delete this workspace's App Stack")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

const AppStackListPodsTool = Tool.make("app_stack_list_pods", {
  description:
    "List pods, containers, readiness, and restart counts for this thread's workspace App Stack. Defaults to dev. Pass app to read another app of this stack's bundle; a platform workspace's stack runs no pods, so it needs app. Use the returned pod and container names with app_stack_logs, passing the same app.",
  parameters: MemberInput,
  success: AppStackListPodsResult,
  failure: Schema.Union([AppStackError, OrchestratorMcpFailure]),
  dependencies,
})
  .annotate(Tool.Title, "List this workspace's App Stack pods")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const AppStackLogsTool = Tool.make("app_stack_logs", {
  description:
    "Read recent logs from a pod in this thread's workspace App Stack. Defaults to dev and the last 200 lines; tailLines accepts 1 to 5000. Pass app to read another app of this stack's bundle, which a platform workspace needs. Use app_stack_list_pods to find pod and container names. Cannot read another workspace's logs.",
  parameters: PodLogsInput,
  success: AppStackGetPodLogsResult,
  failure: Schema.Union([AppStackError, OrchestratorMcpFailure]),
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
  AppStackBundlePlanTool,
  AppStackCreateWorktreesTool,
  AppStackStopTool,
  AppStackRestartTool,
  AppStackDeleteTool,
  AppStackListPodsTool,
  AppStackLogsTool,
  AppStackDeviceStartTool,
  AppStackDeviceStatusTool,
  AppStackDeviceStopTool,
);
