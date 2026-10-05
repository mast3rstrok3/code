import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, expect } from "@effect/vitest";
import { AppReviewWorkflowRunId, type AppReviewWorkflowCycle } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/unstable/process";
import {
  layer as processRunnerLayer,
  ProcessRunner,
  type ProcessRunInput,
} from "../processRunner.ts";
import {
  appReviewRetryCommandsFailure,
  appReviewTestCommands,
  completedAppReviewTests,
  restoreAppReviewTestWrites,
  runAppReviewTest,
} from "./appReviewTestRunner.ts";

const completedAt = "2026-09-18T07:00:00.000Z";
const selections = ["calendar", "lists", "chat"].map((command) => ({
  command,
  retryCommand: command,
}));

it.effect("retains published builds after a failed command and worktree disposal", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped();
    const cwd = path.join(root, "worktree");
    const artifactsDir = path.join(root, "server-state", "workflow-build-artifacts", "review-1");
    yield* fs.makeDirectory(cwd);
    yield* fs.writeFileString(
      path.join(cwd, "publish.cjs"),
      `const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const apk = Buffer.from('review APK');
const dir = process.env.APP_REVIEW_ARTIFACT_DIR;
fs.writeFileSync(path.join(dir, 'candidate.apk'), apk);
fs.writeFileSync(path.join(dir, 'recipe.json'), JSON.stringify({sha256: crypto.createHash('sha256').update(apk).digest('hex')}));
process.exitCode = 1;`,
    );
    const input = {
      command: "suite",
      retryCommand: "node publish.cjs",
      cwd,
      previewUrl: null,
      executionId: "publish",
      artifactsDir,
      env: { APP_REVIEW_ARTIFACT_DIR: path.join(cwd, "wrong-directory") },
    };
    const failed = yield* runAppReviewTest(input);
    expect(failed.status).toBe("failed");
    expect(failed.outputMarkdown).toContain(artifactsDir);
    yield* fs.remove(cwd, { recursive: true });
    yield* fs.makeDirectory(cwd);
    yield* fs.writeFileString(
      path.join(cwd, "restore.cjs"),
      `const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const dir = process.env.APP_REVIEW_ARTIFACT_DIR;
const apk = fs.readFileSync(path.join(dir, 'candidate.apk'));
const recipe = JSON.parse(fs.readFileSync(path.join(dir, 'recipe.json'), 'utf8'));
if (crypto.createHash('sha256').update(apk).digest('hex') !== recipe.sha256) throw new Error('Checksum mismatch');
fs.writeFileSync('restored.apk', apk);`,
    );
    const restored = yield* runAppReviewTest({
      ...input,
      retryCommand: "node restore.cjs",
      executionId: "restore",
    });
    expect(restored.status).toBe("passed");
    expect(yield* fs.readFileString(path.join(cwd, "restored.apk"))).toBe("review APK");
    expect(yield* fs.readFileString(path.join(artifactsDir, "candidate.apk"))).toBe("review APK");
  }).pipe(
    Effect.scoped,
    Effect.provide(processRunnerLayer.pipe(Layer.provideMerge(NodeServices.layer))),
  ),
);

it.effect("fails before launching a suite when its artifact directory cannot be created", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped();
    const path = yield* Path.Path;
    const file = path.join(root, "file");
    yield* fs.writeFileString(file, "occupied");
    const result = yield* runAppReviewTest({
      command: "suite",
      retryCommand: "suite",
      cwd: root,
      previewUrl: null,
      executionId: "unavailable-store",
      artifactsDir: path.join(file, "builds"),
    }).pipe(
      Effect.provideService(ProcessRunner, {
        run: () => Effect.die("Suite launched without its artifact directory"),
      }),
    );
    expect(result.status).toBe("failed");
    expect(result.outputMarkdown).toContain("makeDirectory");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("retains failure output beyond the inline limit in private logs", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const platform = yield* HostProcessPlatform;
    const cwd = yield* fs.makeTempDirectoryScoped();
    const script = path.join(cwd, "fail.cjs");
    const stdout = `${"x".repeat(9_000)}\nLast stdout failure\n`;
    const stderr = `${"y".repeat(9_000)}\nLast stderr failure\n`;
    yield* fs.writeFileString(
      script,
      "process.stdout.write('x'.repeat(9000) + '\\nLast stdout failure\\n'); process.stderr.write('y'.repeat(9000) + '\\nLast stderr failure\\n'); process.exitCode = 1;",
    );
    const recordingsDir = path.join(cwd, "evidence");
    const result = yield* runAppReviewTest({
      command: "suite",
      retryCommand: "node fail.cjs",
      cwd,
      previewUrl: null,
      executionId: "failure-output",
      recordingsDir,
    });
    expect(result.status).toBe("failed");
    expect(result.outputMarkdown).toContain("Inline stdout was truncated");
    expect(result.outputMarkdown).toContain("Inline stderr was truncated");
    expect(result.outputMarkdown.length).toBeLessThan(18_000);
    const files = yield* fs.readDirectory(recordingsDir);
    for (const [stream, expected] of [
      ["stdout", stdout],
      ["stderr", stderr],
    ] as const) {
      const file = files.find((name) => name.endsWith(`.${stream}.log`));
      expect(file).toBeDefined();
      const logPath = path.join(recordingsDir, file!);
      expect(result.outputMarkdown).toContain(logPath);
      expect(yield* fs.readFileString(logPath)).toBe(expected);
      if (platform !== "win32") {
        expect((yield* fs.stat(logPath)).mode & 0o777).toBe(0o600);
      }
    }
  }).pipe(
    Effect.scoped,
    Effect.provide(processRunnerLayer.pipe(Layer.provideMerge(NodeServices.layer))),
  ),
);

for (const scenario of ["timeout", "log-limit", "write-failure"] as const) {
  it.effect(`retains honest test diagnostics after ${scenario}`, () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const recordingsDir = yield* fs.makeTempDirectoryScoped();
      const output = scenario === "log-limit" ? "x".repeat(8 * 1024 * 1024 + 100) : "last failure";
      const result = yield* runAppReviewTest({
        command: "suite",
        retryCommand: "suite",
        cwd: recordingsDir,
        previewUrl: null,
        executionId: scenario,
        recordingsDir,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          writeFile: (file, bytes, options) =>
            scenario === "write-failure" && file.endsWith(".log")
              ? Effect.fail(
                  PlatformError.systemError({
                    _tag: "PermissionDenied",
                    module: "FileSystem",
                    method: "writeFile",
                  }),
                )
              : fs.writeFile(file, bytes, options),
        }),
        Effect.provideService(ProcessRunner, {
          run: (input) =>
            Effect.gen(function* () {
              yield* input.onOutputChunk!("stdout", new TextEncoder().encode(output));
              yield* input.onOutputChunk!("stdout", new TextEncoder().encode("\nend"));
              return {
                code: scenario === "timeout" ? null : ChildProcessSpawner.ExitCode(0),
                timedOut: scenario === "timeout",
                stdout: "",
                stderr: "",
                stdoutTruncated: scenario === "log-limit",
                stderrTruncated: false,
                stdoutInvalidUtf8: false,
                stderrInvalidUtf8: false,
              };
            }),
        }),
      );
      expect(result.status).toBe(scenario === "timeout" ? "failed" : "passed");
      const file = (yield* fs.readDirectory(recordingsDir)).find((name) =>
        name.endsWith(".stdout.log"),
      );
      expect(file).toBeDefined();
      const logPath = path.join(recordingsDir, file!);
      expect(result.outputMarkdown).toContain(logPath);
      const saved = yield* fs.readFileString(logPath);
      if (scenario === "timeout") {
        expect(result.outputMarkdown).toContain("exceeded the 45 minute limit");
        expect(saved).toBe("last failure\nend");
      } else if (scenario === "log-limit") {
        expect(result.outputMarkdown).toContain("Truncated at 8 MiB");
        expect(saved).toHaveLength(8 * 1024 * 1024);
      } else {
        expect(result.outputMarkdown).toContain("Incomplete because a log write failed");
        expect(saved).toBe("");
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
}

it("uses a repair's failed-test selector and never reopens a passed suite", () => {
  expect(
    appReviewTestCommands(
      {
        cycles: [
          {
            e2eExecution: {
              id: "failed",
              commands: selections.slice(0, 2),
              results: [
                {
                  command: "calendar",
                  executedCommand: "calendar",
                  status: "passed",
                  outputMarkdown: "",
                  completedAt,
                },
                {
                  command: "lists",
                  executedCommand: "lists",
                  status: "failed",
                  outputMarkdown: "",
                  completedAt,
                },
              ],
            },
            fixResult: {
              runId: AppReviewWorkflowRunId.make("review"),
              planId: "repair",
              status: "succeeded",
              validations: [],
              notesMarkdown: "Fixed search",
              retryCommands: [{ command: "lists", retryCommand: "lists --grep search" }],
            },
          },
        ],
      },
      ["all-apps"],
    ),
  ).toEqual([{ command: "lists", retryCommand: "lists --grep search" }]);
});

it("runs the ticket's exact selection once on the first cycle", () => {
  expect(
    appReviewTestCommands({ cycles: [] }, ["calendar --grep booking", "calendar --grep booking"]),
  ).toEqual([{ command: "calendar --grep booking", retryCommand: "calendar --grep booking" }]);
});

it("keeps passed suites and retries only failed or unfinished suites", () => {
  expect(
    appReviewTestCommands(
      {
        cycles: [
          {
            fixResult: null,
            e2eExecution: {
              id: "first",
              commands: selections,
              results: [
                {
                  command: "calendar",
                  executedCommand: "calendar",
                  status: "passed",
                  outputMarkdown: "",
                  completedAt,
                },
                {
                  command: "lists",
                  executedCommand: "lists",
                  status: "failed",
                  outputMarkdown: "Search fails",
                  completedAt,
                },
              ],
            },
          },
        ],
      },
      ["all-apps"],
    ),
  ).toEqual(selections.slice(1));
});

const failedSelection = {
  id: "retry",
  commands: [{ command: "lists", retryCommand: "lists --grep search" }],
  results: [
    {
      command: "lists",
      executedCommand: "lists --grep search",
      status: "failed",
      outputMarkdown: "Search fails",
      completedAt,
    },
  ],
} satisfies NonNullable<AppReviewWorkflowCycle["e2eExecution"]>;

it("keeps the last failed selection when a repair cannot narrow it", () => {
  expect(
    appReviewTestCommands({ cycles: [{ e2eExecution: failedSelection, fixResult: null }] }, [
      "all-apps",
    ]),
  ).toEqual(failedSelection.commands);
});

it("does not reopen suites from earlier cycles", () => {
  expect(
    appReviewTestCommands(
      {
        cycles: [
          { e2eExecution: { ...failedSelection, commands: selections }, fixResult: null },
          { e2eExecution: failedSelection, fixResult: null },
        ],
      },
      ["calendar", "lists", "chat"],
    ),
  ).toEqual(failedSelection.commands);
});

it.each([
  { command: "unknown", retryCommand: "unknown --grep test" },
  { command: "calendar", retryCommand: "calendar --grep booking" },
])("rejects retry mappings for suites that did not fail: $command", (mapping) => {
  const cycle = {
    e2eExecution: {
      ...failedSelection,
      commands: [...failedSelection.commands, selections[0]!],
      results: [
        ...failedSelection.results,
        {
          ...failedSelection.results[0]!,
          command: "calendar",
          executedCommand: "calendar",
          status: "passed" as const,
        },
      ],
    },
  };
  expect(appReviewRetryCommandsFailure(cycle, { retryCommands: [mapping] })).toContain(
    "does not match a failed command",
  );
});

it("rejects duplicate retry mappings and accepts a single failed-suite mapping", () => {
  const mapping = { command: "lists", retryCommand: "lists --grep search" };
  expect(
    appReviewRetryCommandsFailure(
      { e2eExecution: failedSelection },
      { retryCommands: [mapping, mapping] },
    ),
  ).toContain("Duplicate retry mapping");
  expect(
    appReviewRetryCommandsFailure({ e2eExecution: failedSelection }, { retryCommands: [mapping] }),
  ).toBeNull();
  expect(appReviewRetryCommandsFailure({ e2eExecution: failedSelection }, {})).toBeNull();
});

it("matches actual executions and ignores duplicate or unrelated results", () => {
  const result = failedSelection.results[0]!;
  const execution = {
    ...failedSelection,
    commands: [...failedSelection.commands, selections[0]!],
    results: [
      { ...result, command: "unrelated", executedCommand: "unrelated", status: "passed" as const },
      { ...result, executedCommand: "old-selection", status: "passed" as const },
      result,
      result,
    ],
  };
  expect(completedAppReviewTests(execution)).toEqual([result]);
  expect(
    appReviewTestCommands({ cycles: [{ e2eExecution: execution, fixResult: null }] }, []),
  ).toEqual(execution.commands);
});

for (const [code, timedOut, status, timeoutMinutes] of [
  [0, false, "passed", undefined],
  [1, false, "failed", undefined],
  [null, true, "failed", undefined],
  [0, false, "passed", 120],
  [null, true, "failed", 120],
] as const) {
  it.effect(
    `records command exit ${code}, timeout ${timedOut} with a ${timeoutMinutes ?? 45} minute limit`,
    () =>
      Effect.gen(function* () {
        const calls: ProcessRunInput[] = [];
        const result = yield* runAppReviewTest({
          command: "suite",
          retryCommand: "suite --grep failed",
          cwd: "/assigned",
          previewUrl: "https://assigned.example",
          executionId: "cycle-2",
          stackId: "stack-assigned",
          testPlatforms: ["web", "android"],
          env: { APP_REVIEW_TEST_PLATFORMS: "ios", APP_REVIEW_TEST_TIMEOUT_MS: "1" },
          timeoutMinutes,
        }).pipe(
          Effect.provideService(ProcessRunner, {
            run: (input) => {
              calls.push(input);
              return Effect.succeed({
                code: code === null ? null : ChildProcessSpawner.ExitCode(code),
                timedOut,
                stdout: "test output",
                stderr: "",
                stdoutTruncated: false,
                stderrTruncated: false,
                stdoutInvalidUtf8: false,
                stderrInvalidUtf8: false,
              });
            },
          }),
        );
        expect(result).toMatchObject({
          command: "suite",
          executedCommand: "suite --grep failed",
          status,
        });
        expect(calls).toHaveLength(1);
        if (timedOut) {
          expect(result.outputMarkdown).toContain(
            `exceeded the ${timeoutMinutes ?? 45} minute limit`,
          );
        }
        expect(calls[0]).toMatchObject({
          cwd: "/assigned",
          env: {
            APP_REVIEW_PREVIEW_URL: "https://assigned.example",
            APP_REVIEW_EXECUTION_ID: "cycle-2",
            APP_REVIEW_STACK_ID: "stack-assigned",
            APP_REVIEW_TEST_PLATFORMS: "web,android",
            APP_REVIEW_TEST_TIMEOUT_MS: String((timeoutMinutes ?? 45) * 60_000),
          },
          timeout: `${timeoutMinutes ?? 45} minutes`,
          maxOutputBytes: 8192,
        });
      }).pipe(Effect.provide(NodeServices.layer)),
  );
}

it.effect("interrupts the process scope when execution is cancelled", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const stopped = yield* Deferred.make<void>();
    const task = yield* runAppReviewTest({
      command: "suite",
      retryCommand: "suite",
      cwd: "/assigned",
      previewUrl: null,
      executionId: "cancelled",
    }).pipe(
      Effect.provideService(ProcessRunner, {
        run: () =>
          Effect.scoped(
            Effect.gen(function* () {
              yield* Effect.addFinalizer(() => Deferred.succeed(stopped, undefined));
              yield* Deferred.succeed(started, undefined);
              return yield* Effect.never;
            }),
          ),
      }),
      Effect.forkChild,
    );
    yield* Deferred.await(started);
    yield* Fiber.interrupt(task);
    yield* Deferred.await(stopped);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("collects what the suite recorded under server-chosen names", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const recordingsDir = yield* fileSystem.makeTempDirectoryScoped();
    const result = yield* runAppReviewTest({
      command: "suite",
      retryCommand: "suite",
      cwd: "/assigned",
      previewUrl: null,
      executionId: "cycle-1",
      recordingsDir,
      env: { APP_DEV_STACK_API_TOKEN: "token" },
    }).pipe(
      Effect.provideService(ProcessRunner, {
        run: (input) =>
          Effect.gen(function* () {
            const incoming = input.env?.APP_REVIEW_RECORDING_DIR ?? "";
            expect(input.env).toMatchObject({
              APP_DEV_STACK_API_TOKEN: "token",
              APP_REVIEW_TEST_PLATFORMS: "web",
              APP_REVIEW_RECORDER_BINDING: "__t3DomRecorderEmit",
            });
            expect(yield* fileSystem.exists(input.env?.APP_REVIEW_RECORDER_SCRIPT ?? "")).toBe(
              true,
            );
            yield* fileSystem.writeFileString(
              path.join(incoming, "test_login.rrweb.jsonl"),
              '{"type":4}\n',
            );
            yield* fileSystem.writeFileString(path.join(incoming, "empty.rrweb.jsonl"), "");
            yield* fileSystem.writeFileString(path.join(incoming, "trace.zip"), "ignored");
            return {
              code: ChildProcessSpawner.ExitCode(1),
              timedOut: false,
              stdout: "",
              stderr: "",
              stdoutTruncated: false,
              stderrTruncated: false,
              stdoutInvalidUtf8: false,
              stderrInvalidUtf8: false,
            };
          }).pipe(Effect.orDie),
      }),
    );
    expect(result.status).toBe("failed");
    expect(result.recordings).toHaveLength(1);
    const [recording] = result.recordings ?? [];
    expect(recording).toMatchObject({ label: "test_login", sizeBytes: 11 });
    expect(recording?.path).toBe(path.join(recordingsDir, `${recording?.id}.rrweb.jsonl`));
    expect(yield* fileSystem.readFileString(recording?.path ?? "")).toBe('{"type":4}\n');
    expect(
      (yield* fileSystem.readDirectory(recordingsDir)).some((name) => name.endsWith(".incoming")),
    ).toBe(false);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("restores only what the suite wrote and leaves earlier edits alone", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const runner = yield* ProcessRunner;
    const repo = yield* fileSystem.makeTempDirectoryScoped();
    const git = (...args: string[]) =>
      runner.run({
        command: "git",
        args: ["-c", "user.name=T3", "-c", "user.email=t3@example.com", ...args],
        cwd: repo,
      });
    yield* git("init", "-q");
    yield* fileSystem.makeDirectory(path.join(repo, "knowledge"));
    yield* fileSystem.writeFileString(path.join(repo, "knowledge", "verification.json"), "{}\n");
    yield* fileSystem.writeFileString(path.join(repo, "work.ts"), "base\n");
    yield* git("add", ".");
    yield* git("commit", "-q", "-m", "base");
    yield* fileSystem.writeFileString(path.join(repo, "work.ts"), "in progress\n");
    yield* fileSystem.writeFileString(path.join(repo, "notes.md"), "mine\n");
    // What the suite wrote while it ran.
    yield* fileSystem.writeFileString(
      path.join(repo, "knowledge", "verification.json"),
      '{"passed":true}\n',
    );
    yield* fileSystem.writeFileString(path.join(repo, "report.html"), "<html/>\n");

    const result = yield* restoreAppReviewTestWrites({
      cwd: path.join(repo, "knowledge"),
      paths: ["knowledge/verification.json", "report.html"],
    });

    expect(result).toEqual({
      restored: ["knowledge/verification.json"],
      removed: ["report.html"],
    });
    expect(
      yield* fileSystem.readFileString(path.join(repo, "knowledge", "verification.json")),
    ).toBe("{}\n");
    expect(yield* fileSystem.exists(path.join(repo, "report.html"))).toBe(false);
    expect(yield* fileSystem.readFileString(path.join(repo, "work.ts"))).toBe("in progress\n");
    expect(yield* fileSystem.readFileString(path.join(repo, "notes.md"))).toBe("mine\n");
  }).pipe(Effect.provide(processRunnerLayer.pipe(Layer.provideMerge(NodeServices.layer)))),
);
