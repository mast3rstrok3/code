import { groupStackPodLogEntriesByService } from "@t3tools/client-runtime/app-stack-logs";
import type { AppStack, AppStackPodLogEntry } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  appStackLifecycle,
  appStackLogListItems,
  showThreadAppStackChip,
} from "./appStackPresentation";

const makeStack = (input: Partial<AppStack> = {}): AppStack => ({
  id: "hero-dev",
  uuid: "hero-dev",
  userId: "user-1",
  worktreePath: "/repo/hero",
  composePath: "infra/compose/compose.app-dev.yml",
  displayName: "hero",
  description: null,
  status: "running",
  namespace: "hero-dev",
  services: [],
  serviceCount: 0,
  lastError: null,
  errorCount: 0,
  createdAt: "2026-06-25T00:00:00.000Z",
  updatedAt: "2026-06-25T00:00:00.000Z",
  ...input,
});

const makeEntry = (input: Partial<AppStackPodLogEntry> = {}): AppStackPodLogEntry => ({
  podName: "web-7cdbbbfdd8-l9mpx",
  containerName: "web",
  phase: "Running",
  ready: true,
  restartCount: 0,
  state: "running",
  ownerKind: "ReplicaSet",
  ownerName: "web-7cdbbbfdd8",
  logs: "listening",
  error: null,
  fetchedAt: "2026-06-25T00:00:00.000Z",
  ...input,
});

describe("appStackLifecycle", () => {
  it("offers start for an idle stack and stop for a live one", () => {
    expect(appStackLifecycle(makeStack({ status: "stopped" }))).toEqual({
      start: "create",
      canStop: false,
    });
    expect(appStackLifecycle(makeStack({ status: "running" }))).toEqual({
      start: null,
      canStop: true,
    });
    expect(appStackLifecycle(makeStack({ status: "stopping" })).canStop).toBe(false);
  });

  it("starts a stopped bundle through restart so it keeps its shape", () => {
    expect(appStackLifecycle(makeStack({ status: "error", bundleId: "bundle-1" })).start).toBe(
      "restart",
    );
  });
});

describe("showThreadAppStackChip", () => {
  it("hides the chip when there is no stack or it is stopped", () => {
    expect(showThreadAppStackChip(null)).toBe(false);
    expect(showThreadAppStackChip(makeStack({ status: "stopped" }))).toBe(false);
    expect(showThreadAppStackChip(makeStack({ status: "starting" }))).toBe(true);
    expect(showThreadAppStackChip(makeStack({ status: "error" }))).toBe(true);
  });
});

describe("appStackLogListItems", () => {
  const groups = groupStackPodLogEntriesByService([
    makeEntry(),
    makeEntry({ containerName: "sidecar" }),
    makeEntry({
      podName: "api-5d8f9c7b6a-x2k9p",
      containerName: "api",
      ownerName: "api-5d8f9c7b6a",
    }),
  ]);

  it("puts each service header before its containers", () => {
    expect(appStackLogListItems(groups, new Set()).map((item) => item.key)).toEqual([
      "service:web",
      "entry:web:web-7cdbbbfdd8-l9mpx:web",
      "entry:web:web-7cdbbbfdd8-l9mpx:sidecar",
      "service:api",
      "entry:api:api-5d8f9c7b6a-x2k9p:api",
    ]);
  });

  it("keeps only the header of a collapsed service", () => {
    const items = appStackLogListItems(groups, new Set(["web"]));
    expect(items.map((item) => item.key)).toEqual([
      "service:web",
      "service:api",
      "entry:api:api-5d8f9c7b6a-x2k9p:api",
    ]);
    expect(items[0]).toMatchObject({ kind: "service", collapsed: true });
  });
});
