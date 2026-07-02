/**
 * Synthetic crypto-ticker fixture for EOD-sync tests.
 *
 * `equityCryptoEodCaughtUp` iterates the crypto watchlist (derived from
 * `accounts.equity_ticker`) — on a DB with no crypto accounts the `.every()` is vacuously
 * true and every due/stale check short-circuits. Tests that exercise the carryover logic
 * install a BTC-USD account plus one `equity_daily` bar at 2050-01-01: above any 2026
 * fixture date (so "caught up ⇒ not due" cases hold) and below the 2099 dates the
 * carryover tests probe (so "missing ⇒ still due" cases hold).
 */
import { db } from "../db.js";

const FIXTURE_NOTE = "test:crypto-eod-fixture";
const FIXTURE_TICKER = "BTC-USD";
const FIXTURE_BAR_DATE = "2050-01-01";

export function installCryptoTickerFixture(): void {
  const existing = db
    .prepare(
      `SELECT COUNT(*) AS c FROM accounts WHERE upper(trim(COALESCE(equity_ticker, ''))) = ?`
    )
    .get(FIXTURE_TICKER) as { c: number };
  if (existing.c > 0) return; // DB already has a real BTC-USD account — nothing to fake.

  const group = db.prepare(`SELECT id FROM asset_groups ORDER BY id LIMIT 1`).get() as {
    id: number;
  };
  db.prepare(
    `INSERT INTO accounts (asset_group_id, name, notes, equity_ticker)
     VALUES (?, 'Crypto EOD fixture', ?, ?)`
  ).run(group.id, FIXTURE_NOTE, FIXTURE_TICKER);
  db.prepare(
    `INSERT INTO equity_daily (ticker, trade_date, close_usd) VALUES (?, ?, 1)
     ON CONFLICT(ticker, trade_date) DO NOTHING`
  ).run(FIXTURE_TICKER, FIXTURE_BAR_DATE);
}

export function removeCryptoTickerFixture(): void {
  const removed = db.prepare(`DELETE FROM accounts WHERE notes = ?`).run(FIXTURE_NOTE);
  if (removed.changes === 0) return; // install was a no-op (real BTC-USD account exists)
  db.prepare(`DELETE FROM equity_daily WHERE ticker = ? AND trade_date = ?`).run(
    FIXTURE_TICKER,
    FIXTURE_BAR_DATE
  );
  db.prepare(
    `DELETE FROM market_display_series
     WHERE source = 'account' AND kind = 'equity' AND upper(series_key) = ?`
  ).run(FIXTURE_TICKER);
}
