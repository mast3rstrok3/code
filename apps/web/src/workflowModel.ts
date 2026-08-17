import type {
  OrchestrationImplementationRetryableFailure,
  OrchestrationPlanningTicket,
  OrchestrationSessionStatus,
  OrchestrationThreadWorkflowRole,
  WorkflowPreset,
} from "@t3tools/contracts";
import {
  WORKFLOW_PRESET_DEFINITION_BY_ID,
  type WorkflowPresetHelpStep,
} from "@t3tools/shared/workflowPresets";

export interface WorkflowModelThread {
  readonly environmentId: string;
  readonly id: string;
  readonly parentThreadId: string | null;
  readonly workflowRole: OrchestrationThreadWorkflowRole | null;
  readonly workflowContext?: {
    readonly workflowId: string;
    readonly parentWorkflowId?: string | null | undefined;
    readonly rootThreadId: string;
  } | null;
  readonly workflowSubagentBatchProvenance?: {
    readonly batchId: string;
  } | null;
  readonly workflowPreset?: WorkflowPreset | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
  readonly settledAt: string | null;
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
  readonly backgroundLiveness?: "working" | "monitoring" | null | undefined;
  readonly latestTurn: {
    readonly state: "running" | "interrupted" | "completed" | "error";
    readonly requestedAt: string;
    readonly startedAt: string | null;
    readonly completedAt: string | null;
  } | null;
  readonly session: {
    readonly status: OrchestrationSessionStatus;
    readonly updatedAt: string;
  } | null;
}

export type WorkflowThreadStatus =
  | "working"
  | "monitoring"
  | "approval"
  | "input"
  | "completed"
  | "failed"
  | "stopped"
  | "archived";

export interface WorkflowTreeRow<TThread extends WorkflowModelThread> {
  readonly thread: TThread;
  readonly depth: number;
  readonly parentThreadKey: string | null;
}

export interface WorkflowGroup<TThread extends WorkflowModelThread> {
  readonly id: string;
  readonly kind: "workflow" | "batch" | "legacy";
  readonly sourceId: string;
  readonly parentGroupId: string | null;
  readonly depth: number;
  readonly createdAt: string;
  readonly preset: WorkflowPreset | null;
  readonly rows: readonly WorkflowTreeRow<TThread>[];
  readonly activeCount: number;
  readonly settledCount: number;
  readonly isActive: boolean;
}

export interface WorkflowRoot<TThread extends WorkflowModelThread> {
  readonly root: TThread;
  readonly members: readonly TThread[];
  readonly groups: readonly WorkflowGroup<TThread>[];
}

export type WorkflowTimelineEntry<TThread extends WorkflowModelThread> =
  | {
      readonly kind: "thread";
      readonly id: string;
      readonly createdAt: string;
      readonly row: WorkflowTreeRow<TThread>;
    }
  | {
      readonly kind: "workflow";
      readonly id: string;
      readonly createdAt: string;
      readonly group: WorkflowGroup<TThread>;
    };

export interface WorkflowTimelineStep<TThread extends WorkflowModelThread> {
  readonly id: string;
  readonly createdAt: string;
  readonly label: string | null;
  readonly skillId: string | null;
  readonly repeatsAsCycles: boolean;
  readonly entries: readonly WorkflowTimelineEntry<TThread>[];
}

export interface WorkflowTimeRange {
  readonly startedAt: string;
  readonly endedAt: string | null;
}

export function buildTicketWaves(
  tickets: readonly OrchestrationPlanningTicket[],
): readonly (readonly OrchestrationPlanningTicket[])[] {
  const remaining = new Map(tickets.map((ticket) => [ticket.id, ticket] as const));
  const waves: OrchestrationPlanningTicket[][] = [];
  while (remaining.size > 0) {
    const ready = [...remaining.values()]
      .filter((ticket) =>
        ticket.dependencies.every((dependency) => !remaining.has(dependency.ticketId)),
      )
      .toSorted((left, right) => left.ordinal - right.ordinal);
    const wave =
      ready.length > 0
        ? ready
        : [[...remaining.values()].toSorted((a, b) => a.ordinal - b.ordinal)[0]!];
    waves.push(wave);
    for (const ticket of wave) remaining.delete(ticket.id);
  }
  return waves;
}

export function workflowStepMatchesImplementationFailure<TThread extends WorkflowModelThread>(
  step: WorkflowTimelineStep<TThread>,
  stage: OrchestrationImplementationRetryableFailure["stage"],
): boolean {
  const label = step.label?.toLowerCase() ?? "";
  switch (stage) {
    case "source-dirty":
    case "worktree-setup":
      return label === "create shared worktree" || label.startsWith("load the selected spec");
    case "worker-setup":
    case "worker-execution":
      return label.includes("tdd") || label.includes("build");
    case "integration":
    case "merge-gate":
      return label.includes("integrat") || label.includes("merge gate");
    case "app-dev-stack":
      return label.startsWith("start and probe appdevstack");
    case "app-review":
      return label.includes("app review");
    case "code-review":
      return label.includes("code review");
    case "fixer":
      return label.includes("repair") || label.includes("tdd");
    case "build":
      return label.includes("build") || label.includes("tdd");
    case "change-request":
      return label.includes("change request") || label.includes("publish");
  }
}

export interface WorkflowViewModel<TThread extends WorkflowModelThread> {
  readonly ownerThreadKeyByThreadKey: ReadonlyMap<string, string>;
  readonly rootsByThreadKey: ReadonlyMap<string, WorkflowRoot<TThread>>;
  readonly topLevelThreads: readonly TThread[];
}

export function workflowThreadKey(thread: Pick<WorkflowModelThread, "environmentId" | "id">) {
  return `${thread.environmentId}:${thread.id}`;
}

function timestampMs(value: string): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function buildWorkflowTimeline<TThread extends WorkflowModelThread>(
  group: WorkflowGroup<TThread>,
  groups: readonly WorkflowGroup<TThread>[],
): readonly WorkflowTimelineEntry<TThread>[] {
  return [
    ...group.rows.map(
      (row): WorkflowTimelineEntry<TThread> => ({
        kind: "thread",
        id: workflowThreadKey(row.thread),
        createdAt: row.thread.createdAt,
        row,
      }),
    ),
    ...groups
      .filter((candidate) => candidate.parentGroupId === group.id)
      .map(
        (child): WorkflowTimelineEntry<TThread> => ({
          kind: "workflow",
          id: child.id,
          createdAt: child.createdAt,
          group: child,
        }),
      ),
  ].toSorted(
    (left, right) =>
      timestampMs(left.createdAt) - timestampMs(right.createdAt) || left.id.localeCompare(right.id),
  );
}

function workflowStepIdentity<TThread extends WorkflowModelThread>(
  entry: WorkflowTimelineEntry<TThread>,
): string {
  if (entry.kind === "workflow") {
    return `workflow:${entry.group.preset ?? entry.group.id}`;
  }
  return `role:${entry.row.thread.workflowRole ?? "workflow-child"}`;
}

function entrySkillIds<TThread extends WorkflowModelThread>(
  entry: WorkflowTimelineEntry<TThread>,
): ReadonlySet<string> {
  if (entry.kind === "workflow") {
    return entry.group.preset === "app-review"
      ? new Set(["implementation.browser-app-review.codex"])
      : new Set();
  }
  switch (entry.row.thread.workflowRole) {
    case "planning-orchestrator":
      return new Set([
        "planning.engineering-grill-automatic.codex",
        "planning.grill-stage.codex",
        "planning.spec.codex",
        "planning.tickets.codex",
        "planning.wayfinder.codex",
        "planning.research.codex",
        "planning.prototype.codex",
      ]);
    case "planning-reviewer":
      return new Set(["planning.ticket-reviewer.codex"]);
    case "implementation-orchestrator":
      return new Set(["implementation.orchestrator-planning.codex"]);
    case "implementation-worker":
    case "implementation-fixer":
    case "product-fix-implementer":
    case "fast-feature-implementer":
      return new Set(["implementation.tdd.codex"]);
    case "app-review-fixer":
      return new Set(["matt-pocock.implement"]);
    case "implementation-validator":
      return new Set(["implementation.merge-gate.codex"]);
    case "implementation-qa-reviewer":
    case "app-review-reviewer":
    case "app-review-orchestrator":
      return new Set(["implementation.browser-app-review.codex"]);
    case "implementation-code-reviewer":
      return new Set(["implementation.code-review.codex"]);
    case null:
      return new Set();
  }
}

function entryMatchesDefinedStep<TThread extends WorkflowModelThread>(
  entry: WorkflowTimelineEntry<TThread>,
  step: WorkflowPresetHelpStep,
): boolean {
  if (step.skillId !== undefined && entrySkillIds(entry).has(step.skillId)) return true;
  if (entry.kind === "workflow") return false;
  const role = entry.row.thread.workflowRole;
  const label = step.label.toLowerCase();
  if (label.includes("start and probe appdevstack")) {
    return role === "implementation-orchestrator" || role === "fast-feature-implementer";
  }
  if (label.includes("change request") || label.includes("publish")) {
    return role === "implementation-orchestrator" || role === "fast-feature-implementer";
  }
  if (label.includes("cli plan")) return role === "fast-feature-implementer";
  return false;
}

function definedStepRepeatsAsCycles(step: WorkflowPresetHelpStep): boolean {
  const label = step.label.toLowerCase();
  return (
    step.skillId === "implementation.browser-app-review.codex" ||
    step.skillId === "planning.ticket-reviewer.codex" ||
    label.includes("cycle")
  );
}

function definedStepUsesRootThread(preset: WorkflowPreset, step: WorkflowPresetHelpStep): boolean {
  if (step.threadBoundary === "same thread") return true;
  const definition = WORKFLOW_PRESET_DEFINITION_BY_ID[preset];
  if (step.skillId !== undefined && step.skillId === definition.workflowPromptId) return true;
  const label = step.label.toLowerCase();
  if (label.includes("create shared worktree")) return true;
  if (preset === "planning") {
    return step.skillId !== "planning.ticket-reviewer.codex";
  }
  if (preset === "wayfinder") return true;
  return false;
}

function fallbackStepRepeatsAsCycles<TThread extends WorkflowModelThread>(
  entries: readonly WorkflowTimelineEntry<TThread>[],
): boolean {
  if (entries.length < 2) return false;
  if (entries.every((entry) => entry.kind === "workflow")) return true;
  return entries.every(
    (entry) =>
      entry.kind === "thread" &&
      (entry.row.thread.workflowRole === "planning-reviewer" ||
        entry.row.thread.workflowRole === "implementation-qa-reviewer" ||
        entry.row.thread.workflowRole === "implementation-fixer" ||
        entry.row.thread.workflowRole === "app-review-reviewer" ||
        entry.row.thread.workflowRole === "app-review-fixer"),
  );
}

/**
 * Render the canonical steps users see in Settings → Workflows. Runtime threads
 * attach to those definitions; a fresh thread for a repeated review or repair
 * remains another cycle of the same step. Historical workflows without defined
 * steps retain role-based grouping as a fallback.
 */
export function buildWorkflowSteps<TThread extends WorkflowModelThread>(
  group: WorkflowGroup<TThread>,
  groups: readonly WorkflowGroup<TThread>[],
  rootThread?: TThread,
): readonly WorkflowTimelineStep<TThread>[] {
  const timeline = buildWorkflowTimeline(group, groups);
  const definedSteps =
    group.preset === null ? [] : WORKFLOW_PRESET_DEFINITION_BY_ID[group.preset].helpSteps;
  if (definedSteps.length > 0) {
    const matchedEntryIds = new Set<string>();
    const steps = definedSteps.map((definition, index): WorkflowTimelineStep<TThread> => {
      const matchedEntries = timeline.filter((entry) => entryMatchesDefinedStep(entry, definition));
      for (const entry of matchedEntries) matchedEntryIds.add(entry.id);
      const entries =
        rootThread !== undefined &&
        group.preset !== null &&
        definedStepUsesRootThread(group.preset, definition)
          ? [
              {
                kind: "thread" as const,
                id: workflowThreadKey(rootThread),
                createdAt: rootThread.createdAt,
                row: { thread: rootThread, depth: 0, parentThreadKey: null },
              },
              ...matchedEntries,
            ]
          : matchedEntries;
      return {
        id: `defined:${group.id}:${String(index)}`,
        createdAt: entries[0]?.createdAt ?? group.createdAt,
        label: definition.label,
        skillId: definition.skillId ?? null,
        repeatsAsCycles: definedStepRepeatsAsCycles(definition),
        entries,
      };
    });
    const unmatched = timeline.filter((entry) => !matchedEntryIds.has(entry.id));
    if (unmatched.length === 0) return steps;
    return [...steps, ...buildFallbackWorkflowSteps(unmatched)];
  }
  return buildFallbackWorkflowSteps(timeline);
}

function buildFallbackWorkflowSteps<TThread extends WorkflowModelThread>(
  timeline: readonly WorkflowTimelineEntry<TThread>[],
): readonly WorkflowTimelineStep<TThread>[] {
  const steps: WorkflowTimelineStep<TThread>[] = [];
  const stepIndexByIdentity = new Map<string, number>();
  for (const entry of timeline) {
    const identity = workflowStepIdentity(entry);
    const existingIndex = stepIndexByIdentity.get(identity);
    if (existingIndex !== undefined) {
      const existing = steps[existingIndex]!;
      const entries = [...existing.entries, entry];
      steps[existingIndex] = {
        ...existing,
        entries,
        repeatsAsCycles: fallbackStepRepeatsAsCycles(entries),
      };
      continue;
    }
    stepIndexByIdentity.set(identity, steps.length);
    steps.push({
      id: `${identity}:${entry.id}`,
      createdAt: entry.createdAt,
      label: null,
      skillId: null,
      repeatsAsCycles: false,
      entries: [entry],
    });
  }
  return steps;
}

export function resolveWorkflowThreadTimeRange(thread: WorkflowModelThread): WorkflowTimeRange {
  if (workflowStatusIsActive(resolveWorkflowThreadStatus(thread))) {
    return { startedAt: thread.createdAt, endedAt: null };
  }
  return {
    startedAt: thread.createdAt,
    endedAt:
      thread.settledAt ??
      thread.latestTurn?.completedAt ??
      thread.archivedAt ??
      thread.session?.updatedAt ??
      thread.updatedAt,
  };
}

export function resolveWorkflowGroupTimeRange<TThread extends WorkflowModelThread>(
  group: WorkflowGroup<TThread>,
  groups: readonly WorkflowGroup<TThread>[],
): WorkflowTimeRange {
  const childrenByParentId = new Map<string, WorkflowGroup<TThread>[]>();
  for (const candidate of groups) {
    if (candidate.parentGroupId === null) continue;
    const children = childrenByParentId.get(candidate.parentGroupId);
    if (children) children.push(candidate);
    else childrenByParentId.set(candidate.parentGroupId, [candidate]);
  }
  const ranges: WorkflowTimeRange[] = [];
  const visited = new Set<string>();
  const collect = (candidate: WorkflowGroup<TThread>) => {
    if (visited.has(candidate.id)) return;
    visited.add(candidate.id);
    ranges.push(...candidate.rows.map((row) => resolveWorkflowThreadTimeRange(row.thread)));
    for (const child of childrenByParentId.get(candidate.id) ?? []) collect(child);
  };
  collect(group);

  const startedAt = ranges.reduce(
    (earliest, range) =>
      timestampMs(range.startedAt) < timestampMs(earliest) ? range.startedAt : earliest,
    group.createdAt,
  );
  if (ranges.some((range) => range.endedAt === null)) return { startedAt, endedAt: null };
  const endedAt = ranges.reduce<string>((latest, range) => {
    const candidate = range.endedAt ?? range.startedAt;
    return timestampMs(candidate) > timestampMs(latest) ? candidate : latest;
  }, startedAt);
  return { startedAt, endedAt };
}

export function resolveWorkflowStepTimeRange<TThread extends WorkflowModelThread>(
  step: WorkflowTimelineStep<TThread>,
  groups: readonly WorkflowGroup<TThread>[],
): WorkflowTimeRange {
  const ranges = step.entries.map((entry) =>
    entry.kind === "thread"
      ? resolveWorkflowThreadTimeRange(entry.row.thread)
      : resolveWorkflowGroupTimeRange(entry.group, groups),
  );
  const startedAt = ranges.reduce(
    (earliest, range) =>
      timestampMs(range.startedAt) < timestampMs(earliest) ? range.startedAt : earliest,
    step.createdAt,
  );
  if (ranges.some((range) => range.endedAt === null)) return { startedAt, endedAt: null };
  return {
    startedAt,
    endedAt: ranges.reduce<string>((latest, range) => {
      const candidate = range.endedAt ?? range.startedAt;
      return timestampMs(candidate) > timestampMs(latest) ? candidate : latest;
    }, startedAt),
  };
}

export function resolveWorkflowThreadStatus(thread: WorkflowModelThread): WorkflowThreadStatus {
  if (thread.archivedAt !== null) return "archived";
  if (thread.hasPendingApprovals) return "approval";
  if (thread.hasPendingUserInput) return "input";
  if (thread.session?.status === "running" || thread.session?.status === "starting") {
    return "working";
  }
  if (thread.session?.status === "error" || thread.latestTurn?.state === "error") return "failed";
  if (thread.backgroundLiveness === "working") return "working";
  if (thread.backgroundLiveness === "monitoring") return "monitoring";
  if (
    thread.session?.status === "interrupted" ||
    thread.session?.status === "stopped" ||
    thread.latestTurn?.state === "interrupted"
  ) {
    return "stopped";
  }
  return "completed";
}

export function workflowStatusIsActive(status: WorkflowThreadStatus): boolean {
  return (
    status === "working" || status === "monitoring" || status === "approval" || status === "input"
  );
}

const WORKFLOW_STATUS_PRIORITY: Record<WorkflowThreadStatus, number> = {
  approval: 8,
  input: 7,
  working: 6,
  monitoring: 5,
  failed: 4,
  stopped: 3,
  completed: 2,
  archived: 1,
};

export function resolveWorkflowRollupStatus(
  threads: readonly WorkflowModelThread[],
): WorkflowThreadStatus | null {
  let highest: WorkflowThreadStatus | null = null;
  for (const thread of threads) {
    const status = resolveWorkflowThreadStatus(thread);
    if (highest === null || WORKFLOW_STATUS_PRIORITY[status] > WORKFLOW_STATUS_PRIORITY[highest]) {
      highest = status;
    }
  }
  return highest;
}

export function resolveWorkflowLifecycle<TThread extends WorkflowModelThread>(
  members: readonly TThread[],
  classify: (thread: TThread) => "active" | "snoozed" | "settled",
): "active" | "snoozed" | "settled" {
  let hasSnoozed = false;
  for (const member of members) {
    const lifecycle = classify(member);
    if (lifecycle === "active") return "active";
    if (lifecycle === "snoozed") hasSnoozed = true;
  }
  return hasSnoozed ? "snoozed" : "settled";
}

function resolveOwner<TThread extends WorkflowModelThread>(
  thread: TThread,
  byKey: ReadonlyMap<string, TThread>,
): TThread {
  const contextRootId = thread.workflowContext?.rootThreadId;
  const contextRoot = contextRootId
    ? byKey.get(`${thread.environmentId}:${contextRootId}`)
    : undefined;
  // A nested workflow's rootThreadId identifies its local controller (for
  // example, App Review can root at a Fast Feature Build child). Continue up
  // the physical thread ancestry so every nested workflow remains visible from
  // the thread that initiated the complete workflow tree.
  let current = contextRoot ?? thread;
  const path: TThread[] = [];
  const indexByKey = new Map<string, number>();
  while (current.parentThreadId !== null) {
    const currentKey = workflowThreadKey(current);
    const cycleIndex = indexByKey.get(currentKey);
    if (cycleIndex !== undefined) {
      return path.slice(cycleIndex).toSorted((left, right) => left.id.localeCompare(right.id))[0]!;
    }
    indexByKey.set(currentKey, path.length);
    path.push(current);
    const parent = byKey.get(`${current.environmentId}:${current.parentThreadId}`);
    if (!parent || parent === current) break;
    current = parent;
  }
  return current;
}

function resolveLegacyBranchKey<TThread extends WorkflowModelThread>(
  thread: TThread,
  owner: TThread,
  byKey: ReadonlyMap<string, TThread>,
): string {
  let current = thread;
  const visited = new Set<string>();
  while (current.parentThreadId !== null && current.parentThreadId !== owner.id) {
    const currentKey = workflowThreadKey(current);
    if (visited.has(currentKey)) break;
    visited.add(currentKey);
    const parent = byKey.get(`${current.environmentId}:${current.parentThreadId}`);
    if (!parent || parent === current) break;
    current = parent;
  }
  return current.id;
}

function sortOldestFirst<TThread extends WorkflowModelThread>(left: TThread, right: TThread) {
  return (
    timestampMs(left.createdAt) - timestampMs(right.createdAt) || left.id.localeCompare(right.id)
  );
}

function buildGroupRows<TThread extends WorkflowModelThread>(threads: readonly TThread[]) {
  const byKey = new Map(threads.map((thread) => [workflowThreadKey(thread), thread] as const));
  const parentByKey = new Map<string, string | null>();
  for (const thread of threads) {
    const key = workflowThreadKey(thread);
    if (thread.parentThreadId === null || thread.parentThreadId === thread.id) {
      parentByKey.set(key, null);
      continue;
    }
    const parentKey = `${thread.environmentId}:${thread.parentThreadId}`;
    parentByKey.set(key, byKey.has(parentKey) ? parentKey : null);
  }

  // Break every edge participating in a cycle. Orphans and corrupt branches
  // become roots, so the renderer always emits each surviving shell once.
  for (const startKey of byKey.keys()) {
    const path: string[] = [];
    const indexByKey = new Map<string, number>();
    let currentKey: string | null = startKey;
    while (currentKey !== null) {
      const cycleIndex = indexByKey.get(currentKey);
      if (cycleIndex !== undefined) {
        for (const cycleKey of path.slice(cycleIndex)) parentByKey.set(cycleKey, null);
        break;
      }
      indexByKey.set(currentKey, path.length);
      path.push(currentKey);
      currentKey = parentByKey.get(currentKey) ?? null;
    }
  }

  const childrenByParent = new Map<string, TThread[]>();
  for (const thread of threads) {
    const parentKey = parentByKey.get(workflowThreadKey(thread));
    if (parentKey === null || parentKey === undefined) continue;
    const children = childrenByParent.get(parentKey);
    if (children) children.push(thread);
    else childrenByParent.set(parentKey, [thread]);
  }
  for (const children of childrenByParent.values()) children.sort(sortOldestFirst);

  const rows: WorkflowTreeRow<TThread>[] = [];
  const emitted = new Set<string>();
  const emit = (thread: TThread, depth: number) => {
    const key = workflowThreadKey(thread);
    if (emitted.has(key)) return;
    emitted.add(key);
    rows.push({ thread, depth, parentThreadKey: parentByKey.get(key) ?? null });
    for (const child of childrenByParent.get(key) ?? []) emit(child, depth + 1);
  };
  const roots = threads
    .filter((thread) => parentByKey.get(workflowThreadKey(thread)) === null)
    .toSorted(sortOldestFirst);
  for (const root of roots) emit(root, 0);
  for (const thread of [...threads].sort(sortOldestFirst)) emit(thread, 0);
  return rows;
}

export function buildWorkflowViewModel<TThread extends WorkflowModelThread>(
  threads: readonly TThread[],
): WorkflowViewModel<TThread> {
  const byKey = new Map(threads.map((thread) => [workflowThreadKey(thread), thread] as const));
  const ownerThreadKeyByThreadKey = new Map<string, string>();
  const membersByOwnerKey = new Map<string, TThread[]>();

  for (const thread of threads) {
    const owner = resolveOwner(thread, byKey);
    const threadKey = workflowThreadKey(thread);
    const ownerKey = workflowThreadKey(owner);
    ownerThreadKeyByThreadKey.set(threadKey, ownerKey);
    const members = membersByOwnerKey.get(ownerKey);
    if (members) members.push(thread);
    else membersByOwnerKey.set(ownerKey, [thread]);
  }

  const rootsByThreadKey = new Map<string, WorkflowRoot<TThread>>();
  for (const [ownerKey, members] of membersByOwnerKey) {
    const owner = byKey.get(ownerKey);
    if (!owner) continue;
    const descendants = members.filter((thread) => workflowThreadKey(thread) !== ownerKey);
    const grouped = new Map<
      string,
      { kind: WorkflowGroup<TThread>["kind"]; sourceId: string; threads: TThread[] }
    >();
    for (const thread of descendants) {
      const contextId = thread.workflowContext?.workflowId;
      const batchId = thread.workflowSubagentBatchProvenance?.batchId;
      const kind = contextId ? "workflow" : batchId ? "batch" : "legacy";
      const sourceId = contextId ?? batchId ?? resolveLegacyBranchKey(thread, owner, byKey);
      const groupId = `${kind}:${sourceId}`;
      const group = grouped.get(groupId);
      if (group) group.threads.push(thread);
      else grouped.set(groupId, { kind, sourceId, threads: [thread] });
    }

    const groupIdByThreadKey = new Map<string, string>();
    const groupIdByWorkflowId = new Map<string, string>();
    for (const [groupId, group] of grouped) {
      if (group.kind === "workflow") groupIdByWorkflowId.set(group.sourceId, groupId);
      for (const thread of group.threads) {
        groupIdByThreadKey.set(workflowThreadKey(thread), groupId);
      }
    }

    const parentGroupIdById = new Map<string, string | null>();
    for (const [groupId, group] of grouped) {
      const declaredParentWorkflowId = group.threads.find(
        (thread) => thread.workflowContext?.parentWorkflowId != null,
      )?.workflowContext?.parentWorkflowId;
      const declaredParentGroupId =
        declaredParentWorkflowId === undefined || declaredParentWorkflowId === null
          ? undefined
          : groupIdByWorkflowId.get(declaredParentWorkflowId);
      if (declaredParentGroupId !== undefined && declaredParentGroupId !== groupId) {
        parentGroupIdById.set(groupId, declaredParentGroupId);
        continue;
      }
      let parentGroupId: string | null = null;
      for (const thread of [...group.threads].sort(sortOldestFirst)) {
        let parentThreadId = thread.parentThreadId;
        const visited = new Set<string>();
        while (parentThreadId !== null) {
          const parentKey = `${thread.environmentId}:${parentThreadId}`;
          if (visited.has(parentKey)) break;
          visited.add(parentKey);
          const candidateGroupId = groupIdByThreadKey.get(parentKey);
          if (candidateGroupId !== undefined && candidateGroupId !== groupId) {
            parentGroupId = candidateGroupId;
            break;
          }
          const parent = byKey.get(parentKey);
          if (!parent) break;
          parentThreadId = parent.parentThreadId;
        }
        if (parentGroupId !== null) break;
      }
      parentGroupIdById.set(groupId, parentGroupId);
    }

    // Corrupt cross-workflow ancestry must not make the group renderer recurse
    // forever. Break every group edge participating in a cycle, matching the
    // thread-row cycle handling above.
    for (const startId of grouped.keys()) {
      const path: string[] = [];
      const indexById = new Map<string, number>();
      let currentId: string | null = startId;
      while (currentId !== null) {
        const cycleIndex = indexById.get(currentId);
        if (cycleIndex !== undefined) {
          for (const cycleId of path.slice(cycleIndex)) parentGroupIdById.set(cycleId, null);
          break;
        }
        indexById.set(currentId, path.length);
        path.push(currentId);
        currentId = parentGroupIdById.get(currentId) ?? null;
      }
    }

    const depthByGroupId = new Map<string, number>();
    const resolveGroupDepth = (groupId: string): number => {
      const cached = depthByGroupId.get(groupId);
      if (cached !== undefined) return cached;
      const parentGroupId = parentGroupIdById.get(groupId) ?? null;
      const depth = parentGroupId === null ? 0 : resolveGroupDepth(parentGroupId) + 1;
      depthByGroupId.set(groupId, depth);
      return depth;
    };

    const unorderedGroups = [...grouped.entries()].map(([id, group]): WorkflowGroup<TThread> => {
      const rows = buildGroupRows(group.threads);
      const statuses = rows.map((row) => resolveWorkflowThreadStatus(row.thread));
      const activeCount = statuses.filter(workflowStatusIsActive).length;
      return {
        id,
        kind: group.kind,
        sourceId: group.sourceId,
        parentGroupId: parentGroupIdById.get(id) ?? null,
        depth: resolveGroupDepth(id),
        createdAt: group.threads.reduce(
          (earliest, thread) =>
            timestampMs(thread.createdAt) < timestampMs(earliest) ? thread.createdAt : earliest,
          group.threads[0]?.createdAt ?? owner.createdAt,
        ),
        preset:
          group.threads.find((thread) => thread.workflowPreset != null)?.workflowPreset ??
          (group.kind === "workflow" ? owner.workflowPreset : null) ??
          null,
        rows,
        activeCount,
        settledCount: statuses.length - activeCount,
        isActive: activeCount > 0,
      };
    });

    const compareGroups = (left: WorkflowGroup<TThread>, right: WorkflowGroup<TThread>) =>
      timestampMs(left.createdAt) - timestampMs(right.createdAt) || left.id.localeCompare(right.id);
    const childrenByParentId = new Map<string, WorkflowGroup<TThread>[]>();
    for (const group of unorderedGroups) {
      if (group.parentGroupId === null) continue;
      const children = childrenByParentId.get(group.parentGroupId);
      if (children) children.push(group);
      else childrenByParentId.set(group.parentGroupId, [group]);
    }
    for (const children of childrenByParentId.values()) children.sort(compareGroups);

    // Workflow cards follow the generated step tree: a parent run comes first,
    // followed immediately by its sub-workflows in creation order.
    const groups: WorkflowGroup<TThread>[] = [];
    const emittedGroups = new Set<string>();
    const emitGroup = (group: WorkflowGroup<TThread>) => {
      if (emittedGroups.has(group.id)) return;
      emittedGroups.add(group.id);
      groups.push(group);
      for (const child of childrenByParentId.get(group.id) ?? []) emitGroup(child);
    };
    for (const group of unorderedGroups
      .filter((candidate) => candidate.parentGroupId === null)
      .sort(compareGroups)) {
      emitGroup(group);
    }
    for (const group of unorderedGroups.sort(compareGroups)) emitGroup(group);

    rootsByThreadKey.set(ownerKey, { root: owner, members, groups });
  }

  return {
    ownerThreadKeyByThreadKey,
    rootsByThreadKey,
    topLevelThreads: threads.filter((thread) => thread.parentThreadId === null),
  };
}

export function selectWorkflowRootForThread<TThread extends WorkflowModelThread>(
  model: WorkflowViewModel<TThread>,
  thread: Pick<WorkflowModelThread, "environmentId" | "id"> | null | undefined,
): WorkflowRoot<TThread> | null {
  if (!thread) return null;
  const threadKey = workflowThreadKey(thread);
  const ownerKey = model.ownerThreadKeyByThreadKey.get(threadKey) ?? threadKey;
  return model.rootsByThreadKey.get(ownerKey) ?? null;
}
