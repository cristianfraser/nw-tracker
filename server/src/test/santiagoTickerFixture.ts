/**
 * Synthetic Bolsa de Santiago ticker fixture for the `stocks_santiago` due/stale tests — the
 * `.SN` twin of `cryptoTickerFixture.ts`.
 *
 * `equitySantiagoEodCaughtUp` iterates the Santiago watchlist (derived from
 * `accounts.equity_ticker`), so the fixture guarantees at least one `.SN` account and gives
 * EVERY listed `.SN` ticker one `equity_daily` bar at 2050-01-01: above any 2026 fixture date
 * ("caught up ⇒ not stale" holds) and below the 2099 dates the carry-over tests probe
 * ("missing ⇒ still stale" holds). Other suites leave `VITEST.SN` accounts behind with no
 * bars, which is why the bar is planted per listed ticker rather than per fixture account.
 */
import { db } from "../db.js";
import { listWatchlistSantiagoTickersForEodSync } from "../watchlist.js";

const FIXTURE_NOTE = "test:santiago-eod-fixture";
const FIXTURE_TICKER = "VITEST.SN";
const FIXTURE_BAR_DATE = "2050-01-01";

let plantedBarTickers: string[] = [];
let createdAccount = false;

export function installSantiagoTickerFixture(): void {
  const existing = db
    .prepare(
      `SELECT COUNT(*) AS c FROM accounts WHERE upper(trim(COALESCE(equity_ticker, ''))) LIKE '%.SN'`
    )
    .get() as { c: number };
  if (existing.c === 0) {
    const group = db.prepare(`SELECT id FROM asset_groups ORDER BY id LIMIT 1`).get() as {
      id: number;
    };
    db.prepare(
      `INSERT INTO accounts (asset_group_id, name, notes, equity_ticker)
       VALUES (?, 'Santiago EOD fixture', ?, ?)`
    ).run(group.id, FIXTURE_NOTE, FIXTURE_TICKER);
    createdAccount = true;
  }
  plantedBarTickers = [];
  const plant = db.prepare(
    `INSERT INTO equity_daily (ticker, trade_date, close, currency) VALUES (?, ?, 1, 'clp')
     ON CONFLICT(ticker, trade_date) DO NOTHING`
  );
  for (const ticker of listWatchlistSantiagoTickersForEodSync()) {
    if (plant.run(ticker, FIXTURE_BAR_DATE).changes > 0) plantedBarTickers.push(ticker);
  }
}

export function removeSantiagoTickerFixture(): void {
  const unplant = db.prepare(`DELETE FROM equity_daily WHERE ticker = ? AND trade_date = ?`);
  for (const ticker of plantedBarTickers) unplant.run(ticker, FIXTURE_BAR_DATE);
  plantedBarTickers = [];
  if (!createdAccount) return;
  createdAccount = false;
  db.prepare(`DELETE FROM accounts WHERE notes = ?`).run(FIXTURE_NOTE);
  db.prepare(
    `DELETE FROM market_display_series
     WHERE source = 'account' AND kind = 'equity' AND upper(series_key) = ?`
  ).run(FIXTURE_TICKER);
}
