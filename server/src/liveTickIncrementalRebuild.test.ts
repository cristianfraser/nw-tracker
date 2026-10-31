import { afterAll, describe, expect, it, vi } from "vitest";
import {
  aggregationCacheKeysForTest,
  clearAggregationCache,
  invalidateMarketDataAggregations,
} from "./aggregationCache.js";
import type { LiveQuoteMoves } from "./cacheDependencies.js";
import { chileCalendarAddDays, chileCalendarTodayYmd, dateAtTimeZoneWallClock } from "./chileDate.js";
import { buildDashboardPageBundle } from "./dashboardPageBundle.js";
import { getDashboardOverviewDaily } from "./dashboardOverviewDaily.js";
import { db } from "./db.js";
import { equityMarketKind, marketQuoteCurrency } from "./equityQuote.js";
import { buildFlowsOverviewPayload } from "./flowsOverview.js";
import { cachedFlowsExpensesGastosPayload, cachedFlowsExpensesPayload } from "./flowsMortgageCarrying.js";
import { getGroupConsolidatedMonthlyRows } from "./groupConsolidatedTables.js";
import { resolveGroupDailySeries } from "./groupDailySeries.js";
import { monthlyPerfForAccountId } from "./groupMonthlyPerfConsolidation.js";
import { LIVE_FX_SYMBOL } from "./liveMarketQuotesConfig.js";
import { insertLiveMarketQuote } from "./liveMarketQuotesDb.js";
import { isChileBusinessDay, isNyseTradingDay } from "./marketHolidays.js";
import { warmRentabilidadDailySeries } from "./rentabilidadDailyWarm.js";
import { snapshotTables } from "./test/snapshotTables.js";
import { creditCardGroupLedgerResponse } from "./creditCardGroupLedger.js";
import { creditCardInstallmentsResponse } from "./creditCardInstallments.js";
import { listCreditCardMasterAccountIds } from "./creditCardTree.js";
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

/**
 * A poll's writes: every ticker at `factor(ticker)` × its last close, the fx row at `fxFactor` ×.
 * Returns the tickers whose quote it moved.
 */
function writeQuotes(at: Date, factor: number | ((ticker: string) => number), fxFactor: number): Set<string> {
  const factorOf = typeof factor === "number" ? () => factor : factor;
  const moved = new Set<string>();
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
    if (factorOf(ticker) !== 1) moved.add(ticker.toUpperCase());
    insertLiveMarketQuote({
      symbol: ticker.toUpperCase(),
      kind: "equity",
      value: last.close * factorOf(ticker),
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
  return moved;
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
    out.set(`gastos|${unit}`, JSON.stringify(cachedFlowsExpensesGastosPayload(unit, new Set())));
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
  // The card ledgers price an unpaid facturación's dollars at the live rate.
  for (const id of listCreditCardMasterAccountIds()) out.set(`cc_ledger|${id}`, JSON.stringify(creditCardInstallmentsResponse(id)));
  out.set("cc_ledger|liabilities", JSON.stringify(creditCardGroupLedgerResponse("liabilities")));
  // The synthetic gap-mirror ids are numbered per build; the lines are the comparison.
  out.set(
    "expenses",
    JSON.stringify(cachedFlowsExpensesPayload()).replace(/synthetic-checking-gap-mirror:\d+|"statement_line_id":-\d+/g, "~")
  );
  return out;
}

/**
 * Rebuild after a tick (quotes a minute later at the given factors) incrementally and from an
 * empty cache; returns the keys whose payloads differ, and whether the tick moved the bundles.
 */
async function tickParity(
  equityFactor: number | ((ticker: string) => number),
  fxFactor: number,
  opts: { scoped?: boolean; extraMovedTickers?: string[] } = {}
): Promise<{ differing: string[]; moved: boolean; keptKeys: string[] }> {
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
  const movedTickers = writeQuotes(t1, equityFactor, fxFactor);
  for (const t of opts.extraMovedTickers ?? []) movedTickers.add(t);
  const moves: LiveQuoteMoves | undefined = opts.scoped ? { tickers: movedTickers, fx: fxFactor !== 1 } : undefined;
  const cachedBefore = new Set(aggregationCacheKeysForTest());
  invalidateMarketDataAggregations("live_tail", moves);
  const keptKeys = aggregationCacheKeysForTest().filter((k) => cachedBefore.has(k));
  const incremental = await snapshotPayloads();

  clearAggregationCache();
  const full = await snapshotPayloads();
  vi.useRealTimers();
  return {
    differing: [...full.keys()].filter((k) => incremental.get(k) !== full.get(k)),
    keptKeys,
    moved:
      incremental.get("bundle|clp") !== before.get("bundle|clp") &&
      incremental.get("bundle|usd") !== before.get("bundle|usd"),
  };
}

describe("live-quote tick: incremental rebuild == full rebuild", () => {
  // The live fx moves card payloads too: an unpaid facturación's dollars (the «próximos pagos»
  // panel, the flows overview's card spend) are priced at the live rate.
  it("serves byte-identical payloads in CLP and USD after the quotes and the live fx move", async () => {
    const { differing, moved } = await tickParity(1.03, 1.0075);
    expect(differing).toEqual([]);
    // The tick reached the payloads (otherwise the comparison above proves nothing).
    expect(moved).toBe(true);
  }, 300_000);

  // A scoped tick (the poll names what moved) drops only what read a moved price.
  it("a scoped tick of every price and the dollar serves the same payloads as a full rebuild", async () => {
    const { differing, moved, keptKeys } = await tickParity(1.03, 1.0075, { scoped: true });
    expect(differing).toEqual([]);
    expect(moved).toBe(true);
    // A card's billing detail keeps its base part (statement frame, ledger payload) and re-applies
    // only the live dollar rate on top (`ccBillingDetailCache.ts`).
    // The daily series keep their past part (values on past days, flow legs, deposit cums).
    expect(keptKeys).toContain("hist.daily_series_past");
    // The ledger accounts keep their closed months' rows; only the current month's is rebuilt.
    expect(keptKeys).toContain("hist.ledger_closed_month_rows");
    // (A card that never billed in dollars reads no live rate and keeps its bundle too.)
    const kept = new Set(keptKeys);
    const ratesReapplied = listCreditCardMasterAccountIds().filter(
      (id) => kept.has(`cc.billing_detail|${id}|base`) && !kept.has(`cc.billing_detail|${id}`)
    );
    expect(ratesReapplied.length).toBeGreaterThan(0);
  }, 300_000);

  // The synthetic DB holds no stock or coin, so a moved ticker is one nothing reads: a scoped
  // tick keeps everything (a coin moving at night in the real data; the unit tests in
  // cacheDependencies.test.ts cover an entry that does read the ticker).
  it("a tick of a price nothing reads keeps every cached payload", async () => {
    const { differing, keptKeys } = await tickParity(1, 1, { scoped: true, extraMovedTickers: ["ZZZ-USD"] });
    expect(differing).toEqual([]);
    expect(keptKeys.some((k) => k.startsWith("group.consolidated_monthly|liabilities|"))).toBe(true);
    expect(keptKeys.some((k) => k.startsWith("dashboard.page_bundle|"))).toBe(true);
  }, 300_000);
});
