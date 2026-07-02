import { assert, describe, it } from "@effect/vitest";

import { buildFfmpegArgs, createVideoFrameSink, evenDimension } from "./VideoFrameSink.ts";

const frame = (byte: number): Uint8Array => Uint8Array.of(byte);

const collectingSink = (fps: number) => {
  const written: number[] = [];
  const sink = createVideoFrameSink({
    fps,
    write: (bytes) => {
      written.push(bytes[0]!);
    },
  });
  return { sink, written };
};

describe("VideoFrameSink", () => {
  describe("evenDimension", () => {
    it("rounds odd dimensions up to the next even pixel", () => {
      assert.strictEqual(evenDimension(1279.6), 1280);
      assert.strictEqual(evenDimension(801), 802);
      assert.strictEqual(evenDimension(800), 800);
      assert.strictEqual(evenDimension(0), 2);
    });
  });

  describe("buildFfmpegArgs", () => {
    it("builds an mjpeg-pipe to vp8 webm invocation with even dimensions", () => {
      const args = buildFfmpegArgs({
        width: 1281,
        height: 799.5,
        fps: 25,
        outputPath: "/tmp/out.webm",
      });

      assert.strictEqual(args.at(-1), "/tmp/out.webm");
      assert.include(args, "image2pipe");
      assert.include(args, "vp8");
      assert.include(args, "pipe:0");
      const rIndex = args.indexOf("-r");
      assert.strictEqual(args[rIndex + 1], "25");
      const vfIndex = args.indexOf("-vf");
      assert.strictEqual(args[vfIndex + 1], "pad=1282:800:0:0:gray,crop=1282:800:0:0");
    });
  });

  describe("createVideoFrameSink", () => {
    it("writes nothing until a second frame or flush provides the frame's duration", () => {
      const { sink, written } = collectingSink(25);
      sink.pushFrame(frame(1), 1_000);
      assert.deepStrictEqual(written, []);
    });

    it("re-writes the previous frame max(1, round(fps*elapsed)) times", () => {
      const { sink, written } = collectingSink(25);
      sink.pushFrame(frame(1), 1_000);
      // 1 second at 25fps: frame 1 repeats 25 times.
      sink.pushFrame(frame(2), 2_000);
      assert.strictEqual(written.length, 25);
      assert.isTrue(written.every((byte) => byte === 1));
      // 100ms: round(25 * 0.1) = 3 copies of frame 2.
      sink.pushFrame(frame(3), 2_100);
      assert.strictEqual(written.length, 28);
      assert.deepStrictEqual(written.slice(25), [2, 2, 2]);
    });

    it("writes a rapid frame at least once", () => {
      const { sink, written } = collectingSink(25);
      sink.pushFrame(frame(1), 1_000);
      sink.pushFrame(frame(2), 1_001);
      assert.deepStrictEqual(written, [1]);
    });

    it("flush emits the held frame for the remaining elapsed time and clears it", () => {
      const { sink, written } = collectingSink(10);
      sink.pushFrame(frame(1), 0);
      sink.flush(500);
      // 0.5s at 10fps: 5 copies.
      assert.deepStrictEqual(written, [1, 1, 1, 1, 1]);
      sink.flush(1_000);
      assert.strictEqual(written.length, 5);
      assert.strictEqual(sink.writtenFrameCount(), 5);
    });

    it("a single seeded frame flushed immediately still produces one frame", () => {
      const { sink, written } = collectingSink(25);
      sink.pushFrame(frame(7), 4_000);
      sink.flush(4_000);
      assert.deepStrictEqual(written, [7]);
    });

    it("clamps out-of-order timestamps instead of dropping frames", () => {
      const { sink, written } = collectingSink(25);
      sink.pushFrame(frame(1), 2_000);
      sink.pushFrame(frame(2), 1_000);
      assert.deepStrictEqual(written, [1]);
      sink.flush(2_040);
      assert.deepStrictEqual(written, [1, 2]);
    });
  });
});
