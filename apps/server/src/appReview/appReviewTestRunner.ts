import * as HostProcess from "@t3tools/shared/HostProcess";
import type {
  AppReviewTestRecording,
  AppReviewTestResult,
  ReviewTestPlatforms,
} from "@t3tools/contracts";
import {
  APP_REVIEW_ARTIFACT_DIR_ENV,
  APP_REVIEW_BASE_REF_ENV,
  APP_REVIEW_PREVIEW_URL_ENV,
  APP_REVIEW_STACK_ID_ENV,
  APP_REVIEW_TEST_PLATFORMS_ENV,
  APP_REVIEW_RECORDER_BINDING_ENV,
  APP_REVIEW_RECORDER_SCRIPT_ENV,
  APP_REVIEW_RECORDING_DIR_ENV,
  APP_REVIEW_TEST_RECORDING_SUFFIX,
} from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
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
const MAX_TEST_LOG_BYTES = 8 * 1024 * 1024;

const prepareTestLogs = Effect.fn("prepareTestLogs")(function* (runDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const random = yield* SecureRandom.SecureRandom;
  const id = yield* random.uuidV4();
  yield* fs.makeDirectory(runDir, { recursive: true });
  const logs = {
    stdout: {
      path: path.join(runDir, `${id}.stdout.log`),
      bytes: 0,
      truncated: false,
      failed: false,
    },
    stderr: {
      path: path.join(runDir, `${id}.stderr.log`),
      bytes: 0,
      truncated: false,
      failed: false,
    },
  };
  for (const log of Object.values(logs)) {
    yield* fs.writeFileString(log.path, "", { flag: "wx", mode: 0o600 });
  }
  return {
    write: Effect.fn("writeTestLog")(function* (stream: "stdout" | "stderr", chunk: Uint8Array) {
      const log = logs[stream];
      if (log.failed) return;
      const remaining = MAX_TEST_LOG_BYTES - log.bytes;
      if (chunk.byteLength > remaining) log.truncated = true;
      if (remaining === 0) return;
      const bytes = chunk.subarray(0, remaining);
      yield* fs.writeFile(log.path, bytes, { flag: "a" }).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            log.bytes += bytes.byteLength;
          }),
        ),
        Effect.catch((error) => {
          log.failed = true;
          return Effect.logWarning("E2E test log could not be saved", error);
        }),
      );
    }),
    describe: () =>
      Object.entries(logs)
        .map(
          ([stream, log]) =>
            `${stream} log: \`${log.path}\`${log.failed ? ". Incomplete because a log write failed." : log.truncated ? ". Truncated at 8 MiB." : ""}`,
        )
        .join("\n"),
  };
});

/** Where a review's collected test recordings live, below `stateDir/preview-artifacts`. */
export const appReviewTestRecordingsDir = (path: Path.Path, stateDir: string, reviewId: string) =>
  path.join(stateDir, "preview-artifacts", "app-review-e2e", reviewId);

/** Suites publish here so builds survive disposal of the reviewed worktree. */
export const appReviewBuildArtifactsDir = (path: Path.Path, stateDir: string, reviewId: string) =>
  path.join(stateDir, "app-review-artifacts", reviewId);

/**
 * Give one command an empty directory to record into and the recorder script
 * to inject. The script is the preview browser's own, so a suite's recordings
 * replay in the same player at the same rrweb version.
 */
const prepareTestRecording = Effect.fn("prepareTestRecording")(function* (runDir: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const random = yield* SecureRandom.SecureRandom;
  const id = yield* random.uuidV4();
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

/** Cancellation closes ProcessRunner's scope and terminates its child process. */
interface AppReviewTestInput {
  readonly command: string;
  readonly retryCommand: string;
  readonly cwd: string;
  readonly previewUrl: string | null;
  /** The App Stack serving `previewUrl`, when the reviewed worktree has one. */
  readonly stackId?: string | null | undefined;
  readonly baseRef?: string | null | undefined;
  readonly testPlatforms?: typeof ReviewTestPlatforms.Type | undefined;
  readonly executionId: string;
  /** Directory for this run's test recordings; omitted where the server has no state dir. */
  readonly recordingsDir?: string | undefined;
  readonly artifactsDir?: string | undefined;
  /** Extra environment the server grants every suite, such as its Stacks controller access. */
  readonly env?: Readonly<Record<string, string>> | undefined;
  readonly timeoutMinutes?: number | undefined;
  /** Run a failed command once more before reporting it, unless it timed out. */
  readonly retryFailure?: boolean | undefined;
}

export const runAppReviewTest = Effect.fn("runAppReviewTest")(function* (
  input: AppReviewTestInput,
) {
  const first = yield* runAppReviewTestOnce(input);
  if (input.retryFailure !== true || first.result.status === "passed" || first.timedOut) {
    return first.result;
  }
  const second = yield* runAppReviewTestOnce(input);
  const recordings = [...(first.result.recordings ?? []), ...(second.result.recordings ?? [])];
  return {
    ...second.result,
    outputMarkdown: [
      second.result.status === "passed"
        ? "The command failed, then passed when run again, so a test in it is flaky."
        : "The command failed twice.",
      `First run:\n\n${first.result.outputMarkdown}`,
      `Second run:\n\n${second.result.outputMarkdown}`,
    ].join("\n\n"),
    ...(recordings.length === 0 ? {} : { recordings }),
  } satisfies AppReviewTestResult;
});

// Untraced: runAppReviewTest's span already covers each attempt.
const runAppReviewTestOnce = Effect.fnUntraced(function* (input: AppReviewTestInput) {
  const runner = yield* ProcessRunner;
  const platform = yield* HostProcess.Platform;
  const timeoutMinutes = input.timeoutMinutes ?? 45;
  // Recording is evidence, not the test: a full disk must not fail the suite.
  const recording =
    input.recordingsDir === undefined
      ? null
      : yield* prepareTestRecording(input.recordingsDir).pipe(
          Effect.tapError((error) => Effect.logWarning("E2E recording unavailable", error)),
          Effect.orElseSucceed(() => null),
        );
  const logs =
    input.recordingsDir === undefined
      ? null
      : yield* prepareTestLogs(input.recordingsDir).pipe(
          Effect.tapError((error) => Effect.logWarning("E2E test logs unavailable", error)),
          Effect.orElseSucceed(() => null),
        );
  const artifactsDir = input.artifactsDir;
  const result = yield* (
    artifactsDir === undefined
      ? Effect.void
      : Effect.flatMap(FileSystem.FileSystem, (fs) =>
          fs.makeDirectory(artifactsDir, { recursive: true, mode: 0o700 }),
        )
  ).pipe(
    Effect.andThen(
      runner.run({
        command: platform === "win32" ? "cmd.exe" : "/bin/sh",
        args:
          platform === "win32"
            ? ["/d", "/s", "/c", input.retryCommand]
            : ["-c", input.retryCommand],
        cwd: input.cwd,
        env: {
          ...input.env,
          [APP_REVIEW_ARTIFACT_DIR_ENV]: input.artifactsDir ?? "",
          [APP_REVIEW_PREVIEW_URL_ENV]: input.previewUrl ?? "",
          [APP_REVIEW_TEST_PLATFORMS_ENV]: (input.testPlatforms ?? ["web"]).join(","),
          APP_REVIEW_EXECUTION_ID: input.executionId,
          APP_REVIEW_TEST_TIMEOUT_MS: String(timeoutMinutes * 60_000),
          ...(input.stackId == null ? {} : { [APP_REVIEW_STACK_ID_ENV]: input.stackId }),
          ...(input.baseRef == null ? {} : { [APP_REVIEW_BASE_REF_ENV]: input.baseRef }),
          ...(recording === null
            ? {}
            : {
                [APP_REVIEW_RECORDING_DIR_ENV]: recording.incomingDir,
                [APP_REVIEW_RECORDER_SCRIPT_ENV]: recording.scriptPath,
                [APP_REVIEW_RECORDER_BINDING_ENV]: DOM_RECORDER_BINDING,
              }),
        },
        timeout: `${timeoutMinutes} minutes`,
        timeoutBehavior: "timedOutResult",
        maxOutputBytes: 8_192,
        outputMode: "truncate",
        ...(logs === null ? {} : { onOutputChunk: logs.write }),
      }),
    ),
    Effect.map((output) => ({
      timedOut: output.timedOut,
      status: output.code === 0 && !output.timedOut ? ("passed" as const) : ("failed" as const),
      outputMarkdown: [
        output.timedOut
          ? `Test command exceeded the ${timeoutMinutes} minute limit.`
          : `Exit code: ${output.code ?? "none"}\n${output.stdout}\n${output.stderr}`,
        ...(output.stdoutTruncated ? ["Inline stdout was truncated."] : []),
        ...(output.stderrTruncated ? ["Inline stderr was truncated."] : []),
      ].join("\n\n"),
    })),
    Effect.catch((error) =>
      Effect.succeed({ timedOut: false, status: "failed" as const, outputMarkdown: error.message }),
    ),
  );
  const recordings =
    recording === null || input.recordingsDir === undefined
      ? []
      : yield* collectTestRecordings({ ...recording, runDir: input.recordingsDir }).pipe(
          Effect.tapError((error) => Effect.logWarning("E2E recordings not collected", error)),
          Effect.orElseSucceed(() => []),
        );
  const { timedOut, ...outcome } = result;
  const testResult = {
    command: input.command,
    executedCommand: input.retryCommand,
    ...outcome,
    outputMarkdown: [
      result.outputMarkdown,
      logs?.describe() ?? "No test output logs were retained.",
      ...(input.artifactsDir === undefined
        ? []
        : [`Build artifact directory: \`${input.artifactsDir}\``]),
    ].join("\n\n"),
    ...(recordings.length === 0 ? {} : { recordings }),
    completedAt: DateTime.formatIso(yield* DateTime.now),
  } satisfies AppReviewTestResult;
  return { result: testResult, timedOut };
});
