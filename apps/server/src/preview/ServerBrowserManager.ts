// @effect-diagnostics nodeBuiltinImport:off - Server-hosted Chromium needs Node crypto and filesystem paths.
// @effect-diagnostics globalDate:off - CDP callbacks run outside Effect's clock service.
// @effect-diagnostics preferSchemaOverJson:off - JSON byte sizing guards untrusted automation results.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";

import {
  FILL_PREVIEW_VIEWPORT,
  PreviewBrowserUnavailableError,
  type PreviewCloseInput,
  type PreviewFrameEvent,
  type PreviewInputEvent,
  type PreviewPickElementInput,
  type PreviewRefreshInput,
  type PreviewResizeInput,
  type PreviewScreenshotArtifact,
  type PreviewTabActionInput,
  type ThreadId,
  type PreviewViewportSetting,
  type PreviewZoomInput,
} from "@t3tools/contracts";
import type { BrowserContext, CDPSession, Page } from "playwright";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as BrowserExecutableResolver from "./BrowserExecutableResolver.ts";
import * as PreviewManager from "./Manager.ts";

interface ServerBrowserTab {
  readonly threadId: ThreadId;
  readonly tabId: string;
  readonly page: Page;
  readonly cdp: CDPSession;
  readonly frames: PubSub.PubSub<PreviewFrameEvent>;
  sequence: number;
  zoomFactor: number;
  lastFrameAt: number;
  viewportSetting: PreviewViewportSetting;
  renderedViewport: { readonly width: number; readonly height: number };
}

interface ServerBrowserRuntime {
  readonly context: BrowserContext;
  readonly source: BrowserExecutableResolver.BrowserExecutableResolution["source"];
}

type BrowserDataKind = "cookies" | "cache" | "all";

const DEFAULT_VIEWPORT = { width: 1280, height: 800 } as const;
const MAX_VISIBLE_TEXT_LENGTH = 20_000;
const MAX_INTERACTIVE_ELEMENTS = 80;
const MAX_EVALUATION_BYTES = 2 * 1024 * 1024;

const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

const environmentHash = (environmentId: string): string =>
  NodeCrypto.createHash("sha256").update(environmentId).digest("hex").slice(0, 16);

const sanitizeArtifactSegment = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//u, "")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 48) || "page";

const browserError = (cause: unknown): PreviewBrowserUnavailableError =>
  new PreviewBrowserUnavailableError({
    message: cause instanceof Error ? cause.message : String(cause),
  });

const viewportFromResizeInput = (
  input: Pick<PreviewResizeInput, "viewport" | "renderedViewport">,
): { readonly width: number; readonly height: number } => {
  if (input.viewport._tag !== "fill") {
    return { width: input.viewport.width, height: input.viewport.height };
  }
  return input.renderedViewport ?? DEFAULT_VIEWPORT;
};

const modifiersDown = (modifiers: ReadonlyArray<string> | undefined, modifier: string): boolean =>
  modifiers?.includes(modifier) ?? false;

const playwrightModifiers = (modifiers: ReadonlyArray<string> | undefined): string[] => {
  const keys: string[] = [];
  if (modifiersDown(modifiers, "Alt")) keys.push("Alt");
  if (modifiersDown(modifiers, "Control")) keys.push("Control");
  if (modifiersDown(modifiers, "Meta")) keys.push("Meta");
  if (modifiersDown(modifiers, "Shift")) keys.push("Shift");
  return keys;
};

const readHistoryState = async (
  cdp: CDPSession,
): Promise<{ readonly canGoBack: boolean; readonly canGoForward: boolean }> => {
  try {
    const history = (await cdp.send("Page.getNavigationHistory")) as {
      readonly currentIndex?: number;
      readonly entries?: ReadonlyArray<unknown>;
    };
    const currentIndex = history.currentIndex ?? 0;
    const length = history.entries?.length ?? 0;
    return {
      canGoBack: currentIndex > 0,
      canGoForward: length > 0 && currentIndex < length - 1,
    };
  } catch {
    return { canGoBack: false, canGoForward: false };
  }
};

const selectorForElementScript = `
  (element) => {
    if (element.id) return "#" + CSS.escape(element.id);
    for (const attribute of ["data-testid", "name"]) {
      const value = element.getAttribute(attribute);
      if (value) return element.tagName.toLowerCase() + "[" + attribute + "=" + JSON.stringify(value) + "]";
    }
    const buildParts = (current, parts = []) => {
      if (!current || current.nodeType !== Node.ELEMENT_NODE || parts.length >= 8) return parts;
      const parent = current.parentElement;
      const siblings = parent
        ? Array.from(parent.children).filter((child) => child.tagName === current.tagName)
        : [];
      const base = current.tagName.toLowerCase();
      const part = siblings.length > 1
        ? base + ":nth-of-type(" + (siblings.indexOf(current) + 1) + ")"
        : base;
      return buildParts(parent, [part, ...parts]);
    };
    return buildParts(element).join(" > ");
  }
`;

export class ServerBrowserManager extends Context.Service<
  ServerBrowserManager,
  {
    readonly isEnabled: Effect.Effect<boolean>;
    readonly ensureTab: (
      input: PreviewTabActionInput & {
        readonly viewport?: PreviewViewportSetting;
        readonly renderedViewport?: { readonly width: number; readonly height: number };
      },
    ) => Effect.Effect<void, PreviewBrowserUnavailableError>;
    readonly navigate: (
      input: PreviewTabActionInput & { readonly url: string },
    ) => Effect.Effect<void, PreviewBrowserUnavailableError>;
    readonly resize: (
      input: PreviewResizeInput,
    ) => Effect.Effect<void, PreviewBrowserUnavailableError>;
    readonly refresh: (
      input: PreviewRefreshInput,
    ) => Effect.Effect<void, PreviewBrowserUnavailableError>;
    readonly close: (input: PreviewCloseInput) => Effect.Effect<void>;
    readonly goBack: (
      input: PreviewTabActionInput,
    ) => Effect.Effect<void, PreviewBrowserUnavailableError>;
    readonly goForward: (
      input: PreviewTabActionInput,
    ) => Effect.Effect<void, PreviewBrowserUnavailableError>;
    readonly zoom: (input: PreviewZoomInput) => Effect.Effect<void, PreviewBrowserUnavailableError>;
    readonly input: (
      input: PreviewInputEvent,
    ) => Effect.Effect<void, PreviewBrowserUnavailableError>;
    readonly captureScreenshot: (
      input: PreviewTabActionInput,
    ) => Effect.Effect<PreviewScreenshotArtifact, PreviewBrowserUnavailableError>;
    readonly pickElementAt: (
      input: PreviewPickElementInput,
    ) => Effect.Effect<string | null, PreviewBrowserUnavailableError>;
    readonly clearBrowserData: (
      data: BrowserDataKind,
    ) => Effect.Effect<void, PreviewBrowserUnavailableError>;
    readonly frames: (
      input: PreviewTabActionInput,
    ) => Effect.Effect<Stream.Stream<PreviewFrameEvent>, PreviewBrowserUnavailableError>;
    readonly automationStatus: (input: PreviewTabActionInput) => Effect.Effect<
      {
        readonly available: boolean;
        readonly visible: boolean;
        readonly tabId: string | null;
        readonly url: string | null;
        readonly title: string | null;
        readonly loading: boolean;
        readonly viewportSetting?: PreviewViewportSetting;
        readonly viewport?: { readonly width: number; readonly height: number };
      },
      never
    >;
    readonly automationSnapshot: (
      input: PreviewTabActionInput,
    ) => Effect.Effect<unknown, PreviewBrowserUnavailableError>;
    readonly automationClick: (
      input: PreviewTabActionInput & {
        readonly selector?: string;
        readonly locator?: string;
        readonly x?: number;
        readonly y?: number;
        readonly timeoutMs?: number;
      },
    ) => Effect.Effect<void, PreviewBrowserUnavailableError>;
    readonly automationType: (
      input: PreviewTabActionInput & {
        readonly selector?: string;
        readonly locator?: string;
        readonly text: string;
        readonly clear?: boolean;
        readonly timeoutMs?: number;
      },
    ) => Effect.Effect<void, PreviewBrowserUnavailableError>;
    readonly automationPress: (
      input: PreviewTabActionInput & {
        readonly key: string;
        readonly modifiers?: ReadonlyArray<string>;
      },
    ) => Effect.Effect<void, PreviewBrowserUnavailableError>;
    readonly automationScroll: (
      input: PreviewTabActionInput & {
        readonly deltaX?: number;
        readonly deltaY?: number;
        readonly selector?: string;
        readonly locator?: string;
      },
    ) => Effect.Effect<void, PreviewBrowserUnavailableError>;
    readonly automationEvaluate: (
      input: PreviewTabActionInput & {
        readonly expression: string;
        readonly awaitPromise?: boolean;
        readonly returnByValue?: boolean;
      },
    ) => Effect.Effect<unknown, PreviewBrowserUnavailableError>;
    readonly automationWaitFor: (
      input: PreviewTabActionInput & {
        readonly selector?: string;
        readonly locator?: string;
        readonly text?: string;
        readonly urlIncludes?: string;
        readonly timeoutMs?: number;
      },
    ) => Effect.Effect<void, PreviewBrowserUnavailableError>;
  }
>()("t3/preview/ServerBrowserManager") {}

export const make = Effect.gen(function* ServerBrowserManagerMake() {
  const config = yield* ServerConfig.ServerConfig;
  const previewManager = yield* PreviewManager.PreviewManager;
  const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const environmentId = yield* serverEnvironment.getEnvironmentId;
  const userDataDir = path.join(config.stateDir, "preview-browser", environmentHash(environmentId));
  const artifactDir = path.join(config.stateDir, "preview-artifacts");
  const tabs = new Map<string, ServerBrowserTab>();
  let runtimePromise: Promise<ServerBrowserRuntime> | null = null;

  const enabled = config.mode === "web" && config.previewBrowserMode !== "off";
  const context = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(context);
  const runPromise = Effect.runPromiseWith(context);

  const runDetached = <A, E>(effect: Effect.Effect<A, E>) => {
    runFork(effect.pipe(Effect.ignore));
  };

  const reportStatus = (tab: ServerBrowserTab, status?: "Loading" | "Success" | "LoadFailed") =>
    Effect.tryPromise({
      try: async () => {
        const url = tab.page.url();
        const title = await tab.page.title().catch(() => "");
        const history = await readHistoryState(tab.cdp);
        if (status === "LoadFailed") {
          return {
            navStatus: {
              _tag: "LoadFailed" as const,
              url: url || "about:blank",
              title,
              code: -1,
              description: "The server-hosted Chromium tab crashed or failed to load.",
            },
            ...history,
          };
        }
        return {
          navStatus: {
            _tag: status ?? "Success",
            url: url || "about:blank",
            title,
          },
          ...history,
        };
      },
      catch: browserError,
    }).pipe(
      Effect.flatMap((state) =>
        previewManager.reportStatus({
          threadId: tab.threadId,
          tabId: tab.tabId,
          navStatus: state.navStatus,
          canGoBack: state.canGoBack,
          canGoForward: state.canGoForward,
        }),
      ),
      Effect.ignore,
    );

  const launchRuntime = async (): Promise<ServerBrowserRuntime> => {
    if (!enabled) {
      throw new PreviewBrowserUnavailableError({
        message: "Server-hosted browser preview is disabled.",
      });
    }
    const resolution = await runPromise(BrowserExecutableResolver.resolveBrowserExecutable(config));
    await NodeFSP.mkdir(userDataDir, { recursive: true });
    const playwright = (await import("playwright")) as typeof import("playwright");
    const args: string[] = [
      "--disable-dev-shm-usage",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
    ];
    if (config.previewBrowserSandbox === "off" || config.previewBrowserSandbox === "auto") {
      args.push("--no-sandbox");
    }
    const options = {
      executablePath: resolution.executablePath,
      headless: true,
      args,
      viewport: DEFAULT_VIEWPORT,
      ignoreHTTPSErrors: true,
    };
    const context = await playwright.chromium.launchPersistentContext(userDataDir, options);
    return { context, source: resolution.source };
  };

  const ensureRuntime = Effect.tryPromise({
    try: async () => {
      runtimePromise ??= launchRuntime();
      try {
        return await runtimePromise;
      } catch (error) {
        runtimePromise = null;
        throw error;
      }
    },
    catch: browserError,
  });

  const attachPage = Effect.fn("ServerBrowserManager.attachPage")(function* (
    input: PreviewTabActionInput & {
      readonly viewport?: PreviewViewportSetting;
      readonly renderedViewport?: { readonly width: number; readonly height: number };
    },
  ) {
    const existing = tabs.get(input.tabId);
    if (existing) return existing;
    const runtime = yield* ensureRuntime;
    const viewportSetting = input.viewport ?? FILL_PREVIEW_VIEWPORT;
    const renderedViewport =
      viewportSetting._tag === "fill"
        ? (input.renderedViewport ?? DEFAULT_VIEWPORT)
        : { width: viewportSetting.width, height: viewportSetting.height };
    const framePubSub = yield* PubSub.sliding<PreviewFrameEvent>(1);
    const page = yield* Effect.tryPromise({
      try: async () => {
        const created = await runtime.context.newPage();
        await created.setViewportSize(renderedViewport);
        return created;
      },
      catch: browserError,
    });
    const cdp = yield* Effect.tryPromise({
      try: async () => runtime.context.newCDPSession(page),
      catch: browserError,
    });
    const tab: ServerBrowserTab = {
      threadId: input.threadId,
      tabId: input.tabId,
      page,
      cdp,
      frames: framePubSub,
      sequence: 0,
      zoomFactor: 1,
      lastFrameAt: 0,
      viewportSetting,
      renderedViewport,
    };
    tabs.set(input.tabId, tab);

    page.on("load", () => runDetached(reportStatus(tab, "Success")));
    page.on("crash", () => {
      if (tabs.get(input.tabId) === tab) tabs.delete(input.tabId);
      runDetached(PubSub.shutdown(framePubSub));
      runDetached(reportStatus(tab, "LoadFailed"));
    });
    page.on("close", () => {
      if (tabs.get(input.tabId) === tab) tabs.delete(input.tabId);
      runDetached(PubSub.shutdown(framePubSub));
    });
    cdp.on("Page.screencastFrame", (event: unknown) => {
      const frame = event as {
        readonly data?: string;
        readonly sessionId?: number;
        readonly metadata?: { readonly deviceWidth?: number; readonly deviceHeight?: number };
      };
      if (typeof frame.sessionId === "number") {
        void cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => {});
      }
      if (typeof frame.data !== "string") return;
      const now = Date.now();
      const minInterval = 1000 / config.previewBrowserMaxFps;
      if (now - tab.lastFrameAt < minInterval) return;
      tab.lastFrameAt = now;
      tab.sequence += 1;
      const createdAt = new Date(now).toISOString();
      const previewFrame: PreviewFrameEvent = {
        threadId: tab.threadId,
        tabId: tab.tabId,
        sequence: tab.sequence,
        mimeType: "image/jpeg",
        data: frame.data,
        width: Math.max(1, Math.round(frame.metadata?.deviceWidth ?? tab.renderedViewport.width)),
        height: Math.max(
          1,
          Math.round(frame.metadata?.deviceHeight ?? tab.renderedViewport.height),
        ),
        createdAt,
      };
      runDetached(PubSub.publish(framePubSub, previewFrame));
    });
    yield* Effect.tryPromise({
      try: async () => {
        await cdp.send("Page.enable");
        await cdp.send("Page.startScreencast", {
          format: "jpeg",
          quality: config.previewBrowserJpegQuality,
          maxWidth: config.previewBrowserMaxFrameWidth,
          maxHeight: config.previewBrowserMaxFrameHeight,
        });
      },
      catch: browserError,
    });
    return tab;
  });

  const getTab = Effect.fn("ServerBrowserManager.getTab")(function* (input: PreviewTabActionInput) {
    return yield* attachPage(input);
  });

  const ensureTab: ServerBrowserManager["Service"]["ensureTab"] = (input) =>
    attachPage(input).pipe(Effect.asVoid);

  const navigate: ServerBrowserManager["Service"]["navigate"] = Effect.fn(
    "ServerBrowserManager.navigate",
  )(function* (input) {
    const tab = yield* getTab(input);
    yield* reportStatus(tab, "Loading");
    yield* Effect.tryPromise({
      try: () => tab.page.goto(input.url, { waitUntil: "domcontentloaded", timeout: 30_000 }),
      catch: browserError,
    }).pipe(
      Effect.catch((error) =>
        reportStatus(tab, "LoadFailed").pipe(Effect.andThen(Effect.fail(error))),
      ),
    );
    yield* reportStatus(tab, "Success");
  });

  const resize: ServerBrowserManager["Service"]["resize"] = Effect.fn(
    "ServerBrowserManager.resize",
  )(function* (input) {
    const tab = yield* getTab(input);
    const renderedViewport = viewportFromResizeInput(input);
    tab.viewportSetting = input.viewport;
    tab.renderedViewport = renderedViewport;
    yield* Effect.tryPromise({
      try: async () => {
        await tab.page.setViewportSize(renderedViewport);
      },
      catch: browserError,
    });
  });

  const refresh: ServerBrowserManager["Service"]["refresh"] = Effect.fn(
    "ServerBrowserManager.refresh",
  )(function* (input) {
    const tab = yield* getTab(input);
    yield* reportStatus(tab, "Loading");
    yield* Effect.tryPromise({
      try: () =>
        input.bypassCache
          ? tab.cdp.send("Page.reload", { ignoreCache: true })
          : tab.page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 }),
      catch: browserError,
    });
  });

  const close: ServerBrowserManager["Service"]["close"] = Effect.fn("ServerBrowserManager.close")(
    function* (input) {
      const targets = input.tabId
        ? [tabs.get(input.tabId)].filter((tab): tab is ServerBrowserTab => tab !== undefined)
        : Array.from(tabs.values()).filter((tab) => tab.threadId === input.threadId);
      yield* Effect.forEach(
        targets,
        (tab) =>
          Effect.tryPromise({
            try: () => tab.page.close({ runBeforeUnload: false }),
            catch: () => undefined,
          }).pipe(Effect.ignore),
        { discard: true },
      );
    },
  );

  const goBack: ServerBrowserManager["Service"]["goBack"] = Effect.fn(
    "ServerBrowserManager.goBack",
  )(function* (input) {
    const tab = yield* getTab(input);
    yield* Effect.tryPromise({
      try: () => tab.page.goBack({ waitUntil: "domcontentloaded", timeout: 30_000 }),
      catch: browserError,
    }).pipe(Effect.asVoid);
  });

  const goForward: ServerBrowserManager["Service"]["goForward"] = Effect.fn(
    "ServerBrowserManager.goForward",
  )(function* (input) {
    const tab = yield* getTab(input);
    yield* Effect.tryPromise({
      try: () => tab.page.goForward({ waitUntil: "domcontentloaded", timeout: 30_000 }),
      catch: browserError,
    }).pipe(Effect.asVoid);
  });

  const zoom: ServerBrowserManager["Service"]["zoom"] = Effect.fn("ServerBrowserManager.zoom")(
    function* (input) {
      const tab = yield* getTab(input);
      const next =
        input.action === "reset"
          ? 1
          : Math.max(0.25, Math.min(3, tab.zoomFactor + (input.action === "in" ? 0.1 : -0.1)));
      tab.zoomFactor = next;
      yield* Effect.tryPromise({
        try: () =>
          tab.page.evaluate((factor) => {
            (globalThis as any).document.documentElement.style.zoom = String(factor);
          }, next),
        catch: browserError,
      });
    },
  );

  const input: ServerBrowserManager["Service"]["input"] = Effect.fn("ServerBrowserManager.input")(
    function* (event) {
      const tab = yield* getTab(event);
      yield* Effect.tryPromise({
        try: async () => {
          switch (event.type) {
            case "pointerMove":
              await tab.page.mouse.move(event.x, event.y);
              break;
            case "pointerDown":
              await tab.page.mouse.move(event.x, event.y);
              await tab.page.mouse.down({ button: event.button === 2 ? "right" : "left" });
              break;
            case "pointerUp":
              await tab.page.mouse.move(event.x, event.y);
              await tab.page.mouse.up({ button: event.button === 2 ? "right" : "left" });
              break;
            case "wheel":
              await tab.page.mouse.move(event.x, event.y);
              await tab.page.mouse.wheel(event.deltaX, event.deltaY);
              break;
            case "keyDown":
              if (event.text && event.text.length === 1 && event.key.length === 1) {
                await tab.page.keyboard.insertText(event.text);
              } else {
                await tab.page.keyboard.down(event.key);
              }
              break;
            case "keyUp":
              await tab.page.keyboard.up(event.key);
              break;
          }
        },
        catch: browserError,
      });
    },
  );

  const captureScreenshot: ServerBrowserManager["Service"]["captureScreenshot"] = Effect.fn(
    "ServerBrowserManager.captureScreenshot",
  )(function* (input) {
    const tab = yield* getTab(input);
    const [createdAt, millis] = yield* Effect.all([nowIso, Clock.currentTimeMillis]);
    const id = `browser-screenshot-${sanitizeArtifactSegment(tab.page.url())}-${millis.toString(36)}`;
    const artifactPath = path.join(artifactDir, `${id}.png`);
    const data = yield* Effect.tryPromise({
      try: () => tab.page.screenshot({ type: "png", fullPage: false }),
      catch: browserError,
    });
    yield* fileSystem
      .makeDirectory(artifactDir, { recursive: true })
      .pipe(Effect.mapError(browserError));
    yield* fileSystem.writeFile(artifactPath, data).pipe(Effect.mapError(browserError));
    return {
      id,
      threadId: input.threadId,
      tabId: input.tabId,
      path: artifactPath,
      mimeType: "image/png" as const,
      sizeBytes: data.byteLength,
      createdAt,
    };
  });

  const pickElementAt: ServerBrowserManager["Service"]["pickElementAt"] = Effect.fn(
    "ServerBrowserManager.pickElementAt",
  )(function* (input) {
    const tab = yield* getTab(input);
    return yield* Effect.tryPromise({
      try: () =>
        tab.page.evaluate(
          ({ x, y, selectorSource }) => {
            const document = (globalThis as any).document;
            const element = document.elementFromPoint(x, y);
            if (!element) return null;
            const selectorFor = (0, eval)(selectorSource) as (element: any) => string;
            const rect = element.getBoundingClientRect();
            const label =
              element.getAttribute("aria-label") ||
              element.innerText ||
              element.getAttribute("name") ||
              element.tagName.toLowerCase();
            return `${element.tagName.toLowerCase()} ${JSON.stringify(label.slice(0, 120))} at ${selectorFor(element)} (${Math.round(rect.x)}, ${Math.round(rect.y)}, ${Math.round(rect.width)}x${Math.round(rect.height)})`;
          },
          { x: input.x, y: input.y, selectorSource: selectorForElementScript },
        ),
      catch: browserError,
    });
  });

  const clearBrowserData: ServerBrowserManager["Service"]["clearBrowserData"] = Effect.fn(
    "ServerBrowserManager.clearBrowserData",
  )(function* (data) {
    const runtime = yield* ensureRuntime;
    if (data === "cookies" || data === "all") {
      yield* Effect.tryPromise({ try: () => runtime.context.clearCookies(), catch: browserError });
    }
    if (data === "cache" || data === "all") {
      yield* Effect.forEach(
        tabs.values(),
        (tab) =>
          Effect.tryPromise({
            try: () => tab.cdp.send("Network.clearBrowserCache"),
            catch: browserError,
          }),
        { discard: true },
      );
    }
  });

  const frames: ServerBrowserManager["Service"]["frames"] = Effect.fn(
    "ServerBrowserManager.frames",
  )(function* (input) {
    const tab = yield* getTab(input);
    return Stream.fromPubSub(tab.frames);
  });

  const automationStatus: ServerBrowserManager["Service"]["automationStatus"] = Effect.fn(
    "ServerBrowserManager.automationStatus",
  )(function* (input) {
    const tab = tabs.get(input.tabId);
    if (!tab || tab.page.isClosed()) {
      return {
        available: enabled,
        visible: true,
        tabId: tab?.tabId ?? null,
        url: null,
        title: null,
        loading: false,
      };
    }
    const title = yield* Effect.promise(() => tab.page.title().catch(() => ""));
    return {
      available: true,
      visible: true,
      tabId: input.tabId,
      url: tab.page.url() || null,
      title,
      loading: false,
      viewportSetting: tab.viewportSetting,
      viewport: tab.renderedViewport,
    };
  });

  const automationSnapshot: ServerBrowserManager["Service"]["automationSnapshot"] = Effect.fn(
    "ServerBrowserManager.automationSnapshot",
  )(function* (input) {
    const tab = yield* getTab(input);
    const pageInfo = yield* Effect.tryPromise({
      try: () =>
        tab.page.evaluate(
          ({ maxText, maxElements, selectorSource }) => {
            const document = (globalThis as any).document;
            const location = (globalThis as any).location;
            const getComputedStyle = (globalThis as any).getComputedStyle;
            const selectorFor = (0, eval)(selectorSource) as (element: any) => string;
            const visible = (element: any) => {
              const style = getComputedStyle(element);
              const rect = element.getBoundingClientRect();
              return (
                style.visibility !== "hidden" &&
                style.display !== "none" &&
                rect.width > 0 &&
                rect.height > 0
              );
            };
            const elements = Array.from<any>(
              document.querySelectorAll("a[href],button,input,textarea,select,[role],[tabindex]"),
            )
              .filter(visible)
              .slice(0, maxElements)
              .map((element) => {
                const rect = element.getBoundingClientRect();
                return {
                  tag: element.tagName.toLowerCase(),
                  role: element.getAttribute("role"),
                  name:
                    element.getAttribute("aria-label") ||
                    element.innerText ||
                    element.getAttribute("name") ||
                    "",
                  selector: selectorFor(element),
                  x: rect.x,
                  y: rect.y,
                  width: rect.width,
                  height: rect.height,
                };
              });
            return {
              url: location.href,
              title: document.title,
              loading: document.readyState !== "complete",
              visibleText: (document.body?.innerText || "").slice(0, maxText),
              interactiveElements: elements,
            };
          },
          {
            maxText: MAX_VISIBLE_TEXT_LENGTH,
            maxElements: MAX_INTERACTIVE_ELEMENTS,
            selectorSource: selectorForElementScript,
          },
        ),
      catch: browserError,
    });
    const [accessibilityTree, screenshot] = yield* Effect.all([
      Effect.promise(() => tab.cdp.send("Accessibility.getFullAXTree").catch(() => null)),
      Effect.tryPromise({
        try: () => tab.page.screenshot({ type: "png", fullPage: false }),
        catch: browserError,
      }),
    ]);
    return {
      ...pageInfo,
      accessibilityTree,
      consoleEntries: [],
      networkEntries: [],
      actionTimeline: [],
      screenshot: {
        mimeType: "image/png" as const,
        data: screenshot.toString("base64"),
        width: tab.renderedViewport.width,
        height: tab.renderedViewport.height,
      },
    };
  });

  const resolveLocator = (page: Page, input: { selector?: string; locator?: string }) =>
    input.locator
      ? page.locator(input.locator)
      : input.selector
        ? page.locator(input.selector)
        : null;

  const automationClick: ServerBrowserManager["Service"]["automationClick"] = Effect.fn(
    "ServerBrowserManager.automationClick",
  )(function* (input) {
    const tab = yield* getTab(input);
    yield* Effect.tryPromise({
      try: async () => {
        const locator = resolveLocator(tab.page, input);
        if (locator) await locator.click({ timeout: input.timeoutMs ?? 15_000 });
        else await tab.page.mouse.click(input.x ?? 0, input.y ?? 0);
      },
      catch: browserError,
    });
  });

  const automationType: ServerBrowserManager["Service"]["automationType"] = Effect.fn(
    "ServerBrowserManager.automationType",
  )(function* (input) {
    const tab = yield* getTab(input);
    yield* Effect.tryPromise({
      try: async () => {
        const locator = resolveLocator(tab.page, input);
        if (locator) {
          if (input.clear) await locator.fill("", { timeout: input.timeoutMs ?? 15_000 });
          await locator.fill(input.text, { timeout: input.timeoutMs ?? 15_000 });
          return;
        }
        await tab.page.keyboard.insertText(input.text);
      },
      catch: browserError,
    });
  });

  const automationPress: ServerBrowserManager["Service"]["automationPress"] = Effect.fn(
    "ServerBrowserManager.automationPress",
  )(function* (input) {
    const tab = yield* getTab(input);
    yield* Effect.tryPromise({
      try: async () => {
        const modifiers = playwrightModifiers(input.modifiers);
        for (const modifier of modifiers) await tab.page.keyboard.down(modifier);
        try {
          await tab.page.keyboard.press(input.key);
        } finally {
          for (const modifier of modifiers.toReversed()) await tab.page.keyboard.up(modifier);
        }
      },
      catch: browserError,
    });
  });

  const automationScroll: ServerBrowserManager["Service"]["automationScroll"] = Effect.fn(
    "ServerBrowserManager.automationScroll",
  )(function* (input) {
    const tab = yield* getTab(input);
    yield* Effect.tryPromise({
      try: async () => {
        const locator = resolveLocator(tab.page, input);
        if (locator) {
          await locator.evaluate(
            (element, delta) =>
              (element as any).scrollBy({ left: delta.x, top: delta.y, behavior: "instant" }),
            { x: input.deltaX ?? 0, y: input.deltaY ?? 0 },
          );
          return;
        }
        await tab.page.mouse.wheel(input.deltaX ?? 0, input.deltaY ?? 0);
      },
      catch: browserError,
    });
  });

  const automationEvaluate: ServerBrowserManager["Service"]["automationEvaluate"] = Effect.fn(
    "ServerBrowserManager.automationEvaluate",
  )(function* (input) {
    const tab = yield* getTab(input);
    const value = yield* Effect.tryPromise({
      try: () => tab.page.evaluate(`(${input.expression})`),
      catch: browserError,
    });
    const bytes = Buffer.byteLength(JSON.stringify(value ?? null), "utf8");
    if (bytes > MAX_EVALUATION_BYTES) {
      return yield* new PreviewBrowserUnavailableError({
        message: `Preview automation evaluate result exceeded ${MAX_EVALUATION_BYTES} bytes.`,
      });
    }
    return value;
  });

  const automationWaitFor: ServerBrowserManager["Service"]["automationWaitFor"] = Effect.fn(
    "ServerBrowserManager.automationWaitFor",
  )(function* (input) {
    const tab = yield* getTab(input);
    const timeout = input.timeoutMs ?? 15_000;
    yield* Effect.tryPromise({
      try: async () => {
        if (input.selector || input.locator) {
          await resolveLocator(tab.page, input)?.waitFor({ timeout });
        }
        if (input.text) await tab.page.getByText(input.text).waitFor({ timeout });
        if (input.urlIncludes) {
          await tab.page.waitForURL((url) => url.toString().includes(input.urlIncludes!), {
            timeout,
          });
        }
      },
      catch: browserError,
    });
  });

  yield* Effect.addFinalizer(() =>
    Effect.tryPromise({
      try: async () => {
        const runtime = runtimePromise ? await runtimePromise.catch(() => null) : null;
        await runtime?.context.close().catch(() => {});
      },
      catch: () => undefined,
    }).pipe(Effect.ignore),
  );

  return ServerBrowserManager.of({
    isEnabled: Effect.succeed(enabled),
    ensureTab,
    navigate,
    resize,
    refresh,
    close,
    goBack,
    goForward,
    zoom,
    input,
    captureScreenshot,
    pickElementAt,
    clearBrowserData,
    frames,
    automationStatus,
    automationSnapshot,
    automationClick,
    automationType,
    automationPress,
    automationScroll,
    automationEvaluate,
    automationWaitFor,
  });
});

export const layer = Layer.effect(ServerBrowserManager, make);
