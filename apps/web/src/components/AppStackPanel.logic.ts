import type {
  AppStack,
  AppStackListResult,
  AppStackAutoCreateResult,
  AppStackPod,
  AppStackService,
} from "@t3tools/contracts";
import { normalizePreviewUrl } from "@t3tools/shared/preview";

type WorkflowConflict = NonNullable<AppStackListResult["workflowConflicts"]>[number];

export function appStackOwnershipLabel(stack: AppStack): string | null {
  return stack.workflowId ? "Workflow-owned" : null;
}

export function isProtectedAppStack(stack: AppStack): boolean {
  return stack.protected === true;
}

/**
 * Labels the protection toggle. A protected stack survives workflow teardown
 * and is the last one the environment sheds under memory pressure, so the
 * button says what pressing it gives up.
 */
export function appStackProtectionAction(stack: AppStack): {
  readonly label: string;
  readonly ariaLabel: string;
  readonly nextProtected: boolean;
} {
  const stackName = stack.displayName?.trim() || stack.namespace || stack.id;
  return isProtectedAppStack(stack)
    ? {
        label: "Protected",
        ariaLabel: `Stop protecting ${stackName} from automatic teardown`,
        nextProtected: false,
      }
    : {
        label: "Protect",
        ariaLabel: `Protect ${stackName} from automatic teardown`,
        nextProtected: true,
      };
}

export function appStackWorkflowConflictSummary(conflict: WorkflowConflict): string {
  return `${conflict.stackIds.length} stacks · ${conflict.workflowId}`;
}

export interface PreviewCandidate {
  readonly serviceName: string;
  readonly url: string;
}

const PRIMARY_PREVIEW_SERVICE_NAMES = ["frontend-dev", "frontend", "web", "app"] as const;
const TRANSITIONING_STACK_STATUSES = new Set<AppStack["status"]>([
  "pending",
  "starting",
  "stopping",
]);

export function isTransitioningAppStackStatus(status: AppStack["status"]): boolean {
  return TRANSITIONING_STACK_STATUSES.has(status);
}

export interface AutoCreateNotice {
  readonly kind: "reserved" | "already-running";
  readonly message: string;
  readonly url: string | null;
  readonly stackId: string | null;
}

export interface AppStackSelectionState {
  readonly checked: boolean;
  readonly indeterminate: boolean;
}

export interface AppStackDeleteFailure {
  readonly stack: AppStack;
  readonly message: string;
}

function stackUpdatedTime(stack: AppStack): number {
  const timestamp = Date.parse(stack.updatedAt);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function normalizeWorktreePath(value: string): string {
  const normalized = value.trim().replace(/\\/gu, "/").replace(/\/+$/gu, "");
  return normalized === "" ? "/" : normalized;
}

export function orderAppStacksForPanel(input: {
  readonly currentStack: AppStack | null | undefined;
  readonly listedStacks: ReadonlyArray<AppStack>;
  readonly currentWorktreePath: string;
}): AppStack[] {
  const currentPath = normalizeWorktreePath(input.currentWorktreePath);
  const ordered: AppStack[] = [];
  const seenIds = new Set<string>();

  if (input.currentStack) {
    ordered.push(input.currentStack);
    seenIds.add(input.currentStack.id);
  }

  for (const stack of input.listedStacks) {
    if (seenIds.has(stack.id)) continue;
    if (
      input.currentStack &&
      normalizeWorktreePath(stack.worktreePath) ===
        normalizeWorktreePath(input.currentStack.worktreePath)
    ) {
      continue;
    }
    ordered.push(stack);
    seenIds.add(stack.id);
  }

  return ordered.sort((left, right) => {
    const leftCurrent = normalizeWorktreePath(left.worktreePath) === currentPath;
    const rightCurrent = normalizeWorktreePath(right.worktreePath) === currentPath;
    if (leftCurrent !== rightCurrent) return leftCurrent ? -1 : 1;
    return stackUpdatedTime(right) - stackUpdatedTime(left);
  });
}

export function reconcileAppStackIds(
  ids: ReadonlySet<string>,
  stacks: ReadonlyArray<AppStack>,
): Set<string> {
  const availableIds = new Set(stacks.map((stack) => stack.id));
  return new Set([...ids].filter((id) => availableIds.has(id)));
}

export function appStackSelectionState(
  selectedIds: ReadonlySet<string>,
  stacks: ReadonlyArray<AppStack>,
): AppStackSelectionState {
  if (stacks.length === 0) return { checked: false, indeterminate: false };
  const selectedCount = stacks.reduce(
    (count, stack) => count + (selectedIds.has(stack.id) ? 1 : 0),
    0,
  );
  return {
    checked: selectedCount === stacks.length,
    indeterminate: selectedCount > 0 && selectedCount < stacks.length,
  };
}

export function appStackBulkDeleteConfirmation(count: number): string {
  return [
    `Delete ${count} App Stack${count === 1 ? "" : "s"}?`,
    `This will remove ${count === 1 ? "its" : "their"} Kubernetes namespace${count === 1 ? "" : "s"}.`,
  ].join("\n");
}

export function appStackBulkDeleteFailureMessage(
  failures: ReadonlyArray<AppStackDeleteFailure>,
  totalCount: number,
): string | null {
  if (failures.length === 0) return null;
  const details = failures
    .map(({ stack, message }) => `${stack.displayName?.trim() || stack.id}: ${message}`)
    .join("; ");
  return `Failed to delete ${failures.length} of ${totalCount} App Stack${totalCount === 1 ? "" : "s"}. ${details}`;
}

/** Informational (non-error) notice when auto-create returned an existing stack. */
export function autoCreateNotice(result: AppStackAutoCreateResult): AutoCreateNotice | null {
  if (result.created) return null;
  const message = result.message?.trim();
  if (result.reserved === true) {
    return {
      kind: "reserved",
      message:
        message || "This branch is served by the standing deployment; no dev stack was created.",
      url: result.frontendUrl,
      stackId: null,
    };
  }
  return {
    kind: "already-running",
    message:
      message || "An app stack for this worktree is already running; showing the existing stack.",
    url: result.frontendUrl,
    stackId: result.stack?.id ?? null,
  };
}

export function shouldPollAppStacks(
  currentStack: AppStack | null | undefined,
  listedStacks: ReadonlyArray<AppStack>,
): boolean {
  return (
    (currentStack !== null &&
      currentStack !== undefined &&
      isTransitioningAppStackStatus(currentStack.status)) ||
    listedStacks.some((stack) => isTransitioningAppStackStatus(stack.status))
  );
}

function nonEmpty(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function serviceLookupKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

function stripReplicaSetHash(value: string): string {
  return value.replace(/-[a-z0-9]{8,10}$/u, "");
}

export function normalizePreviewHref(rawUrl: string | null | undefined): string | null {
  const trimmedUrl = nonEmpty(rawUrl);
  if (trimmedUrl === null) return null;
  try {
    return normalizePreviewUrl(trimmedUrl);
  } catch {
    return null;
  }
}

export function collectPreviewCandidates(stack: AppStack): readonly PreviewCandidate[] {
  const candidates: PreviewCandidate[] = [];
  const seen = new Set<string>();
  const previewUrls = stack.previewUrls ?? {};

  const addCandidate = (serviceName: string, url: string | null | undefined) => {
    const href = normalizePreviewHref(url);
    if (href === null) return;
    const key = `${serviceName}\u0000${href}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ serviceName, url: href });
  };

  for (const service of stack.services ?? []) {
    addCandidate(service.name, service.previewUrl);
    addCandidate(service.name, previewUrls[service.name]);
  }
  for (const [serviceName, url] of Object.entries(previewUrls)) {
    addCandidate(serviceName, url);
  }
  return candidates;
}

export function primaryPreviewForStack(stack: AppStack): PreviewCandidate | null {
  const candidates = collectPreviewCandidates(stack);
  for (const serviceName of PRIMARY_PREVIEW_SERVICE_NAMES) {
    const serviceKey = serviceLookupKey(serviceName);
    const candidate = candidates.find((item) => serviceLookupKey(item.serviceName) === serviceKey);
    if (candidate) return candidate;
  }
  return candidates[0] ?? null;
}

export function previewUrlForService(service: AppStackService, stack: AppStack): string | null {
  return (
    normalizePreviewHref(service.previewUrl) ??
    normalizePreviewHref(stack.previewUrls?.[service.name])
  );
}

function previewForServiceName(stack: AppStack, serviceName: string): PreviewCandidate | null {
  const serviceKey = serviceLookupKey(serviceName);
  return (
    collectPreviewCandidates(stack).find(
      (candidate) => serviceLookupKey(candidate.serviceName) === serviceKey,
    ) ?? null
  );
}

export function previewForPod(pod: AppStackPod, stack: AppStack): PreviewCandidate | null {
  const explicitUrl = normalizePreviewHref(pod.previewUrl);
  if (explicitUrl !== null) {
    return {
      serviceName: nonEmpty(pod.previewServiceName) ?? pod.containers[0]?.name ?? pod.name,
      url: explicitUrl,
    };
  }

  const candidates: string[] = [];
  const seen = new Set<string>();
  const addCandidate = (value: string | null | undefined) => {
    const serviceName = nonEmpty(value);
    if (serviceName === null) return;
    const key = serviceLookupKey(serviceName);
    if (!key || seen.has(key)) return;
    seen.add(key);
    candidates.push(serviceName);
  };

  addCandidate(pod.previewServiceName);
  for (const container of pod.containers) {
    addCandidate(container.name);
  }
  if (pod.ownerName) {
    addCandidate(stripReplicaSetHash(pod.ownerName));
  }

  for (const serviceName of candidates) {
    const preview = previewForServiceName(stack, serviceName);
    if (preview !== null) return preview;
  }

  const podNameKey = serviceLookupKey(pod.name);
  for (const preview of collectPreviewCandidates(stack)) {
    const serviceKey = serviceLookupKey(preview.serviceName);
    if (podNameKey === serviceKey || podNameKey.startsWith(`${serviceKey}-`)) {
      return preview;
    }
  }

  return null;
}
