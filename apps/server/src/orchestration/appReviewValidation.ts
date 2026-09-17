import type { AppReviewWorkflowRun } from "@t3tools/contracts";

import { currentWorkflowValidations } from "./workflowValidation.ts";

export function isTicketAppReview(run: Pick<AppReviewWorkflowRun, "caller">): boolean {
  return run.caller.type === "implementation" && run.caller.ticketId != null;
}

export function isImplementationAppReview(run: Pick<AppReviewWorkflowRun, "caller">): boolean {
  return run.caller.type === "implementation";
}

export function deferredTicketValidationCommands(
  run: AppReviewWorkflowRun,
  projectCommands: ReadonlyArray<string>,
) {
  if (!isImplementationAppReview(run)) return [];
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

export function finalAppReviewValidationCommands(run: AppReviewWorkflowRun) {
  if (!isImplementationAppReview(run) || isTicketAppReview(run)) return [];
  return [
    ...new Set([
      ...run.cycles.flatMap((cycle) => cycle.deferredValidationCommands ?? []),
      ...deferredTicketValidationCommands(run, []),
    ]),
  ];
}

export function reusableAppReviewFixValidations(run: AppReviewWorkflowRun) {
  if (!isImplementationAppReview(run)) return [];
  const currentCycleNumber = run.cycles.at(-1)?.cycleNumber;
  const candidates = run.cycles.flatMap((cycle) => {
    const result = cycle.fixResult;
    const eligible =
      currentCycleNumber !== undefined &&
      cycle.cycleNumber === currentCycleNumber - 1 &&
      cycle.status === "completed" &&
      result?.status === "succeeded" &&
      result.commitSha === run.workspaceRevision.headSha &&
      cycle.fixWorkspaceRevision?.fingerprint === run.workspaceRevision.fingerprint &&
      cycle.fixPreviewTargets?.length === run.previewTargets.length &&
      cycle.fixPreviewTargets.every((target, index) => target === run.previewTargets[index]);
    return [
      ...(cycle.validationRepair?.result.validations ?? []).map((validation) => ({
        ...validation,
        cycleNumber: cycle.cycleNumber,
        eligible: false,
      })),
      ...(result?.validations ?? []).map((validation) => ({
        ...validation,
        cycleNumber: cycle.cycleNumber,
        eligible,
      })),
    ];
  });
  // Include unsuccessful repairs so a newer failure invalidates older passing evidence.
  return currentWorkflowValidations(candidates).filter(
    (validation) =>
      validation.eligible && validation.status === "passed" && validation.scope !== "project",
  );
}
