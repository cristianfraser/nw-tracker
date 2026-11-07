import { publishLiveInputChange } from "./cacheRegistry.js";
import { syncStatusPayload } from "./globalSyncStale.js";

/**
 * Drops the cached figures that read the dashboard's sync dimming (`noteSyncDimmingRead`) when the
 * dimmed set changes. The set turns with the clock — a source waiting on its publisher dims from
 * its publish hour (18:00 Chile), a publisher-lag verdict expires with its poll — so no write or
 * price tick marks the moment; its own job on the scheduler kernel checks it on the live quotes'
 * session cadence (`liveMarketQuotesScheduler.ts`, 2 minutes on the wall clock).
 * The first call only records the set: whatever was cached before it was built on the current one.
 */
let lastDimmed: string | null = null;

export function checkSyncDimmingChanged(): boolean {
  const dimmed = [...syncStatusPayload().stale_dimming].sort().join(",");
  const changed = lastDimmed != null && dimmed !== lastDimmed;
  lastDimmed = dimmed;
  // Drops what read the dimming; the stamp tells the browser, which refetches what read it.
  if (changed) publishLiveInputChange(new Date().toISOString(), { dimming: true });
  return changed;
}

/** Tests only. */
export function resetSyncDimmingWatchForTest(): void {
  lastDimmed = null;
}
