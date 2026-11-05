import { describe, expect, it, vi } from "vite-plus/test";

import { act, fakeTimers, render, stubGlobal } from "../../../test/render";
import DomReplaySurface from "./DomReplaySurface";

const replayer = vi.hoisted(() => ({ currentTime: 0, playOffsets: [] as number[] }));

// The real Replayer rebuilds the recorded page in an iframe; the test only
// needs the clock it reports.
vi.mock("@rrweb/replay", () => ({
  Replayer: class {
    on() {}
    play(offset = 0) {
      replayer.playOffsets.push(offset);
    }
    pause() {}
    destroy() {}
    getCurrentTime() {
      return replayer.currentTime;
    }
    getMetaData() {
      return { startTime: 0, endTime: 10_000, totalTime: 10_000 };
    }
  },
}));

function setup() {
  replayer.currentTime = 0;
  replayer.playOffsets.length = 0;
}

const recording = [
  { type: 4, data: { width: 800, height: 600, href: "about:blank" }, timestamp: 0 },
  { type: 2, data: {}, timestamp: 0 },
]
  .map((event) => JSON.stringify(event))
  .join("\n");

describe("DomReplaySurface", () => {
  it("moves the scrubber with playback and resumes where it paused", async () => {
    setup();
    using _fetch = stubGlobal("fetch", async () => new Response(recording));
    // The replay owns no links; nothing here navigates.
    await using screen = await render(<DomReplaySurface url="/recording.rrweb.jsonl" />, {
      router: false,
    });
    await expect.element(screen.getByRole("button", { name: "Play" })).toBeEnabled();
    using _timers = fakeTimers();
    const click = (name: string) =>
      act(() => (screen.getByRole("button", { name }).element() as HTMLButtonElement).click());

    await click("Play");
    replayer.currentTime = 5_000;
    await act(() => vi.advanceTimersByTime(1_000));
    await expect.element(screen.getByText("0:05 / 0:10")).toBeInTheDocument();

    replayer.currentTime = 6_000;
    await click("Pause");
    await click("Play");
    expect(replayer.playOffsets).toEqual([0, 6_000]);
  });
});
