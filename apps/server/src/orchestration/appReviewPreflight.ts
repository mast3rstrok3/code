import {
  APP_REVIEW_PREVIEW_URL_ENV,
  APP_REVIEW_TEST_PLATFORMS_ENV,
  type ReviewTestPlatforms,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { ProcessRunner } from "../processRunner.ts";

export const APP_REVIEW_PREFLIGHT_RETRY_MS = 60_000;

/** Discard process output because connection diagnostics may contain credentials. */
export const runAppReviewPreflight = Effect.fn("runAppReviewPreflight")(function* (input: {
  readonly command: string;
  readonly cwd: string;
  readonly previewUrl: string | null;
  readonly testPlatforms?: typeof ReviewTestPlatforms.Type | undefined;
}) {
  const runner = yield* ProcessRunner;
  const platform = yield* HostProcessPlatform;
  return yield* runner
    .run({
      command: platform === "win32" ? "cmd.exe" : "/bin/sh",
      args: platform === "win32" ? ["/d", "/s", "/c", input.command] : ["-c", input.command],
      cwd: input.cwd,
      env: {
        [APP_REVIEW_PREVIEW_URL_ENV]: input.previewUrl ?? "",
        [APP_REVIEW_TEST_PLATFORMS_ENV]: (input.testPlatforms ?? ["web"]).join(","),
      },
      timeout: 10_000,
      timeoutBehavior: "timedOutResult",
      maxOutputBytes: 1024,
      outputMode: "truncate",
    })
    .pipe(
      Effect.map((result) =>
        result.timedOut || result.code === 1
          ? ("waiting" as const)
          : result.code === 0
            ? ("ready" as const)
            : ("error" as const),
      ),
      Effect.catch(() => Effect.succeed("error" as const)),
    );
});
