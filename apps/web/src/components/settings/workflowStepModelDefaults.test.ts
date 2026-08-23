import { ProviderInstanceId, type ModelSelection } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import {
  setWorkflowStepModelDefault,
  setWorkflowStepModelDefaults,
  engineeringWorkflowDefaultSteps,
} from "./workflowStepModelDefaults.ts";

const selection: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.6-sol",
};

it("lists the nine Engineering Workflow steps in phase order", () => {
  const targets = engineeringWorkflowDefaultSteps();
  expect(targets.map((target) => target.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  expect(targets.map((target) => target.phase)).toEqual([
    "planning",
    "planning",
    "planning",
    "planning",
    "ticket-review",
    "implementation",
    "implementation",
    "implementation",
    "implementation",
  ]);
  expect(targets.map((target) => target.label)).toEqual([
    "Prepare shared worktree and App Dev Stack",
    "Grill with Docs",
    "Spec authoring",
    "Ticket authoring",
    "Ticket review and revision cycles",
    "Execute ticket waves",
    "Merge ticket branches",
    "App Review",
    "Final Code Review, pull request, and green checks",
  ]);
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
  ]);
  expect(targets.filter((target) => target.modelMode === "configurable")).toHaveLength(5);
});

it("keeps nested worker and review agents under their workflow step", () => {
  const targets = engineeringWorkflowDefaultSteps();
  const ticketWaves = targets.find((target) => target.label === "Execute ticket waves");
  const appReview = targets.find((target) => target.label === "App Review");

  expect(ticketWaves?.subSteps.map((subStep) => subStep.label)).toEqual([
    "TDD implementation worker",
    "Ticket App Review",
    "Ticket Code Review",
  ]);
  expect(appReview?.subSteps.map((subStep) => subStep.label)).toEqual([
    "E2E tests & browser review",
    "Gap analysis & repair tickets",
    "Repair implementation",
  ]);
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
