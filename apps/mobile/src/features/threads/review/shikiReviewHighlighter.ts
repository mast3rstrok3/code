import { createHighlighterCore, type HighlighterCore } from "@shikijs/core";
import { createJavaScriptRegexEngine } from "@shikijs/engine-javascript";
import { getFiletypeFromFileName } from "@pierre/diffs/utils";

import {
  resolveReviewHighlighterEngine,
  resolveReviewHighlighterEnginePreference,
  type ReviewHighlighterEngine,
} from "./reviewHighlighterEngine";
import type { ReviewRenderableFile, ReviewRenderableLineRow } from "./reviewModel";

export type ReviewDiffTheme = "light" | "dark";

export interface ReviewHighlightedToken {
  readonly content: string;
  readonly color: string | null;
  readonly fontStyle: number | null;
}

export interface ReviewHighlightedFile {
  readonly additionLines: ReadonlyArray<ReadonlyArray<ReviewHighlightedToken>>;
  readonly deletionLines: ReadonlyArray<ReadonlyArray<ReviewHighlightedToken>>;
}

const SHIKI_THEME_NAME_BY_SCHEME = {
  light: "github-light-default",
  dark: "github-dark-default",
} as const;
const REVIEW_HIGHLIGHTER_ENGINE_PREFERENCE = resolveReviewHighlighterEnginePreference(
  process.env.EXPO_PUBLIC_REVIEW_HIGHLIGHTER_ENGINE ?? "javascript",
);
const REVIEW_HIGHLIGHTER_DISABLE_RESULT_CACHE = resolveReviewHighlighterBooleanFlag(
  process.env.EXPO_PUBLIC_REVIEW_HIGHLIGHTER_DISABLE_CACHE,
  false,
);
const highlightCache = new Map<string, Promise<ReviewHighlightedFile>>();
const resolvedHighlightCache = new Map<string, ReviewHighlightedFile>();
const loadedLanguages = new Set<string>(["text"]);
const languageLoadingPromises = new Map<string, Promise<boolean>>();
const languageImports: Partial<Record<string, () => Promise<unknown>>> = {
  javascript: () => import("@shikijs/langs/javascript"),
  typescript: () => import("@shikijs/langs/typescript"),
  jsx: () => import("@shikijs/langs/jsx"),
  tsx: () => import("@shikijs/langs/tsx"),
  python: () => import("@shikijs/langs/python"),
  rust: () => import("@shikijs/langs/rust"),
  go: () => import("@shikijs/langs/go"),
  java: () => import("@shikijs/langs/java"),
  kotlin: () => import("@shikijs/langs/kotlin"),
  swift: () => import("@shikijs/langs/swift"),
  "objective-c": () => import("@shikijs/langs/objective-c"),
  c: () => import("@shikijs/langs/c"),
  cpp: () => import("@shikijs/langs/cpp"),
  csharp: () => import("@shikijs/langs/csharp"),
  php: () => import("@shikijs/langs/php"),
  ruby: () => import("@shikijs/langs/ruby"),
  lua: () => import("@shikijs/langs/lua"),
  perl: () => import("@shikijs/langs/perl"),
  r: () => import("@shikijs/langs/r"),
  dart: () => import("@shikijs/langs/dart"),
  scala: () => import("@shikijs/langs/scala"),
  elixir: () => import("@shikijs/langs/elixir"),
  haskell: () => import("@shikijs/langs/haskell"),
  clojure: () => import("@shikijs/langs/clojure"),
  ocaml: () => import("@shikijs/langs/ocaml"),
  fsharp: () => import("@shikijs/langs/fsharp"),
  erlang: () => import("@shikijs/langs/erlang"),
  zig: () => import("@shikijs/langs/zig"),
  nim: () => import("@shikijs/langs/nim"),
  html: () => import("@shikijs/langs/html"),
  css: () => import("@shikijs/langs/css"),
  scss: () => import("@shikijs/langs/scss"),
  less: () => import("@shikijs/langs/less"),
  xml: () => import("@shikijs/langs/xml"),
  svg: () => import("@shikijs/langs/xml"),
  vue: () => import("@shikijs/langs/vue"),
  svelte: () => import("@shikijs/langs/svelte"),
  astro: () => import("@shikijs/langs/astro"),
  json: () => import("@shikijs/langs/json"),
  jsonc: () => import("@shikijs/langs/jsonc"),
  yaml: () => import("@shikijs/langs/yaml"),
  toml: () => import("@shikijs/langs/toml"),
  ini: () => import("@shikijs/langs/ini"),
  bash: () => import("@shikijs/langs/bash"),
  shellscript: () => import("@shikijs/langs/shellscript"),
  powershell: () => import("@shikijs/langs/powershell"),
  fish: () => import("@shikijs/langs/fish"),
  sql: () => import("@shikijs/langs/sql"),
  graphql: () => import("@shikijs/langs/graphql"),
  prisma: () => import("@shikijs/langs/prisma"),
  docker: () => import("@shikijs/langs/docker"),
  hcl: () => import("@shikijs/langs/hcl"),
  nix: () => import("@shikijs/langs/nix"),
  markdown: () => import("@shikijs/langs/markdown"),
  mdx: () => import("@shikijs/langs/mdx"),
  tex: () => import("@shikijs/langs/tex"),
  diff: () => import("@shikijs/langs/diff"),
  regex: () => import("@shikijs/langs/regex"),
  viml: () => import("@shikijs/langs/viml"),
  makefile: () => import("@shikijs/langs/makefile"),
  cmake: () => import("@shikijs/langs/cmake"),
  groovy: () => import("@shikijs/langs/groovy"),
};

const languageAliases: Record<string, string> = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  py: "python",
  rb: "ruby",
  rs: "rust",
  sh: "bash",
  zsh: "bash",
  shell: "shellscript",
  yml: "yaml",
  md: "markdown",
  "c++": "cpp",
  "c#": "csharp",
  cs: "csharp",
  dockerfile: "docker",
  vim: "viml",
  objc: "objective-c",
  objectivec: "objective-c",
  "obj-c": "objective-c",
  ps1: "powershell",
  pwsh: "powershell",
  hs: "haskell",
  ex: "elixir",
  exs: "elixir",
  erl: "erlang",
  clj: "clojure",
  ml: "ocaml",
  fs: "fsharp",
  tf: "hcl",
  make: "makefile",
  plain: "text",
  plaintext: "text",
  txt: "text",
};
let highlighterPromise: Promise<HighlighterCore> | null = null;
let activeHighlighterEnginePromise: Promise<ReviewHighlighterEngine> | null = null;

type LoadedLanguageModule = {
  default: Parameters<HighlighterCore["loadLanguage"]>[0];
};

function resolveReviewHighlighterBooleanFlag(
  value: string | undefined,
  defaultValue: boolean,
): boolean {
  switch (value) {
    case "1":
    case "true":
      return true;
    case "0":
    case "false":
      return false;
    default:
      return defaultValue;
  }
}

function isReviewHighlighterDebugLoggingEnabled(): boolean {
  return typeof __DEV__ !== "undefined" ? __DEV__ : false;
}

function logReviewHighlighterDiagnostic(message: string, details?: Record<string, unknown>): void {
  if (!isReviewHighlighterDebugLoggingEnabled()) {
    return;
  }

  if (details) {
    console.log(`[review-highlighter] ${message}`, details);
    return;
  }

  console.log(`[review-highlighter] ${message}`);
}

function logReviewHighlighterDiagnosticError(message: string, error: unknown): void {
  if (!isReviewHighlighterDebugLoggingEnabled()) {
    return;
  }

  if (error instanceof Error) {
    console.error(`[review-highlighter] ${message}`, {
      name: error.name,
      message: error.message,
      stack: error.stack,
    });
    return;
  }

  console.error(`[review-highlighter] ${message}`, error);
}

function stripTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value.slice(0, -1) : value;
}

function joinPatchLines(lines: ReadonlyArray<string>): string {
  return lines.map(stripTrailingNewline).join("\n");
}

async function getHighlighter(): Promise<HighlighterCore> {
  if (!highlighterPromise) {
    const configuredHighlighterPromise = Promise.all([
      import("@shikijs/themes/github-light-default"),
      import("@shikijs/themes/github-dark-default"),
    ]).then(async ([lightThemeModule, darkThemeModule]) => {
      let nativeEngineAvailable = false;

      logReviewHighlighterDiagnostic("initializing", {
        preference: REVIEW_HIGHLIGHTER_ENGINE_PREFERENCE,
        resultCacheDisabled: REVIEW_HIGHLIGHTER_DISABLE_RESULT_CACHE,
      });

      const themes = [lightThemeModule.default, darkThemeModule.default];

      if (REVIEW_HIGHLIGHTER_ENGINE_PREFERENCE !== "javascript") {
        try {
          const nativeEngineModule = await import("react-native-shiki-engine");
          logReviewHighlighterDiagnostic("imported react-native-shiki-engine");
          nativeEngineAvailable = nativeEngineModule.isNativeEngineAvailable();
          logReviewHighlighterDiagnostic("checked native engine availability", {
            nativeEngineAvailable,
          });

          if (nativeEngineAvailable) {
            logReviewHighlighterDiagnostic("creating native regex engine");
            const highlighter = await createHighlighterCore({
              themes,
              langs: [],
              engine: nativeEngineModule.createNativeEngine(),
            });
            logReviewHighlighterDiagnostic("using native engine");
            return {
              highlighter,
              engine: "native" as const,
            };
          }
        } catch (error) {
          logReviewHighlighterDiagnosticError(
            "native engine initialization failed; falling back to javascript",
            error,
          );
          nativeEngineAvailable = false;
        }
      } else {
        logReviewHighlighterDiagnostic("skipping native engine probe", {
          reason: "preference-forced-javascript",
        });
      }

      const engine = resolveReviewHighlighterEngine(
        REVIEW_HIGHLIGHTER_ENGINE_PREFERENCE,
        nativeEngineAvailable,
      );
      const highlighter = await createHighlighterCore({
        themes,
        langs: [],
        engine: createJavaScriptRegexEngine(),
      });
      logReviewHighlighterDiagnostic("using javascript engine", {
        resolvedEngine: engine,
      });
      return {
        highlighter,
        engine,
      };
    });

    highlighterPromise = configuredHighlighterPromise
      .then((result) => result.highlighter)
      .catch((error) => {
        highlighterPromise = null;
        activeHighlighterEnginePromise = null;
        throw error;
      });
    activeHighlighterEnginePromise = configuredHighlighterPromise
      .then((result) => result.engine)
      .catch((error) => {
        activeHighlighterEnginePromise = null;
        throw error;
      });
  }

  return highlighterPromise;
}

export async function getActiveReviewHighlighterEngine(): Promise<ReviewHighlighterEngine> {
  await getHighlighter();
  return activeHighlighterEnginePromise ?? Promise.resolve("javascript");
}

function resolveLanguageAlias(language: string): string {
  const normalized = language.toLowerCase();
  return languageAliases[normalized] ?? normalized;
}

async function loadSingleLanguage(
  highlighter: HighlighterCore,
  language: string,
): Promise<boolean> {
  if (loadedLanguages.has(language)) {
    return true;
  }

  const existingPromise = languageLoadingPromises.get(language);
  if (existingPromise) {
    return existingPromise;
  }

  const importer = languageImports[language];
  if (!importer) {
    return false;
  }

  const loadingPromise = (async () => {
    try {
      const languageModule = (await importer()) as LoadedLanguageModule;
      await highlighter.loadLanguage(languageModule.default);
      loadedLanguages.add(language);
      return true;
    } catch {
      return false;
    } finally {
      languageLoadingPromises.delete(language);
    }
  })();

  languageLoadingPromises.set(language, loadingPromise);
  return loadingPromise;
}

async function resolveLanguageFromPath(
  path: string,
  languageHint: string | null = null,
): Promise<string> {
  const detectedLanguage = languageHint ?? getFiletypeFromFileName(path);
  if (!detectedLanguage) {
    return "text";
  }

  const candidate = resolveLanguageAlias(detectedLanguage);
  if (candidate === "text" || candidate === "ansi") {
    return "text";
  }

  if (!(candidate in languageImports)) {
    return "text";
  }

  const highlighter = await getHighlighter();
  const loaded = await loadSingleLanguage(highlighter, resolveLanguageAlias(candidate));
  if (!loaded) {
    return "text";
  }

  return candidate;
}

async function resolveLanguage(file: ReviewRenderableFile): Promise<string> {
  return resolveLanguageFromPath(file.path, file.languageHint);
}

function normalizeHighlightedLines(
  tokenLines: ReadonlyArray<ReadonlyArray<{ content: string; color?: string; fontStyle?: number }>>,
): ReadonlyArray<ReadonlyArray<ReviewHighlightedToken>> {
  return tokenLines.map((line) =>
    line.map((token) => ({
      content: token.content,
      color: token.color ?? null,
      fontStyle: token.fontStyle ?? null,
    })),
  );
}

async function highlightLines(
  code: string,
  language: string,
  theme: string,
): Promise<ReadonlyArray<ReadonlyArray<ReviewHighlightedToken>>> {
  if (code.length === 0) {
    return [];
  }

  const highlighter = await getHighlighter();
  const tokenLines = highlighter.codeToTokensBase(code, { lang: language, theme });
  return normalizeHighlightedLines(tokenLines);
}

function getHighlightCacheKey(file: ReviewRenderableFile, theme: ReviewDiffTheme): string {
  return `${SHIKI_THEME_NAME_BY_SCHEME[theme]}:${file.cacheKey}`;
}

export function getCachedHighlightedReviewFile(
  file: ReviewRenderableFile,
  theme: ReviewDiffTheme,
): ReviewHighlightedFile | null {
  if (REVIEW_HIGHLIGHTER_DISABLE_RESULT_CACHE) {
    return null;
  }

  return resolvedHighlightCache.get(getHighlightCacheKey(file, theme)) ?? null;
}

export async function highlightReviewFile(
  file: ReviewRenderableFile,
  theme: ReviewDiffTheme,
): Promise<ReviewHighlightedFile> {
  const shikiTheme = SHIKI_THEME_NAME_BY_SCHEME[theme];
  const cacheKey = getHighlightCacheKey(file, theme);
  if (!REVIEW_HIGHLIGHTER_DISABLE_RESULT_CACHE) {
    const resolved = resolvedHighlightCache.get(cacheKey);
    if (resolved) {
      return resolved;
    }
    const cached = highlightCache.get(cacheKey);
    if (cached) {
      return cached;
    }
  }

  const promise = (async () => {
    const language = await resolveLanguage(file);
    const [additionLines, deletionLines] = await Promise.all([
      highlightLines(joinPatchLines(file.additionLines), language, shikiTheme),
      highlightLines(joinPatchLines(file.deletionLines), language, shikiTheme),
    ]);

    const highlighted = { additionLines, deletionLines };
    if (!REVIEW_HIGHLIGHTER_DISABLE_RESULT_CACHE) {
      resolvedHighlightCache.set(cacheKey, highlighted);
    }
    return highlighted;
  })();

  if (!REVIEW_HIGHLIGHTER_DISABLE_RESULT_CACHE) {
    highlightCache.set(cacheKey, promise);
  }
  return promise;
}

export async function highlightReviewSelectedLines(input: {
  readonly filePath: string;
  readonly lines: ReadonlyArray<ReviewRenderableLineRow>;
  readonly theme: ReviewDiffTheme;
  readonly languageHint?: string | null;
}): Promise<Record<string, ReadonlyArray<ReviewHighlightedToken>>> {
  if (input.lines.length === 0) {
    return {};
  }

  const language = await resolveLanguageFromPath(input.filePath, input.languageHint ?? null);
  const shikiTheme = SHIKI_THEME_NAME_BY_SCHEME[input.theme];
  const additionLikeLines = input.lines
    .filter((line) => line.change !== "delete")
    .map((line) => `${line.content}\n`);
  const deletionLines = input.lines
    .filter((line) => line.change === "delete")
    .map((line) => `${line.content}\n`);
  const [additionTokens, deletionTokens] = await Promise.all([
    highlightLines(joinPatchLines(additionLikeLines), language, shikiTheme),
    highlightLines(joinPatchLines(deletionLines), language, shikiTheme),
  ]);

  const tokenMap: Record<string, ReadonlyArray<ReviewHighlightedToken>> = {};
  let additionIndex = 0;
  let deletionIndex = 0;

  input.lines.forEach((line) => {
    if (line.change === "delete") {
      tokenMap[line.id] = deletionTokens[deletionIndex] ?? [];
      deletionIndex += 1;
      return;
    }

    tokenMap[line.id] = additionTokens[additionIndex] ?? [];
    additionIndex += 1;
  });

  return tokenMap;
}
