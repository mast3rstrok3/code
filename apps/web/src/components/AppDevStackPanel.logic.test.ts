import type { AppDevStack, AppDevStackAutoCreateResult, AppDevStackPod } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  appDevStackBulkDeleteConfirmation,
  appDevStackBulkDeleteFailureMessage,
  appDevStackSelectionState,
  autoCreateNotice,
  normalizePreviewHref,
  orderAppDevStacksForPanel,
  previewForPod,
  primaryPreviewForStack,
  reconcileAppDevStackIds,
  shouldPollAppDevStacks,
} from "./AppDevStackPanel.logic";

const makeStack = (input: Partial<AppDevStack> = {}): AppDevStack => ({
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

const makePod = (input: Partial<AppDevStackPod> = {}): AppDevStackPod => ({
  name: "web-7cdbbbfdd8-l9mpx",
  phase: "Running",
  readyContainerCount: 1,
  totalContainerCount: 1,
  restartCount: 0,
  ownerKind: "ReplicaSet",
  ownerName: "web-7cdbbbfdd8",
  containers: [{ name: "web", ready: true, restartCount: 0, state: "running" }],
  ...input,
});

describe("AppDevStackPanel URL helpers", () => {
  it("polls while a current or listed stack is transitioning", () => {
    expect(shouldPollAppDevStacks(makeStack({ status: "starting" }), [])).toBe(true);
    expect(shouldPollAppDevStacks(makeStack(), [makeStack({ status: "stopping" })])).toBe(true);
    expect(shouldPollAppDevStacks(makeStack(), [makeStack()])).toBe(false);
  });

  it("prefers frontend aliases when choosing the primary stack preview", () => {
    const stack = makeStack({
      services: [
        { name: "backend", status: "running", previewUrl: "https://api-hero-dev.example.test" },
        { name: "web", status: "running", previewUrl: "https://hero-dev.example.test" },
      ],
      previewUrls: {
        backend: "https://api-hero-dev.example.test",
        web: "https://hero-dev.example.test",
      },
    });

    expect(primaryPreviewForStack(stack)).toEqual({
      serviceName: "web",
      url: "https://hero-dev.example.test/",
    });
  });

  it("also treats app as a frontend alias", () => {
    const stack = makeStack({
      services: [
        { name: "backend", status: "running", previewUrl: "https://api-hero-dev.example.test" },
        { name: "app", status: "running", previewUrl: "https://hero-dev.example.test" },
      ],
    });

    expect(primaryPreviewForStack(stack)?.serviceName).toBe("app");
  });

  it("prefers an explicit pod preview URL", () => {
    const stack = makeStack();
    const pod = makePod({
      previewUrl: "https://explicit.example.test",
      previewServiceName: "keycloak",
    });

    expect(previewForPod(pod, stack)).toEqual({
      serviceName: "keycloak",
      url: "https://explicit.example.test/",
    });
  });

  it("falls back to matching pod containers against stack service URLs", () => {
    const stack = makeStack({
      services: [{ name: "web", status: "running", previewUrl: "https://hero-dev.example.test" }],
      previewUrls: { web: "https://hero-dev.example.test" },
    });

    expect(previewForPod(makePod(), stack)).toEqual({
      serviceName: "web",
      url: "https://hero-dev.example.test/",
    });
  });

  it("does not return invalid preview hrefs", () => {
    const stack = makeStack({
      services: [{ name: "web", status: "running", previewUrl: "javascript:alert(1)" }],
      previewUrls: { web: "javascript:alert(1)" },
    });

    expect(normalizePreviewHref("javascript:alert(1)")).toBe(null);
    expect(previewForPod(makePod(), stack)).toBe(null);
  });
});

describe("AppDevStackPanel list management", () => {
  it("shows the current stack once and orders remaining stacks by update time", () => {
    const current = makeStack({ id: "current", worktreePath: "/repo/current" });
    const older = makeStack({
      id: "older",
      worktreePath: "/repo/older",
      updatedAt: "2026-06-24T00:00:00.000Z",
    });
    const newer = makeStack({
      id: "newer",
      worktreePath: "/repo/newer",
      updatedAt: "2026-06-26T00:00:00.000Z",
    });

    expect(
      orderAppDevStacksForPanel({
        currentStack: current,
        listedStacks: [older, current, newer],
        currentWorktreePath: "/repo/current/",
      }).map((stack) => stack.id),
    ).toEqual(["current", "newer", "older"]);
  });

  it("includes current-query data when the general list is stale", () => {
    const current = makeStack({ id: "current", worktreePath: "/repo/current" });
    const other = makeStack({ id: "other", worktreePath: "/repo/other" });

    expect(
      orderAppDevStacksForPanel({
        currentStack: current,
        listedStacks: [other],
        currentWorktreePath: "/repo/current",
      }).map((stack) => stack.id),
    ).toEqual(["current", "other"]);
  });

  it("reconciles stale selection and derives tri-state select-all state", () => {
    const first = makeStack({ id: "first" });
    const second = makeStack({ id: "second" });
    const reconciled = reconcileAppDevStackIds(new Set(["first", "missing"]), [first, second]);

    expect(reconciled).toEqual(new Set(["first"]));
    expect(appDevStackSelectionState(reconciled, [first, second])).toEqual({
      checked: false,
      indeterminate: true,
    });
    expect(appDevStackSelectionState(new Set(["first", "second"]), [first, second])).toEqual({
      checked: true,
      indeterminate: false,
    });
    expect(appDevStackSelectionState(new Set(), [first, second])).toEqual({
      checked: false,
      indeterminate: false,
    });
  });

  it("builds bulk-delete confirmation and partial failure copy", () => {
    expect(appDevStackBulkDeleteConfirmation(2)).toBe(
      "Delete 2 App Stacks?\nThis will remove their Kubernetes namespaces.",
    );
    expect(appDevStackBulkDeleteConfirmation(1)).toBe(
      "Delete 1 App Stack?\nThis will remove its Kubernetes namespace.",
    );
    expect(
      appDevStackBulkDeleteFailureMessage(
        [{ stack: makeStack({ id: "broken", displayName: "Broken stack" }), message: "Denied" }],
        3,
      ),
    ).toBe("Failed to delete 1 of 3 App Stacks. Broken stack: Denied");
    expect(appDevStackBulkDeleteFailureMessage([], 2)).toBeNull();
  });
});

describe("autoCreateNotice", () => {
  const makeResult = (
    input: Partial<AppDevStackAutoCreateResult> = {},
  ): AppDevStackAutoCreateResult => ({
    stack: makeStack(),
    created: true,
    frontendUrl: null,
    frontendServiceName: null,
    ...input,
  });

  it("returns null for fresh creates", () => {
    expect(autoCreateNotice(makeResult())).toBe(null);
  });

  it("reports an already-running stack with its URL and id", () => {
    const notice = autoCreateNotice(
      makeResult({
        created: false,
        alreadyRunning: true,
        message: "An app dev stack for this worktree/branch is already running.",
        frontendUrl: "https://code-feat-x-frontend-a1b2c3d4-dev.example.test",
      }),
    );

    expect(notice).toEqual({
      kind: "already-running",
      message: "An app dev stack for this worktree/branch is already running.",
      url: "https://code-feat-x-frontend-a1b2c3d4-dev.example.test",
      stackId: "hero-dev",
    });
  });

  it("reports reserved branches without a stack", () => {
    const notice = autoCreateNotice(
      makeResult({
        created: false,
        reserved: true,
        stack: null,
        message: null,
        frontendUrl: "https://code-dev.example.test",
      }),
    );

    expect(notice).toEqual({
      kind: "reserved",
      message: "This branch is served by the standing deployment; no dev stack was created.",
      url: "https://code-dev.example.test",
      stackId: null,
    });
  });
});
