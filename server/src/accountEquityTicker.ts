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

const stmtAccountsByTicker = db.prepare(
  `SELECT id FROM accounts WHERE UPPER(TRIM(equity_ticker)) = ?`
);

/** Every account holding a symbol — for callers that handle 0/many themselves (auto-create). */
export function accountsWithEquityTicker(ticker: string): number[] {
  const symbol = String(ticker ?? "").trim().toUpperCase();
  if (!symbol) return [];
  const rows = stmtAccountsByTicker.all(symbol) as { id: number }[];
  return rows.map((r) => r.id);
}

/**
 * The account holding a symbol — the reverse of {@link equityTickerForAccount}, and the only
 * sanctioned way for an importer to turn a broker's ticker into an account.
 *
 * Throws unless exactly one account matches: zero means the position does not exist yet (a
 * first-ever purchase of something new, which should be created deliberately in the panel, not
 * invented by an importer), and more than one means the ticker is ambiguous.
 */
export function accountIdForEquityTicker(ticker: string): number {
  const symbol = String(ticker ?? "").trim().toUpperCase();
  if (!symbol) throw new Error("accountIdForEquityTicker: empty ticker");
  const rows = stmtAccountsByTicker.all(symbol) as { id: number }[];
  if (rows.length !== 1) {
    throw new Error(
      `Expected exactly one account with equity_ticker "${symbol}", found ${rows.length}. ` +
        `Create the position in the panel first (it sets accounts.equity_ticker).`
    );
  }
  return rows[0]!.id;
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
