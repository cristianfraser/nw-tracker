import { db } from "./db.js";

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

export function fxBidAskRowOnOrBefore(date: string | null): FxBidAskRow | null {
  if (!date) return null;
  return (stmtBuyOnOrBefore.get(date) as FxBidAskRow | undefined) ?? null;
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

/** Ensure a buy rate exists on or before `paymentDate` (materialize on payment date when missing). */
export function ensureBidAskForPaymentDate(paymentDate: string): void {
  if (fxBuyClpPerUsdOnOrBefore(paymentDate) != null) return;
  materializeInferredBidAskForDate(paymentDate);
}
