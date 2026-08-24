import type {
  ImplementationWorkflowSettings,
  OrchestrationPlanningTicketId,
  OrchestrationImplementationSkipTarget,
} from "@t3tools/contracts";
import { normalizeImplementationWorkflowSettings } from "./workflowPresets.ts";

/** Convert implementation-stage choices into a new run's skip list. */
export function implementationWorkflowDefaultSkips(
  settings: ImplementationWorkflowSettings | undefined,
  ticketIds: ReadonlyArray<OrchestrationPlanningTicketId> = [],
): ReadonlyArray<OrchestrationImplementationSkipTarget> {
  if (settings === undefined) return [];
  const normalized = normalizeImplementationWorkflowSettings(settings);
  return [
    ...(normalized.ticketAppReviewEnabled
      ? []
      : ticketIds.map((ticketId) => ({
          kind: "ticket" as const,
          ticketId,
          stage: "app-review" as const,
        }))),
    ...(normalized.appReviewEnabled
      ? []
      : [{ kind: "run" as const, stage: "app-review" as const }]),
    ...(normalized.finalCodeReviewEnabled
      ? []
      : [{ kind: "run" as const, stage: "code-review" as const }]),
    ...(normalized.pullRequestCreationEnabled
      ? []
      : [{ kind: "run" as const, stage: "change-request" as const }]),
    ...(normalized.pullRequestBabysittingEnabled
      ? []
      : [{ kind: "run" as const, stage: "change-request-babysit" as const }]),
  ];
}
