/**
 * Polls Yahoo equities/crypto + CLP=X (while the fx day is open, `forexDay.ts`) or mirrors the
 * stored `fx_daily` close after it ends. HTTP reads DB only. Three jobs on the scheduler kernel
 * (`schedulerKernel.ts`):
 *
 * - **The poll.** Since 2026-11-04 Yahoo's price stream (`yahooPriceStream.ts`, started here)
 *   carries the live prices while it is connected: a poll fetches only the symbols the stream does
 *   not cover now (a closed market, a quiet symbol, a dead socket), and keeps the base cadence in
 *   session. Polls are on the wall clock, with one right after each market open (2026-10-27,
 *   `nextLiveQuotesTickAtMs`): a fixed `setInterval` from boot left up to five minutes of each
 *   session's start on yesterday's close. The first poll after a wake waits for the network, and
 *   a poll where no Yahoo request succeeded retries after 15 s then 45 s (2026-09-15; the budget
 *   refills on a success, a thrown sync — a bug, not the network — never retries).
 * - **The watchlist history depth** (~400 days of Yahoo history for new or shallow tickers), so
 *   `GET /api/watchlist` stays DB-only; on the poll's base cadence.
 * - **The sync dimming check** (`syncDimmingWatch.ts`): the dashboard's dimming turns with the
 *   clock (a publish hour), so it is looked at on the session cadence.
 *
 * Env (`config.ts`): `LIVE_QUOTES_SYNC_ENABLED`, `LIVE_QUOTES_INTERVAL_MS` (default 5 min),
 * `LIVE_QUOTES_SESSION_INTERVAL_MS` (default 2 min, while a priced market is open).
 */
import { demoMarketAwake, onDemoMarketWake } from "./demoMarketActivity.js";
import { checkSyncDimmingChanged } from "./syncDimmingWatch.js";
import { loadRootDotenv } from "./rootDotenv.js";
import { liveQuotesIntervalMs, liveQuotesSessionIntervalMs, liveQuotesSyncEnabled } from "./liveMarketQuotesConfig.js";
import { syncAllLiveMarketQuotes } from "./liveMarketQuotesSync.js";
import { equityMarketKind, isSantiagoRegularSessionOpen } from "./equityQuote.js";
import { isNyseRegularSessionOpen } from "./nyseSession.js";
import { nextLiveQuotesTickAtMs, tickFailedWholesale } from "./liveMarketQuotesSchedulerPolicy.js";
import { ScheduledJob, atStartThen, nextAlignedMs, type ScheduledJobSpec } from "./schedulerKernel.js";
import { ensureWatchlistEquityHistoryDepth, listWatchlistEquitySeriesKeys } from "./watchlist.js";
import { liveStreamConnected, liveStreamCoverage, startYahooPriceStream } from "./yahooPriceStream.js";

/** After a resume, how long to give the network before the first fetch. */
export const LIVE_QUOTES_RESUME_NETWORK_WAIT_MS = 10_000;

/** Retry delays after a wholesale failure — the budget refills only when a poll succeeds. */
export const LIVE_QUOTES_RETRY_DELAYS_MS: readonly number[] = [15_000, 45_000];

/**
 * Whether a market the poll prices is in its regular session at an instant. The markets are
 * read from the watchlist at each scheduling (a ticker added during the day can bring one in);
 * crypto trades around the clock and keeps the base cadence.
 */
function pricedSessionOpenPredicate(): (at: Date) => boolean {
  const kinds = new Set(listWatchlistEquitySeriesKeys().map((t) => equityMarketKind(t)));
  return (at) =>
    (kinds.has("nyse") && isNyseRegularSessionOpen(at)) ||
    (kinds.has("santiago") && isSantiagoRegularSessionOpen(at));
}

/** The common gates of the three jobs: on with the live quotes, asleep with the demo. */
const gates: Pick<ScheduledJobSpec, "enabled" | "awake" | "onWake"> = {
  enabled: liveQuotesSyncEnabled,
  awake: () => demoMarketAwake(),
  onWake: (listener) => onDemoMarketWake(listener),
};

const pollJob = new ScheduledJob({
  ...gates,
  name: "live-quotes:scheduler",
  logSkips: true,
  next: atStartThen((nowMs) => {
    const intervalMs = liveQuotesIntervalMs();
    try {
      // With the stream up, the poll is only the backstop: no faster cadence in session.
      const sessionStep = liveStreamConnected() ? intervalMs : liveQuotesSessionIntervalMs();
      return nextLiveQuotesTickAtMs(nowMs, intervalMs, sessionStep, pricedSessionOpenPredicate());
    } catch (e) {
      // The watchlist read failing must not stop the poll: one interval later, the base cadence.
      console.error(`live-quotes:scheduler — next tick error: ${e instanceof Error ? e.message : e}`);
      return nowMs + intervalMs;
    }
  }),
  run: async () => {
    loadRootDotenv();
    // Symbols the price stream carries now are its own; the poll fetches the rest.
    const coverage = liveStreamCoverage();
    const result = await syncAllLiveMarketQuotes(new Date(), { skipTickers: coverage.tickers, skipLiveFx: coverage.fx });
    if (!tickFailedWholesale(result)) return "ok";
    console.warn("live-quotes:scheduler — no Yahoo request succeeded");
    return "failed";
  },
  // A poll an interval late or more followed a sleep.
  wake: () => ({ wakeGapMs: liveQuotesIntervalMs(), networkGraceMs: LIVE_QUOTES_RESUME_NETWORK_WAIT_MS }),
  retry: { delaysMs: LIVE_QUOTES_RETRY_DELAYS_MS, when: "always", retryThrown: false },
});

const watchlistHistoryJob = new ScheduledJob({
  ...gates,
  name: "live-quotes:watchlist-history",
  next: atStartThen((nowMs) => nextAlignedMs(nowMs, liveQuotesIntervalMs())),
  run: async () => {
    const backfilled = await ensureWatchlistEquityHistoryDepth();
    if (backfilled > 0) console.log(`live-quotes:scheduler — watchlist history backfilled for ${backfilled} ticker(s)`);
    return "ok";
  },
});

const syncDimmingJob = new ScheduledJob({
  ...gates,
  name: "live-quotes:sync-dimming",
  next: atStartThen((nowMs) => nextAlignedMs(nowMs, liveQuotesSessionIntervalMs())),
  run: async () => {
    checkSyncDimmingChanged();
    return "ok";
  },
});

export function startLiveMarketQuotesScheduler(): void {
  if (!pollJob.start()) {
    console.log("live-quotes:scheduler — disabled (LIVE_QUOTES_SYNC_ENABLED=0).");
    return;
  }
  console.log(
    `live-quotes:scheduler — enabled; polling every ${Math.round(liveQuotesIntervalMs() / 1000)}s, ` +
      `${Math.round(liveQuotesSessionIntervalMs() / 1000)}s while a priced market is open`
  );
  watchlistHistoryJob.start();
  syncDimmingJob.start();
  startYahooPriceStream();
}
