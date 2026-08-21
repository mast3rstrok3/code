import type { AppReviewScope, WorkflowStepReviewPartsOverride } from "@t3tools/contracts";

import {
  APP_REVIEW_WORKFLOW_PROMPT_ID,
  workflowStepCycleKeysEqual,
  type WorkflowStepCycleKey,
} from "./workflowStepCycles.ts";

/** The two parts an App Review can run. Both on is the ordinary review. */
export interface AppReviewParts {
  readonly e2e: boolean;
  readonly browser: boolean;
}

export const ALL_APP_REVIEW_PARTS: AppReviewParts = { e2e: true, browser: true };

/** One step whose review parts a user can toggle in Settings → Workflows. */
export interface AppReviewPartsTarget {
  readonly key: WorkflowStepCycleKey;
  readonly label: string;
  readonly description: string;
}

/**
 * The steps review parts can be set for. The step-level entry governs
 * standalone runs and the combined post-merge review, and is the standing
 * default for ticket reviews; the ticket entry overrides it for the App Review
 * each ticket runs.
 */
export const APP_REVIEW_PARTS_TARGETS: ReadonlyArray<AppReviewPartsTarget> = [
  {
    key: { workflowPromptId: APP_REVIEW_WORKFLOW_PROMPT_ID },
    label: "App Review parts",
    description:
      "Standalone runs and the combined post-merge review, and the default for ticket reviews.",
  },
  {
    key: {
      workflowPromptId: APP_REVIEW_WORKFLOW_PROMPT_ID,
      stepWorkflowPromptId: "implementation.tdd.codex",
    },
    label: "Ticket App Review parts",
    description: "The App Review a single ticket runs before its Code Review.",
  },
];

function partsFromOverrides(
  overrides: ReadonlyArray<WorkflowStepReviewPartsOverride> | undefined,
  key: WorkflowStepCycleKey,
): AppReviewParts | undefined {
  const entries = overrides ?? [];
  const exact = entries.find((entry) => workflowStepCycleKeysEqual(entry, key));
  if (exact !== undefined) return { e2e: exact.e2e, browser: exact.browser };
  if (key.stepWorkflowPromptId !== undefined) {
    const stepLevel = entries.find((entry) =>
      workflowStepCycleKeysEqual(entry, { workflowPromptId: key.workflowPromptId }),
    );
    if (stepLevel !== undefined) return { e2e: stepLevel.e2e, browser: stepLevel.browser };
  }
  return undefined;
}

/**
 * The parts Settings allow for one step. A ticket key without its own entry
 * follows the step-level entry, and a step without any entry runs both parts.
 */
export function resolveAppReviewStepParts(input: {
  readonly overrides: ReadonlyArray<WorkflowStepReviewPartsOverride> | undefined;
  readonly key: WorkflowStepCycleKey;
}): AppReviewParts {
  return partsFromOverrides(input.overrides, input.key) ?? ALL_APP_REVIEW_PARTS;
}

/**
 * The parts one step runs, with the run's own overrides outranking the
 * standing Settings entirely: a run-level entry — exact or step-level — wins
 * before any Settings entry is consulted, so what the user set on the run they
 * are looking at is what that run does.
 */
export function resolveLayeredAppReviewStepParts(input: {
  readonly threadOverrides: ReadonlyArray<WorkflowStepReviewPartsOverride> | undefined;
  readonly settingsOverrides: ReadonlyArray<WorkflowStepReviewPartsOverride> | undefined;
  readonly key: WorkflowStepCycleKey;
}): AppReviewParts {
  return (
    partsFromOverrides(input.threadOverrides, input.key) ??
    partsFromOverrides(input.settingsOverrides, input.key) ??
    ALL_APP_REVIEW_PARTS
  );
}

export function appReviewPartsForScope(scope: AppReviewScope): AppReviewParts {
  return { e2e: scope !== "browser", browser: scope !== "e2e" };
}

export function intersectAppReviewParts(
  left: AppReviewParts,
  right: AppReviewParts,
): AppReviewParts {
  return { e2e: left.e2e && right.e2e, browser: left.browser && right.browser };
}

/** Null means no part remains: the review cannot run and must be skipped. */
export function appReviewScopeForParts(parts: AppReviewParts): AppReviewScope | null {
  if (parts.e2e && parts.browser) return "both";
  if (parts.e2e) return "e2e";
  if (parts.browser) return "browser";
  return null;
}

/** The one-line statement of what a review runs, shown wherever parts matter. */
export function describeAppReviewParts(parts: AppReviewParts): string {
  return `E2E tests: ${parts.e2e ? "yes" : "no"} · Browser review: ${parts.browser ? "yes" : "no"}`;
}

/** The overrides after setting or clearing one step's parts. */
export function setWorkflowStepReviewPartsOverride(
  overrides: ReadonlyArray<WorkflowStepReviewPartsOverride>,
  key: WorkflowStepCycleKey,
  parts: AppReviewParts | null,
): ReadonlyArray<WorkflowStepReviewPartsOverride> {
  const others = overrides.filter((entry) => !workflowStepCycleKeysEqual(entry, key));
  if (parts === null) return others;
  return [
    ...others,
    {
      workflowPromptId: key.workflowPromptId,
      ...(key.stepWorkflowPromptId === undefined
        ? {}
        : { stepWorkflowPromptId: key.stepWorkflowPromptId }),
      e2e: parts.e2e,
      browser: parts.browser,
    },
  ];
}
