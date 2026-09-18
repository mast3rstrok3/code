import { it, expect } from "@effect/vitest";
import { AppReviewWorkflowRunId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import { ChildProcessSpawner } from "effect/unstable/process";
import { ProcessRunner, type ProcessRunInput } from "../processRunner.ts";
import { appReviewTestCommands, runAppReviewTest } from "./appReviewTestRunner.ts";

const completedAt = "2026-09-18T07:00:00.000Z";
const selections = ["calendar", "lists", "chat"].map((command) => ({
  command,
  retryCommand: command,
}));

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
              retryCommands: [
                { command: "lists", retryCommand: "lists --grep search" },
                { command: "calendar", retryCommand: "calendar --grep booking" },
              ],
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

for (const [code, timedOut, status] of [
  [0, false, "passed"],
  [1, false, "failed"],
  [null, true, "failed"],
] as const) {
  it.effect(`records command exit ${code}, timeout ${timedOut} without an agent`, () =>
    Effect.gen(function* () {
      const calls: ProcessRunInput[] = [];
      const result = yield* runAppReviewTest({
        command: "suite",
        retryCommand: "suite --grep failed",
        cwd: "/assigned",
        previewUrl: "https://assigned.example",
        executionId: "cycle-2",
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
      expect(calls[0]).toMatchObject({
        cwd: "/assigned",
        env: {
          APP_REVIEW_PREVIEW_URL: "https://assigned.example",
          APP_REVIEW_EXECUTION_ID: "cycle-2",
        },
        timeout: "45 minutes",
        maxOutputBytes: 8192,
      });
    }),
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
  }),
);
