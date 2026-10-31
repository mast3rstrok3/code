import { describe, expect, it } from "@effect/vitest";
import type { EnvironmentWorkflowThreadShell } from "@t3tools/client-runtime/state/models";
import {
  buildWorkflowViewModel,
  selectWorkflowRootForThread,
} from "@t3tools/client-runtime/workflow-model";
import type {
  OrchestrationImplementationRun,
  OrchestrationPlanningSpec,
  OrchestrationThreadActivity,
} from "@t3tools/contracts";

import { pendingWorkflowQuestions } from "./workflowQuestions";
import { buildWorkflowSheetRows, type WorkflowSheetInput } from "./workflowSheetModel";

function thread(
  id: string,
  overrides: Partial<EnvironmentWorkflowThreadShell> = {},
): EnvironmentWorkflowThreadShell {
  return {
    environmentId: "env",
    id,
    title: id,
    parentThreadId: null,
    workflowRole: null,
    workflowContext: null,
    workflowSubagentBatchProvenance: null,
    workflowPreset: null,
    workflowPausedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    archivedAt: null,
    settledAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    backgroundLiveness: null,
    latestTurn: null,
    session: null,
    modelSelection: { instanceId: "codex", model: "gpt-5.4" },
    ...overrides,
  } as unknown as EnvironmentWorkflowThreadShell;
}

const planningRoot = (overrides: Partial<EnvironmentWorkflowThreadShell> = {}) =>
  thread("root", {
    workflowPreset: "planning",
    workflowContext: { workflowId: "workflow-root", rootThreadId: "root", ticketScope: [] },
    planningWorkflowSummary: { stage: "spec-authoring", specId: null },
    ...overrides,
  } as Partial<EnvironmentWorkflowThreadShell>);

function input(
  root: EnvironmentWorkflowThreadShell,
  overrides: Partial<WorkflowSheetInput> = {},
): WorkflowSheetInput {
  const workflow = selectWorkflowRootForThread(buildWorkflowViewModel([root]), root)!;
  return {
    workflow,
    implementationRuns: [],
    appReviewWorkflowRuns: [],
    tickets: [],
    spec: null,
    defaultStepCycles: [],
    expanded: {},
    showAllEntries: new Set(),
    ...overrides,
  };
}

const stepNamed = (rows: ReturnType<typeof buildWorkflowSheetRows>, label: string) =>
  rows.find((row) => row.kind === "step" && row.label === label);

const spec = {
  id: "spec-1",
  title: "Payments",
  summaryMarkdown: "# Payments",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
} as unknown as OrchestrationPlanningSpec;

const implementationRun = (overrides: Partial<OrchestrationImplementationRun> = {}) =>
  ({
    id: "run-1",
    specId: "spec-1",
    sourceProposedPlan: null,
    orchestratorThreadId: "orchestrator",
    appReviewWorkflowRunIds: [],
    planningTicketIds: [],
    ticketStates: [],
    stageExecutions: [],
    skips: [],
    status: "running",
    automationHalt: null,
    retryableFailure: null,
    activeValidationKind: null,
    finalValidation: null,
    finalValidationResults: [],
    finalRegression: null,
    validatedHeadSha: null,
    codeReviewedHeadSha: null,
    finalCodeReviewLaunchCount: 0,
    codeReviewExhaustedAt: null,
    appReviewExhaustedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  }) as unknown as OrchestrationImplementationRun;

describe("buildWorkflowSheetRows", () => {
  it("opens a lone workflow and lists its steps in order", () => {
    const rows = buildWorkflowSheetRows(input(planningRoot()));
    expect(rows[0]).toMatchObject({ kind: "group", expanded: true });
    const steps = rows.flatMap((row) => (row.kind === "step" ? [row] : []));
    expect(steps.slice(0, 3).map((step) => [step.number, step.label])).toEqual([
      [1, "Prepare shared worktree"],
      [2, "Grill with Docs"],
      [3, "Spec authoring"],
    ]);
  });

  it("hides a collapsed workflow's phases and steps", () => {
    const groupId = buildWorkflowSheetRows(input(planningRoot()))[0]!.id;
    const rows = buildWorkflowSheetRows(input(planningRoot(), { expanded: { [groupId]: false } }));
    expect(rows.map((row) => row.kind)).toEqual(["group"]);
  });

  it("restarts, clears, and skips a run-wide stage through the linked run", () => {
    const run = implementationRun();
    const step = stepNamed(
      buildWorkflowSheetRows(input(planningRoot(), { spec, implementationRuns: [run] })),
      "Final Code Review",
    );
    expect(step?.kind === "step" ? step.controls : null).toMatchObject({
      restart: { kind: "rerun", runId: "run-1", targets: [{ kind: "run", stage: "code-review" }] },
      clear: { runId: "run-1", targets: [{ kind: "run", stage: "code-review" }] },
      skip: { runId: "run-1", target: { kind: "run", stage: "code-review" }, skipped: false },
    });
  });

  it("resumes rather than restarts a paused workflow away from its resume step", () => {
    const step = stepNamed(
      buildWorkflowSheetRows(
        input(planningRoot({ workflowPausedAt: "2026-01-02T00:00:00.000Z" }), {
          spec,
          implementationRuns: [implementationRun()],
        }),
      ),
      "Final Code Review",
    );
    expect(step?.kind === "step" ? step.controls.restart : "missing").toBeNull();
  });

  it("lists the planning documents and notes a step that has not started", () => {
    const closed = buildWorkflowSheetRows(input(planningRoot(), { spec }));
    const step = stepNamed(closed, "Merge ticket branches");
    const rows = buildWorkflowSheetRows(
      input(planningRoot(), { spec, expanded: { [step!.id]: true } }),
    );
    expect(rows).toContainEqual(
      expect.objectContaining({ kind: "document", title: "Spec · Payments" }),
    );
    expect(rows).toContainEqual(expect.objectContaining({ kind: "note", text: "Not started" }));
  });
});

describe("pendingWorkflowQuestions", () => {
  const activity = (kind: string, payload: unknown) =>
    ({ kind, payload }) as unknown as OrchestrationThreadActivity;

  it("keeps only questions nothing has answered", () => {
    const question = {
      id: "scope",
      header: "Scope",
      question: "Which scope?",
      options: [{ label: "Small", description: "Small" }],
    };
    expect(
      pendingWorkflowQuestions([
        activity("user-input.requested", { requestId: "a", questions: [question] }),
        activity("user-input.requested", { requestId: "b", questions: [question] }),
        activity("user-input.resolved", { requestId: "a" }),
      ]).map((request) => request.requestId),
    ).toEqual(["b"]);
  });
});
