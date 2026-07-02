import { performance } from "node:perf_hooks";
import { setAggregationInvalidationListener } from "./aggregationCache.js";
import { chileCalendarAddDays, chileCalendarTodayYmd, dateAtTimeZoneWallClock } from "./chileDate.js";
import { buildDashboardPageBundle } from "./dashboardPageBundle.js";
import { db } from "./db.js";

/**
 * Proactive dashboard cache warmer: rebuilds the page-bundle aggregation caches in the
 * background so interactive requests never pay a cold build.
 *
 * Triggers:
 * - server boot;
 * - just after Chile midnight (the aggregation cache clears on day rollover because entries
 *   bake in "today" — the warm build performs that clear + rebuild instead of the first
 *   morning request);
 * - `PRAGMA data_version` change (another process wrote the DB, e.g. a CLI import — the
 *   aggregation cache would clear on next read; polled every minute);
 * - debounced in-process invalidations (panel edits / HTTP imports), so caches are warm
 *   again shortly after a write burst finishes.
 *
 * Env: `CACHE_WARM_ENABLED=0` disables (default on).
 */

const BOOT_DELAY_MS = 2_000;
const INVALIDATION_DEBOUNCE_MS = 30_000;
const DATA_VERSION_POLL_MS = 60_000;
/** Warm at 00:05 Chile — clear of midnight and of the 23:55 crypto-EOD sync window. */
const MIDNIGHT_WARM_MINUTE = 5;

let started = false;
let warming = false;
let rewarmQueued = false;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let midnightTimer: ReturnType<typeof setTimeout> | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let lastWarmedDataVersion: number | null = null;

function currentDataVersion(): number {
  return db.pragma("data_version", { simple: true }) as number;
}

async function runWarm(reason: string): Promise<void> {
  if (warming) {
    rewarmQueued = true;
    return;
  }
  warming = true;
  try {
    const t0 = performance.now();
    await buildDashboardPageBundle("clp");
    await buildDashboardPageBundle("usd");
    lastWarmedDataVersion = currentDataVersion();
    console.log(`cache-warm: dashboard caches warmed (${reason}) in ${(performance.now() - t0).toFixed(0)}ms`);
  } catch (e) {
    console.error(`cache-warm: failed (${reason}) — ${e instanceof Error ? e.message : e}`);
  } finally {
    warming = false;
    if (rewarmQueued) {
      rewarmQueued = false;
      scheduleWarm("rewarm-after-queued-invalidation");
    }
  }
}

/** Debounced: repeated invalidations (e.g. a merge import) coalesce into one rebuild. */
function scheduleWarm(reason: string, delayMs = INVALIDATION_DEBOUNCE_MS): void {
  if (debounceTimer != null) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void runWarm(reason);
  }, delayMs);
  debounceTimer.unref?.();
}

function scheduleMidnightWarm(): void {
  const tomorrow = chileCalendarAddDays(chileCalendarTodayYmd(), 1);
  const at = dateAtTimeZoneWallClock(tomorrow, 0, MIDNIGHT_WARM_MINUTE, "America/Santiago");
  const delayMs = Math.max(60_000, at.getTime() - Date.now());
  midnightTimer = setTimeout(() => {
    void runWarm("chile-day-rollover").finally(() => scheduleMidnightWarm());
  }, delayMs);
  midnightTimer.unref?.();
}

export function startDashboardCacheWarmer(): void {
  if (process.env.CACHE_WARM_ENABLED === "0") {
    console.log("cache-warm: disabled (CACHE_WARM_ENABLED=0)");
    return;
  }
  if (started) return;
  started = true;

  setAggregationInvalidationListener(() => scheduleWarm("invalidation"));
  scheduleMidnightWarm();
  pollTimer = setInterval(() => {
    if (warming || debounceTimer != null) return;
    if (lastWarmedDataVersion != null && currentDataVersion() !== lastWarmedDataVersion) {
      scheduleWarm("external-write", 5_000);
    }
  }, DATA_VERSION_POLL_MS);
  pollTimer.unref?.();

  scheduleWarm("boot", BOOT_DELAY_MS);
}

export function stopDashboardCacheWarmer(): void {
  setAggregationInvalidationListener(null);
  if (debounceTimer != null) clearTimeout(debounceTimer);
  if (midnightTimer != null) clearTimeout(midnightTimer);
  if (pollTimer != null) clearInterval(pollTimer);
  debounceTimer = null;
  midnightTimer = null;
  pollTimer = null;
  started = false;
}
