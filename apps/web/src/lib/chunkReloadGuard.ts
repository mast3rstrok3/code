import { reloadApp } from "./reloadApp";

// Deploys and desktop server swaps can invalidate lazy chunks, and cached responses can be
// incomplete. Refresh assets before one reload; the guard stops a persistent failure from looping.
const CHUNK_RELOAD_GUARD_KEY = "t3code:chunk-load-reloaded";
// A previous plain reload did not repair cached chunks, so allow the new recovery once.
const CHUNK_RELOAD_GUARD_VALUE = "refresh-assets";

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
    // Without storage, the reload guard cannot prevent an infinite loop.
    return false;
  }
  if (alreadyReloaded) return false;
  reload();
  return true;
}

export function clearChunkReloadGuard(getStorage: () => Storage = () => window.sessionStorage) {
  try {
    getStorage().removeItem(CHUNK_RELOAD_GUARD_KEY);
  } catch {}
}
