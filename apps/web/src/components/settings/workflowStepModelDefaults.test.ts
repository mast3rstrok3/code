import { ProviderInstanceId, type ModelSelection } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import {
  setWorkflowStepModelDefault,
  setWorkflowStepModelDefaults,
  workflowStepModelDefaultTargets,
} from "./workflowStepModelDefaults.ts";

const selection: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.6-sol",
};

it("lists each pinnable step once, with the agents it starts", () => {
  const targets = workflowStepModelDefaultTargets();
  const promptIds = targets.map((target) => target.workflowPromptId);

  expect(new Set(promptIds).size).toBe(promptIds.length);
  const appReview = targets.find(
    (target) => target.workflowPromptId === "implementation.browser-app-review.codex",
  );
  expect(appReview?.subSteps.map((subStep) => subStep.workflowPromptId)).toEqual([
    "implementation.browser-app-review.codex",
    "matt-pocock.to-tickets",
    "matt-pocock.implement",
  ]);
});

it("drops the phase prefix a guided workflow adds to its step labels", () => {
  const targets = workflowStepModelDefaultTargets();
  expect(targets.every((target) => !target.label.includes(" · "))).toBe(true);
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
