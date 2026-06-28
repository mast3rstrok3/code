import type { AppDevStackPod, AppDevStackPodLogEntry } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  countStackLogContainers,
  filterStackPodLogEntries,
  formatStackPodLogsForClipboard,
  groupStackPodLogEntriesByService,
  resolveCurrentStackPath,
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

describe("resolveCurrentStackPath", () => {
  it("uses active worktree, then git cwd, then workspace root", () => {
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
    ).toBe("/repo/git");
    expect(
      resolveCurrentStackPath({
        activeThreadWorktreePath: "",
        gitCwd: null,
        workspaceRoot: "/repo/root/",
      }),
    ).toBe("/repo/root");
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
