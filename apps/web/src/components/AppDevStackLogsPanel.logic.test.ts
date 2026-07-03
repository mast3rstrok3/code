import type {
  AppDevStack,
  AppDevStackDiscoveredStackPodLogs,
  AppDevStackPod,
  AppDevStackPodLogEntry,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildAssociatedStackPodLogsResult,
  buildStackPodLogViews,
  countStackLogContainers,
  filterStackPodLogEntries,
  formatAllStackPodLogsForClipboard,
  formatStackPodLogsForClipboard,
  groupStackPodLogEntriesByService,
  isSameOrChildStackPath,
  resolveCurrentStackPath,
  stackLogReadLimitLabel,
  stackLogTailSelectionLabel,
  stackLogTailSelectionToReadLimit,
} from "./AppDevStackLogsPanel.logic";

const backendEntry: AppDevStackPodLogEntry = {
  podName: "backend-abc",
  containerName: "backend",
  phase: "Running",
  ready: true,
  restartCount: 0,
  state: "running",
  ownerKind: "ReplicaSet",
  ownerName: "backend",
  logs: "server listening\n",
  error: null,
  fetchedAt: "2026-06-25T00:00:00.000Z",
};
const frontendEntry: AppDevStackPodLogEntry = {
  podName: "frontend-def",
  containerName: "vite",
  phase: "Running",
  ready: true,
  restartCount: 1,
  state: "running",
  ownerKind: "ReplicaSet",
  ownerName: "frontend",
  logs: "ready in 120ms\n",
  error: null,
  fetchedAt: "2026-06-25T00:00:01.000Z",
};
const redisErrorEntry: AppDevStackPodLogEntry = {
  podName: "redis-ghi",
  containerName: "redis",
  phase: "Pending",
  ready: false,
  restartCount: 2,
  state: "CrashLoopBackOff",
  ownerKind: "StatefulSet",
  ownerName: "redis",
  logs: "",
  error: "pod is restarting",
  fetchedAt: "2026-06-25T00:00:02.000Z",
};
const emptyMinioEntry: AppDevStackPodLogEntry = {
  podName: "minio-jkl",
  containerName: "minio",
  phase: "Running",
  ready: true,
  restartCount: 0,
  state: "running",
  ownerKind: "Deployment",
  ownerName: "minio",
  logs: "",
  error: null,
  fetchedAt: "2026-06-25T00:00:03.000Z",
};
const entries: AppDevStackPodLogEntry[] = [
  backendEntry,
  frontendEntry,
  redisErrorEntry,
  emptyMinioEntry,
];

const makeStack = (input: Partial<AppDevStack> & Pick<AppDevStack, "id" | "worktreePath">) => {
  const { id, worktreePath, ...rest } = input;
  return {
    id,
    uuid: rest.uuid ?? id,
    userId: rest.userId ?? "user-1",
    worktreePath,
    composePath: rest.composePath ?? "infra/compose/compose.app-dev.yml",
    displayName: rest.displayName ?? null,
    description: rest.description ?? null,
    status: rest.status ?? "running",
    services: rest.services ?? null,
    serviceCount: rest.serviceCount ?? 0,
    lastError: rest.lastError ?? null,
    errorCount: rest.errorCount ?? 0,
    createdAt: rest.createdAt ?? "2026-06-25T00:00:00.000Z",
    updatedAt: rest.updatedAt ?? "2026-06-25T00:00:00.000Z",
    ...rest,
  } satisfies AppDevStack;
};

const makeDiscoveredStack = (
  input: Pick<AppDevStackDiscoveredStackPodLogs, "stackId" | "namespace" | "entries"> &
    Partial<AppDevStackDiscoveredStackPodLogs>,
): AppDevStackDiscoveredStackPodLogs => ({
  stackId: input.stackId,
  namespace: input.namespace,
  displayName: input.displayName ?? input.namespace,
  displaySlug: input.displaySlug ?? null,
  repoName: input.repoName ?? input.namespace.replace(/-dev$/u, ""),
  branchName: input.branchName ?? null,
  worktreePath: input.worktreePath ?? `/repo/${input.namespace}`,
  managedBy: input.managedBy ?? null,
  limit: input.limit ?? { mode: "tail", tailLines: 300 },
  pods:
    input.pods ??
    input.entries.map((entry) => ({
      name: entry.podName,
      phase: entry.phase,
      readyContainerCount: entry.ready ? 1 : 0,
      totalContainerCount: 1,
      restartCount: entry.restartCount,
      createdAt: null,
      nodeName: null,
      ownerKind: entry.ownerKind,
      ownerName: entry.ownerName,
      containers: [
        {
          name: entry.containerName,
          ready: entry.ready,
          restartCount: entry.restartCount,
          state: entry.state,
        },
      ],
    })),
  entries: input.entries,
  error: input.error ?? null,
  fetchedAt: input.fetchedAt ?? "2026-06-25T00:00:10.000Z",
});

describe("resolveCurrentStackPath", () => {
  it("uses the workspace root when the active worktree path is nested inside it", () => {
    expect(
      resolveCurrentStackPath({
        activeThreadWorktreePath: "/repo/root/apps/server",
        gitCwd: "/repo/root/apps/server",
        workspaceRoot: "/repo/root/",
      }),
    ).toBe("/repo/root");
  });

  it("uses active worktree, then workspace root, then git cwd", () => {
    expect(
      resolveCurrentStackPath({
        activeThreadWorktreePath: "/repo/worktree/",
        gitCwd: "/repo/git",
        workspaceRoot: "/repo/root",
      }),
    ).toBe("/repo/worktree");
    expect(
      resolveCurrentStackPath({
        activeThreadWorktreePath: null,
        gitCwd: "/repo/git/",
        workspaceRoot: "/repo/root",
      }),
    ).toBe("/repo/root");
    expect(
      resolveCurrentStackPath({
        activeThreadWorktreePath: "",
        gitCwd: "/repo/git/",
        workspaceRoot: null,
      }),
    ).toBe("/repo/git");
  });
});

describe("isSameOrChildStackPath", () => {
  it("matches exact and descendant paths only", () => {
    expect(isSameOrChildStackPath("/repo/root", "/repo/root/")).toBe(true);
    expect(isSameOrChildStackPath("/repo/root/apps/server", "/repo/root")).toBe(true);
    expect(isSameOrChildStackPath("/repo/root-other", "/repo/root")).toBe(false);
  });
});

describe("filterStackPodLogEntries", () => {
  it("filters by pod name, container name, service owner, and log text", () => {
    expect(filterStackPodLogEntries(entries, { search: "frontend-def", hideEmpty: false })).toEqual(
      [frontendEntry],
    );
    expect(filterStackPodLogEntries(entries, { search: "vite", hideEmpty: false })).toEqual([
      frontendEntry,
    ]);
    expect(filterStackPodLogEntries(entries, { search: "backend", hideEmpty: false })).toEqual([
      backendEntry,
    ]);
    expect(filterStackPodLogEntries(entries, { search: "listening", hideEmpty: false })).toEqual([
      backendEntry,
    ]);
  });

  it("hides empty logs without hiding per-container errors", () => {
    expect(filterStackPodLogEntries(entries, { search: "", hideEmpty: true })).toEqual([
      backendEntry,
      frontendEntry,
      redisErrorEntry,
    ]);
  });
});

describe("groupStackPodLogEntriesByService", () => {
  it("groups generated pods by their owning service", () => {
    const backendContainerEntry: AppDevStackPodLogEntry = {
      ...backendEntry,
      podName: "backend-6797f5894c-7hx7b",
      ownerName: "backend-6797f5894c",
    };
    const backendWorkerEntry: AppDevStackPodLogEntry = {
      ...backendEntry,
      podName: "backend-6797f5894c-9q2kx",
      containerName: "worker",
      logs: "worker listening\n",
      ownerName: "backend-6797f5894c",
    };
    const codexRunnerEntry: AppDevStackPodLogEntry = {
      ...backendEntry,
      podName: "codex-runner-745ff49b99-km2qn",
      containerName: "runner",
      logs: "runner ready\n",
      ownerName: "codex-runner-745ff49b99",
    };
    const generatedFrontendEntry: AppDevStackPodLogEntry = {
      ...frontendEntry,
      podName: "frontend-7b9b4fb858-jpl26",
      ownerName: "frontend-7b9b4fb858",
    };
    const keycloakEntry: AppDevStackPodLogEntry = {
      ...frontendEntry,
      podName: "keycloak-0",
      containerName: "keycloak",
      ownerKind: "StatefulSet",
      ownerName: "keycloak",
      logs: "keycloak ready\n",
    };

    const groups = groupStackPodLogEntriesByService([
      backendContainerEntry,
      backendWorkerEntry,
      codexRunnerEntry,
      generatedFrontendEntry,
      keycloakEntry,
    ]);

    expect(
      groups.map((group) => ({
        serviceKey: group.serviceKey,
        serviceName: group.serviceName,
        pods: group.pods.map((pod) => ({
          podName: pod.podName,
          containers: pod.entries.map((entry) => entry.containerName),
        })),
      })),
    ).toEqual([
      {
        serviceKey: "backend",
        serviceName: "Back End",
        pods: [
          { podName: "backend-6797f5894c-7hx7b", containers: ["backend"] },
          { podName: "backend-6797f5894c-9q2kx", containers: ["worker"] },
        ],
      },
      {
        serviceKey: "codex-runner",
        serviceName: "Codex Runner",
        pods: [{ podName: "codex-runner-745ff49b99-km2qn", containers: ["runner"] }],
      },
      {
        serviceKey: "frontend",
        serviceName: "Front End",
        pods: [{ podName: "frontend-7b9b4fb858-jpl26", containers: ["vite"] }],
      },
      {
        serviceKey: "keycloak",
        serviceName: "Keycloak",
        pods: [{ podName: "keycloak-0", containers: ["keycloak"] }],
      },
    ]);
  });

  it("tracks empty and error counts per service", () => {
    const groups = groupStackPodLogEntriesByService([redisErrorEntry, emptyMinioEntry]);

    expect(
      groups.map((group) => ({
        serviceKey: group.serviceKey,
        entryCount: group.entryCount,
        emptyCount: group.emptyCount,
        errorCount: group.errorCount,
      })),
    ).toEqual([
      { serviceKey: "redis", entryCount: 1, emptyCount: 0, errorCount: 1 },
      { serviceKey: "minio", entryCount: 1, emptyCount: 1, errorCount: 0 },
    ]);
  });
});

describe("buildStackPodLogViews", () => {
  it("groups and filters logs across multiple discovered stacks", () => {
    const heroStack = makeDiscoveredStack({
      stackId: "hero-stack",
      namespace: "hero-dev",
      displayName: "Hero",
      entries: [backendEntry, emptyMinioEntry],
    });
    const rudiStack = makeDiscoveredStack({
      stackId: "rudi-dev",
      namespace: "rudi-dev",
      displayName: "Rudi",
      entries: [frontendEntry, redisErrorEntry],
    });

    const views = buildStackPodLogViews([heroStack, rudiStack], {
      search: "rudi",
      hideEmpty: true,
    });

    expect(
      views.map((view) => ({
        namespace: view.stack.namespace,
        stackName: view.stackName,
        services: view.serviceGroups.map((group) => group.serviceKey),
        containers: view.filteredEntries.map((entry) => entry.containerName),
      })),
    ).toEqual([
      {
        namespace: "rudi-dev",
        stackName: "Rudi",
        services: ["frontend", "redis"],
        containers: ["vite", "redis"],
      },
    ]);
  });

  it("keeps stack-level failures visible when filters remove all entries", () => {
    const failedStack = makeDiscoveredStack({
      stackId: "hero-stack",
      namespace: "hero-dev",
      entries: [],
      error: "pod list failed",
    });

    const views = buildStackPodLogViews([failedStack], {
      search: "missing",
      hideEmpty: true,
    });

    expect(views).toHaveLength(1);
    expect(views[0]?.stack.error).toBe("pod list failed");
  });
});

describe("buildAssociatedStackPodLogsResult", () => {
  it("wraps stack-specific pod logs in the shared result shape", () => {
    const stack = makeStack({
      id: "hero-stack",
      displayName: "Hero",
      displaySlug: "hero",
      repoName: "hero",
      branchName: "feature/logs",
      worktreePath: "/repo/worktrees/hero",
    });
    const discovered = makeDiscoveredStack({
      stackId: "hero-stack",
      namespace: "hero-dev",
      entries: [backendEntry],
    });
    const result = buildAssociatedStackPodLogsResult({
      stack,
      limit: { mode: "tail", tailLines: 1000 },
      result: {
        stackId: "hero-stack",
        namespace: "hero-dev",
        tailLines: 1000,
        pods: discovered.pods,
        entries: [backendEntry],
        fetchedAt: "2026-06-25T00:00:11.000Z",
      },
    });

    expect(result).toEqual({
      limit: { mode: "tail", tailLines: 1000 },
      fetchedAt: "2026-06-25T00:00:11.000Z",
      stacks: [
        {
          stackId: "hero-stack",
          namespace: "hero-dev",
          displayName: "Hero",
          displaySlug: "hero",
          repoName: "hero",
          branchName: "feature/logs",
          worktreePath: "/repo/worktrees/hero",
          managedBy: null,
          limit: { mode: "tail", tailLines: 1000 },
          pods: discovered.pods,
          entries: [backendEntry],
          error: null,
          fetchedAt: "2026-06-25T00:00:11.000Z",
        },
      ],
    });
  });
});

describe("formatStackPodLogsForClipboard", () => {
  it("includes pod and container headers plus per-container errors", () => {
    const text = formatStackPodLogsForClipboard({
      stackName: "rudi",
      result: {
        namespace: "rudi-dev",
        tailLines: 300,
        fetchedAt: "2026-06-25T00:00:10.000Z",
      },
      entries: [backendEntry, redisErrorEntry],
    });

    expect(text).toContain("App Stack Pod Logs: rudi");
    expect(text).toContain("--- backend-abc / backend ---");
    expect(text).toContain("server listening");
    expect(text).toContain("--- redis-ghi / redis ---");
    expect(text).toContain("error=pod is restarting");
    expect(text).toContain("No log lines returned.");
  });
});

describe("formatAllStackPodLogsForClipboard", () => {
  it("formats multiple stacks with per-stack and per-container errors", () => {
    const text = formatAllStackPodLogsForClipboard({
      result: {
        limit: { mode: "tail", tailLines: 300 },
        fetchedAt: "2026-06-25T00:00:20.000Z",
        stacks: [
          makeDiscoveredStack({
            stackId: "hero-stack",
            namespace: "hero-dev",
            displayName: "Hero",
            entries: [backendEntry, redisErrorEntry],
          }),
          makeDiscoveredStack({
            stackId: "rudi-dev",
            namespace: "rudi-dev",
            displayName: "Rudi",
            entries: [],
            error: "pod list failed",
          }),
        ],
      },
    });

    expect(text).toContain("App Stack Pod Logs");
    expect(text).toContain("== Hero ==");
    expect(text).toContain("Namespace: hero-dev");
    expect(text).toContain("error=pod is restarting");
    expect(text).toContain("== Rudi ==");
    expect(text).toContain("Stack error: pod list failed");
  });
});

describe("stack log tail labels and limits", () => {
  it("maps bounded tails and all-mode for the selector", () => {
    expect(stackLogTailSelectionLabel(300)).toBe("300 lines");
    expect(stackLogTailSelectionLabel("all")).toBe("All");
    expect(stackLogTailSelectionToReadLimit(5000)).toEqual({ mode: "tail", tailLines: 5000 });
    expect(stackLogTailSelectionToReadLimit("all")).toEqual({ mode: "all" });
    expect(stackLogReadLimitLabel({ mode: "all" })).toBe("All available current logs");
  });
});

describe("countStackLogContainers", () => {
  it("counts containers across all pods", () => {
    const pods: AppDevStackPod[] = [
      {
        name: "backend-abc",
        phase: "Running",
        readyContainerCount: 1,
        totalContainerCount: 2,
        restartCount: 0,
        createdAt: null,
        nodeName: null,
        ownerKind: "ReplicaSet",
        ownerName: "backend",
        containers: [
          { name: "backend", ready: true, restartCount: 0, state: "running" },
          { name: "sidecar", ready: true, restartCount: 0, state: "running" },
        ],
      },
      {
        name: "redis-ghi",
        phase: "Pending",
        readyContainerCount: 0,
        totalContainerCount: 1,
        restartCount: 2,
        createdAt: null,
        nodeName: null,
        ownerKind: "StatefulSet",
        ownerName: "redis",
        containers: [{ name: "redis", ready: false, restartCount: 2, state: "waiting" }],
      },
    ];

    expect(countStackLogContainers(pods)).toBe(3);
  });
});
