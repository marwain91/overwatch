import { useEffect, useState } from 'react';
import { useWSStore } from '../stores/wsStore';

/**
 * Polling interval to use for a query that the WebSocket keeps fresh: off while
 * the socket is open and authenticated, the given fallback while it is not.
 * `liveMs` keeps a slow refetch going while live, for data that can change
 * without a Docker event (e.g. CLI edits).
 */
export function useWsAwareInterval(fallbackMs: number, liveMs?: number): number | false {
  const connected = useWSStore((s) => s.connected);
  return connected ? (liveMs ?? false) : fallbackMs;
}

function isWindowActive(): boolean {
  return document.visibilityState === 'visible' && document.hasFocus();
}

/** True while the tab is visible and the window has focus. */
export function useWindowActive(): boolean {
  const [active, setActive] = useState(isWindowActive);

  useEffect(() => {
    const update = () => setActive(isWindowActive());
    document.addEventListener('visibilitychange', update);
    window.addEventListener('focus', update);
    window.addEventListener('blur', update);
    return () => {
      document.removeEventListener('visibilitychange', update);
      window.removeEventListener('focus', update);
      window.removeEventListener('blur', update);
    };
  }, []);

  return active;
}
