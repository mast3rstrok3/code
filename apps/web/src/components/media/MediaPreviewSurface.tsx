import { DownloadIcon, ExternalLinkIcon, RefreshCwIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { cn } from "~/lib/utils";
import { Button } from "~/components/ui/button";

export type MediaPreviewSurfaceKind = "image" | "video";

export function mediaElementErrorMessage(kind: MediaPreviewSurfaceKind): string {
  return kind === "video" ? "Unable to load video preview." : "Unable to load image preview.";
}

function mediaDownloadName(name: string): string {
  const path = name.split(/[?#]/, 1)[0] ?? name;
  const pieces = path.split(/[\\/]/).filter(Boolean);
  return pieces[pieces.length - 1] ?? "preview";
}

function videoSourceType(name: string): string | undefined {
  const path = name.split(/[?#]/, 1)[0]?.toLowerCase() ?? "";
  if (path.endsWith(".webm")) return "video/webm";
  if (path.endsWith(".mp4")) return "video/mp4";
  return undefined;
}

function MediaPreviewFallback({
  name,
  url,
  errorMessage,
  onRetry,
}: {
  readonly name: string;
  readonly url: string | null;
  readonly errorMessage: string;
  readonly onRetry?: (() => void) | undefined;
}) {
  const downloadName = useMemo(() => mediaDownloadName(name), [name]);

  return (
    <div className="flex max-w-lg flex-col items-center gap-3 px-6 text-center text-xs leading-relaxed">
      <p className="text-destructive">{errorMessage}</p>
      <div className="flex flex-wrap items-center justify-center gap-2">
        {onRetry ? (
          <Button size="xs" variant="outline" onClick={onRetry}>
            <RefreshCwIcon className="size-3.5" />
            Retry
          </Button>
        ) : null}
        {url ? (
          <>
            <Button
              size="xs"
              variant="outline"
              render={<a href={url} target="_blank" rel="noreferrer" />}
            >
              <ExternalLinkIcon className="size-3.5" />
              Open raw
            </Button>
            <Button size="xs" variant="outline" render={<a href={url} download={downloadName} />}>
              <DownloadIcon className="size-3.5" />
              Download
            </Button>
          </>
        ) : null}
      </div>
    </div>
  );
}

export function MediaPreviewSurface({
  kind,
  name,
  url,
  errorMessage = null,
  onRetry,
  className,
  mediaClassName,
}: {
  readonly kind: MediaPreviewSurfaceKind;
  readonly name: string;
  readonly url: string | null;
  readonly errorMessage?: string | null | undefined;
  readonly onRetry?: (() => void) | undefined;
  readonly className?: string | undefined;
  readonly mediaClassName?: string | undefined;
}) {
  const [mediaLoadError, setMediaLoadError] = useState(false);

  useEffect(() => {
    setMediaLoadError(false);
  }, [kind, url]);

  const activeError = errorMessage ?? (mediaLoadError ? mediaElementErrorMessage(kind) : null);

  return (
    <div className={cn(className)}>
      {activeError ? (
        <MediaPreviewFallback name={name} url={url} errorMessage={activeError} onRetry={onRetry} />
      ) : kind === "image" ? (
        <img
          src={url ?? ""}
          alt={name}
          className={mediaClassName}
          onError={() => setMediaLoadError(true)}
        />
      ) : (
        <video
          controls
          preload="metadata"
          className={mediaClassName}
          onError={() => setMediaLoadError(true)}
        >
          <source src={url ?? ""} type={videoSourceType(name)} />
        </video>
      )}
    </div>
  );
}
