import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  BrowserExecutableUnavailableError,
  type BrowserExecutableResolverAdapter,
  resolveBrowserExecutablePromise,
  resolveFfmpegExecutablePromise,
  resolvePreviewBrowserStatus,
} from "./BrowserExecutableResolver.ts";

const baseInput = {
  mode: "web",
  previewBrowserMode: "auto",
  previewBrowserSource: "auto",
  previewBrowserExecutablePath: undefined,
  previewFfmpegExecutablePath: undefined,
  envPath: "",
} as const;
const hostPlatform = "linux" as const;

const adapter = (
  executablePaths: ReadonlySet<string>,
  playwrightPath?: string,
  playwrightFfmpeg?: string,
): BrowserExecutableResolverAdapter => ({
  isExecutable: async (path) => executablePaths.has(path),
  playwrightExecutablePath: async () => playwrightPath,
  playwrightFfmpegPath: async () => playwrightFfmpeg,
});

describe("BrowserExecutableResolver", () => {
  it("uses the configured executable path when it is executable", async () => {
    const resolution = await resolveBrowserExecutablePromise(
      {
        ...baseInput,
        previewBrowserExecutablePath: "/custom/chromium",
      },
      adapter(new Set(["/custom/chromium"])),
    );

    assert.deepStrictEqual(resolution, {
      executablePath: "/custom/chromium",
      source: "configured",
    });
  });

  it("discovers system Chromium candidates from PATH", async () => {
    const resolution = await resolveBrowserExecutablePromise(
      {
        ...baseInput,
        envPath: "/usr/local/bin:/opt/bin",
      },
      adapter(new Set(["/opt/bin/google-chrome"])),
    );

    assert.deepStrictEqual(resolution, {
      executablePath: "/opt/bin/google-chrome",
      source: "system",
    });
  });

  it("falls back to Playwright-managed Chromium when no system candidate exists", async () => {
    const resolution = await resolveBrowserExecutablePromise(
      baseInput,
      adapter(new Set(["/pw/chromium"]), "/pw/chromium"),
    );

    assert.deepStrictEqual(resolution, {
      executablePath: "/pw/chromium",
      source: "playwright",
    });
  });

  it("reports an actionable missing-browser message", async () => {
    try {
      await resolveBrowserExecutablePromise(baseInput, adapter(new Set()));
      assert.fail("Expected resolver to reject when no browser is available");
    } catch (error) {
      assert.instanceOf(error, BrowserExecutableUnavailableError);
      assert.include((error as BrowserExecutableUnavailableError).message, "No usable Chromium");
      assert.include(
        (error as BrowserExecutableUnavailableError).message,
        "vp run --filter t3 install:preview-browser",
      );
    }
  });

  it("uses the configured ffmpeg path ahead of PATH and Playwright candidates", async () => {
    const path = await resolveFfmpegExecutablePromise(
      { previewFfmpegExecutablePath: "/custom/ffmpeg", envPath: "/usr/bin", hostPlatform },
      adapter(
        new Set(["/custom/ffmpeg", "/usr/bin/ffmpeg", "/pw/ffmpeg"]),
        undefined,
        "/pw/ffmpeg",
      ),
    );

    assert.strictEqual(path, "/custom/ffmpeg");
  });

  it("rejects a configured ffmpeg path that is not executable", async () => {
    try {
      await resolveFfmpegExecutablePromise(
        { previewFfmpegExecutablePath: "/custom/ffmpeg", envPath: "/usr/bin", hostPlatform },
        adapter(new Set(["/usr/bin/ffmpeg"])),
      );
      assert.fail("Expected resolver to reject a non-executable configured ffmpeg");
    } catch (error) {
      assert.instanceOf(error, BrowserExecutableUnavailableError);
      assert.include(
        (error as BrowserExecutableUnavailableError).message,
        "Configured ffmpeg executable is not executable",
      );
    }
  });

  it("prefers ffmpeg on PATH over the Playwright cache", async () => {
    const path = await resolveFfmpegExecutablePromise(
      { previewFfmpegExecutablePath: undefined, envPath: "/usr/bin", hostPlatform },
      adapter(new Set(["/usr/bin/ffmpeg", "/pw/ffmpeg"]), undefined, "/pw/ffmpeg"),
    );

    assert.strictEqual(path, "/usr/bin/ffmpeg");
  });

  it("falls back to the Playwright-managed ffmpeg", async () => {
    const path = await resolveFfmpegExecutablePromise(
      { previewFfmpegExecutablePath: undefined, envPath: "/usr/bin", hostPlatform },
      adapter(new Set(["/pw/ffmpeg"]), undefined, "/pw/ffmpeg"),
    );

    assert.strictEqual(path, "/pw/ffmpeg");
  });

  it("reports an actionable missing-ffmpeg message", async () => {
    try {
      await resolveFfmpegExecutablePromise(
        { previewFfmpegExecutablePath: undefined, envPath: "/usr/bin", hostPlatform },
        adapter(new Set()),
      );
      assert.fail("Expected resolver to reject when no ffmpeg is available");
    } catch (error) {
      assert.instanceOf(error, BrowserExecutableUnavailableError);
      assert.include((error as BrowserExecutableUnavailableError).message, "No usable ffmpeg");
    }
  });

  it.effect("advertises the recording capability when ffmpeg is available", () =>
    Effect.gen(function* () {
      const status = yield* resolvePreviewBrowserStatus(
        { ...baseInput, envPath: "/usr/bin" },
        adapter(new Set(["/usr/bin/chromium", "/usr/bin/ffmpeg"])),
      );

      assert.strictEqual(status.status, "ready");
      assert.isTrue(status.capabilities.recording);
    }),
  );

  it.effect("withholds the recording capability when ffmpeg is missing", () =>
    Effect.gen(function* () {
      const status = yield* resolvePreviewBrowserStatus(
        { ...baseInput, envPath: "/usr/bin" },
        adapter(new Set(["/usr/bin/chromium"])),
      );

      assert.strictEqual(status.status, "ready");
      assert.isFalse(status.capabilities.recording);
      assert.isTrue(status.capabilities.automation);
    }),
  );
});
