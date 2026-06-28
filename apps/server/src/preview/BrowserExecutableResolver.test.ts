import { assert, describe, it } from "@effect/vitest";

import {
  BrowserExecutableUnavailableError,
  type BrowserExecutableResolverAdapter,
  resolveBrowserExecutablePromise,
} from "./BrowserExecutableResolver.ts";

const baseInput = {
  mode: "web",
  previewBrowserMode: "auto",
  previewBrowserSource: "auto",
  previewBrowserExecutablePath: undefined,
  envPath: "",
} as const;

const adapter = (
  executablePaths: ReadonlySet<string>,
  playwrightPath?: string,
): BrowserExecutableResolverAdapter => ({
  isExecutable: async (path) => executablePaths.has(path),
  playwrightExecutablePath: async () => playwrightPath,
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
});
