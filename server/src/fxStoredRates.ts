/** The stored USD/CLP close (`fx_daily`): the leaf both the live-rate readers and `fxRates.ts` read. */
import { db } from "./db.js";

export type FxRow = { date: string; clp_per_usd: number };

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
