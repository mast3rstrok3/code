import { ProviderInstanceId, type ModelSelection } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import {
  setWorkflowStepModelDefault,
  setWorkflowStepModelDefaults,
  engineeringWorkflowDefaultSteps,
  skippableImplementationSettingForStep,
  standingWorkflowStepModel,
} from "./workflowStepModelDefaults.ts";

const selection: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.6-sol",
};

it("lists the eleven Engineering steps in phase order", () => {
  const targets = engineeringWorkflowDefaultSteps();
  expect(targets.map((target) => target.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  expect(targets.map((target) => target.phase)).toEqual([
    "planning",
    "planning",
    "planning",
    "planning",
    "planning",
    "implementation",
    "implementation",
    "implementation",
    "implementation",
    "implementation",
    "implementation",
  ]);
  expect(targets.map((target) => target.label)).toEqual([
    "Prepare shared worktree",
    "Grill with Docs",
    "Spec authoring",
    "Ticket authoring",
    "Ticket review and revision",
    "Execute ticket waves",
    "Merge ticket branches",
    "Final App Review",
    "Final Code Review",
    "Create pull request",
    "Babysit pull request",
  ]);
});

it("runs Feature as Instruction, TDD implementation, App Review, Code Review, then Create PR", () => {
  const targets = engineeringWorkflowDefaultSteps("fast-plan");

  expect(targets.map((target) => target.phase)).toEqual([
    "planning",
    "implementation",
    "implementation",
    "implementation",
    "implementation",
  ]);
  expect(targets.map((target) => target.label)).toEqual([
    "Instruction",
    "TDD implementation",
    "App Review",
    "Code Review",
    "Create PR",
  ]);
  // Only the reviewers run in their own threads, so only they take a model of their own.
  expect(targets.map((target) => target.modelMode)).toEqual([
    "workflow",
    "workflow",
    "configurable",
    "configurable",
    "workflow",
  ]);
  expect(targets[2]?.workflowPromptId).toBe("implementation.browser-app-review.codex");
  expect(targets[3]?.workflowPromptId).toBe("implementation.code-review.codex");
});

it("drops the phase prefix a guided workflow adds to its step labels", () => {
  const targets = engineeringWorkflowDefaultSteps();
  expect(targets.every((target) => !target.label.includes(" · "))).toBe(true);
});

it("marks automatic, same-thread, and separately configurable steps", () => {
  const targets = engineeringWorkflowDefaultSteps();

  expect(targets.map((target) => target.modelMode)).toEqual([
    "none",
    "workflow",
    "workflow",
    "workflow",
    "configurable",
    "configurable",
    "configurable",
    "configurable",
    "configurable",
    "none",
    "configurable",
  ]);
  expect(targets.filter((target) => target.modelMode === "configurable")).toHaveLength(6);
});

it("keeps nested worker and review agents under their workflow step", () => {
  const targets = engineeringWorkflowDefaultSteps();
  const ticketWaves = targets.find((target) => target.label === "Execute ticket waves");
  const appReview = targets.find((target) => target.label === "Final App Review");

  expect(ticketWaves?.subSteps.map((subStep) => subStep.label)).toEqual([
    "TDD implementation worker",
    "Ticket App Review",
    "Ticket Code Review",
  ]);
  expect(appReview?.subSteps.map((subStep) => subStep.label)).toEqual([
    "End-to-end test",
    "Gap analysis & repair tickets",
    "Repair implementation",
  ]);
});

it("maps the final workflow steps to their run switches", () => {
  const settingsByLabel = Object.fromEntries(
    engineeringWorkflowDefaultSteps().map((step) => [
      step.label,
      skippableImplementationSettingForStep(step),
    ]),
  );

  expect(settingsByLabel["Final App Review"]).toBe("appReviewEnabled");
  expect(settingsByLabel["Final Code Review"]).toBe("finalCodeReviewEnabled");
  expect(settingsByLabel["Create pull request"]).toBe("pullRequestCreationEnabled");
  expect(settingsByLabel["Babysit pull request"]).toBe("pullRequestBabysittingEnabled");
});

it("replaces a default in place and clears it without leaving an empty key", () => {
  const withStep = setWorkflowStepModelDefault(
    [],
    { workflowPromptId: "implementation.browser-app-review.codex" },
    selection,
  );
  expect(withStep).toEqual([
    {
      workflowPromptId: "implementation.browser-app-review.codex",
      modelSelection: selection,
    },
  ]);
  expect(Object.hasOwn(withStep[0]!, "stepWorkflowPromptId")).toBe(false);

  const withSubStep = setWorkflowStepModelDefault(
    withStep,
    {
      workflowPromptId: "matt-pocock.to-tickets",
      stepWorkflowPromptId: "implementation.browser-app-review.codex",
    },
    selection,
  );
  expect(withSubStep).toHaveLength(2);

  const cleared = setWorkflowStepModelDefault(
    withSubStep,
    { workflowPromptId: "implementation.browser-app-review.codex" },
    null,
  );
  expect(cleared.map((entry) => entry.workflowPromptId)).toEqual(["matt-pocock.to-tickets"]);
});

it("sets and clears a model across several review pins", () => {
  const keys = [
    { workflowPromptId: "implementation.code-review.codex" },
    {
      workflowPromptId: "implementation.code-review.codex",
      stepWorkflowPromptId: "implementation.tdd.codex",
    },
  ];
  const assigned = setWorkflowStepModelDefaults([], keys, selection);

  expect(assigned).toHaveLength(2);
  expect(assigned.every((entry) => entry.modelSelection === selection)).toBe(true);
  expect(setWorkflowStepModelDefaults(assigned, keys, null)).toEqual([]);
});

const codeReview = { workflowPromptId: "implementation.code-review.codex" };
const other: ModelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-opus-5-5",
};

it("keeps Feature's and Engineering's Code Review defaults apart", () => {
  const feature = setWorkflowStepModelDefault([], codeReview, selection, "feature");
  expect(feature).toEqual([{ ...codeReview, workflow: "feature", modelSelection: selection }]);
  const both = setWorkflowStepModelDefault(feature, codeReview, other, "engineering");
  expect(standingWorkflowStepModel(both, codeReview, "feature")).toEqual(selection);
  expect(standingWorkflowStepModel(both, codeReview, "engineering")).toEqual(other);
  expect(
    standingWorkflowStepModel(
      setWorkflowStepModelDefault(both, codeReview, null, "feature"),
      codeReview,
      "feature",
    ),
  ).toBeNull();
});

it("shows an unscoped default from older settings for every workflow", () => {
  const legacy = setWorkflowStepModelDefault([], codeReview, selection);
  expect(standingWorkflowStepModel(legacy, codeReview, "feature")).toEqual(selection);
  expect(standingWorkflowStepModel(legacy, codeReview, "engineering")).toEqual(selection);
});

it("clears an unscoped default for one workflow while the other keeps it", () => {
  const legacy = setWorkflowStepModelDefault([], codeReview, selection);
  const cleared = setWorkflowStepModelDefault(legacy, codeReview, null, "engineering");
  expect(standingWorkflowStepModel(cleared, codeReview, "engineering")).toBeNull();
  expect(standingWorkflowStepModel(cleared, codeReview, "feature")).toEqual(selection);
  expect(cleared).toEqual([{ ...codeReview, workflow: "feature", modelSelection: selection }]);

  const changed = setWorkflowStepModelDefault(legacy, codeReview, other, "feature");
  expect(standingWorkflowStepModel(changed, codeReview, "feature")).toEqual(other);
  expect(standingWorkflowStepModel(changed, codeReview, "engineering")).toEqual(selection);
});
