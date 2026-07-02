// @effect-diagnostics nodeBuiltinImport:off - Browser discovery intentionally probes PATH and executable bits.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
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
  readonly previewFfmpegExecutablePath?: string | undefined;
  readonly envPath?: string | undefined;
}

export interface FfmpegExecutableResolverInput {
  readonly previewFfmpegExecutablePath: string | undefined;
  readonly envPath?: string | undefined;
}

type FfmpegExecutableResolverPromiseInput = FfmpegExecutableResolverInput & {
  readonly hostPlatform: NodeJS.Platform;
};

export interface BrowserExecutableResolverAdapter {
  readonly isExecutable: (path: string) => Promise<boolean>;
  readonly playwrightExecutablePath: () => Promise<string | undefined>;
  readonly playwrightFfmpegPath: (hostPlatform: NodeJS.Platform) => Promise<string | undefined>;
}

const playwrightCacheDir = (hostPlatform: NodeJS.Platform): string => {
  const configured = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (configured && configured !== "0") return configured;
  const home = NodeOS.homedir();
  switch (hostPlatform) {
    case "darwin":
      return NodePath.join(home, "Library", "Caches", "ms-playwright");
    case "win32":
      return NodePath.join(home, "AppData", "Local", "ms-playwright");
    default:
      return NodePath.join(home, ".cache", "ms-playwright");
  }
};

const ffmpegExecutableName = (hostPlatform: NodeJS.Platform): string => {
  switch (hostPlatform) {
    case "darwin":
      return "ffmpeg-mac";
    case "win32":
      return "ffmpeg-win64.exe";
    default:
      return "ffmpeg-linux";
  }
};

const resolvePlaywrightCorePackageJson = (): string => {
  const require = NodeModule.createRequire(import.meta.url);
  try {
    return require.resolve("playwright-core/package.json");
  } catch {
    // pnpm strict linking: playwright-core is only resolvable from playwright.
    const playwrightRequire = NodeModule.createRequire(require.resolve("playwright/package.json"));
    return playwrightRequire.resolve("playwright-core/package.json");
  }
};

const defaultPlaywrightFfmpegPath = async (
  hostPlatform: NodeJS.Platform,
): Promise<string | undefined> => {
  try {
    const cacheDir = playwrightCacheDir(hostPlatform);
    const executableName = ffmpegExecutableName(hostPlatform);
    try {
      const packageJsonPath = resolvePlaywrightCorePackageJson();
      const browsersJsonPath = NodePath.join(NodePath.dirname(packageJsonPath), "browsers.json");
      const parsed = JSON.parse(await NodeFSP.readFile(browsersJsonPath, "utf8")) as {
        readonly browsers?: ReadonlyArray<{
          readonly name?: string;
          readonly revision?: string;
        }>;
      };
      const revision = parsed.browsers?.find((browser) => browser.name === "ffmpeg")?.revision;
      if (revision) return NodePath.join(cacheDir, `ffmpeg-${revision}`, executableName);
    } catch {
      // Fall through to scanning the cache for any installed ffmpeg revision.
    }
    const entries = await NodeFSP.readdir(cacheDir);
    const candidate = entries
      .filter((entry) => entry.startsWith("ffmpeg-"))
      .toSorted()
      .at(-1);
    return candidate ? NodePath.join(cacheDir, candidate, executableName) : undefined;
  } catch {
    return undefined;
  }
};

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
  playwrightFfmpegPath: defaultPlaywrightFfmpegPath,
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
  recordingAvailable?: boolean,
): ServerPreviewBrowserStatus => ({
  mode: mode === "desktop" ? "desktop" : "server",
  status: "ready",
  ...(source === undefined ? {} : { source }),
  capabilities: executableStatusCapabilities(true, {
    recording: mode === "desktop" ? true : (recordingAvailable ?? false),
  }),
});

const pathEntries = (envPath: string | undefined): ReadonlyArray<string> =>
  (envPath ?? process.env.PATH ?? "")
    .split(NodePath.delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

const pathCandidates = (envPath: string | undefined): ReadonlyArray<string> =>
  pathEntries(envPath).flatMap((entry) =>
    SYSTEM_BROWSER_CANDIDATES.map((candidate) => NodePath.join(entry, candidate)),
  );

const ffmpegPathCandidates = (envPath: string | undefined): ReadonlyArray<string> =>
  pathEntries(envPath).map((entry) => NodePath.join(entry, "ffmpeg"));

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

export async function resolveFfmpegExecutablePromise(
  input: FfmpegExecutableResolverPromiseInput,
  adapter: BrowserExecutableResolverAdapter = defaultAdapter,
): Promise<string> {
  const configured = input.previewFfmpegExecutablePath?.trim();
  if (configured) {
    const resolved = NodePath.resolve(configured);
    if (await adapter.isExecutable(resolved)) return resolved;
    throw new BrowserExecutableUnavailableError({
      message: `Configured ffmpeg executable is not executable: ${resolved}`,
    });
  }

  const system = await firstExecutable(ffmpegPathCandidates(input.envPath), adapter);
  if (system) return system;

  const playwrightFfmpeg = await adapter.playwrightFfmpegPath(input.hostPlatform);
  if (playwrightFfmpeg && (await adapter.isExecutable(playwrightFfmpeg))) {
    return playwrightFfmpeg;
  }

  throw new BrowserExecutableUnavailableError({
    message:
      "No usable ffmpeg executable was found. Install ffmpeg, set T3CODE_PREVIEW_FFMPEG_EXECUTABLE, or run `vp run --filter t3 install:preview-browser`.",
  });
}

export const resolveFfmpegExecutable = (
  input: FfmpegExecutableResolverInput,
  adapter?: BrowserExecutableResolverAdapter,
) =>
  Effect.gen(function* () {
    const hostPlatform = yield* HostProcessPlatform;
    return yield* Effect.tryPromise({
      try: () => resolveFfmpegExecutablePromise({ ...input, hostPlatform }, adapter),
      catch: (cause) =>
        isBrowserExecutableUnavailableError(cause)
          ? cause
          : new BrowserExecutableUnavailableError({
              message: cause instanceof Error ? cause.message : String(cause),
            }),
    });
  });

export const resolveFfmpegAvailability = (
  input: FfmpegExecutableResolverInput,
  adapter?: BrowserExecutableResolverAdapter,
) =>
  resolveFfmpegExecutable(input, adapter).pipe(
    Effect.map(() => true),
    Effect.orElseSucceed(() => false),
  );

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
    Effect.flatMap((resolution) =>
      resolveFfmpegAvailability(
        {
          previewFfmpegExecutablePath: input.previewFfmpegExecutablePath,
          envPath: input.envPath,
        },
        adapter,
      ).pipe(
        Effect.map((recordingAvailable) =>
          readyPreviewBrowserStatus(input.mode, resolution.source, recordingAvailable),
        ),
      ),
    ),
    Effect.catch((error) =>
      Effect.succeed(unavailablePreviewBrowserStatus(input.mode, error.message)),
    ),
  );
};
