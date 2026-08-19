// @effect-diagnostics nodeBuiltinImport:off - Resolving rrweb's UMD build needs Node module resolution and its sibling path.
/**
 * DomRecorder - rrweb DOM recording for the preview browser.
 *
 * A screencast recording costs a realtime video encoder per review. rrweb instead
 * serializes DOM mutations and input in the page, so the artifact is a JSON event
 * log and the server spawns nothing. The trade is fidelity: rrweb records the DOM,
 * not pixels, so canvas and WebGL replay blank. `ServerBrowserManager` picks the
 * recorder and falls back to the encoder when this one cannot attach.
 *
 * Injection is deliberately lazy. These tabs are also the general in-app browser,
 * and nothing is evaluated in a page until a review actually starts recording.
 */
import * as NodeModule from "node:module";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

/** Page-side entry point installed by the bootstrap script. */
export const DOM_RECORDER_BINDING = "__t3DomRecorderEmit";

/** How long the page buffers events between binding calls. */
export const DOM_RECORDER_FLUSH_INTERVAL_MS = 1_000;

export interface DomRecorderPage {
  readonly exposeBinding: (
    name: string,
    callback: (source: unknown, payload: unknown) => unknown,
  ) => Promise<void>;
  readonly addInitScript: (script: { readonly content: string }) => Promise<void>;
  readonly evaluate: <T>(expression: string) => Promise<T>;
}

/**
 * Reply to a page flush. `stop` retires the recorder in pages whose review has
 * already finished, so a stale init script cannot keep recording a reused tab.
 */
interface FlushReply {
  readonly stop: boolean;
}

/**
 * rrweb publishes only its module entry, so the self-contained UMD build is
 * unreachable by specifier. Resolving the package and reading its sibling keeps
 * this working in dev and in the packed bundle, both of which load dependencies
 * from node_modules.
 */
let cachedRecordScript: string | null = null;

export const loadRrwebRecordScript = async (): Promise<string> => {
  if (cachedRecordScript !== null) return cachedRecordScript;
  const require = NodeModule.createRequire(import.meta.url);
  const umdPath = NodePath.join(
    NodePath.dirname(require.resolve("@rrweb/record")),
    "record.umd.min.cjs",
  );
  cachedRecordScript = await NodeFSP.readFile(umdPath, "utf8");
  return cachedRecordScript;
};

/**
 * The page half of the recorder: start rrweb once per document, batch events, and
 * hand them to the server on an interval. The UMD wrapper prefers CommonJS when a
 * page happens to define `module`, so the shadowing IIFE forces the global branch.
 */
export const buildBootstrapScript = (recordScript: string): string => `
(() => {
  if (window.__t3DomRecorderInstalled) return;
  // Playwright runs init scripts in the blank documents it creates for its own
  // machinery. A recorder started there reports a 0x0 about:blank page into the
  // same binding, so skip anything that is not the page under review.
  if (location.href === "about:blank" || !window.innerWidth || !window.innerHeight) return;
  window.__t3DomRecorderInstalled = true;

  (function () {
    var module = undefined, exports = undefined, define = undefined;
    ${recordScript}
  }).call(window);

  // The UMD build exports a namespace, not the function itself.
  const namespace = window.rrwebRecord;
  const record = typeof namespace === "function" ? namespace : namespace && namespace.record;
  if (typeof record !== "function") return;

  let buffer = [];
  let stopped = false;
  let flushing = false;

  const flush = async () => {
    if (flushing || buffer.length === 0) return;
    flushing = true;
    const batch = buffer;
    buffer = [];
    try {
      const reply = await window.${DOM_RECORDER_BINDING}(batch);
      if (reply && reply.stop) {
        stopped = true;
        if (typeof stopRecording === "function") stopRecording();
        clearInterval(timer);
      }
    } catch {
      // The binding is gone; the tab is closing or the recording was torn down.
      stopped = true;
      clearInterval(timer);
    } finally {
      flushing = false;
    }
  };

  const stopRecording = record({
    emit: (event) => {
      if (stopped) return;
      buffer.push(event);
    },
  });

  const timer = setInterval(flush, ${DOM_RECORDER_FLUSH_INTERVAL_MS});
  window.__t3DomRecorderFlush = flush;
  window.addEventListener("pagehide", () => {
    void flush();
  });
})();
`;

/**
 * Share of the viewport covered by canvas or video above which rrweb is the wrong
 * recorder. It captures the DOM, so those elements replay as empty boxes with no
 * error anywhere, which is worse than a heavier but correct video.
 */
export const DOM_RECORDER_MAX_PIXEL_COVERAGE = 0.4;

/**
 * Measures how much of the viewport pixel-only elements occupy. This samples the
 * page as it is when recording starts, so a canvas the reviewer opens later still
 * slips through; pin `previewRecordingMode` to `video` for apps built that way.
 */
export const PIXEL_COVERAGE_PROBE = `(() => {
  const viewport = window.innerWidth * window.innerHeight;
  if (!viewport) return 0;
  let covered = 0;
  for (const element of document.querySelectorAll("canvas,video")) {
    const rect = element.getBoundingClientRect();
    const width = Math.max(0, Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0));
    const height = Math.max(0, Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0));
    covered += width * height;
  }
  return covered / viewport;
})()`;

/** An unreadable probe result must not veto recording, so only a clear reading vetoes. */
export const pixelCoverageRejectsDomRecording = (coverage: unknown): boolean =>
  typeof coverage === "number" &&
  Number.isFinite(coverage) &&
  coverage > DOM_RECORDER_MAX_PIXEL_COVERAGE;

export interface DomRecordingHandle {
  /** Bytes appended to the event log so far. */
  readonly byteCount: () => number;
  /** Events appended so far. Zero at stop means the page never reported anything. */
  readonly eventCount: () => number;
  /** Ask the page for one last batch, then stop accepting events. */
  readonly stop: () => Promise<void>;
  /** Drop the recording without waiting on the page. */
  readonly abort: () => Promise<void>;
}

export interface DomRecordingSink {
  readonly write: (line: string) => Promise<void>;
  readonly close: () => Promise<void>;
}

/**
 * Attach a recorder to `page`, appending one JSON event per line to `sink`.
 *
 * The binding stays installed for the life of the page. Once this recording ends,
 * every later flush is answered with `stop`, which retires the page-side recorder.
 */
export const startDomRecording = async (input: {
  readonly page: DomRecorderPage;
  readonly sink: DomRecordingSink;
  readonly recordScript: string;
}): Promise<DomRecordingHandle> => {
  let active = true;
  let bytes = 0;
  let events = 0;

  const appendBatch = async (payload: unknown): Promise<FlushReply> => {
    if (!active) return { stop: true };
    if (!Array.isArray(payload)) return { stop: false };
    for (const event of payload) {
      const line = `${JSON.stringify(event)}\n`;
      bytes += Buffer.byteLength(line);
      events += 1;
      await input.sink.write(line);
    }
    return { stop: false };
  };

  const coverage = await input.page.evaluate<unknown>(PIXEL_COVERAGE_PROBE).catch(() => null);
  if (pixelCoverageRejectsDomRecording(coverage)) {
    throw new Error("The page under review is mostly canvas or video, which rrweb cannot replay.");
  }

  const bootstrap = buildBootstrapScript(input.recordScript);
  await input.page.exposeBinding(DOM_RECORDER_BINDING, (_source, payload) => appendBatch(payload));
  // Re-arm across navigations, then start on the document already loaded.
  await input.page.addInitScript({ content: bootstrap });
  await input.page.evaluate(bootstrap);

  const drain = async () => {
    try {
      await input.page.evaluate(
        "window.__t3DomRecorderFlush ? window.__t3DomRecorderFlush() : undefined",
      );
    } catch {
      // The page is gone. Whatever it already flushed is what the artifact holds.
    }
  };

  return {
    byteCount: () => bytes,
    eventCount: () => events,
    stop: async () => {
      await drain();
      active = false;
      await input.sink.close();
    },
    abort: async () => {
      active = false;
      await input.sink.close();
    },
  };
};
