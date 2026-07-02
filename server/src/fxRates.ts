import { db } from "./db.js";
import {
  ensureBidAskForPaymentDate,
  fxBuyClpPerUsdOnOrBefore,
  fxSellClpPerUsdOnOrBefore,
} from "./fxBidAsk.js";
import { recordFxConversionWarning } from "./fxConversionWarnings.js";

export type FxRow = { date: string; clp_per_usd: number };

export { fxForLiveMtm, shouldUseLiveFxQuote, LIVE_FX_YAHOO_SYMBOL } from "./fxLive.js";

export type FxLookupOptions = {
  /**
   * When true, only month-end `fx_daily` rows are considered (official monthly snapshots).
   * Falls back to any row on or before the date if no month-end row exists.
   */
  monthEndOnly?: boolean;
};

const stmtAny = db.prepare(
  `SELECT date, clp_per_usd FROM fx_daily WHERE date <= ? ORDER BY date DESC LIMIT 1`
);

const stmtMonthEnd = db.prepare(
  `SELECT date, clp_per_usd FROM fx_daily
   WHERE date <= ?
     AND date = date(date, 'start of month', '+1 month', '-1 day')
   ORDER BY date DESC LIMIT 1`
);

/** First month-end `fx_daily` row on or after `date` (when the series starts after snapshot dates). */
const stmtMonthEndOnOrAfter = db.prepare(
  `SELECT date, clp_per_usd FROM fx_daily
   WHERE date >= ?
     AND date = date(date, 'start of month', '+1 month', '-1 day')
   ORDER BY date ASC LIMIT 1`
);

/** Single FX row used for CLP↔USD (charts, bolsa flows, dashboard). */
export function fxRowOnOrBefore(
  date: string | null,
  opts?: FxLookupOptions
): FxRow | null {
  if (!date) return null;
  if (opts?.monthEndOnly) {
    const row = (stmtMonthEnd.get(date) as FxRow | undefined) ?? null;
    if (row) return row;
  }
  return (stmtAny.get(date) as FxRow | undefined) ?? null;
}

/**
 * CLP→USD for balances, charts, and dashboard `current_value_usd`.
 * Uses Yahoo CLP=X EOD in `fx_daily` (NYSE trade dates). Falls back to month-end-only rows for legacy
 * Excel imports, then the earliest month-end on or after `date` when the series starts after snapshot dates.
 */
export function fxMonthEndForBalanceUsd(date: string | null): FxRow | null {
  if (!date) return null;
  const observado = fxRowOnOrBefore(date);
  if (observado) return observado;
  const prior = (stmtMonthEnd.get(date) as FxRow | undefined) ?? null;
  if (prior) return prior;
  return (stmtMonthEndOnOrAfter.get(date) as FxRow | undefined) ?? null;
}

const DEPOSIT_CROSS_RATE_DECIMALS = 5;

function roundPaymentClp(clp: number): number {
  const f = 10 ** DEPOSIT_CROSS_RATE_DECIMALS;
  return Math.round(clp * f) / f;
}

/** USD → CLP at sell rate on or before `paymentDate`; falls back to mid with warning. */
export function usdToClpAtPaymentRounded(usd: number, paymentDate: string): number | null {
  if (!Number.isFinite(usd) || usd === 0) return 0;
  const sign = Math.sign(usd);
  ensureBidAskForPaymentDate(paymentDate);
  const sell = fxSellClpPerUsdOnOrBefore(paymentDate);
  if (sell != null && sell > 0) {
    return sign * roundPaymentClp(Math.abs(usd) * sell);
  }
  const fx = fxRowOnOrBefore(paymentDate);
  if (!fx || fx.clp_per_usd <= 0) return null;
  recordFxConversionWarning({
    code: "sell_rate_missing",
    date: paymentDate,
    context: "usdToClpAtPaymentRounded",
  });
  return sign * roundPaymentClp(Math.abs(usd) * fx.clp_per_usd);
}

/** USD → reference CLP at mid (DRIP, internal USD rotation); records usd_reference_clp warning. */
export function usdToClpReferenceRounded(usd: number, paymentDate: string): number | null {
  if (!Number.isFinite(usd) || usd === 0) return 0;
  const fx = fxRowOnOrBefore(paymentDate);
  if (!fx || fx.clp_per_usd <= 0) return null;
  recordFxConversionWarning({
    code: "usd_reference_clp",
    date: paymentDate,
    context: "usdToClpReferenceRounded",
  });
  return roundPaymentClp(Math.abs(usd) * fx.clp_per_usd);
}

/** CLP → USD at buy rate on or before `paymentDate`; falls back to mid with warning. */
export function clpToUsdAtPaymentRounded(clp: number, paymentDate: string): number | null {
  if (!Number.isFinite(clp) || clp === 0) return 0;
  const sign = Math.sign(clp);
  ensureBidAskForPaymentDate(paymentDate);
  const buy = fxBuyClpPerUsdOnOrBefore(paymentDate);
  if (buy != null && buy > 0) {
    const usd = Math.abs(clp) / buy;
    const f = 10 ** DEPOSIT_CROSS_RATE_DECIMALS;
    return sign * (Math.round(usd * f) / f);
  }
  const fx = fxRowOnOrBefore(paymentDate);
  if (!fx || fx.clp_per_usd <= 0) return null;
  recordFxConversionWarning({
    code: "buy_rate_missing",
    date: paymentDate,
    context: "clpToUsdAtPaymentRounded",
  });
  const usd = Math.abs(clp) / fx.clp_per_usd;
  const f = 10 ** DEPOSIT_CROSS_RATE_DECIMALS;
  return sign * (Math.round(usd * f) / f);
}

/**
 * CLP → USD for **balance display** (dashboard totals, cards, liabilities breakdown) —
 * divides by the same `fx_daily` row family charts use (`convertTs` /
 * `fxMonthEndForBalanceUsd`), so totals and chart points agree to the peso. Payment and
 * deposit-event conversions (money actually moved) use the bid-ask helpers instead.
 */
export function clpToUsdForBalanceAt(clp: number, asOfYmd: string): number | null {
  if (!Number.isFinite(clp)) return null;
  const fx = fxMonthEndForBalanceUsd(asOfYmd);
  if (!fx || fx.clp_per_usd <= 0) return null;
  return clp / fx.clp_per_usd;
}

export function ufRowOnOrBefore(date: string | null): { date: string; clp_per_uf: number } | null {
  if (!date) return null;
  return (
    (db
      .prepare(`SELECT date, clp_per_uf FROM uf_daily WHERE date <= ? ORDER BY date DESC LIMIT 1`)
      .get(date) as { date: string; clp_per_uf: number } | undefined) ?? null
  );
}

/**
 * Official UF (CLP per 1 UF) from `uf_daily` at each snapshot label — last row on or before each date.
 * Used for mortgage cierre / UF día (not duplicated from the depto dividendos sheet).
 */
export function ufClpBySnapshotDatesAsc(datesAsc: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  if (datesAsc.length === 0) return out;
  const rows = db
    .prepare(`SELECT date, clp_per_uf FROM uf_daily ORDER BY date ASC`)
    .all() as { date: string; clp_per_uf: number }[];
  if (rows.length === 0) return out;
  let j = 0;
  let last: number | null = null;
  for (const d of datesAsc) {
    while (j < rows.length && rows[j]!.date <= d) {
      last = rows[j]!.clp_per_uf;
      j += 1;
    }
    if (last != null && Number.isFinite(last)) out.set(d, last);
  }
  return out;
}
