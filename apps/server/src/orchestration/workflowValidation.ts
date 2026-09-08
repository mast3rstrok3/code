import type { AppReviewWorkflowFixValidation } from "@t3tools/contracts";

export const WORKFLOW_VALIDATION_EVIDENCE_INSTRUCTION =
  'In validations, label pre-fix bug reproduction runs with purpose "reproduction" and post-fix checks with purpose "verification". Preserve their actual statuses and completedAt timestamps. Verification must cover every reproduced bug after the repair; a broader passing test command may cover several reproduction runs. Only bug reproduction belongs in reproduction: setup failures and failing post-fix checks remain verification failures. Unlabelled entries count as verification. When correcting a failed verification command, such as adding a missing environment variable or fixing unsupported flags, set supersedesCommand on the later passing verification to the exact earlier command. Use this only when the retry covers the same checks without weakening assertions or skipping tests, and explain the correction in outputMarkdown. Keep both attempts in validations. A newer passing retry supersedes that earlier failure; unrelated passing checks do not.';

type Validation = AppReviewWorkflowFixValidation;

/** Resolve reruns and explicit command corrections without changing the reported history. */
export function currentWorkflowValidations<T extends Validation>(validations: ReadonlyArray<T>) {
  const latest = new Map<string, T>();
  for (const validation of validations) {
    if (validation.purpose === "reproduction") continue;
    const command = validation.command.trim();
    const previous = latest.get(command);
    const completedAt = Date.parse(validation.completedAt);
    const previousAt = previous === undefined ? -Infinity : Date.parse(previous.completedAt);
    // Conflicting results at the same time do not establish a successful rerun.
    if (
      previous === undefined ||
      completedAt > previousAt ||
      (completedAt === previousAt && validation.status !== "passed")
    ) {
      latest.set(command, validation);
    }
  }
  const superseded = new Set<string>();
  for (const validation of latest.values()) {
    if (validation.status !== "passed" || validation.supersedesCommand === undefined) continue;
    const command = validation.supersedesCommand.trim();
    const previous = latest.get(command);
    if (
      previous !== undefined &&
      previous.status !== "passed" &&
      Date.parse(validation.completedAt) > Date.parse(previous.completedAt)
    ) {
      superseded.add(command);
    }
  }
  return [...latest.values()].filter((validation) => !superseded.has(validation.command.trim()));
}

/** A reproduction is evidence of a bug, not evidence that the repair passed. */
export function hasPostRepairVerification<T extends Validation>(validations: ReadonlyArray<T>) {
  const reproductionTimes = validations
    .filter((v) => v.purpose === "reproduction")
    .map((v) => Date.parse(v.completedAt));
  if (reproductionTimes.length === 0) return true;
  const lastReproduction = Math.max(...reproductionTimes);
  return currentWorkflowValidations(validations).some(
    (v) => v.status === "passed" && Date.parse(v.completedAt) >= lastReproduction,
  );
}
