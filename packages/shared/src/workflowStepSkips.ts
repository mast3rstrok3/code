import type {
  ImplementationWorkflowSettings,
  OrchestrationImplementationSkipTarget,
} from "@t3tools/contracts";

/** Convert the standing Engineering Workflow switches into a new run's skip list. */
export function implementationWorkflowDefaultSkips(
  settings: ImplementationWorkflowSettings | undefined,
): ReadonlyArray<OrchestrationImplementationSkipTarget> {
  if (settings === undefined) return [];
  return [
    ...(settings.appReviewEnabled ? [] : [{ kind: "run" as const, stage: "app-review" as const }]),
    ...(settings.finalCodeReviewEnabled
      ? []
      : [{ kind: "run" as const, stage: "code-review" as const }]),
    ...(settings.pullRequestCreationEnabled
      ? []
      : [{ kind: "run" as const, stage: "change-request" as const }]),
    ...(settings.pullRequestBabysittingEnabled
      ? []
      : [{ kind: "run" as const, stage: "change-request-babysit" as const }]),
  ];
}
