import type {
  AppReviewScope,
  AppStackShape,
  ReviewTestPlatform,
  WorkflowStepReviewPartsOverride,
} from "@t3tools/contracts";

import {
  APP_REVIEW_WORKFLOW_PROMPT_ID,
  workflowStepCycleKeysEqual,
  type WorkflowStepCycleKey,
} from "./workflowStepCycles.ts";

/** Automated review settings. The browser field remains readable for older saved settings. */
export interface AppReviewParts {
  readonly e2e: boolean;
  readonly browser: boolean;
  readonly testPlatforms?: readonly [ReviewTestPlatform, ...ReviewTestPlatform[]];
  readonly ticketTestPlatforms?: NonNullable<
    WorkflowStepReviewPartsOverride["ticketTestPlatforms"]
  >;
  readonly ticketAppStacks?: NonNullable<WorkflowStepReviewPartsOverride["ticketAppStacks"]>;
}

export const DEFAULT_APP_REVIEW_PARTS: AppReviewParts = { e2e: true, browser: false };

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
  if (exact !== undefined) return reviewPartsFromOverride(exact);
  if (key.stepWorkflowPromptId !== undefined) {
    const stepLevel = entries.find((entry) =>
      workflowStepCycleKeysEqual(entry, { workflowPromptId: key.workflowPromptId }),
    );
    if (stepLevel !== undefined) return reviewPartsFromOverride(stepLevel);
  }
  return undefined;
}

/**
 * The parts Settings allow for one step. A ticket key without its own entry
 * follows the step-level entry. Without an entry, E2E is on and browser review is off.
 */
export function resolveAppReviewStepParts(input: {
  readonly overrides: ReadonlyArray<WorkflowStepReviewPartsOverride> | undefined;
  readonly key: WorkflowStepCycleKey;
}): AppReviewParts {
  return partsFromOverrides(input.overrides, input.key) ?? DEFAULT_APP_REVIEW_PARTS;
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
    DEFAULT_APP_REVIEW_PARTS
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
  return `E2E tests: ${parts.e2e ? "yes" : "no"}`;
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
      ...parts,
    },
  ];
}

function reviewPartsFromOverride(entry: WorkflowStepReviewPartsOverride): AppReviewParts {
  return {
    e2e: entry.e2e,
    browser: false,
    ...(entry.testPlatforms === undefined ? {} : { testPlatforms: entry.testPlatforms }),
    ...(entry.ticketTestPlatforms === undefined
      ? {}
      : { ticketTestPlatforms: entry.ticketTestPlatforms }),
    ...(entry.ticketAppStacks === undefined ? {} : { ticketAppStacks: entry.ticketAppStacks }),
  };
}

export const REVIEW_TEST_PLATFORMS = ["web", "windows", "android", "ios", "macos"] as const;
export const REVIEW_TEST_PLATFORM_LABELS: Record<ReviewTestPlatform, string> = {
  web: "Web",
  windows: "Windows",
  android: "Android",
  ios: "iOS",
  macos: "macOS",
};
/**
 * The platforms E2E tests can reach from a server on `hostPlatform`. Web runs
 * anywhere, and Android and Windows run on emulators, VMs, or cluster guests;
 * iOS and macOS need Apple hardware.
 */
export function reviewTestPlatformsForHost(
  hostPlatform: NodeJS.Platform,
): readonly ReviewTestPlatform[] {
  return hostPlatform === "darwin"
    ? REVIEW_TEST_PLATFORMS
    : REVIEW_TEST_PLATFORMS.filter((platform) => platform !== "ios" && platform !== "macos");
}

export const TICKET_APP_REVIEW_PARTS_KEY = {
  workflowPromptId: APP_REVIEW_WORKFLOW_PROMPT_ID,
  stepWorkflowPromptId: "implementation.tdd.codex",
};

export function resolveReviewTestPlatforms(
  parts: AppReviewParts,
  ticketId?: string,
): readonly [ReviewTestPlatform, ...ReviewTestPlatform[]] {
  return (
    parts.ticketTestPlatforms?.find((entry) => entry.ticketId === ticketId)?.platforms ??
    parts.testPlatforms ?? ["web"]
  );
}

export function setTicketTestPlatforms(
  parts: AppReviewParts,
  ticketId: string,
  platforms: readonly [ReviewTestPlatform, ...ReviewTestPlatform[]] | null,
): AppReviewParts {
  const others = (parts.ticketTestPlatforms ?? []).filter((entry) => entry.ticketId !== ticketId);
  return {
    ...parts,
    ticketTestPlatforms: platforms === null ? others : [...others, { ticketId, platforms }],
  };
}

export type TicketAppStackSource = "override" | "plan" | "default";

interface TicketWithAppStack {
  readonly id: string;
  readonly appStack?: AppStackShape | undefined;
}

/**
 * The App Stack a ticket's App Review runs: the user's override, else the
 * planner's, else the ticket's own app alone with every service.
 */
export function resolveTicketAppStack(
  parts: AppReviewParts,
  ticket: TicketWithAppStack,
): AppStackShape {
  return (
    parts.ticketAppStacks?.find((entry) => entry.ticketId === ticket.id)?.appStack ??
    ticket.appStack ??
    {}
  );
}

export function ticketAppStackSource(
  parts: AppReviewParts,
  ticket: TicketWithAppStack,
): TicketAppStackSource {
  if (parts.ticketAppStacks?.some((entry) => entry.ticketId === ticket.id)) return "override";
  return ticket.appStack === undefined ? "default" : "plan";
}

/** Null clears the override, so the ticket runs the App Stack its plan names. */
export function setTicketAppStack(
  parts: AppReviewParts,
  ticketId: string,
  appStack: AppStackShape | null,
): AppReviewParts {
  const others = (parts.ticketAppStacks ?? []).filter((entry) => entry.ticketId !== ticketId);
  return {
    ...parts,
    ticketAppStacks: appStack === null ? others : [...others, { ticketId, appStack }],
  };
}
