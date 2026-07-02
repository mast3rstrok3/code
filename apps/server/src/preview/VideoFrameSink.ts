/**
 * VideoFrameSink - VFR→CFR pacing for CDP screencast frames piped into ffmpeg.
 *
 * CDP's `Page.screencastFrame` only emits when the page repaints, while ffmpeg's
 * image2pipe input treats every written frame as 1/fps seconds of video. To keep
 * the output clock aligned with wall time, each incoming frame first re-writes
 * the previous frame `max(1, round(fps * elapsedSeconds))` times — the same
 * technique Playwright's own VideoRecorder uses.
 */

export interface BuildFfmpegArgsInput {
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly outputPath: string;
}

/** vp8 requires even frame dimensions; round up to the nearest even pixel. */
export const evenDimension = (value: number): number => {
  const rounded = Math.max(2, Math.round(value));
  return rounded % 2 === 0 ? rounded : rounded + 1;
};

/**
 * Playwright's screencast-to-webm argument list: an MJPEG stream on stdin,
 * padded/cropped to a fixed canvas, encoded as realtime vp8.
 */
export const buildFfmpegArgs = (input: BuildFfmpegArgsInput): string[] => {
  const width = evenDimension(input.width);
  const height = evenDimension(input.height);
  return [
    "-loglevel",
    "error",
    "-f",
    "image2pipe",
    "-avioflags",
    "direct",
    "-fpsprobesize",
    "0",
    "-probesize",
    "32",
    "-analyzeduration",
    "0",
    "-c:v",
    "mjpeg",
    "-i",
    "pipe:0",
    "-y",
    "-an",
    "-r",
    String(input.fps),
    "-c:v",
    "vp8",
    "-qmin",
    "0",
    "-qmax",
    "50",
    "-crf",
    "8",
    "-deadline",
    "realtime",
    "-speed",
    "8",
    "-b:v",
    "1M",
    "-vf",
    `pad=${width}:${height}:0:0:gray,crop=${width}:${height}:0:0`,
    input.outputPath,
  ];
};

export interface VideoFrameSinkOptions {
  readonly fps: number;
  readonly write: (frame: Uint8Array) => void;
}

export interface VideoFrameSink {
  /** Queue a new frame captured at `timestampMs` (wall-clock milliseconds). */
  readonly pushFrame: (frame: Uint8Array, timestampMs: number) => void;
  /** Emit the held frame up to `timestampMs` and clear it. Call before closing stdin. */
  readonly flush: (timestampMs: number) => void;
  /** Total frames written to `write` so far. */
  readonly writtenFrameCount: () => number;
}

export const createVideoFrameSink = (options: VideoFrameSinkOptions): VideoFrameSink => {
  const { fps, write } = options;
  let heldFrame: Uint8Array | null = null;
  let heldFrameTimestampMs = 0;
  let writtenFrames = 0;

  const emitHeldFrame = (timestampMs: number) => {
    if (heldFrame === null) return;
    const elapsedSeconds = Math.max(0, timestampMs - heldFrameTimestampMs) / 1000;
    const repeatCount = Math.max(1, Math.round(fps * elapsedSeconds));
    for (let index = 0; index < repeatCount; index += 1) write(heldFrame);
    writtenFrames += repeatCount;
  };

  return {
    pushFrame: (frame, timestampMs) => {
      emitHeldFrame(timestampMs);
      heldFrame = frame;
      heldFrameTimestampMs = Math.max(timestampMs, heldFrameTimestampMs);
    },
    flush: (timestampMs) => {
      emitHeldFrame(timestampMs);
      heldFrame = null;
    },
    writtenFrameCount: () => writtenFrames,
  };
};
