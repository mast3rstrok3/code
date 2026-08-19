// @effect-diagnostics nodeBuiltinImport:off
import * as NodeEvents from "node:events";
import * as NodeStream from "node:stream";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { BrowserContext, CDPSession, Page } from "playwright";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as PreviewManager from "./Manager.ts";
import * as PreviewRecordingPolicy from "./PreviewRecordingPolicy.ts";
import {
  ServerBrowserManager,
  makeWithAdapter,
  type ServerBrowserManagerAdapter,
} from "./ServerBrowserManager.ts";

type Listener = (...args: ReadonlyArray<unknown>) => void;

class FakeEventTarget {
  private readonly listeners = new Map<string, Set<Listener>>();

  on(event: string, listener: Listener) {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  once(event: string, listener: Listener) {
    const wrapped: Listener = (...args) => {
      this.listeners.get(event)?.delete(wrapped);
      listener(...args);
    };
    return this.on(event, wrapped);
  }

  emit(event: string, ...args: ReadonlyArray<unknown>) {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
}

class FakePage extends FakeEventTarget {
  closed = false;
  failScreenshot = false;
  deferGoto = false;
  viewport = { width: 1280, height: 800 };
  private gotoResolver: (() => void) | null = null;

  readonly mouse = {
    move: async () => {},
    down: async () => {},
    up: async () => {},
    wheel: async () => {},
    click: async () => {},
  };

  readonly keyboard = {
    insertText: async () => {},
    down: async () => {},
    up: async () => {},
    press: async () => {},
  };

  async setViewportSize(viewport: { readonly width: number; readonly height: number }) {
    this.viewport = viewport;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.emit("close");
  }

  isClosed() {
    return this.closed;
  }

  url() {
    return "about:blank";
  }

  async title() {
    return "";
  }

  async goto() {
    if (!this.deferGoto) return null;
    await new Promise<void>((resolve) => {
      this.gotoResolver = resolve;
    });
    return null;
  }

  resolveGoto() {
    this.gotoResolver?.();
    this.gotoResolver = null;
  }

  async screenshot() {
    if (this.failScreenshot) throw new Error("screenshot failed");
    return Buffer.from("jpeg-frame");
  }

  // rrweb recording surface.
  failExposeBinding = false;
  readonly initScripts: string[] = [];
  readonly evaluated: string[] = [];
  domRecorderBinding: ((source: unknown, payload: unknown) => unknown) | null = null;

  async exposeBinding(_name: string, callback: (source: unknown, payload: unknown) => unknown) {
    if (this.failExposeBinding) throw new Error("binding refused");
    this.domRecorderBinding = callback;
  }

  async addInitScript(script: { readonly content: string }) {
    this.initScripts.push(script.content);
  }

  async evaluate(expression: string) {
    this.evaluated.push(expression);
    return undefined;
  }
}

class FakeCdp extends FakeEventTarget {
  readonly commands: string[] = [];
  detached = false;
  failCacheClear = false;

  async send(command: string) {
    this.commands.push(command);
    if (command === "Network.clearBrowserCache" && this.failCacheClear) {
      throw new Error("cache clear failed");
    }
    if (command === "Page.getNavigationHistory") {
      return { currentIndex: 0, entries: [] };
    }
    return {};
  }

  async detach() {
    this.detached = true;
  }
}

class FakeContext extends FakeEventTarget {
  readonly createdPages: FakePage[] = [new FakePage()];
  readonly createdCdps: FakeCdp[] = [];
  closeCalls = 0;
  clearCookiesCalls = 0;
  deferClose = false;
  failCacheClear = false;
  deferPageGoto = false;
  failPageExposeBinding = false;
  private closeResolver: (() => void) | null = null;

  pages() {
    return this.createdPages.filter((page) => !page.closed) as unknown as Page[];
  }

  async newPage() {
    const page = new FakePage();
    page.deferGoto = this.deferPageGoto;
    page.failExposeBinding = this.failPageExposeBinding;
    this.createdPages.push(page);
    return page as unknown as Page;
  }

  async newCDPSession() {
    const cdp = new FakeCdp();
    cdp.failCacheClear = this.failCacheClear;
    this.createdCdps.push(cdp);
    return cdp as unknown as CDPSession;
  }

  async clearCookies() {
    this.clearCookiesCalls += 1;
  }

  close() {
    this.closeCalls += 1;
    if (!this.deferClose) return this.finishClose();
    return new Promise<void>((resolve) => {
      this.closeResolver = () => {
        void this.finishClose().then(resolve);
      };
    });
  }

  resolveClose() {
    this.closeResolver?.();
    this.closeResolver = null;
  }

  async closeUnexpectedly() {
    await this.finishClose();
  }

  private async finishClose() {
    for (const page of this.createdPages) await page.close();
    this.emit("close");
  }

  managedPage() {
    return this.createdPages.find((page) =>
      this.createdCdps.some((cdp) => cdp.commands.includes("Page.enable") && !page.closed),
    );
  }

  managedCdp() {
    return this.createdCdps.find((cdp) => cdp.commands.includes("Page.enable"));
  }
}

const fakeChildProcess = () => {
  const child = new NodeEvents.EventEmitter() as NodeEvents.EventEmitter & {
    stdin: NodeStream.PassThrough;
    stderr: NodeStream.PassThrough;
    kill: () => boolean;
  };
  child.stdin = new NodeStream.PassThrough();
  child.stderr = new NodeStream.PassThrough();
  child.kill = () => {
    child.emit("exit", null);
    return true;
  };
  child.stdin.once("finish", () => child.emit("exit", 0));
  return child;
};

const makeHarness = (options: { readonly recordingMode?: "auto" | "dom" | "video" } = {}) => {
  const contexts: FakeContext[] = [];
  const childProcesses: ReturnType<typeof fakeChildProcess>[] = [];
  let configureContext: ((context: FakeContext) => void) | null = null;
  const adapter: ServerBrowserManagerAdapter = {
    launchPersistentContext: async () => {
      const context = new FakeContext();
      configureContext?.(context);
      contexts.push(context);
      return context as unknown as BrowserContext;
    },
    spawn: (() => {
      const child = fakeChildProcess();
      childProcesses.push(child);
      return child;
    }) as unknown as ServerBrowserManagerAdapter["spawn"],
  };
  const baseConfigLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "server-browser-manager-test-",
  });
  const configLayer = Layer.effect(
    ServerConfig.ServerConfig,
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      return ServerConfig.make({
        ...config,
        previewBrowserExecutablePath: "/bin/true",
        previewFfmpegExecutablePath: "/bin/true",
        previewBrowserIdleTtlMs: 60_000,
        // These cases assert encoder behaviour; the DOM recorder has its own suite.
        previewRecordingMode: options.recordingMode ?? "video",
      });
    }),
  ).pipe(Layer.provide(baseConfigLayer));
  const environmentLayer = Layer.succeed(
    ServerEnvironment.ServerEnvironment,
    ServerEnvironment.ServerEnvironment.of({
      getEnvironmentId: Effect.succeed(EnvironmentId.make("server-browser-test")),
      getDescriptor: Effect.die("descriptor is not used by browser manager tests"),
    }),
  );
  const layer = Layer.effect(ServerBrowserManager, makeWithAdapter(adapter)).pipe(
    Layer.provideMerge(PreviewManager.layer),
    // No projects exist in these tests, so the server setting is the whole policy.
    Layer.provide(PreviewRecordingPolicy.layerServerConfigOnly),
    Layer.provide(environmentLayer),
    Layer.provide(configLayer),
    Layer.provide(NodeServices.layer),
  );
  return {
    contexts,
    childProcesses,
    layer,
    configureNextContext: (configure: (context: FakeContext) => void) => {
      configureContext = configure;
    },
  };
};

const threadId = ThreadId.make("browser-manager-thread");
const tab = (tabId: string) => ({ threadId, tabId });

afterEach(() => {
  vi.useRealTimers();
});

describe("ServerBrowserManager lifecycle", () => {
  it.effect(
    "allows cold development pages more than eight seconds to reach DOMContentLoaded",
    () => {
      vi.useFakeTimers();
      const harness = makeHarness();
      harness.configureNextContext((context) => {
        context.deferPageGoto = true;
      });
      return Effect.gen(function* () {
        const browser = yield* ServerBrowserManager;
        const navigation = yield* browser
          .navigate({ ...tab("cold-navigation"), url: "https://feature.example.test" })
          .pipe(Effect.forkScoped);

        yield* Effect.promise(() =>
          vi.waitFor(() => {
            expect(harness.contexts).toHaveLength(1);
            expect(harness.contexts[0]!.managedPage()).toBeDefined();
          }),
        );
        yield* Effect.promise(() => vi.advanceTimersByTimeAsync(10_000));
        harness.contexts[0]!.managedPage()!.resolveGoto();
        yield* Effect.promise(() => vi.advanceTimersByTimeAsync(0));

        expect(Exit.isSuccess(yield* Effect.exit(Fiber.join(navigation)))).toBe(true);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("starts screencasting only for active frame subscribers", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const browser = yield* ServerBrowserManager;
      yield* browser.ensureTab(tab("frames"));
      const cdp = harness.contexts[0]!.managedCdp()!;
      expect(cdp.commands).not.toContain("Page.startScreencast");

      const firstStream = yield* browser.frames(tab("frames"));
      const secondStream = yield* browser.frames(tab("frames"));
      const firstFiber = yield* Stream.runDrain(firstStream).pipe(Effect.forkScoped);
      const secondFiber = yield* Stream.runDrain(secondStream).pipe(Effect.forkScoped);
      yield* Effect.promise(() =>
        vi.waitFor(() => {
          expect(cdp.commands.filter((command) => command === "Page.startScreencast")).toHaveLength(
            1,
          );
        }),
      );

      yield* Fiber.interrupt(firstFiber);
      expect(cdp.commands).not.toContain("Page.stopScreencast");
      yield* Fiber.interrupt(secondFiber);
      yield* Effect.promise(() =>
        vi.waitFor(() => {
          expect(cdp.commands.filter((command) => command === "Page.stopScreencast")).toHaveLength(
            1,
          );
        }),
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect(
    "shares one screencast between UI subscription and recording and releases failures",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const browser = yield* ServerBrowserManager;
        yield* browser.ensureTab(tab("recording"));
        const context = harness.contexts[0]!;
        const cdp = context.managedCdp()!;
        const stream = yield* browser.frames(tab("recording"));
        const streamFiber = yield* Stream.runDrain(stream).pipe(Effect.forkScoped);
        yield* Effect.promise(() =>
          vi.waitFor(() => expect(cdp.commands).toContain("Page.startScreencast")),
        );

        yield* browser.recordingStart(tab("recording"));
        expect(cdp.commands.filter((command) => command === "Page.startScreencast")).toHaveLength(
          1,
        );
        const stopExit = yield* Effect.exit(
          browser.recordingStop({ threadId, tabId: "recording" }),
        );
        expect(Exit.isFailure(stopExit)).toBe(true);
        expect(cdp.commands).not.toContain("Page.stopScreencast");

        yield* Fiber.interrupt(streamFiber);
        yield* Effect.promise(() =>
          vi.waitFor(() => expect(cdp.commands).toContain("Page.stopScreencast")),
        );

        context.managedPage()!.failScreenshot = true;
        const startExit = yield* Effect.exit(browser.recordingStart(tab("recording")));
        expect(Exit.isFailure(startExit)).toBe(true);
        yield* Effect.promise(() =>
          vi.waitFor(() => {
            expect(
              cdp.commands.filter((command) => command === "Page.stopScreencast"),
            ).toHaveLength(2);
          }),
        );
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("records the DOM without an encoder or a screencast", () => {
    const harness = makeHarness({ recordingMode: "auto" });
    return Effect.gen(function* () {
      const browser = yield* ServerBrowserManager;
      yield* browser.ensureTab(tab("dom-recording"));
      yield* browser.recordingStart(tab("dom-recording"));

      const page = harness.contexts[0]!.managedPage()!;
      const cdp = harness.contexts[0]!.managedCdp()!;
      expect(harness.childProcesses).toHaveLength(0);
      expect(cdp.commands).not.toContain("Page.startScreencast");
      expect(page.initScripts).toHaveLength(1);

      yield* Effect.promise(async () => {
        await page.domRecorderBinding?.(null, [{ type: 2 }, { type: 3 }]);
      });
      const artifact = yield* browser.recordingStop({ threadId, tabId: "dom-recording" });

      expect(artifact.mimeType).toBe("application/x-rrweb+jsonl");
      expect(artifact.path.endsWith(".rrweb.jsonl")).toBe(true);
      expect(artifact.sizeBytes).toBeGreaterThan(0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("falls back to the encoder when the page refuses the recorder", () => {
    const harness = makeHarness({ recordingMode: "auto" });
    harness.configureNextContext((context) => {
      context.failPageExposeBinding = true;
    });
    return Effect.gen(function* () {
      const browser = yield* ServerBrowserManager;
      yield* browser.ensureTab(tab("dom-fallback"));
      yield* browser.recordingStart(tab("dom-fallback"));

      expect(harness.childProcesses).toHaveLength(1);
      expect(harness.contexts[0]!.managedCdp()!.commands).toContain("Page.startScreencast");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("refuses to record when the DOM recorder is pinned and cannot attach", () => {
    const harness = makeHarness({ recordingMode: "dom" });
    harness.configureNextContext((context) => {
      context.failPageExposeBinding = true;
    });
    return Effect.gen(function* () {
      const browser = yield* ServerBrowserManager;
      yield* browser.ensureTab(tab("dom-pinned"));
      const exit = yield* Effect.exit(browser.recordingStart(tab("dom-pinned")));

      expect(Exit.isFailure(exit)).toBe(true);
      expect(harness.childProcesses).toHaveLength(0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("aborts a recording that outlives its reviewer", () => {
    vi.useFakeTimers();
    const harness = makeHarness();
    return Effect.gen(function* () {
      const browser = yield* ServerBrowserManager;
      yield* browser.ensureTab(tab("recording-watchdog"));
      yield* browser.recordingStart(tab("recording-watchdog"));
      const cdp = harness.contexts[0]!.managedCdp()!;
      expect(cdp.commands).not.toContain("Page.stopScreencast");

      // Nobody calls recordingStop: the reviewer's session was stopped mid-review.
      yield* Effect.promise(() => vi.advanceTimersByTimeAsync(30 * 60_000));
      yield* Effect.promise(() =>
        vi.waitFor(() => {
          expect(cdp.commands.filter((command) => command === "Page.stopScreencast")).toHaveLength(
            1,
          );
        }),
      );
      expect(harness.childProcesses[0]!.stdin.writableEnded).toBe(true);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("releases the screencast when the recording process exits unexpectedly", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const browser = yield* ServerBrowserManager;
      yield* browser.ensureTab(tab("recording-exit"));
      yield* browser.recordingStart(tab("recording-exit"));
      const cdp = harness.contexts[0]!.managedCdp()!;
      expect(cdp.commands.filter((command) => command === "Page.startScreencast")).toHaveLength(1);

      harness.childProcesses[0]!.emit("exit", 1);
      yield* Effect.promise(() =>
        vi.waitFor(() => {
          expect(cdp.commands.filter((command) => command === "Page.stopScreencast")).toHaveLength(
            1,
          );
        }),
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("disposes crashed tabs and schedules one idle shutdown after the final tab", () => {
    vi.useFakeTimers();
    const harness = makeHarness();
    return Effect.gen(function* () {
      const browser = yield* ServerBrowserManager;
      yield* browser.ensureTab(tab("crash"));
      const context = harness.contexts[0]!;
      const cdp = context.managedCdp()!;
      const stream = yield* browser.frames(tab("crash"));
      const streamFiber = yield* Stream.runDrain(stream).pipe(Effect.forkScoped);
      yield* Effect.promise(() => vi.advanceTimersByTimeAsync(0));

      context.managedPage()!.emit("crash");
      yield* Effect.promise(() => vi.advanceTimersByTimeAsync(0));
      expect(cdp.detached).toBe(true);
      expect(cdp.commands).toContain("Page.stopScreencast");
      yield* Effect.promise(() => vi.advanceTimersByTimeAsync(120_000));
      expect(context.closeCalls).toBe(1);
      yield* Fiber.interrupt(streamFiber);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("cancels idle shutdown when a new tab is requested", () => {
    vi.useFakeTimers();
    const harness = makeHarness();
    return Effect.gen(function* () {
      const browser = yield* ServerBrowserManager;
      yield* browser.ensureTab(tab("first"));
      const context = harness.contexts[0]!;
      yield* browser.close(tab("first"));
      yield* Effect.promise(() => vi.advanceTimersByTimeAsync(30_000));
      yield* browser.ensureTab(tab("second"));
      yield* Effect.promise(() => vi.advanceTimersByTimeAsync(40_000));
      expect(context.closeCalls).toBe(0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("waits for shutdown before launching one replacement runtime", () => {
    vi.useFakeTimers();
    const harness = makeHarness();
    harness.configureNextContext((context) => {
      if (harness.contexts.length === 0) context.deferClose = true;
    });
    return Effect.gen(function* () {
      const browser = yield* ServerBrowserManager;
      yield* browser.ensureTab(tab("first"));
      const firstContext = harness.contexts[0]!;
      yield* browser.close(tab("first"));
      yield* Effect.promise(() => vi.advanceTimersByTimeAsync(60_000));
      yield* Effect.promise(() => vi.waitFor(() => expect(firstContext.closeCalls).toBe(1)));

      const firstAcquire = yield* browser.ensureTab(tab("replacement-a")).pipe(Effect.forkScoped);
      const secondAcquire = yield* browser.ensureTab(tab("replacement-b")).pipe(Effect.forkScoped);
      yield* Effect.promise(() => vi.advanceTimersByTimeAsync(0));
      expect(harness.contexts).toHaveLength(1);
      firstContext.resolveClose();
      yield* Effect.all([Fiber.join(firstAcquire), Fiber.join(secondAcquire)], { discard: true });
      expect(harness.contexts).toHaveLength(2);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("relaunches cleanly after unexpected context closure", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const browser = yield* ServerBrowserManager;
      yield* browser.ensureTab(tab("first"));
      yield* Effect.promise(() => harness.contexts[0]!.closeUnexpectedly());
      yield* browser.ensureTab(tab("second"));
      expect(harness.contexts).toHaveLength(2);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("clears cache without cookies and still shuts down when cache clearing fails", () => {
    vi.useFakeTimers();
    const harness = makeHarness();
    harness.configureNextContext((context) => {
      context.failCacheClear = true;
    });
    return Effect.gen(function* () {
      const browser = yield* ServerBrowserManager;
      yield* browser.ensureTab(tab("cache"));
      const context = harness.contexts[0]!;
      yield* browser.close(tab("cache"));
      yield* Effect.promise(() => vi.advanceTimersByTimeAsync(60_000));
      yield* Effect.promise(() => vi.waitFor(() => expect(context.closeCalls).toBe(1)));
      expect(context.clearCookiesCalls).toBe(0);
      expect(context.createdCdps.flatMap((cdp) => cdp.commands)).toContain(
        "Network.clearBrowserCache",
      );
    }).pipe(Effect.provide(harness.layer));
  });
});
