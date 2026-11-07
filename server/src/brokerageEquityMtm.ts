import { historyTierMemo } from "./cacheRegistry.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { monthEndsBetweenInclusive } from "./calendarMonth.js";
import { BROKERAGE_SHARE_UNITS_FLOW_KINDS } from "./brokerageFlowMovement.js";
import { equityAsTradedClose, healIncomingEquityClose } from "./equitySplits.js";
import {
  sumUnitsThroughDate,
  listMovementRowsForAccount,
  unitsDeltaForAccountMovement,
} from "./movementTransfer.js";
import { isUsdCashAccount } from "./usdCashAccounts.js";
import { isClpCashAccount } from "./clpCashAccounts.js";
import { db } from "./db.js";
import { dbStateMemo } from "./dbStateMemo.js";
import { equityTickerForAccount, requireEquityTicker } from "./accountEquityTicker.js";
export { equityTickerForAccount } from "./accountEquityTicker.js";
import {
  equityDisplaySessionYmd,
  equityQuoteCurrency,
  marketQuoteCurrency,
} from "./equityQuote.js";
import type { EodCloseSeries } from "./equityYahooEod.js";
import { chileWallClockAt } from "./chileDate.js";
import { holdingPriceAt } from "./holdingPrices.js";
import type { CurrencyCode } from "./rates.js";
import { convertValue } from "./valueConvert.js";

/** Equity symbols loaded at `import:excel` into `equity_daily` (quote-currency close per share/coin). Crypto: CoinGecko; stocks: Yahoo. */
export const EQUITY_DAILY_IMPORT_TICKERS = ["SPY", "VEA", "OILK", "BTC-USD", "ETH-USD"] as const;

const insEod = db.prepare(
  `INSERT INTO equity_daily (ticker, trade_date, close, currency) VALUES (?,?,?,?)
   ON CONFLICT(ticker, trade_date) DO UPDATE SET close = excluded.close, currency = excluded.currency`
);

export function upsertEquityDailySeries(ticker: string, series: EodCloseSeries): number {
  const currency = marketQuoteCurrency(ticker);
  let n = 0;
  for (let i = 0; i < series.dates.length; i++) {
    const d = series.dates[i]!;
    const c = series.closes[i]!;
    if (!Number.isFinite(c)) continue;
    // The table is split-adjusted: a close sent as traded is re-framed, and one that moves like
    // an unrecorded split throws before anything of this ticker is stored over it.
    insEod.run(ticker, d, healIncomingEquityClose(ticker, d, c), currency);
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
  // A share flow's cash leg is never the equity side: a buy's from-account and a sell's
  // to-account are the wallet the proceeds move through (USD cash for USD-quoted stocks, CLP
  // cash for `.SN` ones — the first CLP sale, 2026-10-20, made Racional CLP read as a stock).
  if (isUsdCashAccount(accountId) || isClpCashAccount(accountId)) return false;
  // Movements are mark-input tables: the history tier drops this the moment one is written.
  const memo = historyTierMemo<number, boolean>("account_uses_equity_mtm");
  let uses = memo.get(accountId);
  if (uses === undefined) {
    uses = stmtHasUnits.get(accountId, accountId, ...BROKERAGE_SHARE_UNITS_FLOW_KINDS) != null;
    memo.set(accountId, uses);
  }
  return uses;
}

/** Share units held on or before `asOfYmd` (brokerage acciones / crypto with unit flows). */
export function equityShareUnitsThroughYmd(accountId: number, asOfYmd: string): number {
  if (!accountUsesEquityMtm(accountId)) return 0;
  return sumUnitsThroughDate(accountId, asOfYmd, BROKERAGE_SHARE_UNITS_FLOW_KINDS);
}

/** First calendar day a positive share inflow hit this equity account (buy, DRIP, transfer in). */
export function firstEquityShareActivityYmd(accountId: number): string | null {
  if (!accountUsesEquityMtm(accountId)) return null;
  // Memoized until the next database write: a backdated or deleted first buy moves it.
  return dbStateMemo("first_equity_share_activity_ymd", accountId, () => firstEquityShareActivityYmdUncached(accountId));
}

function firstEquityShareActivityYmdUncached(accountId: number): string | null {
  let min: string | null = null;
  for (const r of listMovementRowsForAccount(accountId)) {
    const fk = r.flow_kind;
    if (!fk || !(BROKERAGE_SHARE_UNITS_FLOW_KINDS as readonly string[]).includes(fk)) continue;
    if (unitsDeltaForAccountMovement(r, accountId) <= 0) continue;
    const ymd = r.occurred_on.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) continue;
    if (min == null || ymd < min) min = ymd;
  }
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
  now?: Date
): number | null {
  // A day before Chile today reads the EOD bar and the stored fx: kept in the history tier
  // (`cacheRegistry.ts`) across live-quote ticks.
  if (price == null && now === undefined && asOfYmd < chileCalendarTodayYmd()) {
    const memo = historyTierMemo<string, number | null>("equity_mtm_clp");
    const key = `${accountId}|${asOfYmd}`;
    let v = memo.get(key);
    if (v === undefined) {
      v = computeEquityMtmClpUncached(accountId, asOfYmd, null, new Date());
      memo.set(key, v);
    }
    return v;
  }
  return computeEquityMtmClpUncached(accountId, asOfYmd, price, now ?? new Date());
}

function computeEquityMtmClpUncached(
  accountId: number,
  asOfYmd: string,
  price: number | null | undefined,
  now: Date
): number | null {
  if (!accountUsesEquityMtm(accountId)) return null;
  const ticker = requireEquityTicker(accountId);
  const units = equityShareUnitsThroughYmd(accountId, asOfYmd);
  if (units <= 0 || !Number.isFinite(units)) return null;
  // The shares held on `asOfYmd` are valued at that day's traded price (`equitySplits.ts`).
  const close = price ?? equityAsTradedClose(ticker, asOfYmd);
  if (close == null || !Number.isFinite(close)) return null;
  // Shares × the quote-currency price, converted once at what selling them would get
  // (`valueConvert.ts`): the date's rate, live while today's fx day is open.
  return convertValue(units * close, equityQuoteCurrency(ticker), "clp", asOfYmd, "asset", now);
}

/**
 * Today's value of an equity position in its quote currency: the shares held today × today's
 * price (`holdingPriceAt`: live in session, the held print after the close, the display
 * session's bar, the newest bar). A position emptied after holding shares is 0, read from the
 * shares alone — no quote is read, so a sold-out position records no live dependency.
 */
export function equityTodayNativeValue(
  accountId: number,
  now: Date = new Date()
): { value: number; currency: CurrencyCode; as_of_date: string } | null {
  if (!accountUsesEquityMtm(accountId)) return null;
  const ticker = requireEquityTicker(accountId);
  const quote = equityQuoteCurrency(ticker);
  const today = chileWallClockAt(now).ymd;
  const units = equityShareUnitsThroughYmd(accountId, today);
  if (!(units > 0) || !Number.isFinite(units)) {
    const sold = soldOutEquityMark(accountId, equityDisplaySessionYmd(ticker, now));
    return sold ? { value: 0, currency: quote, as_of_date: sold.as_of_date } : null;
  }
  const px = holdingPriceAt({ kind: "stock", ticker, quote }, today, { now });
  if (!px) return null;
  const value = units * px.price;
  return Number.isFinite(value) ? { value, currency: px.currency, as_of_date: px.as_of } : null;
}

/** {@link equityTodayNativeValue} in pesos, at today's sell rate. */
export function computeEquityMtmClpDisplaySync(
  accountId: number,
  now: Date = new Date()
): { value_clp: number; as_of_date: string } | null {
  const native = equityTodayNativeValue(accountId, now);
  if (!native) return null;
  const clp = convertValue(native.value, native.currency, "clp", chileWallClockAt(now).ymd, "asset", now);
  return clp != null && Number.isFinite(clp) ? { value_clp: clp, as_of_date: native.as_of_date } : null;
}

/** 0 on the display session for a position emptied after holding shares, else no mark. */
function soldOutEquityMark(
  accountId: number,
  displayYmd: string
): { value_clp: number; as_of_date: string } | null {
  if (firstEquityShareActivityYmd(accountId) != null && equityShareUnitsThroughYmd(accountId, displayYmd) <= 0) {
    return { value_clp: 0, as_of_date: displayYmd };
  }
  return null;
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
