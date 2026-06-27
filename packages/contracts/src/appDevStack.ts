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

export const AppDevStackStatus = Schema.Literals([
  "pending",
  "starting",
  "running",
  "stopping",
  "stopped",
  "error",
]);
export type AppDevStackStatus = typeof AppDevStackStatus.Type;

export const AppDevStackService = Schema.Struct({
  name: TrimmedNonEmptyString,
  status: TrimmedNonEmptyString,
  containerPort: Schema.optionalKey(Schema.NullOr(PortSchema)),
  health: Schema.optionalKey(NullableTrimmedNonEmptyString),
  error: Schema.optionalKey(NullableString),
  previewUrl: Schema.optionalKey(NullableTrimmedNonEmptyString),
});
export type AppDevStackService = typeof AppDevStackService.Type;

export const AppDevStackOwner = Schema.Struct({
  id: Schema.optionalKey(NullableTrimmedNonEmptyString),
  userId: Schema.optionalKey(NullableTrimmedNonEmptyString),
  label: Schema.optionalKey(NullableString),
  displayName: Schema.optionalKey(NullableString),
  username: Schema.optionalKey(NullableString),
  email: Schema.optionalKey(NullableString),
});
export type AppDevStackOwner = typeof AppDevStackOwner.Type;

export const AppDevStackPreviewUrls = Schema.Record(TrimmedNonEmptyString, TrimmedNonEmptyString);
export type AppDevStackPreviewUrls = typeof AppDevStackPreviewUrls.Type;

export const AppDevStack = Schema.Struct({
  id: TrimmedNonEmptyString,
  uuid: TrimmedNonEmptyString,
  userId: TrimmedNonEmptyString,
  user: Schema.optionalKey(Schema.NullOr(AppDevStackOwner)),
  owner: Schema.optionalKey(Schema.NullOr(AppDevStackOwner)),
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
  displayName: NullableString,
  displaySlug: Schema.optionalKey(NullableString),
  description: NullableString,
  repoName: Schema.optionalKey(NullableString),
  branchName: Schema.optionalKey(NullableString),
  status: AppDevStackStatus,
  namespace: Schema.optionalKey(NullableTrimmedNonEmptyString),
  services: Schema.NullOr(Schema.Array(AppDevStackService)),
  serviceCount: NonNegativeInt,
  selectedServices: Schema.optionalKey(Schema.NullOr(Schema.Array(TrimmedNonEmptyString))),
  lastError: NullableString,
  errorCount: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  lastStartedAt: Schema.optionalKey(Schema.NullOr(IsoDateTime)),
  lastStoppedAt: Schema.optionalKey(Schema.NullOr(IsoDateTime)),
  previewUrls: Schema.optionalKey(Schema.NullOr(AppDevStackPreviewUrls)),
});
export type AppDevStack = typeof AppDevStack.Type;

export const AppDevStackBackendStatus = Schema.Struct({
  enabled: Schema.Boolean,
  backendUrl: Schema.NullOr(TrimmedNonEmptyString),
});
export type AppDevStackBackendStatus = typeof AppDevStackBackendStatus.Type;

export const AppDevStackListInput = Schema.Struct({
  userId: Schema.optional(NullableTrimmedNonEmptyString),
});
export type AppDevStackListInput = typeof AppDevStackListInput.Type;

export const AppDevStackListResult = Schema.Struct({
  stacks: Schema.Array(AppDevStack),
});
export type AppDevStackListResult = typeof AppDevStackListResult.Type;

export const AppDevStackByWorktreeInput = Schema.Struct({
  worktreePath: TrimmedNonEmptyString,
});
export type AppDevStackByWorktreeInput = typeof AppDevStackByWorktreeInput.Type;

export const AppDevStackByWorktreeResult = Schema.Struct({
  stack: Schema.NullOr(AppDevStack),
  frontendUrl: Schema.NullOr(TrimmedNonEmptyString),
  frontendServiceName: Schema.NullOr(TrimmedNonEmptyString),
});
export type AppDevStackByWorktreeResult = typeof AppDevStackByWorktreeResult.Type;

export const AppDevStackGetInput = Schema.Struct({
  stackId: TrimmedNonEmptyString,
});
export type AppDevStackGetInput = typeof AppDevStackGetInput.Type;

export const AppDevStackAutoCreateInput = Schema.Struct({
  worktreePath: TrimmedNonEmptyString,
  displayName: TrimmedNonEmptyString,
  gitBranch: Schema.optional(NullableTrimmedNonEmptyString),
});
export type AppDevStackAutoCreateInput = typeof AppDevStackAutoCreateInput.Type;

export const AppDevStackAutoCreateResult = Schema.Struct({
  stack: AppDevStack,
  created: Schema.Boolean,
  frontendUrl: Schema.NullOr(TrimmedNonEmptyString),
  frontendServiceName: Schema.NullOr(TrimmedNonEmptyString),
});
export type AppDevStackAutoCreateResult = typeof AppDevStackAutoCreateResult.Type;

export const AppDevStackDeleteResult = Schema.Struct({
  deleted: Schema.Literal(true),
});
export type AppDevStackDeleteResult = typeof AppDevStackDeleteResult.Type;

export const AppDevStackPodContainer = Schema.Struct({
  name: TrimmedNonEmptyString,
  ready: Schema.Boolean,
  restartCount: NonNegativeInt,
  state: Schema.NullOr(TrimmedNonEmptyString),
});
export type AppDevStackPodContainer = typeof AppDevStackPodContainer.Type;

export const AppDevStackPod = Schema.Struct({
  name: TrimmedNonEmptyString,
  phase: TrimmedNonEmptyString,
  readyContainerCount: NonNegativeInt,
  totalContainerCount: NonNegativeInt,
  restartCount: NonNegativeInt,
  createdAt: Schema.optionalKey(Schema.NullOr(IsoDateTime)),
  nodeName: Schema.optionalKey(NullableTrimmedNonEmptyString),
  ownerKind: Schema.optionalKey(NullableTrimmedNonEmptyString),
  ownerName: Schema.optionalKey(NullableTrimmedNonEmptyString),
  containers: Schema.Array(AppDevStackPodContainer),
});
export type AppDevStackPod = typeof AppDevStackPod.Type;

export const AppDevStackListPodsInput = Schema.Struct({
  stackId: TrimmedNonEmptyString,
});
export type AppDevStackListPodsInput = typeof AppDevStackListPodsInput.Type;

export const AppDevStackListPodsResult = Schema.Struct({
  stackId: TrimmedNonEmptyString,
  namespace: TrimmedNonEmptyString,
  pods: Schema.Array(AppDevStackPod),
});
export type AppDevStackListPodsResult = typeof AppDevStackListPodsResult.Type;

export const AppDevStackPodLogTailLines = PositiveInt.check(Schema.isLessThanOrEqualTo(5_000));
export type AppDevStackPodLogTailLines = typeof AppDevStackPodLogTailLines.Type;

export const AppDevStackGetPodLogsInput = Schema.Struct({
  stackId: TrimmedNonEmptyString,
  podName: TrimmedNonEmptyString,
  containerName: Schema.optional(NullableTrimmedNonEmptyString),
  tailLines: Schema.optional(AppDevStackPodLogTailLines),
});
export type AppDevStackGetPodLogsInput = typeof AppDevStackGetPodLogsInput.Type;

export const AppDevStackGetPodLogsResult = Schema.Struct({
  stackId: TrimmedNonEmptyString,
  namespace: TrimmedNonEmptyString,
  podName: TrimmedNonEmptyString,
  containerName: Schema.NullOr(TrimmedNonEmptyString),
  tailLines: AppDevStackPodLogTailLines,
  logs: Schema.String,
  fetchedAt: IsoDateTime,
});
export type AppDevStackGetPodLogsResult = typeof AppDevStackGetPodLogsResult.Type;

export class AppDevStackError extends Schema.TaggedErrorClass<AppDevStackError>()(
  "AppDevStackError",
  {
    operation: TrimmedNonEmptyString,
    reason: Schema.optional(Schema.Literals(["disabled", "request_failed", "invalid_response"])),
    status: Schema.optional(NonNegativeInt),
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
