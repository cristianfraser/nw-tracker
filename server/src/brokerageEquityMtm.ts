import { historyTierMemo } from "./cacheRegistry.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { monthEndsBetweenInclusive } from "./calendarMonth.js";
import { BROKERAGE_SHARE_UNITS_FLOW_KINDS, brokerageShareUnitsThroughDate } from "./brokerageFlowMovement.js";
import { equityAsTradedClose, healIncomingEquityClose } from "./equitySplits.js";
import {
  listMovementRowsForAccount,
  unitsDeltaForAccountMovement,
} from "./movementTransfer.js";
import { accountProfileOptional } from "./accountProfile.js";
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


/** True when the account is valued from share units (its profile's quantity is a stock). */
export function accountUsesEquityMtm(accountId: number): boolean {
  return accountProfileOptional(accountId)?.quantity.kind === "stock";
}

/** Share units held on or before `asOfYmd` by an equity account (`brokerageShareUnitsThroughDate`); 0 for any other. */
export function equityShareUnitsThroughYmd(accountId: number, asOfYmd: string): number {
  if (!accountUsesEquityMtm(accountId)) return 0;
  return brokerageShareUnitsThroughDate(accountId, asOfYmd);
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
 * Whether an equity account had held shares by `asOfYmd`: before its first share inflow its
 * chart line and monthly rows have no value yet (not 0); after it, an emptied position reads 0.
 */
export function equityHeldByYmd(accountId: number, asOfYmd: string): boolean {
  const first = firstEquityShareActivityYmd(accountId);
  return first != null && asOfYmd >= first;
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

/** Merge timeline keys with month-ends covered by `equity_daily` for MTM brokerage accounts. */
export function expandSnapshotDatesForEquityMtm(baseDates: string[], allIds: number[]): string[] {
  const s = new Set(baseDates);
  for (const id of allIds) {
    const ticker = equityTickerForAccount(id);
    if (!ticker || !accountUsesEquityMtm(id)) continue;
    const r = db
      .prepare(`SELECT min(trade_date) AS a, max(trade_date) AS b FROM equity_daily WHERE ticker = ?`)
      .get(ticker) as { a: string | null; b: string | null } | undefined;
    if (!r?.a || !r.b) continue;
    for (const me of monthEndsBetweenInclusive(r.a, r.b)) s.add(me);
  }
  return [...s].sort();
}
