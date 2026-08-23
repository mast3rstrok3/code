import type { OrchestrationPlanningTicket } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildWorkflowViewModel,
  buildTicketWaves,
  buildWorkflowTimeline,
  buildWorkflowSteps,
  resolveGroupImplementationRun,
  resolveWorkflowGroupTimeRange,
  resolveWorkflowLifecycle,
  resolveWorkflowPhaseStatus,
  resolveWorkflowRollupStatus,
  resolveWorkflowStageDetailStatus,
  resolveWorkflowStepRollup,
  resolveWorkflowStepStatus,
  resolveWorkflowStepTimeRange,
  resolveWorkflowTicketStatus,
  resolveWorkflowThreadTimeRange,
  resolveWorkflowThreadStatus,
  selectWorkflowRootForThread,
  workflowNavigationIsAvailable,
  implementationRunCurrentStage,
  implementationTicketStageDetails,
  type WorkflowModelImplementationRun,
  workflowStepMatchesImplementationFailure,
  workflowStepCanRetryImplementationFailure,
  type WorkflowModelThread,
  type WorkflowTimelineStep,
} from "./workflowModel";

const planningTicket = (
  id: string,
  ordinal: number,
  dependencies: readonly string[] = [],
): OrchestrationPlanningTicket => ({
  id,
  specId: "spec-1",
  ordinal,
  title: id,
  bodyMarkdown: id,
  plannedFileChanges: [],
  dependencies: dependencies.map((ticketId) => ({ specId: "spec-1", ticketId })),
  status: "open",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

describe("buildTicketWaves", () => {
  it("groups independent tickets before their dependents", () => {
    const waves = buildTicketWaves([
      planningTicket("ticket-1", 0),
      planningTicket("ticket-2", 1),
      planningTicket("ticket-3", 2, ["ticket-1"]),
      planningTicket("ticket-4", 3, ["ticket-2", "ticket-3"]),
      planningTicket("ticket-5", 4),
    ]);
    expect(waves.map((wave) => wave.map(({ id }) => id))).toEqual([
      ["ticket-1", "ticket-2", "ticket-5"],
      ["ticket-3"],
      ["ticket-4"],
    ]);
  });
});

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

describe("resolveGroupImplementationRun", () => {
  const run = (
    id: string,
    overrides: Partial<WorkflowModelImplementationRun> = {},
  ): WorkflowModelImplementationRun => ({
    id,
    specId: "spec-1",
    sourceProposedPlan: null,
    orchestratorThreadId: `orchestrator-${id}`,
    appReviewWorkflowRunIds: [],
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  });

  // Implementation threads carry the run id as their workflow id, so they land
  // in a group of their own nested under the planning card that flattened them.
  const planningWorkflow = () => {
    const root = thread("root", {
      workflowPreset: "planning",
      workflowContext: { workflowId: "workflow-root", rootThreadId: "root" },
    });
    const orchestrator = thread("orchestrator-run-a", {
      parentThreadId: "root",
      workflowRole: "implementation-orchestrator",
      createdAt: "2026-01-02T00:00:00.000Z",
      workflowContext: {
        workflowId: "run-a",
        parentWorkflowId: "workflow-root",
        rootThreadId: "root",
      },
    });
    const groups =
      buildWorkflowViewModel([root, orchestrator]).rootsByThreadKey.get("env:root")?.groups ?? [];
    return { groups, card: groups.find((group) => group.parentGroupId === null)! };
  };

  it("links the run that owns a flattened nested group", () => {
    const { groups, card } = planningWorkflow();
    const otherWorkflowRun = run("run-b", {
      specId: "spec-2",
      updatedAt: "2026-01-09T00:00:00.000Z",
    });

    expect(
      resolveGroupImplementationRun(card, groups, [otherWorkflowRun, run("run-a")], {
        specId: "spec-1",
        rootThreadId: "root",
      })?.id,
    ).toBe("run-a");
  });

  it("never borrows another workflow's run when this one has not linked yet", () => {
    const { groups, card } = planningWorkflow();
    const otherWorkflowRun = run("run-b", {
      specId: "spec-2",
      updatedAt: "2026-01-09T00:00:00.000Z",
    });

    expect(
      resolveGroupImplementationRun(card, groups, [otherWorkflowRun], {
        specId: "spec-1",
        rootThreadId: "root",
      }),
    ).toBeNull();
    expect(
      resolveGroupImplementationRun(
        card,
        groups,
        [otherWorkflowRun, run("run-pending", { orchestratorThreadId: "not-created-yet" })],
        { specId: "spec-1", rootThreadId: "root" },
      )?.id,
    ).toBe("run-pending");
  });
});

describe("buildWorkflowViewModel", () => {
  it("makes a started root workflow navigable before it creates child threads", () => {
    const workflowRoot = thread("root", {
      workflowPreset: "planning",
      workflowContext: { workflowId: "workflow-root", rootThreadId: "root" },
    });
    const ordinaryThread = thread("ordinary");

    const workflow = selectWorkflowRootForThread(
      buildWorkflowViewModel([workflowRoot]),
      workflowRoot,
    );
    const ordinary = selectWorkflowRootForThread(
      buildWorkflowViewModel([ordinaryThread]),
      ordinaryThread,
    );

    expect(workflow?.groups).toHaveLength(1);
    expect(workflow?.groups[0]?.preset).toBe("planning");
    expect(
      workflow
        ? buildWorkflowSteps(workflow.groups[0]!, workflow.groups, workflow.root)
            .map((step) => step.label)
            .filter((label) => label?.startsWith("Planning phase"))
        : [],
    ).toEqual([
      "Planning phase · Prepare shared worktree and App Dev Stack",
      "Planning phase · Grill with Docs",
      "Planning phase · Spec authoring",
      "Planning phase · Ticket authoring",
      "Planning phase · Ticket review and revision cycles",
    ]);
    expect(workflowNavigationIsAvailable(workflow)).toBe(true);
    expect(workflowNavigationIsAvailable(ordinary)).toBe(false);
  });

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

  it("keeps nested App Review as its own workflow group under Implementation", () => {
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
      createdAt: "2026-01-01T00:01:00.000Z",
    });
    const controller = thread("app-review-controller", {
      parentThreadId: "implementation",
      workflowPreset: "app-review",
      workflowRole: "app-review-orchestrator",
      workflowContext: {
        workflowId: "app-review-run",
        parentWorkflowId: "implementation-run",
        rootThreadId: "root",
      },
      createdAt: "2026-01-01T00:02:00.000Z",
    });
    const reviewer = thread("app-review-reviewer", {
      parentThreadId: "app-review-controller",
      workflowPreset: "app-review",
      workflowRole: "app-review-reviewer",
      workflowContext: {
        workflowId: "app-review-run",
        parentWorkflowId: "implementation-run",
        rootThreadId: "root",
      },
      createdAt: "2026-01-01T00:03:00.000Z",
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
      ["workflow:app-review-run", "app-review", "workflow:implementation-run", 1],
    ]);
    expect(groups?.find((group) => group.id === "workflow:app-review-run")?.rows).toHaveLength(2);

    const implementationGroup = groups?.find((group) => group.id === "workflow:implementation-run");
    expect(
      implementationGroup && groups
        ? buildWorkflowTimeline(implementationGroup, groups, { flattenNestedWorkflows: true }).map(
            (entry) => [entry.kind, entry.kind === "thread" ? entry.row.thread.id : entry.group.id],
          )
        : [],
    ).toEqual([
      ["thread", "implementation"],
      ["thread", "app-review-controller"],
      ["thread", "app-review-reviewer"],
    ]);
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
        workflowId: "app-review-run",
        parentWorkflowId: "implementation-run",
        rootThreadId: "root",
      },
    });

    const groups = buildWorkflowViewModel([
      root,
      detachedReview,
      implementation,
    ]).rootsByThreadKey.get("env:root")?.groups;

    expect(groups?.find((group) => group.sourceId === "app-review-run")).toMatchObject({
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
    const controller = thread("app-review-controller", {
      parentThreadId: "build",
      workflowRole: "app-review-orchestrator",
      workflowPreset: "app-review",
      workflowContext: {
        workflowId: "app-review-run",
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
      { kind: "workflow", group: { sourceId: "app-review-run" } },
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

  it("keeps repeated non-adjacent roles as cycles in one workflow step", () => {
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

    expect(group && groups ? buildWorkflowSteps(group, groups) : []).toMatchObject([
      {
        id: "role:implementation-fixer:env:first-fix",
        repeatsAsCycles: true,
        entries: [
          { kind: "thread", row: { thread: { id: "first-fix" } } },
          { kind: "thread", row: { thread: { id: "second-fix" } } },
        ],
      },
      {
        id: "role:implementation-code-reviewer:env:review",
        entries: [{ kind: "thread", row: { thread: { id: "review" } } }],
      },
    ]);
  });

  it("uses Settings workflow steps and groups repeated App Reviews as cycles", () => {
    const root = thread("root", { workflowPreset: "fast-feature" });
    const build = thread("build", {
      parentThreadId: "root",
      workflowRole: "fast-feature-implementer",
      workflowContext: { workflowId: "fast-feature-run", rootThreadId: "root" },
      createdAt: "2026-01-01T00:01:00.000Z",
    });
    const reviewA = thread("review-a", {
      parentThreadId: "build",
      workflowRole: "app-review-orchestrator",
      workflowPreset: "app-review",
      workflowContext: {
        workflowId: "app-review-a",
        parentWorkflowId: "fast-feature-run",
        rootThreadId: "root",
      },
      createdAt: "2026-01-01T00:02:00.000Z",
    });
    const reviewB = thread("review-b", {
      parentThreadId: "build",
      workflowRole: "app-review-orchestrator",
      workflowPreset: "app-review",
      workflowContext: {
        workflowId: "app-review-b",
        parentWorkflowId: "fast-feature-run",
        rootThreadId: "root",
      },
      createdAt: "2026-01-01T00:03:00.000Z",
    });
    const model = buildWorkflowViewModel([root, build, reviewA, reviewB]);
    const groups = model.rootsByThreadKey.get("env:root")?.groups;
    const fastFeature = groups?.find((group) => group.sourceId === "fast-feature-run");
    // The panel flattens nested runs into their parent's steps, so the two
    // App Review runs read as two cycles of the one App Review step.
    const steps =
      fastFeature && groups
        ? buildWorkflowSteps(fastFeature, groups, root, { flattenNestedWorkflows: true })
        : [];

    expect(steps.map((step) => step.label)).toEqual([
      "Planning",
      "Building",
      "App Review",
      "Code Review",
    ]);
    expect(steps[2]).toMatchObject({
      repeatsAsCycles: true,
      entries: [
        { kind: "thread", row: { thread: { id: "review-a" } } },
        { kind: "thread", row: { thread: { id: "review-b" } } },
      ],
    });
    // Planning is a conversation in the main thread; Building gets its own.
    expect(steps[0]?.entries[0]?.id).toBe("env:root");
    expect(steps[1]?.entries[0]).toMatchObject({
      kind: "thread",
      row: { thread: { id: "build" } },
    });
    expect(
      steps.findIndex((step) => workflowStepMatchesImplementationFailure(step, "app-review")),
    ).toBe(2);
    // Fast feature creates the worktree and starts the stack inside Planning,
    // so both stages restart there rather than losing their step.
    expect(
      steps.findIndex((step) => workflowStepMatchesImplementationFailure(step, "app-dev-stack")),
    ).toBe(0);
    expect(
      steps.filter((step) => workflowStepMatchesImplementationFailure(step, "app-dev-stack")),
    ).toHaveLength(1);
    expect(
      steps.filter((step) => workflowStepMatchesImplementationFailure(step, "worktree-setup")),
    ).toHaveLength(1);
  });

  it("attaches every ticket-scoped implementation thread to the ticket execution step", () => {
    const root = thread("root", { workflowPreset: "planning" });
    const planningReview = thread("planning-review", {
      parentThreadId: "root",
      workflowRole: "planning-reviewer",
      workflowContext: { workflowId: "planning-run", rootThreadId: "root" },
    });
    const worker = thread("worker", {
      parentThreadId: "root",
      workflowRole: "implementation-worker",
      workflowContext: {
        workflowId: "implementation-run",
        parentWorkflowId: "planning-run",
        rootThreadId: "root",
        ticketScope: ["ticket-1"],
      },
    });
    const ticketReview = thread("ticket-review", {
      parentThreadId: "worker",
      workflowRole: "implementation-code-reviewer",
      workflowContext: {
        workflowId: "implementation-run",
        parentWorkflowId: "planning-run",
        rootThreadId: "root",
        ticketScope: ["ticket-1"],
      },
    });
    const model = buildWorkflowViewModel([root, planningReview, worker, ticketReview]);
    const groups = model.rootsByThreadKey.get("env:root")?.groups ?? [];
    const planning = groups.find((group) => group.sourceId === "planning-run");
    const steps = planning
      ? buildWorkflowSteps(planning, groups, root, { flattenNestedWorkflows: true })
      : [];
    const ticketExecution = steps.find((step) => step.label?.includes("Execute ticket waves"));

    expect(
      ticketExecution?.entries
        .filter((entry) => entry.kind === "thread")
        .map((entry) => entry.row.thread.id),
    ).toEqual(["ticket-review", "worker"]);
  });

  it("marks which Engineering Workflow steps run in the main thread", () => {
    const root = thread("root", { workflowPreset: "planning" });
    const planningReview = thread("planning-review", {
      parentThreadId: "root",
      workflowRole: "planning-reviewer",
      workflowContext: { workflowId: "planning-run", rootThreadId: "root" },
    });
    const model = buildWorkflowViewModel([root, planningReview]);
    const groups = model.rootsByThreadKey.get("env:root")?.groups ?? [];
    const planning = groups.find((group) => group.sourceId === "planning-run");
    const steps = planning
      ? buildWorkflowSteps(planning, groups, root, { flattenNestedWorkflows: true })
      : [];
    const byLabel = (needle: string) => steps.find((step) => step.label?.includes(needle));

    // The Grill is a conversation in the main thread, while ticket review and
    // the ticket waves get threads of their own.
    expect(byLabel("Grill with Docs")?.usesRootThread).toBe(true);
    expect(byLabel("Ticket review")?.usesRootThread).toBe(false);
    expect(byLabel("Execute ticket waves")?.usesRootThread).toBe(false);
  });

  it("renders one bounded post-ticket sequence without internal fallback steps", () => {
    // The root declares the planning run; its implementation children name it
    // as their parent workflow and flatten into the same steps.
    const root = thread("root", {
      workflowPreset: "planning",
      workflowContext: { workflowId: "planning-run", rootThreadId: "root" },
    });
    const scoped = (id: string, workflowRole: TestThread["workflowRole"]) =>
      thread(id, {
        parentThreadId: "root",
        workflowRole,
        workflowContext: {
          workflowId: "implementation-run",
          parentWorkflowId: "planning-run",
          rootThreadId: "root",
          ticketScope: ["ticket-1"],
        },
      });
    const global = (id: string, workflowRole: TestThread["workflowRole"], title: string = id) =>
      thread(id, {
        title,
        parentThreadId: "root",
        workflowRole,
        workflowContext: {
          workflowId: "implementation-run",
          parentWorkflowId: "planning-run",
          rootThreadId: "root",
          ticketScope: ["ticket-1", "ticket-2"],
        },
      });
    const model = buildWorkflowViewModel([
      root,
      scoped("worker", "implementation-worker"),
      scoped("ticket-app-review", "app-review-reviewer"),
      scoped("ticket-gap-analysis", "app-review-planner"),
      scoped("ticket-code-review", "implementation-code-reviewer"),
      global("merge", "implementation-validator", "Implementation merge gate"),
      global("app-review", "app-review-reviewer"),
      global("gap-analysis", "app-review-planner"),
      global("repair", "app-review-fixer"),
      global("code-review", "implementation-code-reviewer"),
      global("final-validation", "implementation-validator", "Implementation final validation"),
      global("pr-babysitter", "implementation-change-request-babysitter"),
    ]);
    const groups = model.rootsByThreadKey.get("env:root")?.groups ?? [];
    const planning = groups.find((group) => group.sourceId === "planning-run");
    const steps = planning
      ? buildWorkflowSteps(planning, groups, root, { flattenNestedWorkflows: true })
      : [];

    expect(steps.map((step) => step.label)).toEqual([
      "Planning phase · Prepare shared worktree and App Dev Stack",
      "Planning phase · Grill with Docs",
      "Planning phase · Spec authoring",
      "Planning phase · Ticket authoring",
      "Planning phase · Ticket review and revision cycles",
      "Implementation phase · Execute ticket waves",
      "Implementation phase · Merge ticket branches",
      "Implementation phase · App Review",
      "Implementation phase · Final Code Review, pull request, and green checks",
    ]);
    expect(steps[5]?.entries.map((entry) => entry.id)).toEqual([
      "env:ticket-app-review",
      "env:ticket-code-review",
      "env:ticket-gap-analysis",
      "env:worker",
    ]);
    expect(steps[7]?.entries.map((entry) => entry.id)).toEqual([
      "env:app-review",
      "env:gap-analysis",
      "env:repair",
    ]);
    expect(steps[8]?.entries.map((entry) => entry.id)).toEqual([
      "env:root",
      "env:code-review",
      "env:final-validation",
      "env:pr-babysitter",
    ]);
  });

  it("keeps the run coordinator off the final code review step", () => {
    // The coordinator thread is created with the first ticket wave and reads
    // as settled whenever it is idle, so attaching it to the last step called
    // the final code review done before it had started.
    const root = thread("root", {
      workflowPreset: "planning",
      workflowContext: { workflowId: "planning-run", rootThreadId: "root" },
    });
    const orchestrator = thread("orchestrator", {
      parentThreadId: "root",
      workflowRole: "implementation-orchestrator",
      workflowContext: {
        workflowId: "implementation-run",
        parentWorkflowId: "planning-run",
        rootThreadId: "root",
        ticketScope: ["ticket-1", "ticket-2"],
      },
    });
    const worker = thread("worker", {
      parentThreadId: "root",
      workflowRole: "implementation-worker",
      workflowContext: {
        workflowId: "implementation-run",
        parentWorkflowId: "planning-run",
        rootThreadId: "root",
        ticketScope: ["ticket-1"],
      },
    });
    const model = buildWorkflowViewModel([root, orchestrator, worker]);
    const groups = model.rootsByThreadKey.get("env:root")?.groups ?? [];
    const planning = groups.find((group) => group.sourceId === "planning-run");
    const steps = planning
      ? buildWorkflowSteps(planning, groups, root, { flattenNestedWorkflows: true })
      : [];
    const byLabel = (needle: string) => steps.find((step) => step.label?.includes(needle));

    // The coordinator lands on the step its own turn does, and nothing falls
    // through to a fallback step after the last defined one.
    expect(byLabel("Execute ticket waves")?.entries.map((entry) => entry.id)).toEqual([
      "env:orchestrator",
      "env:worker",
    ]);
    expect(byLabel("Final Code Review")?.entries.map((entry) => entry.id)).toEqual(["env:root"]);
    expect(steps).toHaveLength(9);

    // The panel reads a step's status from the threads it owns other than the
    // workflow root, and the final step owns none until the review starts.
    const finalStepThreads = (byLabel("Final Code Review")?.entries ?? []).flatMap((entry) =>
      entry.kind === "thread" && entry.row.thread.id !== root.id ? [entry.row.thread] : [],
    );
    expect(
      resolveWorkflowStepStatus({
        threadStatuses: finalStepThreads.map(resolveWorkflowThreadStatus),
      }),
    ).toBe("pending");
  });

  it("leaves the run coordinator on the step the Implementation preset gives it", () => {
    const root = thread("root", {
      workflowPreset: "implementation",
      workflowContext: { workflowId: "implementation-run", rootThreadId: "root" },
    });
    const orchestrator = thread("orchestrator", {
      parentThreadId: "root",
      workflowRole: "implementation-orchestrator",
      workflowContext: {
        workflowId: "implementation-run",
        rootThreadId: "root",
        ticketScope: ["ticket-1"],
      },
    });
    const model = buildWorkflowViewModel([root, orchestrator]);
    const groups = model.rootsByThreadKey.get("env:root")?.groups ?? [];
    const implementation = groups.find((group) => group.sourceId === "implementation-run");
    const steps = implementation
      ? buildWorkflowSteps(implementation, groups, root, { flattenNestedWorkflows: true })
      : [];
    const byLabel = (needle: string) => steps.find((step) => step.label?.includes(needle));

    expect(byLabel("Load Planning tickets")?.entries.map((entry) => entry.id)).toEqual([
      "env:root",
      "env:orchestrator",
    ]);
    expect(byLabel("Execute ticket waves")?.entries).toEqual([]);
    expect(byLabel("Final Code Review")?.entries).toEqual([]);
  });

  it("maps every implementation stage onto a guided preset step", () => {
    // Guided presets prefix labels with their phase and name the work
    // differently from the legacy presets; a stage that matches no step
    // silently loses its restart, which is how "Execute ticket waves" ended up
    // with no way back in.
    const step = (label: string) =>
      ({
        id: label,
        createdAt: "2026-01-01T00:00:00.000Z",
        label,
        skillId: null,
        repeatsAsCycles: false,
        usesRootThread: false,
        entries: [],
      }) satisfies WorkflowTimelineStep<ReturnType<typeof thread>>;

    const guidedSteps = [
      "Planning phase · Prepare shared worktree and App Dev Stack",
      "Implementation phase · Execute ticket waves",
      "Implementation phase · Merge ticket branches",
      "Implementation phase · App Review",
      "Implementation phase · Final Code Review, pull request, and green checks",
    ].map(step);

    const matched = (stage: Parameters<typeof workflowStepMatchesImplementationFailure>[1]) =>
      guidedSteps.find((candidate) => workflowStepMatchesImplementationFailure(candidate, stage))
        ?.label;

    expect(matched("worktree-setup")).toBe(
      "Planning phase · Prepare shared worktree and App Dev Stack",
    );
    expect(matched("worker-execution")).toBe("Implementation phase · Execute ticket waves");
    expect(matched("merge-gate")).toBe("Implementation phase · Merge ticket branches");
    expect(matched("integration")).toBe("Implementation phase · Merge ticket branches");
    expect(matched("app-review")).toBe("Implementation phase · App Review");
    expect(matched("code-review")).toBe(
      "Implementation phase · Final Code Review, pull request, and green checks",
    );
    expect(matched("change-request")).toBe(
      "Implementation phase · Final Code Review, pull request, and green checks",
    );
  });

  it("stops offering a narrow retry after the server retry budget is exhausted", () => {
    const step = {
      id: "final-review",
      createdAt: "2026-01-01T00:00:00.000Z",
      label: "Implementation phase · Final Code Review, pull request, and green checks",
      skillId: null,
      repeatsAsCycles: false,
      usesRootThread: false,
      entries: [],
    } satisfies WorkflowTimelineStep<ReturnType<typeof thread>>;
    const failure = {
      stage: "change-request" as const,
      detail: "Publication failed",
      failedAt: "2026-01-01T00:00:00.000Z",
      attemptCount: 3,
      maxAttempts: 3,
      humanBlocked: false,
    };

    expect(
      workflowStepCanRetryImplementationFailure(step, {
        status: "needs-human-attention",
        retryableFailure: failure,
      }),
    ).toBe(true);
    expect(
      workflowStepCanRetryImplementationFailure(step, {
        status: "needs-human-attention",
        retryableFailure: { ...failure, attemptCount: 4 },
      }),
    ).toBe(false);
  });

  it("reports a ticket stage that is running rather than calling it not started", () => {
    // The reviewer thread is live but the outcome only lands when it finishes;
    // reading the outcome alone described running work as work that never began.
    const reviewing = implementationTicketStageDetails(
      {
        status: "code-reviewing",
        workerResult: { status: "succeeded" },
        appReviewOutcome: "failed",
        codeReviewOutcome: null,
      },
      { appReviewEligible: true },
    );
    expect(reviewing.implementation).toBe("succeeded");
    expect(reviewing.appReview).toBe("failed");
    expect(reviewing.codeReview).toBe("in review");

    const appReviewing = implementationTicketStageDetails(
      { status: "app-reviewing", workerResult: { status: "succeeded" } },
      { appReviewEligible: true },
    );
    expect(appReviewing.appReview).toBe("in review");

    const building = implementationTicketStageDetails(
      { status: "running" },
      { appReviewEligible: false },
    );
    expect(building.implementation).toBe("running");
    expect(building.appReview).toBe("not planned");
    expect(building.codeReview).toBe("not started");

    // A finished outcome still wins over the ticket's status.
    const done = implementationTicketStageDetails(
      { status: "succeeded", codeReviewOutcome: "clean", appReviewOutcome: "skipped" },
      { appReviewEligible: true },
    );
    expect(done.codeReview).toBe("clean");
    expect(done.appReview).toBe("skipped — not planned for browser review");

    expect(implementationTicketStageDetails(undefined, {})).toEqual({
      implementation: "not started",
      appReview: "not planned",
      codeReview: "not started",
    });
  });

  it("reports the stage a paused run would resume at", () => {
    expect(implementationRunCurrentStage({ status: "running" })).toBe("worker-execution");
    expect(implementationRunCurrentStage({ status: "code-reviewing" })).toBe("code-review");
    expect(implementationRunCurrentStage({ status: "code-review-fixing" })).toBe("code-review");
    expect(implementationRunCurrentStage({ status: "validating" })).toBe("merge-gate");
    expect(implementationRunCurrentStage({ status: "babysitting-change-request" })).toBe(
      "change-request",
    );
    // A blocked run still reports the stage it failed at, not its status.
    expect(
      implementationRunCurrentStage({
        status: "needs-human-attention",
        retryableFailure: {
          stage: "app-review",
          detail: "App Review did not pass",
          failedAt: "2026-01-01T00:00:00.000Z",
          attemptCount: 1,
          maxAttempts: 3,
          humanBlocked: false,
        },
      }),
    ).toBe("app-review");
    expect(implementationRunCurrentStage({ status: "completed" })).toBeNull();
    expect(implementationRunCurrentStage({ status: "canceled" })).toBeNull();
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
      workflowRole: "app-review-reviewer",
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
    const controller = thread("app-review-controller", {
      parentThreadId: "build",
      workflowPreset: "app-review",
      workflowRole: "app-review-orchestrator",
      workflowContext: { workflowId: "app-review-run", rootThreadId: "build" },
    });
    const reviewer = thread("app-review-reviewer", {
      parentThreadId: "app-review-controller",
      workflowRole: "app-review-reviewer",
      workflowContext: { workflowId: "app-review-run", rootThreadId: "build" },
    });

    const model = buildWorkflowViewModel([reviewer, root, controller, build]);
    const workflow = selectWorkflowRootForThread(model, root);

    expect(selectWorkflowRootForThread(model, reviewer)?.root.id).toBe("root");
    expect(workflow?.members.map((candidate) => candidate.id).sort()).toEqual([
      "app-review-controller",
      "app-review-reviewer",
      "build",
      "root",
    ]);
    expect(
      workflow?.groups.map((group) => [group.id, group.preset, group.parentGroupId, group.depth]),
    ).toEqual([
      ["legacy:build", "fast-feature", null, 0],
      ["workflow:app-review-run", "app-review", "legacy:build", 1],
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

describe("resolveWorkflowStepStatus", () => {
  it("ranks what the step asks of a human above what its agents are doing", () => {
    expect(resolveWorkflowStepStatus({ threadStatuses: ["working"], blocked: true })).toBe(
      "blocked",
    );
    expect(resolveWorkflowStepStatus({ threadStatuses: ["working"], paused: true })).toBe("paused");
    expect(
      resolveWorkflowStepStatus({ threadStatuses: ["working"], paused: true, blocked: true }),
    ).toBe("blocked");
    expect(resolveWorkflowStepStatus({ threadStatuses: ["completed", "approval"] })).toBe(
      "awaiting",
    );
    expect(
      resolveWorkflowStepStatus({ threadStatuses: ["working"], skipped: true, blocked: true }),
    ).toBe("skipped");
  });

  it("keeps a step the run is still sitting at running once its agent settles", () => {
    expect(resolveWorkflowStepStatus({ threadStatuses: ["completed"], progress: "current" })).toBe(
      "running",
    );
    expect(resolveWorkflowStepStatus({ threadStatuses: ["failed"], progress: "current" })).toBe(
      "running",
    );
    expect(resolveWorkflowStepStatus({ threadStatuses: [], progress: "current" })).toBe("running");
  });

  it("reads a step that owns no agent from the workflow's own progress", () => {
    expect(resolveWorkflowStepStatus({ threadStatuses: [], progress: "completed" })).toBe("done");
    expect(resolveWorkflowStepStatus({ threadStatuses: [], progress: "upcoming" })).toBe("pending");
    expect(resolveWorkflowStepStatus({ threadStatuses: [] })).toBe("pending");
  });

  it("reports the worst outcome a settled step recorded", () => {
    expect(resolveWorkflowStepStatus({ threadStatuses: ["completed", "failed"] })).toBe("failed");
    expect(resolveWorkflowStepStatus({ threadStatuses: ["completed", "stopped"] })).toBe("stopped");
    expect(resolveWorkflowStepStatus({ threadStatuses: ["completed", "completed"] })).toBe("done");
  });
});

describe("resolveWorkflowPhaseStatus", () => {
  it("never hides one blocked step behind the steps beside it that are fine", () => {
    expect(resolveWorkflowPhaseStatus(["done", "running", "blocked", "pending"])).toBe("blocked");
    expect(resolveWorkflowPhaseStatus(["done", "running", "pending"])).toBe("running");
    expect(resolveWorkflowPhaseStatus(["running", "awaiting"])).toBe("awaiting");
  });

  it("claims done only once every step is done or skipped", () => {
    expect(resolveWorkflowPhaseStatus(["done", "skipped", "done"])).toBe("done");
    expect(resolveWorkflowPhaseStatus(["done", "done", "pending"])).toBe("pending");
    expect(resolveWorkflowPhaseStatus([])).toBe("pending");
  });
});

describe("resolveWorkflowStepRollup", () => {
  it("shows the most demanding part of a row split across several", () => {
    expect(resolveWorkflowStepRollup(["done", "done"])).toBe("done");
    expect(resolveWorkflowStepRollup(["done", "queued"])).toBe("queued");
    expect(resolveWorkflowStepRollup(["done", "running", "queued"])).toBe("running");
    expect(resolveWorkflowStepRollup(["failed", "running"])).toBe("failed");
    expect(resolveWorkflowStepRollup([])).toBe("pending");
  });
});

describe("resolveWorkflowTicketStatus", () => {
  it("separates a ticket queued behind its dependencies from one nobody started", () => {
    expect(
      resolveWorkflowTicketStatus({
        ticketState: "blocked",
        threadStatuses: [],
        skipped: false,
        paused: false,
      }),
    ).toBe("queued");
    expect(
      resolveWorkflowTicketStatus({
        ticketState: "ready",
        threadStatuses: [],
        skipped: false,
        paused: false,
      }),
    ).toBe("pending");
  });

  it("lets a ticket waiting on the user outrank the state the run recorded", () => {
    expect(
      resolveWorkflowTicketStatus({
        ticketState: "running",
        threadStatuses: ["approval"],
        skipped: false,
        paused: false,
      }),
    ).toBe("awaiting");
    expect(
      resolveWorkflowTicketStatus({
        ticketState: "running",
        threadStatuses: ["approval"],
        skipped: false,
        paused: true,
      }),
    ).toBe("paused");
  });

  it("reads a review stage of a running ticket as running", () => {
    for (const state of ["running", "app-reviewing", "code-reviewing"]) {
      expect(
        resolveWorkflowTicketStatus({
          ticketState: state,
          threadStatuses: ["completed"],
          skipped: false,
          paused: false,
        }),
      ).toBe("running");
    }
    expect(
      resolveWorkflowTicketStatus({
        ticketState: "succeeded",
        threadStatuses: ["completed"],
        skipped: false,
        paused: false,
      }),
    ).toBe("done");
  });

  it("falls back to the ticket's own threads when the run has no state for it", () => {
    expect(
      resolveWorkflowTicketStatus({
        ticketState: null,
        threadStatuses: ["working"],
        skipped: false,
        paused: false,
      }),
    ).toBe("running");
    expect(
      resolveWorkflowTicketStatus({
        ticketState: "open",
        threadStatuses: [],
        skipped: false,
        paused: false,
      }),
    ).toBe("pending");
  });
});

describe("resolveWorkflowStageDetailStatus", () => {
  it("colors the words a stage already reports", () => {
    expect(resolveWorkflowStageDetailStatus("running")).toBe("running");
    expect(resolveWorkflowStageDetailStatus("in review")).toBe("running");
    expect(resolveWorkflowStageDetailStatus("in progress")).toBe("running");
    expect(resolveWorkflowStageDetailStatus("succeeded")).toBe("done");
    expect(resolveWorkflowStageDetailStatus("clean")).toBe("done");
    expect(resolveWorkflowStageDetailStatus("3 tickets")).toBe("done");
    expect(resolveWorkflowStageDetailStatus("findings")).toBe("awaiting");
    expect(resolveWorkflowStageDetailStatus("exhausted")).toBe("failed");
    expect(resolveWorkflowStageDetailStatus("blocked")).toBe("blocked");
    expect(resolveWorkflowStageDetailStatus("skipped — not planned for browser review")).toBe(
      "skipped",
    );
    expect(resolveWorkflowStageDetailStatus("not started")).toBe("pending");
    expect(resolveWorkflowStageDetailStatus("eligible")).toBe("pending");
  });
});
