import { equityMarketKind } from "./equityQuote.js";
import { db } from "./db.js";

const stmtEquityTicker = db.prepare(
  `SELECT equity_ticker FROM accounts WHERE id = ?`
);

const stmtDistinctTickers = db.prepare(
  `SELECT DISTINCT equity_ticker AS t
   FROM accounts
   WHERE equity_ticker IS NOT NULL AND trim(equity_ticker) != ''
   ORDER BY t`
);

/** Yahoo symbol stored on the account (SPY, OILK, BTC-USD, …). */
export function equityTickerForAccount(accountId: number): string | null {
  const row = stmtEquityTicker.get(accountId) as { equity_ticker: string | null } | undefined;
  const t = row?.equity_ticker?.trim();
  return t ? t.toUpperCase() : null;
}

/** Fail fast when an equity-MTM account has no `equity_ticker` in DB. */
export function requireEquityTicker(accountId: number): string {
  const ticker = equityTickerForAccount(accountId);
  if (!ticker) {
    throw new Error(
      `account ${accountId}: equity_ticker is required (set at import or panel create; re-run migration 089 backfill if legacy account)`
    );
  }
  return ticker;
}

/** All distinct symbols for marquee live quotes and NYSE/crypto EOD sync. */
export function listDistinctEquityTickersForSync(): string[] {
  const rows = stmtDistinctTickers.all() as { t: string }[];
  return rows.map((r) => r.t.trim().toUpperCase()).filter(Boolean);
}

/** NYSE-listed symbols from `accounts.equity_ticker` (excludes BTC-USD / ETH-USD). */
export function listNyseEquityTickersForEodSync(): string[] {
  return listDistinctEquityTickersForSync().filter((t) => equityMarketKind(t) === "nyse");
}
