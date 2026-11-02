/**
 * The home panels' last payload in localStorage («Flujos», «Próximos pagos», «Últimos gastos»), so
 * a reload paints the last numbers the browser saw instead of an empty or zero panel until the
 * server answers — as the card strip does with its nav snapshot (`dashboardNavSnapshotCache.ts`).
 * A per-browser convenience: an unreadable entry, or one whose shape the panel does not accept
 * (`isValid`), is ignored, never an error. Each panel versions its own key: bump it when the
 * stored shape changes.
 */
import { useEffect } from "react";

const PREFIX = "nw:panel-cache:";

export function readPanelCache<T>(key: string, isValid: (value: unknown) => value is T): T | null {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isValid(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writePanelCache(key: string, value: unknown): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // Storage full or blocked: the panel loads from the server next time.
  }
}

/**
 * What a panel shows: the live payload once it is here (and stored for the next visit), the
 * stored one until then. `cached` tells the panel it is showing the stored one.
 */
export function usePanelCache<T>(
  key: string,
  live: T | null | undefined,
  isValid: (value: unknown) => value is T
): { value: T | null; cached: boolean } {
  useEffect(() => {
    if (live != null) writePanelCache(key, live);
  }, [key, live]);
  if (live != null) return { value: live, cached: false };
  return { value: readPanelCache(key, isValid), cached: true };
}
