import type { AppReviewWorkflowRun } from "@t3tools/contracts";

import { currentWorkflowValidations } from "./workflowValidation.ts";

export function isTicketAppReview(run: Pick<AppReviewWorkflowRun, "caller">): boolean {
  return run.caller.type === "implementation" && run.caller.ticketId != null;
}

export function deferredTicketValidationCommands(
  run: AppReviewWorkflowRun,
  projectCommands: ReadonlyArray<string>,
) {
  if (!isTicketAppReview(run)) return [];
  const commands = new Set(projectCommands.map((command) => command.trim()));
  return currentWorkflowValidations(
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
