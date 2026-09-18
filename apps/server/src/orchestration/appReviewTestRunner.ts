import type { AppReviewTestResult, AppReviewWorkflowCycle } from "@t3tools/contracts";
import { APP_REVIEW_PREVIEW_URL_ENV } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { ProcessRunner } from "../processRunner.ts";

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
  return previous.e2eExecution.commands.flatMap((selection) => {
    const result = previous.e2eExecution!.results.find(
      (entry) => entry.command === selection.command,
    );
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
