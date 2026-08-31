import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  PortSchema,
  PositiveInt,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

const NullableString = Schema.NullOr(Schema.String);
const NullableTrimmedNonEmptyString = Schema.NullOr(TrimmedNonEmptyString);

export const AppStackStatus = Schema.Literals([
  "pending",
  "starting",
  "running",
  "stopping",
  "stopped",
  "error",
]);
export type AppStackStatus = typeof AppStackStatus.Type;

/**
 * Which compose contract a stack runs. `dev` is the hot-reload contract
 * (`compose.app-dev.yml`); `prod` is the production build
 * (`compose.app-prod.yml`). A worktree can have one stack of each.
 */
export const AppStackVariant = Schema.Literals(["dev", "prod"]);
export type AppStackVariant = typeof AppStackVariant.Type;

export const AppStackService = Schema.Struct({
  name: TrimmedNonEmptyString,
  status: TrimmedNonEmptyString,
  containerPort: Schema.optionalKey(Schema.NullOr(PortSchema)),
  health: Schema.optionalKey(NullableTrimmedNonEmptyString),
  error: Schema.optionalKey(NullableString),
  previewUrl: Schema.optionalKey(NullableTrimmedNonEmptyString),
});
export type AppStackService = typeof AppStackService.Type;

export const AppStackOwner = Schema.Struct({
  id: Schema.optionalKey(NullableTrimmedNonEmptyString),
  userId: Schema.optionalKey(NullableTrimmedNonEmptyString),
  label: Schema.optionalKey(NullableString),
  displayName: Schema.optionalKey(NullableString),
  username: Schema.optionalKey(NullableString),
  email: Schema.optionalKey(NullableString),
});
export type AppStackOwner = typeof AppStackOwner.Type;

export const AppStackPreviewUrls = Schema.Record(TrimmedNonEmptyString, TrimmedNonEmptyString);
export type AppStackPreviewUrls = typeof AppStackPreviewUrls.Type;

export const AppStack = Schema.Struct({
  id: TrimmedNonEmptyString,
  uuid: TrimmedNonEmptyString,
  userId: TrimmedNonEmptyString,
  user: Schema.optionalKey(Schema.NullOr(AppStackOwner)),
  owner: Schema.optionalKey(Schema.NullOr(AppStackOwner)),
  userLabel: Schema.optionalKey(NullableString),
  userDisplayName: Schema.optionalKey(NullableString),
  userUsername: Schema.optionalKey(NullableString),
  userEmail: Schema.optionalKey(NullableString),
  ownerLabel: Schema.optionalKey(NullableString),
  ownerDisplayName: Schema.optionalKey(NullableString),
  ownerUsername: Schema.optionalKey(NullableString),
  ownerEmail: Schema.optionalKey(NullableString),
  worktreePath: TrimmedNonEmptyString,
  composePath: TrimmedNonEmptyString,
  // Servers derive this from composePath; older servers omit it.
  variant: Schema.optionalKey(AppStackVariant),
  displayName: NullableString,
  displaySlug: Schema.optionalKey(NullableString),
  description: NullableString,
  repoName: Schema.optionalKey(NullableString),
  branchName: Schema.optionalKey(NullableString),
  workflowId: Schema.optionalKey(NullableTrimmedNonEmptyString),
  status: AppStackStatus,
  namespace: Schema.optionalKey(NullableTrimmedNonEmptyString),
  services: Schema.NullOr(Schema.Array(AppStackService)),
  serviceCount: NonNegativeInt,
  selectedServices: Schema.optionalKey(Schema.NullOr(Schema.Array(TrimmedNonEmptyString))),
  lastError: NullableString,
  errorCount: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  lastStartedAt: Schema.optionalKey(Schema.NullOr(IsoDateTime)),
  lastStoppedAt: Schema.optionalKey(Schema.NullOr(IsoDateTime)),
  previewUrls: Schema.optionalKey(Schema.NullOr(AppStackPreviewUrls)),
  // Protected stacks survive workflow teardown and are the last thing the
  // environment sheds under memory pressure. Older servers omit the field.
  protected: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
});
export type AppStack = typeof AppStack.Type;

export const AppStackBackendStatus = Schema.Struct({
  enabled: Schema.Boolean,
  backendUrl: Schema.NullOr(TrimmedNonEmptyString),
});
export type AppStackBackendStatus = typeof AppStackBackendStatus.Type;

export const AppStackListInput = Schema.Struct({
  userId: Schema.optional(NullableTrimmedNonEmptyString),
});
export type AppStackListInput = typeof AppStackListInput.Type;

export const AppStackListResult = Schema.Struct({
  stacks: Schema.Array(AppStack),
  workflowConflicts: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        kind: Schema.optionalKey(Schema.Literals(["duplicate-worktree", "ownership-mismatch"])),
        workflowId: TrimmedNonEmptyString,
        stackIds: Schema.Array(TrimmedNonEmptyString),
        runIds: Schema.Array(TrimmedNonEmptyString),
        worktreePaths: Schema.Array(TrimmedNonEmptyString),
      }),
    ),
  ),
});
export type AppStackListResult = typeof AppStackListResult.Type;

export const AppStackByWorktreeInput = Schema.Struct({
  worktreePath: TrimmedNonEmptyString,
  // Defaults to dev.
  variant: Schema.optional(AppStackVariant),
});
export type AppStackByWorktreeInput = typeof AppStackByWorktreeInput.Type;

export const AppStackByWorktreeResult = Schema.Struct({
  stack: Schema.NullOr(AppStack),
  frontendUrl: Schema.NullOr(TrimmedNonEmptyString),
  frontendServiceName: Schema.NullOr(TrimmedNonEmptyString),
});
export type AppStackByWorktreeResult = typeof AppStackByWorktreeResult.Type;

export const AppStackGetInput = Schema.Struct({
  stackId: TrimmedNonEmptyString,
});
export type AppStackGetInput = typeof AppStackGetInput.Type;

export const AppStackSetProtectedInput = Schema.Struct({
  stackId: TrimmedNonEmptyString,
  protected: Schema.Boolean,
});
export type AppStackSetProtectedInput = typeof AppStackSetProtectedInput.Type;

export const AppStackWorkflowTeardownInput = Schema.Struct({
  workflowId: TrimmedNonEmptyString,
});
export type AppStackWorkflowTeardownInput = typeof AppStackWorkflowTeardownInput.Type;

export const AppStackWorkflowTeardownResult = Schema.Struct({
  stoppedStackIds: Schema.Array(TrimmedNonEmptyString),
  skippedProtectedStackIds: Schema.Array(TrimmedNonEmptyString),
  failedStackIds: Schema.Array(TrimmedNonEmptyString),
});
export type AppStackWorkflowTeardownResult = typeof AppStackWorkflowTeardownResult.Type;

export const AppStackAutoCreateInput = Schema.Struct({
  worktreePath: TrimmedNonEmptyString,
  displayName: TrimmedNonEmptyString,
  gitBranch: Schema.optional(NullableTrimmedNonEmptyString),
  namespace: Schema.optional(NullableTrimmedNonEmptyString),
  workflowId: Schema.optional(NullableTrimmedNonEmptyString),
  // Defaults to dev. Nothing picks prod on the caller's behalf: workflows
  // never set it, and the panel asks for it explicitly.
  variant: Schema.optional(AppStackVariant),
});
export type AppStackAutoCreateInput = typeof AppStackAutoCreateInput.Type;

export const AppStackAutoCreateResult = Schema.Struct({
  // Null only for reserved branches, which are served by a standing
  // deployment (frontendUrl) instead of a per-worktree stack.
  stack: Schema.NullOr(AppStack),
  created: Schema.Boolean,
  alreadyRunning: Schema.optional(Schema.Boolean),
  reserved: Schema.optional(Schema.Boolean),
  message: Schema.optional(Schema.NullOr(Schema.String)),
  frontendUrl: Schema.NullOr(TrimmedNonEmptyString),
  frontendServiceName: Schema.NullOr(TrimmedNonEmptyString),
});
export type AppStackAutoCreateResult = typeof AppStackAutoCreateResult.Type;

export const AppStackDeleteResult = Schema.Struct({
  deleted: Schema.Literal(true),
});
export type AppStackDeleteResult = typeof AppStackDeleteResult.Type;

export const AppStackPodContainer = Schema.Struct({
  name: TrimmedNonEmptyString,
  ready: Schema.Boolean,
  restartCount: NonNegativeInt,
  state: Schema.NullOr(TrimmedNonEmptyString),
});
export type AppStackPodContainer = typeof AppStackPodContainer.Type;

export const AppStackPod = Schema.Struct({
  name: TrimmedNonEmptyString,
  phase: TrimmedNonEmptyString,
  readyContainerCount: NonNegativeInt,
  totalContainerCount: NonNegativeInt,
  restartCount: NonNegativeInt,
  createdAt: Schema.optionalKey(Schema.NullOr(IsoDateTime)),
  nodeName: Schema.optionalKey(NullableTrimmedNonEmptyString),
  ownerKind: Schema.optionalKey(NullableTrimmedNonEmptyString),
  ownerName: Schema.optionalKey(NullableTrimmedNonEmptyString),
  previewUrl: Schema.optionalKey(NullableTrimmedNonEmptyString),
  previewServiceName: Schema.optionalKey(NullableTrimmedNonEmptyString),
  containers: Schema.Array(AppStackPodContainer),
});
export type AppStackPod = typeof AppStackPod.Type;

export const AppStackListPodsInput = Schema.Struct({
  stackId: TrimmedNonEmptyString,
});
export type AppStackListPodsInput = typeof AppStackListPodsInput.Type;

export const AppStackListPodsResult = Schema.Struct({
  stackId: TrimmedNonEmptyString,
  namespace: TrimmedNonEmptyString,
  pods: Schema.Array(AppStackPod),
});
export type AppStackListPodsResult = typeof AppStackListPodsResult.Type;

export const AppStackPodLogTailLines = PositiveInt.check(Schema.isLessThanOrEqualTo(5_000));
export type AppStackPodLogTailLines = typeof AppStackPodLogTailLines.Type;

export const AppStackLogReadLimit = Schema.Union([
  Schema.Struct({
    mode: Schema.Literal("tail"),
    tailLines: Schema.optional(
      PositiveInt.check(Schema.isGreaterThanOrEqualTo(100)).check(
        Schema.isLessThanOrEqualTo(5_000),
      ),
    ),
  }),
  Schema.Struct({
    mode: Schema.Literal("all"),
  }),
]);
export type AppStackLogReadLimit = typeof AppStackLogReadLimit.Type;

export const AppStackGetPodLogsInput = Schema.Struct({
  stackId: TrimmedNonEmptyString,
  podName: TrimmedNonEmptyString,
  containerName: Schema.optional(NullableTrimmedNonEmptyString),
  tailLines: Schema.optional(AppStackPodLogTailLines),
});
export type AppStackGetPodLogsInput = typeof AppStackGetPodLogsInput.Type;

export const AppStackGetPodLogsResult = Schema.Struct({
  stackId: TrimmedNonEmptyString,
  namespace: TrimmedNonEmptyString,
  podName: TrimmedNonEmptyString,
  containerName: Schema.NullOr(TrimmedNonEmptyString),
  tailLines: AppStackPodLogTailLines,
  logs: Schema.String,
  fetchedAt: IsoDateTime,
});
export type AppStackGetPodLogsResult = typeof AppStackGetPodLogsResult.Type;

export const AppStackPodLogEntry = Schema.Struct({
  podName: TrimmedNonEmptyString,
  containerName: TrimmedNonEmptyString,
  phase: TrimmedNonEmptyString,
  ready: Schema.Boolean,
  restartCount: NonNegativeInt,
  state: Schema.NullOr(TrimmedNonEmptyString),
  ownerKind: Schema.NullOr(TrimmedNonEmptyString),
  ownerName: Schema.NullOr(TrimmedNonEmptyString),
  logs: Schema.String,
  error: Schema.NullOr(TrimmedNonEmptyString),
  fetchedAt: IsoDateTime,
});
export type AppStackPodLogEntry = typeof AppStackPodLogEntry.Type;

export const AppStackGetStackPodLogsInput = Schema.Struct({
  stackId: TrimmedNonEmptyString,
  tailLines: Schema.optional(AppStackPodLogTailLines),
});
export type AppStackGetStackPodLogsInput = typeof AppStackGetStackPodLogsInput.Type;

export const AppStackGetStackPodLogsResult = Schema.Struct({
  stackId: TrimmedNonEmptyString,
  namespace: TrimmedNonEmptyString,
  tailLines: AppStackPodLogTailLines,
  pods: Schema.Array(AppStackPod),
  entries: Schema.Array(AppStackPodLogEntry),
  fetchedAt: IsoDateTime,
});
export type AppStackGetStackPodLogsResult = typeof AppStackGetStackPodLogsResult.Type;

export const AppStackDiscoveredStackPodLogs = Schema.Struct({
  stackId: TrimmedNonEmptyString,
  namespace: TrimmedNonEmptyString,
  displayName: Schema.optionalKey(NullableString),
  displaySlug: Schema.optionalKey(NullableString),
  repoName: Schema.optionalKey(NullableString),
  branchName: Schema.optionalKey(NullableString),
  worktreePath: Schema.optionalKey(NullableString),
  managedBy: Schema.optionalKey(NullableTrimmedNonEmptyString),
  limit: AppStackLogReadLimit,
  pods: Schema.Array(AppStackPod),
  entries: Schema.Array(AppStackPodLogEntry),
  error: Schema.NullOr(TrimmedNonEmptyString),
  fetchedAt: IsoDateTime,
});
export type AppStackDiscoveredStackPodLogs = typeof AppStackDiscoveredStackPodLogs.Type;

export const AppStackGetAllStackPodLogsInput = Schema.Struct({
  limit: Schema.optional(AppStackLogReadLimit),
});
export type AppStackGetAllStackPodLogsInput = typeof AppStackGetAllStackPodLogsInput.Type;

export const AppStackGetAllStackPodLogsResult = Schema.Struct({
  limit: AppStackLogReadLimit,
  stacks: Schema.Array(AppStackDiscoveredStackPodLogs),
  fetchedAt: IsoDateTime,
});
export type AppStackGetAllStackPodLogsResult = typeof AppStackGetAllStackPodLogsResult.Type;

export class AppStackError extends Schema.TaggedErrorClass<AppStackError>()("AppStackError", {
  operation: TrimmedNonEmptyString,
  reason: Schema.optional(Schema.Literals(["disabled", "request_failed", "invalid_response"])),
  status: Schema.optional(NonNegativeInt),
  message: TrimmedNonEmptyString,
  cause: Schema.optional(Schema.Defect()),
}) {}
