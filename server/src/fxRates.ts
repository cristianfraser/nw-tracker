import { historyTierMemo } from "./cacheRegistry.js";
import { db } from "./db.js";
import {
  ensureBidAskForPaymentDate,
  fxBuyClpPerUsdOnOrBefore,
} from "./fxBidAsk.js";
import { recordFxConversionWarning } from "./fxConversionWarnings.js";

export type FxRow = { date: string; clp_per_usd: number };

export { fxForLiveMtm, shouldUseLiveFxQuote, LIVE_FX_YAHOO_SYMBOL } from "./fxLive.js";

const stmtAny = db.prepare(
  `SELECT date, clp_per_usd FROM fx_daily WHERE date <= ? ORDER BY date DESC LIMIT 1`
);

/** The stored USD/CLP mid on or before `date` (the `fx_daily` close of the fx day). */
export function fxRowOnOrBefore(date: string | null): FxRow | null {
  if (!date) return null;
  return (stmtAny.get(date) as FxRow | undefined) ?? null;
}

/**
 * CLP→USD for balances, charts, and dashboard `current_value_usd`: the Yahoo CLP=X close in
 * `fx_daily` on or before the date (one row per weekday, the rate at the fx day end —
 * `forexDay.ts`). Null before the series starts: no rate dated after the day is ever read.
 */
export function fxMonthEndForBalanceUsd(date: string | null): FxRow | null {
  return fxRowOnOrBefore(date);
}

const DEPOSIT_CROSS_RATE_DECIMALS = 5;

function roundPaymentClp(clp: number): number {
  const f = 10 ** DEPOSIT_CROSS_RATE_DECIMALS;
  return Math.round(clp * f) / f;
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

/**
 * CLP → USD at buy rate on or before `paymentDate`; falls back to mid with warning. Unrounded
 * (deposit/flow events sum these and round once for display). Null when no rate exists on or
 * before the date.
 */
export function clpToUsdAtPayment(clp: number, paymentDate: string): number | null {
  if (!Number.isFinite(clp) || clp === 0) return 0;
  const buy = buyRateOnOrBefore(paymentDate);
  if (buy != null && buy > 0) return clp / buy;
  const fx = fxRowOnOrBefore(paymentDate);
  if (!fx || fx.clp_per_usd <= 0) return null;
  recordFxConversionWarning({
    code: "buy_rate_missing",
    date: paymentDate,
    context: "clpToUsdAtPaymentRounded",
  });
  return clp / fx.clp_per_usd;
}

/**
 * The buy rate on or before `paymentDate` (inferred from the mid when none is stored). A rate
 * found is memoized in the history tier — every daily build converts each deposit event, a few
 * thousand lookups — and the stored rates are mark inputs, so any write to them drops the memo.
 * A missing rate is not memoized: the mid fallback records its warning on every conversion.
 */
function buyRateOnOrBefore(paymentDate: string): number | null {
  const memo = historyTierMemo<string, number>("fx_buy_rate_on_or_before");
  const known = memo.get(paymentDate);
  if (known !== undefined) return known;
  ensureBidAskForPaymentDate(paymentDate);
  const buy = fxBuyClpPerUsdOnOrBefore(paymentDate);
  if (buy != null && buy > 0) memo.set(paymentDate, buy);
  return buy;
}

/** {@link clpToUsdAtPayment} rounded to the deposit cross-rate precision. */
export function clpToUsdAtPaymentRounded(clp: number, paymentDate: string): number | null {
  const usd = clpToUsdAtPayment(clp, paymentDate);
  if (usd == null) return null;
  const f = 10 ** DEPOSIT_CROSS_RATE_DECIMALS;
  return Math.sign(usd) * (Math.round(Math.abs(usd) * f) / f);
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
 * Exact-date UF rows in `[fromYmd, toYmd]` (inclusive) as a `Map<date, clp_per_uf>`.
 * Exact dates only — NO on-or-before fallback: the mortgage UF-timing reminder compares a
 * present-day UF against a FUTURE (post-cierre) UF, and a silent fallback to an older row
 * would corrupt that comparison. A future date simply absent from the map means BCentral
 * has not published it yet (the daily UF horizon is ~the 9th of the next month).
 */
export function ufClpByDateRange(fromYmd: string, toYmd: string): Map<string, number> {
  const out = new Map<string, number>();
  if (!fromYmd || !toYmd || fromYmd > toYmd) return out;
  const rows = db
    .prepare(`SELECT date, clp_per_uf FROM uf_daily WHERE date >= ? AND date <= ?`)
    .all(fromYmd, toYmd) as { date: string; clp_per_uf: number }[];
  for (const r of rows) {
    if (Number.isFinite(r.clp_per_uf)) out.set(r.date, r.clp_per_uf);
  }
  return out;
}

const UF_SNAPSHOT_INDEXED_LOOKUP_MAX = 16;

/**
 * Official UF (CLP per 1 UF) from `uf_daily` at each snapshot label — last row on or before each date.
 * Used for mortgage cierre / UF día (not duplicated from the depto dividendos sheet).
 */
export function ufClpBySnapshotDatesAsc(datesAsc: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  if (datesAsc.length === 0) return out;
  if (datesAsc.length <= UF_SNAPSHOT_INDEXED_LOOKUP_MAX) {
    // A few dates (a single mark): one indexed on-or-before lookup each beats reading the table.
    for (const d of datesAsc) {
      const row = ufRowOnOrBefore(d);
      if (row != null && Number.isFinite(row.clp_per_uf)) out.set(d, row.clp_per_uf);
    }
    return out;
  }
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
