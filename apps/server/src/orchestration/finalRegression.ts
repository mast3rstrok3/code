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

/** Accept only the requested selection, once, with a fresh result for every pending check. */
export function recordRegressionCycle(input: {
  state: FinalRegressionState;
  validations: readonly OrchestrationImplementationValidationResult[];
  headSha: string;
  completedAt: string;
}): FinalRegressionState {
  const expected = new Set(regressionCommands(input.state));
  const unexpectedFailure = input.validations.some(
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
      const matches = input.validations.filter(
        (result) => result.purpose !== "reproduction" && result.command === command,
      );
      const result =
        matches.length === 1 && !unexpectedFailure
          ? matches[0]!
          : {
              command,
              status: "failed" as const,
              outputMarkdown:
                "The validator must report exactly one result for this selection and resolve every reported failure.",
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
): FinalRegressionState {
  const reviewed =
    invalidatedCommands !== undefined &&
    Boolean(impactMarkdown?.trim()) &&
    invalidatedCommands.every((command) => state.checks.some((check) => check.command === command));
  return {
    ...state,
    reviewBaseSha: null,
    checks: state.checks.map((check) =>
      !reviewed || invalidatedCommands?.includes(check.command)
        ? { ...check, result: null }
        : check,
    ),
  };
}
