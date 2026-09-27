import { reloadApp } from "./reloadApp";

// A deploy can remove old chunks, and cached responses can be incomplete.
// Refresh assets before one reload. The guard prevents a persistent failure
// from looping and clears after a successful boot.
const CHUNK_RELOAD_GUARD_KEY = "t3code:chunk-load-reloaded";
// A previous plain reload did not repair cached chunks, so allow the new recovery once.
const CHUNK_RELOAD_GUARD_VALUE = "refresh-assets";

/**
 * Called from the `vite:preloadError` listener. Reloads at most once per
 * failure streak and returns whether it did, so the caller knows whether to
 * swallow the event or let the error surface through the normal paths.
 */
export function reloadOnceForChunkLoadError(
  getStorage: () => Storage = () => window.sessionStorage,
  reload: () => void = () => void reloadApp(),
): boolean {
  let alreadyReloaded: boolean;
  try {
    const storage = getStorage();
    alreadyReloaded = storage.getItem(CHUNK_RELOAD_GUARD_KEY) === CHUNK_RELOAD_GUARD_VALUE;
    if (!alreadyReloaded) storage.setItem(CHUNK_RELOAD_GUARD_KEY, CHUNK_RELOAD_GUARD_VALUE);
  } catch {
    // Without storage the guard cannot survive a reload, so a persistent
    // failure would loop forever. Let the error surface instead.
    return false;
  }
  if (alreadyReloaded) return false;
  reload();
  return true;
}

/** Clears the guard after a successful boot so a later stale deploy can reload again. */
export function clearChunkReloadGuard(getStorage: () => Storage = () => window.sessionStorage) {
  try {
    getStorage().removeItem(CHUNK_RELOAD_GUARD_KEY);
  } catch {
    // Blocked storage never held the flag.
  }
}
