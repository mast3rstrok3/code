import { describe, expect, it } from "vite-plus/test";

import {
  buildWorkflowViewModel,
  buildWorkflowTimeline,
  buildWorkflowSteps,
  resolveWorkflowGroupTimeRange,
  resolveWorkflowLifecycle,
  resolveWorkflowRollupStatus,
  resolveWorkflowStepTimeRange,
  resolveWorkflowThreadTimeRange,
  resolveWorkflowThreadStatus,
  selectWorkflowRootForThread,
  type WorkflowModelThread,
} from "./workflowModel";

type TestThread = WorkflowModelThread & { readonly title: string };

function thread(id: string, overrides: Partial<TestThread> = {}): TestThread {
  return {
    environmentId: "env",
    id,
    parentThreadId: null,
    workflowRole: null,
    workflowContext: null,
    workflowSubagentBatchProvenance: null,
    workflowPreset: null,
    title: id,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    archivedAt: null,
    settledAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    backgroundLiveness: null,
    latestTurn: null,
    session: null,
    ...overrides,
  };
}

describe("buildWorkflowViewModel", () => {
  it("resolves the same owner from a root and a deeply nested child", () => {
    const root = thread("root");
    const planning = thread("planning", {
      parentThreadId: "root",
      workflowContext: { workflowId: "workflow-a", rootThreadId: "root" },
    });
    const worker = thread("worker", {
      parentThreadId: "planning",
      workflowContext: { workflowId: "workflow-a", rootThreadId: "root" },
    });
    const model = buildWorkflowViewModel([worker, root, planning]);

    expect(selectWorkflowRootForThread(model, root)?.root.id).toBe("root");
    expect(selectWorkflowRootForThread(model, worker)?.root.id).toBe("root");
    expect(model.topLevelThreads.map((candidate) => candidate.id)).toEqual(["root"]);
  });

  it("groups by workflow, then batch provenance, then the first legacy branch", () => {
    const root = thread("root", { workflowPreset: "full-feature" });
    const workflowChild = thread("workflow-child", {
      parentThreadId: "root",
      workflowContext: { workflowId: "workflow-a", rootThreadId: "root" },
      workflowSubagentBatchProvenance: { batchId: "ignored-batch" },
    });
    const batchChild = thread("batch-child", {
      parentThreadId: "root",
      workflowSubagentBatchProvenance: { batchId: "batch-a" },
    });
    const legacyParent = thread("legacy-parent", { parentThreadId: "root" });
    const legacyChild = thread("legacy-child", { parentThreadId: "legacy-parent" });
    const groups = buildWorkflowViewModel([
      root,
      workflowChild,
      batchChild,
      legacyParent,
      legacyChild,
    ]).rootsByThreadKey.get("env:root")?.groups;

    expect(groups?.map((group) => group.id).sort()).toEqual([
      "batch:batch-a",
      "legacy:legacy-parent",
      "workflow:workflow-a",
    ]);
    expect(groups?.flatMap((group) => group.rows.map((row) => row.thread.id)).sort()).toEqual([
      "batch-child",
      "legacy-child",
      "legacy-parent",
      "workflow-child",
    ]);
    expect(groups?.some((group) => group.id === "batch:ignored-batch")).toBe(false);
    expect(groups?.find((group) => group.id === "batch:batch-a")?.preset).toBeNull();
  });

  it("keeps nested Dev Review as its own workflow group under Implementation", () => {
    const root = thread("root", { workflowPreset: "full-feature" });
    const orchestrator = thread("implementation", {
      parentThreadId: "root",
      workflowPreset: "implementation",
      workflowRole: "implementation-orchestrator",
      workflowContext: {
        workflowId: "implementation-run",
        parentWorkflowId: "full-feature-run",
        rootThreadId: "root",
      },
    });
    const controller = thread("dev-review-controller", {
      parentThreadId: "implementation",
      workflowPreset: "dev-review",
      workflowRole: "dev-review-orchestrator",
      workflowContext: {
        workflowId: "dev-review-run",
        parentWorkflowId: "implementation-run",
        rootThreadId: "root",
      },
    });
    const reviewer = thread("dev-review-reviewer", {
      parentThreadId: "dev-review-controller",
      workflowPreset: "dev-review",
      workflowRole: "dev-review-reviewer",
      workflowContext: {
        workflowId: "dev-review-run",
        parentWorkflowId: "implementation-run",
        rootThreadId: "root",
      },
    });

    const groups = buildWorkflowViewModel([
      root,
      orchestrator,
      controller,
      reviewer,
    ]).rootsByThreadKey.get("env:root")?.groups;

    expect(
      groups?.map((group) => [group.id, group.preset, group.parentGroupId, group.depth]),
    ).toEqual([
      ["workflow:implementation-run", "implementation", null, 0],
      ["workflow:dev-review-run", "dev-review", "workflow:implementation-run", 1],
    ]);
    expect(groups?.find((group) => group.id === "workflow:dev-review-run")?.rows).toHaveLength(2);
  });

  it("uses explicit parent workflow identity when thread ancestry is incomplete", () => {
    const root = thread("root");
    const implementation = thread("implementation", {
      parentThreadId: "root",
      workflowContext: { workflowId: "implementation-run", rootThreadId: "root" },
    });
    const detachedReview = thread("detached-review", {
      parentThreadId: "root",
      workflowContext: {
        workflowId: "dev-review-run",
        parentWorkflowId: "implementation-run",
        rootThreadId: "root",
      },
    });

    const groups = buildWorkflowViewModel([
      root,
      detachedReview,
      implementation,
    ]).rootsByThreadKey.get("env:root")?.groups;

    expect(groups?.find((group) => group.sourceId === "dev-review-run")).toMatchObject({
      parentGroupId: "workflow:implementation-run",
      depth: 1,
    });
  });

  it("orders workflow steps oldest first and rows depth-first with deterministic siblings", () => {
    const root = thread("root");
    const older = thread("older", {
      parentThreadId: "root",
      createdAt: "2026-01-02T00:00:00.000Z",
      workflowContext: { workflowId: "older-run", rootThreadId: "root" },
    });
    const newer = thread("newer", {
      parentThreadId: "root",
      createdAt: "2026-01-03T00:00:00.000Z",
      workflowContext: { workflowId: "newer-run", rootThreadId: "root" },
    });
    const siblingB = thread("b", {
      parentThreadId: "newer",
      createdAt: "2026-01-04T00:00:00.000Z",
      workflowContext: { workflowId: "newer-run", rootThreadId: "root" },
    });
    const siblingA = thread("a", {
      parentThreadId: "newer",
      createdAt: "2026-01-04T00:00:00.000Z",
      workflowContext: { workflowId: "newer-run", rootThreadId: "root" },
    });
    const groups = buildWorkflowViewModel([
      siblingB,
      older,
      root,
      siblingA,
      newer,
    ]).rootsByThreadKey.get("env:root")?.groups;

    expect(groups?.map((group) => group.sourceId)).toEqual(["older-run", "newer-run"]);
    expect(groups?.[1]?.rows.map((row) => [row.thread.id, row.depth])).toEqual([
      ["newer", 0],
      ["a", 1],
      ["b", 1],
    ]);
  });

  it("interleaves nested workflows with parent steps by creation time", () => {
    const root = thread("root", { workflowPreset: "fast-feature" });
    const build = thread("build", {
      parentThreadId: "root",
      workflowRole: "fast-feature-implementer",
      workflowContext: { workflowId: "fast-feature-run", rootThreadId: "root" },
      createdAt: "2026-01-01T00:01:00.000Z",
    });
    const controller = thread("dev-review-controller", {
      parentThreadId: "build",
      workflowRole: "dev-review-orchestrator",
      workflowPreset: "dev-review",
      workflowContext: {
        workflowId: "dev-review-run",
        parentWorkflowId: "fast-feature-run",
        rootThreadId: "root",
      },
      createdAt: "2026-01-01T00:02:00.000Z",
    });
    const codeReview = thread("code-review", {
      parentThreadId: "build",
      workflowRole: "implementation-code-reviewer",
      workflowContext: { workflowId: "fast-feature-run", rootThreadId: "root" },
      createdAt: "2026-01-01T00:03:00.000Z",
    });
    const finalValidation = thread("final-validation", {
      parentThreadId: "build",
      workflowRole: "implementation-validator",
      workflowContext: { workflowId: "fast-feature-run", rootThreadId: "root" },
      createdAt: "2026-01-01T00:04:00.000Z",
    });
    const groups = buildWorkflowViewModel([
      finalValidation,
      controller,
      root,
      codeReview,
      build,
    ]).rootsByThreadKey.get("env:root")?.groups;
    const fastFeature = groups?.find((group) => group.sourceId === "fast-feature-run");

    expect(fastFeature && groups ? buildWorkflowTimeline(fastFeature, groups) : []).toMatchObject([
      { kind: "thread", row: { thread: { id: "build" } } },
      { kind: "workflow", group: { sourceId: "dev-review-run" } },
      { kind: "thread", row: { thread: { id: "code-review" } } },
      { kind: "thread", row: { thread: { id: "final-validation" } } },
    ]);
  });

  it("groups adjacent threads with the same role under one chronological step", () => {
    const root = thread("root");
    const workerB = thread("worker-b", {
      parentThreadId: "root",
      workflowRole: "implementation-worker",
      workflowContext: { workflowId: "implementation-run", rootThreadId: "root" },
      createdAt: "2026-01-01T00:02:00.000Z",
    });
    const workerA = thread("worker-a", {
      parentThreadId: "root",
      workflowRole: "implementation-worker",
      workflowContext: { workflowId: "implementation-run", rootThreadId: "root" },
      createdAt: "2026-01-01T00:01:00.000Z",
    });
    const validator = thread("validator", {
      parentThreadId: "root",
      workflowRole: "implementation-validator",
      workflowContext: { workflowId: "implementation-run", rootThreadId: "root" },
      createdAt: "2026-01-01T00:03:00.000Z",
    });
    const groups = buildWorkflowViewModel([validator, root, workerB, workerA]).rootsByThreadKey.get(
      "env:root",
    )?.groups;
    const implementation = groups?.[0];

    expect(
      implementation && groups ? buildWorkflowSteps(implementation, groups) : [],
    ).toMatchObject([
      {
        id: "role:implementation-worker:env:worker-a",
        entries: [
          { kind: "thread", row: { thread: { id: "worker-a" } } },
          { kind: "thread", row: { thread: { id: "worker-b" } } },
        ],
      },
      {
        id: "role:implementation-validator:env:validator",
        entries: [{ kind: "thread", row: { thread: { id: "validator" } } }],
      },
    ]);
  });

  it("keeps repeated non-adjacent roles as separate workflow steps", () => {
    const root = thread("root");
    const firstFix = thread("first-fix", {
      parentThreadId: "root",
      workflowRole: "implementation-fixer",
      workflowContext: { workflowId: "run", rootThreadId: "root" },
      createdAt: "2026-01-01T00:01:00.000Z",
    });
    const review = thread("review", {
      parentThreadId: "root",
      workflowRole: "implementation-code-reviewer",
      workflowContext: { workflowId: "run", rootThreadId: "root" },
      createdAt: "2026-01-01T00:02:00.000Z",
    });
    const secondFix = thread("second-fix", {
      parentThreadId: "root",
      workflowRole: "implementation-fixer",
      workflowContext: { workflowId: "run", rootThreadId: "root" },
      createdAt: "2026-01-01T00:03:00.000Z",
    });
    const groups = buildWorkflowViewModel([secondFix, review, root, firstFix]).rootsByThreadKey.get(
      "env:root",
    )?.groups;
    const group = groups?.[0];

    expect(group && groups ? buildWorkflowSteps(group, groups).map((step) => step.id) : []).toEqual(
      [
        "role:implementation-fixer:env:first-fix",
        "role:implementation-code-reviewer:env:review",
        "role:implementation-fixer:env:second-fix",
      ],
    );
  });

  it("calculates thread, step, and parent workflow timing across nested work", () => {
    const root = thread("root");
    const build = thread("build", {
      parentThreadId: "root",
      workflowRole: "implementation-worker",
      workflowContext: { workflowId: "implementation-run", rootThreadId: "root" },
      createdAt: "2026-01-01T10:00:00.000Z",
      settledAt: "2026-01-01T10:05:00.000Z",
      updatedAt: "2026-01-01T10:09:00.000Z",
    });
    const review = thread("review", {
      parentThreadId: "build",
      workflowRole: "dev-review-reviewer",
      workflowContext: {
        workflowId: "review-run",
        parentWorkflowId: "implementation-run",
        rootThreadId: "root",
      },
      createdAt: "2026-01-01T10:06:00.000Z",
      settledAt: "2026-01-01T10:12:00.000Z",
    });
    const groups = buildWorkflowViewModel([review, build, root]).rootsByThreadKey.get(
      "env:root",
    )?.groups;
    const implementation = groups?.find((group) => group.sourceId === "implementation-run");
    const steps = implementation && groups ? buildWorkflowSteps(implementation, groups) : [];

    expect(resolveWorkflowThreadTimeRange(build)).toEqual({
      startedAt: "2026-01-01T10:00:00.000Z",
      endedAt: "2026-01-01T10:05:00.000Z",
    });
    expect(
      implementation && groups ? resolveWorkflowGroupTimeRange(implementation, groups) : null,
    ).toEqual({
      startedAt: "2026-01-01T10:00:00.000Z",
      endedAt: "2026-01-01T10:12:00.000Z",
    });
    expect(steps[1] && groups ? resolveWorkflowStepTimeRange(steps[1], groups) : null).toEqual({
      startedAt: "2026-01-01T10:06:00.000Z",
      endedAt: "2026-01-01T10:12:00.000Z",
    });
  });

  it("keeps a nested workflow visible from the thread that initiated the whole tree", () => {
    const root = thread("root", { workflowPreset: "fast-feature" });
    const build = thread("build", {
      parentThreadId: "root",
      workflowPreset: "fast-feature",
      workflowRole: "fast-feature-implementer",
    });
    const controller = thread("dev-review-controller", {
      parentThreadId: "build",
      workflowPreset: "dev-review",
      workflowRole: "dev-review-orchestrator",
      workflowContext: { workflowId: "dev-review-run", rootThreadId: "build" },
    });
    const reviewer = thread("dev-review-reviewer", {
      parentThreadId: "dev-review-controller",
      workflowRole: "dev-review-reviewer",
      workflowContext: { workflowId: "dev-review-run", rootThreadId: "build" },
    });

    const model = buildWorkflowViewModel([reviewer, root, controller, build]);
    const workflow = selectWorkflowRootForThread(model, root);

    expect(selectWorkflowRootForThread(model, reviewer)?.root.id).toBe("root");
    expect(workflow?.members.map((candidate) => candidate.id).sort()).toEqual([
      "build",
      "dev-review-controller",
      "dev-review-reviewer",
      "root",
    ]);
    expect(
      workflow?.groups.map((group) => [group.id, group.preset, group.parentGroupId, group.depth]),
    ).toEqual([
      ["legacy:build", "fast-feature", null, 0],
      ["workflow:dev-review-run", "dev-review", "legacy:build", 1],
    ]);
  });

  it("promotes missing parents and cycles to roots and keeps archived shells", () => {
    const root = thread("root");
    const orphan = thread("orphan", {
      parentThreadId: "missing",
      archivedAt: "2026-01-05T00:00:00.000Z",
      workflowContext: { workflowId: "run", rootThreadId: "root" },
    });
    const cycleA = thread("cycle-a", {
      parentThreadId: "cycle-b",
      workflowContext: { workflowId: "run", rootThreadId: "root" },
    });
    const cycleB = thread("cycle-b", {
      parentThreadId: "cycle-a",
      workflowContext: { workflowId: "run", rootThreadId: "root" },
    });
    const unrelatedRoot = thread("unrelated-root", { environmentId: "other-env" });
    const unrelatedChild = thread("unrelated-child", {
      environmentId: "other-env",
      parentThreadId: "unrelated-root",
    });
    const model = buildWorkflowViewModel([
      unrelatedChild,
      cycleB,
      orphan,
      root,
      unrelatedRoot,
      cycleA,
    ]);
    const rows = model.rootsByThreadKey.get("env:root")?.groups[0]?.rows ?? [];

    expect(rows.map((row) => row.thread.id).sort()).toEqual(["cycle-a", "cycle-b", "orphan"]);
    expect(rows.every((row) => row.depth === 0)).toBe(true);
    expect(resolveWorkflowThreadStatus(orphan)).toBe("archived");
    expect(rows.some((row) => row.thread.environmentId === unrelatedChild.environmentId)).toBe(
      false,
    );
  });

  it("rolls active and settled counts from hidden descendants", () => {
    const root = thread("root");
    const approval = thread("approval", {
      parentThreadId: "root",
      hasPendingApprovals: true,
      workflowContext: { workflowId: "run", rootThreadId: "root" },
    });
    const completed = thread("completed", {
      parentThreadId: "root",
      settledAt: "2026-01-02T00:00:00.000Z",
      workflowContext: { workflowId: "run", rootThreadId: "root" },
    });
    const group = buildWorkflowViewModel([root, completed, approval]).rootsByThreadKey.get(
      "env:root",
    )?.groups[0];

    expect(group).toMatchObject({ activeCount: 1, settledCount: 1, isActive: true });
    expect(resolveWorkflowRollupStatus([root, completed, approval])).toBe("approval");
    expect(
      resolveWorkflowLifecycle([root, completed, approval], (candidate) =>
        candidate.id === "approval" ? "active" : "settled",
      ),
    ).toBe("active");
  });

  it("keeps sidebar lists, counts, and local title search rooted at top-level threads", () => {
    const root = thread("root", { title: "Visible workflow" });
    const child = thread("child", {
      title: "Secret worker",
      parentThreadId: "root",
      workflowContext: { workflowId: "run", rootThreadId: "root" },
    });
    const ordinary = thread("ordinary", { title: "Ordinary thread" });
    const model = buildWorkflowViewModel([child, ordinary, root]);
    const localSearch = (query: string) =>
      model.topLevelThreads.filter((candidate) =>
        candidate.title.toLowerCase().includes(query.toLowerCase()),
      );

    expect(model.topLevelThreads.map((candidate) => candidate.id).sort()).toEqual([
      "ordinary",
      "root",
    ]);
    expect(model.topLevelThreads).toHaveLength(2);
    expect(localSearch("Secret worker")).toEqual([]);
  });
});
