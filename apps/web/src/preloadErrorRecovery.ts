const RELOAD_MARKER_KEY = "t3code.vite-preload-reload";

type VitePreloadErrorEvent = Event & { readonly payload?: unknown };

function preloadErrorSignal(event: VitePreloadErrorEvent): string {
  return event.payload instanceof Error ? event.payload.message : "unknown-preload-error";
}

export function installPreloadErrorRecovery({
  target = window,
  storage = window.sessionStorage,
  reload = () => window.location.reload(),
}: {
  readonly target?: Pick<Window, "addEventListener">;
  readonly storage?: Pick<Storage, "getItem" | "setItem">;
  readonly reload?: () => void;
} = {}): void {
  target.addEventListener("vite:preloadError", (rawEvent) => {
    const event = rawEvent as VitePreloadErrorEvent;
    const signal = preloadErrorSignal(event);

    // An open tab can retain an old lazy-chunk URL across an atomic deploy.
    // Reload once for that URL so the browser picks up the current index and
    // manifest. Let a repeated failure reach the route error boundary instead
    // of trapping the user in a reload loop.
    if (storage.getItem(RELOAD_MARKER_KEY) === signal) return;

    storage.setItem(RELOAD_MARKER_KEY, signal);
    event.preventDefault();
    reload();
  });
}
