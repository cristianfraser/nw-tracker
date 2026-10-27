import { performance } from "node:perf_hooks";
import { setAggregationInvalidationListener } from "./aggregationCache.js";
import { chileCalendarAddDays, chileCalendarTodayYmd, dateAtTimeZoneWallClock } from "./chileDate.js";
import { buildDashboardPageBundle } from "./dashboardPageBundle.js";
import { db } from "./db.js";
import { buildFlowsOverviewPayload } from "./flowsOverview.js";
import { pruneMarkInputChanges } from "./markInputChanges.js";
import {
  pendingLiveQuotesChange,
  publishLiveQuotesStamp,
  setLiveQuotesStampPublishedByWarmer,
} from "./liveQuotesStamp.js";
import { warmRentabilidadDailySeries } from "./rentabilidadDailyWarm.js";

/**
 * Proactive dashboard cache warmer: rebuilds the page-bundle aggregation caches, then the
 * full-history daily series behind every Rentabilidad table (`rentabilidadDailyWarm.ts`), in the
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
 *   again shortly after a write burst finishes;
 * - a live-quote poll that moved a price, after `LIVE_TAIL_DELAY_MS` instead of the write
 *   debounce (polls are minutes apart, nothing to coalesce), and once warm the poll's change is
 *   published to the client (`liveQuotesStamp.ts`).
 *
 * Env: `CACHE_WARM_ENABLED=0` disables (default on).
 */

const BOOT_DELAY_MS = 2_000;
const INVALIDATION_DEBOUNCE_MS = 30_000;
const LIVE_TAIL_DELAY_MS = 2_000;
const DATA_VERSION_POLL_MS = 60_000;
/** Warm at 00:05 Chile — clear of midnight and of the 23:55 crypto-EOD sync window. */
const MIDNIGHT_WARM_MINUTE = 5;

let started = false;
let warming = false;
let rewarmQueued = false;
/** Delay for the queued rewarm: the shortest asked for while the warm ran. */
let rewarmQueuedDelayMs = INVALIDATION_DEBOUNCE_MS;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let midnightTimer: ReturnType<typeof setTimeout> | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let lastWarmedDataVersion: number | null = null;

function currentDataVersion(): number {
  return db.pragma("data_version", { simple: true }) as number;
}

async function runWarm(reason: string, delayMs = INVALIDATION_DEBOUNCE_MS): Promise<void> {
  if (warming) {
    rewarmQueued = true;
    rewarmQueuedDelayMs = Math.min(rewarmQueuedDelayMs, delayMs);
    return;
  }
  warming = true;
  const liveChange = pendingLiveQuotesChange();
  try {
    const t0 = performance.now();
    await buildDashboardPageBundle("clp");
    await buildDashboardPageBundle("usd");
    const tBundles = performance.now();
    // The bundles carry the live marks; the Rentabilidad series below are not worth the wait.
    publishLiveQuotesStamp(liveChange);
    // The home dashboard's flows section (Por cuota, month rows).
    buildFlowsOverviewPayload("clp", "split", null);
    buildFlowsOverviewPayload("usd", "split", null);
    const scopes = await warmRentabilidadDailySeries();
    lastWarmedDataVersion = currentDataVersion();
    console.log(
      `cache-warm: dashboard caches warmed (${reason}) in ${(tBundles - t0).toFixed(0)}ms; ` +
        `${scopes} Rentabilidad daily series in ${(performance.now() - tBundles).toFixed(0)}ms`
    );
  } catch (e) {
    console.error(`cache-warm: failed (${reason}) — ${e instanceof Error ? e.message : e}`);
  } finally {
    warming = false;
    if (rewarmQueued) {
      rewarmQueued = false;
      const delay = rewarmQueuedDelayMs;
      rewarmQueuedDelayMs = INVALIDATION_DEBOUNCE_MS;
      scheduleWarm("rewarm-after-queued-invalidation", delay);
    }
  }
}

/** Debounced: repeated invalidations (e.g. a merge import) coalesce into one rebuild. */
function scheduleWarm(reason: string, delayMs = INVALIDATION_DEBOUNCE_MS): void {
  if (debounceTimer != null) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void runWarm(reason, delayMs);
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

  // The mark-change log only needs to outlive the slowest reader's gap; older rows go.
  const pruned = pruneMarkInputChanges();
  if (pruned > 0) console.log(`cache-warm: pruned ${pruned} mark-input change rows older than 7 days`);
  setLiveQuotesStampPublishedByWarmer(true);
  setAggregationInvalidationListener((scope) =>
    scope === "live_tail"
      ? scheduleWarm("live-quotes", LIVE_TAIL_DELAY_MS)
      : scheduleWarm("invalidation")
  );
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

