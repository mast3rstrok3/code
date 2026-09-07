import type { AppReviewWorkflowFixResult, AppReviewWorkflowRun } from "@t3tools/contracts";

type Validation = AppReviewWorkflowFixResult["validations"][number];

export function isTicketAppReview(run: Pick<AppReviewWorkflowRun, "caller">): boolean {
  return run.caller.type === "implementation" && run.caller.ticketId != null;
}

/** Keep history in the report, but decide each command from its newest execution. */
export function latestAppReviewValidations(validations: ReadonlyArray<Validation>) {
  const latest = new Map<string, Validation>();
  for (const validation of validations) {
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

export function deferredTicketValidationCommands(
  run: AppReviewWorkflowRun,
  projectCommands: ReadonlyArray<string>,
) {
  if (!isTicketAppReview(run)) return [];
  const commands = new Set(projectCommands.map((command) => command.trim()));
  return latestAppReviewValidations(
    run.cycles.flatMap((cycle) => [
      ...(cycle.validationRepair?.result.validations ?? []),
      ...(cycle.fixResult?.validations ?? []),
    ]),
  )
    .filter(
      (validation) =>
        validation.status !== "passed" &&
        (validation.scope === "project" || commands.has(validation.command.trim())),
    )
    .map((validation) => validation.command.trim());
}
