import { fxMonthEndForBalanceUsd, ufRowOnOrBefore } from "./fxRates.js";
import type { TsUnit } from "./valuationTimeseries.js";
import { accountValueInUnitFromClp } from "./accountValue.js";
import { convertValue, type ValueSide } from "./valueConvert.js";
import { convertCurrency } from "./rates.js";

/**
 * Pesos in `unit` at a date by the historical rule: USD at the `fx_daily` row on or before the
 * date (NaN without one), UF at the `uf_daily` row on or before it. Every day before Chile
 * today converts this way, so a historical mark (and the `daily.marks|` cache) never reads a
 * live rate. Flows keep this rule (the mid) on every day; values go through {@link clpToUnitAt}
 * or {@link accountValueClpToUnitAt}, at their side of the spread.
 */
export function convertTs(clp: number, asOf: string, unit: TsUnit): number {
  if (unit === "usd") {
    const fx = fxMonthEndForBalanceUsd(asOf);
    if (!fx || fx.clp_per_usd <= 0) return Number.NaN;
    return clp / fx.clp_per_usd;
  }
  if (unit === "uf") {
    const u = ufRowOnOrBefore(asOf);
    return u && u.clp_per_uf > 0 ? clp / u.clp_per_uf : clp;
  }
  return clp;
}

export type ClpToUnitOpts = {
  now?: Date;
  /**
   * The side of the spread the pesos close at (`rates.ts`): `asset` (default) for something
   * held, `debt` for a balance owed (a card total, the mortgage).
   */
  side?: ValueSide;
};

/**
 * A VALUE in pesos at `ymd`, in `unit`, converted once at its side (`valueConvert.ts`): the
 * stored rate on a past day, today's rate (live while the fx day is open) today and on a later
 * date (the current month's month-end point). For an amount that is not one account's value
 * (a card total netted from cash, a reference line); an account's value goes through
 * {@link accountValueClpToUnitAt}. Null when no rate is on file.
 */
export function clpToUnitAt(
  clp: number,
  ymd: string,
  unit: TsUnit,
  opts?: ClpToUnitOpts
): number | null {
  if (unit === "clp") return clp;
  const out = convertValue(clp, "clp", unit, ymd, opts?.side ?? "asset", opts?.now);
  return out != null && Number.isFinite(out) ? out : null;
}

/**
 * An account's VALUE in `unit` at `ymd` — never a flow — given its pesos `clp` that day: the
 * value in what it is natively expressed in, converted once (`accountValueInUnitFromClp`). A
 * dollar cash account in USD is its ledger dollars, a dollar stock its shares × dollar price; a
 * peso value converts at the account's side.
 */
export function accountValueClpToUnitAt(
  accountId: number,
  clp: number,
  ymd: string,
  unit: TsUnit,
  opts?: { now?: Date }
): number | null {
  return accountValueInUnitFromClp(accountId, clp, ymd, unit, opts);
}

/**
 * Pesos in `unit` at the MID rate — for figures that are not a held value (a flow, a benchmark
 * level): the stored mid on a past day, today's live mid today. What {@link clpToUnitAt} read
 * before values took a side of the spread.
 */
export function clpToUnitAtMid(clp: number, ymd: string, unit: TsUnit, now?: Date): number | null {
  if (unit === "clp") return clp;
  const out = convertCurrency(clp, "clp", unit, ymd, { side: "mid", now });
  return out != null && Number.isFinite(out) ? out : null;
}
