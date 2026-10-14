const RELOAD_FLAG = 'overwatch_stale_asset_reload';

export function isChunkLoadError(error: unknown): boolean {
  const msg = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|ChunkLoadError|Unable to preload CSS/i.test(msg);
}

/**
 * Reload the page once to pick up a new build. A sessionStorage flag prevents
 * a reload loop if the assets are genuinely missing; it is cleared after a
 * stable load. Returns true if a reload was triggered.
 */
export function reloadOnceForStaleAssets(): boolean {
  try {
    if (sessionStorage.getItem(RELOAD_FLAG)) return false;
    sessionStorage.setItem(RELOAD_FLAG, '1');
  } catch {
    // Storage unavailable: cannot guard against loops, so do not auto-reload.
    return false;
  }
  window.location.reload();
  return true;
}

/** Clear the guard once the app has been up for a while, so a later update can reload again. */
export function armStaleAssetReload(): void {
  setTimeout(() => {
    try {
      sessionStorage.removeItem(RELOAD_FLAG);
    } catch {
      // ignore
    }
  }, 10_000);
}
