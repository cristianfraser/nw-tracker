import { monthEndsBetweenInclusive } from "./calendarMonth.js";
import { BROKERAGE_SHARE_UNITS_FLOW_KINDS } from "./brokerageFlowMovement.js";
import { sumUnitsThroughDate, listMovementRowsForAccount, unitsDeltaForAccountMovement } from "./movementTransfer.js";
import { accountUsesBrokerageFlowKinds } from "./accountBrokerageFlows.js";
import { isUsdCashAccount } from "./usdCashAccounts.js";
import { db } from "./db.js";
import { equityTickerForAccount, requireEquityTicker } from "./accountEquityTicker.js";
export { equityTickerForAccount } from "./accountEquityTicker.js";
import {
  equityCloseEod,
  equityDisplaySessionYmd,
  equityQuoteCurrency,
  equitySessionYmdForTicker,
  getLiveEquityQuoteFromDb,
  shouldUseLiveEquityQuote,
} from "./equityQuote.js";
import type { EodCloseSeries } from "./equityYahooEod.js";
import { fxForLiveMtm, fxMonthEndForBalanceUsd } from "./fxRates.js";

/** Equity symbols loaded at `import:excel` into `equity_daily` (quote-currency close per share/coin). Crypto: CoinGecko; stocks: Yahoo. */
export const EQUITY_DAILY_IMPORT_TICKERS = ["SPY", "VEA", "OILK", "BTC-USD", "ETH-USD"] as const;

const insEod = db.prepare(
  `INSERT INTO equity_daily (ticker, trade_date, close, currency) VALUES (?,?,?,?)
   ON CONFLICT(ticker, trade_date) DO UPDATE SET close = excluded.close, currency = excluded.currency`
);

export function upsertEquityDailySeries(ticker: string, series: EodCloseSeries): number {
  const currency = equityQuoteCurrency(ticker);
  let n = 0;
  for (let i = 0; i < series.dates.length; i++) {
    const d = series.dates[i]!;
    const c = series.closes[i]!;
    if (!Number.isFinite(c)) continue;
    insEod.run(ticker, d, c, currency);
    n += 1;
  }
  return n;
}

const shareUnitsFlowPh = BROKERAGE_SHARE_UNITS_FLOW_KINDS.map(() => "?").join(", ");

const stmtHasUnits = db.prepare(
  `SELECT 1 FROM movements
   WHERE (account_id = ? OR to_account_id = ?)
     AND flow_kind IN (${shareUnitsFlowPh})
     AND COALESCE(units_delta, 0) != 0
   LIMIT 1`
);

export function accountUsesEquityMtm(accountId: number): boolean {
  if (isUsdCashAccount(accountId)) return false;
  return (
    stmtHasUnits.get(accountId, accountId, ...BROKERAGE_SHARE_UNITS_FLOW_KINDS) != null
  );
}

/** Share units held on or before `asOfYmd` (brokerage acciones / crypto with unit flows). */
export function equityShareUnitsThroughYmd(accountId: number, asOfYmd: string): number {
  if (!accountUsesEquityMtm(accountId)) return 0;
  return sumUnitsThroughDate(accountId, asOfYmd, BROKERAGE_SHARE_UNITS_FLOW_KINDS);
}

const firstShareActivityYmdCache = new Map<number, string | null>();

/** First calendar day a positive share inflow hit this equity account (buy, DRIP, transfer in). */
export function firstEquityShareActivityYmd(accountId: number): string | null {
  if (!accountUsesEquityMtm(accountId)) return null;
  const cached = firstShareActivityYmdCache.get(accountId);
  if (cached !== undefined) return cached;
  let min: string | null = null;
  for (const r of listMovementRowsForAccount(accountId)) {
    const fk = r.flow_kind;
    if (!fk || !(BROKERAGE_SHARE_UNITS_FLOW_KINDS as readonly string[]).includes(fk)) continue;
    if (unitsDeltaForAccountMovement(r, accountId) <= 0) continue;
    const ymd = r.occurred_on.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) continue;
    if (min == null || ymd < min) min = ymd;
  }
  firstShareActivityYmdCache.set(accountId, min);
  return min;
}

/**
 * Chart valuation = 0 when flat only **after** the account has held shares (sold out).
 * Before first share activity, return null so the line does not backfill zeros.
 */
export function equityChartZeroClpAtYmd(accountId: number, asOfYmd: string): boolean {
  const first = firstEquityShareActivityYmd(accountId);
  if (first == null || asOfYmd < first) return false;
  return equityShareUnitsThroughYmd(accountId, asOfYmd) <= 0;
}

/**
 * CLP MTM: shares through `asOfYmd` × quote-currency price (× FX for USD-quoted tickers).
 * Uses EOD from DB unless `price` passed.
 */
export function computeEquityMtmClp(
  accountId: number,
  asOfYmd: string,
  price?: number | null,
  now: Date = new Date()
): number | null {
  if (!accountUsesEquityMtm(accountId)) return null;
  const ticker = requireEquityTicker(accountId);
  const units = equityShareUnitsThroughYmd(accountId, asOfYmd);
  if (units <= 0 || !Number.isFinite(units)) return null;
  const close = price ?? equityCloseEod(ticker, asOfYmd);
  if (close == null || !Number.isFinite(close)) return null;
  if (equityQuoteCurrency(ticker) === "clp") {
    const clp = units * close;
    return Number.isFinite(clp) ? clp : null;
  }
  const fx =
    price != null && Number.isFinite(price)
      ? fxForLiveMtm(asOfYmd, now)
      : fxMonthEndForBalanceUsd(asOfYmd);
  if (!fx || fx.clp_per_usd <= 0) return null;
  const clp = units * close * fx.clp_per_usd;
  return Number.isFinite(clp) ? clp : null;
}

/** Sync MTM using a fresh cached live quote only during NYSE regular session. */
export function computeEquityMtmClpCachedLive(
  accountId: number,
  now: Date = new Date()
): number | null {
  if (!accountUsesEquityMtm(accountId)) return null;
  const ticker = requireEquityTicker(accountId);
  const session = equitySessionYmdForTicker(ticker, now);
  if (!shouldUseLiveEquityQuote(ticker, session, now)) return null;
  const cached = getLiveEquityQuoteFromDb(ticker);
  if (!cached) return null;
  return computeEquityMtmClp(accountId, session, cached.price, now);
}

/**
 * Synchronous display mark for acciones: live MTM in session, else last EOD for
 * {@link equityDisplaySessionYmd} (prior close before open; same-day close after close —
 * on the ticker's own exchange calendar, Chile day for `.SN`).
 */
export function computeEquityMtmClpDisplaySync(
  accountId: number,
  now: Date = new Date()
): { value_clp: number; as_of_date: string } | null {
  if (!accountUsesEquityMtm(accountId)) return null;
  const ticker = requireEquityTicker(accountId);

  const session = equitySessionYmdForTicker(ticker, now);
  if (shouldUseLiveEquityQuote(ticker, session, now)) {
    const cached = computeEquityMtmClpCachedLive(accountId, now);
    if (cached != null && Number.isFinite(cached) && cached > 0) {
      return { value_clp: cached, as_of_date: session };
    }
    const fromSession = computeEquityMtmClp(accountId, session, null, now);
    if (fromSession != null && Number.isFinite(fromSession) && fromSession > 0) {
      return { value_clp: fromSession, as_of_date: session };
    }
  }

  const displayYmd = equityDisplaySessionYmd(ticker, now);
  const fromDisplay = computeEquityMtmClp(accountId, displayYmd, null, now);
  if (fromDisplay != null && Number.isFinite(fromDisplay) && fromDisplay > 0) {
    return { value_clp: fromDisplay, as_of_date: displayYmd };
  }

  const mdRow = stmtMaxEqDate.get(ticker) as { md: string | null } | undefined;
  const md = mdRow?.md;
  if (md) {
    const fromEod = computeEquityMtmClp(accountId, md);
    if (fromEod != null && Number.isFinite(fromEod) && fromEod > 0) {
      return { value_clp: fromEod, as_of_date: md };
    }
  }

  if (firstEquityShareActivityYmd(accountId) != null && equityShareUnitsThroughYmd(accountId, displayYmd) <= 0) {
    return { value_clp: 0, as_of_date: displayYmd };
  }

  return null;
}

/** MTM from scheduler-persisted live quote (no Yahoo on HTTP). */
export function computeEquityMtmClpLive(
  accountId: number,
  now: Date = new Date()
): { value_clp: number; as_of_date: string; source: string } | null {
  if (!accountUsesEquityMtm(accountId)) return null;
  const ticker = requireEquityTicker(accountId);
  const session = equitySessionYmdForTicker(ticker, now);
  const quote = getLiveEquityQuoteFromDb(ticker);
  if (!quote) return null;
  const clp = computeEquityMtmClp(accountId, session, quote.price, now);
  if (clp == null || !Number.isFinite(clp) || clp <= 0) return null;
  return { value_clp: clp, as_of_date: quote.trade_date, source: quote.source };
}

const stmtMaxEqDate = db.prepare(
  `SELECT max(trade_date) AS md FROM equity_daily WHERE ticker = ?`
);

/** Latest CLP mark for brokerage equities (live from DB scheduler, else EOD display session). */
export function computeLatestDisplayedEquityClp(
  accountId: number,
  now: Date = new Date()
): { value_clp: number; as_of_date: string } | null {
  if (!accountUsesEquityMtm(accountId)) return null;
  const ticker = requireEquityTicker(accountId);

  const sync = computeEquityMtmClpDisplaySync(accountId, now);
  if (sync != null && sync.value_clp > 0) return sync;

  const mdRow = stmtMaxEqDate.get(ticker) as { md: string | null } | undefined;
  const md = mdRow?.md;
  if (!md) return null;

  const fromFlows = computeEquityMtmClp(accountId, md);
  if (fromFlows != null && Number.isFinite(fromFlows) && fromFlows > 0) {
    return { value_clp: fromFlows, as_of_date: md };
  }

  return null;
}

export function deleteEquityDailyForImportTickers(): void {
  const ph = EQUITY_DAILY_IMPORT_TICKERS.map(() => "?").join(",");
  db.prepare(`DELETE FROM equity_daily WHERE ticker IN (${ph})`).run(...EQUITY_DAILY_IMPORT_TICKERS);
}

/** Merge timeline keys with month-ends covered by `equity_daily` for MTM brokerage accounts. */
export function expandSnapshotDatesForEquityMtm(
  baseDates: string[],
  allIds: number[],
  merge: { spyId?: number; veaId?: number } | undefined
): string[] {
  const s = new Set(baseDates);
  const addTickerMonths = (accountId: number | undefined, ticker: string) => {
    if (accountId == null || !accountUsesEquityMtm(accountId)) return;
    const r = db
      .prepare(`SELECT min(trade_date) AS a, max(trade_date) AS b FROM equity_daily WHERE ticker = ?`)
      .get(ticker) as { a: string | null; b: string | null } | undefined;
    if (!r?.a || !r.b) return;
    for (const me of monthEndsBetweenInclusive(r.a, r.b)) s.add(me);
  };
  if (merge?.spyId) addTickerMonths(merge.spyId, "SPY");
  if (merge?.veaId) addTickerMonths(merge.veaId, "VEA");
  if (!merge) {
    for (const id of allIds) {
      const t = equityTickerForAccount(id);
      if (t) addTickerMonths(id, t);
    }
  }
  return [...s].sort();
}
