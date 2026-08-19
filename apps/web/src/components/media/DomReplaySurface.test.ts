import { describe, expect, it } from "vite-plus/test";

import { formatReplayTime, parseRrwebEventLog, recordedViewport } from "./DomReplaySurface";
import { isDomReplayRecording } from "./MediaPreviewSurface";

describe("parseRrwebEventLog", () => {
  it("reads one event per line and ignores blank lines", () => {
    const events = parseRrwebEventLog('{"type":4}\n\n{"type":3}\n');

    expect(events).toEqual([{ type: 4 }, { type: 3 }]);
  });

  it("keeps every complete event when a recording ends mid-line", () => {
    const events = parseRrwebEventLog('{"type":4}\n{"type":3}\n{"type":3,"data":{"so');

    expect(events).toEqual([{ type: 4 }, { type: 3 }]);
  });
});

describe("recordedViewport", () => {
  it("takes the size from the meta event", () => {
    expect(
      recordedViewport([{ type: 3 }, { type: 4, data: { width: 1280, height: 720 } }]),
    ).toEqual({ width: 1280, height: 720 });
  });

  it("reports nothing when the meta event is missing or unusable", () => {
    expect(recordedViewport([{ type: 3 }])).toBeNull();
    expect(recordedViewport([{ type: 4, data: { width: 0, height: 720 } }])).toBeNull();
  });
});

describe("formatReplayTime", () => {
  it("renders minutes and padded seconds", () => {
    expect(formatReplayTime(0)).toBe("0:00");
    expect(formatReplayTime(9_000)).toBe("0:09");
    expect(formatReplayTime(605_000)).toBe("10:05");
  });

  it("clamps a negative offset rather than rendering a negative clock", () => {
    expect(formatReplayTime(-1_000)).toBe("0:00");
  });
});

describe("isDomReplayRecording", () => {
  it("routes rrweb logs to the replayer and leaves video on the video element", () => {
    expect(isDomReplayRecording("application/x-rrweb+jsonl")).toBe(true);
    expect(isDomReplayRecording("video/webm")).toBe(false);
    expect(isDomReplayRecording(null)).toBe(false);
  });
});
