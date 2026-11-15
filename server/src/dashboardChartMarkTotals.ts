import { chileCalendarTodayYmd } from "./chileDate.js";
import { HOME_CURRENCY } from "./displayUnits.js";
import { nodeValue, nodeValuesAtDates, type NodePointValuePolicy } from "./nodeValue.js";
import type { TsUnit } from "./rates.js";

/**
 * The one valuation the dashboard charts (overview, patrimonio-vs-invested, cuentas
 * principales) sample at their month-end grid dates: Σ per-account CLP marks over a bucket,
 * with the cash CC-netting the net-worth view applies.
 *
 * This is deliberately the SAME `accountMarkClpAtYmd` the daily views sum, so a monthly chart
 * value at date `d` equals the daily chart value at `d` by construction, not by a separate
 * reconciliation. The legacy path forward-filled each group's *monthly closing* onto the
 * grid, which drifted from the true per-day mark wherever a source had no row on that exact
 * date (mid-month snapshot dates, a month a group skipped, a linked card the consolidated cash
 * didn't net at that date).
 *
 * Marks are read directly at the ~130 month-end dates (not off a contiguous daily grid): the
 * per-account daily mark cache is built for the dense daily views, and materializing 3.7k days
 * per account just to pick out the month-ends turned a ~1.6s dashboard build into ~22s. Rows
 * are taken as parameters (the caller resolves them via `listAccountsForGroupTab`) so this
 * stays a leaf module.
 */

export type ChartMarkTotalAccountRow = {
  account_id: number;
  bucket_slug: string;
  import_key?: string | null;
  name?: string | null;
  exclude_from_group_totals?: number;
};

/**
 * The chart totals' pesos at a date: each counted member's peso mark, a date with no mark left
 * out (a netting bucket always reads), rounded to the peso after the netting.
 */
const MONTH_END_MARK_TOTALS: Omit<NodePointValuePolicy, "netsLinkedCards"> = {
  members: "counted",
  empty: "null_unless_netted",
  rounding: "unit_coin",
};

/**
 * The chart totals in another unit at a date: each real counted member's own value in the unit,
 * unrounded.
 */
const CHART_VALUE_IN_UNIT: Omit<NodePointValuePolicy, "netsLinkedCards" | "now"> = {
  members: "real_counted",
  empty: "null_unless_netted",
  rounding: "none",
};

export type SlugMarkTotalsOpts = {
  /**
   * Apply the net-worth cash adjustment (`cashNetOfLinkedCreditCards`: subtract the linked
   * credit cards' owed on that date, signed — a total in credit adds) — set for the
   * `cash_eqs` bucket only, matching `buildDashboardBucketDailySeriesClp`.
   */
  netLinkedCreditCard?: boolean;
};

/**
 * CLP mark total per requested date for one bucket's accounts, rounded per date exactly as
 * `buildDashboardBucketDailySeriesClp` / the overview liabilities leg round theirs (netting,
 * if any, is applied before the round).
 *
 * A date where **no** account has a finite mark is left OUT of the map (not set to 0), the
 * same `any ? value : null` rule the daily series uses: before a group's first holding, the
 * primary chart's child lines must read null (line absent), not a flat 0 that draws as data.
 * A genuine zero — an account that exists and marks to 0 — still yields 0 (`any` is true).
 *
 * Exception: `netLinkedCreditCard` (the cash_eqs bucket) always emits, matching
 * `buildDashboardBucketDailySeriesClp` — the cash line nets the linked card at every date, so
 * a date with no cash mark but a linked card balance is a real value (negative when owed,
 * positive when in credit), not an absence.
 */
export function slugMarkTotalsAtDatesClp(
  accounts: readonly ChartMarkTotalAccountRow[],
  datesAsc: readonly string[],
  opts?: SlugMarkTotalsOpts
): Map<string, number> {
  const values = nodeValuesAtDates(accounts, datesAsc, HOME_CURRENCY, {
    ...MONTH_END_MARK_TOTALS,
    netsLinkedCards: opts?.netLinkedCreditCard === true,
  });
  const out = new Map<string, number>();
  datesAsc.forEach((ymd, i) => {
    const v = values[i];
    if (v != null) out.set(ymd, v);
  });
  return out;
}

/**
 * A bucket's value TODAY in a non-peso unit: Σ of each account's own value in the unit
 * (`bucketValueInUnitAt` — each framed on the day its pesos were priced, a USD cash account
 * in its ledger dollars) with the cash netting at today's rate — the headline's rule, so the
 * charts' today point equals the cards. Never the bucket's pesos ÷ one rate, which framed every
 * market mark priced on an earlier day (cuotas, a pre-open stock) on today's live rate.
 * Absent (null) under the same rule as {@link slugMarkTotalsAtDatesClp}.
 */
export function slugValueInUnitToday(
  accounts: readonly ChartMarkTotalAccountRow[],
  unit: Exclude<TsUnit, "clp">,
  opts?: SlugMarkTotalsOpts & { now?: Date }
): number | null {
  return slugValueInUnitAt(accounts, chileCalendarTodayYmd(), unit, opts);
}

/**
 * A bucket's value on `ymd` in a non-peso unit: Σ of each account's own value in the unit
 * (`bucketValueInUnitAt`: what it held, converted once at its side), the linked cards netted
 * from cash at the debt side. Never the bucket's pesos ÷ one rate, which would convert a
 * dollar holding to pesos and back across the spread.
 */
export function slugValueInUnitAt(
  accounts: readonly ChartMarkTotalAccountRow[],
  ymd: string,
  unit: Exclude<TsUnit, "clp">,
  opts?: SlugMarkTotalsOpts & { now?: Date }
): number | null {
  return nodeValue(accounts, ymd, unit, {
    ...CHART_VALUE_IN_UNIT,
    netsLinkedCards: opts?.netLinkedCreditCard === true,
    now: opts?.now ?? new Date(),
  });
}
