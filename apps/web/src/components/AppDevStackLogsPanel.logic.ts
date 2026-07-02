import type {
  AppDevStack,
  AppDevStackDiscoveredStackPodLogs,
  AppDevStackGetAllStackPodLogsResult,
  AppDevStackGetStackPodLogsResult,
  AppDevStackLogReadLimit,
  AppDevStackPod,
  AppDevStackPodLogEntry,
} from "@t3tools/contracts";

export interface CurrentStackPathInput {
  readonly activeThreadWorktreePath: string | null | undefined;
  readonly gitCwd: string | null | undefined;
  readonly workspaceRoot: string | null | undefined;
}

export interface StackPodLogFilterOptions {
  readonly search: string;
  readonly hideEmpty: boolean;
}

export type StackLogTailSelection = 100 | 300 | 1000 | 5000 | "all";

export interface StackPodLogPodGroup {
  readonly podName: string;
  readonly entries: AppDevStackPodLogEntry[];
}

export interface StackPodLogServiceGroup {
  readonly serviceKey: string;
  readonly serviceName: string;
  readonly pods: StackPodLogPodGroup[];
  readonly entryCount: number;
  readonly emptyCount: number;
  readonly errorCount: number;
}

export interface StackPodLogStackView {
  readonly stack: AppDevStackDiscoveredStackPodLogs;
  readonly stackName: string;
  readonly filteredEntries: AppDevStackPodLogEntry[];
  readonly serviceGroups: StackPodLogServiceGroup[];
  readonly podCount: number;
  readonly containerCount: number;
  readonly errorCount: number;
  readonly emptyCount: number;
}

interface MutableStackPodLogServiceGroup {
  serviceKey: string;
  serviceName: string;
  pods: StackPodLogPodGroup[];
  entryCount: number;
  emptyCount: number;
  errorCount: number;
}

export function normalizeStackWorktreePath(path: string): string {
  return path.trim().replace(/\/+$/u, "") || path.trim();
}

export function isSameOrChildStackPath(path: string, parent: string): boolean {
  const normalizedPath = normalizeStackWorktreePath(path);
  const normalizedParent = normalizeStackWorktreePath(parent);
  return (
    normalizedPath === normalizedParent ||
    (normalizedParent !== "/" && normalizedPath.startsWith(`${normalizedParent}/`))
  );
}

export function resolveCurrentStackPath(input: CurrentStackPathInput): string | null {
  const activeThreadWorktreePath = normalizeStackWorktreePath(input.activeThreadWorktreePath ?? "");
  const workspaceRoot = normalizeStackWorktreePath(input.workspaceRoot ?? "");
  const gitCwd = normalizeStackWorktreePath(input.gitCwd ?? "");

  if (
    activeThreadWorktreePath.length > 0 &&
    workspaceRoot.length > 0 &&
    isSameOrChildStackPath(activeThreadWorktreePath, workspaceRoot)
  ) {
    return workspaceRoot;
  }
  if (activeThreadWorktreePath.length > 0) return activeThreadWorktreePath;
  if (workspaceRoot.length > 0) return workspaceRoot;
  if (gitCwd.length > 0) return gitCwd;
  return null;
}

function nonEmpty(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

const GENERATED_REPLICA_SET_HASH_RE = /^[a-z0-9]{8,10}$/u;
const GENERATED_POD_SUFFIX_RE = /^[a-z0-9]{5}$/u;

const SERVICE_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  backend: "Back End",
  "codex-runner": "Codex Runner",
  frontend: "Front End",
  keycloak: "Keycloak",
  minio: "MinIO",
  postgres: "Postgres",
  redis: "Redis",
};

export function displayNameFromStackPath(worktreePath: string): string {
  const normalized = normalizeStackWorktreePath(worktreePath);
  const lastSlashIndex = normalized.lastIndexOf("/");
  return normalized.slice(lastSlashIndex + 1) || "App Stack";
}

export function displayStackName(stack: AppDevStack): string {
  return (
    nonEmpty(stack.displayName) ??
    nonEmpty(stack.repoName) ??
    displayNameFromStackPath(stack.worktreePath)
  );
}

export function displayDiscoveredStackName(stack: AppDevStackDiscoveredStackPodLogs): string {
  return (
    nonEmpty(stack.displayName) ??
    nonEmpty(stack.repoName) ??
    nonEmpty(stack.worktreePath) ??
    nonEmpty(stack.namespace) ??
    stack.stackId
  );
}

export function stackLogTailSelectionLabel(selection: StackLogTailSelection): string {
  return selection === "all" ? "All" : `${String(selection)} lines`;
}

export function stackLogReadLimitLabel(limit: AppDevStackLogReadLimit): string {
  return limit.mode === "all"
    ? "All available current logs"
    : `${String(limit.tailLines ?? 300)} lines`;
}

export function stackLogTailSelectionToReadLimit(
  selection: StackLogTailSelection,
): AppDevStackLogReadLimit {
  return selection === "all" ? { mode: "all" } : { mode: "tail", tailLines: selection };
}

export function stackPodLogOwnerLabel(
  entry: Pick<AppDevStackPodLogEntry, "ownerKind" | "ownerName">,
): string | null {
  const ownerKind = nonEmpty(entry.ownerKind);
  const ownerName = nonEmpty(entry.ownerName);
  if (ownerKind && ownerName) return `${ownerKind} ${ownerName}`;
  return ownerName ?? ownerKind;
}

export function countStackLogContainers(pods: ReadonlyArray<AppDevStackPod>): number {
  return pods.reduce((total, pod) => total + pod.containers.length, 0);
}

function entryIsEmpty(entry: AppDevStackPodLogEntry): boolean {
  return entry.logs.trim().length === 0 && nonEmpty(entry.error) === null;
}

function stripGeneratedReplicaSetHash(name: string): string {
  const parts = name.split("-");
  const lastPart = parts.at(-1);
  if (parts.length > 1 && lastPart && GENERATED_REPLICA_SET_HASH_RE.test(lastPart)) {
    return parts.slice(0, -1).join("-");
  }
  return name;
}

function stripGeneratedPodSuffixes(name: string): string {
  const parts = name.split("-");
  const lastPart = parts.at(-1);
  if (parts.length > 1 && lastPart && GENERATED_POD_SUFFIX_RE.test(lastPart)) {
    return stripGeneratedReplicaSetHash(parts.slice(0, -1).join("-"));
  }
  return stripGeneratedReplicaSetHash(name);
}

function titleCaseServiceName(serviceKey: string): string {
  return serviceKey
    .split("-")
    .filter((part) => part.length > 0)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function stackPodLogServiceKey(entry: AppDevStackPodLogEntry): string {
  const ownerName = nonEmpty(entry.ownerName);
  if (ownerName) {
    return entry.ownerKind === "ReplicaSet" ? stripGeneratedReplicaSetHash(ownerName) : ownerName;
  }
  return stripGeneratedPodSuffixes(entry.podName);
}

function stackPodLogServiceName(serviceKey: string): string {
  return SERVICE_DISPLAY_NAMES[serviceKey] ?? titleCaseServiceName(serviceKey);
}

export function groupStackPodLogEntriesByService(
  entries: ReadonlyArray<AppDevStackPodLogEntry>,
): StackPodLogServiceGroup[] {
  const groups: MutableStackPodLogServiceGroup[] = [];
  const groupsByServiceKey = new Map<string, MutableStackPodLogServiceGroup>();
  const podEntriesByServiceKey = new Map<string, Map<string, AppDevStackPodLogEntry[]>>();

  for (const entry of entries) {
    const serviceKey = stackPodLogServiceKey(entry);
    let serviceGroup = groupsByServiceKey.get(serviceKey);
    if (!serviceGroup) {
      serviceGroup = {
        serviceKey,
        serviceName: stackPodLogServiceName(serviceKey),
        pods: [],
        entryCount: 0,
        emptyCount: 0,
        errorCount: 0,
      };
      groupsByServiceKey.set(serviceKey, serviceGroup);
      podEntriesByServiceKey.set(serviceKey, new Map());
      groups.push(serviceGroup);
    }

    let podEntries = podEntriesByServiceKey.get(serviceKey)?.get(entry.podName);
    if (!podEntries) {
      podEntries = [];
      podEntriesByServiceKey.get(serviceKey)?.set(entry.podName, podEntries);
      serviceGroup.pods.push({ podName: entry.podName, entries: podEntries });
    }

    podEntries.push(entry);
    serviceGroup.entryCount += 1;
    if (entryIsEmpty(entry)) serviceGroup.emptyCount += 1;
    if (entry.error !== null) serviceGroup.errorCount += 1;
  }

  return groups;
}

function searchableEntryText(entry: AppDevStackPodLogEntry): string {
  return [
    entry.podName,
    entry.containerName,
    entry.phase,
    entry.state,
    entry.ownerKind,
    entry.ownerName,
    stackPodLogOwnerLabel(entry),
    entry.logs,
    entry.error,
  ]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join("\n")
    .toLowerCase();
}

function searchableStackText(stack: AppDevStackDiscoveredStackPodLogs): string {
  return [
    stack.stackId,
    stack.namespace,
    stack.displayName,
    stack.displaySlug,
    stack.repoName,
    stack.branchName,
    stack.worktreePath,
    stack.managedBy,
    stack.error,
  ]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join("\n")
    .toLowerCase();
}

export function filterStackPodLogEntries(
  entries: ReadonlyArray<AppDevStackPodLogEntry>,
  options: StackPodLogFilterOptions,
): AppDevStackPodLogEntry[] {
  const query = options.search.trim().toLowerCase();
  return entries.filter((entry) => {
    if (options.hideEmpty && entryIsEmpty(entry)) return false;
    if (query.length === 0) return true;
    return searchableEntryText(entry).includes(query);
  });
}

export function filterStackPodLogEntriesForStack(
  stack: AppDevStackDiscoveredStackPodLogs,
  options: StackPodLogFilterOptions,
): AppDevStackPodLogEntry[] {
  const query = options.search.trim().toLowerCase();
  const stackMatches = query.length > 0 && searchableStackText(stack).includes(query);
  return stack.entries.filter((entry) => {
    if (options.hideEmpty && entryIsEmpty(entry)) return false;
    if (query.length === 0 || stackMatches) return true;
    return searchableEntryText(entry).includes(query);
  });
}

export function buildStackPodLogViews(
  stacks: ReadonlyArray<AppDevStackDiscoveredStackPodLogs>,
  options: StackPodLogFilterOptions,
): StackPodLogStackView[] {
  return stacks
    .map((stack) => {
      const filteredEntries = filterStackPodLogEntriesForStack(stack, options);
      const serviceGroups = groupStackPodLogEntriesByService(filteredEntries);
      return {
        stack,
        stackName: displayDiscoveredStackName(stack),
        filteredEntries,
        serviceGroups,
        podCount: stack.pods.length,
        containerCount: countStackLogContainers(stack.pods),
        errorCount: stack.entries.filter((entry) => entry.error !== null).length,
        emptyCount: stack.entries.filter(entryIsEmpty).length,
      };
    })
    .filter((view) => {
      if (view.stack.error !== null) return true;
      if (options.search.trim().length > 0) return view.filteredEntries.length > 0;
      return true;
    });
}

export function formatStackPodLogsForClipboard(input: {
  readonly stackName: string;
  readonly result: Pick<AppDevStackGetStackPodLogsResult, "namespace" | "tailLines" | "fetchedAt">;
  readonly entries: ReadonlyArray<AppDevStackPodLogEntry>;
}): string {
  const lines: string[] = [
    `App Stack Pod Logs: ${input.stackName}`,
    `Namespace: ${input.result.namespace}`,
    `Tail: ${String(input.result.tailLines)} lines`,
    `Fetched: ${input.result.fetchedAt}`,
  ];

  for (const entry of input.entries) {
    const owner = stackPodLogOwnerLabel(entry);
    lines.push(
      "",
      `--- ${entry.podName} / ${entry.containerName} ---`,
      [
        `phase=${entry.phase}`,
        `ready=${String(entry.ready)}`,
        `restarts=${String(entry.restartCount)}`,
        entry.state ? `state=${entry.state}` : null,
        owner ? `owner=${owner}` : null,
        `fetchedAt=${entry.fetchedAt}`,
      ]
        .filter((value): value is string => value !== null)
        .join(" "),
    );
    if (entry.error) {
      lines.push(`error=${entry.error}`);
    }
    lines.push(entry.logs.trimEnd().length > 0 ? entry.logs.trimEnd() : "No log lines returned.");
  }

  return lines.join("\n");
}

export function formatAllStackPodLogsForClipboard(input: {
  readonly result: Pick<AppDevStackGetAllStackPodLogsResult, "limit" | "stacks" | "fetchedAt">;
}): string {
  const lines: string[] = [
    "App Stack Pod Logs",
    `Limit: ${stackLogReadLimitLabel(input.result.limit)}`,
    `Fetched: ${input.result.fetchedAt}`,
  ];

  for (const stack of input.result.stacks) {
    lines.push(
      "",
      `== ${displayDiscoveredStackName(stack)} ==`,
      `Stack ID: ${stack.stackId}`,
      `Namespace: ${stack.namespace}`,
      `Limit: ${stackLogReadLimitLabel(stack.limit)}`,
      `Fetched: ${stack.fetchedAt}`,
    );
    if (stack.managedBy) lines.push(`Managed by: ${stack.managedBy}`);
    if (stack.error) lines.push(`Stack error: ${stack.error}`);

    for (const entry of stack.entries) {
      const owner = stackPodLogOwnerLabel(entry);
      lines.push(
        "",
        `--- ${entry.podName} / ${entry.containerName} ---`,
        [
          `phase=${entry.phase}`,
          `ready=${String(entry.ready)}`,
          `restarts=${String(entry.restartCount)}`,
          entry.state ? `state=${entry.state}` : null,
          owner ? `owner=${owner}` : null,
          `fetchedAt=${entry.fetchedAt}`,
        ]
          .filter((value): value is string => value !== null)
          .join(" "),
      );
      if (entry.error) {
        lines.push(`error=${entry.error}`);
      }
      lines.push(entry.logs.trimEnd().length > 0 ? entry.logs.trimEnd() : "No log lines returned.");
    }

    if (stack.entries.length === 0 && stack.error === null) {
      lines.push("No containers returned logs.");
    }
  }

  return lines.join("\n");
}
