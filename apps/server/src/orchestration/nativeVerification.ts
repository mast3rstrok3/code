import type {
  NativeVerificationAction,
  NativeVerificationHandoff,
  OrchestrationImplementationRun,
} from "@t3tools/contracts";
import { currentWorkflowValidations } from "./workflowValidation.ts";

export const nativeVerificationIsOpen = (handoff: NativeVerificationHandoff | null | undefined) =>
  handoff?.status === "ready" || handoff?.status === "claimed";

export function nativeVerificationEvidenceMarkdown(
  handoff: NativeVerificationHandoff | null | undefined,
): string {
  if (!handoff || handoff.status !== "completed") return "";
  return `Native verification completed on the requested machines at commit ${handoff.commitSha}. Inspect this evidence for native acceptance. Continue the remaining review checks here. A changed HEAD needs new verification; unavailable native tooling on this host does not invalidate evidence for the unchanged commit.\n\n${JSON.stringify(handoff.results.filter((result) => result.commitSha === handoff.commitSha))}`;
}

/** Apply a handoff transition against the current revision, retaining every submitted result. */
export function transitionNativeVerification(input: {
  run: OrchestrationImplementationRun;
  ticketId: string;
  expectedRevision: number | null;
  action: NativeVerificationAction;
  now: string;
}): OrchestrationImplementationRun | string {
  const { run, action, now } = input;
  if (run.status === "canceled" || run.status === "completed") return "This workflow has ended.";
  const ticket = run.ticketStates.find((candidate) => candidate.ticketId === input.ticketId);
  if (!ticket) return "Ticket not found.";
  const previous = ticket.nativeVerification;
  if ((previous?.revision ?? null) !== input.expectedRevision)
    return "The native handoff changed. Refresh before trying again.";
  let handoff: NativeVerificationHandoff;
  if (action.type === "prepare") {
    if (previous && previous.status !== "canceled" && previous.status !== "completed")
      return "This ticket already has a native handoff.";
    if (ticket.status === "succeeded") return "This ticket has already completed its reviews.";
    if (action.handoff.runId !== run.id || action.handoff.ticketId !== ticket.ticketId)
      return "The handoff does not belong to this ticket.";
    handoff = { ...action.handoff, revision: (previous?.revision ?? -1) + 1 };
  } else {
    if (!previous || previous.status === "canceled" || previous.status === "completed")
      return "There is no open native handoff.";
    handoff = { ...previous, revision: previous.revision + 1, updatedAt: now };
    if (action.type === "claim") {
      if (previous.claim !== null)
        return "Another environment already owns this verification. Release its claim first.";
      if (!previous.requiredPlatforms.includes(action.claim.platform))
        return "This platform was not requested.";
      handoff = { ...handoff, status: "claimed", claim: action.claim };
    } else if (action.type === "release") {
      if (previous.claim?.id !== action.claimId) return "This claim is no longer current.";
      handoff = { ...handoff, status: "ready", claim: null };
    } else if (action.type === "cancel") {
      if (previous.claim) return "Release the verification claim before canceling the handoff.";
      handoff = { ...handoff, status: "canceled", claim: null };
    } else {
      if (previous.claim?.id !== action.claimId) return "This claim is no longer current.";
      if (action.result.platform !== previous.claim.platform)
        return "The result does not match the claimed platform.";
      const current = currentWorkflowValidations(action.result.validations);
      if (
        action.result.status === "passed" &&
        (current.length === 0 ||
          current.some((v) => v.status !== "passed") ||
          action.result.evidence.length === 0)
      )
        return "Passing native verification requires passing checks and native evidence.";
      const results = [...previous.results, action.result];
      const latestForPlatform = new Map(results.map((result) => [result.platform, result]));
      const complete = previous.requiredPlatforms.every((platform) => {
        const result = latestForPlatform.get(platform);
        return result?.status === "passed" && result.commitSha === action.result.commitSha;
      });
      handoff = {
        ...handoff,
        commitSha: action.result.commitSha,
        status: complete ? "completed" : "ready",
        claim: null,
        results,
      };
    }
  }
  const complete = handoff.status === "completed";
  const dependents = new Set([ticket.ticketId]);
  for (let changed = true; changed;) {
    changed = false;
    for (const state of run.ticketStates) {
      if (
        !dependents.has(state.ticketId) &&
        state.dependencyTicketIds.some((id) => dependents.has(id))
      ) {
        dependents.add(state.ticketId);
        changed = true;
      }
    }
  }
  const restored =
    ticket.workerResult && complete
      ? {
          ...ticket.workerResult,
          status: "succeeded" as const,
          commitSha: handoff.commitSha,
          validations: [
            ...ticket.workerResult.validations,
            ...handoff.results
              .filter(
                (result) => result.commitSha === handoff.commitSha && result.status === "passed",
              )
              .flatMap((result) => result.validations)
              .filter((validation) => validation.status !== "blocked")
              .map((validation) => ({
                ...validation,
                status: validation.status === "passed" ? ("passed" as const) : ("failed" as const),
              })),
          ],
        }
      : ticket.workerResult;
  const ownsHalt =
    run.automationHalt?.ticketId === ticket.ticketId ||
    run.retryableFailure?.ticketId === ticket.ticketId;
  return {
    ...run,
    ...(ownsHalt
      ? { status: "running" as const, automationHalt: null, retryableFailure: null }
      : {}),
    ticketStates: run.ticketStates.map((state) =>
      state.ticketId === ticket.ticketId
        ? {
            ...state,
            status: complete ? "running" : "awaiting-native-verification",
            nativeVerification: handoff,
            workerResult: restored,
            ...(complete
              ? {
                  appReviewWorkflowRunId: null,
                  appReviewOutcome: null,
                  appReviewLaunchCount: 0,
                  appReviewGeneration: state.appReviewGeneration + 1,
                  codeReviewThreadId: null,
                  codeReviewOutcome: null,
                  codeReviewGeneration: state.codeReviewGeneration + 1,
                  codeReviewLaunchCount: 0,
                  codeReviewPassCount: 0,
                }
              : {}),
            warningMarkdown: complete
              ? "Native verification returned. Continuing ticket reviews."
              : handoff.status === "canceled"
                ? "Native handoff canceled. Rerun the ticket stage to continue here."
                : "Awaiting native verification on another environment.",
            updatedAt: now,
          }
        : dependents.has(state.ticketId) &&
            state.status === "failed" &&
            !state.workerResult &&
            (state.warningMarkdown ?? "").startsWith("Blocked by failed dependency")
          ? {
              ...state,
              status: "blocked",
              warningMarkdown: null,
              updatedAt: now,
            }
          : state,
    ),
    updatedAt: now,
  };
}
