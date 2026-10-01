import { expect, it } from "vite-plus/test";

import {
  DEFAULT_APP_REVIEW_PARTS,
  resolveReviewTestPlatforms,
  resolveTicketAppStack,
  setTicketAppStack,
  setTicketTestPlatforms,
  ticketAppStackSource,
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
    browser: false,
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
  ).toEqual({ e2e: false, browser: false });
  // A run-level step entry covers the ticket key before any Settings entry.
  expect(
    resolveLayeredAppReviewStepParts({
      threadOverrides: [{ ...stepKey, e2e: false, browser: true }],
      settingsOverrides: [{ ...ticketKey, e2e: true, browser: false }],
      key: ticketKey,
    }),
  ).toEqual({ e2e: false, browser: false });
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
  expect(describeAppReviewParts({ e2e: true, browser: false })).toBe("E2E tests: yes");
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

it("keeps ticket platforms through settings resolution and restores the workflow default", () => {
  expect(resolveReviewTestPlatforms(DEFAULT_APP_REVIEW_PARTS)).toEqual(["web"]);
  const parts = setTicketTestPlatforms(
    { e2e: true, browser: true, testPlatforms: ["web", "windows"] },
    "ticket-1",
    ["web", "android", "ios"],
  );
  const overrides = setWorkflowStepReviewPartsOverride([], ticketKey, parts);
  const resolved = resolveLayeredAppReviewStepParts({
    threadOverrides: overrides,
    settingsOverrides: [],
    key: ticketKey,
  });
  expect(resolveReviewTestPlatforms(resolved, "ticket-1")).toEqual(["web", "android", "ios"]);
  expect(resolveReviewTestPlatforms(resolved, "ticket-2")).toEqual(["web", "windows"]);
  expect(
    resolveReviewTestPlatforms(setTicketTestPlatforms(resolved, "ticket-1", null), "ticket-1"),
  ).toEqual(["web", "windows"]);
  expect(resolved.e2e).toBe(true);
  expect(resolved.browser).toBe(false);
});

it("runs the user's ticket App Stack over the planner's, and clears back to the plan", () => {
  const planned = { id: "ticket-1", appStack: { bundle: ["medical-repository"] } };
  const unplanned = { id: "ticket-2" };
  expect(resolveTicketAppStack(DEFAULT_APP_REVIEW_PARTS, unplanned)).toEqual({});
  expect(ticketAppStackSource(DEFAULT_APP_REVIEW_PARTS, unplanned)).toBe("default");
  expect(resolveTicketAppStack(DEFAULT_APP_REVIEW_PARTS, planned)).toEqual({
    bundle: ["medical-repository"],
  });
  expect(ticketAppStackSource(DEFAULT_APP_REVIEW_PARTS, planned)).toBe("plan");

  const parts = setTicketAppStack(
    setTicketTestPlatforms(DEFAULT_APP_REVIEW_PARTS, "ticket-1", ["web", "android"]),
    "ticket-1",
    { omitServices: { rudi: ["codex-runner"] } },
  );
  // The override travels through a saved entry like the platforms beside it.
  const resolved = resolveLayeredAppReviewStepParts({
    threadOverrides: setWorkflowStepReviewPartsOverride([], ticketKey, parts),
    settingsOverrides: [],
    key: ticketKey,
  });
  expect(resolveTicketAppStack(resolved, planned)).toEqual({
    omitServices: { rudi: ["codex-runner"] },
  });
  expect(ticketAppStackSource(resolved, planned)).toBe("override");
  expect(resolveTicketAppStack(resolved, unplanned)).toEqual({});

  const cleared = setTicketAppStack(resolved, "ticket-1", null);
  expect(resolveTicketAppStack(cleared, planned)).toEqual({ bundle: ["medical-repository"] });
  // Clearing the stack keeps the ticket's platforms.
  expect(resolveReviewTestPlatforms(cleared, "ticket-1")).toEqual(["web", "android"]);
});
