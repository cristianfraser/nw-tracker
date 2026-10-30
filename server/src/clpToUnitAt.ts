import { chileCalendarTodayYmd, chileWallClockAt } from "./chileDate.js";
import { fxMonthEndForBalanceUsd, ufRowOnOrBefore } from "./fxRates.js";
import { usdFromClpAtLiveFrame } from "./fxLive.js";
import { isUsdCashAccount, usdCashBalanceUsdAt } from "./usdCashAccounts.js";
import type { TsUnit } from "./valuationTimeseries.js";
import { historyTierMemo } from "./aggregationCache.js";

/**
 * Pesos in `unit` at a date by the historical rule: USD at the `fx_daily` row on or before the
 * date (NaN without one), UF at the `uf_daily` row on or before it. Every day before Chile
 * today converts this way, so a historical mark (and the `daily.marks|` cache) never reads a
 * live rate. Flows keep this rule on every day; values dated today go through
 * {@link clpToUnitAt}.
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

/**
 * {@link convertTs} for many days before Chile today (the daily series' grids): the day's rate
 * is read once and kept in the history tier (`aggregationCache.ts`) — fx and UF rows are
 * write-once and their writes drop the tier — so every account of every scope shares it.
 * Returns exactly what {@link clpToUnitAt} returns for such a day (null where it is null);
 * throws for today or later, which take the live frame.
 */
export function pastDayUnitConverter(unit: TsUnit): (clp: number, ymd: string) => number | null {
  if (unit === "clp") return (clp) => clp;
  const today = chileCalendarTodayYmd();
  // null = no usable rate on file (USD: NaN → null; UF: the pesos pass through unconverted).
  const rates = historyTierMemo<string, number | null>(`unit_rate_by_day|${unit}`);
  const rateAt = (ymd: string): number | null => {
    let r = rates.get(ymd);
    if (r === undefined) {
      if (unit === "usd") {
        const fx = fxMonthEndForBalanceUsd(ymd);
        r = fx && fx.clp_per_usd > 0 ? fx.clp_per_usd : null;
      } else {
        const u = ufRowOnOrBefore(ymd);
        r = u && u.clp_per_uf > 0 ? u.clp_per_uf : null;
      }
      rates.set(ymd, r);
    }
    return r;
  };
  return (clp, ymd) => {
    if (ymd >= today) throw new Error(`pastDayUnitConverter: ${ymd} is not before Chile today`);
    const rate = rateAt(ymd);
    if (unit === "usd") {
      if (rate == null) return null;
      const out = clp / rate;
      return Number.isFinite(out) ? out : null;
    }
    const out = rate == null ? clp : clp / rate;
    return Number.isFinite(out) ? out : null;
  };
}

export type ClpToUnitOpts = {
  /**
   * The day the pesos were priced (`priced_on` of `accountTodayValue`). Only read for a value
   * dated today: a market mark priced on an earlier day frames on that day's fx.
   */
  markAsOf?: string | null;
  now?: Date;
};

/**
 * A VALUE in pesos at `ymd`, in `unit`. Today in USD: the live frame of the day the pesos were
 * priced (`usdFromClpAtLiveFrame` — the live CLP=X while that fx day is open, the stored close
 * after), so a live mark is divided by the rate it was built with; a date after today (the
 * current month's month-end point) is framed as today. Any earlier day: exactly
 * {@link convertTs}. Null when no rate is on file (callers decide: a chart point is null, a sum
 * skips it).
 */
export function clpToUnitAt(
  clp: number,
  ymd: string,
  unit: TsUnit,
  opts?: ClpToUnitOpts
): number | null {
  if (unit === "clp") return clp;
  const today = opts?.now ? chileWallClockAt(opts.now).ymd : chileCalendarTodayYmd();
  // A value dated after today (the current month's month-end point) is today's value.
  if (unit === "usd" && ymd >= today) {
    return usdFromClpAtLiveFrame(clp, opts?.markAsOf ?? today, opts?.now);
  }
  const out = convertTs(clp, ymd, unit);
  return Number.isFinite(out) ? out : null;
}

/**
 * An account's VALUE in `unit` at `ymd` — never a flow. A USD cash account in USD is its ledger
 * dollars (`usdCashBalanceUsdAt`; `clp` is ignored: its pesos are those dollars at the sell
 * rate, and pesos ÷ mid would read the bid-ask spread as a P/L). Everything else:
 * {@link clpToUnitAt}.
 */
export function accountValueClpToUnitAt(
  accountId: number,
  clp: number,
  ymd: string,
  unit: TsUnit,
  opts?: ClpToUnitOpts
): number | null {
  if (unit === "usd" && isUsdCashAccount(accountId)) return usdCashBalanceUsdAt(accountId, ymd);
  return clpToUnitAt(clp, ymd, unit, opts);
}
