import type {
  AppReviewTestRecording,
  AppReviewTestResult,
  AppReviewWorkflowCycle,
  AppReviewWorkflowFixResult,
  ReviewTestPlatforms,
} from "@t3tools/contracts";
import {
  APP_REVIEW_PREVIEW_URL_ENV,
  APP_REVIEW_STACK_ID_ENV,
  APP_REVIEW_TEST_PLATFORMS_ENV,
  APP_REVIEW_RECORDER_BINDING_ENV,
  APP_REVIEW_RECORDER_SCRIPT_ENV,
  APP_REVIEW_RECORDING_DIR_ENV,
  APP_REVIEW_TEST_RECORDING_SUFFIX,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import {
  buildBootstrapScript,
  DOM_RECORDER_BINDING,
  loadRrwebRecordScript,
} from "../preview/DomRecorder.ts";
import { ProcessRunner } from "../processRunner.ts";

/** A fleet run records every test of a suite; past this the run is misconfigured. */
const MAX_TEST_RECORDINGS = 2_000;

/** Where a run's collected test recordings live, below `stateDir/preview-artifacts`. */
export const appReviewTestRecordingsDir = (path: Path.Path, stateDir: string, runId: string) =>
  path.join(stateDir, "preview-artifacts", "app-review-e2e", runId);

/**
 * Give one command an empty directory to record into and the recorder script
 * to inject. The script is the preview browser's own, so a suite's recordings
 * replay in the same player at the same rrweb version.
 */
const prepareTestRecording = Effect.fn("prepareTestRecording")(function* (runDir: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const id = yield* crypto.randomUUIDv4;
  const incomingDir = path.join(runDir, `${id}.incoming`);
  yield* fileSystem.makeDirectory(incomingDir, { recursive: true });
  const scriptPath = path.join(runDir, "recorder.js");
  const script = buildBootstrapScript(yield* Effect.promise(loadRrwebRecordScript));
  yield* fileSystem.writeFileString(scriptPath, script);
  return { id, incomingDir, scriptPath };
});

/**
 * Move what the suite recorded next to the run's other recordings under
 * server-chosen names, so a recording id alone locates its file.
 */
const collectTestRecordings = Effect.fn("collectTestRecordings")(function* (input: {
  readonly runDir: string;
  readonly id: string;
  readonly incomingDir: string;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const names = (yield* fileSystem.readDirectory(input.incomingDir))
    .filter((name) => name.endsWith(APP_REVIEW_TEST_RECORDING_SUFFIX))
    .toSorted()
    .slice(0, MAX_TEST_RECORDINGS);
  const recordings: AppReviewTestRecording[] = [];
  for (const [index, name] of names.entries()) {
    const label = name.slice(0, -APP_REVIEW_TEST_RECORDING_SUFFIX.length).trim();
    const source = path.join(input.incomingDir, name);
    const info = yield* fileSystem.stat(source);
    if (label === "" || info.type !== "File" || Number(info.size) === 0) continue;
    const id = `${input.id}-${index + 1}`;
    const target = path.join(input.runDir, `${id}${APP_REVIEW_TEST_RECORDING_SUFFIX}`);
    yield* fileSystem.rename(source, target);
    recordings.push({ id, label, path: target, sizeBytes: Number(info.size) });
  }
  yield* fileSystem.remove(input.incomingDir, { recursive: true });
  return recordings;
});

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
  /** The App Stack serving `previewUrl`, when the reviewed worktree has one. */
  readonly stackId?: string | null | undefined;
  readonly testPlatforms?: typeof ReviewTestPlatforms.Type | undefined;
  readonly executionId: string;
  /** Directory for this run's test recordings; omitted where the server has no state dir. */
  readonly recordingsDir?: string | undefined;
  /** Extra environment the server grants every suite, such as its Stacks controller access. */
  readonly env?: Readonly<Record<string, string>> | undefined;
}) {
  const runner = yield* ProcessRunner;
  const platform = yield* HostProcessPlatform;
  // Recording is evidence, not the test: a full disk must not fail the suite.
  const recording =
    input.recordingsDir === undefined
      ? null
      : yield* prepareTestRecording(input.recordingsDir).pipe(
          Effect.tapError((error) => Effect.logWarning("E2E recording unavailable", error)),
          Effect.orElseSucceed(() => null),
        );
  const result = yield* runner
    .run({
      command: platform === "win32" ? "cmd.exe" : "/bin/sh",
      args:
        platform === "win32" ? ["/d", "/s", "/c", input.retryCommand] : ["-c", input.retryCommand],
      cwd: input.cwd,
      env: {
        ...input.env,
        [APP_REVIEW_PREVIEW_URL_ENV]: input.previewUrl ?? "",
        [APP_REVIEW_TEST_PLATFORMS_ENV]: (input.testPlatforms ?? ["web"]).join(","),
        APP_REVIEW_EXECUTION_ID: input.executionId,
        ...(input.stackId == null ? {} : { [APP_REVIEW_STACK_ID_ENV]: input.stackId }),
        ...(recording === null
          ? {}
          : {
              [APP_REVIEW_RECORDING_DIR_ENV]: recording.incomingDir,
              [APP_REVIEW_RECORDER_SCRIPT_ENV]: recording.scriptPath,
              [APP_REVIEW_RECORDER_BINDING_ENV]: DOM_RECORDER_BINDING,
            }),
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
  const recordings =
    recording === null || input.recordingsDir === undefined
      ? []
      : yield* collectTestRecordings({ ...recording, runDir: input.recordingsDir }).pipe(
          Effect.tapError((error) => Effect.logWarning("E2E recordings not collected", error)),
          Effect.orElseSucceed(() => []),
        );
  return {
    command: input.command,
    executedCommand: input.retryCommand,
    ...result,
    ...(recordings.length === 0 ? {} : { recordings }),
    completedAt: DateTime.formatIso(yield* DateTime.now),
  } satisfies AppReviewTestResult;
});
