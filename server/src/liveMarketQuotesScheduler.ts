/**
 * Polls Yahoo equities/crypto + CLP=X (while the fx day is open, `forexDay.ts`) or mirrors the
 * stored `fx_daily` close after it ends. HTTP reads DB only.
 *
 * Env: `LIVE_QUOTES_SYNC_ENABLED`, `LIVE_QUOTES_INTERVAL_MS` (default 5 min).
 *
 * Wake and failure handling (2026-09-15): the first tick after the machine resumes waits for the
 * network, and a tick where no Yahoo request succeeded retries on a short, bounded schedule
 * instead of leaving yesterday's closes on screen for a whole interval — see
 * `liveMarketQuotesSchedulerPolicy.ts` for the decisions and the incident.
 */
import { loadRootDotenv } from "./rootDotenv.js";
import { liveQuotesIntervalMs, liveQuotesSyncEnabled } from "./liveMarketQuotesConfig.js";
import { syncAllLiveMarketQuotes, type LiveMarketQuotesSyncResult } from "./liveMarketQuotesSync.js";
import {
  RESUME_NETWORK_WAIT_MS,
  RETRY_DELAYS_MS,
  planAfterTick,
  resumedAfterSuspend,
  tickFailedWholesale,
} from "./liveMarketQuotesSchedulerPolicy.js";
import { ensureWatchlistEquityHistoryDepth } from "./watchlist.js";

let inFlight = false;
let schedulerEnabled = false;
let intervalMs = 5 * 60 * 1000;
let lastTickStartedAtMs: number | null = null;
let retryBudget = RETRY_DELAYS_MS.length;
let retryTimer: NodeJS.Timeout | null = null;

type TickTrigger = "boot" | "interval" | "retry";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cancelPendingRetry(): void {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
}

async function schedulerTick(trigger: TickTrigger): Promise<void> {
  if (inFlight) {
    console.log("live-quotes:scheduler — skip (previous run still in progress).");
    return;
  }
  inFlight = true;
  if (trigger === "retry") retryTimer = null;
  let result: LiveMarketQuotesSyncResult | null = null;
  try {
    const now = Date.now();
    if (trigger === "interval" && resumedAfterSuspend(lastTickStartedAtMs, now, intervalMs)) {
      const lateMin = Math.round((now - (lastTickStartedAtMs ?? now)) / 60_000);
      console.log(
        `live-quotes:scheduler — resumed ${lateMin} min after the last tick (sleep?); waiting ${RESUME_NETWORK_WAIT_MS / 1000}s for the network`
      );
      await sleep(RESUME_NETWORK_WAIT_MS);
    }
    lastTickStartedAtMs = Date.now();
    loadRootDotenv();
    result = await syncAllLiveMarketQuotes();
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
  }
  if (result == null) return; // a thrown sync is a bug, not the network — no retry storm on it
  const plan = planAfterTick(retryBudget, tickFailedWholesale(result));
  retryBudget = plan.budgetRemaining;
  if (plan.delayMs != null) {
    cancelPendingRetry();
    console.warn(
      `live-quotes:scheduler — no Yahoo request succeeded; retrying in ${plan.delayMs / 1000}s (${retryBudget} retry(ies) left until a tick succeeds)`
    );
    retryTimer = setTimeout(() => {
      void schedulerTick("retry");
    }, plan.delayMs);
    retryTimer.unref();
  } else if (!tickFailedWholesale(result)) {
    cancelPendingRetry();
  } else {
    console.warn("live-quotes:scheduler — no Yahoo request succeeded and the retry budget is spent; next attempt at the regular interval");
  }
}

export function startLiveMarketQuotesScheduler(): void {
  schedulerEnabled = liveQuotesSyncEnabled();
  if (!schedulerEnabled) {
    console.log("live-quotes:scheduler — disabled (LIVE_QUOTES_SYNC_ENABLED=0).");
    return;
  }
  intervalMs = liveQuotesIntervalMs();
  console.log(
    `live-quotes:scheduler — enabled; polling every ${Math.round(intervalMs / 1000)}s`
  );
  void schedulerTick("boot");
  setInterval(() => {
    void schedulerTick("interval");
  }, intervalMs);
}
