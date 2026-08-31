import type { AppStack, AppStackAutoCreateResult, AppStackPod } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  appStackBulkDeleteConfirmation,
  appStackBulkDeleteFailureMessage,
  appStackOwnershipLabel,
  appStackProtectionAction,
  appStackSelectionState,
  appStackWorkflowConflictSummary,
  autoCreateNotice,
  isProtectedAppStack,
  normalizePreviewHref,
  orderAppStacksForPanel,
  previewForPod,
  primaryPreviewForStack,
  reconcileAppStackIds,
  shouldPollAppStacks,
} from "./AppStackPanel.logic";

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

const makePod = (input: Partial<AppStackPod> = {}): AppStackPod => ({
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

describe("AppStackPanel URL helpers", () => {
  it("polls while a current or listed stack is transitioning", () => {
    expect(shouldPollAppStacks(makeStack({ status: "starting" }), [])).toBe(true);
    expect(shouldPollAppStacks(makeStack(), [makeStack({ status: "stopping" })])).toBe(true);
    expect(shouldPollAppStacks(makeStack(), [makeStack()])).toBe(false);
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

describe("AppStackPanel list management", () => {
  it("labels workflow ownership and summarizes non-destructive conflicts", () => {
    expect(appStackOwnershipLabel(makeStack({ workflowId: "workflow-1" }))).toBe("Workflow-owned");
    expect(appStackOwnershipLabel(makeStack({}))).toBeNull();
    expect(
      appStackWorkflowConflictSummary({
        workflowId: "workflow-1",
        stackIds: ["one", "two"],
        runIds: ["run-one", "run-two"],
        worktreePaths: ["/one", "/two"],
      }),
    ).toBe("2 stacks · workflow-1");
  });

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
      orderAppStacksForPanel({
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
      orderAppStacksForPanel({
        currentStack: current,
        listedStacks: [other],
        currentWorktreePath: "/repo/current",
      }).map((stack) => stack.id),
    ).toEqual(["current", "other"]);
  });

  it("reconciles stale selection and derives tri-state select-all state", () => {
    const first = makeStack({ id: "first" });
    const second = makeStack({ id: "second" });
    const reconciled = reconcileAppStackIds(new Set(["first", "missing"]), [first, second]);

    expect(reconciled).toEqual(new Set(["first"]));
    expect(appStackSelectionState(reconciled, [first, second])).toEqual({
      checked: false,
      indeterminate: true,
    });
    expect(appStackSelectionState(new Set(["first", "second"]), [first, second])).toEqual({
      checked: true,
      indeterminate: false,
    });
    expect(appStackSelectionState(new Set(), [first, second])).toEqual({
      checked: false,
      indeterminate: false,
    });
  });

  it("builds bulk-delete confirmation and partial failure copy", () => {
    expect(appStackBulkDeleteConfirmation(2)).toBe(
      "Delete 2 App Stacks?\nThis will remove their Kubernetes namespaces.",
    );
    expect(appStackBulkDeleteConfirmation(1)).toBe(
      "Delete 1 App Stack?\nThis will remove its Kubernetes namespace.",
    );
    expect(
      appStackBulkDeleteFailureMessage(
        [{ stack: makeStack({ id: "broken", displayName: "Broken stack" }), message: "Denied" }],
        3,
      ),
    ).toBe("Failed to delete 1 of 3 App Stacks. Broken stack: Denied");
    expect(appStackBulkDeleteFailureMessage([], 2)).toBeNull();
  });
});

describe("autoCreateNotice", () => {
  const makeResult = (input: Partial<AppStackAutoCreateResult> = {}): AppStackAutoCreateResult => ({
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
        message: "An app stack for this worktree/branch is already running.",
        frontendUrl: "https://code-feat-x-frontend-a1b2c3d4-dev.example.test",
      }),
    );

    expect(notice).toEqual({
      kind: "already-running",
      message: "An app stack for this worktree/branch is already running.",
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

describe("app stack protection", () => {
  it("reads protection defensively so an older server is not shown as protected", () => {
    expect(isProtectedAppStack(makeStack({}))).toBe(false);
    expect(isProtectedAppStack(makeStack({ protected: null }))).toBe(false);
    expect(isProtectedAppStack(makeStack({ protected: true }))).toBe(true);
  });

  it("labels the toggle by what pressing it does", () => {
    const unprotected = appStackProtectionAction(makeStack({ displayName: "hero" }));
    expect(unprotected.label).toBe("Protect");
    expect(unprotected.nextProtected).toBe(true);
    expect(unprotected.ariaLabel).toBe("Protect hero from automatic teardown");

    const guarded = appStackProtectionAction(makeStack({ displayName: "hero", protected: true }));
    expect(guarded.label).toBe("Protected");
    expect(guarded.nextProtected).toBe(false);
    expect(guarded.ariaLabel).toBe("Stop protecting hero from automatic teardown");
  });
});
