import { currentWorkflowValidations } from "./workflowValidation.ts";
import type {
  FinalRegressionState,
  OrchestrationImplementationValidationResult,
} from "@t3tools/contracts";

export function regressionCommands(state: FinalRegressionState): string[] {
  return [
    ...new Set(
      state.checks
        .filter((check) => check.result?.status !== "passed")
        .map((check) => check.result?.retryCommand ?? check.command),
    ),
  ];
}

export function regressionPassed(state: FinalRegressionState, requiredCommands: readonly string[]) {
  return (
    requiredCommands.every((command) =>
      state.checks.some((check) => check.command === command && check.result?.status === "passed"),
    ) && state.checks.every((check) => check.result?.status === "passed")
  );
}

function resultForCommand(
  command: string,
  validations: readonly OrchestrationImplementationValidationResult[],
  current: readonly OrchestrationImplementationValidationResult[],
) {
  const direct = current.find((result) => result.command === command);
  const replacement = current.find(
    (result) =>
      result.status === "passed" &&
      validations.some(
        (prior) =>
          prior.command === command &&
          prior.purpose !== "reproduction" &&
          prior.status !== "passed" &&
          Date.parse(prior.completedAt) < Date.parse(result.completedAt),
      ) &&
      validations.some(
        (record) =>
          record.command === result.command &&
          record.completedAt === result.completedAt &&
          record.supersedesCommand === command,
      ),
  );
  return direct ?? replacement ?? null;
}

/** Resolve each requested selection while preserving setup corrections and their history. */
export function recordRegressionCycle(input: {
  state: FinalRegressionState;
  validations: readonly OrchestrationImplementationValidationResult[];
  headSha: string;
  completedAt: string;
}): FinalRegressionState {
  const expected = new Set(regressionCommands(input.state));
  const current = currentWorkflowValidations(input.validations);
  const unexpectedFailure = current.some(
    (result) =>
      result.purpose !== "reproduction" &&
      result.status !== "passed" &&
      !expected.has(result.command),
  );
  return {
    ...input.state,
    launchCount: 0,
    cycles: [
      ...input.state.cycles,
      {
        headSha: input.headSha,
        validations: [...input.validations],
        completedAt: input.completedAt,
      },
    ],
    checks: input.state.checks.map((check) => {
      if (check.result?.status === "passed") return check;
      const command = check.result?.retryCommand ?? check.command;
      const reported = resultForCommand(command, input.validations, current);
      const result =
        reported && !unexpectedFailure
          ? reported
          : {
              command,
              status: "failed" as const,
              outputMarkdown:
                "The validator must resolve every reported failure and provide a current result for this selection.",
              completedAt: input.completedAt,
            };
      return { ...check, result };
    }),
  };
}

/** Without an explicit impact review, passing results cannot be carried across a repair. */
export function invalidateRegressionChecks(
  state: FinalRegressionState,
  invalidatedCommands: readonly string[] | undefined,
  impactMarkdown: string | undefined,
  reviewedRetryCommands: readonly { command: string; retryCommand: string }[] = [],
): FinalRegressionState {
  const reviewed =
    invalidatedCommands !== undefined &&
    Boolean(impactMarkdown?.trim()) &&
    invalidatedCommands.every((command) =>
      state.checks.some((check) => check.command === command),
    ) &&
    new Set(reviewedRetryCommands.map((selection) => selection.command)).size ===
      reviewedRetryCommands.length &&
    reviewedRetryCommands.every(
      (selection) =>
        state.checks.some(
          (check) => check.command === selection.command && check.result?.status !== "passed",
        ) && Boolean(selection.retryCommand.trim()),
    );
  return {
    ...state,
    reviewBaseSha: null,
    checks: state.checks.map((check) => {
      if (!reviewed || invalidatedCommands?.includes(check.command))
        return { ...check, result: null };
      const selection = reviewedRetryCommands.find((entry) => entry.command === check.command);
      return selection && check.result
        ? { ...check, result: { ...check.result, retryCommand: selection.retryCommand } }
        : check;
    }),
  };
}

/** Carry a completed legacy gate into cycle one, including corrected setup attempts. */
export function recoverLegacyRegression(input: {
  requiredCommands: readonly string[];
  validations: readonly OrchestrationImplementationValidationResult[];
  headSha: string;
  completedAt: string;
}): FinalRegressionState {
  const current = currentWorkflowValidations(input.validations);
  const checks = [...new Set(input.requiredCommands)].map((command) => {
    return { command, result: resultForCommand(command, input.validations, current) };
  });
  for (const result of current) {
    if (result.status !== "passed" && !checks.some((check) => check.result === result)) {
      checks.push({ command: result.command, result });
    }
  }
  return {
    checks,
    cycles: [
      {
        headSha: input.headSha,
        validations: [...input.validations],
        completedAt: input.completedAt,
      },
    ],
    reviewBaseSha: input.headSha,
    launchCount: 0,
  };
}
