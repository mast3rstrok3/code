import { expect, it } from "vite-plus/test";

import {
  findWorkflowStepCycleTarget,
  resolveWorkflowStepCycleBudget,
  setWorkflowStepCycleOverride,
  WORKFLOW_STEP_CYCLE_TARGETS,
} from "./workflowStepCycles.ts";

const APP_REVIEW = { workflowPromptId: "implementation.browser-app-review.codex" };
const TICKET_APP_REVIEW = {
  workflowPromptId: "implementation.browser-app-review.codex",
  stepWorkflowPromptId: "implementation.tdd.codex",
};

it("falls back to the step's own default when nothing is set", () => {
  expect(resolveWorkflowStepCycleBudget({ key: APP_REVIEW })).toBe(10);
  expect(
    resolveWorkflowStepCycleBudget({
      key: { workflowPromptId: "planning.ticket-reviewer.codex" },
    }),
  ).toBe(5);
});

it("prefers the run's own budget over the standing default", () => {
  expect(
    resolveWorkflowStepCycleBudget({
      key: APP_REVIEW,
      threadOverrides: [{ ...APP_REVIEW, maxCycles: 3 }],
      settingsOverrides: [{ ...APP_REVIEW, maxCycles: 20 }],
    }),
  ).toBe(3);
  expect(
    resolveWorkflowStepCycleBudget({
      key: APP_REVIEW,
      settingsOverrides: [{ ...APP_REVIEW, maxCycles: 20 }],
    }),
  ).toBe(10);
});

it("keeps a ticket App Review budget separate from the run's own App Review", () => {
  // The two run the same agent under different steps, so a budget set on one
  // must not be picked up by the other.
  const overrides = [{ ...TICKET_APP_REVIEW, maxCycles: 2 }];
  expect(
    resolveWorkflowStepCycleBudget({ key: TICKET_APP_REVIEW, threadOverrides: overrides }),
  ).toBe(2);
  expect(resolveWorkflowStepCycleBudget({ key: APP_REVIEW, threadOverrides: overrides })).toBe(10);
});

it("clamps a budget written outside the step's bounds", () => {
  expect(
    resolveWorkflowStepCycleBudget({
      key: APP_REVIEW,
      threadOverrides: [{ ...APP_REVIEW, maxCycles: 500 }],
    }),
  ).toBe(10);
  expect(resolveWorkflowStepCycleBudget({ key: APP_REVIEW, fallbackCycles: 0 })).toBe(1);
});

it("uses the caller's fallback only when no budget is set", () => {
  expect(resolveWorkflowStepCycleBudget({ key: APP_REVIEW, fallbackCycles: 4 })).toBe(4);
  expect(
    resolveWorkflowStepCycleBudget({
      key: APP_REVIEW,
      threadOverrides: [{ ...APP_REVIEW, maxCycles: 7 }],
      fallbackCycles: 4,
    }),
  ).toBe(7);
});

it("has no target for a step that runs once", () => {
  expect(findWorkflowStepCycleTarget({ workflowPromptId: "planning.spec.codex" })).toBeUndefined();
});

it("keeps every target's default within its own ceiling", () => {
  for (const target of WORKFLOW_STEP_CYCLE_TARGETS) {
    expect(target.defaultCycles).toBeLessThanOrEqual(target.maxCycles);
    expect(target.defaultCycles).toBeGreaterThanOrEqual(1);
  }
});

it("replaces and clears one budget without touching the others", () => {
  const withApp = setWorkflowStepCycleOverride([], APP_REVIEW, 12);
  const withBoth = setWorkflowStepCycleOverride(withApp, TICKET_APP_REVIEW, 3);
  expect(withBoth).toEqual([
    { ...APP_REVIEW, maxCycles: 12 },
    { ...TICKET_APP_REVIEW, maxCycles: 3 },
  ]);
  expect(setWorkflowStepCycleOverride(withBoth, TICKET_APP_REVIEW, null)).toEqual([
    { ...APP_REVIEW, maxCycles: 12 },
  ]);
});
