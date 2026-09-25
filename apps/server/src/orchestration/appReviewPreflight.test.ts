import { it, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { ProcessRunner, ProcessSpawnError, type ProcessRunInput } from "../processRunner.ts";
import { runAppReviewPreflight } from "./appReviewPreflight.ts";

for (const [code, timedOut, expected] of [
  [0, false, "ready"],
  [1, false, "waiting"],
  [null, true, "waiting"],
  [2, false, "error"],
  [127, false, "error"],
  [null, false, "error"],
] as const) {
  it.effect(`classifies readiness exit ${code}, timeout ${timedOut} as ${expected}`, () =>
    Effect.gen(function* () {
      const calls: ProcessRunInput[] = [];
      const result = yield* runAppReviewPreflight({
        command: "node check.mjs",
        cwd: "/assigned/worktree",
        previewUrl: "https://assigned.example",
        testPlatforms: ["web", "android"],
      }).pipe(
        Effect.provideService(ProcessRunner, {
          run: (input) => {
            calls.push(input);
            return Effect.succeed({
              code: code === null ? null : ChildProcessSpawner.ExitCode(code),
              timedOut,
              stdout: "postgres://secret",
              stderr: "password=secret",
              stdoutTruncated: false,
              stderrTruncated: false,
              stdoutInvalidUtf8: false,
              stderrInvalidUtf8: false,
            });
          },
        }),
      );
      expect(result).toBe(expected);
      expect(calls[0]).toMatchObject({
        cwd: "/assigned/worktree",
        env: {
          APP_REVIEW_PREVIEW_URL: "https://assigned.example",
          APP_REVIEW_TEST_PLATFORMS: "web,android",
        },
        timeout: 10_000,
        timeoutBehavior: "timedOutResult",
        maxOutputBytes: 1024,
      });
    }),
  );
}

it.effect("does not persist process errors or inherit an unrelated preview URL", () =>
  Effect.gen(function* () {
    const result = yield* runAppReviewPreflight({
      command: "missing-script",
      cwd: "/assigned",
      previewUrl: null,
    }).pipe(
      Effect.provideService(ProcessRunner, {
        run: (input) => {
          expect(input.env?.APP_REVIEW_PREVIEW_URL).toBe("");
          expect(input.env?.APP_REVIEW_TEST_PLATFORMS).toBe("web");
          return Effect.fail(
            new ProcessSpawnError({ command: "sh", argumentCount: 2, cause: "secret" }),
          );
        },
      }),
    );
    expect(result).toBe("error");
  }),
);
