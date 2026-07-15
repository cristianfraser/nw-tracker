/**
 * Polls Yahoo equities/crypto + CLP=X (NYSE session) or mirrors Yahoo EOD `fx_daily` after close. HTTP reads DB only.
 *
 * Env: `LIVE_QUOTES_SYNC_ENABLED`, `LIVE_QUOTES_INTERVAL_MS` (default 5 min).
 */
import { loadRootDotenv } from "./rootDotenv.js";
import { liveQuotesIntervalMs, liveQuotesSyncEnabled } from "./liveMarketQuotesConfig.js";
import { syncAllLiveMarketQuotes } from "./liveMarketQuotesSync.js";
import { ensureWatchlistEquityHistoryDepth } from "./watchlist.js";

let inFlight = false;
let intervalHandle: ReturnType<typeof setInterval> | null = null;
let schedulerEnabled = false;
let intervalMs = 5 * 60 * 1000;
let nextTickAtMs: number | null = null;

export type LiveMarketQuotesSchedulerSnapshot = {
  enabled: boolean;
  interval_ms: number;
  in_flight: boolean;
  next_tick_at: string | null;
};

export function getLiveMarketQuotesSchedulerSnapshot(): LiveMarketQuotesSchedulerSnapshot {
  return {
    enabled: schedulerEnabled,
    interval_ms: intervalMs,
    in_flight: inFlight,
    next_tick_at:
      nextTickAtMs != null && Number.isFinite(nextTickAtMs)
        ? new Date(nextTickAtMs).toISOString()
        : null,
  };
}

async function schedulerTick(): Promise<void> {
  if (inFlight) {
    console.log("live-quotes:scheduler — skip (previous run still in progress).");
    return;
  }
  inFlight = true;
  try {
    loadRootDotenv();
    await syncAllLiveMarketQuotes();
  } catch (e) {
    console.error(`live-quotes:scheduler — error: ${e instanceof Error ? e.message : e}`);
  }
  try {
    // Watchlist YTD/YoY history depth (~400d Yahoo backfill for new/shallow tickers).
    // Lives on the scheduler so GET /api/watchlist stays DB-only; separate catch so a
    // history failure never masks a quotes failure (or vice versa).
    const backfilled = await ensureWatchlistEquityHistoryDepth();
    if (backfilled > 0) {
      console.log(`live-quotes:scheduler — watchlist history backfilled for ${backfilled} ticker(s)`);
    }
  } catch (e) {
    console.error(
      `live-quotes:scheduler — watchlist history backfill error: ${e instanceof Error ? e.message : e}`
    );
  } finally {
    inFlight = false;
    if (schedulerEnabled) {
      nextTickAtMs = Date.now() + intervalMs;
    }
  }
}

export function startLiveMarketQuotesScheduler(): void {
  schedulerEnabled = liveQuotesSyncEnabled();
  if (!schedulerEnabled) {
    console.log("live-quotes:scheduler — disabled (LIVE_QUOTES_SYNC_ENABLED=0).");
    nextTickAtMs = null;
    return;
  }
  intervalMs = liveQuotesIntervalMs();
  console.log(
    `live-quotes:scheduler — enabled; polling every ${Math.round(intervalMs / 1000)}s`
  );
  void schedulerTick();
  intervalHandle = setInterval(() => {
    void schedulerTick();
  }, intervalMs);
  nextTickAtMs = Date.now() + intervalMs;
}

export function stopLiveMarketQuotesScheduler(): void {
  if (intervalHandle != null) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
  schedulerEnabled = false;
  nextTickAtMs = null;
}
