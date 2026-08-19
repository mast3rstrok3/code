import { describe, expect, it } from "@effect/vitest";

import * as DomRecorder from "./DomRecorder.ts";

const RECORD_SCRIPT = "window.rrwebRecord = () => () => {};";

/** Captures what the recorder installs, and lets a test play the page's part. */
const fakePage = (coverage: unknown = 0) => {
  const initScripts: string[] = [];
  const evaluated: string[] = [];
  let binding: ((source: unknown, payload: unknown) => unknown) | null = null;
  return {
    initScripts,
    evaluated,
    emit: (events: ReadonlyArray<unknown>) => binding?.(null, events),
    page: {
      exposeBinding: async (
        name: string,
        callback: (source: unknown, payload: unknown) => unknown,
      ) => {
        expect(name).toBe(DomRecorder.DOM_RECORDER_BINDING);
        binding = callback;
      },
      addInitScript: async (script: { readonly content: string }) => {
        initScripts.push(script.content);
      },
      evaluate: async <T>(expression: string) => {
        evaluated.push(expression);
        return (expression === DomRecorder.PIXEL_COVERAGE_PROBE ? coverage : undefined) as T;
      },
    } satisfies DomRecorder.DomRecorderPage,
  };
};

const fakeSink = () => {
  const lines: string[] = [];
  let closed = false;
  return {
    lines,
    isClosed: () => closed,
    sink: {
      write: async (line: string) => {
        lines.push(line);
      },
      close: async () => {
        closed = true;
      },
    } satisfies DomRecorder.DomRecordingSink,
  };
};

describe("buildBootstrapScript", () => {
  it("inlines the recorder and shadows the module globals the UMD wrapper prefers", () => {
    const script = DomRecorder.buildBootstrapScript(RECORD_SCRIPT);
    expect(script).toContain(RECORD_SCRIPT);
    expect(script).toContain(DomRecorder.DOM_RECORDER_BINDING);
    expect(script).toContain("var module = undefined, exports = undefined, define = undefined;");
  });

  it("guards against installing twice in one document", () => {
    expect(DomRecorder.buildBootstrapScript(RECORD_SCRIPT)).toContain("__t3DomRecorderInstalled");
  });

  it("skips the blank documents Playwright creates for its own machinery", () => {
    // A recorder started there reports a 0x0 about:blank page into the same binding.
    expect(DomRecorder.buildBootstrapScript(RECORD_SCRIPT)).toContain(
      'location.href === "about:blank"',
    );
  });

  it("unwraps the namespace the UMD build exports instead of a bare function", () => {
    expect(DomRecorder.buildBootstrapScript(RECORD_SCRIPT)).toContain("namespace.record");
  });
});

describe("loadRrwebRecordScript", () => {
  it("reads the self-contained UMD build rrweb does not publish in its exports map", async () => {
    const script = await DomRecorder.loadRrwebRecordScript();

    expect(script).toContain("rrwebRecord");
    expect(script.length).toBeGreaterThan(50_000);
    // A split bundle would need its sibling chunks injected too.
    expect(script).not.toMatch(/require\("\.\//);
  });
});

describe("pixelCoverageRejectsDomRecording", () => {
  it("rejects a page that is mostly canvas or video", () => {
    expect(DomRecorder.pixelCoverageRejectsDomRecording(0.9)).toBe(true);
  });

  it("accepts an ordinary page, and anything it could not measure", () => {
    expect(DomRecorder.pixelCoverageRejectsDomRecording(0.1)).toBe(false);
    expect(DomRecorder.pixelCoverageRejectsDomRecording(null)).toBe(false);
    expect(DomRecorder.pixelCoverageRejectsDomRecording(Number.NaN)).toBe(false);
    expect(DomRecorder.pixelCoverageRejectsDomRecording("0.9")).toBe(false);
  });
});

describe("startDomRecording", () => {
  it("refuses a page rrweb would replay as empty boxes", async () => {
    const page = fakePage(0.85);
    const sink = fakeSink();

    await expect(
      DomRecorder.startDomRecording({
        page: page.page,
        sink: sink.sink,
        recordScript: RECORD_SCRIPT,
      }),
    ).rejects.toThrow(/canvas or video/);
    expect(page.initScripts).toHaveLength(0);
  });

  it("arms the current document and every later navigation", async () => {
    const page = fakePage();
    const sink = fakeSink();
    await DomRecorder.startDomRecording({
      page: page.page,
      sink: sink.sink,
      recordScript: RECORD_SCRIPT,
    });

    expect(page.initScripts).toHaveLength(1);
    expect(page.evaluated[0]).toBe(DomRecorder.PIXEL_COVERAGE_PROBE);
    expect(page.evaluated[1]).toContain(RECORD_SCRIPT);
  });

  it("writes one line per event and counts what it wrote", async () => {
    const page = fakePage();
    const sink = fakeSink();
    const handle = await DomRecorder.startDomRecording({
      page: page.page,
      sink: sink.sink,
      recordScript: RECORD_SCRIPT,
    });

    const reply = await page.emit([{ type: 2, data: { href: "/" } }, { type: 3 }]);

    expect(reply).toEqual({ stop: false });
    expect(sink.lines).toEqual(['{"type":2,"data":{"href":"/"}}\n', '{"type":3}\n']);
    expect(handle.eventCount()).toBe(2);
    expect(handle.byteCount()).toBe(sink.lines.join("").length);
  });

  it("retires the page recorder once the recording has stopped", async () => {
    const page = fakePage();
    const sink = fakeSink();
    const handle = await DomRecorder.startDomRecording({
      page: page.page,
      sink: sink.sink,
      recordScript: RECORD_SCRIPT,
    });

    await handle.stop();

    // The final drain asks the page for whatever it still holds.
    expect(page.evaluated.at(-1)).toContain("__t3DomRecorderFlush");
    expect(sink.isClosed()).toBe(true);
    // A stale init script in a reused tab must not keep feeding a closed sink.
    expect(await page.emit([{ type: 3 }])).toEqual({ stop: true });
    expect(sink.lines).toHaveLength(0);
  });

  it("abandons the artifact without waiting on a page that may be gone", async () => {
    const page = fakePage();
    const sink = fakeSink();
    const handle = await DomRecorder.startDomRecording({
      page: page.page,
      sink: sink.sink,
      recordScript: RECORD_SCRIPT,
    });
    const evaluatedBeforeAbort = page.evaluated.length;

    await handle.abort();

    expect(page.evaluated).toHaveLength(evaluatedBeforeAbort);
    expect(sink.isClosed()).toBe(true);
    expect(await page.emit([{ type: 3 }])).toEqual({ stop: true });
  });
});
