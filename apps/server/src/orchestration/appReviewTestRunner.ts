import type {
  AppReviewTestResult,
  AppReviewWorkflowCycle,
  AppReviewWorkflowFixResult,
} from "@t3tools/contracts";
import { APP_REVIEW_PREVIEW_URL_ENV } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { ProcessRunner } from "../processRunner.ts";

/** Match results to the persisted selection, independent of completion order. */
export function completedAppReviewTests(
  execution: NonNullable<AppReviewWorkflowCycle["e2eExecution"]>,
) {
  return execution.commands.flatMap((selection) => {
    const result = execution.results.find(
      (entry) =>
        entry.command === selection.command && entry.executedCommand === selection.retryCommand,
    );
    return result === undefined ? [] : [result];
  });
}

/** A repair may narrow failed suites, but cannot reopen or replace other suites. */
export function appReviewRetryCommandsFailure(
  cycle: Pick<AppReviewWorkflowCycle, "e2eExecution">,
  result: Pick<AppReviewWorkflowFixResult, "retryCommands">,
): string | null {
  const failedCommands = new Set(
    cycle.e2eExecution === undefined
      ? []
      : completedAppReviewTests(cycle.e2eExecution)
          .filter((entry) => entry.status === "failed")
          .map((entry) => entry.command),
  );
  const seen = new Set<string>();
  for (const selection of result.retryCommands ?? []) {
    if (!selection.command?.trim() || !selection.retryCommand?.trim()) {
      return "Retry mappings require non-empty command and retryCommand strings.";
    }
    if (seen.has(selection.command)) {
      return `Duplicate retry mapping for '${selection.command}'.`;
    }
    if (!failedCommands.has(selection.command)) {
      return `Retry mapping '${selection.command}' does not match a failed command in this cycle.`;
    }
    seen.add(selection.command);
  }
  return null;
}

/** Keep passing suites and rerun the failed selection after each committed repair. */
export function appReviewTestCommands(
  run: {
    readonly cycles: ReadonlyArray<Pick<AppReviewWorkflowCycle, "e2eExecution" | "fixResult">>;
  },
  commands: readonly string[],
) {
  const previous = run.cycles.at(-1);
  if (!previous?.e2eExecution) {
    return [...new Set(commands)].map((command) => ({ command, retryCommand: command }));
  }
  const completed = completedAppReviewTests(previous.e2eExecution);
  return previous.e2eExecution.commands.flatMap((selection) => {
    const result = completed.find((entry) => entry.command === selection.command);
    if (result?.status === "passed") return [];
    const retry = previous.fixResult?.retryCommands?.find(
      (entry) => entry.command === selection.command,
    );
    return [
      { command: selection.command, retryCommand: retry?.retryCommand ?? selection.retryCommand },
    ];
  });
}

/** Cancellation closes ProcessRunner's scope and terminates its child process. */
export const runAppReviewTest = Effect.fn("runAppReviewTest")(function* (input: {
  readonly command: string;
  readonly retryCommand: string;
  readonly cwd: string;
  readonly previewUrl: string | null;
  readonly executionId: string;
}) {
  const runner = yield* ProcessRunner;
  const platform = yield* HostProcessPlatform;
  const result = yield* runner
    .run({
      command: platform === "win32" ? "cmd.exe" : "/bin/sh",
      args:
        platform === "win32" ? ["/d", "/s", "/c", input.retryCommand] : ["-c", input.retryCommand],
      cwd: input.cwd,
      env: {
        [APP_REVIEW_PREVIEW_URL_ENV]: input.previewUrl ?? "",
        APP_REVIEW_EXECUTION_ID: input.executionId,
      },
      timeout: "45 minutes",
      timeoutBehavior: "timedOutResult",
      maxOutputBytes: 8_192,
      outputMode: "truncate",
    })
    .pipe(
      Effect.map((output) => ({
        status: output.code === 0 && !output.timedOut ? ("passed" as const) : ("failed" as const),
        outputMarkdown: output.timedOut
          ? "Test command exceeded the 45 minute limit."
          : `Exit code: ${output.code ?? "none"}\n${output.stdout}\n${output.stderr}`,
      })),
      Effect.catch((error) =>
        Effect.succeed({ status: "failed" as const, outputMarkdown: error.message }),
      ),
    );
  return {
    command: input.command,
    executedCommand: input.retryCommand,
    ...result,
    completedAt: DateTime.formatIso(yield* DateTime.now),
  } satisfies AppReviewTestResult;
});
