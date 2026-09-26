/**
 * The three CLP lines of the day-period CC historial chart, attached to a `/api/daily-series`
 * payload: `cc_owed` (saldo total — Σ of the scope's CC-master lines, the per-day owed walk),
 * `cc_installment_debt` (deuda en cuotas — Σ per master) and `cc_plan_tail` (the future plan
 * simulation over one shared grid). One builder for both scopes: a card's own page passes its
 * single id, a Pasivos / credit-card group page the masters its merged monthly ledger sums
 * (`resolveCcMasterAccountIds`), so the two grains agree on membership. Absent when no member
 * has an installment schedule (as before: those cards draw no daily historial).
 *
 * CLP by construction — the historial chart is CLP-native — so callers only attach it to CLP
 * requests, where the series lines are already pesos.
 */
import {
  ccInstallmentDebtDailyClpForAccounts,
  ccInstallmentPlanTailClpForAccounts,
  sumNullableDailySeries,
  type CcPlanTailPoint,
} from "./ccInstallmentDebtDaily.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { resolveCcMasterAccountIds } from "./creditCardGroupLedger.js";
import type { BucketDailySeries } from "./dailySeries.js";

export type CcDailyHistorialBlock = {
  /** Per-day owed (CLP), index-aligned with `points`: Σ of the scope's CC-master lines. */
  cc_owed: (number | null)[];
  /** Per-day plan debt («deuda en cuotas», CLP), index-aligned with `points`. */
  cc_installment_debt: (number | null)[];
  /** Future daily tail (`today+1 .. plan end`, CLP); absent once every plan has settled. */
  cc_plan_tail?: CcPlanTailPoint[];
};

/**
 * Build the block for the given masters over `series` (built with `includeAccounts: true`, in
 * CLP). A master with no line in the series — a nav-omitted retired master the config still
 * lists — adds nothing to `cc_owed`; its (settled) plan still walks the debt/tail sums.
 */
export function ccDailyHistorialBlockForMasters(
  masterIds: readonly number[],
  series: BucketDailySeries
): CcDailyHistorialBlock | null {
  if (series.unit !== "clp") {
    throw new Error(`ccDailyHistorialBlockForMasters: series unit ${series.unit}, expected clp`);
  }
  const dates = series.points.map((p) => p.as_of_date);
  const debt = ccInstallmentDebtDailyClpForAccounts(masterIds, dates);
  if (!debt) return null;
  const memberIds = new Set(masterIds);
  const lines = (series.accounts ?? []).filter((l) => memberIds.has(l.account_id));
  const owed = sumNullableDailySeries(
    lines.map((l) => l.values),
    dates.length
  );
  const todayYmd = dates.at(-1) ?? chileCalendarTodayYmd();
  const tail = ccInstallmentPlanTailClpForAccounts(masterIds, todayYmd);
  return { cc_owed: owed, cc_installment_debt: debt, ...(tail ? { cc_plan_tail: tail } : {}) };
}

/** Group-scope block over the masters the merged monthly ledger sums; null for non-CC groups. */
export function ccDailyHistorialBlockForGroup(
  portfolioGroupSlug: string,
  series: BucketDailySeries
): CcDailyHistorialBlock | null {
  const masterIds = resolveCcMasterAccountIds(portfolioGroupSlug);
  if (masterIds.length === 0) return null;
  return ccDailyHistorialBlockForMasters(masterIds, series);
}
