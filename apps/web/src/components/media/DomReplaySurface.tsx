/**
 * DomReplaySurface - plays back an App Review recorded with rrweb.
 *
 * The artifact is a JSON event log, not a video, so there is no `<video>` element
 * to hand the browser. rrweb rebuilds the recorded DOM inside its own iframe and
 * this component owns the surrounding chrome: fetch, scale to fit, play, scrub.
 *
 * `@rrweb/replay` is large and most reviews are never opened, so `AppReviewDocument`
 * loads this module lazily. Import it through `React.lazy`, never directly.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { PauseIcon, PlayIcon } from "lucide-react";

// This whole module is lazily imported, so rrweb's styles load lazily with it.
import "@rrweb/replay/dist/style.css";

import { cn } from "~/lib/utils";
import { Button } from "~/components/ui/button";

/** rrweb's Meta event carries the viewport the review was recorded at. */
const META_EVENT_TYPE = 4;

interface RecordedViewport {
  readonly width: number;
  readonly height: number;
}

export function parseRrwebEventLog(text: string): unknown[] {
  const events: unknown[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // A recording torn down mid-flush can end on a partial line. Everything
      // before it still replays, so keep what parsed instead of failing the view.
    }
  }
  return events;
}

export function recordedViewport(events: ReadonlyArray<unknown>): RecordedViewport | null {
  for (const event of events) {
    const candidate = event as { readonly type?: number; readonly data?: RecordedViewport };
    if (candidate.type !== META_EVENT_TYPE) continue;
    const { width, height } = candidate.data ?? {};
    if (typeof width === "number" && typeof height === "number" && width > 0 && height > 0) {
      return { width, height };
    }
  }
  return null;
}

export function formatReplayTime(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export default function DomReplaySurface({
  url,
  className,
}: {
  readonly url: string;
  readonly className?: string | undefined;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const replayerRef = useRef<{
    play: (offset?: number) => void;
    pause: () => void;
    destroy: () => void;
    getMetaData: () => { readonly totalTime: number };
    on: (event: string, handler: (payload: unknown) => void) => void;
  } | null>(null);

  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [totalTime, setTotalTime] = useState(0);
  const [viewport, setViewport] = useState<RecordedViewport | null>(null);
  const [scale, setScale] = useState(1);

  useEffect(() => {
    let disposed = false;
    const stage = stageRef.current;
    if (!stage) return;

    void (async () => {
      try {
        const [{ Replayer }, response] = await Promise.all([import("@rrweb/replay"), fetch(url)]);
        if (!response.ok) throw new Error(`Recording request failed (${response.status}).`);
        const events = parseRrwebEventLog(await response.text());
        if (disposed) return;
        // rrweb needs a first full snapshot plus something to apply to it.
        if (events.length < 2) throw new Error("This recording holds too few events to replay.");

        const replayer = new Replayer(events as never, { root: stage, speed: 1 });
        replayerRef.current = replayer as unknown as typeof replayerRef.current;
        replayer.on("ui-update-current-time", (payload: unknown) => {
          setCurrentTime((payload as { readonly payload?: number }).payload ?? 0);
        });
        replayer.on("finish", () => setPlaying(false));

        setViewport(recordedViewport(events));
        setTotalTime(replayer.getMetaData().totalTime);
        setReady(true);
      } catch (cause) {
        if (disposed) return;
        setError(cause instanceof Error ? cause.message : "Unable to load this recording.");
      }
    })();

    return () => {
      disposed = true;
      replayerRef.current?.destroy();
      replayerRef.current = null;
    };
  }, [url]);

  // rrweb rebuilds the page at its recorded size, so shrink it into whatever
  // width the review panel actually has rather than letting it overflow.
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !viewport) return;
    const observer = new ResizeObserver(([entry]) => {
      const available = entry?.contentRect.width ?? 0;
      if (available > 0) setScale(Math.min(1, available / viewport.width));
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, [viewport]);

  const toggle = useCallback(() => {
    const replayer = replayerRef.current;
    if (!replayer) return;
    if (playing) {
      replayer.pause();
      setPlaying(false);
    } else {
      replayer.play(currentTime);
      setPlaying(true);
    }
  }, [currentTime, playing]);

  const seek = useCallback((offset: number) => {
    const replayer = replayerRef.current;
    if (!replayer) return;
    setCurrentTime(offset);
    replayer.play(offset);
    setPlaying(true);
  }, []);

  if (error) {
    return (
      <div
        className={cn(
          "rounded-md border border-border px-3 py-4 text-sm text-destructive",
          className,
        )}
      >
        {error}
      </div>
    );
  }

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div
        ref={hostRef}
        className="overflow-hidden rounded-md border border-border bg-black"
        style={
          viewport ? { height: `${Math.round(viewport.height * scale)}px` } : { minHeight: "180px" }
        }
      >
        <div ref={stageRef} style={{ transform: `scale(${scale})`, transformOrigin: "top left" }} />
      </div>
      <div className="flex items-center gap-3">
        <Button size="xs" variant="outline" onClick={toggle} disabled={!ready}>
          {playing ? <PauseIcon className="size-3.5" /> : <PlayIcon className="size-3.5" />}
          {playing ? "Pause" : "Play"}
        </Button>
        <input
          type="range"
          min={0}
          max={totalTime}
          value={currentTime}
          disabled={!ready}
          onChange={(event) => seek(Number(event.target.value))}
          className="h-1 flex-1 accent-primary"
          aria-label="Recording position"
        />
        <span className="text-xs tabular-nums text-muted-foreground">
          {formatReplayTime(currentTime)} / {formatReplayTime(totalTime)}
        </span>
      </div>
    </div>
  );
}
