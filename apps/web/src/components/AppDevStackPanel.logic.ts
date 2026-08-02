import type {
  AppDevStack,
  AppDevStackAutoCreateResult,
  AppDevStackPod,
  AppDevStackService,
} from "@t3tools/contracts";
import { normalizePreviewUrl } from "@t3tools/shared/preview";

export interface PreviewCandidate {
  readonly serviceName: string;
  readonly url: string;
}

const PRIMARY_PREVIEW_SERVICE_NAMES = ["frontend-dev", "frontend", "web", "app"] as const;
const TRANSITIONING_STACK_STATUSES = new Set<AppDevStack["status"]>([
  "pending",
  "starting",
  "stopping",
]);

export function isTransitioningAppDevStackStatus(status: AppDevStack["status"]): boolean {
  return TRANSITIONING_STACK_STATUSES.has(status);
}

export interface AutoCreateNotice {
  readonly kind: "reserved" | "already-running";
  readonly message: string;
  readonly url: string | null;
  readonly stackId: string | null;
}

/** Informational (non-error) notice when auto-create returned an existing stack. */
export function autoCreateNotice(result: AppDevStackAutoCreateResult): AutoCreateNotice | null {
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
      message ||
      "An app dev stack for this worktree is already running; showing the existing stack.",
    url: result.frontendUrl,
    stackId: result.stack?.id ?? null,
  };
}

export function shouldPollAppDevStacks(
  currentStack: AppDevStack | null | undefined,
  listedStacks: ReadonlyArray<AppDevStack>,
): boolean {
  return (
    (currentStack !== null &&
      currentStack !== undefined &&
      isTransitioningAppDevStackStatus(currentStack.status)) ||
    listedStacks.some((stack) => isTransitioningAppDevStackStatus(stack.status))
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

export function collectPreviewCandidates(stack: AppDevStack): readonly PreviewCandidate[] {
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

export function primaryPreviewForStack(stack: AppDevStack): PreviewCandidate | null {
  const candidates = collectPreviewCandidates(stack);
  for (const serviceName of PRIMARY_PREVIEW_SERVICE_NAMES) {
    const serviceKey = serviceLookupKey(serviceName);
    const candidate = candidates.find((item) => serviceLookupKey(item.serviceName) === serviceKey);
    if (candidate) return candidate;
  }
  return candidates[0] ?? null;
}

export function previewUrlForService(
  service: AppDevStackService,
  stack: AppDevStack,
): string | null {
  return (
    normalizePreviewHref(service.previewUrl) ??
    normalizePreviewHref(stack.previewUrls?.[service.name])
  );
}

function previewForServiceName(stack: AppDevStack, serviceName: string): PreviewCandidate | null {
  const serviceKey = serviceLookupKey(serviceName);
  return (
    collectPreviewCandidates(stack).find(
      (candidate) => serviceLookupKey(candidate.serviceName) === serviceKey,
    ) ?? null
  );
}

export function previewForPod(pod: AppDevStackPod, stack: AppDevStack): PreviewCandidate | null {
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
