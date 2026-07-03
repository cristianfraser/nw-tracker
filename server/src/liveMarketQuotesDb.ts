import { db } from "./db.js";
import {
  LIVE_FX_SYMBOL,
  liveQuotesMaxAgeMs,
  liveQuotesRetentionHours,
  type LiveMarketQuoteKind,
} from "./liveMarketQuotesConfig.js";

export type LiveMarketQuoteRow = {
  symbol: string;
  kind: LiveMarketQuoteKind;
  value: number;
  /** Quote currency for equity rows; NULL for fx-rate rows (enforced by table CHECK). */
  currency: "usd" | "clp" | null;
  session_ymd: string;
  previous_value: number | null;
  fetched_at: string;
};

const insQuote = db.prepare(
  `INSERT INTO live_market_quotes (symbol, kind, value, currency, session_ymd, previous_value, fetched_at)
   VALUES (?, ?, ?, ?, ?, ?, ?)`
);

const stmtLatestEquity = db.prepare(
  `SELECT symbol, kind, value, currency, session_ymd, previous_value, fetched_at
   FROM live_market_quotes
   WHERE symbol = ? AND kind = 'equity'
   ORDER BY fetched_at DESC LIMIT 1`
);

const stmtLatestFx = db.prepare(
  `SELECT symbol, kind, value, currency, session_ymd, previous_value, fetched_at
   FROM live_market_quotes
   WHERE symbol = ? AND kind = 'fx_clp_per_usd'
   ORDER BY fetched_at DESC LIMIT 1`
);

export function insertLiveMarketQuote(row: LiveMarketQuoteRow): void {
  if (!Number.isFinite(row.value) || row.value <= 0) {
    throw new Error(`live_market_quotes: invalid value for ${row.symbol}`);
  }
  insQuote.run(
    row.symbol,
    row.kind,
    row.value,
    row.currency,
    row.session_ymd,
    row.previous_value,
    row.fetched_at
  );
}

export function pruneLiveMarketQuotes(retentionHours = liveQuotesRetentionHours()): number {
  const cutoff = new Date(Date.now() - retentionHours * 60 * 60 * 1000).toISOString();
  const r = db
    .prepare(`DELETE FROM live_market_quotes WHERE fetched_at < ?`)
    .run(cutoff);
  return r.changes;
}

function isFresh(fetchedAt: string, maxAgeMs: number): boolean {
  const t = Date.parse(fetchedAt);
  if (!Number.isFinite(t)) return false;
  return Date.now() - t <= maxAgeMs;
}

export function getLatestLiveEquityQuoteRow(
  ticker: string,
  maxAgeMs = liveQuotesMaxAgeMs()
): LiveMarketQuoteRow | null {
  const row = stmtLatestEquity.get(ticker.toUpperCase()) as LiveMarketQuoteRow | undefined;
  if (!row || !isFresh(row.fetched_at, maxAgeMs)) return null;
  return row;
}

export function getLatestLiveFxQuoteRow(
  maxAgeMs = liveQuotesMaxAgeMs()
): LiveMarketQuoteRow | null {
  const row = stmtLatestFx.get(LIVE_FX_SYMBOL) as LiveMarketQuoteRow | undefined;
  if (!row || !isFresh(row.fetched_at, maxAgeMs)) return null;
  return row;
}

/** For tests: clear all live quotes. */
export function clearLiveMarketQuotesForTest(): void {
  db.prepare(`DELETE FROM live_market_quotes`).run();
}
