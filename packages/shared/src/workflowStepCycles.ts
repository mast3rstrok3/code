import type { WorkflowStepCycleOverride } from "@t3tools/contracts";

/** A looping workflow step, addressed the same way as a model pin. */
export interface WorkflowStepCycleKey {
  readonly workflowPromptId: string;
  readonly stepWorkflowPromptId?: string | undefined;
}

/** The configuration key shared by standalone, final, and ticket App Review steps. */
export const APP_REVIEW_WORKFLOW_PROMPT_ID = "implementation.browser-app-review.codex";

/** One configurable cycle target and its accepted bounds. */
export interface WorkflowStepCycleTarget {
  readonly key: WorkflowStepCycleKey;
  readonly label: string;
  readonly description: string;
  readonly defaultCycles: number;
  readonly maxCycles: number;
}

/** The built-in workflow steps whose logical work can repeat. */
export const WORKFLOW_STEP_CYCLE_TARGETS: ReadonlyArray<WorkflowStepCycleTarget> = [
  {
    key: { workflowPromptId: "planning.ticket-reviewer.codex" },
    label: "Ticket review and revision cycles",
    description:
      "One reviewer pass over the Planning Tickets plus the revision it asks for. Planning completes with warnings when the budget runs out.",
    defaultCycles: 5,
    maxCycles: 5,
  },
  {
    key: { workflowPromptId: APP_REVIEW_WORKFLOW_PROMPT_ID },
    label: "App Review cycles",
    description:
      "An E2E test, browser review, gap analysis, and fix. The review ends unresolved when the budget runs out.",
    defaultCycles: 10,
    maxCycles: 10,
  },
  {
    key: {
      workflowPromptId: APP_REVIEW_WORKFLOW_PROMPT_ID,
      stepWorkflowPromptId: "implementation.tdd.codex",
    },
    label: "Ticket App Review cycles",
    description:
      "The same four phases, for the App Review a single ticket runs before its Code Review.",
    defaultCycles: 10,
    maxCycles: 10,
  },
  {
    key: { workflowPromptId: "implementation.code-review.codex" },
    label: "Final Code Review cycles",
    description:
      "One fresh review-and-fix thread per cycle. A clean result ends the review early; cycle five continues with a warning when the branch remains usable.",
    defaultCycles: 5,
    maxCycles: 5,
  },
  {
    key: {
      workflowPromptId: "implementation.code-review.codex",
      stepWorkflowPromptId: "implementation.tdd.codex",
    },
    label: "Ticket Code Review cycles",
    description:
      "One fresh review-and-fix thread per ticket cycle. A clean result ends the review early; cycle five continues with a warning when the branch remains usable.",
    defaultCycles: 5,
    maxCycles: 5,
  },
];

export function workflowStepCycleKeysEqual(
  left: WorkflowStepCycleKey,
  right: WorkflowStepCycleKey,
): boolean {
  return (
    left.workflowPromptId === right.workflowPromptId &&
    (left.stepWorkflowPromptId ?? null) === (right.stepWorkflowPromptId ?? null)
  );
}

export function workflowStepCycleKeyId(key: WorkflowStepCycleKey): string {
  return JSON.stringify([key.stepWorkflowPromptId ?? "", key.workflowPromptId]);
}

export function findWorkflowStepCycleTarget(
  key: WorkflowStepCycleKey,
): WorkflowStepCycleTarget | undefined {
  return WORKFLOW_STEP_CYCLE_TARGETS.find((target) => workflowStepCycleKeysEqual(target.key, key));
}

function findOverride(
  overrides: ReadonlyArray<WorkflowStepCycleOverride> | undefined,
  key: WorkflowStepCycleKey,
): WorkflowStepCycleOverride | undefined {
  return (overrides ?? []).find((entry) => workflowStepCycleKeysEqual(entry, key));
}

/**
 * Resolve one run's effective budget before the Settings default and built-in
 * default, then clamp it to the target's bounds.
 */
export function resolveWorkflowStepCycleBudget(input: {
  readonly key: WorkflowStepCycleKey;
  readonly threadOverrides?: ReadonlyArray<WorkflowStepCycleOverride> | undefined;
  readonly settingsOverrides?: ReadonlyArray<WorkflowStepCycleOverride> | undefined;
  readonly fallbackCycles?: number | undefined;
}): number {
  const target = findWorkflowStepCycleTarget(input.key);
  if (target === undefined) return input.fallbackCycles ?? 1;
  const override =
    findOverride(input.threadOverrides, input.key) ??
    findOverride(input.settingsOverrides, input.key);
  const requested = override?.maxCycles ?? Math.round(input.fallbackCycles ?? target.defaultCycles);
  return Math.min(target.maxCycles, Math.max(1, requested));
}

/** Set or clear one exact step and sub-step budget. */
export function setWorkflowStepCycleOverride(
  overrides: ReadonlyArray<WorkflowStepCycleOverride>,
  key: WorkflowStepCycleKey,
  maxCycles: number | null,
): ReadonlyArray<WorkflowStepCycleOverride> {
  const others = overrides.filter((entry) => !workflowStepCycleKeysEqual(entry, key));
  if (maxCycles === null) return others;
  return [
    ...others,
    {
      workflowPromptId: key.workflowPromptId,
      ...(key.stepWorkflowPromptId === undefined
        ? {}
        : { stepWorkflowPromptId: key.stepWorkflowPromptId }),
      maxCycles,
    },
  ];
}
