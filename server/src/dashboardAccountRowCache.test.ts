import { afterAll, describe, expect, it, vi } from "vitest";
import {
  aggregationCacheHasForTest,
  clearAggregationCache,
  invalidateMarketDataAggregations,
} from "./aggregationCache.js";
import { chileCalendarAddDays, chileCalendarTodayYmd, dateAtTimeZoneWallClock } from "./chileDate.js";
import { buildDashboardAccountRows } from "./dashboardAccounts.js";
import { db } from "./db.js";
import { insertLiveMarketQuote } from "./liveMarketQuotesDb.js";
import { isChileBusinessDay, isNyseTradingDay } from "./marketHolidays.js";
import { snapshotTables } from "./test/snapshotTables.js";

/**
 * Each dashboard row is its own cache entry (`dashboardAccounts.ts`): a live-quote tick that moves
 * one price drops the rows that read it, and the list reassembled from the rows still cached is
 * what a build from an empty cache answers. The synthetic DB holds no stock or coin, so this test
 * adds a Bitcoin account (units × BTC-USD × fx), the only row that reads the coin.
 */
// Never snapshot `accounts`: restoring it deletes every account, which cascades through their rows.
const restoreTables = snapshotTables(["equity_daily", "live_market_quotes", "mark_input_changes"]);
const TEST_IMPORT_KEY = "vitest:row-cache|btc";
afterAll(() => {
  const added = db.prepare(`SELECT id FROM accounts WHERE import_key = ?`).get(TEST_IMPORT_KEY) as { id: number } | undefined;
  if (added) {
    db.prepare(`DELETE FROM movements WHERE account_id = ?`).run(added.id);
    db.prepare(`DELETE FROM accounts WHERE id = ?`).run(added.id);
  }
  restoreTables();
  vi.useRealTimers();
  clearAggregationCache();
});

const PREFIX = "dashboard.page_bundle|";

/** The latest day both markets traded, at 14:00 New York (as `liveTickIncrementalRebuild.test.ts`). */
function tradingAfternoon(): Date {
  let d = chileCalendarTodayYmd();
  while (!isNyseTradingDay(d) || !isChileBusinessDay(d)) d = chileCalendarAddDays(d, -1);
  return dateAtTimeZoneWallClock(d, 14, 0, "America/New_York");
}

function writeBtcQuote(at: Date, value: number): void {
  insertLiveMarketQuote({
    symbol: "BTC-USD",
    kind: "equity",
    value,
    currency: "usd",
    session_ymd: at.toISOString().slice(0, 10),
    previous_value: 60_000,
    fetched_at: at.toISOString(),
  });
}

describe("dashboard rows: one cache entry per account", () => {
  it("a coin tick drops only the coin's row and the list; the reassembled rows equal a fresh build", async () => {
    const t0 = tradingAfternoon();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(t0);
    const today = chileCalendarTodayYmd();
    db.prepare(`DELETE FROM live_market_quotes`).run();
    db.prepare(`DELETE FROM equity_daily WHERE ticker = 'BTC-USD'`).run();
    const groupId = (
      db.prepare(`SELECT id FROM asset_groups WHERE slug = 'brokerage_crypto__bitcoin'`).get() as { id: number }
    ).id;
    const btcId = Number(
      db
        .prepare(
          `INSERT INTO accounts (asset_group_id, name, notes, equity_ticker, import_key)
           VALUES (?, 'Test Bitcoin', 'vitest:row-cache', 'BTC-USD', ?)`
        )
        .run(groupId, TEST_IMPORT_KEY).lastInsertRowid
    );
    const insClose = db.prepare(
      `INSERT INTO equity_daily (ticker, trade_date, close, currency) VALUES ('BTC-USD', ?, ?, 'usd')`
    );
    for (let d = chileCalendarAddDays(today, -400), i = 0; d < today; d = chileCalendarAddDays(d, 1), i++) {
      insClose.run(d, 50_000 + 25 * i);
    }
    db.prepare(
      `INSERT INTO movements (account_id, amount, currency, occurred_on, note, units_delta)
       VALUES (?, 3000000, 'clp', ?, 'Compra BTC|vitest', 0.05)`
    ).run(btcId, chileCalendarAddDays(today, -300));
    const otherIds = (
      db.prepare(`SELECT id FROM accounts WHERE id != ? ORDER BY id`).all(btcId) as { id: number }[]
    ).map((r) => r.id);

    clearAggregationCache();
    writeBtcQuote(t0, 60_000);
    const before = JSON.stringify(await buildDashboardAccountRows(false));
    await buildDashboardAccountRows(true);
    for (const unit of ["clp", "usd"]) {
      expect(aggregationCacheHasForTest(`${PREFIX}account_row|${btcId}|${unit}`)).toBe(true);
      expect(aggregationCacheHasForTest(`${PREFIX}account_rows|${unit}`)).toBe(true);
    }

    // The tick: the coin moves, nothing else.
    const t1 = new Date(t0.getTime() + 60_000);
    vi.setSystemTime(t1);
    writeBtcQuote(t1, 63_000);
    invalidateMarketDataAggregations("live_tail", { tickers: new Set(["BTC-USD"]), fx: false });
    for (const unit of ["clp", "usd"]) {
      expect(aggregationCacheHasForTest(`${PREFIX}account_row|${btcId}|${unit}`)).toBe(false);
      expect(aggregationCacheHasForTest(`${PREFIX}account_rows|${unit}`)).toBe(false);
      expect(aggregationCacheHasForTest(`${PREFIX}account_rows_ctx|${unit}`)).toBe(true);
      for (const id of otherIds) {
        expect(aggregationCacheHasForTest(`${PREFIX}account_row|${id}|${unit}`)).toBe(true);
      }
    }

    const incremental = {
      clp: JSON.stringify(await buildDashboardAccountRows(false)),
      usd: JSON.stringify(await buildDashboardAccountRows(true)),
    };
    clearAggregationCache();
    const full = {
      clp: JSON.stringify(await buildDashboardAccountRows(false)),
      usd: JSON.stringify(await buildDashboardAccountRows(true)),
    };
    vi.useRealTimers();
    expect(incremental).toEqual(full);
    // The tick reached the coin's row (otherwise the comparison proves nothing).
    expect(incremental.clp).not.toBe(before);
    const btcRow = (JSON.parse(full.clp) as { account_id: number; current_value_clp: number | null }[]).find(
      (r) => r.account_id === btcId
    );
    expect(btcRow?.current_value_clp).toBeGreaterThan(0);
  }, 300_000);
});
