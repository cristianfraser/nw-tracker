import { db } from "./db.js";
import { chileCalendarTodayYmd } from "./chileDate.js";

export type FxBidAskRow = {
  date: string;
  buy_clp_per_usd: number;
  sell_clp_per_usd: number;
  source: string;
};

/** Total CLP spread between buy and sell when inferring from Yahoo mid. */
export const FX_BID_ASK_SPREAD_CLP = 4;

const stmtExactDate = db.prepare(
  `SELECT date, buy_clp_per_usd, sell_clp_per_usd, source
   FROM fx_daily_bid_ask WHERE date = ?`
);

const stmtMidOnOrBefore = db.prepare(
  `SELECT clp_per_usd FROM fx_daily WHERE date <= ? ORDER BY date DESC LIMIT 1`
);

const stmtBuyOnOrBefore = db.prepare(
  `SELECT date, buy_clp_per_usd, sell_clp_per_usd, source
   FROM fx_daily_bid_ask WHERE date <= ? ORDER BY date DESC LIMIT 1`
);

const stmtSellOnOrBefore = stmtBuyOnOrBefore;

const stmtMidRowOnOrBefore = db.prepare(
  `SELECT date, clp_per_usd FROM fx_daily WHERE date <= ? ORDER BY date DESC LIMIT 1`
);

/**
 * Latest bid/ask row on or before `date`. `mid_spread_inferred` rows are just cached
 * `fx_daily` mids ± spread, so when `fx_daily` has a row at the same date or newer, the
 * lookup re-infers from that fresher mid (transiently — nothing is persisted) instead of
 * serving the stale materialized value. Without this, a row materialized weeks ago (or
 * future-dated, e.g. a projected vencimiento) freezes every later conversion at that old
 * rate. Real observed rows (`movement_compra_usd`, manual) are always served as stored.
 */
export function fxBidAskRowOnOrBefore(date: string | null): FxBidAskRow | null {
  if (!date) return null;
  const row = (stmtBuyOnOrBefore.get(date) as FxBidAskRow | undefined) ?? null;
  const midRow = stmtMidRowOnOrBefore.get(date) as
    | { date: string; clp_per_usd: number }
    | undefined;
  const canInferFromMid =
    midRow != null && Number.isFinite(midRow.clp_per_usd) && midRow.clp_per_usd > 0;
  if (row && row.source === "mid_spread_inferred" && canInferFromMid && midRow.date >= row.date) {
    return { date: midRow.date, ...inferBidAskFromMid(midRow.clp_per_usd), source: "mid_spread_inferred" };
  }
  if (!row && canInferFromMid) {
    return { date: midRow.date, ...inferBidAskFromMid(midRow.clp_per_usd), source: "mid_spread_inferred" };
  }
  return row;
}

export function fxBuyClpPerUsdOnOrBefore(date: string | null): number | null {
  const row = fxBidAskRowOnOrBefore(date);
  const v = row?.buy_clp_per_usd;
  return v != null && Number.isFinite(v) && v > 0 ? v : null;
}

export function fxSellClpPerUsdOnOrBefore(date: string | null): number | null {
  const row = fxBidAskRowOnOrBefore(date);
  const v = row?.sell_clp_per_usd;
  return v != null && Number.isFinite(v) && v > 0 ? v : null;
}

export function upsertFxBidAskRow(row: FxBidAskRow): void {
  if (row.buy_clp_per_usd < row.sell_clp_per_usd) {
    throw new Error(
      `fx_daily_bid_ask ${row.date}: buy ${row.buy_clp_per_usd} < sell ${row.sell_clp_per_usd}`
    );
  }
  db.prepare(
    `INSERT INTO fx_daily_bid_ask (date, buy_clp_per_usd, sell_clp_per_usd, source)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(date) DO UPDATE SET
       buy_clp_per_usd = excluded.buy_clp_per_usd,
       sell_clp_per_usd = excluded.sell_clp_per_usd,
       source = excluded.source`
  ).run(row.date, row.buy_clp_per_usd, row.sell_clp_per_usd, row.source);
}

export function fxBidAskRowOnDate(date: string): FxBidAskRow | null {
  return (stmtExactDate.get(date) as FxBidAskRow | undefined) ?? null;
}

export function midClpPerUsdOnOrBefore(date: string): number | null {
  const row = stmtMidOnOrBefore.get(date) as { clp_per_usd: number } | undefined;
  const v = row?.clp_per_usd;
  return v != null && Number.isFinite(v) && v > 0 ? v : null;
}

/** Buy/sell CLP per USD from Yahoo mid ± half spread (buy > sell). */
export function inferBidAskFromMid(mid: number): { buy_clp_per_usd: number; sell_clp_per_usd: number } {
  if (!Number.isFinite(mid) || mid <= 0) {
    throw new Error(`inferBidAskFromMid: invalid mid ${mid}`);
  }
  const half = FX_BID_ASK_SPREAD_CLP / 2;
  const buy_clp_per_usd = mid + half;
  const sell_clp_per_usd = mid - half;
  if (buy_clp_per_usd < sell_clp_per_usd) {
    throw new Error(`inferBidAskFromMid: buy ${buy_clp_per_usd} < sell ${sell_clp_per_usd}`);
  }
  return { buy_clp_per_usd, sell_clp_per_usd };
}

/** Upsert `mid_spread_inferred` row when no buy rate exists on or before `date`. */
export function materializeInferredBidAskForDate(date: string): FxBidAskRow | null {
  const existing = fxBidAskRowOnDate(date);
  if (existing) return existing;
  const mid = midClpPerUsdOnOrBefore(date);
  if (mid == null) return null;
  const inferred = inferBidAskFromMid(mid);
  const row: FxBidAskRow = {
    date,
    ...inferred,
    source: "mid_spread_inferred",
  };
  upsertFxBidAskRow(row);
  return row;
}

/**
 * Ensure a buy rate exists on or before `paymentDate` (materialize on payment date when
 * missing). Future dates are never materialized: persisting today's mid under a future
 * date would freeze later conversions at a stale rate once that date passes (the lookup
 * infers transiently for such dates instead).
 */
export function ensureBidAskForPaymentDate(paymentDate: string): void {
  if (paymentDate > chileCalendarTodayYmd()) return;
  if (fxBuyClpPerUsdOnOrBefore(paymentDate) != null) return;
  materializeInferredBidAskForDate(paymentDate);
}
