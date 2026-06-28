// @effect-diagnostics nodeBuiltinImport:off - Browser discovery intentionally probes PATH and executable bits.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type { ServerPreviewBrowserStatus } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type * as ServerConfig from "../config.ts";

export const SYSTEM_BROWSER_CANDIDATES = [
  "chromium",
  "chromium-browser",
  "google-chrome",
  "google-chrome-stable",
  "microsoft-edge",
] as const;

export interface BrowserExecutableResolution {
  readonly executablePath: string;
  readonly source: "configured" | "system" | "playwright";
}

export class BrowserExecutableUnavailableError extends Schema.TaggedErrorClass<BrowserExecutableUnavailableError>()(
  "BrowserExecutableUnavailableError",
  {
    message: Schema.String,
  },
) {}

const isBrowserExecutableUnavailableError = Schema.is(BrowserExecutableUnavailableError);

interface BrowserExecutableResolverInput {
  readonly mode: ServerConfig.RuntimeMode;
  readonly previewBrowserMode: ServerConfig.PreviewBrowserMode;
  readonly previewBrowserSource: ServerConfig.PreviewBrowserSource;
  readonly previewBrowserExecutablePath: string | undefined;
  readonly envPath?: string | undefined;
}

export interface BrowserExecutableResolverAdapter {
  readonly isExecutable: (path: string) => Promise<boolean>;
  readonly playwrightExecutablePath: () => Promise<string | undefined>;
}

const defaultAdapter: BrowserExecutableResolverAdapter = {
  isExecutable: async (path) => {
    try {
      await NodeFSP.access(path, NodeFS.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
  playwrightExecutablePath: async () => {
    try {
      const playwright = (await import("playwright")) as typeof import("playwright");
      return playwright.chromium.executablePath();
    } catch {
      return undefined;
    }
  },
};

const executableStatusCapabilities = (
  ready: boolean,
  overrides?: Partial<ServerPreviewBrowserStatus["capabilities"]>,
) => ({
  visual: ready,
  automation: ready,
  screenshots: ready,
  elementPicking: ready,
  recording: ready,
  viewportResize: ready,
  ...overrides,
});

export const disabledPreviewBrowserStatus = (
  mode: ServerConfig.RuntimeMode,
  message: string,
): ServerPreviewBrowserStatus => ({
  mode: mode === "desktop" ? "desktop" : "none",
  status: "disabled",
  message,
  capabilities: executableStatusCapabilities(false),
});

export const unavailablePreviewBrowserStatus = (
  mode: ServerConfig.RuntimeMode,
  message: string,
): ServerPreviewBrowserStatus => ({
  mode: mode === "desktop" ? "desktop" : "server",
  status: "unavailable",
  message,
  capabilities: executableStatusCapabilities(false),
});

export const readyPreviewBrowserStatus = (
  mode: ServerConfig.RuntimeMode,
  source?: BrowserExecutableResolution["source"],
): ServerPreviewBrowserStatus => ({
  mode: mode === "desktop" ? "desktop" : "server",
  status: "ready",
  ...(source === undefined ? {} : { source }),
  capabilities: executableStatusCapabilities(true, {
    recording: mode === "desktop",
  }),
});

const pathCandidates = (envPath: string | undefined): ReadonlyArray<string> => {
  const entries = (envPath ?? process.env.PATH ?? "")
    .split(NodePath.delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return entries.flatMap((entry) =>
    SYSTEM_BROWSER_CANDIDATES.map((candidate) => NodePath.join(entry, candidate)),
  );
};

async function firstExecutable(
  candidates: ReadonlyArray<string>,
  adapter: BrowserExecutableResolverAdapter,
): Promise<string | undefined> {
  for (const candidate of candidates) {
    if (await adapter.isExecutable(candidate)) return candidate;
  }
  return undefined;
}

export async function resolveBrowserExecutablePromise(
  input: BrowserExecutableResolverInput,
  adapter: BrowserExecutableResolverAdapter = defaultAdapter,
): Promise<BrowserExecutableResolution> {
  if (input.previewBrowserMode === "off") {
    throw new BrowserExecutableUnavailableError({
      message: "Server-hosted browser preview is disabled by configuration.",
    });
  }

  const configured = input.previewBrowserExecutablePath?.trim();
  if (configured) {
    const resolved = NodePath.resolve(configured);
    if (await adapter.isExecutable(resolved)) {
      return { executablePath: resolved, source: "configured" };
    }
    throw new BrowserExecutableUnavailableError({
      message: `Configured Chromium executable is not executable: ${resolved}`,
    });
  }

  if (input.previewBrowserSource !== "playwright") {
    const system = await firstExecutable(pathCandidates(input.envPath), adapter);
    if (system) return { executablePath: system, source: "system" };
  }

  if (input.previewBrowserSource !== "system") {
    const playwrightPath = await adapter.playwrightExecutablePath();
    if (playwrightPath && (await adapter.isExecutable(playwrightPath))) {
      return { executablePath: playwrightPath, source: "playwright" };
    }
  }

  const installHint =
    input.previewBrowserSource === "system"
      ? "Install Chromium or set T3CODE_PREVIEW_BROWSER_EXECUTABLE to an executable browser path."
      : "Install Chromium or run `vp run --filter t3 install:preview-browser`.";
  throw new BrowserExecutableUnavailableError({
    message: `No usable Chromium executable was found. ${installHint}`,
  });
}

export const resolveBrowserExecutable = (
  input: BrowserExecutableResolverInput,
  adapter?: BrowserExecutableResolverAdapter,
) =>
  Effect.tryPromise({
    try: () => resolveBrowserExecutablePromise(input, adapter),
    catch: (cause) =>
      isBrowserExecutableUnavailableError(cause)
        ? cause
        : new BrowserExecutableUnavailableError({
            message: cause instanceof Error ? cause.message : String(cause),
          }),
  });

export const resolvePreviewBrowserStatus = (
  input: BrowserExecutableResolverInput,
  adapter?: BrowserExecutableResolverAdapter,
) => {
  if (input.previewBrowserMode === "off") {
    return Effect.succeed(
      disabledPreviewBrowserStatus(
        input.mode,
        "Server-hosted browser preview is disabled by configuration.",
      ),
    );
  }
  if (input.mode === "desktop") {
    return Effect.succeed(readyPreviewBrowserStatus(input.mode));
  }
  return resolveBrowserExecutable(input, adapter).pipe(
    Effect.map((resolution) => readyPreviewBrowserStatus(input.mode, resolution.source)),
    Effect.catch((error) =>
      Effect.succeed(unavailablePreviewBrowserStatus(input.mode, error.message)),
    ),
  );
};
