import { expect, it } from "vite-plus/test";

import {
  DEFAULT_APP_REVIEW_PARTS,
  appReviewPartsForScope,
  appReviewScopeForParts,
  describeAppReviewParts,
  intersectAppReviewParts,
  resolveAppReviewStepParts,
  resolveLayeredAppReviewStepParts,
  setWorkflowStepReviewPartsOverride,
} from "./appReviewParts.ts";
import { APP_REVIEW_WORKFLOW_PROMPT_ID } from "./workflowStepCycles.ts";

const stepKey = { workflowPromptId: APP_REVIEW_WORKFLOW_PROMPT_ID };
const ticketKey = {
  workflowPromptId: APP_REVIEW_WORKFLOW_PROMPT_ID,
  stepWorkflowPromptId: "implementation.tdd.codex",
};

it("defaults to E2E only and lets a ticket key fall back to the step entry", () => {
  expect(resolveAppReviewStepParts({ overrides: undefined, key: stepKey })).toEqual(
    DEFAULT_APP_REVIEW_PARTS,
  );
  expect(resolveAppReviewStepParts({ overrides: [], key: ticketKey })).toEqual({
    e2e: true,
    browser: false,
  });
  const stepOnly = [{ ...stepKey, e2e: true, browser: false }];
  expect(resolveAppReviewStepParts({ overrides: stepOnly, key: ticketKey })).toEqual({
    e2e: true,
    browser: false,
  });
  const both = [
    { ...stepKey, e2e: true, browser: false },
    { ...ticketKey, e2e: false, browser: true },
  ];
  expect(resolveAppReviewStepParts({ overrides: both, key: ticketKey })).toEqual({
    e2e: false,
    browser: true,
  });
});

it("maps scopes to parts and back, with none as null", () => {
  expect(appReviewPartsForScope("both")).toEqual({ e2e: true, browser: true });
  expect(appReviewScopeForParts(appReviewPartsForScope("e2e"))).toBe("e2e");
  expect(appReviewScopeForParts(appReviewPartsForScope("browser"))).toBe("browser");
  expect(appReviewScopeForParts({ e2e: false, browser: false })).toBeNull();
  expect(
    appReviewScopeForParts(
      intersectAppReviewParts(appReviewPartsForScope("e2e"), { e2e: false, browser: true }),
    ),
  ).toBeNull();
});

it("lets run-level overrides outrank the standing Settings entirely", () => {
  const settings = [{ ...stepKey, e2e: true, browser: false }];
  const thread = [{ ...ticketKey, e2e: false, browser: true }];
  expect(
    resolveLayeredAppReviewStepParts({
      threadOverrides: thread,
      settingsOverrides: settings,
      key: ticketKey,
    }),
  ).toEqual({ e2e: false, browser: true });
  // A run-level step entry covers the ticket key before any Settings entry.
  expect(
    resolveLayeredAppReviewStepParts({
      threadOverrides: [{ ...stepKey, e2e: false, browser: true }],
      settingsOverrides: [{ ...ticketKey, e2e: true, browser: false }],
      key: ticketKey,
    }),
  ).toEqual({ e2e: false, browser: true });
  expect(
    resolveLayeredAppReviewStepParts({
      threadOverrides: undefined,
      settingsOverrides: settings,
      key: ticketKey,
    }),
  ).toEqual({ e2e: true, browser: false });
  expect(
    resolveLayeredAppReviewStepParts({
      threadOverrides: undefined,
      settingsOverrides: undefined,
      key: stepKey,
    }),
  ).toEqual(DEFAULT_APP_REVIEW_PARTS);
});

it("states the parts as the insert line", () => {
  expect(describeAppReviewParts({ e2e: true, browser: false })).toBe(
    "E2E tests: yes · Browser review: no",
  );
});

it("sets, replaces, and clears one step's override", () => {
  const set = setWorkflowStepReviewPartsOverride([], stepKey, { e2e: true, browser: false });
  expect(set).toEqual([
    { workflowPromptId: APP_REVIEW_WORKFLOW_PROMPT_ID, e2e: true, browser: false },
  ]);
  const replaced = setWorkflowStepReviewPartsOverride(set, stepKey, { e2e: false, browser: true });
  expect(replaced).toHaveLength(1);
  expect(replaced[0]).toMatchObject({ e2e: false, browser: true });
  expect(setWorkflowStepReviewPartsOverride(replaced, stepKey, null)).toEqual([]);
});
