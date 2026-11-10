/**
 * Synthetic London Stock Exchange ticker fixture for the `stocks_london` due/stale tests — the
 * `.L` twin of `santiagoTickerFixture.ts`: guarantees at least one `.L` account and gives EVERY
 * listed `.L` ticker one `equity_daily` bar at 2050-01-01 (above any 2026 fixture date, so
 * "caught up ⇒ not stale" holds; below the 2099 dates the carry-over tests probe, so
 * "missing ⇒ still stale" holds).
 */
import { db } from "../db.js";
import { listWatchlistLondonTickersForEodSync } from "../watchlist.js";

const FIXTURE_NOTE = "test:london-eod-fixture";
export const LONDON_FIXTURE_TICKER = "VITEST.L";
const FIXTURE_BAR_DATE = "2050-01-01";

let plantedBarTickers: string[] = [];
let createdAccount = false;

export function installLondonTickerFixture(): void {
  const existing = db
    .prepare(`SELECT COUNT(*) AS c FROM accounts a JOIN market_symbols m ON m.ticker = upper(trim(a.equity_ticker)) WHERE m.market_kind = 'london'`)
    .get() as { c: number };
  if (existing.c === 0) {
    const group = db.prepare(`SELECT id FROM asset_groups ORDER BY id LIMIT 1`).get() as { id: number };
    db.prepare(
      `INSERT INTO accounts (asset_group_id, name, notes, equity_ticker)
       VALUES (?, 'London EOD fixture', ?, ?)`
    ).run(group.id, FIXTURE_NOTE, LONDON_FIXTURE_TICKER);
    createdAccount = true;
  }
  plantedBarTickers = [];
  const plant = db.prepare(
    `INSERT INTO equity_daily (ticker, trade_date, close, currency) VALUES (?, ?, 1, 'usd')
     ON CONFLICT(ticker, trade_date) DO NOTHING`
  );
  for (const ticker of listWatchlistLondonTickersForEodSync()) {
    if (plant.run(ticker, FIXTURE_BAR_DATE).changes > 0) plantedBarTickers.push(ticker);
  }
}

export function removeLondonTickerFixture(): void {
  const unplant = db.prepare(`DELETE FROM equity_daily WHERE ticker = ? AND trade_date = ?`);
  for (const ticker of plantedBarTickers) unplant.run(ticker, FIXTURE_BAR_DATE);
  plantedBarTickers = [];
  if (!createdAccount) return;
  createdAccount = false;
  db.prepare(`DELETE FROM accounts WHERE notes = ?`).run(FIXTURE_NOTE);
  db.prepare(
    `DELETE FROM market_display_series
     WHERE source = 'account' AND kind = 'equity' AND upper(series_key) = ?`
  ).run(LONDON_FIXTURE_TICKER);
}
