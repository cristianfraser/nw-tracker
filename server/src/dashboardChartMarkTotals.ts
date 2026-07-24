import { accountMarkClpAtYmd } from "./accountMarkClpAtYmd.js";
import { applyCashSavingsNwAdjustment } from "./cashEqsBucketNet.js";
import { linkedCreditCardClpForCashCardAsOf } from "./liabilityTree.js";

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

export type SlugMarkTotalsOpts = {
  /**
   * Apply the net-worth cash adjustment (subtract the linked credit card owed on that date)
   * — set for the `cash_eqs` bucket only, matching `buildDashboardBucketDailySeriesClp`.
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
 * a date with no cash mark but an owed card is a real (negative) value, not an absence.
 */
export function slugMarkTotalsAtDatesClp(
  accounts: readonly ChartMarkTotalAccountRow[],
  datesAsc: readonly string[],
  opts?: SlugMarkTotalsOpts
): Map<string, number> {
  const rows = accounts.filter((a) => a.exclude_from_group_totals !== 1);
  const out = new Map<string, number>();
  for (const ymd of datesAsc) {
    let raw = 0;
    let any = false;
    for (const a of rows) {
      const mark = accountMarkClpAtYmd(a.account_id, ymd, a.bucket_slug, {
        import_key: a.import_key ?? null,
        name: a.name ?? null,
      });
      const clp = mark?.value_clp;
      if (clp != null && Number.isFinite(clp)) {
        raw += clp;
        any = true;
      }
    }
    if (opts?.netLinkedCreditCard) {
      raw = applyCashSavingsNwAdjustment(raw, linkedCreditCardClpForCashCardAsOf(ymd));
    } else if (!any) {
      continue;
    }
    out.set(ymd, Math.round(raw));
  }
  return out;
}
