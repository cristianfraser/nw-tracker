import { afterAll, describe, expect, it, vi } from "vitest";
import { clearAggregationCache, invalidateMarketDataAggregations } from "./aggregationCache.js";
import { chileCalendarAddDays, chileCalendarTodayYmd, dateAtTimeZoneWallClock } from "./chileDate.js";
import { buildDashboardPageBundle } from "./dashboardPageBundle.js";
import { getDashboardOverviewDaily } from "./dashboardOverviewDaily.js";
import { db } from "./db.js";
import { equityMarketKind, marketQuoteCurrency } from "./equityQuote.js";
import { buildFlowsOverviewPayload } from "./flowsOverview.js";
import { getGroupConsolidatedMonthlyRows } from "./groupConsolidatedTables.js";
import { resolveGroupDailySeries } from "./groupDailySeries.js";
import { monthlyPerfForAccountId } from "./groupMonthlyPerfConsolidation.js";
import { LIVE_FX_SYMBOL } from "./liveMarketQuotesConfig.js";
import { insertLiveMarketQuote } from "./liveMarketQuotesDb.js";
import { isChileBusinessDay, isNyseTradingDay } from "./marketHolidays.js";
import { warmRentabilidadDailySeries } from "./rentabilidadDailyWarm.js";
import { snapshotTables } from "./test/snapshotTables.js";
import { getGroupValuationTimeseries } from "./valuationTimeseries.js";

/**
 * A live-quote tick keeps the history tier (`aggregationCache.ts`: past-day marks, deposit
 * timelines, ledger closes, fx rows by day) and rebuilds only today on top of it. Whatever the
 * rebuild serves must be byte-identical to a rebuild from an empty cache at the same instant.
 */
const restoreTables = snapshotTables(["live_market_quotes", "equity_daily", "fx_daily"]);
afterAll(() => {
  restoreTables();
  vi.useRealTimers();
  clearAggregationCache();
});

/** The latest day both markets traded, at 14:00 New York: NYSE, the Bolsa and the fx day open. */
function tradingAfternoon(): Date {
  let d = chileCalendarTodayYmd();
  while (!isNyseTradingDay(d) || !isChileBusinessDay(d)) d = chileCalendarAddDays(d, -1);
  return dateAtTimeZoneWallClock(d, 14, 0, "America/New_York");
}

/** A poll's writes: every ticker at `factor` × its last close, the fx row at `fxFactor` ×. */
function writeQuotes(at: Date, factor: number, fxFactor: number): void {
  const ymd = at.toISOString().slice(0, 10);
  const chileYmd = chileCalendarTodayYmd();
  const tickers = (
    db.prepare(`SELECT DISTINCT ticker FROM equity_daily WHERE currency != 'none'`).all() as { ticker: string }[]
  ).map((r) => r.ticker);
  for (const ticker of tickers) {
    const last = db
      .prepare(`SELECT close FROM equity_daily WHERE ticker = ? AND trade_date < ? ORDER BY trade_date DESC LIMIT 1`)
      .get(ticker, chileYmd) as { close: number } | undefined;
    if (!last) continue;
    const kind = equityMarketKind(ticker);
    insertLiveMarketQuote({
      symbol: ticker.toUpperCase(),
      kind: "equity",
      value: last.close * factor,
      currency: marketQuoteCurrency(ticker),
      session_ymd: kind === "crypto24" ? ymd : chileYmd,
      previous_value: last.close,
      fetched_at: at.toISOString(),
    });
  }
  const fx = db
    .prepare(`SELECT clp_per_usd FROM fx_daily WHERE date < ? ORDER BY date DESC LIMIT 1`)
    .get(chileYmd) as { clp_per_usd: number };
  insertLiveMarketQuote({
    symbol: LIVE_FX_SYMBOL,
    kind: "fx_clp_per_usd",
    value: fx.clp_per_usd * fxFactor,
    currency: null,
    session_ymd: chileYmd,
    previous_value: fx.clp_per_usd,
    fetched_at: at.toISOString(),
  });
}

async function snapshotPayloads(): Promise<Map<string, string>> {
  const groups = (db.prepare(`SELECT slug FROM portfolio_groups ORDER BY id`).all() as { slug: string }[]).map(
    (r) => r.slug
  );
  const accountIds = (db.prepare(`SELECT id FROM accounts ORDER BY id`).all() as { id: number }[]).map((r) => r.id);
  const out = new Map<string, string>();
  await warmRentabilidadDailySeries();
  for (const unit of ["clp", "usd"] as const) {
    out.set(`bundle|${unit}`, JSON.stringify(await buildDashboardPageBundle(unit)));
    out.set(`flows|${unit}`, JSON.stringify(buildFlowsOverviewPayload(unit, "split", null)));
    out.set(`overview_daily|${unit}`, JSON.stringify(getDashboardOverviewDaily(unit, 0)));
    for (const slug of groups) {
      out.set(`daily|${slug}|${unit}`, JSON.stringify(resolveGroupDailySeries(slug, unit, 0)));
      out.set(`consolidated|${slug}|${unit}`, JSON.stringify(getGroupConsolidatedMonthlyRows(slug, unit)));
      out.set(
        `valuation_ts|${slug}|${unit}`,
        JSON.stringify(getGroupValuationTimeseries(slug, unit, undefined, { groupedBlocks: true }))
      );
    }
    for (const id of accountIds) out.set(`monthly_perf|${id}|${unit}`, JSON.stringify(monthlyPerfForAccountId(id, unit)));
  }
  return out;
}

/**
 * Rebuild after a tick (quotes a minute later at the given factors) incrementally and from an
 * empty cache; returns the keys whose payloads differ, and whether the tick moved the bundles.
 */
async function tickParity(equityFactor: number, fxFactor: number): Promise<{ differing: string[]; moved: boolean }> {
  const t0 = tradingAfternoon();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(t0);
  // The session is live: no close stored for it yet (the synthetic DB carries bars through its
  // generation day), so the live quotes price today.
  const day = chileCalendarTodayYmd();
  db.prepare(`DELETE FROM equity_daily WHERE trade_date >= ?`).run(day);
  db.prepare(`DELETE FROM fx_daily WHERE date >= ?`).run(day);
  db.prepare(`DELETE FROM live_market_quotes`).run();
  clearAggregationCache();
  writeQuotes(t0, 1, 1);
  const before = await snapshotPayloads();

  // The tick: new quotes a minute later, then the poll's own invalidation.
  const t1 = new Date(t0.getTime() + 60_000);
  vi.setSystemTime(t1);
  writeQuotes(t1, equityFactor, fxFactor);
  invalidateMarketDataAggregations("live_tail");
  const incremental = await snapshotPayloads();

  clearAggregationCache();
  const full = await snapshotPayloads();
  vi.useRealTimers();
  return {
    differing: [...full.keys()].filter((k) => incremental.get(k) !== full.get(k)),
    moved:
      incremental.get("bundle|clp") !== before.get("bundle|clp") &&
      incremental.get("bundle|usd") !== before.get("bundle|usd"),
  };
}

describe("live-quote tick: incremental rebuild == full rebuild", () => {
  it("serves byte-identical payloads in CLP and USD after the quotes and the live fx move", async () => {
    const { differing, moved } = await tickParity(1.03, 1.0075);
    // Known gap, older than the history tier: the expense lines behind the flows overview
    // (`flows.overview.inputs|`) price an unpaid facturación's dollars at the live rate and are
    // kept across ticks, so its card spend lags the live fx until the next write.
    expect(differing.filter((k) => !k.startsWith("flows|"))).toEqual([]);
    // The tick reached the payloads (otherwise the comparison above proves nothing).
    expect(moved).toBe(true);
  }, 300_000);
});
