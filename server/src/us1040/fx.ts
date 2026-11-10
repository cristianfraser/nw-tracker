/**
 * The one currency rule of the Form 1040 (docs/us-1040-readings.md §3): an amount in another
 * currency converts to dollars at the stored USD/CLP mid of its own day (`fx_daily`, read on or
 * before the day — a weekend or holiday takes the last fx day, at most {@link US1040_FX_MAX_AGE_DAYS}
 * back, else the read throws). A cost basis converts at its acquisition day, proceeds at the sale
 * day, income at its receipt day. Pub. 514: «Use the exchange rate prevailing when you receive, pay,
 * or accrue the item»; the IRS «accepts any posted exchange rate that is used consistently». The
 * IRS yearly average is the accepted alternative for recurring income (not used: one rule for every
 * item). The dólar observado stays the F22's.
 */
import { addDaysIso } from "nw-tracker-contracts";
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

/** `amount` in `currency` as dollars on `day` (dollars pass through; pesos at that day's rate; anything else throws). */
export function usdOn(amount: number, currency: string, day: string): number {
  if (currency === "usd") return amount;
  if (currency === "clp") return amount / usdClpRateOn(day);
  throw new Error(`1040: no conversion from ${currency} to dollars (${amount} on ${day})`);
}
