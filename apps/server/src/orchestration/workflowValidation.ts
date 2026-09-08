import type { AppReviewWorkflowFixValidation } from "@t3tools/contracts";

export const WORKFLOW_VALIDATION_EVIDENCE_INSTRUCTION =
  'In validations, label pre-fix bug reproduction runs with purpose "reproduction" and post-fix checks with purpose "verification". Preserve their actual statuses and completedAt timestamps. Verification must cover every reproduced bug after the repair; a broader passing test command may cover several reproduction runs. Only bug reproduction belongs in reproduction: setup failures and failing post-fix checks remain verification failures. Unlabelled entries count as verification.';

type Validation = AppReviewWorkflowFixValidation;

/** Keep history in the report, but decide each command from its newest execution. */
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
  return [...latest.values()];
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
