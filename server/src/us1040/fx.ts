/**
 * The one currency rule of the Form 1040 (docs/us-1040-readings.md §3): an amount in another
 * currency converts to dollars at the stored USD/CLP mid of its own day (`fx_daily`, read on or
 * before the day — a weekend or holiday takes the last fx day, at most {@link US1040_FX_MAX_AGE_DAYS}
 * back, else the read throws). A cost basis converts at its acquisition day, proceeds at the sale
 * day, income at its receipt day. Pub. 514: «Use the exchange rate prevailing when you receive, pay,
 * or accrue the item»; the IRS «accepts any posted exchange rate that is used consistently». The
 * IRS yearly average is the accepted alternative for recurring income (not used: one rule for every
 * item). The dólar observado stays the F22's. An amount in UF (the property's appraisals and
 * prices, a UF-indexed loan) converts to pesos at that day's UF (`uf_daily`, published for every
 * calendar day: an exact read, a missing day throws), then to dollars as above.
 *
 * One exception, by rule: a foreign tax ACCRUED for a year (Form 1116, accrued method) translates at
 * the year's average rate ({@link usdClpYearlyAverage}).
 */
import { addDaysIso } from "nw-tracker-contracts";
import { db } from "../db.js";
import { fxRowOnOrBefore } from "../fxRates.js";

/** How far back a day may read its rate (a long weekend plus a holiday). */
export const US1040_FX_MAX_AGE_DAYS = 7;

/** CLP per USD on `day` (the mid on or before it); throws without a rate in the window. */
export function usdClpRateOn(day: string): number {
  const row = fxRowOnOrBefore(day);
  if (!row || !(row.clp_per_usd > 0)) throw new Error(`1040: no USD/CLP rate on or before ${day}`);
  if (row.date < addDaysIso(day, -US1040_FX_MAX_AGE_DAYS)) {
    throw new Error(`1040: the USD/CLP rate for ${day} is from ${row.date}, more than ${US1040_FX_MAX_AGE_DAYS} days before`);
  }
  return row.clp_per_usd;
}

const ufStmt = db.prepare(`SELECT clp_per_uf FROM uf_daily WHERE date = ?`);

/** CLP per UF on `day` (exact: the UF is published for every calendar day). */
export function clpPerUfOn(day: string): number {
  const r = ufStmt.get(day) as { clp_per_uf: number } | undefined;
  if (!r || !(r.clp_per_uf > 0)) throw new Error(`1040: no UF on ${day} — backfill uf_daily`);
  return r.clp_per_uf;
}

/** `amount` in `currency` as dollars on `day` (dollars pass through; pesos at that day's rate; UF through that day's pesos; anything else throws). */
export function usdOn(amount: number, currency: string, day: string): number {
  if (currency === "usd") return amount;
  if (currency === "clp") return amount / usdClpRateOn(day);
  if (currency === "uf") return (amount * clpPerUfOn(day)) / usdClpRateOn(day);
  throw new Error(`1040: no conversion from ${currency} to dollars (${amount} on ${day})`);
}

/**
 * The average CLP per USD of `year`'s `fx_daily` rows through `throughYmd` (the year's end, or
 * today in an open year): Pub. 514 «Exception» — accrued foreign taxes «translate at the average
 * exchange rate for the tax year to which the taxes relate» when paid within 24 months of the year's
 * end (§986(a)(1)); the F22's April payment always is. A plain mean of the stored trading-day mids
 * (the IRS publishes its own yearly average and accepts any posted rate used consistently). Throws
 * without a row in the year.
 */
export function usdClpYearlyAverage(year: number, throughYmd: string = `${year}-12-31`): number {
  const r = db
    .prepare(`SELECT AVG(clp_per_usd) AS avg, COUNT(*) AS n FROM fx_daily WHERE date BETWEEN ? AND ?`)
    .get(`${year}-01-01`, throughYmd) as { avg: number | null; n: number };
  if (!r.n || !(r.avg! > 0)) throw new Error(`1040: no USD/CLP rate stored in ${year} through ${throughYmd}`);
  return r.avg!;
}
